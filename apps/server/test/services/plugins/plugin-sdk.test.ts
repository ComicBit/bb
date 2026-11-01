import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveThread,
  createThread,
  getThread,
  insertThreadPluginMetadata,
  type DbConnection,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import type { Logger } from "@bb/logger";
import { createAiServiceRegistry, type AiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import {
  createPluginService,
  type PluginServiceDeps,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import type { BbPluginApi } from "../../../src/services/plugins/plugin-api.js";
import {
  seedHostSession,
  seedEnvironment,
  seedPrimaryHost,
  seedProjectWithSource,
  seedThreadRuntimeState,
} from "../../helpers/seed.js";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../../helpers/commands.js";
import { PluginHostArtifactRegistry } from "../../../src/services/plugins/plugin-host-artifact-registry.js";
import { startTestServer, testLogger } from "../../helpers/test-app.js";
import {
  defineRpcContract,
  type ExperimentalRecovery,
  type ExperimentalRecoverySnapshot,
  type ExperimentalRecoverySafeguardsReceipt,
  type PluginAiCompleteOptions,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";

const logger = testLogger as unknown as Logger;

async function writePlugin(
  dir: string,
  options: { name: string; serverSource: string; hostSource?: string },
): Promise<string> {
  const rootDir = join(dir, options.name);
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: options.name,
      version: "0.1.0",
      bb: {
        name: "SDK fixture",
        description: "Plugin SDK fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
        ...(options.hostSource === undefined ? {} : { host: "./host.ts" }),
      },
    }),
  );
  await writeFile(join(rootDir, "server.ts"), options.serverSource);
  if (options.hostSource !== undefined) {
    await writeFile(join(rootDir, "host.ts"), options.hostSource);
  }
  return rootDir;
}

function requireApi(service: PluginService, pluginId: string): BbPluginApi {
  const api = service.getApi(pluginId);
  if (!api) throw new Error(`plugin ${pluginId} is not running`);
  return api;
}

function agentConfigurationContext(
  threadId: string,
): Parameters<PluginService["resolveAgentConfiguration"]>[0]["context"] {
  return {
    thread: {
      id: threadId,
      title: null,
      parentThreadId: null,
      sourceThreadId: null,
    },
    project: {
      id: "project-configure",
      kind: "standard",
      name: "Configure fixture",
      gitRemoteUrl: null,
    },
    environment: {
      id: "environment-configure",
      name: null,
      path: null,
      branchName: null,
      workspaceProvisionType: null,
    },
    host: { id: "host-configure", name: "Configure host" },
    provider: {
      id: "codex",
      model: "gpt-5",
      capabilities: { supportsNativeUserQuestion: false },
    },
    origin: { kind: null, pluginId: null },
  };
}

