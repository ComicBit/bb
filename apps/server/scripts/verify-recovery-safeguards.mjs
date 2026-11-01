#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const server = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkout = resolve(server, "../..");
const fixture = "test/services/threads/thread-recovery-safeguards.test.ts";
const ids = ["stop-suppresses-execution", "fresh-user-rearms", "queued-plugin-input-does-not-rearm", "same-ending-deduplication", "startup-no-catch-up", "eager-live-ending-run-identity", "run-message-revision-admission", "pause-disable-admission-race", "role-visibility-parent-admission", "archive-delete-admission", "queue-interaction-background-admission", "host-admission"];
const sourceDirectories = ["apps/server/src", "apps/server/test/helpers", "apps/server/test/setup", "packages/db/src", "packages/db/drizzle", "packages/domain/src", "packages/config/src", "packages/plugin-sdk/src", "packages/plugin-build/src", "packages/host-daemon-contract/src", "packages/server-contract/src", "packages/provider-bridge-protocol/src"];
const sourceFiles = ["package.json", "pnpm-lock.yaml", "apps/server/package.json", "apps/server/vitest.config.ts", "vitest.shared.ts", "vitest.global-tmpdir.ts", "packages/bb-app/package.json", "packages/plugin-sdk/package.json", "packages/plugin-build/package.json", "apps/desktop/package.json", "scripts/build-node-entry.mjs", "scripts/build-utils.mjs", "apps/server/scripts/verify-recovery-safeguards.mjs", `apps/server/${fixture}`];

