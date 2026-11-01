import { createHash } from "node:crypto";
import { and, count, desc, eq, inArray, max, sql } from "drizzle-orm";
import {
  events,
  getEnvironment,
  getHost,
  getThread,
  getThreadEventRewriteGeneration,
  isThreadQueueAutoSendPaused,
  listActiveBackgroundTaskCountsByThreadIds,
  pendingInteractions,
  queuedThreadMessages,
  threadPluginMetadata,
  type DbQueryConnection,
} from "@bb/db";
import {
  parsePersistedPluginMetadata,
  parseStoredThreadEvent,
  threadScope,
  NATIVE_RECOVERY_STOP_OPERATION,
  turnRequestEventDataSchema,
  systemOperationEventDataSchema,
  type JsonObject,
} from "@bb/domain";
import type {
  ExperimentalRecovery,
  ExperimentalRecoveryContinueResult,
  ExperimentalRecoverySnapshot,
} from "@get-bb/plugin-sdk";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { getActiveTurnId, isManualCompactionActive } from "./thread-events.js";
import { sendThreadMessage } from "./thread-send.js";
import { buildExecutionOptions } from "./thread-commands.js";
import { dispatchExecutionSources, hasMessageDispatchHooks, runMessageDispatchHookPass } from "./dispatch-hooks.js";
import { toThreadResponseFromThread } from "./thread-runtime-display.js";
import { requirePublicProject } from "../lib/entity-lookup.js";
import { ApiError } from "../../errors.js";
import type { PromptInput } from "@bb/domain";


function latestRequest(db: DbQueryConnection, threadId: string, fresh = false) {
  const row = db.select({ data: events.data, sequence: events.sequence })
    .from(events)
    .where(and(
      eq(events.threadId, threadId),
      eq(events.type, "client/turn/requested"),
      sql`json_extract(${events.data}, '$.target.kind') IN ('thread-start', 'new-turn')`,
      fresh ? sql`json_extract(${events.data}, '$.provenance') = 'fresh-user' AND json_extract(${events.data}, '$.initiator') = 'user'` : undefined,
    ))
    .orderBy(desc(events.sequence)).limit(1).get();
  if (!row) return null;
  const parsed = turnRequestEventDataSchema.safeParse(JSON.parse(row.data));
  return parsed.success ? { data: parsed.data, sequence: row.sequence } : null;
}


