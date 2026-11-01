import { getEnvironment, getThread } from "@bb/db";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { callHostOnlineRpc } from "../hosts/online-rpc.js";
import { isServerMoveFrozen } from "../server-move/freeze-state.js";
import { buildExecutionOptions } from "./thread-commands.js";
import { resolveThreadDynamicTools } from "./thread-runtime-config.js";

const LIVE_THREAD_TOOLS_RPC_TIMEOUT_MS = 30_000;

interface LiveThreadToolSyncState {
  requested: boolean;
  running: Promise<void> | null;
}

interface LiveProviderSession {
  environmentId: string;
  threadId: string;
}

const syncStates = new WeakMap<
  LoggedWorkSessionDeps["db"],
  LiveThreadToolSyncState
>();

export function requestLiveThreadToolSync(
  deps: LoggedWorkSessionDeps,
): Promise<void> {
  const state = syncStates.get(deps.db) ?? { requested: false, running: null };
  syncStates.set(deps.db, state);
  state.requested = true;
  state.running ??= drainLiveThreadToolSync(deps, state).finally(() => {
    state.running = null;
  });
  return state.running;
}

async function drainLiveThreadToolSync(
  deps: LoggedWorkSessionDeps,
  state: LiveThreadToolSyncState,
): Promise<void> {
  while (state.requested) {
    state.requested = false;
    if (isServerMoveFrozen(deps.db)) {
      return;
    }
    await Promise.all(
      deps.hub
        .listConnectedHostIds()
        .map((hostId) => syncHostLiveThreadTools(deps, hostId)),
    );
  }
}

async function syncHostLiveThreadTools(
  deps: LoggedWorkSessionDeps,
  hostId: string,
): Promise<void> {
  let sessions: LiveProviderSession[];
  try {
    ({ sessions } = await callHostOnlineRpc(deps, {
      command: { type: "provider.sessions.list" },
      hostId,
      timeoutMs: LIVE_THREAD_TOOLS_RPC_TIMEOUT_MS,
    }));
  } catch (error) {
    deps.logger.debug(
      { err: error, hostId },
      "Could not list live provider sessions for a tool update",
    );
    return;
  }
  for (const session of sessions) {
    try {
      await syncLiveThreadTools(deps, hostId, session);
    } catch (error) {
      deps.logger.warn(
        { err: error, hostId, threadId: session.threadId },
        "Could not update a live provider session's dynamic tools",
      );
    }
  }
}

async function syncLiveThreadTools(
  deps: LoggedWorkSessionDeps,
  hostId: string,
  session: LiveProviderSession,
): Promise<void> {
  const thread = getThread(deps.db, session.threadId);
  if (
    thread === null ||
    thread.deletedAt !== null ||
    thread.environmentId !== session.environmentId
  ) {
    return;
  }
  const environment = getEnvironment(deps.db, session.environmentId);
  if (environment === null || environment.hostId !== hostId) {
    return;
  }
  const execution = await buildExecutionOptions(
    deps,
    {},
    { threadId: thread.id, hostId },
  );
  const dynamicTools = await resolveThreadDynamicTools(deps, {
    environmentId: environment.id,
    hostId,
    model: execution.model,
    thread,
  });
  const { status } = await callHostOnlineRpc(deps, {
    command: {
      type: "thread.tools.update",
      environmentId: environment.id,
      threadId: thread.id,
      dynamicTools,
    },
    hostId,
    timeoutMs: LIVE_THREAD_TOOLS_RPC_TIMEOUT_MS,
  });
  if (status === "applied" || status === "deferred") {
    deps.logger.info(
      {
        hostId,
        status,
        threadId: thread.id,
        toolNames: dynamicTools.map((tool) => tool.name),
      },
      "Updated the dynamic tools of a live provider session",
    );
  }
}
