import {
  createFakePluginHost,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Db,
  getCallByChildThread,
  getRunRequired,
  listCallsForRun,
  migrations,
} from "./data.js";
import { createWorkflowService } from "./service.js";
import { DEFAULT_WORKFLOW_SETTINGS } from "./settings.js";
import type { JsonValue, WorkflowAgentOptions } from "./types.js";
import { parseStoredAgentOptions } from "./validation.js";

/**
 * End-to-end cover for the shipped lane orchestration example: the real
 * script, the real workflow service, a fake BB SDK, and a worker "brain" that
 * answers each call the way the scenario under test wants it answered.
 *
 * Every agent call the script makes is structured, so a worker thread stays
 * busy until the brain submits its structured result — the service settles the
 * call from that submission, exactly as a real worker's bb_workflow_result
 * would.
 */
const LANES_SOURCE = readFileSync(
  new URL("../examples/lanes.js", import.meta.url),
  "utf8",
);

const LANE_STATUSES = [
  "succeeded",
  "failed",
  "blocked",
  "unresolved",
  "no-changes",
];

type CallKind = "exec" | "review" | "fix" | "merge" | "rebase" | "unknown";

interface WorkerCall {
  /** What the call's own output schema asks for. */
  kind: CallKind;
  /** The script's label, e.g. "review:alpha:2" or "integrate:alpha:retry". */
  title: string;
  lane: string;
  /** Review/fix round, 0 for calls that have none. */
  round: number;
}

type Brain = (call: WorkerCall) => JsonValue;

function kindOfSchema(schema: WorkflowAgentOptions["outputSchema"]): CallKind {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return "unknown";
  }
  const required = (schema as { required?: unknown }).required;
  if (!Array.isArray(required)) return "unknown";
  switch (required.map(String).sort().join(",")) {
    case "changed,summary":
      return "exec";
    case "approved,findings":
      return "review";
    case "addressed":
      return "fix";
    case "conflictHunks,conflictedPaths,merged":
      return "merge";
    case "resolved":
      return "rebase";
    default:
      return "unknown";
  }
}

function describeCall(options: WorkflowAgentOptions): WorkerCall {
  const title = options.title ?? "";
  const parts = title.split(":");
  const round = Number(parts[2]);
  return {
    kind: kindOfSchema(options.outputSchema),
    title,
    lane: parts[1] ?? "",
    round: Number.isFinite(round) ? round : 0,
  };
}

interface WorkspaceState {
  uncommittedFiles: string[];
  changedFiles: number;
  branchName: string;
}

interface LaneSetupOptions {
  brain: Brain;
  workspaces?: Record<string, Partial<WorkspaceState>>;
}