export function readRecoverySnapshot(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db" | "hub" | "pendingInteractions">,
  threadId: string,
  db: DbQueryConnection = deps.db,
): ExperimentalRecoverySnapshot | null {
  const thread = getThread(db, threadId);
  if (!thread) return null;
  const environment = thread.environmentId === null ? null : getEnvironment(db, thread.environmentId);
  const host = environment === null ? null : getHost(db, environment.hostId);
  const hostSessionId = host === null ? null : deps.hub.getDaemonSessionIdForHost(host.id) ?? null;
  const request = latestRequest(db, threadId);
  const fresh = latestRequest(db, threadId, true);
  const stopRow = db.select({ data: events.data, sequence: events.sequence })
    .from(events).where(and(
      eq(events.threadId, threadId),
      eq(events.type, "system/operation"),
      sql`json_extract(${events.data}, '$.operation') = ${NATIVE_RECOVERY_STOP_OPERATION}`,
    )).orderBy(desc(events.sequence)).limit(1).get();
  const stopData = stopRow ? systemOperationEventDataSchema.parse(JSON.parse(stopRow.data)) : null;
  const stopRequestId = stopData?.metadata?.requestId;
  const stop = stopRow ? {
    revision: stopRow.sequence,
    requestId: typeof stopRequestId === "string" ? stopRequestId : null,
  } : null;
  const acceptedTurn = request === null ? null : db.select({ turnId: events.turnId, providerThreadId: events.providerThreadId })
    .from(events).where(and(
      eq(events.threadId, threadId), eq(events.type, "turn/input/accepted"),
      sql`json_extract(${events.data}, '$.clientRequestId') = ${request.data.requestId}`,
    )).orderBy(desc(events.sequence)).limit(1).get();
  const assistantRow = request === null || acceptedTurn?.turnId == null || acceptedTurn.providerThreadId === null ? null : db.select().from(events).where(and(
    eq(events.threadId, threadId),
    eq(events.type, "item/completed"),
    eq(events.itemKind, "agentMessage"),
    eq(events.turnId, acceptedTurn.turnId),
    eq(events.providerThreadId, acceptedTurn.providerThreadId),
    sql`${events.sequence} > ${request.sequence} AND ${events.parentToolCallId} IS NULL`,
  )).orderBy(desc(events.sequence)).limit(1).get();
  let finalAssistant: ExperimentalRecoverySnapshot["finalAssistant"] = null;
  if (assistantRow) {
    const event = parseStoredThreadEvent({
      threadId, providerThreadId: assistantRow.providerThreadId,
      scope: assistantRow.scopeKind === "turn" && assistantRow.turnId !== null
        ? { kind: "turn", turnId: assistantRow.turnId } : threadScope(),
      type: assistantRow.type, data: JSON.parse(assistantRow.data),
    });
    if (event.type === "item/completed" && event.item.type === "agentMessage") {
      finalAssistant = { messageId: event.item.id, revision: assistantRow.sequence, text: event.item.text };
    }
  }
  const metadataRows = db.select({ pluginId: threadPluginMetadata.pluginId, metadataJson: threadPluginMetadata.metadataJson })
    .from(threadPluginMetadata).where(eq(threadPluginMetadata.threadId, threadId)).orderBy(threadPluginMetadata.pluginId).all();
  const pluginMetadata: Record<string, JsonObject> = {};
  let corruptMetadata = false;
  for (const row of metadataRows) {
    const metadata = parsePersistedPluginMetadata(row.metadataJson);
    if (metadata === undefined) corruptMetadata = true;
    else pluginMetadata[row.pluginId] = metadata;
  }
  const queuedMessageCount = db.select({ value: count() }).from(queuedThreadMessages)
    .where(eq(queuedThreadMessages.threadId, threadId)).get()?.value ?? 0;
  const pendingInteractionCount = db.select({ value: count() }).from(pendingInteractions)
    .where(and(eq(pendingInteractions.threadId, threadId), inArray(pendingInteractions.status, ["pending", "resolving"]))).get()?.value ?? 0;
  const background = listActiveBackgroundTaskCountsByThreadIds(db, { threadIds: [threadId] })[0];
  const eventSequence = db.select({ value: max(events.sequence) }).from(events)
    .where(eq(events.threadId, threadId)).get()?.value ?? 0;
  const snapshot: ExperimentalRecoverySnapshot = {
    threadId, projectId: thread.projectId, revision: "", eventSequence,
    status: thread.status, providerId: thread.providerId,
    hostId: host?.id ?? null,
    hostOnline: hostSessionId !== null && host?.phase !== "removing" && host?.phase !== "destroyed" && host?.destroyedAt === null && environment?.status === "ready" && Boolean(environment.path),
    visibility: thread.visibility, parentThreadId: thread.parentThreadId,
    archivedAt: thread.archivedAt, deletedAt: thread.deletedAt, pluginMetadata,
    run: request ? {
      requestId: request.data.requestId, requestSequence: request.sequence,
      initiator: request.data.initiator, provenance: request.data.provenance ?? "unknown",
      freshUserRequestId: fresh?.data.requestId ?? null, freshUserSequence: fresh?.sequence ?? null,
    } : null,
    stop, finalAssistant, queuedMessageCount, pendingInteractionCount,
    metadataReadable: !corruptMetadata,
    activeBackgroundTaskCount: background ? background.activeBackgroundAgentCount + background.activeBackgroundCommandCount + background.activeWorkflowCount : 0,
  };
  snapshot.revision = createHash("sha256").update(JSON.stringify({
    nativeRevision: deps.hub.getThreadRevision(threadId),
    snapshot, thread, hostSessionId, hostPhase: host?.phase, environment,
    rewriteGeneration: getThreadEventRewriteGeneration(threadId),
    queuePaused: isThreadQueueAutoSendPaused(db, threadId),
    activeTurnId: getActiveTurnId({ db }, threadId),
    compaction: isManualCompactionActive({ db }, thread),
    corruptMetadata,
  })).digest("hex");
  return snapshot;
}

class RecoveryAdmissionRefused extends Error {
  constructor(readonly reason: ExperimentalRecoveryContinueResult["reason"]) { super(reason); }
}

