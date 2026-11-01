import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveThread, createPendingInteraction, deleteQueuedThreadMessage, deleteThreadEventSuffixInTransaction, getThread, hostDaemonSessions, listEvents, listQueuedThreadMessages, markThreadDeleted, patchThreadPluginMetadata, threads, type EnvironmentRow, type HostRow } from "@bb/db";
import { threadScope, turnRequestEventDataSchema, turnScope, type Thread } from "@bb/domain";
import { hostDaemonOnlineRpcResponseMessageSchema, hostDaemonServerWsMessageSchema, type HostDaemonCommand } from "@bb/host-daemon-contract";
import type { BbPluginApi, ExperimentalRecoveryContinueResult, ExperimentalRecoverySnapshot } from "@get-bb/plugin-sdk";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as commands from "../../../src/services/threads/thread-commands.js";
import { appendClientTurnEvent, appendThreadEvent, recordNativeRecoveryStop } from "../../../src/services/threads/thread-events.js";
import { applyLoggedThreadLifecycleEvent } from "../../../src/services/threads/lifecycle-outcome.js";
import { requestThreadStopForCurrentState, stopThreadForCurrentState } from "../../../src/services/threads/thread-lifecycle.js";
import { continueRecovery, readRecoverySnapshot } from "../../../src/services/threads/thread-recovery.js";
import { acceptThreadSendRequest } from "../../../src/services/threads/thread-send-request.js";
import { sendQueuedMessageNow } from "../../../src/services/threads/queued-messages.js";
import { availableModelFixture } from "../../helpers/available-models.js";
import { seedQueuedMessage, seedThread, seedThreadFixture, seedThreadRuntimeState } from "../../helpers/seed.js";
import { createTestAppHarness, type TestAppHarness } from "../../helpers/test-app.js";

const checkIds = [
  "stop-suppresses-execution", "fresh-user-rearms", "queued-plugin-input-does-not-rearm",
  "same-ending-deduplication", "startup-no-catch-up", "eager-live-ending-run-identity",
  "run-message-revision-admission", "pause-disable-admission-race", "role-visibility-parent-admission",
  "archive-delete-admission", "queue-interaction-background-admission", "host-admission",
] as const;
type CheckId = typeof checkIds[number];
type Proof = { passed: boolean; evidence: string };
type Snapshot = ExperimentalRecoverySnapshot;
type Lifecycle = {
  startup: { idle: Snapshot; active: Snapshot; ended: Snapshot };
  eager: { active: Snapshot; ended: Snapshot; superseded: Snapshot };
  dedup: { active: Snapshot; ended: Snapshot; revised: Snapshot };
};
interface Fixture {
  harness: TestAppHarness;
  thread: Thread;
  environment: EnvironmentRow;
  host: HostRow;
  session: { id: string };
  transport: { observed: HostDaemonCommand[]; close(): void };
}

function snapshot(harness: TestAppHarness, threadId: string): Snapshot {
  const value = readRecoverySnapshot(harness.deps, threadId);
  if (value === null) throw new Error(`Missing native snapshot for ${threadId}`);
  return value;
}

function currentThread(harness: TestAppHarness, threadId: string) {
  const value = getThread(harness.db, threadId);
  if (value === null) throw new Error(`Missing native thread ${threadId}`);
  return value;
}

function latestRequest(harness: TestAppHarness, threadId: string) {
  const row = listEvents(harness.db, { threadId }).filter((event) => event.type === "client/turn/requested").at(-1);
  if (!row) throw new Error(`Missing native request for ${threadId}`);
  return { ...turnRequestEventDataSchema.parse(JSON.parse(row.data)), sequence: row.sequence };
}

function continuationRequests(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId })
    .filter((event) => event.type === "client/turn/requested")
    .map((event) => ({ ...turnRequestEventDataSchema.parse(JSON.parse(event.data)), sequence: event.sequence }))
    .filter((request) => request.input.length === 1 && request.input[0]?.type === "text" && request.input[0].text === "please continue");
}