function object(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) throw new Error(`Invalid native safeguard ${label}`);
  return value;
}
function text(value) { return typeof value === "string" && value.trim().length > 0; }
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function snapshot(value) {
  object(value, ["threadId", "projectId", "revision", "eventSequence", "status", "providerId", "hostId", "hostOnline", "visibility", "parentThreadId", "archivedAt", "deletedAt", "pluginMetadata", "run", "stop", "finalAssistant", "queuedMessageCount", "pendingInteractionCount", "activeBackgroundTaskCount", "metadataReadable"], "snapshot");
  if (![value.threadId, value.projectId, value.revision, value.providerId].every(text) || !["pending", "idle", "starting", "active", "stopping", "error"].includes(value.status) || !/^[a-f0-9]{64}$/.test(value.revision) || ![value.eventSequence, value.queuedMessageCount, value.pendingInteractionCount, value.activeBackgroundTaskCount].every(integer) || typeof value.hostOnline !== "boolean" || typeof value.metadataReadable !== "boolean" || !["visible", "hidden"].includes(value.visibility) || ![value.hostId, value.parentThreadId].every((entry) => entry === null || text(entry)) || ![value.archivedAt, value.deletedAt].every((entry) => entry === null || integer(entry)) || value.pluginMetadata === null || typeof value.pluginMetadata !== "object" || Array.isArray(value.pluginMetadata)) throw new Error("Invalid native safeguard snapshot fields");
  if (value.run !== null) {
    object(value.run, ["requestId", "requestSequence", "initiator", "provenance", "freshUserRequestId", "freshUserSequence"], "run");
    if (!text(value.run.requestId) || !integer(value.run.requestSequence) || !["user", "system", "agent"].includes(value.run.initiator) || !["fresh-user", "queued-user", "plugin", "agent", "system", "unknown"].includes(value.run.provenance) || !(value.run.freshUserRequestId === null || text(value.run.freshUserRequestId)) || !(value.run.freshUserSequence === null || integer(value.run.freshUserSequence))) throw new Error("Invalid native safeguard run fields");
  }
  if (value.stop !== null) {
    object(value.stop, ["revision", "requestId"], "stop");
    if (!integer(value.stop.revision) || !(value.stop.requestId === null || text(value.stop.requestId))) throw new Error("Invalid native safeguard stop fields");
  }
  if (value.finalAssistant !== null) {
    object(value.finalAssistant, ["messageId", "revision", "text"], "assistant");
    if (!text(value.finalAssistant.messageId) || !integer(value.finalAssistant.revision) || typeof value.finalAssistant.text !== "string") throw new Error("Invalid native safeguard assistant fields");
  }
}
function witness(value, startedAt, finishedAt) {
  object(value, ["exercisedAt", "checks", "cleanup", "lifecycle"], "witness envelope");
  if (!integer(value.exercisedAt) || value.exercisedAt < startedAt || value.exercisedAt > finishedAt) throw new Error("Native safeguard witness has a stale or invalid exercise timestamp");
  object(value.checks, ids, "checks");
  for (const id of ids) {
    const check = object(value.checks[id], ["passed", "evidence"], `check ${id}`);
    if (check.passed !== true || !text(check.evidence)) throw new Error(`Native safeguard ${id} did not pass with evidence`);
  }
  object(value.cleanup, ["passed", "evidence"], "cleanup");
  if (value.cleanup.passed !== true || !text(value.cleanup.evidence)) throw new Error("Native safeguard fixture cleanup did not complete");
  object(value.lifecycle, ["startup", "eager", "dedup"], "lifecycle");
  for (const [group, keys] of [["startup", ["idle", "active", "ended"]], ["eager", ["active", "ended", "superseded"]], ["dedup", ["active", "ended", "revised"]]]) {
    object(value.lifecycle[group], keys, `lifecycle ${group}`);
    for (const key of keys) snapshot(value.lifecycle[group][key]);
  }
  return value;
}
async function sourceIdentity() {
  const paths = [...sourceFiles];
  async function walk(directory) {
    for (const entry of await readdir(join(checkout, directory), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /\.(?:[cm]?[jt]sx?|json|sql)$/.test(entry.name)) paths.push(path);
    }
  }
  for (const directory of sourceDirectories) await walk(directory);
  const hash = createHash("sha256");
  for (const path of [...new Set(paths)].sort()) {
    hash.update(path).update("\0").update(await readFile(join(checkout, path))).update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}
function environment(root) {
  const env = {};
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "LANG", "LC_ALL", "TZ"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root, TEMP: root, XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"), XDG_DATA_HOME: join(root, "data"), NODE_ENV: "test", CI: "1", BB_DATA_DIR: join(root, "bb-data"), BB_NATIVE_RECOVERY_WITNESS_PATH: join(root, "witness.json") };
}
async function exercise(cli, config, root, signal) {
  if (signal.aborted) throw signal.reason;
  const child = spawn(process.execPath, ["--conditions=source", cli, "run", "--config", config, fixture], { cwd: server, env: environment(root), detached: false, stdio: ["ignore", "pipe", "pipe"] });
  let diagnostic = "";
  let failure;
  let escalation;
  let drain;
  let finished = false;
  const { promise: exited, resolve: resolveExit } = Promise.withResolvers();
  function finish(exit) {
    if (finished) return;
    finished = true;
    clearTimeout(escalation);
    clearTimeout(drain);
    resolveExit(exit);
  }
  function kill(mode) {
    try { child.kill(mode); }
    catch (error) { if (error.code !== "ESRCH") failure ??= error; }
  }
  function boundPipeClosure() {
    if (finished || drain !== undefined) return;
    drain = setTimeout(() => {
      failure ??= new Error("Native safeguard isolated fixture did not close after forced termination");
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finish({ code: null, exitSignal: "SIGKILL" });
    }, 3000);
  }
  function terminate(reason) {
    if (failure !== undefined || finished) return;
    failure = reason;
    kill("SIGTERM");
    escalation = setTimeout(() => { kill("SIGKILL"); boundPipeClosure(); }, 3000);
  }
  child.once("error", (error) => {
    failure ??= error;
    kill("SIGKILL");
    boundPipeClosure();
  });
  child.once("exit", boundPipeClosure);
  child.once("close", (code, exitSignal) => finish({ code, exitSignal }));
  const abort = () => terminate(signal.reason ?? new Error("Native safeguard verification aborted"));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timeout = setTimeout(() => terminate(new Error("Native safeguard fixture exceeded its 240000ms isolated-process deadline")), 240000);
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { diagnostic = (diagnostic + chunk.toString()).slice(-32768); });
  try {
    const exit = await exited;
    if (failure !== undefined) throw failure;
    if (exit.code !== 0 || exit.exitSignal !== null) throw new Error(`Native safeguard isolated fixture failed (${exit.code ?? exit.exitSignal}). Source development prerequisites: installed workspace dependencies, generated workspace source artifacts and a working better-sqlite3 native module.\n${diagnostic}`);
  } finally {
    signal.removeEventListener("abort", abort);
    clearTimeout(timeout);
    clearTimeout(escalation);
    clearTimeout(drain);
  }
}

