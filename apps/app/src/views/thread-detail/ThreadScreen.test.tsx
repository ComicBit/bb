// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingInteraction } from "@bb/domain";
import type { ComponentProps } from "react";
import { conversationRow, toolRow, turnRow } from "@/test/fixtures/thread-timeline-rows";
import type { UseThreadTimelineControllerResult } from "@/components/thread/timeline";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { ThreadScreen, type ThreadScreenPresentation } from "./ThreadScreen";

const mocks = vi.hoisted(() => ({
  pendingInteractions: [] as PendingInteraction[],
  promptAreaProps: [] as Array<Record<string, unknown>>,
  surfaceProps: [] as Array<Record<string, unknown>>,
  pendingInteractionsError: false,
  refetchPendingInteractions: vi.fn(),
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useChildThreads: () => ({ data: [] }),
  useThread: () => ({ data: undefined }),
  useThreadPendingInteractions: () => ({
    data: mocks.pendingInteractions,
    isError: mocks.pendingInteractionsError,
    isFetching: false,
    refetch: mocks.refetchPendingInteractions,
  }),
}));

vi.mock("@/hooks/queries/child-thread-pending-interactions", () => ({
  useChildThreadPendingAttention: () => [],
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({ data: undefined }),
}));

vi.mock("@/hooks/mutations/thread-runtime-mutations", () => {
  const mutation = () => ({ isPending: false, mutateAsync: vi.fn() });
  return {
    useEditThreadMessage: mutation,
    useSendThreadMessage: mutation,
  };
});

vi.mock("@/components/thread/timeline", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/thread/timeline")>();
  return {
    ...actual,
    ThreadTimelineSurface: (props: Record<string, unknown>) => {
      mocks.surfaceProps.push(props);
      const addToChat = props.onSelectionAddToChat as
        | ((text: string) => void)
        | undefined;
      return (
        <button data-testid="native-history" type="button" onClick={() => addToChat?.("Quoted line")}>
          Add selection to chat
        </button>
      );
    },
  };
});

vi.mock("./ThreadDetailPromptArea", () => ({
  ThreadDetailPromptArea: (props: Record<string, unknown>) => {
    mocks.promptAreaProps.push(props);
    return <div data-testid="prompt-area"><input aria-label="Retained draft" defaultValue="Draft" /></div>;
  },
}));

const THREAD = makeThreadResponse({
  id: "thr_screen",
  projectId: "proj_screen",
  status: "active",
  runtime: { displayStatus: "active" },
});

const TIMELINE = {
  activeBackgroundCommands: [],
  activePromptMode: null,
  activeThinking: null,
  activeWorkflows: [],
  contextBoundarySeq: null,
  contextWindowUsage: null,
  goal: null,
  hasOlderTimelineRows: false,
  isCatchingUpTimeline: false,
  isLoadingOlderTimelineRows: false,
  loadOlderTimelineRows: async () => {},
  modelFallback: null,
  pendingTodos: null,
  providerCommands: null,
  sessionOptions: null,
  timelineError: null,
  timelineLoading: false,
  timelineRows: [],
} as unknown as UseThreadTimelineControllerResult;

const SIDE_CHAT_PRESENTATION: ThreadScreenPresentation = {
  kind: "panel",
  layout: "contained",
  measure: "panel",
  tone: "sidebar",
};

function renderScreen(
  presentation: ThreadScreenPresentation,
  overrides: Partial<ComponentProps<typeof ThreadScreen>> = {},
) {
  const { wrapper: Wrapper } = createQueryClientTestHarness();
  const element = (props = overrides) => (
    <Wrapper>
      <ThreadScreen
        composer={{
          environmentCheckout: undefined,
          environmentChrome: undefined,
          contextEnvironmentId: null,
          permissionPolicy: "snapshot",
        }}
        environment={null}
        presentation={presentation}
        projectId={THREAD.projectId}
        resolveMentionLink={() => null}
        thread={THREAD}
        timeline={TIMELINE}
        timelineHost={{
          environmentHostName: null,
          includePluginMessageActions: false,
          unreadDividerAutoScroll: false,
          unreadDividerPlacement: null,
        }}
        workspaceRootPath={undefined}
        {...props}
      />
    </Wrapper>
  );
  const view = render(element());
  return {
    ...view,
    rerenderScreen: (props: Partial<ComponentProps<typeof ThreadScreen>>) =>
      view.rerender(element(props)),
  };
}

