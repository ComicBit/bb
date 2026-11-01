import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyRecoverySafeguards } from "../../../src/services/threads/thread-recovery-verification.js";

const native = vi.hoisted(() => ({ spawn: vi.fn(), readFile: vi.fn(), stat: vi.fn(), realpath: vi.fn(), mkdtemp: vi.fn(), rm: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: native.spawn }));
vi.mock("node:fs/promises", () => ({ readFile: native.readFile, stat: native.stat, realpath: native.realpath, mkdtemp: native.mkdtemp, rm: native.rm }));

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
  const child = Object.assign(new EventEmitter(), { pid: 24680, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), disconnect: vi.fn(), unref: vi.fn(), connected: true });
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
  native.mkdtemp.mockResolvedValue("/tmp/bb-native-recovery-owner-test");
  native.rm.mockResolvedValue(undefined);
  vi.spyOn(process, "kill").mockReturnValue(true);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

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
    expect(options.detached).toBe(true);
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe", "ipc"]);
    expect(options.env.TMPDIR).toBe("/tmp/bb-native-recovery-owner-test");
    expect(options.env.TMP).toBe(options.env.TMPDIR);
    expect(options.env.TEMP).toBe(options.env.TMPDIR);
    expect(process.kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
    expect(native.rm).toHaveBeenCalledWith("/tmp/bb-native-recovery-owner-test", { recursive: true, force: true });
  });

  it("waits for child exit and cleanup before rejecting cancellation", async () => {
    const { child, spawned } = childProcess();
    const controller = new AbortController();
    const verification = verifyRecoverySafeguards({ signal: controller.signal });
    let settled = false;
    const observed = verification.then(() => { settled = true; }, () => { settled = true; });
    await spawned;
    controller.abort();
    expect(process.kill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("close", 1, null);
    await expect(verification).rejects.toMatchObject({ name: "AbortError" });
    await observed;
  });

  it("escalates an uncooperative driver and bounds cancellation without a close event", async () => {
    vi.useFakeTimers();
    const { child, spawned } = childProcess();
    const controller = new AbortController();
    const verification = verifyRecoverySafeguards({ signal: controller.signal });
    const rejection = expect(verification).rejects.toMatchObject({ name: "AbortError" });
    await spawned;
    controller.abort();
    expect(native.rm).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(process.kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
    expect(native.rm).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    await rejection;
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(child.disconnect).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
    expect(native.rm).toHaveBeenCalledOnce();
  });

  it("enforces the fixed hard deadline even if the driver ignores every signal", async () => {
    vi.useFakeTimers();
    const { child, spawned } = childProcess();
    const verification = verifyRecoverySafeguards();
    const rejection = expect(verification).rejects.toThrow("300000ms deadline");
    await spawned;
    await vi.advanceTimersByTimeAsync(300000);
    expect(process.kill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
    await vi.advanceTimersByTimeAsync(6000);
    await rejection;
    expect(process.kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
    expect(native.rm).toHaveBeenCalledOnce();
  });

  it("kills surviving owned descendants when their driver exits before escalation", async () => {
    const { child, spawned } = childProcess();
    const controller = new AbortController();
    const verification = verifyRecoverySafeguards({ signal: controller.signal });
    const rejection = expect(verification).rejects.toMatchObject({ name: "AbortError" });
    await spawned;
    controller.abort();
    child.emit("exit", 1, null);
    expect(process.kill).toHaveBeenLastCalledWith(-child.pid, "SIGKILL");
    child.emit("close", 1, null);
    await rejection;
    expect(process.kill).not.toHaveBeenCalledWith(child.pid, expect.anything());
    expect(child.kill).not.toHaveBeenCalled();
    expect(native.rm).toHaveBeenCalledOnce();
  });

  it("does not accept receipt output without bounded process and pipe closure", async () => {
    vi.useFakeTimers();
    const { child, spawned } = childProcess();
    const verification = verifyRecoverySafeguards();
    const rejection = expect(verification).rejects.toThrow("did not close");
    await spawned;
    child.stdout.write(JSON.stringify(receipt()));
    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(3000);
    await rejection;
    expect(process.kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
    expect(native.rm).toHaveBeenCalledOnce();
  });

  it("removes its owned root if spawning the fixed driver fails", async () => {
    native.spawn.mockImplementation(() => { throw new Error("spawn failed"); });
    await expect(verifyRecoverySafeguards()).rejects.toThrow("spawn failed");
    expect(native.rm).toHaveBeenCalledOnce();
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("fails closed when temporary artifact cleanup fails", async () => {
    native.rm.mockRejectedValue(new Error("cleanup denied"));
    const { child, spawned } = childProcess();
    const verification = verifyRecoverySafeguards();
    const rejection = expect(verification).rejects.toThrow("cleanup denied");
    await spawned;
    child.stdout.end(JSON.stringify(receipt()));
    child.emit("close", 0, null);
    await rejection;
  });

  it("bounds temporary artifact cleanup rather than accepting an unremoved root", async () => {
    vi.useFakeTimers();
    native.rm.mockReturnValue(Promise.withResolvers<void>().promise);
    const { child, spawned } = childProcess();
    const verification = verifyRecoverySafeguards();
    const rejection = expect(verification).rejects.toThrow("temporary artifact cleanup exceeded");
    await spawned;
    child.stdout.end(JSON.stringify(receipt()));
    child.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(3000);
    await rejection;
  });

  it("fails closed on platforms without owned process-group termination", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      await expect(verifyRecoverySafeguards()).rejects.toThrow("POSIX process-group");
      expect(native.spawn).not.toHaveBeenCalled();
      expect(native.mkdtemp).not.toHaveBeenCalled();
    } finally { Object.defineProperty(process, "platform", platform); }
  });

  it("fails closed if the owned process group cannot be terminated", async () => {
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); });
    const { child, spawned } = childProcess();
    const verification = verifyRecoverySafeguards();
    const rejection = expect(verification).rejects.toThrow("process-group termination failed");
    await spawned;
    child.stdout.end(JSON.stringify(receipt()));
    child.emit("close", 0, null);
    await rejection;
    expect(native.rm).toHaveBeenCalledOnce();
  });

  it("cleans the owned root after an asynchronous spawn failure without signaling a PID", async () => {
    const { child, spawned } = childProcess();
    Reflect.deleteProperty(child, "pid");
    const verification = verifyRecoverySafeguards();
    const rejection = expect(verification).rejects.toThrow("spawn unavailable");
    await spawned;
    child.emit("error", new Error("spawn unavailable"));
    await rejection;
    expect(process.kill).not.toHaveBeenCalled();
    expect(native.rm).toHaveBeenCalledOnce();
  });

  it("does not settle cancellation until parent-owned temporary cleanup completes", async () => {
    const cleanup = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    native.rm.mockImplementation(() => { cleanupStarted.resolve(); return cleanup.promise; });
    const { child, spawned } = childProcess();
    const controller = new AbortController();
    const verification = verifyRecoverySafeguards({ signal: controller.signal });
    let settled = false;
    const observed = verification.then(() => { settled = true; }, () => { settled = true; });
    await spawned;
    controller.abort();
    child.emit("close", 1, null);
    await cleanupStarted.promise;
    expect(settled).toBe(false);
    cleanup.resolve();
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