describe("plugin bb.sdk bind gate", () => {
  let db: DbConnection;
  let workDir: string;
  let service: PluginService;
  let pluginHostArtifacts: PluginHostArtifactRegistry;
  let appUrl: string | null;
  let aiServices: AiServiceRegistry;
  const continueRecovery = vi.fn<ExperimentalRecovery["continue"]>(
    async () => ({ admitted: false, reason: "policy" }),
  );
  const verifySafeguards = vi.fn(
    async (_args?: { signal?: AbortSignal }): Promise<ExperimentalRecoverySafeguardsReceipt> => {
      throw new Error("No safeguard verifier configured for this test");
    },
  );
  const sharedPorts = {
    declareSharedPorts: vi.fn(),
    validateSharedPortDeclaration: vi.fn(
      (_hostId: string, ports: readonly number[]) => [...ports],
    ),
    replaceDeclarationsForOwner: vi.fn(),
    clearDeclarationsForOwner: vi.fn(),
    setNextTunnelConfig: vi.fn(),
    listNextTunnelStatuses: vi.fn(() => [
      {
        hostId: "host-1",
        hostName: "Sawyer Air",
        status: {
          state: "connected" as const,
          label: "sawyer-air",
          lastError: null,
          nextRetryAt: null,
          since: 1,
          shares: [],
        },
      },
    ]),
    onNextTunnelStatusChange: vi.fn((_listener: () => void) => nextUnsubscribe),
  };
  const nextUnsubscribe = vi.fn();
  const ensureSharedPortTunnel = vi.fn().mockResolvedValue({
    label: "sawyer-air",
    baseDomain: "getbb.app",
  });
  const callPluginHost = vi.fn(
    async (
      _args: Parameters<NonNullable<PluginServiceDeps["callPluginHost"]>>[0],
    ) => ({ pong: true }),
  );
  const disposePluginHost = vi.fn(async () => undefined);
  it("discovers only published methods from live implementations and removes them on disable", async () => {
    for (const id of ["usage-a", "usage-b"]) {
      const rootDir = await writePlugin(workDir, {
        name: `bb-plugin-${id}`,
        serverSource: `export default function plugin() {}`,
      });
      await service.installPath(rootDir);
      requireApi(service, id).rpc.register(
        defineRpcContract({
          "usage.v1.get": {
            input: z.null(),
            output: z.object({ percent: z.number() }),
            experimental_description: "Current usage",
          },
        }),
        { "usage.v1.get": () => ({ percent: 42 }) },
        {
          experimental_discoverable: true,
          experimental_description: "Usage source",
        },
      );
      requireApi(service, id).rpc.register(
        { internal: { input: z.null(), output: z.null() } },
        { internal: () => null },
      );
    }
    expect(
      service
        .discoverRpc({ method: "usage.v1.get" })
        .map((item) => item.pluginId),
    ).toEqual(["usage-a", "usage-b"]);
    expect(service.discoverRpc({ method: "internal" })).toEqual([]);
    expect(service.discoverRpc({ pluginId: "usage-a" })).toHaveLength(1);
    await service.setEnabled("usage-a", false);
    expect(service.discoverRpc({}).map((item) => item.pluginId)).toEqual([
      "usage-b",
    ]);
  });

  beforeEach(async () => {
    db = createMigratedConnection();
    workDir = await mkdtemp(join(tmpdir(), "bb-plugin-sdk-test-"));
    sharedPorts.declareSharedPorts.mockClear();
    sharedPorts.validateSharedPortDeclaration.mockClear();
    sharedPorts.replaceDeclarationsForOwner.mockClear();
    sharedPorts.clearDeclarationsForOwner.mockClear();
    sharedPorts.setNextTunnelConfig.mockClear();
    sharedPorts.onNextTunnelStatusChange.mockClear();
    nextUnsubscribe.mockClear();
    ensureSharedPortTunnel.mockClear();
    callPluginHost.mockClear();
    disposePluginHost.mockClear();
    appUrl = "https://bb.example.test";
    pluginHostArtifacts = new PluginHostArtifactRegistry();
    aiServices = createAiServiceRegistry();
    verifySafeguards.mockClear();
    continueRecovery.mockClear();
    service = createPluginService({
      aiServices,
      recovery: {
        snapshot: () => null,
        continue: continueRecovery,
        verifySafeguards,
      },
      telemetry: createNoopTelemetryService(),
      db,
      pluginHostArtifacts,
      sharedPorts,
      ensureSharedPortTunnel,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginChanged: () => {},
        onWatchedTargets: () => () => {},
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: join(workDir, "data"),
      appVersion: "0.9.0",
      getAppUrl: () => appUrl,
      loadTimeoutMs: 2000,
      callPluginHost,
      disposePluginHost,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await service.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  it("throws a descriptive error before bindSdk and resolves after", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-gate",
      serverSource: `export default function plugin() {}`,
    });
    await service.installPath(rootDir);
    const api = requireApi(service, "gate");

    expect(() => api.sdk).toThrow(
      /bb\.sdk is not available until the server is listening/,
    );

    service.bindSdk({ baseUrl: "http://127.0.0.1:9" });
    expect(typeof api.sdk.threads.fork).toBe("function");
    expect(typeof api.sdk.threads.spawn).toBe("function");
  });

  it("rejects unsafe plugin metadata before transport serialization", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-metadata-boundary",
      serverSource: `export default function plugin() {}`,
    });
    await service.installPath(rootDir);
    service.bindSdk({ baseUrl: "http://127.0.0.1:9" });
    const api = requireApi(service, "metadata-boundary");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const invalidValues: Array<{
      value: unknown;
      error: Record<string, unknown>;
    }> = [
      {
        value: Number.NaN,
        error: { message: "pluginMetadata must be a plain JSON object" },
      },
      { value: { missing: undefined }, error: { name: "ZodError" } },
    ];
    const operations = [
      (pluginMetadata: unknown) =>
        api.sdk.threads.spawn({
          projectId: "project-1",
          environment: { type: "project-default" },
          prompt: "invalid",
          pluginMetadata,
        } as never),
      (pluginMetadata: unknown) =>
        api.sdk.threads.fork({
          sourceThreadId: "source-1",
          pluginMetadata,
        } as never),
      (set: unknown) =>
        api.sdk.threads.updatePluginMetadata({
          threadId: "thread-1",
          set,
        } as never),
    ];

    for (const operation of operations) {
      for (const invalidValue of invalidValues) {
        await expect(operation(invalidValue.value)).rejects.toMatchObject(
          invalidValue.error,
        );
      }
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forces the calling plugin identity for no-context spawn and fork attribution", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-metadata-attribution",
      serverSource: `export default function plugin() {}`,
    });
    await service.installPath(rootDir);
    service.bindSdk({ baseUrl: "https://bb.example.test" });
    const api = requireApi(service, "metadata-attribution");
    const requests: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          id: "thread-1",
          projectId: "project-1",
          title: null,
          status: "pending",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const operations = [
      (overrides: Record<string, unknown>) =>
        api.sdk.threads.spawn({
          projectId: "project-1",
          environment: { type: "project-default" },
          prompt: "compatibility",
          ...overrides,
        } as never),
      (overrides: Record<string, unknown>) =>
        api.sdk.threads.fork({
          sourceThreadId: "source-1",
          ...overrides,
        } as never),
    ];

    for (const operation of operations) {
      requests.length = 0;
      await operation({});
      expect(requests[0]).toMatchObject({
        origin: "plugin",
        originPluginId: "metadata-attribution",
      });

      await operation({
        origin: "plugin",
        originPluginId: "legacy-plugin",
      });
      expect(requests[1]).toMatchObject({
        origin: "plugin",
        originPluginId: "metadata-attribution",
      });

      await operation({ origin: "sdk" });
      expect(requests[2]).toMatchObject({
        origin: "plugin",
        originPluginId: "metadata-attribution",
      });
    }
  });

  it("uses the current thread-send transport and overwrites forged plugin attribution", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-send-owner",
      serverSource: `export default function plugin() {}`,
    });
    await service.installPath(rootDir);
    service.bindSdk({ baseUrl: "https://bb.example.test" });
    const api = requireApi(service, "send-owner");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await api.sdk.threads.send({
      threadId: "thread-1",
      input: [{ type: "text", text: "continue", mentions: [] }],
      originPluginId: "forged-plugin",
    } as never);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("https://bb.example.test/");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      originPluginId: "send-owner",
    });
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("pluginSubmission");
  });

  it.each(["disable", "reload"] as const)(
    "refuses prepared continuation admission while %s waits for old-generation disposal",
    async (action) => {
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-continuation-owner",
        serverSource: `export default function plugin() {}`,
      });
      await service.installPath(rootDir);
      const api = requireApi(service, "continuation-owner");
      const snapshot: ExperimentalRecoverySnapshot = {
        threadId: "thread", projectId: "project", revision: "revision", eventSequence: 2,
        status: "idle", providerId: "codex", hostId: "host", hostOnline: true,
        visibility: "visible", parentThreadId: null, archivedAt: null, deletedAt: null,
        pluginMetadata: {}, metadataReadable: true,
        run: { requestId: "request", requestSequence: 1, initiator: "user", provenance: "fresh-user", freshUserRequestId: "request", freshUserSequence: 1 },
        stop: null, finalAssistant: { messageId: "assistant", revision: 2, text: "I will continue next." },
        queuedMessageCount: 0, pendingInteractionCount: 0, activeBackgroundTaskCount: 0,
      };
      let releasePreparation!: () => void;
      const prepared = new Promise<void>((resolve) => { releasePreparation = resolve; });
      const appended = vi.fn();
      continueRecovery.mockImplementationOnce(async (args) => {
        await prepared;
        if (!args.admit()) return { admitted: false, reason: "policy" };
        appended();
        return { admitted: true, reason: "admitted" };
      });
      let releaseDisposal!: () => void;
      const disposeGate = new Promise<void>((resolve) => { releaseDisposal = resolve; });
      let disposing = false;
      api.onDispose(async () => {
        disposing = true;
        await disposeGate;
      });
      const admit = vi.fn(() => true);
      const pending = api.experimental_recovery.continue({ snapshot, admit });
      let disposed = false;
      const disposal = (action === "disable"
        ? service.setEnabled("continuation-owner", false)
        : service.reload("continuation-owner")).then(() => { disposed = true; });
      try {
        await vi.waitFor(() => expect(disposing).toBe(true));
        releasePreparation();
        await expect(pending).resolves.toEqual({ admitted: false, reason: "policy" });
        expect(admit).not.toHaveBeenCalled();
        expect(appended).not.toHaveBeenCalled();
        expect(disposed).toBe(false);
      } finally {
        releasePreparation();
        releaseDisposal();
        await disposal;
      }
      if (action === "reload") {
        const replacement = requireApi(service, "continuation-owner");
        expect(replacement === api).toBe(false);
        continueRecovery.mockImplementationOnce(async (args) => args.admit()
          ? { admitted: true, reason: "admitted" }
          : { admitted: false, reason: "policy" });
        await expect(replacement.experimental_recovery.continue({ snapshot, admit })).resolves.toEqual({
          admitted: true, reason: "admitted",
        });
      }
    },
  );

  it.each(["disable", "reload"] as const)(
    "cancels owned safeguard verification on %s and awaits its cleanup",
    async (action) => {
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-verifier-owner",
        serverSource: `export default function plugin() {}`,
      });
      await service.installPath(rootDir);
      const api = requireApi(service, "verifier-owner");
      let signal: AbortSignal | undefined;
      let release!: () => void;
      const cleanup = new Promise<void>((resolve) => { release = resolve; });
      verifySafeguards.mockImplementationOnce(async (args) => {
        const verificationSignal = args?.signal;
        signal = verificationSignal;
        if (!verificationSignal) throw new Error("Missing verifier cancellation signal");
        const aborted = new Promise<void>((resolve) => {
          verificationSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        await aborted;
        await cleanup;
        verificationSignal.throwIfAborted();
        throw new Error("Verifier must not return after cancellation");
      });
      const caller = new AbortController();
      let callerSettled = false;
      const pending = api.experimental_recovery.verifySafeguards({ signal: caller.signal })
        .catch((error: unknown) => error)
        .finally(() => { callerSettled = true; });
      await vi.waitFor(() => expect(signal).toBeDefined());
      vi.useFakeTimers();
      let disposed = false;
      const disposal = (action === "disable"
        ? service.setEnabled("verifier-owner", false)
        : service.reload("verifier-owner")).then(() => { disposed = true; });
      try {
        await vi.waitFor(() => expect(signal?.aborted).toBe(true));
        expect(caller.signal.aborted).toBe(false);
        expect(disposed).toBe(false);
        await vi.advanceTimersByTimeAsync(5_001);
        expect(callerSettled).toBe(false);
        expect(disposed).toBe(false);
        await expect(api.experimental_recovery.verifySafeguards()).rejects.toThrow(/stale API handle/u);
        expect(verifySafeguards).toHaveBeenCalledOnce();
      } finally {
        release();
        vi.useRealTimers();
        await disposal;
      }
      expect(await pending).toBeInstanceOf(Error);
      expect(disposed).toBe(true);
    },
  );

  it("retains failed factory verification ownership until native cleanup settles", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-verifier-failed-factory",
      serverSource: `export default function plugin(bb) {
        void bb.experimental_recovery.verifySafeguards().catch(() => {});
        throw new Error("Verifier fixture factory failed");
      }`,
    });
    let signal: AbortSignal | undefined;
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    verifySafeguards.mockImplementationOnce(async (args) => {
      const verificationSignal = args?.signal;
      signal = verificationSignal;
      if (!verificationSignal) throw new Error("Missing verifier cancellation signal");
      let onAbort!: () => void;
      const aborted = new Promise<void>((resolve) => { onAbort = resolve; });
      if (verificationSignal.aborted) onAbort();
      else verificationSignal.addEventListener("abort", () => onAbort(), { once: true });
      await aborted;
      await cleanup;
      verificationSignal.throwIfAborted();
      throw new Error("Verifier must not return after cancellation");
    });
    let settled = false;
    const installation = service.installPath(rootDir)
      .catch((error: unknown) => error)
      .finally(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(signal?.aborted).toBe(true));
      expect(settled).toBe(false);
    } finally {
      releaseCleanup();
      await installation;
    }
    expect(service.list().find((plugin) => plugin.id === "verifier-failed-factory")).toMatchObject({
      status: "error",
    });
  });

  it("preserves caller cancellation for owned safeguard verification", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-verifier-caller",
      serverSource: `export default function plugin() {}`,
    });
    await service.installPath(rootDir);
    const api = requireApi(service, "verifier-caller");
    let signal: AbortSignal | undefined;
    verifySafeguards.mockImplementationOnce(async (args) => {
      const verificationSignal = args?.signal;
      signal = verificationSignal;
      if (!verificationSignal) throw new Error("Missing verifier cancellation signal");
      const aborted = new Promise<void>((resolve) => {
        verificationSignal.addEventListener("abort", () => resolve(), { once: true });
      });
      await aborted;
      verificationSignal.throwIfAborted();
      throw new Error("Verifier must not return after cancellation");
    });
    const caller = new AbortController();
    const pending = api.experimental_recovery.verifySafeguards({ signal: caller.signal }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(signal).toBeDefined());
    const reason = new Error("Verifier caller disconnected");
    caller.abort(reason);
    expect(await pending).toBe(reason);
    expect(signal?.aborted).toBe(true);
    expect(service.getApi("verifier-caller")).toBe(api);
  });

  it.each(["disable", "reload", "caller cancellation"] as const)(
    "cancels targeted AI completion on %s without changing its target",
    async (action) => {
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-ai-owner",
        serverSource: `export default function plugin() {}`,
      });
      await service.installPath(rootDir);
      const complete = vi.fn(async (_prompt: string, options: PluginAiCompleteOptions) => {
        const aborted = new Promise<void>((resolve) => {
          options.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        await aborted;
        options.signal.throwIfAborted();
        return "Must not return after cancellation";
      });
      aiServices.register({
        id: "exact-service",
        displayName: "Exact service",
        pluginId: "provider-plugin",
        builtin: false,
        complete,
        transcribe: null,
        status: null,
      });
      const api = requireApi(service, "ai-owner");
      const caller = new AbortController();
      const input = {
        hostId: "exact-host",
        serviceId: "exact-service",
        model: "exact-model",
        reasoningEffort: "medium" as const,
        serviceTier: "fast" as const,
        prompt: "Classify this exact request",
        timeoutMs: 30_000,
        signal: caller.signal,
      };
      const pending = api.experimental_aiServices.complete(input).catch((error: unknown) => error);
      await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
      expect(complete.mock.calls[0]?.[0]).toBe(input.prompt);
      const options = complete.mock.calls[0]?.[1];
      expect(options).toMatchObject({
        experimental_hostId: input.hostId,
        experimental_model: input.model,
        experimental_reasoningEffort: input.reasoningEffort,
        experimental_serviceTier: input.serviceTier,
        experimental_timeoutMs: input.timeoutMs,
      });
      if (action === "caller cancellation") {
        caller.abort(new Error("AI caller disconnected"));
      } else {
        await (action === "disable"
          ? service.setEnabled("ai-owner", false)
          : service.reload("ai-owner"));
      }
      expect(options?.signal.aborted).toBe(true);
      expect(caller.signal.aborted).toBe(action === "caller cancellation");
      expect(await pending).toBeInstanceOf(Error);
      expect(complete).toHaveBeenCalledOnce();
    },
  );

  it("serves the current public app URL without the SDK bind gate", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-app-url",
      serverSource: `export default function plugin() {}`,
    });
    await service.installPath(rootDir);
    const api = requireApi(service, "app-url");

    expect(api.server.experimental_appUrl).toBe("https://bb.example.test");
    appUrl = null;
    expect(api.server.experimental_appUrl).toBeNull();
  });

  it("delivers shared-port declarations through the server control plane", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-shares",
      serverSource: `export default function plugin() {}`,
    });
    await service.installPath(rootDir);
    const api = requireApi(service, "shares");

    await expect(api.hosts.ensureSharedPortTunnel("host-1")).resolves.toEqual({
      label: "sawyer-air",
      baseDomain: "getbb.app",
    });
    api.hosts.declareSharedPorts("host-1", [8080, 3000]);

    expect(ensureSharedPortTunnel).toHaveBeenCalledWith("host-1");

    expect(sharedPorts.declareSharedPorts).toHaveBeenCalledWith({
      ownerId: "shares",
      hostId: "host-1",
      ports: [8080, 3000],
    });

    await service.stop();
    expect(sharedPorts.clearDeclarationsForOwner).toHaveBeenCalledWith(
      "shares",
    );
  });

  it("routes next machine tunnels through the server control plane under the plugin's id", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-next",
      serverSource: `export default function plugin() {}`,
    });
    await service.installPath(rootDir);
    const api = requireApi(service, "next");
    const config = {
      domain: "next.getbb.app",
      server: {
        protocol: "wss" as const,
        host: "tunnel.next.getbb.app",
        port: 443,
      },
    };
    api.hosts.internal_DO_NOT_USE_setNextTunnels(config);
    expect(sharedPorts.setNextTunnelConfig).toHaveBeenCalledWith(
      "next",
      config,
    );
    expect(api.hosts.internal_DO_NOT_USE_nextTunnelStatuses()).toEqual([
      {
        hostId: "host-1",
        hostName: "Sawyer Air",
        state: "connected",
        label: "sawyer-air",
        lastError: null,
        nextRetryAt: null,
        since: 1,
        shares: [],
      },
    ]);
    const listener = vi.fn();
    api.hosts.internal_DO_NOT_USE_onNextTunnelStatusChange(listener);
    expect(sharedPorts.onNextTunnelStatusChange).toHaveBeenCalledWith(listener);

    await service.stop();
    expect(nextUnsubscribe).toHaveBeenCalled();
    expect(sharedPorts.clearDeclarationsForOwner).toHaveBeenCalledWith("next");
  });

  it("binds typed host calls and ignores worker exits from stale generations", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-host-client",
      serverSource: `export default function plugin() {}`,
      hostSource: `
        const schema = { "~standard": { validate(value) { return { value }; } } };
        export default {
          experimental_apiVersion: 1,
          contract: { ping: { input: schema, output: schema } },
          experimental_signals: { changed: { payload: schema } },
          handlers: { ping: (input) => input },
        };
      `,
    });
    await service.installPath(rootDir);
    const api = requireApi(service, "host-client");
    const contract = defineRpcContract({
      ping: {
        input: z.object({ value: z.string() }).strict(),
        output: z.object({ pong: z.boolean() }).strict(),
      },
    });
    const experimental_signals = {
      changed: {
        payload: z.object({ sequence: z.number().int() }).strict(),
      },
    };
    const client = api.hosts.experimental_client({
      contract,
      experimental_signals,
    });

    await expect(
      client.call("ping", { value: "hello" }, { hostId: "host-1" }),
    ).resolves.toEqual({ pong: true });
    expect(callPluginHost).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "host-client",
        method: "ping",
        input: { value: "hello" },
        hostId: "host-1",
        artifact: expect.objectContaining({
          digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
          byteLength: expect.any(Number),
          generation: expect.any(String),
        }),
      }),
    );

    const workerExitHandler = vi.fn();
    const signalHandler = vi.fn();
    client.experimental_onWorkerExit(workerExitHandler);
    client.experimental_onSignal("changed", signalHandler);
    const artifact = callPluginHost.mock.calls[0]?.[0].artifact;
    if (artifact === undefined) throw new Error("missing host artifact call");
    const servedArtifact = pluginHostArtifacts.get("host-client");
    if (servedArtifact === undefined)
      throw new Error("missing served artifact");
    expect(servedArtifact.digest).toBe(artifact.digest);
    expect(servedArtifact.byteLength).toBe(artifact.byteLength);
    expect(
      createHash("sha256")
        .update(await readFile(servedArtifact.path))
        .digest("hex"),
    ).toBe(artifact.digest);
    service.handleHostWorkerExit({
      authenticatedHostId: "host-1",
      pluginId: "host-client",
      generation: "stale-generation",
    });
    service.handleHostSignal({
      authenticatedHostId: "host-1",
      pluginId: "host-client",
      generation: "stale-generation",
      signal: "changed",
      payload: { sequence: 1 },
    });
    service.handleHostSignal({
      authenticatedHostId: "host-1",
      pluginId: "host-client",
      generation: artifact.generation,
      signal: "changed",
      payload: { sequence: 2 },
    });
    service.handleHostWorkerExit({
      authenticatedHostId: "host-1",
      pluginId: "host-client",
      generation: artifact.generation,
    });
    await vi.waitFor(() => expect(workerExitHandler).toHaveBeenCalledOnce());
    expect(workerExitHandler).toHaveBeenCalledWith({ hostId: "host-1" });
    await vi.waitFor(() => expect(signalHandler).toHaveBeenCalledOnce());
    expect(signalHandler).toHaveBeenCalledWith({
      hostId: "host-1",
      payload: { sequence: 2 },
    });
    expect(service.listHostArtifactGenerations()).toEqual([
      { pluginId: "host-client", generation: artifact.generation },
    ]);
  });

  it("rejects host calls during candidate factory registration", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-eager-host-client",
      serverSource: `
        import { defineRpcContract } from "@get-bb/plugin-sdk";
        const schema = { "~standard": { validate(value: unknown) { return { value }; } } };
        const contract = defineRpcContract({ ping: { input: schema, output: schema } });
        export default async function plugin(bb: any) {
          await bb.hosts.experimental_client({ contract }).call(
            "ping",
            {},
            { hostId: "host-1" },
          );
        }
      `,
      hostSource: `
        const schema = { "~standard": { validate(value) { return { value }; } } };
        export default {
          experimental_apiVersion: 1,
          contract: { ping: { input: schema, output: schema } },
          handlers: { ping: (input) => input },
        };
      `,
    });

    const entry = await service.installPath(rootDir);
    expect(entry.status).toBe("error");
    expect(entry.statusDetail).toContain(
      "host plugin calls are unavailable during factory registration",
    );
    expect(callPluginHost).not.toHaveBeenCalled();
  });

  it("does not publish candidate host declarations when reload fails", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-atomic-shares",
      serverSource: `
        export default function plugin(bb: any) {
          bb.hosts.declareSharedPorts("host-1", [3000]);
        }
      `,
    });
    await service.installPath(rootDir);
    const previousApi = requireApi(service, "atomic-shares");
    expect(sharedPorts.replaceDeclarationsForOwner).toHaveBeenCalledWith(
      "atomic-shares",
      [{ hostId: "host-1", ports: [3000] }],
    );
    sharedPorts.replaceDeclarationsForOwner.mockClear();

    await writeFile(
      join(rootDir, "server.ts"),
      `
        export default function plugin(bb: any) {
          bb.hosts.declareSharedPorts("host-1", [4000]);
          throw new Error("candidate failed");
        }
      `,
    );
    await service.reload("atomic-shares");

    expect(service.getApi("atomic-shares")).toBe(previousApi);
    expect(sharedPorts.replaceDeclarationsForOwner).not.toHaveBeenCalled();
  });
});