function makePluginInteraction(): PendingInteraction {
  return {
    id: "int_plugin",
    threadId: THREAD.id,
    turnId: null,
    providerId: null,
    providerThreadId: null,
    providerRequestId: null,
    origin: { kind: "plugin", pluginId: "secrets" },
    payload: { kind: "plugin", pluginId: "secrets", type: "secret-request" },
    resolution: null,
    status: "pending",
    statusReason: null,
    createdAt: 1,
    resolvedAt: null,
  } as unknown as PendingInteraction;
}

beforeEach(() => {
  mocks.pendingInteractions = [];
  mocks.promptAreaProps = [];
  mocks.surfaceProps = [];
  mocks.pendingInteractionsError = false;
  mocks.refetchPendingInteractions.mockReset();
});

afterEach(() => {
  cleanup();
  getPromptDraftAccessor({
    kind: "thread",
    projectId: THREAD.projectId,
    threadId: THREAD.id,
  }).setDraft({ text: "", mentions: [], attachments: [] });
});

describe("ThreadScreen", () => {
  it.each(["contained", "document"] as const)(
    "collapses %s history without remounting history or composer",
    (layout) => {
      const presentation = { ...SIDE_CHAT_PRESENTATION, layout };
      const view = renderScreen(presentation, { historyCollapsed: false });
      const history = screen.getByTestId("native-history");
      const composer = screen.getByTestId("prompt-area");
      const draft = screen.getByLabelText("Retained draft") as HTMLInputElement;
      fireEvent.change(draft, { target: { value: "Keep this draft" } });

      view.rerenderScreen({ historyCollapsed: true });
      expect(screen.getAllByTestId("native-history")).toHaveLength(1);
      expect(screen.getByTestId("native-history")).toBe(history);
      expect(history.closest("[hidden]")).not.toBeNull();
      expect(screen.getByTestId("prompt-area")).toBe(composer);
      expect(composer.closest("[hidden]")).toBeNull();
      expect(draft.value).toBe("Keep this draft");
      expect(mocks.promptAreaProps.at(-1)!.permissionPolicy).toBe("snapshot");

      view.rerenderScreen({ historyCollapsed: false });
      expect(screen.getByTestId("native-history")).toBe(history);
      expect(history.closest("[hidden]")).toBeNull();
      expect(screen.getByTestId("prompt-area")).toBe(composer);
    },
  );

  it("requests expansion only for new conversation messages, not initial data, paging or streaming chunks", () => {
    const onHistoryCollapsedChange = vi.fn();
    const initial = conversationRow({ id: "message", text: "Hello", sourceSeqStart: 10 });
    const props = {
      historyCollapsed: true,
      onHistoryCollapsedChange,
      timeline: { ...TIMELINE, timelineRows: [initial] },
    };
    const view = renderScreen(SIDE_CHAT_PRESENTATION, props);
    expect(onHistoryCollapsedChange).not.toHaveBeenCalled();
    view.rerenderScreen({
      ...props,
      timeline: {
        ...TIMELINE,
        timelineRows: [
          conversationRow({ text: "Older", sourceSeqStart: 1 }),
          { ...initial, text: "Hello streaming", sourceSeqEnd: 20 },
          toolRow({ toolName: "tool", sourceSeqStart: 30 }),
        ],
      },
    });
    expect(onHistoryCollapsedChange).not.toHaveBeenCalled();
    view.rerenderScreen({
      ...props,
      timeline: {
        ...TIMELINE,
        timelineRows: [initial, turnRow({
          children: [conversationRow({ text: "New reply", sourceSeqStart: 40 })],
        })],
      },
    });
    expect(onHistoryCollapsedChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(screen.getByTestId("native-history").closest("[hidden]")).not.toBeNull();
  });

  it("takes the first successful history load and each new thread as a baseline", () => {
    const onHistoryCollapsedChange = vi.fn();
    const props = { historyCollapsed: true, onHistoryCollapsedChange };
    const view = renderScreen(SIDE_CHAT_PRESENTATION, {
      ...props, timeline: { ...TIMELINE, timelineLoading: true },
    });
    const timeline = {
      ...TIMELINE,
      timelineRows: [conversationRow({ text: "Loaded", sourceSeqStart: 12 })],
    };
    view.rerenderScreen({ ...props, timeline });
    view.rerenderScreen({
      ...props, timeline,
      thread: { ...THREAD, id: "thr_different" },
    });
    expect(onHistoryCollapsedChange).not.toHaveBeenCalled();
  });

  it("requests expansion through the shared composer submission seam", () => {
    const onHistoryCollapsedChange = vi.fn();
    renderScreen(SIDE_CHAT_PRESENTATION, {
      historyCollapsed: true, onHistoryCollapsedChange,
    });
    const onSubmitMessage = mocks.promptAreaProps.at(-1)!.onSubmitMessage;
    if (typeof onSubmitMessage !== "function") throw new Error("Missing submission seam");
    onSubmitMessage();
    expect(onHistoryCollapsedChange).toHaveBeenCalledWith(false);
  });

  it("keeps history errors visible with a controlled expansion action", () => {
    const onHistoryCollapsedChange = vi.fn();
    renderScreen(SIDE_CHAT_PRESENTATION, {
      historyCollapsed: true,
      onHistoryCollapsedChange,
      timeline: { ...TIMELINE, timelineError: new Error("Unavailable") },
    });
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load conversation history.");
    fireEvent.click(screen.getByRole("button", { name: "Show conversation" }));
    expect(onHistoryCollapsedChange).toHaveBeenCalledWith(false);
  });

  it.each([
    ["status", "Couldn't load thread status."],
    ["execution", "Thread execution failed."],
  ] as const)("keeps %s failures visible while history is collapsed", (kind, message) => {
    renderScreen(SIDE_CHAT_PRESENTATION, {
      historyCollapsed: true,
      historyStatusError: kind === "status",
      thread: kind === "execution"
        ? { ...THREAD, runtime: { ...THREAD.runtime, displayStatus: "error" } }
        : THREAD,
    });
    expect(screen.getByRole("alert").textContent).toContain(message);
    expect(screen.getByRole("button", { name: "Show conversation" })).toBeTruthy();
  });

  it("retries failed pending-interaction queries from the visible footer", () => {
    mocks.pendingInteractionsError = true;
    renderScreen(SIDE_CHAT_PRESENTATION, { historyCollapsed: true });
    expect(screen.getByRole("alert").textContent).toContain("Couldn't check pending interactions.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.refetchPendingInteractions).toHaveBeenCalledTimes(1);
  });

  it("ignores collapse for a timeline-only transcript", () => {
    renderScreen({ kind: "transcript", layout: "contained" }, {
      composer: null, historyCollapsed: true,
    });
    expect(screen.getByTestId("native-history").closest("[hidden]")).toBeNull();
    expect(screen.queryByTestId("prompt-area")).toBeNull();
  });

  it.each([undefined, true])("hands plugin interactions to the native composer with collapse %s", (historyCollapsed) => {
    mocks.pendingInteractions = [makePluginInteraction()];
    renderScreen(SIDE_CHAT_PRESENTATION, { historyCollapsed });

    const promptArea = mocks.promptAreaProps.at(-1)!;
    expect(promptArea.pendingInteractions).toEqual(mocks.pendingInteractions);
    expect(promptArea.isPrimaryComposer).toBe(false);
    expect(promptArea.permissionPolicy).toBe("snapshot");
    expect(mocks.surfaceProps.at(-1)!.showOngoingIndicator).toBe(false);
  });

  it("quotes a timeline selection into the thread draft and focuses the composer", () => {
    renderScreen({ kind: "page" });
    const focusKeyBefore =
      mocks.promptAreaProps.at(-1)!.composerFocusRequestKey;

    fireEvent.click(
      screen.getByRole("button", { name: "Add selection to chat" }),
    );

    const draft = getPromptDraftAccessor({
      kind: "thread",
      projectId: THREAD.projectId,
      threadId: THREAD.id,
    }).getCurrent();
    expect(draft.text).toContain("Quoted line");
    expect(mocks.promptAreaProps.at(-1)!.composerFocusRequestKey).not.toBe(
      focusKeyBefore,
    );
  });
});
