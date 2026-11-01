import { createHash } from "node:crypto";
import Ajv from "ajv";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { gitStatusResultSchema, type GitStatusResult } from "../../git/contract.js";
import {
  WORKFLOW_CALL_CACHE_VERSION,
  computeWorkflowCallCacheKey,
  reusableSuccessfulResult,
} from "./cache.js";
import {
  abandonOriginNotifications,
  hasWorker,
  hasActiveEnvironmentConsumer,
  ownWorker,
  workerOrigins,
  isWorkerRetired,
  retiredWorkers,
  recordWorkerCleanup,
  activeChildThreadsForRun,
  attachCallThread,
  beginNotificationAttempt,
  cancelRun,
  claimQueuedRun,
  countCallsForRun,
  createRun,
  deleteTerminalRuns,
  getCall,
  getCallByChildThread,
  getLatestRunForOriginThread,
  getRun,
  getRunRequired,
  incrementRepairAttempts,
  listCallsForRun,
  listCallsForRunPage,
  listExpiredTerminalRuns,
  listActiveRunsForOriginThread,
  listRuns,
  listPendingNotificationRuns,
  listRunProvisionedEnvironments,
  listRunningCalls,
  listTimedOutRuns,
  markCallReplayedSameRun,
  markNotificationSent,
  queueCallProviderRetry,
  recordCallPlacement,
  recordNotificationFailure,
  recoverInterruptedRuns,
  settleNotificationUndeliverable,
  settleCall,
  settleRun,
  startCall,
  storeStructuredResult,
  updateRunPhase,
  type Db,
  type WorkflowCallCounts,
  type WorkflowCallRow,
  type WorkflowRunRow,
} from "./data.js";
import { parseWorkflowSource } from "./parser.js";
import { executeWorkflowScript } from "./runtime.js";
import {
  DEFAULT_WORKFLOW_SETTINGS,
  parseStoredWorkflowSettings,
  type WorkflowSettings,
} from "./settings.js";
import { workflowReferenceToSourceInput } from "./source-resolution.js";
import type {
  JsonSchema,
  JsonValue,
  NestedWorkflowContext,
  WorkflowAgentOptions,
  WorkflowCapabilities,
  WorkflowReference,
} from "./types.js";
import { utf8Prefix } from "./utf8.js";
import { parseStoredAgentOptions } from "./validation.js";
import { prepareWorkflowSource } from "./workflow-input.js";

const executionValuesSchema = z.object({
  model: z.string().min(1),
  reasoningLevel: z.string().min(1),
  permissionMode: z.enum(["accept-edits", "auto", "full"]),
});

const selectedExecutionSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  reasoningLevel: executionValuesSchema.shape.reasoningLevel,
  permissionMode: executionValuesSchema.shape.permissionMode,
});
type ResolvedSelection = z.infer<typeof selectedExecutionSchema>;

const MAX_REPAIR_ATTEMPTS = 2;
const WORKER_PROMPT_VERSION = "workflow-worker-prompt-v1";
const RESULT_PROTOCOL_VERSION = "workflow-result-protocol-v1";
const SCHEMA_LIMITS = { bytes: 64 * 1024, nodes: 4_096, depth: 64 };
const VALUE_LIMITS = { bytes: 1024 * 1024, nodes: 100_000, depth: 128 };
const NOTIFICATION_RETRY_BASE_MS = 1_000;
const NOTIFICATION_RETRY_MAX_MS = 60 * 60 * 1_000;
const PROVIDER_RETRY_DELAYS_MS = [1_000, 4_000] as const;
const RETENTION_SWEEP_RUNS = 20;
type ThreadSpawnEnvironment =
  | { type: "reuse"; environmentId: string }
  | {
      type: "host";
      hostId: string;
      workspace: {
        type: "managed-worktree";
        baseBranch: { kind: "named"; name: string } | { kind: "default" };
      };
    };

interface WorkerPlacement {
  threadId: string;
  environmentId: string | null;
  branchName: string | null;
  provisionedEnvironment?: boolean;
}

/**
 * What a call resolves to. `reportIdentity` swaps the bare value for the
 * worker's identity alongside it, so a script can send follow-up work to the
 * same worker, address the worktree it created, and skip review for a lane
 * that committed nothing. `changedFiles` is null when the call did not run in
 * a lane workspace, or when git status was unavailable.
 */
function callResult(
  options: WorkflowAgentOptions,
  placement: Omit<WorkerPlacement, "threadId"> & { threadId: string | null },
  value: JsonValue,
  changedFiles: number | null = null,
): JsonValue {
  if (!options.reportIdentity) return value;
  return {
    value,
    threadId: placement.threadId,
    environmentId: placement.environmentId,
    branchName: placement.branchName,
    changedFiles,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRetryableProviderFailure(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const candidate = error as Record<string, unknown>;
    if (candidate.retryable === true) return true;
    const status = candidate.status ?? candidate.statusCode;
    if (
      typeof status === "number" &&
      [429, 500, 502, 503, 504, 529].includes(status)
    ) {
      return true;
    }
    if (
      typeof candidate.code === "string" &&
      /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)$/.test(
        candidate.code,
      )
    ) {
      return true;
    }
  }
  const detail = message(error).toLowerCase();
  return [
    /provider[^\n]*(?:overload|capacity|busy|temporar|unavailable|rate.?limit)/,
    /(?:rate.?limit|too many requests)/,
    /(?:http|status|api error|error)\s*(?:429|500|502|503|504|529)\b/,
    /\b(?:econnreset|econnrefused|etimedout|ehostunreach|enetunreach)\b/,
    /(?:connection reset|connection closed|socket hang up|network error)/,
  ].some((pattern) => pattern.test(detail));
}

export function formatWorkflowNotification(
  run: WorkflowRunRow,
  maximumBytes: number,
): string {
  const prefix = `[BB workflow finished · ${run.id}]\n\nRun ${run.id} (${run.name}) ${run.status}.\n`;
  const suffix = `\nRun \`bb workflows status ${run.id}\` for authoritative details.`;
  const detail =
    run.status === "succeeded"
      ? `Result: ${run.resultJson ?? "null"}`
      : `Error: ${run.error ?? run.status}`;
  const full = `${prefix}${detail}${suffix}`;
  if (Buffer.byteLength(full, "utf8") <= maximumBytes) return full;
  const marker = "\n…[truncated]";
  const available =
    maximumBytes -
    Buffer.byteLength(prefix, "utf8") -
    Buffer.byteLength(marker, "utf8") -
    Buffer.byteLength(suffix, "utf8");
  if (available >= 0) {
    return `${prefix}${utf8Prefix(detail, available)}${marker}${suffix}`;
  }
  return utf8Prefix(
    `[BB workflow ${run.id}] ${run.status} — run bb workflows status ${run.id}`,
    maximumBytes,
  );
}

function parseJson(text: string, path: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch (error) {
    throw new Error(`${path} is corrupt: ${message(error)}`);
  }
}

function normalizeWholeOutputJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?[\t ]*\r?\n([\s\S]*)\r?\n```$/i.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

function assertBoundedJson(
  value: unknown,
  path: string,
  limits: { bytes: number; nodes: number; depth: number },
): void {
  const ancestors = new Set<object>();
  let nodes = 0;

  function visit(current: unknown, depth: number): void {
    nodes += 1;
    if (nodes > limits.nodes) {
      throw new Error(`${path} exceeds the ${limits.nodes} node limit`);
    }
    if (depth > limits.depth) {
      throw new Error(`${path} exceeds the maximum depth of ${limits.depth}`);
    }
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new Error(`${path} contains a non-finite number`);
      }
      return;
    }
    if (typeof current !== "object") {
      throw new Error(`${path} contains a non-JSON value`);
    }
    if (ancestors.has(current)) {
      throw new Error(`${path} contains a cyclic value`);
    }
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const keys = Object.keys(current);
        if (
          keys.length !== current.length ||
          keys.some((key, index) => key !== String(index))
        ) {
          throw new Error(`${path} contains a sparse or decorated array`);
        }
        for (const item of current) visit(item, depth + 1);
        return;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`${path} contains an object with an unsafe prototype`);
      }
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key !== "string") {
          throw new Error(`${path} contains a symbol-keyed property`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        ) {
          throw new Error(`${path} contains an unsafe property`);
        }
        visit(descriptor.value, depth + 1);
      }
    } finally {
      ancestors.delete(current);
    }
  }

  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error(`${path} is not JSON`);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > limits.bytes) {
    throw new Error(`${path} exceeds the ${limits.bytes} byte limit`);
  }
}

function validateValue(
  schema: JsonSchema,
  value: JsonValue,
): { valid: true } | { valid: false; error: string } {
  try {
    assertBoundedJson(schema, "JSON Schema", SCHEMA_LIMITS);
    assertBoundedJson(value, "JSON value", VALUE_LIMITS);
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);
    if (validate(value)) return { valid: true };
    return {
      valid: false,
      error: ajv.errorsText(validate.errors, {
        separator: "; ",
        dataVar: "value",
      }),
    };
  } catch (error) {
    return { valid: false, error: message(error) };
  }
}

function resultToolParameters(
  outputSchema: JsonSchema,
): Record<string, unknown> {
  return {
    type: "object",
    properties: { value: outputSchema },
    required: ["value"],
    additionalProperties: false,
  };
}

function resolveStructuredValue(
  schema: JsonSchema,
  value: JsonValue,
): { value: JsonValue; validation: ReturnType<typeof validateValue> } {
  const validation = validateValue(schema, value);
  if (validation.valid || typeof value !== "string") {
    return { value, validation };
  }
  let unwrapped: JsonValue;
  try {
    unwrapped = JSON.parse(value) as JsonValue;
  } catch {
    return { value, validation };
  }
  const unwrappedValidation = validateValue(schema, unwrapped);
  if (unwrappedValidation.valid) {
    return { value: unwrapped, validation: unwrappedValidation };
  }
  return {
    value,
    validation: {
      valid: false,
      error: `${validation.error}. The value was a JSON-encoded string; pass the JSON value itself, not a string. After decoding it still fails validation: ${unwrappedValidation.error}`,
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const settle = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", settle);
      resolve();
    };
    const timeout = setTimeout(settle, ms);
    signal.addEventListener("abort", settle, { once: true });
  });
}

interface StartWorkflowInput {
  projectId: string;
  originThreadId: string;
  source: string;
  args: JsonValue;
  resumedFromRunId: string | null;
  /**
   * Start over uncommitted changes in the origin workspace. Refused by
   * default: lanes are cut from the origin's branch tip, so uncommitted work
   * is invisible to every lane and to every reviewer, and merges land on top
   * of it later.
   */
  allowDirty: boolean;
}

/**
 * Outcome of destroying a run's lane worktrees. `kept` is the important arm:
 * worktree removal is `git worktree remove --force`, so a lane whose tree is
 * still dirty is left standing rather than silently discarded.
 */
export interface WorkflowTeardownReport {
  runId: string;
  destroyed: Array<{ environmentId: string; branchName: string | null }>;
  kept: Array<{
    environmentId: string;
    branchName: string | null;
    reason: string;
  }>;
}

export interface WorkflowService {
  start(input: StartWorkflowInput): Promise<WorkflowRunRow>;
  get(runId: string): WorkflowRunRow | null;
  inspect(runId: string): WorkflowRunInspection | null;
  inspectPage(
    runId: string,
    afterCallIndex: number,
    limit: number,
  ): WorkflowRunInspectionPage | null;
  inspectLatestForThread(threadId: string): WorkflowRunInspection | null;
  inspectActiveForThread(threadId: string): WorkflowRunInspection[];
  list(projectId: string, limit: number): WorkflowRunRow[];
  stop(runId: string): Promise<boolean>;
  teardown(
    runId: string,
    options: { discardUncommitted: boolean },
  ): Promise<WorkflowTeardownReport>;
  updateSettings(settings: WorkflowSettings): void;
  runWorker(signal: AbortSignal): Promise<void>;
  onThreadIdle(threadId: string, output: string | null): void;
  onThreadFailed(threadId: string, error: string | null): void;
  onThreadArchived(threadId: string): void;
  onThreadDeleted(threadId: string): void;
  onOriginUnavailable(threadId: string): Promise<void>;
  submitStructuredResult(
    threadId: string,
    value: JsonValue,
  ): Promise<{ ok: true } | { ok: false; terminal: boolean; error: string }>;
  agentConfiguration(threadId: string): {
    resultParameters: Record<string, unknown> | null;
    terminal: boolean;
    instructions: string | null;
  } | null;
}

export interface WorkflowCallInspection extends WorkflowCallRow {
  options: WorkflowAgentOptions;
  execution: {
    provider: string;
    model: string;
    reasoningLevel: string;
    permissionMode: string;
  };
  source: "cached" | "live";
}

export interface WorkflowRunInspection extends WorkflowRunRow {
  calls: WorkflowCallInspection[];
}

export interface WorkflowRunInspectionPage {
  run: WorkflowRunRow;
  calls: WorkflowCallInspection[];
  callCounts: WorkflowCallCounts;
}

export function createWorkflowService(
  bb: BbPluginApi,
  db: Db,
  initialSettings: WorkflowSettings = DEFAULT_WORKFLOW_SETTINGS,
): WorkflowService {
  let shuttingDown = false;
  let currentSettings = initialSettings;
  let claimRequested = true;
  let wakeWaiter: (() => void) | null = null;

  function wakeWorker(): void {
    claimRequested = true;
    wakeWaiter?.();
  }

  function waitForWork(ms: number, signal: AbortSignal): Promise<void> {
    if (claimRequested || signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const settle = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", settle);
        wakeWaiter = null;
        resolve();
      };
      const timeout = setTimeout(settle, Math.max(0, ms));
      wakeWaiter = settle;
      signal.addEventListener("abort", settle, { once: true });
    });
  }
  const controllers = new Map<string, AbortController>();
  const idleHandlers = new Set<string>();
  const pendingIdleOutputs = new Map<string, string | null>();
  const handlerTasks = new Set<Promise<void>>();
  const idleHandlerTasks = new Map<string, Promise<void>>();
  const childStops = new Map<string, Promise<void>>();
  const continuingWorkers = new Set<string>();
  const continuationAdmissions = new Map<string, { afterSeq: number; prompt: string; pending: boolean }>();
  const waiters = new Map<
    string,
    { resolve: (value: JsonValue) => void; reject: (error: Error) => void }
  >();

  function throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new Error("Workflow cancelled");
  }

  function publishRunsChanged(originThreadId: string): void {
    bb.rpc.experimental_invalidate([`runs:${originThreadId}`]);
  }

  function publishRunProgress(runId: string): void {
    const run = getRun(db, runId);
    if (run !== null) publishRunsChanged(run.originThreadId);
  }

  const spawningCalls = new Set<string>();

  async function onOriginUnavailable(threadId: string): Promise<void> {
    const stops = listActiveRunsForOriginThread(db, threadId).map((run) =>
      stop(run.id),
    );
    abandonOriginNotifications(db, threadId);
    await Promise.all(stops);
  }

  async function originUnavailable(threadId: string): Promise<boolean> {
    try {
      const origin = await bb.sdk.threads.get({ threadId });
      return origin.archivedAt != null;
    } catch (error) {
      if (isMissingThread(error)) return true;
      throw error;
    }
  }

  async function waitForOrigin(
    threadId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    let delay = 1_000;
    while (true) {
      throwIfCancelled(signal);
      try {
        return await originUnavailable(threadId);
      } catch (error) {
        if (!isRetryableProviderFailure(error)) throw error;
        await sleep(delay, signal);
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }

  async function reconcileOrigins(): Promise<void> {
    for (const threadId of workerOrigins(db, Date.now())) {
      try {
        if (await originUnavailable(threadId))
          await onOriginUnavailable(threadId);
      } catch (error) {
        bb.log.warn(
          `Could not reconcile workflow origin ${threadId}: ${message(error)}`,
        );
      }
    }
  }

  const ownershipSchema = z.object({
    workflowWorker: z.literal(1),
    runId: z.string().min(1),
    callId: z.string().min(1),
    originThreadId: z.string().min(1),
  });

  async function discoverWorkers(): Promise<void> {
    let offset = 0;
    while (true) {
      const threads = await bb.sdk.threads.list({
        originPluginId: bb.pluginId,
        includeHidden: true,
        archived: false,
        limit: 100,
        offset,
      });
      for (const thread of threads) {
        if (hasWorker(db, thread.id)) continue;
        try {
          const metadata = ownershipSchema.safeParse(
            await bb.sdk.threads.getPluginMetadata({ threadId: thread.id }),
          );
          if (!metadata.success) continue;
          const owner = metadata.data;
          ownWorker(
            db,
            thread.id,
            owner.runId,
            owner.callId,
            owner.originThreadId,
          );
        } catch (error) {
          if (!isMissingThread(error))
            bb.log.warn(
              `Could not discover workflow worker ${thread.id}: ${message(error)}`,
            );
        }
      }
      if (threads.length < 100) break;
      offset += threads.length;
    }
  }

  async function cleanupWorkers(): Promise<void> {
    for (const worker of retiredWorkers(db, Date.now())) {
      if (
        spawningCalls.has(worker.callId) ||
        !isWorkerRetired(db, worker.threadId)
      )
        continue;
      recordWorkerCleanup(
        db,
        worker.threadId,
        await archiveRetiredWorker(worker.threadId),
      );
    }
  }

  async function stopChild(threadId: string): Promise<void> {
    const pending = childStops.get(threadId);
    if (pending !== undefined) return pending;
    const stopping = bb.sdk.threads
      .stop({ threadId })
      .then(() => undefined)
      .catch((error) => {
        if (!isMissingThread(error)) {
          bb.log.warn(
            `Could not stop workflow worker ${threadId}: ${message(error)}`,
          );
        }
      })
      .finally(() => childStops.delete(threadId));
    childStops.set(threadId, stopping);
    return stopping;
  }

  async function stopChildren(threadIds: Iterable<string>): Promise<void> {
    await Promise.all(Array.from(threadIds, (threadId) => stopChild(threadId)));
  }

  async function resolveOrigin(input: StartWorkflowInput) {
    const thread = await bb.sdk.threads.get({ threadId: input.originThreadId });
    if (thread.environmentId === null) {
      throw new Error("Workflow origin thread has no environment");
    }
    const defaults = executionValuesSchema.parse(
      await bb.sdk.threads.defaultExecutionOptions({
        threadId: input.originThreadId,
      }),
    );
    return {
      environmentId: thread.environmentId,
      providerId: thread.providerId,
      ...defaults,
    };
  }

  /**
   * The lane's host must match its orchestrator. The immutable default base
   * commit is captured and persisted by start(), not looked up from this host
   * or a moving branch when a later call finally provisions its workspace.
   */
  const originHostIds = new Map<string, Promise<string>>();
  function originHostId(run: WorkflowRunRow): Promise<string> {
    const cached = originHostIds.get(run.id);
    if (cached !== undefined) return cached;
    const resolving = bb.sdk.environments
      .get({ environmentId: run.environmentId })
      .then((environment) => environment.hostId);
    originHostIds.set(run.id, resolving);
    void resolving.catch(() => originHostIds.delete(run.id));
    return resolving;
  }


  async function spawnEnvironmentArgs(
    run: WorkflowRunRow,
    environment: WorkflowAgentOptions["environment"],
  ): Promise<ThreadSpawnEnvironment> {
    if (environment === null) {
      return { type: "reuse", environmentId: run.environmentId };
    }
    if (environment.kind === "existing") {
      return { type: "reuse", environmentId: environment.environmentId };
    }
    const hostId = await originHostId(run);
    const base = environment.baseBranch ?? run.launchBaseCommit;
    if (base === null) {
      throw new Error("Cannot provision a lane without a known launch commit; start a new run when Git status is available");
    }
    return {
      type: "host",
      hostId,
      workspace: {
        type: "managed-worktree",
        baseBranch:
          base === null ? { kind: "default" } : { kind: "named", name: base },
      },
    };
  }

  /**
   * Read a workspace's git state, or null when it cannot be read at all — a
   * personal workspace has none, and a host that cannot answer is not evidence
   * of anything. Callers decide what an unknown answer means; none of them may
   * treat it as "clean".
   */
  async function readWorkspaceStatus(
    environmentId: string,
    mergeBaseBranch?: string,
  ) {
    try {
      return await bb.sdk.plugins.callRpc({
        pluginId: "git",
        method: "workspaceStatus",
        input: {
          environmentId,
          ...(mergeBaseBranch === undefined ? {} : { mergeBaseBranch }),
        },
        outputSchema: gitStatusResultSchema,
      });
    } catch (error) {
      bb.log.debug(
        `Could not read workspace status for ${environmentId}: ${message(error)}`,
      );
      return null;
    }
  }

  /**
   * A lane worktree starts at the origin branch's tip, so anything still
   * uncommitted in the orchestrator's workspace is invisible to every lane
   * that reads the code and to every reviewer that judges it. Refusing here
   * costs nothing; discovering it after eight lanes have branched costs the
   * whole run.
   *
   * Only a workspace KNOWN to be dirty blocks a run. A personal workspace has
   * no git state to read, and a host that cannot answer right now is not
   * evidence of anything — neither may stop a workflow that does not use
   * lanes at all.
   */
  function assertOriginCommitted(
    status: GitStatusResult | null,
    allowDirty: boolean,
  ): void {
    if (allowDirty) return;
    if (status === null || status.outcome !== "available") return;
    const workingTree = status.workspace.workingTree;
    if (!workingTree.hasUncommittedChanges) return;
    const files = workingTree.files
      .slice(0, 5)
      .map((file) => file.path)
      .join(", ");
    throw new Error(
      `Workflow origin workspace has ${workingTree.files.length} uncommitted file(s) (${files}` +
        `${workingTree.files.length > 5 ? ", …" : ""}). Commit them so lanes branch from the same code, ` +
        `or start again with allowDirty to accept that lanes will not see them.`,
    );
  }

  async function start(input: StartWorkflowInput): Promise<WorkflowRunRow> {
    const parsed = parseWorkflowSource(input.source);
    assertBoundedJson(input.args, "Workflow args", VALUE_LIMITS);
    if (parsed.metadata.inputSchema !== null) {
      assertBoundedJson(
        parsed.metadata.inputSchema,
        "Workflow input schema",
        SCHEMA_LIMITS,
      );
    }
    if (parsed.metadata.outputSchema !== null) {
      assertBoundedJson(
        parsed.metadata.outputSchema,
        "Workflow output schema",
        SCHEMA_LIMITS,
      );
    }
    if (parsed.metadata.inputSchema !== null) {
      const validation = validateValue(parsed.metadata.inputSchema, input.args);
      if (!validation.valid)
        throw new Error(`Workflow args are invalid: ${validation.error}`);
    }
    const origin = await resolveOrigin(input);
    if (input.resumedFromRunId !== null) {
      const previous = getRun(db, input.resumedFromRunId);
      if (previous === null || previous.projectId !== input.projectId) {
        throw new Error(
          `Cannot resume unknown workflow run ${input.resumedFromRunId}`,
        );
      }
      if (previous.status === "queued" || previous.status === "running") {
        throw new Error(
          `Cannot resume workflow run ${input.resumedFromRunId} before it is terminal`,
        );
      }
      if (previous.environmentId !== origin.environmentId) {
        throw new Error(
          `Cannot resume workflow run ${input.resumedFromRunId} from a different environment or workspace`,
        );
      }
    }
    const launchStatus = await readWorkspaceStatus(origin.environmentId);
    assertOriginCommitted(launchStatus, input.allowDirty);
    const created = createRun(db, {
      projectId: input.projectId,
      originThreadId: input.originThreadId,
      environmentId: origin.environmentId,
      launchBaseCommit: launchStatus?.outcome === "available" &&
        (launchStatus.workspace.checkout.kind === "branch" || launchStatus.workspace.checkout.kind === "detached")
        ? launchStatus.workspace.checkout.headSha
        : null,
      originProvider: origin.providerId,
      originModel: origin.model,
      originReasoningLevel: origin.reasoningLevel,
      originPermissionMode: origin.permissionMode,
      name: parsed.metadata.name,
      source: input.source,
      sourceHash: createHash("sha256").update(input.source).digest("hex"),
      argsJson: JSON.stringify(input.args),
      settingsJson: JSON.stringify(currentSettings),
      resumedFromRunId: input.resumedFromRunId,
    });
    wakeWorker();
    publishRunsChanged(created.originThreadId);
    return created;
  }

  function settingsForRun(run: WorkflowRunRow): WorkflowSettings {
    return parseStoredWorkflowSettings(
      parseJson(run.settingsJson, "workflow settings snapshot"),
    );
  }

  function inspectCall(call: WorkflowCallRow): WorkflowCallInspection {
    return {
      ...call,
      options: parseStoredAgentOptions(
        parseJson(call.optionsJson, "workflow call options"),
      ),
      execution: {
        provider: call.resolvedProvider,
        model: call.resolvedModel,
        reasoningLevel: call.resolvedReasoningLevel,
        permissionMode: call.resolvedPermissionMode,
      },
      source: call.replaySource === null ? "live" : "cached",
    };
  }

  function inspect(runId: string): WorkflowRunInspection | null {
    const run = getRun(db, runId);
    if (run === null) return null;
    return {
      ...run,
      calls: listCallsForRun(db, runId).map(inspectCall),
    };
  }

  function inspectPage(
    runId: string,
    afterCallIndex: number,
    limit: number,
  ): WorkflowRunInspectionPage | null {
    if (!Number.isInteger(afterCallIndex) || afterCallIndex < -1) {
      throw new Error("afterCallIndex must be an integer of -1 or greater");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 101) {
      throw new Error("limit must be an integer from 1 to 101");
    }
    const run = getRun(db, runId);
    if (run === null) return null;
    return {
      run,
      calls: listCallsForRunPage(db, {
        runId,
        afterCallIndex,
        limit,
      }).map(inspectCall),
      callCounts: countCallsForRun(db, runId),
    };
  }

  function inspectLatestForThread(
    threadId: string,
  ): WorkflowRunInspection | null {
    const run = getLatestRunForOriginThread(db, threadId);
    return run === null ? null : inspect(run.id);
  }

  function inspectActiveForThread(threadId: string): WorkflowRunInspection[] {
    return listActiveRunsForOriginThread(db, threadId).map((run) => {
      const inspection = inspect(run.id);
      if (inspection === null) {
        throw new Error(`Unknown workflow run ${run.id}`);
      }
      return inspection;
    });
  }

  async function validateSelection(
    run: WorkflowRunRow,
    options: WorkflowAgentOptions,
    signal: AbortSignal,
  ): Promise<ResolvedSelection> {
    const inherited = options.selection === null;
    const requested = options.selection ?? {
      provider: run.originProvider,
      model: run.originModel,
      reasoningLevel: run.originReasoningLevel,
    };
    const providers = await bb.sdk.providers.list({
      environmentId: run.environmentId,
    });
    throwIfCancelled(signal);
    const provider = providers.find(
      (candidate) => candidate.id === requested.provider && candidate.available,
    );
    if (provider === undefined) {
      throw new Error(
        `Provider ${JSON.stringify(requested.provider)} is not available on this workflow host`,
      );
    }
    const catalog = await bb.sdk.providers.models({
      environmentId: run.environmentId,
      providerId: requested.provider,
    });
    throwIfCancelled(signal);
    if (catalog.modelLoadError !== null) {
      throw new Error(
        `Could not load models for provider ${requested.provider}: ${catalog.modelLoadError.code}`,
      );
    }
    const eligibleModels = inherited
      ? [...catalog.models, ...catalog.selectedOnlyModels]
      : catalog.models;
    const model = eligibleModels.find(
      (candidate) =>
        candidate.id === requested.model || candidate.model === requested.model,
    );
    if (model === undefined) {
      throw new Error(
        `Model ${JSON.stringify(requested.model)} is not available for provider ${requested.provider}`,
      );
    }
    if (
      !model.supportedReasoningEfforts.some(
        (effort) => effort.reasoningEffort === requested.reasoningLevel,
      )
    ) {
      throw new Error(
        `Reasoning level ${JSON.stringify(requested.reasoningLevel)} is not supported by ${requested.provider}/${requested.model}`,
      );
    }
    const permissionMode = executionValuesSchema.shape.permissionMode.parse(
      run.originPermissionMode,
    );
    if (!provider.capabilities.permissionModes.includes(permissionMode)) {
      throw new Error(
        `Permission mode ${JSON.stringify(run.originPermissionMode)} is not supported by provider ${requested.provider}`,
      );
    }
    return selectedExecutionSchema.parse({
      providerId: requested.provider,
      model: model.model,
      reasoningLevel: requested.reasoningLevel,
      permissionMode,
    });
  }

  function childPrompt(
    run: WorkflowRunRow,
    prompt: string,
    options: WorkflowAgentOptions,
  ) {
    const header = `[BB workflow ${run.name} · run ${run.id}]`;
    if (options.outputSchema === null) {
      return `${header}\n\n${prompt}\n\nYour final text IS the return value (not a human-facing message), so return raw data.`;
    }
    return `${header}\n\n${prompt}\n\nUse bb_workflow_result to return your final response in the requested structured format. You MUST call this tool exactly once at the end of your response with {"value": ...} to provide the structured output. The value must satisfy this JSON Schema:\n${JSON.stringify(options.outputSchema, null, 2)}\nIf the tool is unavailable during startup, return only the JSON value in your final response as a fallback. If the tool reports validation errors, correct the value and retry. You have at most ${MAX_REPAIR_ATTEMPTS} corrective retries.`;
  }

  function canReplayCall(run: WorkflowRunRow): boolean {
    return run.replaySafetyVersion === 1;
  }

  function waitForCall(
    call: WorkflowCallRow,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    if (signal.aborted) return Promise.reject(new Error("Workflow cancelled"));
    const latest = getCall(db, call.runId, call.callIndex);
    if (latest?.status === "succeeded" && latest.resultJson !== null) {
      return Promise.resolve(
        parseJson(latest.resultJson, "workflow call result"),
      );
    }
    if (latest?.status === "failed" || latest?.status === "cancelled") {
      return Promise.reject(
        new Error(latest.error ?? `Workflow call ${latest.status}`),
      );
    }
    return new Promise((resolve, reject) => {
      waiters.set(call.id, { resolve, reject });
      signal.addEventListener(
        "abort",
        () => {
          waiters.delete(call.id);
          reject(new Error("Workflow cancelled"));
        },
        { once: true },
      );
    });
  }

  async function spawnWorker(
    run: WorkflowRunRow,
    callIndex: number,
    callId: string,
    prompt: string,
    options: WorkflowAgentOptions,
    selection: ResolvedSelection,
  ): Promise<WorkerPlacement> {
    const child = await bb.sdk.threads.spawn({
      lifecycleOwnerThreadId: run.originThreadId,
      pluginMetadata: {
        workflowWorker: 1,
        runId: run.id,
        callId,
        originThreadId: run.originThreadId,
      },
      projectId: run.projectId,
      environment: await spawnEnvironmentArgs(run, options.environment),
      prompt: childPrompt(run, prompt, options),
      title: options.title ?? `${run.name} · ${callIndex + 1}`,
      providerId: selection.providerId,
      model: selection.model,
      reasoningLevel: selection.reasoningLevel,
      permissionMode: selection.permissionMode,
      visibility: "hidden",
      // A lane worker outlives its first call and the orchestrator has to be
      // able to reach it, so it is parented and reports blockers upward.
      // Ordinary workers stay root: a hundred-call run would otherwise
      // notify the origin a hundred times over.
      ...(options.environment === null
        ? {}
        : { parentThreadId: run.originThreadId }),
    });
    ownWorker(db, child.id, run.id, callId, run.originThreadId);
    return {
      threadId: child.id,
      environmentId: child.environmentId ?? null,
      branchName: null,
      provisionedEnvironment: false,
    };
  }

  /**
   * Send follow-up work to a worker that already exists. The worker keeps its
   * conversation, its workspace, and its own execution settings, so the
   * provider has to match what this call resolved: a lane executor cannot
   * change provider mid-lane.
   */
  async function continueWorker(
    run: WorkflowRunRow,
    threadId: string,
    selection: ResolvedSelection,
  ): Promise<WorkerPlacement> {
    const previous = getCallByChildThread(db, threadId);
    if (
      !hasWorker(db, threadId) || previous === null ||
      previous.runId !== run.id || previous.status !== "succeeded" ||
      previous.replayedFromCallId !== null || previous.environmentId === null
    ) {
      throw new Error(`Cannot continue worker ${threadId}: it is not an idle worker owned by this run`);
    }
    await childStops.get(threadId);
    const thread = await bb.sdk.threads.get({ threadId });
    if (
      thread.projectId !== run.projectId || thread.archivedAt != null ||
      thread.status !== "idle" || thread.environmentId !== previous.environmentId
    ) {
      throw new Error(`Cannot continue worker ${threadId}: project, environment or idle state no longer matches`);
    }
    if (thread.providerId !== selection.providerId) {
      throw new Error(
        `Cannot continue worker ${threadId} on provider ${selection.providerId}: it runs on ${thread.providerId}`,
      );
    }
    return {
      threadId,
      environmentId: thread.environmentId,
      branchName: previous.branchName,
      provisionedEnvironment: false,
    };
  }

  /**
   * Read back where a worker actually ran. Worktree provisioning is
   * asynchronous, so the spawn response can carry a null environment; by the
   * time the worker's turn has settled the environment exists, which is the
   * only point this is called.
   */
  async function resolveWorkerPlacement(
    threadId: string,
    provisionRequested: boolean,
    expectedEnvironmentId: string | null,
    run: WorkflowRunRow,
  ): Promise<WorkerPlacement> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.status !== "idle") {
      throw new Error(`Cannot postprocess worker ${threadId}: shutdown has not reached idle`);
    }
    if (thread.environmentId === null) {
      return { threadId, environmentId: null, branchName: null };
    }
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
    });
    return {
      threadId,
      environmentId: environment.id,
      branchName: environment.branchName,
      provisionedEnvironment: provisionRequested &&
        (expectedEnvironmentId === null || expectedEnvironmentId === environment.id) &&
        environment.id !== run.environmentId && environment.projectId === run.projectId &&
        environment.managed && environment.isWorktree &&
        environment.workspaceProvisionType === "managed-worktree",
    };
  }

  /**
   * Close out a lane worker's workspace before anything else looks at it.
   *
   * Two facts drive this. Worktree teardown runs `git worktree remove --force`,
   * so anything a worker leaves uncommitted is destroyed rather than kept —
   * which makes "commit before review" a data-loss guard, not a style rule.
   * And a reviewer is worth spawning only when the lane actually produced
   * commits, so the committed-change count travels back with the identity.
   *
   * Both answers come from BB's own environment actions; nothing is delegated
   * to a prompt the worker could argue with.
   */
  async function closeOutWorkspace(
    run: WorkflowRunRow,
    placement: WorkerPlacement,
  ): Promise<{ committed: boolean; changedFiles: number | null }> {
    if (
      placement.environmentId === null ||
      placement.environmentId === run.environmentId
      || placement.provisionedEnvironment !== true
    ) {
      return { committed: false, changedFiles: null };
    }
    const environmentId = placement.environmentId;
    const environment = await bb.sdk.environments.get({ environmentId });
    if (environment.projectId !== run.projectId) {
      return { committed: false, changedFiles: null };
    }
    const mergeBaseBranch = environment.baseBranch ?? undefined;
    let status = await readWorkspaceStatus(environmentId, mergeBaseBranch);
    let committed = false;
    if (
      status?.outcome === "available" &&
      status.workspace.workingTree.hasUncommittedChanges
    ) {
      const commit = await bb.sdk.environments.commit({ environmentId });
      committed = true;
      bb.log.info(
        `[${run.id}] Committed work the lane worker left uncommitted in ${environmentId}` +
          `${commit.commitSha === null ? "" : ` as ${commit.commitSha}`}`,
      );
      status = await readWorkspaceStatus(environmentId, mergeBaseBranch);
      if (
        status?.outcome === "available" &&
        status.workspace.workingTree.hasUncommittedChanges
      ) {
        bb.log.warn(
          `[${run.id}] Environment ${environmentId} is still dirty after committing; teardown would discard it`,
        );
      }
    }
    return {
      committed,
      changedFiles:
        status?.outcome === "available"
          ? (status.workspace.mergeBase?.fileCount ?? null)
          : null,
    };
  }

  async function runAgentCall(
    run: WorkflowRunRow,
    callIndex: number,
    prompt: string,
    options: WorkflowAgentOptions,
    replay: { prefix: boolean },
    identity: Promise<{
      cacheKey: string;
      selection: ResolvedSelection;
    }>,
    replayDecision: { previous: Promise<void>; release: () => void },
    signal: AbortSignal,
  ): Promise<JsonValue> {
    await replayDecision.previous;
    let call: WorkflowCallRow;
    let selection: ResolvedSelection;
    try {
      throwIfCancelled(signal);
      if (options.outputSchema !== null) {
        assertBoundedJson(
          options.outputSchema,
          "Agent output schema",
          SCHEMA_LIMITS,
        );
      }
      const resolvedIdentity = await identity;
      const cacheKey = resolvedIdentity.cacheKey;
      selection = resolvedIdentity.selection;
      const sameRunCall = getCall(db, run.id, callIndex);
      if (replay.prefix) {
        if (sameRunCall !== null) {
          const sourceRun = getRunRequired(db, run.id);
          if (!canReplayCall(sourceRun)) {
            replay.prefix = false;
          }
          if (replay.prefix) {
            const result =
              sameRunCall.resultJson === null
                ? null
                : parseJson(sameRunCall.resultJson, "workflow call result");
            const reuse = reusableSuccessfulResult({
              status: sameRunCall.status,
              result,
            });
            if (sameRunCall.cacheKey === cacheKey && reuse.reusable) {
              markCallReplayedSameRun(db, sameRunCall.id);
              publishRunsChanged(run.originThreadId);
              return callResult(
                options,
                { ...sameRunCall, threadId: sameRunCall.childThreadId },
                reuse.result,
                sameRunCall.changedFiles,
              );
            }
          }
          replay.prefix = false;
        } else if (run.resumedFromRunId !== null) {
          const currentRun = getRunRequired(db, run.id);
          const sourceRun = getRunRequired(db, run.resumedFromRunId);
          if (!canReplayCall(currentRun) || !canReplayCall(sourceRun)) {
            replay.prefix = false;
          }
          if (replay.prefix) {
            const candidate = getCall(db, run.resumedFromRunId, callIndex);
            const result =
              candidate?.resultJson === null || candidate === null
                ? null
                : parseJson(
                    candidate.resultJson,
                    "resumed workflow call result",
                  );
            const reuse = reusableSuccessfulResult(
              candidate === null ? null : { status: candidate.status, result },
            );
            if (candidate?.cacheKey === cacheKey && reuse.reusable) {
              const replayed = startCall(db, {
                runId: run.id,
                callIndex,
                cacheKey,
                prompt,
                options,
                selection,
                replay: { callId: candidate.id, result: reuse.result },
              });
              publishRunsChanged(run.originThreadId);
              recordCallPlacement(db, replayed.id, {
                ...candidate, threadId: candidate.childThreadId, provisionedEnvironment: false,
              });
              return callResult(
                options,
                { ...candidate, threadId: candidate.childThreadId },
                reuse.result,
                candidate.changedFiles,
              );
            }
          }
          replay.prefix = false;
        }
      }

      call = startCall(db, {
        runId: run.id,
        callIndex,
        cacheKey,
        prompt,
        options,
        selection,
        replay: null,
      });
      publishRunsChanged(run.originThreadId);
    } finally {
      replayDecision.release();
    }
    while (true) {
      let claimedContinuation: string | null = null;
      try {
        throwIfCancelled(signal);
        if (await waitForOrigin(run.originThreadId, signal)) {
          await onOriginUnavailable(run.originThreadId);
          throw new Error("Workflow origin is archived or deleted");
        }
        throwIfCancelled(signal);
        spawningCalls.add(call.id);
        const continuing = options.continueThreadId;
        if (continuing !== null) {
          if (continuingWorkers.has(continuing)) {
            throw new Error(`Cannot continue worker ${continuing}: another call is using it`);
          }
          continuingWorkers.add(continuing);
          claimedContinuation = continuing;
        }
        const worker = continuing === null
          ? await spawnWorker(run, callIndex, call.id, prompt, options, selection)
          : await continueWorker(run, continuing, selection);
        if (signal.aborted) {
          await stopChild(worker.threadId);
          throw new Error("Workflow cancelled");
        }
        if (continuing !== null) {
          const events = await bb.sdk.threads.events.list({
            threadId: worker.threadId, order: "desc", limit: "1",
          });
          continuationAdmissions.set(call.id, {
            afterSeq: events[0]?.seq ?? 0,
            prompt: childPrompt(run, prompt, options),
            pending: true,
          });
        }
        const attached = attachCallThread(db, call.id, worker.threadId, worker);
        if (!attached || signal.aborted) {
          await stopChild(worker.threadId);
          throw new Error("Workflow cancelled");
        }
        publishRunsChanged(run.originThreadId);
        spawningCalls.delete(call.id);
        if (continuing !== null) {
          const admission = continuationAdmissions.get(call.id)!;
          const sent = await bb.sdk.threads.send({
            threadId: worker.threadId,
            mode: "auto",
            input: [{ type: "text", text: admission.prompt, mentions: [] }],
          });
          if (sent.delivery === "sent") continuationAdmissions.delete(call.id);
          else admission.pending = false;
          throwIfCancelled(signal);
        }
        const stopOnAbort = () => void stopChild(worker.threadId);
        signal.addEventListener("abort", stopOnAbort, { once: true });
        try {
          const current = await bb.sdk.threads.get({
            threadId: worker.threadId,
          });
          throwIfCancelled(signal);
          if (current.status === "idle") {
            const output = await bb.sdk.threads.output({
              threadId: worker.threadId,
            });
            throwIfCancelled(signal);
            onThreadIdle(worker.threadId, output.output);
          } else if (current.status === "error") {
            failThreadCall(
              worker.threadId,
              "Workflow worker failed before attachment completed",
            );
          }
        } catch (error) {
          if (signal.aborted) {
            await stopChild(worker.threadId);
            throw error;
          }
          bb.log.warn(
            `Could not reconcile new workflow worker ${worker.threadId}: ${message(error)}`,
          );
        }
        try {
          const value = await waitForCall(call, signal);
          await childStops.get(worker.threadId);
          throwIfCancelled(signal);
          const inLaneWorkspace =
            options.environment !== null || options.continueThreadId !== null;
          if (!options.reportIdentity && !inLaneWorkspace) {
            return value;
          }
          const placement = await resolveWorkerPlacement(
            worker.threadId, options.environment?.kind === "worktree",
            worker.environmentId, run,
          );
          recordCallPlacement(db, call.id, placement);
          const workspace = await closeOutWorkspace(run, placement);
          recordCallPlacement(db, call.id, { ...placement, changedFiles: workspace.changedFiles });
          return callResult(options, placement, value, workspace.changedFiles);
        } finally {
          signal.removeEventListener("abort", stopOnAbort);
        }
      } catch (error) {
        spawningCalls.delete(call.id);
        throwIfCancelled(signal);
        // Sending to an existing conversation is not idempotent. A failed
        // acknowledgement must not cause another turn to be sent automatically.
        if (options.continueThreadId !== null) throw error;
        const delay = PROVIDER_RETRY_DELAYS_MS[call.providerRetryAttempts];
        if (delay === undefined || !isRetryableProviderFailure(error)) {
          throw error;
        }
        const detail = message(error);
        const queued = queueCallProviderRetry(db, call.id, detail);
        if (queued === null) throw error;
        call = queued;
        publishRunsChanged(run.originThreadId);
        bb.log.warn(
          `[${run.id}] Retrying agent call ${callIndex + 1} after transient provider failure ` +
            `(${call.providerRetryAttempts}/${PROVIDER_RETRY_DELAYS_MS.length}) in ${delay} ms: ${detail}`,
        );
        await sleep(delay, signal);
      } finally {
        continuationAdmissions.delete(call.id);
        if (claimedContinuation !== null) continuingWorkers.delete(claimedContinuation);
      }
    }
  }

  function wakeCall(call: WorkflowCallRow): void {
    publishRunProgress(call.runId);
    const waiter = waiters.get(call.id);
    if (waiter === undefined) return;
    waiters.delete(call.id);
    const latest = getCall(db, call.runId, call.callIndex);
    if (latest?.status === "succeeded" && latest.resultJson !== null) {
      try {
        waiter.resolve(parseJson(latest.resultJson, "workflow call result"));
      } catch (error) {
        waiter.reject(
          error instanceof Error ? error : new Error(message(error)),
        );
      }
      return;
    }
    waiter.reject(new Error(latest?.error ?? "Workflow call failed"));
  }

  async function handleThreadIdle(
    threadId: string,
    output: string | null,
  ): Promise<void> {
    const call = getCallByChildThread(db, threadId);
    if (call === null || call.status !== "running") return;
    const admission = continuationAdmissions.get(call.id);
    if (admission !== undefined) {
      if (admission.pending) return;
      // Queue disappearance is not admission (it may have been cancelled).
      // A durable turn request containing our input proves it was submitted.
      const requests = await bb.sdk.threads.events.list({
        threadId, afterSeq: String(admission.afterSeq),
        types: ["client/turn/requested"], order: "asc", limit: "100",
      });
      const submitted = requests.some((event) =>
        event.type === "client/turn/requested" &&
        event.data.originPluginId === bb.pluginId &&
        [event.data.input, ...(event.data.inputGroups ?? [])].some((group) =>
          group.some((input) => input.type === "text" && input.text === admission.prompt)),
      );
      if (!submitted) return;
      const current = await bb.sdk.threads.get({ threadId });
      if (current.status !== "idle") return;
      output = (await bb.sdk.threads.output({ threadId })).output;
      continuationAdmissions.delete(call.id);
    }
    const options = parseStoredAgentOptions(JSON.parse(call.optionsJson));
    if (options.outputSchema !== null) {
      if (call.resultJson !== null) {
        settleCall(db, {
          id: call.id,
          status: "succeeded",
          result: parseJson(call.resultJson, "structured result"),
          error: null,
        });
        wakeCall(call);
        return;
      }

      let fallback:
        | { parsed: false; error: string }
        | {
            parsed: true;
            value: JsonValue;
            validation: ReturnType<typeof validateValue>;
          } = {
        parsed: false,
        error: "the worker did not return a JSON value",
      };
      if (output !== null) {
        try {
          const value = parseJson(
            normalizeWholeOutputJsonFence(output),
            "worker JSON response",
          );
          const resolved = resolveStructuredValue(options.outputSchema, value);
          fallback = {
            parsed: true,
            value: resolved.value,
            validation: resolved.validation,
          };
        } catch (error) {
          fallback = { parsed: false, error: message(error) };
        }
      }
      if (fallback.parsed && fallback.validation.valid) {
        const stored = storeStructuredResult(db, call.id, fallback.value);
        if (stored === "accepted" || stored === "idempotent") {
          settleCall(db, {
            id: call.id,
            status: "succeeded",
            result: fallback.value,
            error: null,
          });
          wakeCall(call);
          return;
        }
      }

      const attempts = incrementRepairAttempts(db, call.id);
      if (attempts === null) {
        wakeCall(call);
        return;
      }
      publishRunProgress(call.runId);
      const detail = fallback.parsed
        ? fallback.validation.valid
          ? "a structured result was already recorded"
          : fallback.validation.error
        : fallback.error;
      if (attempts > MAX_REPAIR_ATTEMPTS) {
        const error = `Structured output failed after ${MAX_REPAIR_ATTEMPTS} corrective turns: ${detail}`;
        settleCall(db, { id: call.id, status: "failed", result: null, error });
        wakeCall(call);
        await stopChild(threadId);
        return;
      }

      try {
        await bb.sdk.threads.send({
          threadId,
          mode: "auto",
          input: [
            {
              type: "text",
              text: `Structured result missing or invalid (${detail}). Call bb_workflow_result with one value matching the required schema. Corrective turn ${attempts} of ${MAX_REPAIR_ATTEMPTS}.`,
              mentions: [],
            },
          ],
        });
        return;
      } catch (error) {
        const correctionError = `Could not request structured-output correction: ${message(error)}`;
        settleCall(db, {
          id: call.id,
          status: "failed",
          result: null,
          error: correctionError,
        });
        wakeCall(call);
        await stopChild(threadId);
      }
    } else {
      settleCall(db, {
        id: call.id,
        status: "succeeded",
        result: output ?? "",
        error: null,
      });
    }
    wakeCall(call);
  }

  function onThreadIdle(threadId: string, output: string | null): void {
    const call = getCallByChildThread(db, threadId);
    if (call === null || call.status !== "running") return;
    if (idleHandlers.has(call.id)) {
      if (continuationAdmissions.has(call.id)) pendingIdleOutputs.set(call.id, output);
      return;
    }
    idleHandlers.add(call.id);
    const task = handleThreadIdle(threadId, output)
      .catch((error) => {
        bb.log.error(
          `Could not handle idle workflow worker ${threadId}: ${message(error)}`,
        );
        failThreadCall(
          threadId,
          `Could not handle worker result: ${message(error)}`,
        );
      })
      .finally(() => {
        idleHandlers.delete(call.id);
        idleHandlerTasks.delete(call.id);
        handlerTasks.delete(task);
        // An idle event can arrive while a queued-send admission check is
        // awaiting the SDK. Keep that event instead of stranding its result.
        if (pendingIdleOutputs.has(call.id)) {
          const pendingOutput = pendingIdleOutputs.get(call.id) ?? null;
          pendingIdleOutputs.delete(call.id);
          if (continuationAdmissions.has(call.id) && getCallByChildThread(db, threadId)?.id === call.id) {
            onThreadIdle(threadId, pendingOutput);
          }
        }
      });
    handlerTasks.add(task);
    idleHandlerTasks.set(call.id, task);
  }

  function failThreadCall(threadId: string, error: string): void {
    const call = getCallByChildThread(db, threadId);
    if (call === null || call.status !== "running") return;
    settleCall(db, { id: call.id, status: "failed", result: null, error });
    wakeCall(call);
  }

  async function submitStructuredResult(
    threadId: string,
    value: JsonValue,
  ): Promise<{ ok: true } | { ok: false; terminal: boolean; error: string }> {
    const call = getCallByChildThread(db, threadId);
    if (call === null) {
      return {
        ok: false,
        terminal: true,
        error: "This thread is not an active workflow worker",
      };
    }
    const options = parseStoredAgentOptions(JSON.parse(call.optionsJson));
    if (options.outputSchema === null) {
      return {
        ok: false,
        terminal: true,
        error: "This workflow call does not require structured output",
      };
    }
    const resolved = resolveStructuredValue(options.outputSchema, value);
    const validation = resolved.validation;
    if (validation.valid) {
      const stored = storeStructuredResult(db, call.id, resolved.value);
      if (stored === "accepted") {
        settleCall(db, {
          id: call.id,
          status: "succeeded",
          result: resolved.value,
          error: null,
        });
        const stopping = stopChild(threadId);
        wakeCall(call);
        await stopping;
        return { ok: true };
      }
      if (stored === "idempotent") {
        await stopChild(threadId);
        return { ok: true };
      }
      if (stored === "conflict") {
        return {
          ok: false,
          terminal: true,
          error:
            "A different structured result was already accepted for this workflow call",
        };
      }
      return {
        ok: false,
        terminal: true,
        error: "This workflow call is no longer active",
      };
    }
    const attempts = incrementRepairAttempts(db, call.id);
    if (attempts === null) {
      return {
        ok: false,
        terminal: true,
        error:
          call.resultJson === null
            ? "This workflow call is no longer active"
            : "A different structured result was already accepted for this workflow call",
      };
    }
    publishRunProgress(call.runId);
    if (attempts > MAX_REPAIR_ATTEMPTS) {
      const error = `Structured output failed after ${MAX_REPAIR_ATTEMPTS} corrective retries: ${validation.error}`;
      settleCall(db, { id: call.id, status: "failed", result: null, error });
      wakeCall(call);
      await stopChild(threadId);
      return { ok: false, terminal: true, error };
    }
    return {
      ok: false,
      terminal: false,
      error: `Value does not match the required schema (${validation.error}). Correct it and retry; ${MAX_REPAIR_ATTEMPTS - attempts + 1} corrective ${MAX_REPAIR_ATTEMPTS - attempts + 1 === 1 ? "retry remains" : "retries remain"}.`,
    };
  }

  function agentConfiguration(threadId: string) {
    const call = getCallByChildThread(db, threadId);
    if (call === null) return null;
    const options = parseStoredAgentOptions(JSON.parse(call.optionsJson));
    return {
      resultParameters:
        call.status === "running" && options.outputSchema !== null
          ? resultToolParameters(options.outputSchema)
          : null,
      terminal: call.status !== "running",
      instructions:
        call.status !== "running"
          ? "This workflow worker is already terminal. Do not perform more work."
          : options.outputSchema === null
            ? null
            : `You are a BB workflow worker. Submit your final value with bb_workflow_result. Required schema: ${JSON.stringify(options.outputSchema)}`,
    };
  }

  async function notify(run: WorkflowRunRow): Promise<void> {
    const latest = getRunRequired(db, run.id);
    if (latest.notificationSent) return;
    const settings = settingsForRun(latest);
    if (!beginNotificationAttempt(db, run.id)) return;
    try {
      if (await originUnavailable(latest.originThreadId)) {
        await onOriginUnavailable(latest.originThreadId);
        return;
      }
      await bb.sdk.threads.send({
        threadId: latest.originThreadId,
        mode: "steer-if-active",
        input: [
          {
            type: "text",
            text: formatWorkflowNotification(
              latest,
              settings.maxNotificationBytes,
            ),
            mentions: [],
            visibility: "agent-only",
          },
        ],
      });
      markNotificationSent(db, run.id);
    } catch (error) {
      const detail = message(error);
      let unavailable = isMissingThread(error);
      if (!unavailable) {
        try {
          unavailable = await originUnavailable(latest.originThreadId);
        } catch {
          unavailable = false;
        }
      }
      if (unavailable) {
        settleNotificationUndeliverable(
          db,
          run.id,
          `Origin thread is unavailable: ${detail}`,
        );
        bb.log.warn(
          `Settled workflow notification ${run.id} without delivery because its origin thread is unavailable`,
        );
        return;
      }
      const exponent = Math.min(latest.notificationAttemptCount, 20);
      const delay = Math.min(
        NOTIFICATION_RETRY_MAX_MS,
        NOTIFICATION_RETRY_BASE_MS * 2 ** exponent,
      );
      recordNotificationFailure(db, {
        id: run.id,
        error: detail,
        nextAttemptAt: Date.now() + delay,
      });
      bb.log.error(
        `Could not notify workflow origin for ${run.id}; retrying in ${delay} ms: ${detail}`,
      );
    }
  }

  async function settleRunAndStopOutstanding(
    args: Parameters<typeof settleRun>[1],
  ): Promise<void> {
    const outstanding = settleRun(db, args);
    wakeWorker();
    const settled = getRun(db, args.id);
    if (settled !== null) publishRunsChanged(settled.originThreadId);
    controllers.get(args.id)?.abort();
    for (const call of outstanding) wakeCall(call);
    await stopChildren(
      outstanding.flatMap((call) =>
        call.childThreadId === null ? [] : [call.childThreadId],
      ),
    );
  }

  async function executeRun(
    run: WorkflowRunRow,
    signal: AbortSignal,
  ): Promise<void> {
    const parsed = parseWorkflowSource(run.source);
    const runSettings = settingsForRun(run);
    let callIndex = 0;
    const replay = { prefix: true };
    const inFlightCalls = new Set<Promise<JsonValue>>();
    let previousCacheKey = Promise.resolve<string | null>(null);
    let previousReplayDecision = Promise.resolve();
    let nestedLaunchQueue = Promise.resolve();
    const capabilities: WorkflowCapabilities = {
      agent(prompt, options, callSignal) {
        const index = callIndex;
        callIndex += 1;
        const computeIdentity = async (previousKey: string | null) => {
          const selection = await validateSelection(run, options, callSignal);
          const cacheKey = computeWorkflowCallCacheKey({
            version: WORKFLOW_CALL_CACHE_VERSION,
            previousCacheKey: previousKey,
            prompt,
            selection,
            outputSchema: options.outputSchema,
            executionSemantics: {
              workerPromptVersion: WORKER_PROMPT_VERSION,
              resultProtocolVersion: RESULT_PROTOCOL_VERSION,
              maxRepairAttempts: MAX_REPAIR_ATTEMPTS,
            },
            placement: {
              environment:
                options.environment === null
                  ? { kind: "origin" }
                  : options.environment,
              continueThreadId: options.continueThreadId,
            },
          });
          return { cacheKey, selection };
        };
        const identity = previousCacheKey.then(computeIdentity, async () => {
          replay.prefix = false;
          return computeIdentity(null);
        });
        previousCacheKey = identity.then(
          (value) => value.cacheKey,
          () => {
            replay.prefix = false;
            return null;
          },
        );
        const priorDecision = previousReplayDecision;
        let releaseDecision = (): void => undefined;
        previousReplayDecision = new Promise<void>((resolve) => {
          releaseDecision = resolve;
        });
        const call = runAgentCall(
          run,
          index,
          prompt,
          options,
          replay,
          identity,
          { previous: priorDecision, release: releaseDecision },
          callSignal,
        );
        inFlightCalls.add(call);
        void call.catch(() => undefined);
        void call
          .finally(() => {
            inFlightCalls.delete(call);
          })
          .catch(() => undefined);
        return call;
      },
      async workflow(
        reference: WorkflowReference,
        childArgs: JsonValue,
        context: NestedWorkflowContext,
      ) {
        const prepareAndLaunch = async () => {
          const prepared = await prepareWorkflowSource(
            bb,
            { projectId: run.projectId, environmentId: run.environmentId },
            workflowReferenceToSourceInput(reference),
          );
          throwIfCancelled(context.signal);
          const child = parseWorkflowSource(prepared.source);
          if (child.metadata.inputSchema !== null) {
            const validation = validateValue(
              child.metadata.inputSchema,
              childArgs,
            );
            if (!validation.valid) {
              throw new Error(
                `Nested workflow ${child.metadata.name} args are invalid: ${validation.error}`,
              );
            }
          }
          const execution = executeWorkflowScript({
            args: childArgs,
            body: child.body,
            capabilities,
            signal: context.signal,
            depth: context.depth,
            scheduler: context.scheduler,
          });
          return { child, execution };
        };
        const launch = nestedLaunchQueue.then(
          prepareAndLaunch,
          prepareAndLaunch,
        );
        nestedLaunchQueue = launch.then(
          () => undefined,
          () => undefined,
        );
        const { child: launchedChild, execution } = await launch;
        const result = await execution;
        if (launchedChild.metadata.outputSchema !== null) {
          const validation = validateValue(
            launchedChild.metadata.outputSchema,
            result,
          );
          if (!validation.valid) {
            throw new Error(
              `Nested workflow ${launchedChild.metadata.name} result is invalid: ${validation.error}`,
            );
          }
        }
        return result;
      },
      log(text) {
        bb.log.info(`[${run.id}] ${text}`);
      },
      phase(title) {
        updateRunPhase(db, run.id, title);
        publishRunsChanged(run.originThreadId);
      },
    };
    try {
      if (await waitForOrigin(run.originThreadId, signal)) {
        await onOriginUnavailable(run.originThreadId);
        return;
      }
      throwIfCancelled(signal);
      const result = await executeWorkflowScript({
        args: parseJson(run.argsJson, "workflow args"),
        body: parsed.body,
        signal,
        capabilities,
        limits: {
          maxAgentCalls: runSettings.maxAgentCalls,
          maxConcurrentAgents: runSettings.maxConcurrentAgents,
        },
      });
      if (shuttingDown && signal.aborted) return;
      if (parsed.metadata.outputSchema !== null) {
        const validation = validateValue(parsed.metadata.outputSchema, result);
        if (!validation.valid) {
          throw new Error(`Workflow result is invalid: ${validation.error}`);
        }
      }
      await settleRunAndStopOutstanding({
        id: run.id,
        status: "succeeded",
        result,
        error: null,
      });
    } catch (error) {
      const latest = getRunRequired(db, run.id);
      if (shuttingDown && signal.aborted && latest.status === "running") {
        return;
      }
      if (latest.status !== "cancelled") {
        await settleRunAndStopOutstanding({
          id: run.id,
          status: signal.aborted ? "cancelled" : "failed",
          result: null,
          error: message(error),
        });
      }
    } finally {
      await Promise.allSettled(inFlightCalls);
      controllers.delete(run.id);
    }
  }

  function isMissingThread(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const candidate = error as { status?: unknown; code?: unknown };
    return candidate.status === 404 || candidate.code === "thread_not_found";
  }

  async function reconcileRunningCalls(): Promise<void> {
    for (const call of listRunningCalls(db)) {
      const threadId = call.childThreadId!;
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.archivedAt != null) {
          failThreadCall(threadId, "Workflow worker was archived");
        } else if (thread.status === "idle") {
          const output = await bb.sdk.threads.output({ threadId });
          onThreadIdle(threadId, output.output);
          await idleHandlerTasks.get(call.id);
        } else if (thread.status === "error") {
          failThreadCall(threadId, "Workflow worker is in an error state");
        }
      } catch (error) {
        if (isMissingThread(error)) {
          failThreadCall(threadId, "Workflow worker was deleted");
        } else {
          bb.log.warn(
            `Could not reconcile workflow worker ${threadId}: ${message(error)}`,
          );
        }
      }
    }
  }

  async function enforceTimeouts(now: number): Promise<void> {
    for (const run of listTimedOutRuns(db, now, 100)) {
      const settings = settingsForRun(run);
      await settleRunAndStopOutstanding({
        id: run.id,
        status: "failed",
        result: null,
        error: `Workflow run timed out after ${settings.totalRunTimeoutMs} ms`,
      });
      controllers.get(run.id)?.abort();
    }
  }

  async function archiveRetiredWorker(threadId: string): Promise<boolean> {
    try {
      await bb.sdk.threads.stop({ threadId });
      await bb.sdk.threads.archive({ threadId });
      return true;
    } catch (error) {
      if (isMissingThread(error)) return true;
      bb.log.warn(
        `Could not archive retired workflow worker ${threadId}: ${message(error)}`,
      );
      return false;
    }
  }

  async function sweepExpiredRuns(now: number): Promise<void> {
    const expired = listExpiredTerminalRuns(db, now, RETENTION_SWEEP_RUNS);
    if (expired.runIds.length === 0) return;
    deleteTerminalRuns(db, expired.runIds);
  }

  async function maintenanceTick(): Promise<void> {
    const now = Date.now();
    const isolated = async (
      name: string,
      operation: () => void | Promise<void>,
    ) => {
      try {
        await operation();
      } catch (error) {
        bb.log.error(
          `Workflow maintenance step ${name} failed: ${message(error)}`,
        );
      }
    };
    await isolated("cleanup-workers", cleanupWorkers);
    await isolated("enforce-timeouts", () => enforceTimeouts(now));
    await isolated("retention", () => sweepExpiredRuns(now));
  }

  async function runWorker(signal: AbortSignal): Promise<void> {
    shuttingDown = false;
    claimRequested = true;
    signal.addEventListener(
      "abort",
      () => {
        shuttingDown = true;
        for (const controller of controllers.values()) controller.abort();
      },
      { once: true },
    );
    await stopChildren(recoverInterruptedRuns(db));
    for (const [name, operation] of [
      ["discover-workers", discoverWorkers],
      ["reconcile-origins", reconcileOrigins],
      ["reconcile-workers", reconcileRunningCalls],
    ] as const) {
      try {
        await operation();
      } catch (error) {
        bb.log.error(
          `Workflow startup reconciliation ${name} failed: ${message(error)}`,
        );
      }
    }
    const active = new Set<Promise<void>>();
    let nextMaintenanceAt = 0;
    while (!signal.aborted) {
      const shouldClaim = claimRequested;
      claimRequested = false;
      while (shouldClaim && active.size < currentSettings.maxActiveRuns) {
        const run = claimQueuedRun(db, currentSettings.maxActiveRuns);
        if (run === null) break;
        publishRunsChanged(run.originThreadId);
        const controller = new AbortController();
        controllers.set(run.id, controller);
        const abortRun = () => controller.abort();
        signal.addEventListener("abort", abortRun, { once: true });
        const execution = executeRun(run, controller.signal).finally(() => {
          signal.removeEventListener("abort", abortRun);
          active.delete(execution);
          wakeWorker();
        });
        active.add(execution);
      }
      if (Date.now() >= nextMaintenanceAt) {
        await maintenanceTick();
        nextMaintenanceAt = Date.now() + 1_000;
      }
      for (const pending of listPendingNotificationRuns(db, Date.now(), 100)) {
        try {
          await notify(pending);
        } catch (error) {
          bb.log.error(
            `Workflow notification maintenance failed for ${pending.id}: ${message(error)}`,
          );
        }
      }
      await waitForWork(nextMaintenanceAt - Date.now(), signal);
    }
    shuttingDown = true;
    for (const controller of controllers.values()) controller.abort();
    await Promise.allSettled(active);
    while (handlerTasks.size > 0) await Promise.allSettled(handlerTasks);
    await stopChildren(recoverInterruptedRuns(db));
    await Promise.allSettled(childStops.values());
  }

  async function stop(runId: string): Promise<boolean> {
    const childThreadIds = activeChildThreadsForRun(db, runId);
    const stopped = cancelRun(db, runId);
    wakeWorker();
    if (stopped) {
      const run = getRun(db, runId);
      if (run !== null) publishRunsChanged(run.originThreadId);
    }
    controllers.get(runId)?.abort();
    await stopChildren(childThreadIds);
    return stopped;
  }

  /**
   * Destroy the worktrees a finished run provisioned, once the orchestrator
   * has taken what it wants from them. Lane branches survive teardown, so the
   * work is recoverable; uncommitted files do not, which is why a dirty lane
   * is kept unless the caller explicitly accepts discarding it.
   */
  async function teardown(
    runId: string,
    options: { discardUncommitted: boolean },
  ): Promise<WorkflowTeardownReport> {
    const run = getRunRequired(db, runId);
    if (run.status === "queued" || run.status === "running") {
      throw new Error(
        `Workflow run ${runId} is still ${run.status}; stop it before tearing down its worktrees`,
      );
    }
    const report: WorkflowTeardownReport = {
      runId,
      destroyed: [],
      kept: [],
    };
    for (const lane of listRunProvisionedEnvironments(db, runId)) {
      try {
        const environment = await bb.sdk.environments.get({ environmentId: lane.environmentId });
        if (environment.projectId !== run.projectId) {
          report.kept.push({ ...lane, reason: "environment no longer belongs to this project" });
          continue;
        }
        if (hasActiveEnvironmentConsumer(db, lane.environmentId, runId)) {
          report.kept.push({ ...lane, reason: "environment is used by another active workflow" });
          continue;
        }
        const ownedThreads = new Set(listCallsForRun(db, runId)
          .filter((call) => call.replayedFromCallId === null)
          .map((call) => call.childThreadId));
        let externalConsumer = false;
        for (let offset = 0; ; offset += 100) {
          const threads = await bb.sdk.threads.list({
            environmentId: lane.environmentId, archived: false, includeHidden: true,
            limit: 100, offset,
          });
          if (threads.some((thread) => !ownedThreads.has(thread.id))) {
            externalConsumer = true;
            break;
          }
          if (threads.length < 100) break;
        }
        if (externalConsumer) {
          report.kept.push({ ...lane, reason: "environment has unarchived external consumers" });
          continue;
        }
        const status = await readWorkspaceStatus(lane.environmentId);
        if (status === null || status.outcome !== "available") {
            report.kept.push({
              ...lane,
              reason:
                "workspace status is unavailable, so uncommitted work cannot be ruled out",
            });
            continue;
        }
        if (!options.discardUncommitted) {
          if (status.workspace.workingTree.hasUncommittedChanges) {
            report.kept.push({
              ...lane,
              reason: `${status.workspace.workingTree.files.length} uncommitted file(s) would be discarded`,
            });
            continue;
          }
        }
        await bb.sdk.environments.archiveThreads({
          environmentId: lane.environmentId,
        });
        await bb.sdk.environments.delete({
          environmentId: lane.environmentId,
        });
        report.destroyed.push(lane);
      } catch (error) {
        report.kept.push({ ...lane, reason: message(error) });
      }
    }
    return report;
  }

  return {
    start,
    get: (runId) => getRun(db, runId),
    inspect,
    inspectPage,
    inspectLatestForThread,
    inspectActiveForThread,
    list: (projectId, limit) => listRuns(db, { projectId, limit }),
    stop,
    teardown,
    updateSettings(settings) {
      currentSettings = settings;
      wakeWorker();
    },
    runWorker,
    onThreadIdle,
    onOriginUnavailable,
    onThreadFailed: (threadId, error) =>
      failThreadCall(threadId, error ?? "Workflow worker failed"),
    onThreadArchived: (threadId) =>
      failThreadCall(threadId, "Workflow worker was archived"),
    onThreadDeleted: (threadId) =>
      failThreadCall(threadId, "Workflow worker was deleted"),
    submitStructuredResult,
    agentConfiguration,
  };
}