function setup(options: LaneSetupOptions) {
  let childCount = 0;
  let db: Db | null = null;
  const workerEnvironments = new Map<string, string>();
  const answered = new Set<string>();
  const brainErrors: string[] = [];
  const workspaces = new Map<string, WorkspaceState>([
    [
      "environment-origin",
      {
        uncommittedFiles: [],
        changedFiles: 0,
        branchName: "feature/orchestrator",
      },
    ],
  ]);
  for (const [environmentId, state] of Object.entries(
    options.workspaces ?? {},
  )) {
    workspaces.set(environmentId, {
      uncommittedFiles: state.uncommittedFiles ?? [],
      changedFiles: state.changedFiles ?? 1,
      branchName: state.branchName ?? `bb/${environmentId}`,
    });
  }

  // A worker thread is busy until its structured result lands: returning
  // "idle" here would push the service into its structured-output repair turns
  // instead of letting the brain answer.
  function awaitingStructuredResult(threadId: string): boolean {
    if (db === null) return false;
    const call = getCallByChildThread(db, threadId);
    if (call === null || call.status !== "running") return false;
    return (
      parseStoredAgentOptions(JSON.parse(call.optionsJson)).outputSchema !==
      null
    );
  }

  const { bb, harness } = createFakePluginHost({
    pluginId: "workflows",
    sdk: {
      threads: {
        get: async ({ threadId }) => {
          if (threadId === "origin") {
            return {
              id: threadId,
              environmentId: "environment-origin",
              providerId: "codex",
              status: "idle",
            } as never;
          }
          return {
            id: threadId,
            environmentId: workerEnvironments.get(threadId) ?? null,
            providerId: "codex",
            status: awaitingStructuredResult(threadId) ? "running" : "idle",
          } as never;
        },
        output: async () => ({ output: "done" }),
        defaultExecutionOptions: async () => ({
          model: "gpt-test",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          source: "default",
        }),
        spawn: async (input) => {
          childCount += 1;
          const id = `child-${childCount}`;
          const environment = input.environment as
            | { type: "reuse"; environmentId: string }
            | { type: "host" };
          if (environment.type === "reuse") {
            workerEnvironments.set(id, environment.environmentId);
          } else {
            const provisioned = `environment-lane-${childCount}`;
            workerEnvironments.set(id, provisioned);
            if (!workspaces.has(provisioned)) {
              workspaces.set(provisioned, {
                uncommittedFiles: [],
                changedFiles: 1,
                branchName: `bb/lane-${childCount}`,
              });
            }
          }
          return { id } as never;
        },
        send: async () => ({ ok: true }) as never,
        stop: async () => ({ ok: true }) as never,
        archive: async () => ({ ok: true }) as never,
      },
      providers: {
        list: async () => [
          {
            id: "codex",
            displayName: "Codex",
            logoUrl: null,
            available: true,
            capabilities: {
              supportsThreadArchive: true,
              supportsThreadRename: true,
              supportsServiceTier: true,
              supportsNativeUserQuestion: false,
              supportsFork: true,
              permissionModes: ["full"],
            },
            composerActions: [],
          },
        ],
        models: async () => ({
          providers: [],
          models: [
            {
              id: "gpt-test",
              model: "gpt-test",
              displayName: "GPT Test",
              description: "test",
              supportedReasoningEfforts: [
                { reasoningEffort: "medium", description: "test" },
              ],
              defaultReasoningEffort: "medium",
              isDefault: true,
            },
          ],
          selectedOnlyModels: [],
          modelLoadError: null,
        }),
      },
      environments: {
        get: async ({ environmentId }) =>
          ({
            id: environmentId,
            projectId: "project-test",
            hostId: "host-1",
            path: "/workspace",
            branchName: workspaces.get(environmentId)?.branchName ?? null,
            baseBranch: "main",
          }) as never,
        status: async ({ environmentId }) => {
          const workspace = workspaces.get(environmentId);
          if (workspace === undefined) {
            throw new Error(`Unknown environment ${environmentId}`);
          }
          return {
            outcome: "available",
            workspace: {
              workingTree: {
                insertions: 0,
                deletions: 0,
                lineStatsComplete: true,
                files: workspace.uncommittedFiles.map((path) => ({
                  path,
                  status: "M",
                  insertions: 1,
                  deletions: 0,
                })),
                hasUncommittedChanges: workspace.uncommittedFiles.length > 0,
                state:
                  workspace.uncommittedFiles.length > 0 ? "dirty" : "clean",
              },
              checkout: {
                kind: "branch",
                branchName: workspace.branchName,
                headSha: "abc123",
              },
              branch: {
                currentBranch: workspace.branchName,
                defaultBranch: "main",
              },
              mergeBase: {
                insertions: 0,
                deletions: 0,
                lineStatsComplete: true,
                files: Array.from(
                  { length: workspace.changedFiles },
                  (_unused, index) => ({
                    path: `changed-${index}.ts`,
                    status: "M",
                    insertions: 1,
                    deletions: 0,
                  }),
                ),
                mergeBaseBranch: "main",
                baseRef: "abc000",
                aheadCount: workspace.changedFiles,
                behindCount: 0,
                hasCommittedUnmergedChanges: workspace.changedFiles > 0,
                commits: [],
              },
            },
          } as never;
        },
        commit: async ({ environmentId }) => {
          const workspace = workspaces.get(environmentId);
          if (workspace !== undefined) workspace.uncommittedFiles = [];
          return {
            ok: true,
            action: "commit",
            message: "committed",
            commitSha: "def456",
            commitSubject: "lane work",
          } as never;
        },
        archiveThreads: async () => ({ ok: true, archived: 1 }) as never,
        delete: async () => ({ ok: true }) as never,
      },
    },
  });

  db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  const service = createWorkflowService(bb, db, DEFAULT_WORKFLOW_SETTINGS);
  const database = db;

  /** Answer every worker that is waiting on a structured result. */
  async function answerWaitingWorkers(runId: string): Promise<void> {
    for (const call of listCallsForRun(database, runId)) {
      if (call.status !== "running" || call.childThreadId === null) continue;
      if (answered.has(call.id)) continue;
      const callOptions = parseStoredAgentOptions(JSON.parse(call.optionsJson));
      if (callOptions.outputSchema === null) continue;
      answered.add(call.id);
      const descriptor = describeCall(callOptions);
      let value: JsonValue;
      try {
        value = options.brain(descriptor);
      } catch (error) {
        brainErrors.push(`${descriptor.title}: ${String(error)}`);
        continue;
      }
      const outcome = await service.submitStructuredResult(
        call.childThreadId,
        value,
      );
      if (!outcome.ok) {
        brainErrors.push(`${descriptor.title}: ${outcome.error}`);
      }
    }
  }

  return {
    harness,
    async start(args: JsonValue) {
      return service.start({
        projectId: "project-test",
        originThreadId: "origin",
        source: LANES_SOURCE,
        args,
        resumedFromRunId: null,
        allowDirty: false,
      });
    },
    async runToCompletion(runId: string) {
      const controller = new AbortController();
      const worker = service.runWorker(controller.signal);
      try {
        await vi.waitFor(
          async () => {
            await answerWaitingWorkers(runId);
            if (brainErrors.length > 0) {
              throw new Error(`Worker brain: ${brainErrors.join("; ")}`);
            }
            const row = getRunRequired(database, runId);
            if (row.status === "failed") {
              throw new Error(`Workflow run failed: ${row.error}`);
            }
            expect(row.status).toBe("succeeded");
          },
          { timeout: 10_000, interval: 5 },
        );
      } finally {
        controller.abort();
        await worker;
      }
      return getRunRequired(database, runId);
    },
    /**
     * Continuations sent to lane workers. The run's completion notification
     * also goes out as a `threads.send`, to the origin thread, after the run
     * settles — it is not lane work and would race every assertion here.
     */
    workerSends() {
      return harness.sdk
        .callsTo("threads.send")
        .map(([input]) => input as Record<string, unknown>)
        .filter((input) => input.threadId !== "origin");
    },
    /** Titles of the workers the script spawned, in spawn order. */
    spawnTitles() {
      return harness.sdk
        .callsTo("threads.spawn")
        .map(([input]) => String((input as { title?: unknown }).title));
    },
    /** Where a named worker was placed; throws when it never spawned. */
    spawnEnvironment(title: string) {
      const match = harness.sdk
        .callsTo("threads.spawn")
        .map(([input]) => input as Record<string, unknown>)
        .find((input) => input.title === title);
      if (match === undefined) {
        throw new Error(`No worker was spawned as ${title}`);
      }
      return match.environment;
    },
    /** Human-readable dispatch order: one line per agent call the script made. */
    sequence(runId: string) {
      return listCallsForRun(database, runId).map((call) => {
        const callOptions = parseStoredAgentOptions(
          JSON.parse(call.optionsJson),
        );
        const where =
          callOptions.continueThreadId !== null
            ? "continue"
            : callOptions.environment === null
              ? "origin-workspace"
              : callOptions.environment.kind === "worktree"
                ? "new-worktree"
                : `reuse ${callOptions.environment.environmentId}`;
        const verb =
          callOptions.continueThreadId === null ? "spawn " : "send  ";
        return `${verb} ${callOptions.title ?? "(untitled)"} -> ${
          call.childThreadId ?? "(unattached)"
        } [${where}] ${call.status}`;
      });
    },
  };
}