describe("plugin bb.sdk against a running server", () => {
  it("returns the server-side Standard Schema output after the host JSON wire", async () => {
    const server = await startTestServer();
    const workDir = await mkdtemp(join(tmpdir(), "bb-plugin-host-transform-"));
    try {
      const { host } = seedHostSession(server.deps, {
        id: "host-plugin-transform",
      });
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-host-transform",
        serverSource: `export default function plugin() {}`,
        hostSource: `
          const schema = { "~standard": { validate(value) { return { value }; } } };
          export default {
            experimental_apiVersion: 1,
            contract: { parseDate: { input: schema, output: schema } },
            handlers: { parseDate: (input) => input },
          };
        `,
      });
      await server.pluginService.installPath(rootDir);
      const inputDate = z.string().transform((value) => new Date(value));
      const outputDate = z.string().transform((value) => new Date(value));
      const contract = defineRpcContract({
        parseDate: {
          input: z.object({ when: inputDate }).strict(),
          output: outputDate,
        },
      });
      const client = requireApi(
        server.pluginService,
        "host-transform",
      ).hosts.experimental_client({ contract });
      const iso = "2026-08-16T12:34:56.000Z";

      const resultPromise = client.call(
        "parseDate",
        { when: iso },
        { hostId: host.id },
      );
      const command = await waitForQueuedCommand(
        server,
        ({ command }) =>
          command.type === "plugin.host.call" &&
          command.pluginId === "host-transform" &&
          command.method === "parseDate",
      );
      expect(command.command).toMatchObject({
        input: { when: iso },
        timeoutMs: 30_000,
      });
      expect(command.command).not.toHaveProperty("deadlineUnixMs");
      await reportQueuedCommandSuccess(server, command, { output: iso });

      await expect(resultPromise).resolves.toEqual(new Date(iso));
    } finally {
      await server.pluginService.stop();
      await rm(workDir, { recursive: true, force: true });
      await server.close();
    }
  });

  it("covers live plugin metadata routes, namespace validation, and lifecycle guards", async () => {
    const server = await startTestServer();
    const workDir = await mkdtemp(join(tmpdir(), "bb-plugin-metadata-live-"));
    try {
      const { host } = seedHostSession(server.deps);
      seedPrimaryHost(server.deps, host.id);
      const { project } = seedProjectWithSource(server.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(server.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      server.pluginService.bindSdk({ baseUrl: server.baseUrl });
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-meta-owner",
        serverSource: `export default function plugin() {}`,
      });
      await server.pluginService.installPath(rootDir);
      const api = requireApi(server.pluginService, "meta-owner");
      const thread = createThread(server.db, server.deps.hub, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "idle",
        originPluginId: "meta-owner",
      });
      await expect(
        api.sdk.threads.getPluginMetadata({ threadId: thread.id }),
      ).resolves.toEqual({});
      await expect(
        api.sdk.threads.updatePluginMetadata({
          threadId: thread.id,
          set: { a: 1, nested: { old: true } },
        }),
      ).resolves.toEqual({ a: 1, nested: { old: true } });
      await expect(
        api.sdk.threads.getPluginMetadata({
          threadId: thread.id,
          pluginId: "cross",
        }),
      ).resolves.toEqual({});
      await expect(
        api.sdk.threads.updatePluginMetadata({
          threadId: thread.id,
          pluginId: "cross",
          set: { b: 2 },
        }),
      ).resolves.toEqual({ b: 2 });
      await expect(
        api.sdk.threads.getPluginMetadata({ threadId: thread.id }),
      ).resolves.toEqual({ a: 1, nested: { old: true } });
      await expect(
        api.sdk.threads.experimental_listPluginMetadata({
          threadIds: [thread.id],
        }),
      ).resolves.toEqual({
        threads: [
          { threadId: thread.id, metadata: { a: 1, nested: { old: true } } },
        ],
      });
      await expect(
        api.sdk.threads.experimental_listPluginMetadata({
          threadIds: [thread.id],
          pluginId: "cross",
        }),
      ).resolves.toEqual({
        threads: [{ threadId: thread.id, metadata: { b: 2 } }],
      });
      await expect(
        api.sdk.threads.getPluginMetadata({
          threadId: thread.id,
          pluginId: "cross",
        }),
      ).resolves.toEqual({ b: 2 });
      await expect(
        api.sdk.threads.updatePluginMetadata({
          threadId: thread.id,
          set: { nested: { next: true } },
          remove: ["a"],
        }),
      ).resolves.toEqual({ nested: { next: true } });
      await expect(
        api.sdk.threads.updatePluginMetadata({
          threadId: thread.id,
          set: { nullable: null },
        }),
      ).resolves.toEqual({ nested: { next: true }, nullable: null });
      await expect(
        api.sdk.threads.updatePluginMetadata({ threadId: thread.id }),
      ).resolves.toEqual({ nested: { next: true }, nullable: null });
      await expect(
        api.sdk.threads.updatePluginMetadata({
          threadId: thread.id,
          remove: ["nested", "nullable"],
        }),
      ).resolves.toEqual({});
      await expect(
        api.sdk.threads.updatePluginMetadata({
          threadId: thread.id,
          set: { toJSON: "data", nested: { toJSON: 1 } },
        }),
      ).resolves.toEqual({ toJSON: "data", nested: { toJSON: 1 } });
      await expect(
        api.sdk.threads.getPluginMetadata({ threadId: thread.id }),
      ).resolves.toEqual({ toJSON: "data", nested: { toJSON: 1 } });
      await expect(
        api.sdk.threads.updatePluginMetadata({
          threadId: thread.id,
          remove: ["toJSON", "nested"],
        }),
      ).resolves.toEqual({});
      await expect(
        api.sdk.threads.updatePluginMetadata({
          threadId: thread.id,
          set: { x: 1 },
          remove: ["x"],
        }),
      ).rejects.toMatchObject({
        name: "BbHttpError",
        status: 400,
        code: "invalid_request",
        message: expect.stringContaining("set and remove overlap"),
      });
      for (const status of ["active", "stopping"] as const) {
        const candidate = createThread(server.db, server.deps.hub, {
          projectId: project.id,
          environmentId: environment.id,
          providerId: "codex",
          status,
          originPluginId: "meta-owner",
        });
        await expect(
          api.sdk.threads.updatePluginMetadata({
            threadId: candidate.id,
            set: { status },
          }),
        ).resolves.toEqual({ status });
      }
      const archived = createThread(server.db, server.deps.hub, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "idle",
        originPluginId: "meta-owner",
      });
      archiveThread(server.db, server.deps.hub, archived.id);
      await expect(
        api.sdk.threads.updatePluginMetadata({
          threadId: archived.id,
          set: { status: "archived" },
        }),
      ).resolves.toEqual({ status: "archived" });
    } finally {
      await server.pluginService.stop();
      await rm(workDir, { recursive: true, force: true });
      await server.close();
    }
  });

  it("fans out frozen metadata without restarting an active turn", async () => {
    const server = await startTestServer();
    const workDir = await mkdtemp(
      join(tmpdir(), "bb-plugin-metadata-configure-"),
    );
    const observationGlobal = globalThis as typeof globalThis & {
      __bbMetadataSeen?: Record<string, unknown>[];
    };
    const takeObservations = () => {
      const observations = observationGlobal.__bbMetadataSeen ?? [];
      delete observationGlobal.__bbMetadataSeen;
      return observations;
    };
    try {
      const { host } = seedHostSession(server.deps);
      const { project } = seedProjectWithSource(server.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(server.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      server.pluginService.bindSdk({ baseUrl: server.baseUrl });
      const thread = createThread(server.db, server.deps.hub, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "active",
      });
      const context = agentConfigurationContext(thread.id);
      const make = (name: string) =>
        writePlugin(workDir, {
          name: `bb-plugin-${name}`,
          serverSource: `
            function deepFrozen(value) {
              return value === null || typeof value !== "object" || (Object.isFrozen(value) && Object.values(value).every(deepFrozen));
            }
            export default function plugin(bb) {
              bb.agents.configure((context) => {
                globalThis.__bbMetadataSeen = globalThis.__bbMetadataSeen || [];
                globalThis.__bbMetadataSeen.push({ plugin: "${name}", metadata: context.pluginMetadata, deepFrozen: deepFrozen(context.pluginMetadata) });
                return { tools: [], skills: [] };
              });
            }
          `,
        });
      await server.pluginService.installPath(await make("alpha"));
      await server.pluginService.installPath(await make("beta"));
      await server.pluginService.installPath(await make("gamma"));
      await server.pluginService.installPath(
        await writePlugin(workDir, {
          name: "bb-plugin-delta",
          serverSource: `export default function plugin() {}`,
        }),
      );
      const alphaMetadata = {
        alpha: {
          own: true,
          levels: { deeper: { items: [{ leaf: "value" }, ["nested"]] } },
        },
      };
      insertThreadPluginMetadata(server.db, {
        threadId: thread.id,
        pluginId: "alpha",
        metadata: alphaMetadata,
      });
      insertThreadPluginMetadata(server.db, {
        threadId: thread.id,
        pluginId: "beta",
        metadata: { beta: { own: true } },
      });
      const result = await server.pluginService.resolveAgentConfiguration({
        context,
        skillIdsByPlugin: new Map(),
      });
      expect(result.tools).toEqual([]);
      const seen = takeObservations();
      expect(seen).toEqual([
        { plugin: "alpha", metadata: alphaMetadata, deepFrozen: true },
        {
          plugin: "beta",
          metadata: { beta: { own: true } },
          deepFrozen: true,
        },
        { plugin: "gamma", metadata: {}, deepFrozen: true },
      ]);
      const activeTurnSnapshot = seen[0]?.metadata;

      const alphaApi = requireApi(server.pluginService, "alpha");
      await expect(
        alphaApi.sdk.threads.updatePluginMetadata({
          threadId: thread.id,
          set: { alpha: { own: false }, updated: true },
        }),
      ).resolves.toEqual({ alpha: { own: false }, updated: true });
      expect(observationGlobal.__bbMetadataSeen).toBeUndefined();
      expect(getThread(server.db, thread.id)?.status).toBe("active");
      expect(activeTurnSnapshot).toEqual(alphaMetadata);

      await server.pluginService.resolveAgentConfiguration({
        context,
        skillIdsByPlugin: new Map(),
      });
      expect(takeObservations()).toEqual(
        expect.arrayContaining([
          {
            plugin: "alpha",
            metadata: { alpha: { own: false }, updated: true },
            deepFrozen: true,
          },
        ]),
      );

      const secretMarker = "sk-live-SECRET-token-value";
      const writeCorruptRow = server.db.$client.prepare(
        "INSERT INTO thread_plugin_metadata (thread_id, plugin_id, metadata_json) VALUES (?, ?, ?) ON CONFLICT (thread_id, plugin_id) DO UPDATE SET metadata_json = excluded.metadata_json",
      );
      for (const pluginId of ["alpha", "delta", "not-loaded"]) {
        writeCorruptRow.run(thread.id, pluginId, secretMarker);
      }
      const warn = vi.spyOn(server.deps.logger, "warn");
      try {
        const afterCorruption =
          await server.pluginService.resolveAgentConfiguration({
            context,
            skillIdsByPlugin: new Map(),
          });
        expect(afterCorruption).toEqual(result);
        expect(takeObservations()).toEqual([
          { plugin: "alpha", metadata: {}, deepFrozen: true },
          {
            plugin: "beta",
            metadata: { beta: { own: true } },
            deepFrozen: true,
          },
          { plugin: "gamma", metadata: {}, deepFrozen: true },
        ]);
        expect(warn.mock.calls).toEqual([
          [
            `Ignoring corrupt plugin metadata for thread ${thread.id}, plugin alpha`,
          ],
        ]);
        expect(JSON.stringify(warn.mock.calls)).not.toContain("sk-live");
      } finally {
        warn.mockRestore();
      }

      await expect(
        alphaApi.sdk.threads.getPluginMetadata({ threadId: thread.id }),
      ).resolves.toEqual({});
      await expect(
        alphaApi.sdk.threads.updatePluginMetadata({
          threadId: thread.id,
          set: { repaired: true },
        }),
      ).resolves.toEqual({ repaired: true });
    } finally {
      delete observationGlobal.__bbMetadataSeen;
      await server.pluginService.stop();
      await rm(workDir, { recursive: true, force: true });
      await server.close();
    }
  });

  it("defers a configure provider registered during a pass to the next pass with its stored metadata", async () => {
    const server = await startTestServer();
    const workDir = await mkdtemp(
      join(tmpdir(), "bb-plugin-metadata-late-configure-"),
    );
    const lateGlobal = globalThis as typeof globalThis & {
      __bbLateConfigureSeen?: unknown[];
      __bbRegisterLateConfigure?: () => void;
    };
    try {
      const { host } = seedHostSession(server.deps);
      const { project } = seedProjectWithSource(server.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(server.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = createThread(server.db, server.deps.hub, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "idle",
      });
      await server.pluginService.installPath(
        await writePlugin(workDir, {
          name: "bb-plugin-aaa-trigger",
          serverSource: `
            export default function plugin(bb) {
              bb.agents.configure(() => {
                Promise.resolve().then(() => globalThis.__bbRegisterLateConfigure?.());
                return { tools: [], skills: [] };
              });
            }
          `,
        }),
      );
      await server.pluginService.installPath(
        await writePlugin(workDir, {
          name: "bb-plugin-bbb-late",
          serverSource: `
            export default function plugin(bb) {
              globalThis.__bbRegisterLateConfigure = () => {
                delete globalThis.__bbRegisterLateConfigure;
                bb.agents.configure((context) => {
                  globalThis.__bbLateConfigureSeen = globalThis.__bbLateConfigureSeen || [];
                  globalThis.__bbLateConfigureSeen.push(context.pluginMetadata);
                  return { tools: [], skills: [] };
                });
              };
            }
          `,
        }),
      );
      insertThreadPluginMetadata(server.db, {
        threadId: thread.id,
        pluginId: "bbb-late",
        metadata: { own: true },
      });
      const context = agentConfigurationContext(thread.id);

      await server.pluginService.resolveAgentConfiguration({
        context,
        skillIdsByPlugin: new Map(),
      });
      expect(lateGlobal.__bbRegisterLateConfigure).toBeUndefined();
      expect(lateGlobal.__bbLateConfigureSeen).toBeUndefined();

      await server.pluginService.resolveAgentConfiguration({
        context,
        skillIdsByPlugin: new Map(),
      });
      expect(lateGlobal.__bbLateConfigureSeen).toEqual([{ own: true }]);
    } finally {
      delete lateGlobal.__bbLateConfigureSeen;
      delete lateGlobal.__bbRegisterLateConfigure;
      await server.pluginService.stop();
      await rm(workDir, { recursive: true, force: true });
      await server.close();
    }
  });

  it("tells rpc handlers which plugin called them and treats every other caller as a client", async () => {
    const server = await startTestServer();
    const workDir = await mkdtemp(join(tmpdir(), "bb-plugin-rpc-caller-"));
    try {
      server.pluginService.bindSdk({ baseUrl: server.baseUrl });
      for (const name of ["callee", "caller"]) {
        const rootDir = await writePlugin(workDir, {
          name: `bb-plugin-${name}`,
          serverSource: `export default function plugin() {}`,
        });
        expect((await server.pluginService.installPath(rootDir)).status).toBe(
          "running",
        );
      }
      const callerSchema = z.union([
        z.object({ kind: z.literal("plugin"), pluginId: z.string() }),
        z.object({ kind: z.literal("client") }),
      ]);
      const whoami = vi.fn(
        (
          _input: null,
          context: { experimental_caller: z.infer<typeof callerSchema> },
        ) => context.experimental_caller,
      );
      requireApi(server.pluginService, "callee").rpc.register(
        defineRpcContract({
          whoami: { input: z.null(), output: callerSchema },
        }),
        { whoami },
      );
      const callerSdk = requireApi(server.pluginService, "caller").sdk;
      const callWhoami = () =>
        callerSdk.plugins.callRpc({
          pluginId: "callee",
          method: "whoami",
          input: null,
          outputSchema: callerSchema,
        });

      await expect(callWhoami()).resolves.toEqual({
        kind: "plugin",
        pluginId: "caller",
      });

      const cli = await fetch(
        `${server.baseUrl}/api/v1/plugins/callee/rpc/whoami`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "null",
        },
      );
      expect(await cli.json()).toEqual({
        ok: true,
        result: { kind: "client" },
      });

      const callsBeforeSpoof = whoami.mock.calls.length;
      const spoofed = await fetch(
        `${server.baseUrl}/api/v1/plugins/callee/rpc/whoami`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bb-plugin-caller": "not-a-real-token",
          },
          body: "null",
        },
      );
      expect(spoofed.status).toBe(403);
      expect(whoami.mock.calls.length).toBe(callsBeforeSpoof);

      await server.pluginService.reload("caller");
      await expect(callWhoami()).rejects.toMatchObject({ status: 403 });
      await expect(
        requireApi(server.pluginService, "caller").sdk.plugins.callRpc({
          pluginId: "callee",
          method: "whoami",
          input: null,
          outputSchema: callerSchema,
        }),
      ).resolves.toEqual({ kind: "plugin", pluginId: "caller" });
      expect(whoami.mock.calls.length).toBe(callsBeforeSpoof + 1);
    } finally {
      await server.pluginService.stop();
      await rm(workDir, { recursive: true, force: true });
      await server.close();
    }
  });

  it("keeps hidden plugin threads attributed and directly operable by id", async () => {
    const server = await startTestServer();
    const workDir = await mkdtemp(join(tmpdir(), "bb-plugin-sdk-live-"));
    try {
      const { host } = seedHostSession(server.deps);
      seedPrimaryHost(server.deps, host.id);
      const { project } = seedProjectWithSource(server.deps, {
        hostId: host.id,
        path: "/tmp/plugin-sdk-live-source",
      });
      const environment = seedEnvironment(server.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/plugin-sdk-live-source",
      });

      server.pluginService.bindSdk({ baseUrl: server.baseUrl });
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-spawner",
        serverSource: `export default function plugin() {}`,
      });
      const entry = await server.pluginService.installPath(rootDir);
      expect(entry.status).toBe("running");
      const api = requireApi(server.pluginService, "spawner");

      const projects = await api.sdk.projects.list();
      expect(projects.map((p) => p.id)).toContain(project.id);
      expect(projects.map((p) => p.id)).not.toContain(PERSONAL_PROJECT_ID);
      const projectsWithoutPersonal = await api.sdk.projects.list({
        includePersonal: false,
      });
      expect(projectsWithoutPersonal.map((p) => p.id)).toEqual([project.id]);

      const projectsWithPersonal = await api.sdk.projects.list({
        includePersonal: true,
      });
      expect(projectsWithPersonal.map((p) => p.id)).toEqual([
        PERSONAL_PROJECT_ID,
        project.id,
      ]);
      expect(
        await api.sdk.projects.get({ projectId: PERSONAL_PROJECT_ID }),
      ).toEqual(projectsWithPersonal[0]);
      const projectsWithThreadsAndPersonal = await api.sdk.projects.list({
        include: "threads",
        includePersonal: true,
      });
      expect(projectsWithThreadsAndPersonal.map((p) => p.id)).toEqual([
        PERSONAL_PROJECT_ID,
        project.id,
      ]);
      expect(projectsWithThreadsAndPersonal).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: PERSONAL_PROJECT_ID, threads: [] }),
          expect.objectContaining({ id: project.id, threads: [] }),
        ]),
      );

      const launchMarker = "plugin-metadata-private-marker";
      const thread = await api.sdk.threads.spawn({
        projectId: project.id,
        prompt: "spawned from a plugin",
        environment: {
          type: "host",
          hostId: host.id,
          workspace: { type: "unmanaged", path: "/tmp/plugin-sdk-live-source" },
        },
        origin: "sdk",
        originPluginId: "forged-plugin",
        pluginMetadata: {
          marker: launchMarker,
          nested: { attempt: 1 },
        },
        visibility: "hidden",
      });
      expect(thread.originPluginId).toBe("spawner");
      expect(thread.visibility).toBe("hidden");
      expect(thread).not.toHaveProperty("pluginMetadata");
      expect(getThread(server.db, thread.id)).toMatchObject({
        originPluginId: "spawner",
        visibility: "hidden",
      });
      await expect(
        api.sdk.threads.getPluginMetadata({ threadId: thread.id }),
      ).resolves.toEqual({ marker: launchMarker, nested: { attempt: 1 } });
      const pluginThread = await api.sdk.threads.get({ threadId: thread.id });
      expect(pluginThread).toMatchObject({
        id: thread.id,
        visibility: "hidden",
      });
      expect(JSON.stringify(pluginThread)).not.toContain(launchMarker);
      await expect(
        api.sdk.threads.wait({
          threadId: thread.id,
          status: "starting",
          timeoutMs: 100,
        }),
      ).resolves.toMatchObject({ matched: true, threadId: thread.id });
      await expect(
        api.sdk.threads.list({ projectId: project.id }),
      ).resolves.not.toContainEqual(expect.objectContaining({ id: thread.id }));
      const allThreads = await api.sdk.threads.list({
        projectId: project.id,
        includeHidden: true,
      });
      expect(allThreads).toContainEqual(
        expect.objectContaining({ id: thread.id }),
      );
      expect(JSON.stringify(allThreads)).not.toContain(launchMarker);

      const operable = createThread(server.db, server.deps.hub, {
        environmentId: environment.id,
        originPluginId: "spawner",
        pluginMetadata: {
          pluginId: "spawner",
          metadata: { marker: "source-plugin-metadata" },
        },
        projectId: project.id,
        providerId: "codex",
        status: "idle",
        visibility: "hidden",
      });
      seedThreadRuntimeState(server.deps, {
        environmentId: environment.id,
        inputText: "Initial turn",
        providerThreadId: "provider-hidden-plugin-thread",
        threadId: operable.id,
      });
      const forkMarker = "plugin-fork-context-private-marker";
      const fork = await api.sdk.threads.fork({
        sourceThreadId: operable.id,
        origin: "sdk",
        originPluginId: "forged-plugin",
        pluginMetadata: { marker: forkMarker, nested: { attempt: 2 } },
      });
      expect(fork).toMatchObject({
        originKind: "fork",
        originPluginId: "spawner",
        sourceThreadId: operable.id,
      });
      expect(fork).not.toHaveProperty("pluginMetadata");
      await expect(
        api.sdk.threads.getPluginMetadata({ threadId: fork.id }),
      ).resolves.toEqual({ marker: forkMarker, nested: { attempt: 2 } });
      const forkWithoutContext = await api.sdk.threads.fork({
        sourceThreadId: operable.id,
      });
      await expect(
        api.sdk.threads.getPluginMetadata({ threadId: forkWithoutContext.id }),
      ).resolves.toEqual({});
      await expect(
        api.sdk.threads.wait({
          threadId: operable.id,
          status: "idle",
          timeoutMs: 100,
        }),
      ).resolves.toMatchObject({ matched: true });
      await expect(
        api.sdk.threads.send({
          threadId: operable.id,
          mode: "auto",
          input: [{ type: "text", text: "Continue", mentions: [] }],
        }),
      ).resolves.toEqual({ ok: true, delivery: "sent" });
      const stopPromise = api.sdk.threads.stop({ threadId: operable.id });
      const stop = await waitForQueuedCommand(
        server,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === operable.id,
      );
      await reportQueuedCommandSuccess(server, stop, {
        providerCheckpointId: null,
      });
      await expect(stopPromise).resolves.toEqual({ ok: true });
    } finally {
      await server.pluginService.stop();
      await rm(workDir, { recursive: true, force: true });
      await server.close();
    }
  });
});
