import { archiveThread, createPendingInteraction, deleteQueuedThreadMessage, deleteThreadEventSuffixInTransaction, getLatestThreadSequence, getThread, listEvents, listQueuedThreadMessages, markThreadDeleted, patchThreadPluginMetadata, threadPluginMetadata, threads } from "@bb/db";
import { eq } from "drizzle-orm";
import { turnScope, type Thread } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as commands from "../../../src/services/threads/thread-commands.js";
import { appendClientTurnEvent } from "../../../src/services/threads/thread-events.js";
import { continueRecovery, readRecoverySnapshot } from "../../../src/services/threads/thread-recovery.js";
import { requestThreadStopForCurrentState, stopThreadForCurrentState } from "../../../src/services/threads/thread-lifecycle.js";
import { acceptThreadSendRequest } from "../../../src/services/threads/thread-send-request.js";
import { seedEvent, seedQueuedMessage, seedStoredEvent, seedThread, seedThreadFixture, seedThreadRuntimeState } from "../../helpers/seed.js";
import { textInput } from "../../helpers/prompt-input.js";
import { withTestHarness, type TestAppHarness } from "../../helpers/test-app.js";
import { invokePluginInline, pluginHookProvider, setPluginHookProvider } from "../../../src/services/plugins/plugin-hook-registry.js";

afterEach(() => vi.restoreAllMocks());

function appendRun(harness: TestAppHarness, thread: Thread, provenance: "fresh-user" | "queued-user" | "plugin" | "system") {
  const request = appendClientTurnEvent(harness.deps, {
    threadId: thread.id, environmentId: thread.environmentId,
    type: "client/turn/requested", source: "tell", requestMethod: "turn/start",
    input: textInput("Finish the task"), target: { kind: "new-turn" },
    execution: { model: "gpt-5", reasoningLevel: "medium", serviceTier: "default", permissionMode: "full", source: "client/turn/requested" },
    initiator: provenance === "plugin" || provenance === "system" ? "system" : "user",
    provenance, senderThreadId: null, originPluginId: null,
  });
  seedEvent(harness.deps, {
    threadId: thread.id, environmentId: thread.environmentId,
    providerThreadId: `provider-${thread.id}`,
    type: "turn/input/accepted", scope: turnScope(`turn-${request.sequence}`),
    sequence: getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
    data: { clientRequestId: request.requestId },
  });
  seedEvent(harness.deps, {
    threadId: thread.id, environmentId: thread.environmentId,
    providerThreadId: `provider-${thread.id}`,
    type: "item/completed", scope: turnScope(`turn-${request.sequence}`),
    sequence: getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
    data: { item: { type: "agentMessage", id: `assistant-${request.sequence}`, text: "I will continue the remaining work." } },
  });
  return request;
}

function fixture(harness: TestAppHarness) {
  const seeded = seedThreadFixture(harness, { thread: { status: "idle" } });
  seedThreadRuntimeState(harness.deps, {
    threadId: seeded.thread.id, environmentId: seeded.environment.id,
    providerThreadId: `provider-${seeded.thread.id}`,
  });
  const request = appendRun(harness, seeded.thread, "fresh-user");
  const snapshot = readRecoverySnapshot(harness.deps, seeded.thread.id)!;
  return { ...seeded, request, snapshot };
}

function holdPreparation() {
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = commands.prepareTurnSubmitCommandPayload;
  vi.spyOn(commands, "prepareTurnSubmitCommandPayload").mockImplementation(async (...args) => {
    const result = await original(...args);
    entered();
    await gate;
    return result;
  });
  return { ready, release };
}

function continuationRequests(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId }).filter((event) => event.type === "client/turn/requested" && JSON.parse(event.data).input?.[0]?.text === "please continue");
}

