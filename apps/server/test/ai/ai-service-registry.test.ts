import { describe, expect, it, vi } from "vitest";
import {
  createAiServiceRegistry,
  completeRegisteredAiService,
  type AiServiceRegistration,
} from "../../src/services/ai/ai-service-registry.js";

const ACME = { pluginId: "acme-plugin", serviceId: "acme" };

function service(
  status: AiServiceRegistration["status"],
  id = "acme",
  pluginId = "acme-plugin",
): AiServiceRegistration {
  return {
    id,
    displayName: "Acme",
    pluginId,
    builtin: false,
    complete: async () => "reply",
    transcribe: null,
    status,
  };
}

describe("AI service registry", () => {
  it("caches status for ten seconds and refreshes after", async () => {
    let clock = 1_000;
    const status = vi.fn(async () => ({ ready: true as const }));
    const registry = createAiServiceRegistry({ now: () => clock });
    registry.register(service(status));

    expect(registry.peekStatus(ACME)).toBeNull();
    await expect(registry.status(ACME)).resolves.toEqual({ ready: true });
    await registry.status(ACME);
    expect(status).toHaveBeenCalledTimes(1);

    clock += 10_001;
    await registry.status(ACME);
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("keeps services with the same id from different plugins apart", async () => {
    const registry = createAiServiceRegistry();
    registry.register(service(null));
    registry.register(
      service(
        async () => ({ ready: false, message: "Other plugin" }),
        "acme",
        "other-plugin",
      ),
    );

    expect(registry.list().map((entry) => entry.pluginId)).toEqual([
      "acme-plugin",
      "other-plugin",
    ]);
    expect(registry.get(ACME)?.pluginId).toBe("acme-plugin");
    await expect(registry.status(ACME)).resolves.toEqual({ ready: true });
    await expect(
      registry.status({ pluginId: "other-plugin", serviceId: "acme" }),
    ).resolves.toEqual({ ready: false, message: "Other plugin" });
    expect(() => registry.register(service(null))).toThrow(
      'AI service "acme" is already registered by this plugin.',
    );
  });

  it("reports a throwing or invalid status as not ready", async () => {
    const registry = createAiServiceRegistry();
    registry.register(
      service(async () => {
        throw new Error("Sign in first");
      }),
    );
    registry.register(
      service(
        // @ts-expect-error — plugin code is untyped at runtime.
        async () => ({ ready: "yes" }),
        "broken",
      ),
    );

    await expect(registry.status(ACME)).resolves.toEqual({
      ready: false,
      message: "Sign in first",
    });
    await expect(
      registry.status({ pluginId: "acme-plugin", serviceId: "broken" }),
    ).resolves.toEqual({
      ready: false,
      message: "Reported an invalid status",
    });
  });

  it("notifies when readiness changes and when services come and go", async () => {
    const onStatusChange = vi.fn();
    let ready = false;
    let clock = 0;
    const registry = createAiServiceRegistry({
      onStatusChange,
      now: () => clock,
    });
    const registration = registry.register(
      service(async () =>
        ready ? { ready: true } : { ready: false, message: "Signed out" },
      ),
    );
    expect(onStatusChange).toHaveBeenCalledTimes(1);

    await registry.status(ACME);
    expect(onStatusChange).toHaveBeenCalledTimes(2);
    clock += 20_000;
    await registry.status(ACME);
    expect(onStatusChange).toHaveBeenCalledTimes(2);

    ready = true;
    clock += 20_000;
    await registry.status(ACME);
    expect(onStatusChange).toHaveBeenCalledTimes(3);

    registration.dispose();
    expect(onStatusChange).toHaveBeenCalledTimes(4);
    expect(registry.get(ACME)).toBeNull();
  });
});

describe("targeted registered inference", () => {
  const input = {
    hostId: "host-cassidy",
    serviceId: "codex",
    model: "gpt-5.4",
    reasoningEffort: "medium" as const,
    serviceTier: "fast" as const,
    prompt: "Classify this final message",
    timeoutMs: 30_000,
  };

  it("forwards exact settings to the registered owner and returns only reported usage", async () => {
    const registry = createAiServiceRegistry();
    const complete: NonNullable<AiServiceRegistration["complete"]> = vi.fn(async (_prompt, options) => {
      options.experimental_reportResult?.({ usage: { inputTokens: 13, cachedInputTokens: 8 }, serviceTier: "default" });
      return "{\"unfinished\":true}";
    });
    registry.register({ ...service(null, "codex", "provider-codex"), complete });
    expect(await completeRegisteredAiService(registry, input)).toEqual({
      text: "{\"unfinished\":true}", usage: { inputTokens: 13, cachedInputTokens: 8 }, serviceTier: "default",
    });
    expect(complete).toHaveBeenCalledWith(input.prompt, expect.objectContaining({
      experimental_hostId: input.hostId, experimental_model: input.model,
      experimental_reasoningEffort: "medium", experimental_serviceTier: "fast",
      experimental_timeoutMs: 30_000, signal: expect.any(AbortSignal),
    }));
  });

  it("rejects missing or ambiguous service owners instead of choosing a fallback", async () => {
    const registry = createAiServiceRegistry();
    await expect(completeRegisteredAiService(registry, input)).rejects.toThrow("not registered");
    registry.register(service(null, "codex", "first-provider"));
    registry.register(service(null, "codex", "second-provider"));
    await expect(completeRegisteredAiService(registry, input)).rejects.toThrow("ambiguous");
  });

  it("leaves missing usage and service tier absent", async () => {
    const registry = createAiServiceRegistry();
    registry.register(service(null, "codex", "provider-codex"));
    expect(await completeRegisteredAiService(registry, input)).toEqual({ text: "reply" });
  });

  it("rejects cancellation even when the registered callback ignores its signal", async () => {
    const registry = createAiServiceRegistry();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    registry.register({ ...service(null, "codex", "provider-codex"), complete: async () => {
      entered();
      return new Promise<string>(() => {});
    } });
    const controller = new AbortController();
    const pending = completeRegisteredAiService(registry, { ...input, signal: controller.signal });
    await ready;
    controller.abort(new Error("classification cancelled"));
    await expect(pending).rejects.toThrow("classification cancelled");
  });
});