function installTransport(harness: TestAppHarness, hostId: string, sessionId: string) {
  const observed: HostDaemonCommand[] = [];
  let closed = false;
  const socket = {
    close() { closed = true; },
    send(data: string) {
      if (closed) throw new Error("Disposed safeguards transport received a command");
      const message = hostDaemonServerWsMessageSchema.parse(JSON.parse(data));
      if (message.type !== "host-rpc.request") return;
      const command = message.command;
      let result: unknown;
      if (command.type === "provider.list_models") {
        result = { models: [availableModelFixture({ model: "gpt-5", reasoningLevels: ["low", "medium", "high"], defaultReasoningLevel: "medium", isDefault: true })], selectedOnlyModels: [] };
      } else if (command.type === "host.list_files") {
        result = { files: [], truncated: false };
      } else if (command.type === "host.list_branch_options") {
        result = { branches: ["main"], branchesTruncated: false, remoteBranches: ["origin/main"], remoteBranchesTruncated: false, selectedBranch: command.selectedBranch ? { name: command.selectedBranch, kind: command.selectedBranch.startsWith("origin/") ? "remote" : "local" } : null };
      } else if (command.type === "host.inspect_git_source") {
        result = { isWorktree: false, checkout: { kind: "branch", branchName: "main", headSha: "abc123" }, defaultBranch: "main", defaultBranchRelation: "equal", hasUncommittedChanges: false, operation: { kind: "none" }, originDefaultBranch: "origin/main" };
      } else if (command.type === "host.read_file") {
        harness.hub.recordHostOnlineRpcResponse({ sessionId, message: { type: "host-rpc.response", requestId: message.requestId, commandType: command.type, ok: false, errorCode: "ENOENT", errorMessage: "The isolated scripted workspace contains no runtime context files" } });
        return;
      } else if (command.type === "turn.submit" || command.type === "thread.start") {
        observed.push(command);
        result = {};
      } else if (command.type === "thread.stop") {
        observed.push(command);
        result = { providerCheckpointId: null, activeTurnRetained: false };
      } else {
        throw new Error(`Unexpected safeguards transport command ${command.type}`);
      }
      harness.hub.recordHostOnlineRpcResponse({ sessionId, message: hostDaemonOnlineRpcResponseMessageSchema.parse({ type: "host-rpc.response", requestId: message.requestId, commandType: command.type, ok: true, result }) });
    },
  };
  harness.hub.registerDaemon(sessionId, hostId, socket);
  return { observed, close() { socket.close(); harness.hub.unregisterDaemon(sessionId); } };
}

async function createFixture(harness: TestAppHarness): Promise<Fixture> {
  const seeded = seedThreadFixture(harness, { thread: { status: "idle" } });
  const transport = installTransport(harness, seeded.host.id, seeded.session.id);
  seedThreadRuntimeState(harness.deps, { threadId: seeded.thread.id, environmentId: seeded.environment.id, providerThreadId: `provider-${seeded.thread.id}` });
  patchThreadPluginMetadata(harness.db, { threadId: seeded.thread.id, pluginId: "safeguard-fixture", set: { role: "code" }, remove: [] });
  return { ...seeded, harness, transport };
}

async function freshRun(fixture: Fixture) {
  const { harness, thread } = fixture;
  const response = await acceptThreadSendRequest(harness.deps, { thread: currentThread(harness, thread.id), payload: { mode: "start", input: [{ type: "text", text: "Finish the isolated fixture task", mentions: [] }], model: "gpt-5", reasoningLevel: "medium", serviceTier: "default", permissionMode: "full" } });
  expect(response).toEqual({ ok: true, delivery: "sent" });
  const request = latestRequest(harness, thread.id);
  expect(request).toMatchObject({ initiator: "user", provenance: "fresh-user" });
  await vi.waitFor(() => expect(fixture.transport.observed).toContainEqual(expect.objectContaining({ type: "turn.submit", requestId: request.requestId })));
  return request;
}

function providerEnding(fixture: Fixture, request = latestRequest(fixture.harness, fixture.thread.id), messageId = `assistant-${request.requestId}`, text = "I will continue the remaining work.") {
  const { harness, thread, environment } = fixture;
  const providerThreadId = `provider-${thread.id}`;
  const scope = turnScope(`turn-${request.requestId}`);
  appendThreadEvent(harness.deps, { threadId: thread.id, environmentId: environment.id, providerThreadId, type: "turn/started", scope, data: { providerThreadId } });
  appendThreadEvent(harness.deps, { threadId: thread.id, environmentId: environment.id, providerThreadId, type: "turn/input/accepted", scope, data: { providerThreadId, clientRequestId: request.requestId } });
  appendThreadEvent(harness.deps, { threadId: thread.id, environmentId: environment.id, providerThreadId, type: "item/completed", scope, data: { providerThreadId, item: { type: "agentMessage", id: messageId, text } } });
  appendThreadEvent(harness.deps, { threadId: thread.id, environmentId: environment.id, providerThreadId, type: "turn/completed", scope, data: { providerThreadId, status: "completed" } });
  expect(applyLoggedThreadLifecycleEvent(harness.deps, { threadId: thread.id, event: { type: "run.succeeded" } }).applied).toBe(true);
  const ended = snapshot(harness, thread.id);
  expect(ended).toMatchObject({ status: "idle", run: { requestId: request.requestId }, finalAssistant: { messageId, text } });
  return ended;
}

