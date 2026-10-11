import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolResultSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { DynamicTool } from "@bb/domain";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAcpMcpServerConfig,
  encodeDynamicToolSnapshot,
} from "./tool-proxy-mcp.js";

const here = dirname(fileURLToPath(import.meta.url));
const BRIDGE_MODULE = resolve(here, "bridge.ts");
const TSX_LOADER = import.meta.resolve("tsx");

const cleanups: Array<() => Promise<void> | void> = [];

const ASK_USER_QUESTION_TOOL: DynamicTool = {
  name: "AskUserQuestion",
  description: "Ask the user a question.",
  inputSchema: { type: "object", properties: {} },
};

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function listenFakeBridge(args: {
  responseDelayMs: number | null;
  response?: unknown;
}): Promise<{
  port: number;
  server: Server;
  requests: unknown[];
  cancelled: unknown[];
  releaseResponses(): void;
  pushTools(tools: readonly DynamicTool[]): void;
  subscriberCount(): number;
}> {
  const requests: unknown[] = [];
  const cancelled: unknown[] = [];
  const sockets = new Set<Socket>();
  const subscribers = new Set<Socket>();
  const heldResponses: Array<() => void> = [];
  const responseTimers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline)) as {
        kind?: unknown;
      };
      if (request.kind === "initialized") {
        socket.end(`${JSON.stringify({ ok: true, content: "" })}\n`);
        return;
      }
      if (request.kind === "subscribe") {
        subscribers.add(socket);
        socket.once("close", () => subscribers.delete(socket));
        return;
      }
      requests.push(request);
      let responded = false;
      socket.once("close", () => {
        if (!responded) cancelled.push(request);
      });
      const response = args.response ?? {
        ok: true,
        content: '{"answers":{"Which?":"B"}}',
      };
      const respond = () => {
        responded = true;
        socket.end(`${JSON.stringify(response)}\n`);
      };
      if (args.responseDelayMs === null) {
        heldResponses.push(respond);
      } else {
        const timer = setTimeout(() => {
          responseTimers.delete(timer);
          respond();
        }, args.responseDelayMs);
        responseTimers.add(timer);
      }
    });
  });
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", () => resolveListen()),
  );
  cleanups.push(
    () =>
      new Promise<void>((resolveClose) => {
        for (const timer of responseTimers) clearTimeout(timer);
        responseTimers.clear();
        heldResponses.length = 0;
        for (const socket of sockets) socket.destroy();
        server.close(() => resolveClose());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake bridge did not bind a port");
  }
  return {
    port: address.port,
    server,
    requests,
    cancelled,
    releaseResponses() {
      for (const respond of heldResponses.splice(0)) respond();
    },
    pushTools(tools) {
      for (const socket of subscribers) {
        socket.write(encodeDynamicToolSnapshot(tools));
      }
    },
    subscriberCount() {
      return subscribers.size;
    },
  };
}

async function connectLikeOpenCode(port: number): Promise<Client> {
  const config = buildAcpMcpServerConfig({
    bridgeArgs: [
      "--conditions=source",
      "--import",
      TSX_LOADER,
      BRIDGE_MODULE,
      "--mcp-stdio",
    ],
    command: process.execPath,
    dynamicTools: [ASK_USER_QUESTION_TOOL],
    host: "127.0.0.1",
    port,
    runtimeEnv: [],
    threadId: "thread-ask",
    token: "secret-token",
  });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const { name, value } of config.env) env[name] = value;
  env.BB_ACP_DYNAMIC_TOOL_PROGRESS_INTERVAL_MS = "200";
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "opencode-like", version: "0" });
  await client.connect(transport);
  transport.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[bb-bridge mcp] ${chunk.toString()}`);
  });
  cleanups.push(() => client.close());
  return client;
}

describe("bb-bridge MCP server keeps long tool calls alive", () => {
  it("sends progress notifications so an OpenCode-style client does not time out while the user answers", async () => {
    const fakeBridge = await listenFakeBridge({ responseDelayMs: 2_500 });
    const client = await connectLikeOpenCode(fakeBridge.port);

    let progressCount = 0;
    const result = await client.callTool(
      {
        name: "AskUserQuestion",
        arguments: { questions: [] },
      },
      CallToolResultSchema,
      {
        timeout: 1_000,
        resetTimeoutOnProgress: true,
        onprogress: () => {
          progressCount += 1;
        },
      },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      { type: "text", text: '{"answers":{"Which?":"B"}}' },
    ]);
    expect(progressCount).toBeGreaterThan(0);
    expect(fakeBridge.requests).toHaveLength(1);
  }, 20_000);

  it("relays an image-only result as an MCP image block", async () => {
    const fakeBridge = await listenFakeBridge({
      responseDelayMs: 0,
      response: {
        ok: true,
        content: "",
        contentBlocks: [
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        ],
        images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }],
      },
    });
    const client = await connectLikeOpenCode(fakeBridge.port);

    const result = await client.callTool(
      { name: "AskUserQuestion", arguments: {} },
      CallToolResultSchema,
      { timeout: 5_000 },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ]);
  }, 20_000);
});

describe("bb-bridge MCP cancellation", () => {
  it.each(["timeout", "abort", "disconnect"] as const)(
    "closes the bridge call on %s without a late MCP reply",
    async (kind) => {
      const bridge = await listenFakeBridge({ responseDelayMs: null });
      const client = await connectLikeOpenCode(bridge.port);
      const errors: string[] = [];
      client.onerror = (error) => errors.push(error.message);
      const controller = new AbortController();
      const result = client
        .callTool(
          { name: "AskUserQuestion", arguments: {} },
          CallToolResultSchema,
          {
            timeout: kind === "timeout" ? 200 : 5_000,
            signal: controller.signal,
          },
        )
        .catch((error) => error);
      await expect.poll(() => bridge.requests.length).toBe(1);
      if (kind === "abort") controller.abort();
      if (kind === "disconnect") await client.close();
      expect(await result).toBeInstanceOf(Error);
      await expect
        .poll(() => bridge.cancelled.length, { timeout: 1_000 })
        .toBe(1);
      bridge.releaseResponses();
      if (kind !== "disconnect") {
        expect((await client.listTools()).tools).toContainEqual(
          expect.objectContaining({ name: "AskUserQuestion" }),
        );
      }
      expect(
        errors.filter((error) => error.includes("unknown message ID")),
      ).toEqual([]);
    },
    20_000,
  );

  it("ignores unknown and malformed cancellations and preserves a normal answer", async () => {
    const bridge = await listenFakeBridge({ responseDelayMs: 300 });
    const client = await connectLikeOpenCode(bridge.port);
    const result = client.callTool({ name: "AskUserQuestion", arguments: {} });
    await expect.poll(() => bridge.requests.length).toBe(1);
    await client.notification({
      method: "notifications/cancelled",
      params: { requestId: "unrelated" },
    });
    await client.notification({
      method: "notifications/cancelled",
      params: { requestId: { invalid: true } },
    });
    expect((await result).isError).toBeFalsy();
    expect(bridge.cancelled).toHaveLength(0);
  }, 20_000);
});

describe("bb-bridge MCP live tool updates", () => {
  const RUN_TOOL: DynamicTool = {
    name: "aurora_run",
    description: "Run an Aurora job.",
    inputSchema: {
      type: "object",
      properties: { job: { type: "string" } },
    },
  };

  async function connectAndCountListChanges(port: number) {
    const client = await connectLikeOpenCode(port);
    let listChanges = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      listChanges += 1;
    });
    return { client, listChanges: () => listChanges };
  }

  it("advertises listChanged so the agent watches for updates", async () => {
    const bridge = await listenFakeBridge({ responseDelayMs: 0 });
    const client = await connectLikeOpenCode(bridge.port);

    expect(client.getServerCapabilities()?.tools).toEqual({
      listChanged: true,
    });
  }, 20_000);

  it("announces a changed tool set once and then serves the new schemas", async () => {
    const bridge = await listenFakeBridge({ responseDelayMs: 0 });
    const { client, listChanges } = await connectAndCountListChanges(
      bridge.port,
    );
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "AskUserQuestion",
    ]);
    await expect.poll(() => bridge.subscriberCount()).toBe(1);

    const widenedRunTool: DynamicTool = {
      ...RUN_TOOL,
      inputSchema: {
        type: "object",
        properties: {
          job: { type: "string" },
          dryRun: { type: "boolean" },
        },
      },
    };
    bridge.pushTools([ASK_USER_QUESTION_TOOL, widenedRunTool]);

    await expect.poll(listChanges).toBe(1);
    expect((await client.listTools()).tools).toEqual([
      {
        name: "AskUserQuestion",
        description: "Ask the user a question.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "aurora_run",
        description: "Run an Aurora job.",
        inputSchema: widenedRunTool.inputSchema,
      },
    ]);

    bridge.pushTools([ASK_USER_QUESTION_TOOL, widenedRunTool]);
    bridge.pushTools([
      ASK_USER_QUESTION_TOOL,
      {
        ...widenedRunTool,
        presentation: {
          label: { pending: "Running", completed: "Ran" },
          icon: { glyph: "play" },
        },
      },
    ]);
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    expect(listChanges()).toBe(1);
  }, 20_000);

  it("finishes a call already in flight and refuses a tool the update removed", async () => {
    const bridge = await listenFakeBridge({ responseDelayMs: null });
    const { client, listChanges } = await connectAndCountListChanges(
      bridge.port,
    );
    await client.listTools();
    await expect.poll(() => bridge.subscriberCount()).toBe(1);
    const inFlight = client.callTool(
      { name: "AskUserQuestion", arguments: {} },
      CallToolResultSchema,
      { timeout: 5_000 },
    );
    await expect.poll(() => bridge.requests.length).toBe(1);

    bridge.pushTools([RUN_TOOL]);
    await expect.poll(listChanges).toBe(1);
    bridge.releaseResponses();

    const settled = await inFlight;
    expect(settled.isError).toBeFalsy();
    expect(settled.content).toEqual([
      { type: "text", text: '{"answers":{"Which?":"B"}}' },
    ]);
    await expect(
      client.callTool({ name: "AskUserQuestion", arguments: {} }),
    ).rejects.toThrow("Unknown tool: AskUserQuestion");
    expect(bridge.requests).toHaveLength(1);
  }, 20_000);
});