interface LaneResult {
  lane: string;
  status: string;
  reason: string;
  branch: string | null;
  environmentId: string | null;
  threadId: string | null;
  rounds: number;
  findings: Array<Record<string, unknown>>;
  /** Decisions the script made on the lane's behalf; never overwritten. */
  notes: string[];
  unaddressedRounds?: number[];
  unreviewed: boolean;
  conflictedPaths?: string[];
}

interface LanesResult {
  runId: string;
  integrationBranchName: string | null;
  lanes: LaneResult[];
  summary: {
    succeeded: number;
    failed: number;
    blocked: number;
    unresolved: number;
    noChanges: number;
  };
  reportHint: string;
}

/** Every lane must come back as a real object carrying a known status. */
function lanesOf(resultJson: string | null): LanesResult {
  const result = JSON.parse(resultJson!) as LanesResult;
  expect(Array.isArray(result.lanes)).toBe(true);
  for (const lane of result.lanes) {
    expect(lane).not.toBeNull();
    expect(typeof lane).toBe("object");
    expect(LANE_STATUSES).toContain(lane.status);
    expect(typeof lane.lane).toBe("string");
    expect(typeof lane.rounds).toBe("number");
    expect(Array.isArray(lane.findings)).toBe(true);
    expect(Array.isArray(lane.notes)).toBe(true);
  }
  return result;
}