function reviseAssistant(fixture: Fixture, messageId: string, text: string) {
  const request = latestRequest(fixture.harness, fixture.thread.id);
  appendThreadEvent(fixture.harness.deps, { threadId: fixture.thread.id, environmentId: fixture.environment.id, providerThreadId: `provider-${fixture.thread.id}`, type: "item/completed", scope: turnScope(`turn-${request.requestId}`), data: { providerThreadId: `provider-${fixture.thread.id}`, item: { type: "agentMessage", id: messageId, text } } });
  return snapshot(fixture.harness, fixture.thread.id);
}

function continuationCommands(fixture: Fixture) {
  return fixture.transport.observed.filter((command) => command.type === "turn.submit" && command.input.length === 1 && command.input[0]?.type === "text" && command.input[0].text === "please continue");
}

function expectNoContinuation(fixture: Fixture, queuedCount = 0) {
  expect(continuationRequests(fixture.harness, fixture.thread.id)).toHaveLength(0);
  expect(continuationCommands(fixture)).toHaveLength(0);
  expect(listQueuedThreadMessages(fixture.harness.db, fixture.thread.id)).toHaveLength(queuedCount);
}

function holdPreparation() {
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = commands.prepareTurnSubmitCommandPayload;
  const spy = vi.spyOn(commands, "prepareTurnSubmitCommandPayload").mockImplementation(async (...args) => {
    const result = await original(...args);
    entered();
    await gate;
    return result;
  });
  return { ready, release, restore() { release(); spy.mockRestore(); } };
}

async function reachPreparation(ready: Promise<void>, pending: Promise<ExperimentalRecoveryContinueResult>) {
  await Promise.race([
    ready,
    pending.then((result) => { throw new Error(`Native continuation settled before the real preparation gate: ${JSON.stringify(result)}`); }),
  ]);
}

async function observe(harness: TestAppHarness, workDir: string) {
  const rootDir = join(workDir, "bb-plugin-safeguards-observer");
  await mkdir(rootDir, { recursive: true });
  await writeFile(join(rootDir, "package.json"), JSON.stringify({ name: "bb-plugin-safeguards-observer", version: "0.0.0", bb: { name: "Safeguards observer", description: "Isolated native lifecycle observer", branding: { icon: "Zap" }, server: "./server.ts" } }));
  const active: Snapshot[] = [];
  const idle: Snapshot[] = [];
  const capture = (target: Snapshot[], value: Snapshot | null | undefined) => {
    if (value == null) throw new Error("Native lifecycle event omitted recovery snapshot");
    target.push(value);
  };
  const key = Symbol.for("bb.native-recovery-safeguards.observer-registration");
  const previous: unknown = Reflect.get(globalThis, key);
  const hadPrevious = Object.prototype.hasOwnProperty.call(globalThis, key);
  Reflect.set(globalThis, key, (api: BbPluginApi) => {
    api.events.on("thread.active", (event) => capture(active, event.experimental_recoverySnapshot));
    api.events.on("thread.idle", (event) => capture(idle, event.experimental_recoverySnapshot));
  });
  try {
    await writeFile(join(rootDir, "server.ts"), `
      import type { BbPluginApi } from "@get-bb/plugin-sdk";
      export default function plugin(bb: BbPluginApi) {
        const register: unknown = Reflect.get(globalThis, Symbol.for("bb.native-recovery-safeguards.observer-registration"));
        if (typeof register !== "function") throw new Error("Missing native fixture observer registration");
        register(bb);
      }
    `);
    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status).toBe("running");
  } finally {
    if (hadPrevious) Reflect.set(globalThis, key, previous);
    else Reflect.deleteProperty(globalThis, key);
  }
  return { active, idle };
}

