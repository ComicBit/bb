import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyRecoverySafeguards } from "../../../src/services/threads/thread-recovery-verification.js";

const native = vi.hoisted(() => ({ spawn: vi.fn(), readFile: vi.fn(), stat: vi.fn(), realpath: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: native.spawn }));
vi.mock("node:fs/promises", () => ({ readFile: native.readFile, stat: native.stat, realpath: native.realpath }));

const ids = ["stop-suppresses-execution", "fresh-user-rearms", "queued-plugin-input-does-not-rearm", "same-ending-deduplication", "startup-no-catch-up", "eager-live-ending-run-identity", "run-message-revision-admission", "pause-disable-admission-race", "role-visibility-parent-admission", "archive-delete-admission", "queue-interaction-background-admission", "host-admission"];
function receipt() {
  const snapshot = {
    threadId: "thread-native", projectId: "project-native", revision: "a".repeat(64), eventSequence: 4,
    status: "idle", providerId: "codex", hostId: "host-native", hostOnline: true, visibility: "visible",
    parentThreadId: null, archivedAt: null, deletedAt: null, pluginMetadata: {},
    run: { requestId: "request-native", requestSequence: 1, initiator: "user", provenance: "fresh-user", freshUserRequestId: "request-native", freshUserSequence: 1 },
    stop: null, finalAssistant: { messageId: "assistant-native", revision: 3, text: "I will continue." },
    queuedMessageCount: 0, pendingInteractionCount: 0, activeBackgroundTaskCount: 0, metadataReadable: true,
  };
  const active = { ...snapshot, status: "active" };
  return {
    sourceRevision: `sha256:${"b".repeat(64)}`, runtimeVersion: "0.45.0", exercisedAt: Date.now(),
    checks: ids.map((id) => ({ id, passed: true, witness: `native fixture observation for ${id}` })),
    cleanup: { passed: true, witness: "SQLite, observers, transports and verifier temp directory removed" },
    lifecycle: { startup: { idle: snapshot, active, ended: snapshot }, eager: { active, ended: snapshot, superseded: active }, dedup: { active, ended: snapshot, revised: snapshot } },
  };
}
function childProcess() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  let resolveSpawned!: () => void;
  const spawned = new Promise<void>((resolve) => { resolveSpawned = resolve; });
  native.spawn.mockImplementation(() => { resolveSpawned(); return child; });
  return { child, spawned };
}
beforeEach(() => {
  vi.resetAllMocks();
  native.readFile.mockImplementation(async (path: string) => JSON.stringify({ name: path.endsWith("apps/server/package.json") ? "@bb/server" : "bb" }));
  native.stat.mockResolvedValue({ isFile: () => true });
  native.realpath.mockImplementation(async (path: string) => path);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("fixed native recovery safeguard service boundary", () => {
  it("runs only its owned driver and removes BB thread/profile and Node loader context", async () => {
    vi.stubEnv("BB_THREAD_ID", "live-thread");
    vi.stubEnv("BB_DATA_DIR", "/live/profile");
    vi.stubEnv("NODE_OPTIONS", "--import /client-selected-loader.mjs");
    const { child, spawned } = childProcess();
    const verification = verifyRecoverySafeguards();
    await spawned;
    const expected = receipt();
    child.stdout.end(`${JSON.stringify(expected)}\n`);
    child.emit("close", 0, null);
    await expect(verification).resolves.toEqual(expected);
    const [executable, args, options] = native.spawn.mock.calls[0]!;
    expect(executable).toBe(process.execPath);
    expect(args).toHaveLength(1);
    expect(args[0]).toMatch(/apps\/server\/scripts\/verify-recovery-safeguards\.mjs$/);
    expect(options.env).not.toHaveProperty("BB_THREAD_ID");
    expect(options.env).not.toHaveProperty("BB_DATA_DIR");
    expect(options.env).not.toHaveProperty("NODE_OPTIONS");
  });

  it("waits for child exit and cleanup before rejecting cancellation", async () => {
    const { child, spawned } = childProcess();
    const controller = new AbortController();
    const verification = verifyRecoverySafeguards({ signal: controller.signal });
    let settled = false;
    const observed = verification.then(() => { settled = true; }, () => { settled = true; });
    await spawned;
    controller.abort();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("close", 1, null);
    await expect(verification).rejects.toMatchObject({ name: "AbortError" });
    await observed;
  });

  it.each(["duplicate", "extra", "failed", "cleanup", "snapshot", "timestamp", "diagnostic"] as const)("rejects %s receipt evidence even after a successful child exit", async (change) => {
    const { child, spawned } = childProcess();
    const verification = verifyRecoverySafeguards();
    await spawned;
    const payload = receipt();
    if (change === "duplicate") payload.checks[1]!.id = payload.checks[0]!.id;
    if (change === "extra") Object.assign(payload, { clientProof: true });
    if (change === "failed") payload.checks[0]!.passed = false;
    if (change === "cleanup") payload.cleanup.passed = false;
    if (change === "snapshot") payload.lifecycle.eager.active.eventSequence = -1;
    if (change === "timestamp") payload.exercisedAt = 1;
    child.stdout.end(`${change === "diagnostic" ? "fixture passed\n" : ""}${JSON.stringify(payload)}\n`);
    child.emit("close", 0, null);
    await expect(verification).rejects.toThrow();
  });

  it("never accepts a witness when its driver reports native source mutation", async () => {
    const { child, spawned } = childProcess();
    const verification = verifyRecoverySafeguards();
    await spawned;
    child.stdout.end(JSON.stringify(receipt()));
    child.stderr.end("Native recovery safeguard sources changed during verification; no receipt was issued");
    child.emit("close", 1, null);
    await expect(verification).rejects.toThrow("sources changed during verification");
  });

  it("reports the source development prerequisite without spawning a fallback", async () => {
    native.stat.mockRejectedValue(new Error("ENOENT"));
    await expect(verifyRecoverySafeguards()).rejects.toThrow("source-built native checkout");
    expect(native.spawn).not.toHaveBeenCalled();
  });

  it("does not spawn when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(verifyRecoverySafeguards({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(native.readFile).not.toHaveBeenCalled();
    expect(native.spawn).not.toHaveBeenCalled();
  });
});