const BLOCKING = {
  severity: "blocking",
  file: "src/alpha.ts",
  line: 12,
  finding: "the task is not done",
};

const MINOR = {
  severity: "minor",
  file: "src/alpha.ts",
  line: 4,
  finding: "a nicer name would read better",
};

describe("lanes example end to end", () => {
  const harnesses: FakePluginHarness[] = [];
  afterEach(async () => {
    await Promise.all(harnesses.map((harness) => harness.dispose()));
    harnesses.length = 0;
  });

  it("runs two approved lanes into their own worktrees and merges them in declared order", async () => {
    const test = setup({
      brain: (call): JsonValue => {
        switch (call.kind) {
          case "exec":
            return { changed: true, summary: `${call.lane} implemented` };
          case "review":
            return { approved: true, findings: [] };
          case "merge":
            return { merged: true, conflictedPaths: [], conflictHunks: "" };
          default:
            throw new Error(`unexpected ${call.kind} call ${call.title}`);
        }
      },
    });
    harnesses.push(test.harness);

    const run = await test.start({
      runId: "two-lanes",
      lanes: [
        { label: "alpha", prompt: "build alpha" },
        { label: "beta", prompt: "build beta" },
      ],
    });
    const finished = await test.runToCompletion(run.id);
    const result = lanesOf(finished.resultJson);

    expect(result.runId).toBe("two-lanes");
    expect(result.lanes.map((lane) => lane.lane)).toEqual(["alpha", "beta"]);
    expect(result.lanes.map((lane) => lane.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    expect(result.summary).toEqual({
      succeeded: 2,
      failed: 0,
      blocked: 0,
      unresolved: 0,
      noChanges: 0,
    });

    const [alpha, beta] = result.lanes as [LaneResult, LaneResult];
    expect(alpha.rounds).toBe(1);
    expect(beta.rounds).toBe(1);
    expect(alpha.environmentId).not.toBe(beta.environmentId);
    expect(alpha.branch).not.toBe(beta.branch);

    // Each executor got its own managed worktree cut from the origin branch.
    for (const lane of ["alpha", "beta"]) {
      expect(test.spawnEnvironment(`exec:${lane}`)).toEqual({
        type: "host",
        hostId: "host-1",
        workspace: {
          type: "managed-worktree",
          baseBranch: { kind: "named", name: "feature/orchestrator" },
        },
      });
    }

    // Each reviewer landed in its own lane's worktree, not a fresh one.
    expect(test.spawnEnvironment("review:alpha:1")).toEqual({
      type: "reuse",
      environmentId: alpha.environmentId,
    });
    expect(test.spawnEnvironment("review:beta:1")).toEqual({
      type: "reuse",
      environmentId: beta.environmentId,
    });

    // Merges are sequential in declared lane order, and the second one reuses
    // the integration worktree BB opened for the first.
    const titles = test.spawnTitles();
    expect(titles.filter((title) => title.startsWith("integrate:"))).toEqual([
      "integrate:alpha",
      "integrate:beta",
    ]);
    expect(titles.indexOf("integrate:alpha")).toBeLessThan(
      titles.indexOf("integrate:beta"),
    );
    expect(test.spawnEnvironment("integrate:alpha")).toMatchObject({
      type: "host",
      workspace: { type: "managed-worktree" },
    });
    expect(test.spawnEnvironment("integrate:beta")).toEqual({
      type: "reuse",
      environmentId: "environment-lane-5",
    });
    expect(result.integrationBranchName).toBe("bb/lane-5");

    // No lane work was continued: two executors, two reviewers, two merges.
    expect(test.workerSends()).toEqual([]);
    expect(titles).toHaveLength(6);
    // Full dispatch order, worktree placement included.
    expect(test.sequence(run.id)).toEqual([
      "spawn  exec:alpha -> child-1 [new-worktree] succeeded",
      "spawn  exec:beta -> child-2 [new-worktree] succeeded",
      "spawn  review:alpha:1 -> child-3 [reuse environment-lane-1] succeeded",
      "spawn  review:beta:1 -> child-4 [reuse environment-lane-2] succeeded",
      "spawn  integrate:alpha -> child-5 [new-worktree] succeeded",
      "spawn  integrate:beta -> child-6 [reuse environment-lane-5] succeeded",
    ]);
  });

  it("ralph-loops a rejected lane through the same executor thread", async () => {
    const test = setup({
      brain: (call): JsonValue => {
        switch (call.kind) {
          case "exec":
            return { changed: true, summary: "first pass" };
          case "review":
            return call.round === 1
              ? { approved: false, findings: [BLOCKING] }
              : { approved: true, findings: [] };
          case "fix":
            return { addressed: true, summary: "blocking finding fixed" };
          case "merge":
            return { merged: true, conflictedPaths: [], conflictHunks: "" };
          default:
            throw new Error(`unexpected ${call.kind} call ${call.title}`);
        }
      },
    });
    harnesses.push(test.harness);

    const run = await test.start({
      runId: "ralph",
      lanes: [{ label: "alpha", prompt: "build alpha" }],
    });
    const finished = await test.runToCompletion(run.id);
    const result = lanesOf(finished.resultJson);

    const [alpha] = result.lanes as [LaneResult];
    expect(alpha.status).toBe("succeeded");
    expect(alpha.rounds).toBe(2);
    expect(alpha.reason).toBe("merged into " + result.integrationBranchName);

    // The fix round continued the executor rather than spawning a new worker.
    const sends = test.workerSends();
    expect(sends).toHaveLength(1);
    expect(sends[0]?.threadId).toBe(alpha.threadId);
    expect(
      (sends[0]?.input as Array<{ text: string }>)[0]?.text,
    ).toContain("Review round 1 rejected the lane alpha work");
    expect(test.spawnTitles()).toEqual([
      "exec:alpha",
      "review:alpha:1",
      "review:alpha:2",
      "integrate:alpha",
    ]);
    // The fix round is a send on the executor's own thread, mid-sequence.
    expect(test.sequence(run.id)).toEqual([
      "spawn  exec:alpha -> child-1 [new-worktree] succeeded",
      "spawn  review:alpha:1 -> child-2 [reuse environment-lane-1] succeeded",
      "send   fix:alpha:1 -> child-1 [continue] succeeded",
      "spawn  review:alpha:2 -> child-3 [reuse environment-lane-1] succeeded",
      "spawn  integrate:alpha -> child-4 [new-worktree] succeeded",
    ]);
  });

  it("stops at the round cap and never merges an unresolved lane", async () => {
    const test = setup({
      brain: (call): JsonValue => {
        switch (call.kind) {
          case "exec":
            return { changed: true, summary: "first pass" };
          case "review":
            return { approved: false, findings: [BLOCKING, MINOR] };
          case "fix":
            return { addressed: true, summary: "fixed what I could" };
          default:
            throw new Error(`unexpected ${call.kind} call ${call.title}`);
        }
      },
    });
    harnesses.push(test.harness);

    const run = await test.start({
      runId: "capped",
      lanes: [{ label: "alpha", prompt: "build alpha", maxRounds: 2 }],
    });
    const finished = await test.runToCompletion(run.id);
    const result = lanesOf(finished.resultJson);

    const [alpha] = result.lanes as [LaneResult];
    expect(alpha.status).toBe("unresolved");
    expect(alpha.rounds).toBe(2);
    // Plain cap exhaustion: the executor answered addressed:true every round,
    // so the reason blames the reviewer's open findings and nothing else.
    expect(alpha.reason).toBe(
      "review round cap reached (2) with 1 blocking finding(s) outstanding",
    );
    expect(alpha.unaddressedRounds).toBeUndefined();
    expect(alpha.notes).toEqual([]);
    expect(alpha.findings).toEqual([BLOCKING, MINOR]);
    expect(result.summary.unresolved).toBe(1);
    expect(result.summary.succeeded).toBe(0);

    // Nothing was integrated, so BB never opened an integration worktree.
    expect(result.integrationBranchName).toBeNull();
    expect(test.spawnTitles()).toEqual([
      "exec:alpha",
      "review:alpha:1",
      "review:alpha:2",
    ]);
  });

  it("skips review and merge when the host counts no changed file", async () => {
    const test = setup({
      // BB's own count wins over the executor's self-report.
      workspaces: { "environment-lane-1": { changedFiles: 0 } },
      brain: (call): JsonValue => {
        if (call.kind === "exec") {
          return { changed: true, summary: "nothing needed after all" };
        }
        throw new Error(`unexpected ${call.kind} call ${call.title}`);
      },
    });
    harnesses.push(test.harness);

    const run = await test.start({
      runId: "empty",
      lanes: [{ label: "alpha", prompt: "build alpha" }],
    });
    const finished = await test.runToCompletion(run.id);
    const result = lanesOf(finished.resultJson);

    const [alpha] = result.lanes as [LaneResult];
    expect(alpha.status).toBe("no-changes");
    expect(alpha.rounds).toBe(0);
    expect(alpha.reason).toBe(
      "the lane's committed work changes no files: nothing needed after all",
    );
    expect(result.summary.noChanges).toBe(1);
    expect(test.spawnTitles()).toEqual(["exec:alpha"]);
    expect(test.workerSends()).toEqual([]);
  });

  it("does not burn a second round on a non-blocking finding", async () => {
    const test = setup({
      brain: (call): JsonValue => {
        switch (call.kind) {
          case "exec":
            return { changed: true, summary: "first pass" };
          case "review":
            return { approved: false, findings: [MINOR] };
          case "merge":
            return { merged: true, conflictedPaths: [], conflictHunks: "" };
          default:
            throw new Error(`unexpected ${call.kind} call ${call.title}`);
        }
      },
    });
    harnesses.push(test.harness);

    const run = await test.start({
      runId: "minor",
      lanes: [{ label: "alpha", prompt: "build alpha" }],
    });
    const finished = await test.runToCompletion(run.id);
    const result = lanesOf(finished.resultJson);

    const [alpha] = result.lanes as [LaneResult];
    expect(alpha.status).toBe("succeeded");
    expect(alpha.rounds).toBe(1);
    // approved=false without a blocking finding is overridden by the script's
    // own gate rather than costing the lane another round. The merge rewrites
    // `reason`, so the override survives in `notes` — recoverable from the
    // result object, not only from the log — and the minor finding stays
    // visible on the succeeded, merged lane.
    expect(alpha.reason).toBe("merged into " + result.integrationBranchName);
    expect(alpha.findings).toEqual([MINOR]);
    expect(alpha.notes).toEqual([
      "reviewer returned approved:false but reported no blocking finding in review round 1; approved by the script gate with 1 minor finding(s) carried into findings",
      "merged by the script gate over review round 1's approved:false verdict; 1 minor finding(s) stay in findings",
    ]);
    expect(alpha.unaddressedRounds).toBeUndefined();
    expect(test.spawnTitles()).toEqual([
      "exec:alpha",
      "review:alpha:1",
      "integrate:alpha",
    ]);
    expect(test.workerSends()).toEqual([]);
  });

  it("names the executor's own addressed:false admissions in an unresolved lane's reason", async () => {
    const test = setup({
      brain: (call): JsonValue => {
        switch (call.kind) {
          case "exec":
            return { changed: true, summary: "first pass" };
          case "review":
            return { approved: false, findings: [BLOCKING] };
          case "fix":
            return {
              addressed: false,
              summary: `round ${call.round} is beyond me`,
            };
          default:
            throw new Error(`unexpected ${call.kind} call ${call.title}`);
        }
      },
    });
    harnesses.push(test.harness);

    const run = await test.start({
      runId: "gave-up",
      lanes: [{ label: "alpha", prompt: "build alpha", maxRounds: 3 }],
    });
    const finished = await test.runToCompletion(run.id);
    const result = lanesOf(finished.resultJson);

    const [alpha] = result.lanes as [LaneResult];
    expect(alpha.status).toBe("unresolved");
    expect(alpha.rounds).toBe(3);
    // The fix worker's verdict is load-bearing: this lane is unresolved
    // because its executor said it could not address the findings, which is a
    // different failure from a reviewer that kept finding new problems.
    expect(alpha.reason).toBe(
      "review round cap reached (3) with 1 blocking finding(s) outstanding" +
        "; the executor reported addressed:false in fix round(s) 1, 2" +
        " — it could not address the findings",
    );
    expect(alpha.unaddressedRounds).toEqual([1, 2]);
    expect(alpha.notes).toEqual([
      "fix round 1 reported addressed:false: round 1 is beyond me",
      "fix round 2 reported addressed:false: round 2 is beyond me",
    ]);
    expect(result.integrationBranchName).toBeNull();
    expect(test.spawnTitles()).toEqual([
      "exec:alpha",
      "review:alpha:1",
      "review:alpha:2",
      "review:alpha:3",
    ]);
  });
});