export async function verifyRecoverySafeguards({ signal } = {}) {
  if (process.platform === "win32" || !process.connected || typeof process.send !== "function") throw new Error("Native recovery safeguards require the server-owned POSIX process-group driver and IPC ownership channel");
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason ?? new Error("Native safeguard verification aborted"));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let root;
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    let cli;
    let before;
    let runtimeVersion;
    try {
      const require = createRequire(join(server, "package.json"));
      const vitestPackage = require.resolve("vitest/package.json");
      cli = join(dirname(await realpath(vitestPackage)), "vitest.mjs");
      if (!(await stat(cli)).isFile()) throw new Error("Vitest CLI is missing");
      require.resolve("better-sqlite3");
      before = await sourceIdentity();
      const nativePackage = JSON.parse(await readFile(join(checkout, "packages/bb-app/package.json"), "utf8"));
      if (nativePackage.name !== "bb-app" || !text(nativePackage.version)) throw new Error("Invalid native package version");
      runtimeVersion = nativePackage.version;
    } catch (error) {
      throw new Error(`Native recovery safeguards require this source checkout's fixed fixture, native semantic sources and installed Vitest/source development dependencies (pnpm install and the workspace generated-source prerequisites): ${error.message}`, { cause: error });
    }
    if (controller.signal.aborted) throw controller.signal.reason;
    root = await mkdtemp(join(tmpdir(), "bb-native-recovery-verification-"));
    const config = join(root, "vitest.config.mjs");
    await writeFile(config, `export default ${JSON.stringify({ root: server, cacheDir: join(root, "vite-cache"), resolve: { conditions: ["source"] }, ssr: { resolve: { conditions: ["source"], externalConditions: ["source"] } }, test: { include: [fixture], setupFiles: [join(server, "test/setup/stored-event-decode-freeze.ts"), join(server, "test/setup/warm-test-harness.ts")], environment: "node", isolate: true, pool: "forks", maxWorkers: 1, fileParallelism: false, testTimeout: 180000, hookTimeout: 180000, watch: false, reporters: ["default"] } })};\n`);
    const startedAt = Date.now();
    await exercise(cli, config, root, controller.signal);
    if (controller.signal.aborted) throw controller.signal.reason;
    const witnessPath = join(root, "witness.json");
    if ((await stat(witnessPath)).size > 1048576) throw new Error("Native safeguard witness exceeds the fixed size limit");
    const result = witness(JSON.parse(await readFile(witnessPath, "utf8")), startedAt, Date.now());
    await rm(root, { recursive: true, force: true });
    root = undefined;
    if (await sourceIdentity() !== before) throw new Error("Native recovery safeguard sources changed during verification; no receipt was issued");
    if (controller.signal.aborted) throw controller.signal.reason;
    return { sourceRevision: before, runtimeVersion, exercisedAt: result.exercisedAt, checks: ids.map((id) => ({ id, passed: result.checks[id].passed, witness: result.checks[id].evidence })), cleanup: { passed: true, witness: `${result.cleanup.evidence}; isolated fixture exited and verifier-owned temporary artifacts removed` }, lifecycle: result.lifecycle };
  } finally {
    try { if (root !== undefined) await rm(root, { recursive: true, force: true }); }
    finally { signal?.removeEventListener("abort", abort); }
  }
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Native safeguard verification aborted"));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    if (process.argv.length !== 2) throw new Error("Native safeguard verifier accepts no command, path or proof arguments");
    process.stdout.write(`${JSON.stringify(await verifyRecoverySafeguards({ signal: controller.signal }))}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    if (process.connected) process.disconnect();
  }
}