function requireRecoverySafe(snapshot: ExperimentalRecoverySnapshot | null): void {
  if (
    !snapshot || snapshot.status !== "idle" || snapshot.archivedAt !== null || snapshot.deletedAt !== null ||
    snapshot.visibility !== "visible" || snapshot.parentThreadId !== null || !snapshot.hostOnline ||
    !snapshot.metadataReadable || !snapshot.finalAssistant?.text.trim() ||
    snapshot.queuedMessageCount > 0 || snapshot.pendingInteractionCount > 0 || snapshot.activeBackgroundTaskCount > 0 ||
    !snapshot.run || snapshot.run.provenance === "unknown" ||
    (snapshot.stop !== null && (snapshot.run.freshUserSequence === null || snapshot.run.freshUserSequence <= snapshot.stop.revision))
  ) {
    throw new RecoveryAdmissionRefused("unsafe");
  }
}

export async function continueRecovery(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: Parameters<ExperimentalRecovery["continue"]>[0],
): Promise<ExperimentalRecoveryContinueResult> {
  const { threadId, revision } = args.snapshot;
  const admit = args.admit;
  const requireCurrent = (db: DbQueryConnection): void => {
    const current = readRecoverySnapshot(deps, threadId, db);
    if (current?.revision !== revision) throw new RecoveryAdmissionRefused("changed");
    requireRecoverySafe(current);
    const thread = getThread(db, threadId);
    if (!thread || getActiveTurnId({ db }, thread.id) !== null || isManualCompactionActive({ db }, thread)) throw new RecoveryAdmissionRefused("unsafe");
  };
  try {
    requireCurrent(deps.db);
    const thread = getThread(deps.db, threadId);
    const environment = thread?.environmentId ? getEnvironment(deps.db, thread.environmentId) : null;
    if (!thread || !environment) throw new RecoveryAdmissionRefused("unsafe");
    const input: PromptInput[] = [{ type: "text", text: "please continue", mentions: [] }];
    if (input[0]?.type === "text") Object.freeze(input[0].mentions);
    Object.freeze(input[0]);
    Object.freeze(input);
    const execution = hasMessageDispatchHooks() ? await buildExecutionOptions(deps, {}, { threadId: thread.id }) : null;
    let sendStarted = false;
    const send = () => {
      sendStarted = true;
      return sendThreadMessage(deps, {
        environment, thread, originPluginId: null, trigger: "auto-dispatch", provenance: "system",
        payload: {
          mode: "start", input,
          ...(execution === null ? {} : {
            model: execution.model, reasoningLevel: execution.reasoningLevel,
            serviceTier: execution.serviceTier, permissionMode: execution.permissionMode,
            executionInputSources: { model: "explicit", reasoningLevel: "explicit", serviceTier: "explicit", permissionMode: "explicit" } as const,
          }),
        },
        beforeAppendInTransaction: ({ tx }) => {
          requireCurrent(tx);
          if (admit() !== true) throw new RecoveryAdmissionRefused("policy");
          requireCurrent(tx);
        },
      });
    };
    if (execution !== null) {
      const outcome = await runMessageDispatchHookPass(deps, {
        thread, threadResponse: toThreadResponseFromThread(deps, { thread }),
        project: requirePublicProject(deps.db, thread.projectId),
        environmentId: environment.id, intendedHostId: null,
        environmentIntent: { kind: "environment", environmentId: environment.id },
        input,
        requestedExecution: { providerId: thread.providerId, model: execution.model, reasoningLevel: execution.reasoningLevel, serviceTier: execution.serviceTier, permissionMode: execution.permissionMode },
        executionSources: dispatchExecutionSources({}),
        attempt: "start-turn", initiator: "system", senderThreadId: null,
        origin: null, originPluginId: null, startedOnBehalfOf: null,
        parentThreadId: thread.parentThreadId, queuedMessages: [], pluginSubmission: null,
        continueAfterHooks: send,
      });
      if (outcome.kind === "wait") return { admitted: false, reason: "policy" };
    }
    if (!sendStarted) await send();
    return { admitted: true, reason: "admitted" };
  } catch (error) {
    if (error instanceof RecoveryAdmissionRefused) return { admitted: false, reason: error.reason };
    if (error instanceof ApiError && error.body.code === "dispatch_rejected") return { admitted: false, reason: "policy" };
    throw error;
  }
}
