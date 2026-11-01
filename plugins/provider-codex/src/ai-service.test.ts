import {
  createFakePluginHost,
  type ExperimentalFakeHostRpcCall,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { registerCodexAiService } from "./ai-service.js";
import type {
  CodexAiCompleteResult,
  CodexAiTextResult,
} from "./ai/host-contract.js";

function setup(
  answer: (
    call: ExperimentalFakeHostRpcCall,
  ) => CodexAiCompleteResult | CodexAiTextResult,
  primaryHostId: string | null = "host-1",
) {
  const { bb, harness } = createFakePluginHost({
    sdk: { system: { config: async () => ({ primaryHostId }) } },
    experimental_callHostRpc: answer,
  });
  registerCodexAiService(bb);
  const [service] = harness.registrations.aiServiceRegistrations;
  if (service?.complete === undefined || service.transcribe === undefined) {
    throw new Error("Codex did not register a complete and transcribe service");
  }
  return {
    complete: service.complete,
    transcribe: service.transcribe,
    calls: harness.inspection.experimental_hostRpcCalls,
  };
}

function modelOf(call: ExperimentalFakeHostRpcCall): unknown {
  return (call.input as { model?: unknown }).model;
}

describe("Codex AI service", () => {
  it("retries with GPT-5.6 Luna after a rate limit", async () => {
    const codex = setup((call) =>
      modelOf(call) === "gpt-6-luna"
        ? { ok: false, code: "rate_limited", message: "Slow down" }
        : { ok: true, text: "Fix login bug" },
    );
    const signal = new AbortController().signal;

    await expect(codex.complete("Write a title", { signal })).resolves.toBe(
      "Fix login bug",
    );
    expect(codex.calls.map(modelOf)).toEqual(["gpt-6-luna", "gpt-5.6-luna"]);
    expect(codex.calls.map((call) => call.input)).toEqual([
      { model: "gpt-6-luna", prompt: "Write a title", timeoutMs: 5_000 },
      { model: "gpt-5.6-luna", prompt: "Write a title", timeoutMs: 5_000 },
    ]);
    expect(codex.calls.every((call) => call.signal === signal)).toBe(true);
  });

  it("stops at a failure another model cannot fix", async () => {
    const codex = setup(() => ({
      ok: false,
      code: "auth_required",
      message: "Run codex login",
    }));

    await expect(
      codex.complete("Write a title", {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Run codex login");
    expect(codex.calls).toHaveLength(1);
  });

  it("does not try the next model once bb has cancelled", async () => {
    const controller = new AbortController();
    const codex = setup(() => {
      controller.abort();
      return { ok: false, code: "service_unavailable", message: "Overloaded" };
    });

    await expect(
      codex.complete("Write a title", { signal: controller.signal }),
    ).rejects.toThrow("Overloaded");
    expect(codex.calls).toHaveLength(1);
  });

  it("forwards an explicit host, model, reasoning, tier and deadline without requiring a primary host", async () => {
    const usage = {
      inputTokens: 120,
      outputTokens: 35,
      totalTokens: 155,
      cachedInputTokens: 40,
      reasoningOutputTokens: 20,
    };
    const codex = setup(
      () => ({
        ok: true,
        text: '{"label":"needs_human"}',
        usage,
        serviceTier: "default",
      }),
      null,
    );
    const reportResult = vi.fn();
    const signal = new AbortController().signal;
    await expect(
      codex.complete("Classify a labelled synthetic case", {
        signal,
        experimental_hostId: "cassidy-host",
        experimental_model: "gpt-6-luna",
        experimental_reasoningEffort: "medium",
        experimental_serviceTier: "fast",
        experimental_timeoutMs: 30_000,
        experimental_reportResult: reportResult,
      }),
    ).resolves.toBe('{"label":"needs_human"}');
    expect(codex.calls).toEqual([
      {
        method: "codex.ai.complete",
        hostId: "cassidy-host",
        signal,
        input: {
          model: "gpt-6-luna",
          prompt: "Classify a labelled synthetic case",
          reasoningEffort: "medium",
          serviceTier: "fast",
          timeoutMs: 30_000,
        },
      },
    ]);
    expect(reportResult).toHaveBeenCalledExactlyOnceWith({
      usage,
      serviceTier: "default",
    });
  });

  it("keeps missing usage and actual tier unknown even when fast is requested", async () => {
    const codex = setup(() => ({ ok: true, text: '{"label":"observe"}' }));
    const reportResult = vi.fn();
    await expect(
      codex.complete("Classify a labelled synthetic case", {
        signal: new AbortController().signal,
        experimental_model: "gpt-6-luna",
        experimental_reasoningEffort: "medium",
        experimental_serviceTier: "fast",
        experimental_reportResult: reportResult,
      }),
    ).resolves.toBe('{"label":"observe"}');
    expect(reportResult).toHaveBeenCalledExactlyOnceWith({});
  });

  it.each(["rate_limited", "service_unavailable", "invalid_response"] as const)(
    "does not substitute a fallback host or model or report metadata on explicit-target %s",
    async (code) => {
      const codex = setup((call) =>
        call.hostId === "cassidy-host"
          ? { ok: false, code, message: "Explicit target failed" }
          : { ok: true, text: "Do not use the primary host" },
      );
      const reportResult = vi.fn();
      await expect(
        codex.complete("Classify a labelled synthetic case", {
          signal: new AbortController().signal,
          experimental_hostId: "cassidy-host",
          experimental_model: "gpt-6-luna",
          experimental_reasoningEffort: "medium",
          experimental_serviceTier: "fast",
          experimental_reportResult: reportResult,
        }),
      ).rejects.toThrow("Explicit target failed");
      expect(codex.calls.map(modelOf)).toEqual(["gpt-6-luna"]);
      expect(codex.calls.map((call) => call.hostId)).toEqual(["cassidy-host"]);
      expect(reportResult).not.toHaveBeenCalled();
    },
  );

  it("retains helper model fallback on an explicit host when no model is selected", async () => {
    const codex = setup((call) =>
      modelOf(call) === "gpt-6-luna"
        ? { ok: false, code: "rate_limited", message: "Slow down" }
        : { ok: true, text: "Fix login bug" },
    );
    await expect(
      codex.complete("Write a title", {
        signal: new AbortController().signal,
        experimental_hostId: "cassidy-host",
        experimental_reasoningEffort: "none",
        experimental_serviceTier: "default",
      }),
    ).resolves.toBe("Fix login bug");
    expect(codex.calls.map(modelOf)).toEqual(["gpt-6-luna", "gpt-5.6-luna"]);
    expect(codex.calls.every((call) => call.hostId === "cassidy-host")).toBe(true);
    expect(codex.calls.map((call) => call.input)).toEqual([
      {
        model: "gpt-6-luna",
        prompt: "Write a title",
        reasoningEffort: "none",
        serviceTier: "default",
        timeoutMs: 5_000,
      },
      {
        model: "gpt-5.6-luna",
        prompt: "Write a title",
        reasoningEffort: "none",
        serviceTier: "default",
        timeoutMs: 5_000,
      },
    ]);
  });

  it("refuses a recording over 20 MB before calling the host", async () => {
    const codex = setup(() => ({ ok: true, text: "unused" }));
    const audio = new File(
      [new Uint8Array(20 * 1024 * 1024 + 1)],
      "long.webm",
      { type: "audio/webm" },
    );

    await expect(
      codex.transcribe(audio, {
        signal: new AbortController().signal,
        hint: null,
      }),
    ).rejects.toThrow("Recordings over 20 MB are too large to transcribe");
    expect(codex.calls).toEqual([]);
  });

  it("sends a recording within the limit with bb's voice budget", async () => {
    const codex = setup(() => ({ ok: true, text: "hello" }));
    const audio = new File([new Uint8Array([1, 2, 3])], "clip.webm", {
      type: "audio/webm",
    });

    await expect(
      codex.transcribe(audio, {
        signal: new AbortController().signal,
        hint: "bb",
      }),
    ).resolves.toBe("hello");
    expect(codex.calls[0]?.input).toMatchObject({
      model: "gpt-transcribe",
      mimeType: "audio/webm",
      filename: "clip.webm",
      hint: "bb",
      timeoutMs: 65_000,
    });
  });
});