describe("native recovery continuation admission", () => {
  it("dispatches exactly the fixed system continuation once for an unchanged snapshot", async () => {
    await withTestHarness(async (harness) => {
      const { thread, snapshot } = fixture(harness);
      const results = await Promise.all([
        continueRecovery(harness.deps, { snapshot, admit: () => true }),
        continueRecovery(harness.deps, { snapshot, admit: () => true }),
      ]);
      expect(results.filter((result) => result.admitted)).toHaveLength(1);
      expect(continuationRequests(harness, thread.id)).toHaveLength(1);
      expect(JSON.parse(continuationRequests(harness, thread.id)[0]!.data)).toMatchObject({ initiator: "system", provenance: "system", input: [{ type: "text", text: "please continue" }] });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
    });
  });

  it("rechecks paused plugin policy inside admission after asynchronous preparation", async () => {
    await withTestHarness(async (harness) => {
      const { thread, snapshot } = fixture(harness);
      const gate = holdPreparation();
      let enabled = true;
      const admit = vi.fn(() => enabled);
      const continuation = continueRecovery(harness.deps, { snapshot, admit });
      await gate.ready;
      expect(admit).not.toHaveBeenCalled();
      enabled = false;
      gate.release();
      expect(await continuation).toEqual({ admitted: false, reason: "policy" });
      expect(continuationRequests(harness, thread.id)).toHaveLength(0);
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
    });
  });

  it("records idle Stop synchronously and rejects an already-classified continuation", async () => {
    await withTestHarness(async (harness) => {
      const { thread, environment, request, snapshot } = fixture(harness);
      const gate = holdPreparation();
      const continuation = continueRecovery(harness.deps, { snapshot, admit: () => true });
      await gate.ready;
      requestThreadStopForCurrentState(harness.deps, thread, environment);
      const stopped = readRecoverySnapshot(harness.deps, thread.id)!;
      expect(stopped.stop).toEqual({ revision: snapshot.eventSequence + 1, requestId: request.requestId });
      gate.release();
      expect(await continuation).toEqual({ admitted: false, reason: "changed" });
      expect(await continueRecovery(harness.deps, { snapshot: stopped, admit: () => true })).toEqual({ admitted: false, reason: "unsafe" });
      expect(continuationRequests(harness, thread.id)).toHaveLength(0);
    });
  });

  it("never rearms Stop for old queued or plugin runs; a later fresh user run rearms", async () => {
    await withTestHarness(async (harness) => {
      const { thread, environment } = fixture(harness);
      requestThreadStopForCurrentState(harness.deps, thread, environment);
      const stopRevision = readRecoverySnapshot(harness.deps, thread.id)!.stop!.revision;
      for (const provenance of ["queued-user", "plugin"] as const) {
        appendRun(harness, thread, provenance);
        const snapshot = readRecoverySnapshot(harness.deps, thread.id)!;
        expect(snapshot.run!.freshUserSequence).toBeLessThan(stopRevision);
        expect(await continueRecovery(harness.deps, { snapshot, admit: () => true })).toEqual({ admitted: false, reason: "unsafe" });
      }
      appendRun(harness, thread, "fresh-user");
      const snapshot = readRecoverySnapshot(harness.deps, thread.id)!;
      expect(snapshot.run!.freshUserSequence).toBeGreaterThan(stopRevision);
      expect(await continueRecovery(harness.deps, { snapshot, admit: () => true })).toEqual({ admitted: true, reason: "admitted" });
    });
  });

  it.each(["queue", "archive", "hide", "metadata", "assistant", "delete", "parent", "interaction", "background", "host"] as const)("rejects a %s change while preparing without queueing", async (change) => {
    await withTestHarness(async (harness) => {
      const { thread, snapshot, session } = fixture(harness);
      const gate = holdPreparation();
      const continuation = continueRecovery(harness.deps, { snapshot, admit: () => true });
      await gate.ready;
      if (change === "queue") seedQueuedMessage(harness.deps, { threadId: thread.id, content: textInput("User queued work") });
      if (change === "archive") archiveThread(harness.db, harness.hub, thread.id);
      if (change === "hide") harness.db.update(threads).set({ visibility: "hidden" }).where(eq(threads.id, thread.id)).run();
      if (change === "metadata") patchThreadPluginMetadata(harness.db, { threadId: thread.id, pluginId: "orchestrator", set: { role: "control" }, remove: [] });
      if (change === "assistant") seedEvent(harness.deps, { threadId: thread.id, providerThreadId: `provider-${thread.id}`, type: "item/completed", scope: turnScope("later-assistant"), sequence: snapshot.eventSequence + 1, data: { item: { type: "agentMessage", id: "later-assistant", text: "Actually finished." } } });
      if (change === "delete") markThreadDeleted(harness.db, harness.hub, { threadId: thread.id });
      if (change === "parent") {
        const parent = seedThread(harness.deps, { projectId: thread.projectId });
        harness.db.update(threads).set({ parentThreadId: parent.id }).where(eq(threads.id, thread.id)).run();
      }
      if (change === "interaction") createPendingInteraction(harness.db, { threadId: thread.id, originKind: "plugin", pluginId: "orchestrator", rendererId: "decision", turnId: null, payload: "{}" });
      if (change === "background") seedStoredEvent(harness.deps, {
        threadId: thread.id, type: "item/backgroundTask/progress", scope: { kind: "thread" },
        itemId: "task-running", itemKind: "backgroundTask", sequence: snapshot.eventSequence + 1,
        data: { item: { id: "task-running", type: "backgroundTask", taskType: "local_workflow", description: "Running task", status: "pending", taskStatus: "running" } },
      });
      if (change === "host") harness.hub.unregisterDaemon(session.id);
      gate.release();
      expect(await continuation).toEqual({ admitted: false, reason: "changed" });
      expect(continuationRequests(harness, thread.id)).toHaveLength(0);
    });
  });

  it("does not infer freshness from historical initiator=user and marks new plugin sends", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);
      seedThreadRuntimeState(harness.deps, { threadId: thread.id, environmentId: environment.id, providerThreadId: "provider-unproven" });
      expect(readRecoverySnapshot(harness.deps, thread.id)?.run).toMatchObject({ initiator: "user", provenance: "unknown", freshUserSequence: null });
      await acceptThreadSendRequest(harness.deps, { thread, payload: { input: textInput("Plugin work"), mode: "start", originPluginId: "orchestrator" } });
      expect(readRecoverySnapshot(harness.deps, thread.id)?.run).toMatchObject({ initiator: "user", provenance: "plugin", freshUserSequence: null });
    });
  });

  it("persists Stop before the awaited native Stop path yields", async () => {
    await withTestHarness(async (harness) => {
      const { thread, snapshot, request } = fixture(harness);
      const pending = stopThreadForCurrentState(harness.deps, thread, null);
      expect(readRecoverySnapshot(harness.deps, thread.id)?.stop).toEqual({ revision: snapshot.eventSequence + 1, requestId: request.requestId });
      await pending;
    });
  });

  it("keeps Stop across history suffix deletion and rejects a queued run afterward", async () => {
    await withTestHarness(async (harness) => {
      const { thread, environment, snapshot } = fixture(harness);
      requestThreadStopForCurrentState(harness.deps, thread, environment);
      const stopped = readRecoverySnapshot(harness.deps, thread.id)!;
      harness.db.transaction((tx) => deleteThreadEventSuffixInTransaction(tx, {
        threadId: thread.id, cutoffSequence: snapshot.finalAssistant!.revision,
        oldMaxSequence: stopped.eventSequence,
      }));
      appendRun(harness, thread, "queued-user");
      const current = readRecoverySnapshot(harness.deps, thread.id)!;
      expect(current.stop).toEqual(stopped.stop);
      expect(await continueRecovery(harness.deps, { snapshot: current, admit: () => true })).toEqual({ admitted: false, reason: "unsafe" });
    });
  });

  it("refuses notified state ABA changes even when the final values are restored", async () => {
    await withTestHarness(async (harness) => {
      const { snapshot } = fixture(harness);
      const gate = holdPreparation();
      const pending = continueRecovery(harness.deps, { snapshot, admit: () => true });
      await gate.ready;
      const queued = seedQueuedMessage(harness.deps, { threadId: snapshot.threadId, content: textInput("User queued then cancelled") });
      deleteQueuedThreadMessage(harness.db, harness.hub, queued.id);
      const current = readRecoverySnapshot(harness.deps, snapshot.threadId)!;
      expect(current.queuedMessageCount).toBe(0);
      expect(current.eventSequence).toBe(snapshot.eventSequence);
      gate.release();
      expect(await pending).toEqual({ admitted: false, reason: "changed" });
    });
  });

  it.each(["wait", "reject"] as const)("honors ordinary dispatch hook %s without creating a queued nudge", async (action) => {
    await withTestHarness(async (harness) => {
      const { snapshot, thread } = fixture(harness);
      const previous = pluginHookProvider();
      setPluginHookProvider({
        listHooks: () => [{ pluginId: "limiter", handler: () => action === "wait" ? { action: "wait", reason: "At capacity" } : { action: "reject", message: "Do not send" } }],
        invokeHook: (_id, _label, run) => invokePluginInline(run),
        decisionTimeoutMs: 1_000,
      });
      try {
        expect(await continueRecovery(harness.deps, { snapshot, admit: () => true })).toEqual({ admitted: false, reason: "policy" });
        expect(continuationRequests(harness, thread.id)).toHaveLength(0);
        expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
      } finally {
        setPluginHookProvider(previous);
      }
    });
  });
  it("does not bind a delayed older-turn assistant to a newer user run", async () => {
    await withTestHarness(async (harness) => {
      const { thread, environment, request: older } = fixture(harness);
      const newer = appendClientTurnEvent(harness.deps, {
        threadId: thread.id, environmentId: environment.id, type: "client/turn/requested",
        source: "tell", requestMethod: "turn/start", input: textInput("New user work"),
        target: { kind: "new-turn" },
        execution: { model: "gpt-5", reasoningLevel: "medium", serviceTier: "default", permissionMode: "full", source: "client/turn/requested" },
        initiator: "user", provenance: "fresh-user", senderThreadId: null, originPluginId: null,
      });
      seedEvent(harness.deps, {
        threadId: thread.id, providerThreadId: `provider-${thread.id}`,
        type: "turn/input/accepted", scope: turnScope(`turn-${newer.sequence}`),
        sequence: getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
        data: { clientRequestId: newer.requestId },
      });
      seedEvent(harness.deps, {
        threadId: thread.id, providerThreadId: `provider-${thread.id}`,
        type: "item/completed", scope: turnScope(`turn-${older.sequence}`),
        sequence: getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
        data: { item: { type: "agentMessage", id: "late-older-assistant", text: "I will continue old work." } },
      });
      const current = readRecoverySnapshot(harness.deps, thread.id)!;
      expect(current.run?.requestId).toBe(newer.requestId);
      expect(current.finalAssistant).toBeNull();
      expect(await continueRecovery(harness.deps, { snapshot: current, admit: () => true })).toEqual({ admitted: false, reason: "unsafe" });
    });
  });

  it("does not let delayed old-run Stop settlement replace a native marker after a fresh run", async () => {
    await withTestHarness(async (harness) => {
      const { thread, environment } = fixture(harness);
      requestThreadStopForCurrentState(harness.deps, thread, environment);
      const stopped = readRecoverySnapshot(harness.deps, thread.id)!;
      const fresh = appendRun(harness, thread, "fresh-user");
      seedEvent(harness.deps, {
        threadId: thread.id, type: "system/thread/interrupted", scope: { kind: "thread" },
        sequence: getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
        data: { reason: "manual-stop" },
      });
      const current = readRecoverySnapshot(harness.deps, thread.id)!;
      expect(current.stop).toEqual(stopped.stop);
      expect(current.run?.freshUserRequestId).toBe(fresh.requestId);
      expect(await continueRecovery(harness.deps, { snapshot: current, admit: () => true })).toEqual({ admitted: true, reason: "admitted" });
    });
  });

  it("reports unreadable plugin metadata without inventing host connectivity", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = fixture(harness);
      patchThreadPluginMetadata(harness.db, { threadId: thread.id, pluginId: "orchestrator", set: { role: "code" }, remove: [] });
      harness.db.update(threadPluginMetadata).set({ metadataJson: "[]" }).where(eq(threadPluginMetadata.threadId, thread.id)).run();
      const current = readRecoverySnapshot(harness.deps, thread.id)!;
      expect(current.hostOnline).toBe(true);
      expect(current.metadataReadable).toBe(false);
      expect(await continueRecovery(harness.deps, { snapshot: current, admit: () => true })).toEqual({ admitted: false, reason: "unsafe" });
    });
  });

  it.each(["plugin", "queued-user"] as const)("admits an authorized proven %s task before any Stop without claiming a fresh user", async (provenance) => {
    await withTestHarness(async (harness) => {
      const { thread, environment } = seedThreadFixture(harness, { thread: { status: "idle" } });
      seedThreadRuntimeState(harness.deps, { threadId: thread.id, environmentId: environment.id, providerThreadId: `provider-${thread.id}` });
      appendRun(harness, thread, provenance);
      const current = readRecoverySnapshot(harness.deps, thread.id)!;
      expect(current.stop).toBeNull();
      expect(current.run?.freshUserSequence).toBeNull();
      expect(await continueRecovery(harness.deps, { snapshot: current, admit: () => true })).toEqual({ admitted: true, reason: "admitted" });
    });
  });

  it("bounds native revision retention without reviving an evicted snapshot", async () => {
    await withTestHarness(async (harness) => {
      const { thread, snapshot } = fixture(harness);
      for (let index = 0; index < 4097; index++) {
        harness.hub.getThreadRevision(`unrelated-revision-${index}`);
      }
      const current = readRecoverySnapshot(harness.deps, thread.id)!;
      expect(current.revision).not.toBe(snapshot.revision);
      expect(await continueRecovery(harness.deps, { snapshot, admit: () => true }))
        .toEqual({ admitted: false, reason: "changed" });
      expect(await continueRecovery(harness.deps, { snapshot: current, admit: () => true }))
        .toEqual({ admitted: true, reason: "admitted" });
    });
  });

});
