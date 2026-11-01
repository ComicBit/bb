import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { threadStatusSchema, threadTurnInitiatorSchema } from "@bb/domain";
import type { ExperimentalRecoverySafeguardsReceipt } from "@get-bb/plugin-sdk";

const checkIds = [
  "stop-suppresses-execution", "fresh-user-rearms", "queued-plugin-input-does-not-rearm",
  "same-ending-deduplication", "startup-no-catch-up", "eager-live-ending-run-identity",
  "run-message-revision-admission", "pause-disable-admission-race", "role-visibility-parent-admission",
  "archive-delete-admission", "queue-interaction-background-admission", "host-admission",
] as const;
const evidenceSchema = z.string().trim().min(1);
const sequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const snapshotSchema = z.object({
  threadId: evidenceSchema,
  projectId: evidenceSchema,
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  eventSequence: sequenceSchema,
  status: threadStatusSchema,
  providerId: evidenceSchema,
  hostId: evidenceSchema.nullable(),
  hostOnline: z.boolean(),
  visibility: z.enum(["visible", "hidden"]),
  parentThreadId: evidenceSchema.nullable(),
  archivedAt: sequenceSchema.nullable(),
  deletedAt: sequenceSchema.nullable(),
  pluginMetadata: z.record(z.string(), z.json()),
  run: z.object({
    requestId: evidenceSchema,
    requestSequence: sequenceSchema,
    initiator: threadTurnInitiatorSchema,
    provenance: z.enum(["fresh-user", "queued-user", "plugin", "agent", "system", "unknown"]),
    freshUserRequestId: evidenceSchema.nullable(),
    freshUserSequence: sequenceSchema.nullable(),
  }).strict().nullable(),
  stop: z.object({ revision: sequenceSchema, requestId: evidenceSchema.nullable() }).strict().nullable(),
  finalAssistant: z.object({ messageId: evidenceSchema, revision: sequenceSchema, text: z.string() }).strict().nullable(),
  queuedMessageCount: sequenceSchema,
  pendingInteractionCount: sequenceSchema,
  activeBackgroundTaskCount: sequenceSchema,
  metadataReadable: z.boolean(),
}).strict();
const receiptSchema = z.object({
  sourceRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  runtimeVersion: evidenceSchema,
  exercisedAt: sequenceSchema,
  checks: z.array(z.object({ id: z.enum(checkIds), passed: z.literal(true), witness: evidenceSchema }).strict()).length(checkIds.length),
  cleanup: z.object({ passed: z.literal(true), witness: evidenceSchema }).strict(),
  lifecycle: z.object({
    startup: z.object({ idle: snapshotSchema, active: snapshotSchema, ended: snapshotSchema }).strict(),
    eager: z.object({ active: snapshotSchema, ended: snapshotSchema, superseded: snapshotSchema }).strict(),
    dedup: z.object({ active: snapshotSchema, ended: snapshotSchema, revised: snapshotSchema }).strict(),
  }).strict(),
}).strict();