async function flushLifecycle() {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

describe("isolated native recovery safeguard witness", () => {
  it("exercises the twelve native invariants and disposes every owned fixture before publishing", async () => {
    const checks: Record<CheckId, Proof> = {
      "stop-suppresses-execution": { passed: false, evidence: "Not exercised" },
      "fresh-user-rearms": { passed: false, evidence: "Not exercised" },
      "queued-plugin-input-does-not-rearm": { passed: false, evidence: "Not exercised" },
      "same-ending-deduplication": { passed: false, evidence: "Not exercised" },
      "startup-no-catch-up": { passed: false, evidence: "Not exercised" },
      "eager-live-ending-run-identity": { passed: false, evidence: "Not exercised" },
      "run-message-revision-admission": { passed: false, evidence: "Not exercised" },
      "pause-disable-admission-race": { passed: false, evidence: "Not exercised" },
      "role-visibility-parent-admission": { passed: false, evidence: "Not exercised" },
      "archive-delete-admission": { passed: false, evidence: "Not exercised" },
      "queue-interaction-background-admission": { passed: false, evidence: "Not exercised" },
      "host-admission": { passed: false, evidence: "Not exercised" },
    };
    const lifecycle: Partial<Lifecycle> = {};
    const failures: unknown[] = [];
    const cleanupEvidence: string[] = [];
    const cleanupFailures: string[] = [];
    let created = 0;
    let disposed = 0;
    const owned = async <T>(run: (fixture: Fixture, workDir: string) => Promise<T>): Promise<T> => {
      let harness: TestAppHarness | undefined;
      let workDir: string | undefined;
      try {
        harness = await createTestAppHarness();
        created++;
        workDir = await mkdtemp(join(tmpdir(), "bb-native-safeguards-"));
        return await run(await createFixture(harness), workDir);
      } finally {
        vi.restoreAllMocks();
        if (harness) {
          await flushLifecycle();
          const sessions = harness.db.select({ id: hostDaemonSessions.id, hostId: hostDaemonSessions.hostId }).from(hostDaemonSessions).all();
          const errors: unknown[] = [];
          for (const session of sessions) {
            try { harness.hub.closeDaemonSessionSocket(session.id, "daemon-disconnect"); } catch (error) { errors.push(error); }
          }
          try { await harness.cleanup(); } catch (error) { errors.push(error); }
          if (workDir) {
            try { await rm(workDir, { recursive: true, force: true }); } catch (error) { errors.push(error); }
          }
          await flushLifecycle();
          try { harness.db.$client.close(); } catch (error) { errors.push(error); }
          try {
            expect(harness.db.$client.open).toBe(false);
            expect(existsSync(harness.config.dataDir)).toBe(false);
            if (workDir) expect(existsSync(workDir)).toBe(false);
            for (const session of sessions) expect(harness.hub.getDaemonSessionIdForHost(session.hostId)).toBeNull();
          } catch (error) { errors.push(error); }
          if (errors.length === 0) {
            disposed++;
            cleanupEvidence.push(`Fixture ${created}: native plugin service stopped, scripted daemon sessions unregistered, SQLite closed, owned data and observer directories removed`);
          } else {
            const evidence = errors.map(errorText).join("; ");
            cleanupFailures.push(evidence);
            throw new AggregateError(errors, "Native fixture cleanup failed");
          }
        } else {
          cleanupFailures.push("Harness creation failed before an owned cleanup handle was returned");
        }
      }
    };
    const check = async (id: CheckId, run: () => Promise<string>) => {
      try { checks[id] = { passed: true, evidence: await run() }; }
      catch (error) { checks[id] = { passed: false, evidence: errorText(error) }; failures.push(error); }
    };
    const admissionRace = async (mutate: (fixture: Fixture) => void, queuedCount = 0) => owned(async (fixture) => {
      await freshRun(fixture);
      const ended = providerEnding(fixture);
      const gate = holdPreparation();
      const pending = continueRecovery(fixture.harness.deps, { snapshot: ended, admit: () => true });
      try {
        await reachPreparation(gate.ready, pending);
        mutate(fixture);
        const changed = snapshot(fixture.harness, fixture.thread.id);
        expect(changed.revision).not.toBe(ended.revision);
        gate.release();
        expect(await pending).toEqual({ admitted: false, reason: "changed" });
        expectNoContinuation(fixture, queuedCount);
        return `${fixture.thread.id}: ${ended.revision} -> ${changed.revision}; append refused with zero continuation request/command`;
      } finally { gate.restore(); await pending.catch(() => undefined); }
    });

    await check("stop-suppresses-execution", async () => {
      const idleStop = await owned(async (fixture) => {
        const request = await freshRun(fixture);
        const ended = providerEnding(fixture);
        const gate = holdPreparation();
        const pending = continueRecovery(fixture.harness.deps, { snapshot: ended, admit: () => true });
        let stopping: Promise<void> | undefined;
        try {
          await reachPreparation(gate.ready, pending);
          stopping = stopThreadForCurrentState(fixture.harness.deps, currentThread(fixture.harness, fixture.thread.id), null);
          const stopped = snapshot(fixture.harness, fixture.thread.id);
          expect(stopped.stop).toEqual({ revision: ended.eventSequence + 1, requestId: request.requestId });
          recordNativeRecoveryStop(fixture.harness.deps, fixture.thread.id);
          expect(snapshot(fixture.harness, fixture.thread.id).stop).toEqual(stopped.stop);
          gate.release();
          expect(await pending).toEqual({ admitted: false, reason: "changed" });
          await stopping;
          expect(await continueRecovery(fixture.harness.deps, { snapshot: snapshot(fixture.harness, fixture.thread.id), admit: () => true })).toEqual({ admitted: false, reason: "unsafe" });
          expectNoContinuation(fixture);
          return `Native Stop persisted synchronously before awaiting Stop settlement, bound ${request.requestId} at ${stopped.stop!.revision}; preclassified and current continuations refused, no request/command/queue`;
        } finally { gate.restore(); await pending.catch(() => undefined); await stopping?.catch(() => undefined); }
      });
      const activeStop = await owned(async (fixture) => {
        const request = await freshRun(fixture);
        const providerThreadId = `provider-${fixture.thread.id}`;
        const scope = turnScope(`turn-${request.requestId}`);
        appendThreadEvent(fixture.harness.deps, { threadId: fixture.thread.id, environmentId: fixture.environment.id, providerThreadId, type: "turn/started", scope, data: { providerThreadId } });
        appendThreadEvent(fixture.harness.deps, { threadId: fixture.thread.id, environmentId: fixture.environment.id, providerThreadId, type: "turn/input/accepted", scope, data: { providerThreadId, clientRequestId: request.requestId } });
        const active = snapshot(fixture.harness, fixture.thread.id);
        expect(active.status).toBe("active");
        const stopping = stopThreadForCurrentState(fixture.harness.deps, currentThread(fixture.harness, fixture.thread.id), fixture.environment, { requireStopped: true });
        try {
          const stopped = snapshot(fixture.harness, fixture.thread.id);
          expect(stopped.stop).toEqual({ requestId: request.requestId, revision: active.eventSequence + 1 });
          await stopping;
          expect(fixture.transport.observed).toContainEqual(expect.objectContaining({ type: "thread.stop", intent: "interrupt", threadId: fixture.thread.id }));
          expect(snapshot(fixture.harness, fixture.thread.id).stop).toEqual(stopped.stop);
          expectNoContinuation(fixture);
          return `Actual active provider turn ${request.requestId} persisted Stop ${stopped.stop!.revision} before the first await, then settled real native thread.stop through the scripted host`;
        } finally { await stopping.catch(() => undefined); }
      });
      return `${idleStop}; ${activeStop}`;
    });

    await check("fresh-user-rearms", () => owned(async (fixture) => {
      await freshRun(fixture);
      providerEnding(fixture);
      requestThreadStopForCurrentState(fixture.harness.deps, currentThread(fixture.harness, fixture.thread.id), fixture.environment);
      const stopped = snapshot(fixture.harness, fixture.thread.id);
      const fresh = await freshRun(fixture);
      const ended = providerEnding(fixture, fresh);
      expect(ended.run!.freshUserSequence).toBeGreaterThan(stopped.stop!.revision);
      expect(ended.run!.freshUserRequestId).toBe(fresh.requestId);
      expect(await continueRecovery(fixture.harness.deps, { snapshot: ended, admit: () => true })).toEqual({ admitted: true, reason: "admitted" });
      const requests = continuationRequests(fixture.harness, fixture.thread.id);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ initiator: "system", provenance: "system", input: [{ type: "text", text: "please continue" }] });
      await vi.waitFor(() => expect(continuationCommands(fixture)).toHaveLength(1));
      expect(continuationCommands(fixture)[0]).toMatchObject({ requestId: requests[0]!.requestId, input: [{ type: "text", text: "please continue" }] });
      expect(listQueuedThreadMessages(fixture.harness.db, fixture.thread.id)).toHaveLength(0);
      return `Actual native user send ${fresh.requestId}@${fresh.sequence} exceeded Stop ${stopped.stop!.revision}; one fixed system request ${requests[0]!.requestId} and matching scripted turn.submit admitted`;
    }));

    await check("queued-plugin-input-does-not-rearm", () => owned(async (fixture) => {
      await freshRun(fixture);
      const ended = providerEnding(fixture);
      const queued = seedQueuedMessage(fixture.harness.deps, { threadId: fixture.thread.id, content: [{ type: "text", text: "Previously queued user work", mentions: [] }] });
      requestThreadStopForCurrentState(fixture.harness.deps, currentThread(fixture.harness, fixture.thread.id), fixture.environment);
      const stopped = snapshot(fixture.harness, fixture.thread.id);
      expect(await sendQueuedMessageNow(fixture.harness.deps, { threadId: fixture.thread.id, queuedMessageId: queued.id, mode: "auto" })).toEqual({ delivery: "sent" });
      const queuedRequest = latestRequest(fixture.harness, fixture.thread.id);
      expect(queuedRequest.provenance).toBe("queued-user");
      await vi.waitFor(() => expect(fixture.transport.observed).toContainEqual(expect.objectContaining({ type: "turn.submit", requestId: queuedRequest.requestId })));
      const queuedEnd = providerEnding(fixture, queuedRequest);
      expect(queuedEnd.stop).toEqual(stopped.stop);
      expect(queuedEnd.run!.freshUserSequence).toBeLessThan(stopped.stop!.revision);
      expect(await continueRecovery(fixture.harness.deps, { snapshot: queuedEnd, admit: () => true })).toEqual({ admitted: false, reason: "unsafe" });
      await acceptThreadSendRequest(fixture.harness.deps, { thread: currentThread(fixture.harness, fixture.thread.id), payload: { mode: "start", input: [{ type: "text", text: "Plugin work after Stop", mentions: [] }], pluginSubmission: { pluginId: "safeguard-fixture", data: null } } });
      const pluginRequest = latestRequest(fixture.harness, fixture.thread.id);
      expect(pluginRequest).toMatchObject({ initiator: "system", provenance: "plugin" });
      await vi.waitFor(() => expect(fixture.transport.observed).toContainEqual(expect.objectContaining({ type: "turn.submit", requestId: pluginRequest.requestId })));
      const pluginEnd = providerEnding(fixture, pluginRequest);
      expect(pluginEnd.stop).toEqual(stopped.stop);
      expect(await continueRecovery(fixture.harness.deps, { snapshot: pluginEnd, admit: () => true })).toEqual({ admitted: false, reason: "unsafe" });
      fixture.harness.db.transaction((tx) => deleteThreadEventSuffixInTransaction(tx, { threadId: fixture.thread.id, cutoffSequence: ended.finalAssistant!.revision, oldMaxSequence: pluginEnd.eventSequence }));
      expect(snapshot(fixture.harness, fixture.thread.id).stop).toEqual(stopped.stop);
      expectNoContinuation(fixture);
      return `Native queued send ${queuedRequest.requestId} and pluginSubmission send ${pluginRequest.requestId} retained Stop ${stopped.stop!.revision}; neither rearmed or created continuation; history suffix deletion retained marker`;
    }));

    await check("same-ending-deduplication", () => owned(async (fixture, workDir) => {
      const events = await observe(fixture.harness, workDir);
      await freshRun(fixture);
      const active = snapshot(fixture.harness, fixture.thread.id);
      const ended = providerEnding(fixture);
      const revised = reviseAssistant(fixture, ended.finalAssistant!.messageId, "I will continue the revised remaining work.");
      expect(revised.run!.requestId).toBe(ended.run!.requestId);
      expect(revised.finalAssistant!.messageId).toBe(ended.finalAssistant!.messageId);
      expect(revised.finalAssistant!.revision).toBeGreaterThan(ended.finalAssistant!.revision);
      expect(applyLoggedThreadLifecycleEvent(fixture.harness.deps, { threadId: fixture.thread.id, event: { type: "run.succeeded" } }).applied).toBe(false);
      await flushLifecycle();
      expect(events.active).toHaveLength(1);
      expect(events.idle).toHaveLength(1);
      expect(events.active[0]).toMatchObject({ status: "active", run: { requestId: active.run!.requestId } });
      expect(events.idle[0]).toEqual(ended);
      const results = await Promise.all([continueRecovery(fixture.harness.deps, { snapshot: revised, admit: () => true }), continueRecovery(fixture.harness.deps, { snapshot: revised, admit: () => true })]);
      expect(results.filter((result) => result.admitted)).toHaveLength(1);
      expect(continuationRequests(fixture.harness, fixture.thread.id)).toHaveLength(1);
      const admittedRequest = continuationRequests(fixture.harness, fixture.thread.id)[0]!;
      expect(admittedRequest).toMatchObject({ initiator: "system", provenance: "system", input: [{ type: "text", text: "please continue" }] });
      await vi.waitFor(() => expect(continuationCommands(fixture)).toHaveLength(1));
      expect(continuationCommands(fixture)[0]).toMatchObject({ requestId: admittedRequest.requestId });
      expect(listQueuedThreadMessages(fixture.harness.db, fixture.thread.id)).toHaveLength(0);
      lifecycle.dedup = { active: events.active[0]!, ended: events.idle[0]!, revised };
      return `Concurrent identical native ending admissions produced exactly one request/command; duplicate run.succeeded emitted no second idle event; persisted message ${ended.finalAssistant!.messageId} revision ${ended.finalAssistant!.revision} -> ${revised.finalAssistant!.revision}. External tracker dedup is not claimed`;
    }));

    await check("startup-no-catch-up", () => owned(async (fixture, workDir) => {
      await freshRun(fixture);
      const idle = providerEnding(fixture);
      const second = await createFixture(fixture.harness);
      await freshRun(second);
      const active = snapshot(second.harness, second.thread.id);
      const ended = providerEnding(second);
      const third = await createFixture(fixture.harness);
      await freshRun(third);
      expect(snapshot(third.harness, third.thread.id).status).toBe("active");
      const events = await observe(fixture.harness, workDir);
      await flushLifecycle();
      expect(events.active).toHaveLength(0);
      expect(events.idle).toHaveLength(0);
      expect(continuationRequests(fixture.harness, fixture.thread.id)).toHaveLength(0);
      expect(continuationRequests(second.harness, second.thread.id)).toHaveLength(0);
      expect(continuationRequests(third.harness, third.thread.id)).toHaveLength(0);
      expect(continuationCommands(fixture)).toHaveLength(0);
      expect(continuationCommands(second)).toHaveLength(0);
      expect(continuationCommands(third)).toHaveLength(0);
      lifecycle.startup = { idle, active, ended };
      return `Source-installed native observer registered with two historical idle endings and one already-active run; registration/startup replayed zero lifecycle events and created zero continuation requests. Persisted active/ended pair ${active.run!.requestId}; external startup tracker policy is not claimed`;
    }));

    await check("eager-live-ending-run-identity", () => owned(async (fixture, workDir) => {
      const request = await freshRun(fixture);
      expect(applyLoggedThreadLifecycleEvent(fixture.harness.deps, { threadId: fixture.thread.id, event: { type: "run.succeeded" } }).applied).toBe(true);
      const events = await observe(fixture.harness, workDir);
      expect(applyLoggedThreadLifecycleEvent(fixture.harness.deps, { threadId: fixture.thread.id, event: { type: "run.started" } }).applied).toBe(true);
      const active = snapshot(fixture.harness, fixture.thread.id);
      const ended = providerEnding(fixture, request);
      const newer = appendClientTurnEvent(fixture.harness.deps, { threadId: fixture.thread.id, environmentId: fixture.environment.id, type: "client/turn/requested", source: "tell", requestMethod: "turn/start", input: [{ type: "text", text: "Native plugin superseding work", mentions: [] }], target: { kind: "new-turn" }, execution: { model: "gpt-5", reasoningLevel: "medium", serviceTier: "default", permissionMode: "full", source: "client/turn/requested" }, initiator: "system", provenance: "plugin", senderThreadId: null });
      expect(applyLoggedThreadLifecycleEvent(fixture.harness.deps, { threadId: fixture.thread.id, event: { type: "run.started" } }).applied).toBe(true);
      const superseded = snapshot(fixture.harness, fixture.thread.id);
      expect(events.active).toHaveLength(0);
      expect(events.idle).toHaveLength(0);
      expect(superseded.run!.requestId).toBe(newer.requestId);
      await flushLifecycle();
      expect(events.active).toHaveLength(2);
      expect(events.idle).toHaveLength(1);
      expect(events.active[0]).toMatchObject({ status: "active", run: { requestId: request.requestId }, finalAssistant: null });
      expect(events.idle[0]).toEqual(ended);
      expect(events.active[1]).toEqual(superseded);
      expect(events.active[0]!.run!.requestId).not.toBe(events.active[1]!.run!.requestId);
      lifecycle.eager = { active: events.active[0]!, ended: events.idle[0]!, superseded: events.active[1]! };
      expect(active.run!.requestId).toBe(lifecycle.eager.active.run!.requestId);
      return `Native active -> idle -> newer active transitions completed synchronously before any listener delivery; eager payloads retained old run ${request.requestId} and ending, distinct newer native plugin run ${newer.requestId}; external end tracker is not claimed`;
    }));

    await check("run-message-revision-admission", async () => {
      const evidence: string[] = [];
      evidence.push(await admissionRace((fixture) => {
        appendClientTurnEvent(fixture.harness.deps, { threadId: fixture.thread.id, environmentId: fixture.environment.id, type: "client/turn/requested", source: "tell", requestMethod: "turn/start", input: [{ type: "text", text: "New source-owned plugin run", mentions: [] }], target: { kind: "new-turn" }, execution: { model: "gpt-5", reasoningLevel: "medium", serviceTier: "default", permissionMode: "full", source: "client/turn/requested" }, initiator: "system", provenance: "plugin", senderThreadId: null });
      }));
      evidence.push(await admissionRace((fixture) => { reviseAssistant(fixture, "different-final-message", "Another native assistant ending"); }));
      evidence.push(await admissionRace((fixture) => { const ended = snapshot(fixture.harness, fixture.thread.id); reviseAssistant(fixture, ended.finalAssistant!.messageId, "Revised same assistant message"); }));
      return `Source run, final message identity, and same-message revision races each refused after real preparation: ${evidence.join("; ")}`;
    });

    await check("pause-disable-admission-race", async () => {
      const evidence: string[] = [];
      for (const change of ["pause", "disable"] as const) {
        evidence.push(await owned(async (fixture) => {
          await freshRun(fixture);
          const ended = providerEnding(fixture);
          let enabled = true;
          let paused = false;
          const admit = vi.fn(() => enabled && !paused);
          const gate = holdPreparation();
          const pending = continueRecovery(fixture.harness.deps, { snapshot: ended, admit });
          try {
            await reachPreparation(gate.ready, pending);
            expect(admit).not.toHaveBeenCalled();
            if (change === "pause") paused = true;
            else enabled = false;
            gate.release();
            expect(await pending).toEqual({ admitted: false, reason: "policy" });
            expect(admit).toHaveBeenCalledTimes(1);
            expectNoContinuation(fixture);
            return `${change}: caller policy changed after actual preparation, queried only inside append gate; no request/command/queue`;
          } finally { gate.restore(); await pending.catch(() => undefined); }
        }));
      }
      return evidence.join("; ");
    });

    await check("role-visibility-parent-admission", async () => {
      const evidence: string[] = [];
      evidence.push(await admissionRace((fixture) => { patchThreadPluginMetadata(fixture.harness.db, { threadId: fixture.thread.id, pluginId: "safeguard-fixture", set: { role: "control" }, remove: [] }); }));
      evidence.push(await admissionRace((fixture) => { fixture.harness.db.update(threads).set({ visibility: "hidden" }).where(eq(threads.id, fixture.thread.id)).run(); }));
      evidence.push(await admissionRace((fixture) => { const parent = seedThread(fixture.harness.deps, { projectId: fixture.thread.projectId }); fixture.harness.db.update(threads).set({ parentThreadId: parent.id }).where(eq(threads.id, fixture.thread.id)).run(); }));
      return `Changed role metadata, hidden visibility, and parent identity each invalidated classified snapshot before append: ${evidence.join("; ")}`;
    });

    await check("archive-delete-admission", async () => {
      const archive = await admissionRace((fixture) => { archiveThread(fixture.harness.db, fixture.harness.hub, fixture.thread.id); });
      const deleted = await admissionRace((fixture) => { markThreadDeleted(fixture.harness.db, fixture.harness.hub, { threadId: fixture.thread.id }); });
      return `Native archive and delete each blocked prepared admission without a nudge: ${archive}; ${deleted}`;
    });

    await check("queue-interaction-background-admission", async () => {
      const queue = await admissionRace((fixture) => { seedQueuedMessage(fixture.harness.deps, { threadId: fixture.thread.id, content: [{ type: "text", text: "Queued user work", mentions: [] }] }); }, 1);
      const aba = await admissionRace((fixture) => { const queued = seedQueuedMessage(fixture.harness.deps, { threadId: fixture.thread.id, content: [{ type: "text", text: "User queued then cancelled", mentions: [] }] }); deleteQueuedThreadMessage(fixture.harness.db, fixture.harness.hub, queued.id); });
      const interaction = await admissionRace((fixture) => { createPendingInteraction(fixture.harness.db, { threadId: fixture.thread.id, originKind: "plugin", pluginId: "safeguard-fixture", rendererId: "decision", turnId: null, payload: "{}" }); });
      const background = await admissionRace((fixture) => { appendThreadEvent(fixture.harness.deps, { threadId: fixture.thread.id, type: "item/backgroundTask/progress", scope: threadScope(), data: { providerThreadId: `provider-${fixture.thread.id}`, item: { id: "native-running-task", type: "backgroundTask", taskType: "local_workflow", description: "Controlled running task", status: "pending", taskStatus: "running", skipTranscript: false } } }); });
      return `Queue, notified queue ABA, pending interaction, and active background task each refused prepared admission; existing queue count preserved and no continuation nudge: ${queue}; ${aba}; ${interaction}; ${background}`;
    });

    await check("host-admission", async () => {
      const evidence = await admissionRace((fixture) => { fixture.transport.close(); expect(snapshot(fixture.harness, fixture.thread.id).hostOnline).toBe(false); });
      return `Actual NotificationHub scripted daemon disconnection invalidated host admission: ${evidence}`;
    });

    const cleanup: Proof = { passed: cleanupFailures.length === 0 && created === disposed && created > 0, evidence: `${disposed}/${created} owned fixtures fully disposed. ${cleanupEvidence.join("; ")}${cleanupFailures.length ? `; cleanup failures: ${cleanupFailures.join("; ")}` : ""}` };
    try {
      expect(Object.keys(checks)).toEqual([...checkIds]);
      expect(cleanup.passed, cleanup.evidence).toBe(true);
      expect(Object.keys(lifecycle).sort()).toEqual(["dedup", "eager", "startup"]);
    } catch (error) { failures.push(error); }
    const witnessPath = process.env.BB_NATIVE_RECOVERY_WITNESS_PATH;
    if (witnessPath) await writeFile(witnessPath, JSON.stringify({ exercisedAt: Date.now(), checks, cleanup, lifecycle }));
    if (failures.length) throw new AggregateError(failures, checkIds.filter((id) => !checks[id].passed).map((id) => `${id}: ${checks[id].evidence}`).join("\n") || "Native witness completeness or cleanup assertion failed");
  }, 180_000);
});