async function fixedDriver(): Promise<{ driver: string; server: string }> {
  let ancestor = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const server = join(ancestor, "apps/server");
    const driver = join(server, "scripts/verify-recovery-safeguards.mjs");
    try {
      const rootPackage: unknown = JSON.parse(await readFile(join(ancestor, "package.json"), "utf8"));
      const serverPackage: unknown = JSON.parse(await readFile(join(server, "package.json"), "utf8"));
      if (z.object({ name: z.literal("bb") }).safeParse(rootPackage).success && z.object({ name: z.literal("@bb/server") }).safeParse(serverPackage).success && (await stat(driver)).isFile() && (await stat(join(server, "test/services/threads/thread-recovery-safeguards.test.ts"))).isFile()) {
        return { driver: await realpath(driver), server: await realpath(server) };
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  throw new Error("Native recovery safeguard verification requires the source-built native checkout containing apps/server/scripts/verify-recovery-safeguards.mjs, its fixed source fixture and installed Vitest/source development dependencies; this installed runtime has no owned source verifier");
}

export async function verifyRecoverySafeguards(
  { signal }: { signal?: AbortSignal } = {},
): Promise<ExperimentalRecoverySafeguardsReceipt> {
  signal?.throwIfAborted();
  const invokedAt = Date.now();
  if (process.platform === "win32") throw new Error("Native recovery safeguard verification requires POSIX process-group ownership; this platform cannot safely terminate the isolated verifier tree");
  const { driver, server } = await fixedDriver();
  signal?.throwIfAborted();
  const root = await mkdtemp(join(tmpdir(), "bb-native-recovery-owner-"));
  try {
    signal?.throwIfAborted();
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "LANG", "LC_ALL", "TZ"]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    for (const key of ["TMPDIR", "TMP", "TEMP"]) env[key] = root;
    const child = spawn(process.execPath, [driver], { cwd: server, env, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stdout = "";
    let stderr = "";
    let failure: Error | undefined;
    let ownershipFailure: Error | undefined;
    let finished = false;
    let groupKilled = false;
    let escalation: NodeJS.Timeout | undefined;
    let drain: NodeJS.Timeout | undefined;
    const killOwnedGroup = (mode: "SIGTERM" | "SIGKILL") => {
      if (child.pid === undefined || groupKilled) return;
      if (mode === "SIGKILL") groupKilled = true;
      try { process.kill(-child.pid, mode); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
          ownershipFailure = new Error("Native recovery safeguard owned process-group termination failed", { cause: error });
        }
      }
    };
    const { promise: exitPromise, resolve: resolveExit } = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
    const finish = (exit: { code: number | null; signal: NodeJS.Signals | null }) => {
      if (finished) return;
      finished = true;
      clearTimeout(escalation);
      clearTimeout(drain);
      resolveExit(exit);
    };
    const boundPipeClosure = () => {
      if (finished || drain !== undefined) return;
      drain = setTimeout(() => {
        failure ??= new Error("Native recovery safeguard driver did not close its owned process and pipes after forced termination");
        child.stdout.destroy();
        child.stderr.destroy();
        try { if (child.connected) child.disconnect(); }
        catch (error) { ownershipFailure ??= new Error("Native recovery safeguard driver IPC cleanup failed", { cause: error }); }
        child.unref();
        finish({ code: null, signal: "SIGKILL" });
      }, 3000);
    };
    const terminate = (error: Error) => {
      if (failure !== undefined || finished) return;
      failure = error;
      killOwnedGroup("SIGTERM");
      escalation = setTimeout(() => {
        killOwnedGroup("SIGKILL");
        boundPipeClosure();
      }, 3000);
    };
    child.once("error", (error) => {
      if (child.pid === undefined) {
        failure ??= error;
        finish({ code: null, signal: null });
      } else terminate(error);
    });
    child.once("exit", () => {
      killOwnedGroup("SIGKILL");
      clearTimeout(escalation);
      boundPipeClosure();
    });
    child.once("close", (code, exitSignal) => {
      killOwnedGroup("SIGKILL");
      finish({ code, signal: exitSignal });
    });
    const abort = () => terminate(new DOMException("Native recovery safeguard verification aborted", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const deadline = setTimeout(() => terminate(new Error("Native recovery safeguard driver exceeded its 300000ms deadline")), 300000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > 1048576) terminate(new Error("Native recovery safeguard driver output exceeds its fixed size limit"));
      else stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-32768); });
    try {
      const exit = await exitPromise;
      if (ownershipFailure !== undefined) throw ownershipFailure;
      if (failure !== undefined) throw failure;
      signal?.throwIfAborted();
      if (exit.code !== 0 || exit.signal !== null) throw new Error(`Native recovery safeguard driver failed (${exit.code ?? exit.signal}): ${stderr.trim()}`);
      let payload: unknown;
      try { payload = JSON.parse(stdout); }
      catch (error) { throw new Error("Native recovery safeguard driver did not return a single JSON receipt", { cause: error }); }
      const receipt = receiptSchema.parse(payload);
      if (new Set(receipt.checks.map((check) => check.id)).size !== checkIds.length) throw new Error("Native recovery safeguard driver returned duplicate or missing check IDs");
      if (receipt.exercisedAt < invokedAt || receipt.exercisedAt > Date.now()) throw new Error("Native recovery safeguard driver returned a stale or invalid exercise timestamp");
      return receipt;
    } finally {
      clearTimeout(deadline);
      clearTimeout(escalation);
      clearTimeout(drain);
      signal?.removeEventListener("abort", abort);
    }
  } finally {
    const { promise: cleanupExpired, reject: rejectCleanup } = Promise.withResolvers<never>();
    const cleanupDeadline = setTimeout(() => rejectCleanup(new Error("Native recovery safeguard temporary artifact cleanup exceeded its 3000ms deadline")), 3000);
    try { await Promise.race([rm(root, { recursive: true, force: true }), cleanupExpired]); }
    finally { clearTimeout(cleanupDeadline); }
  }
}
