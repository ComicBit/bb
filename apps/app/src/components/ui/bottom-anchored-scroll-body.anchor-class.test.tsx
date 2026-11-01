// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BottomAnchoredScrollBody } from "@/components/ui/bottom-anchored-scroll-body";

class ResizeObserverMock implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderBody(scrollOverlay?: ReactNode) {
  const view = render(
    <BottomAnchoredScrollBody
      footer={<div>Footer</div>}
      maxWidthClassName="max-w-none"
      scrollAnchorThreadId="thread-a"
      scrollOverlay={scrollOverlay}
    >
      <div data-timeline-row-id="row-a">row-a</div>
    </BottomAnchoredScrollBody>,
  );
  const row = view.container.querySelector('[data-timeline-row-id="row-a"]');
  const contentWrapper = row?.parentElement;
  const sentinel = view.container.querySelector(".scroll-bottom-anchor");
  if (!contentWrapper || !sentinel) {
    throw new Error("Scroll body did not render its wrapper and sentinel");
  }
  return { container: view.container, contentWrapper, sentinel };
}

describe("BottomAnchoredScrollBody scroll-anchor exclusion", () => {
  it("excludes only the content wrapper and keeps the sentinel outside it", () => {
    vi.stubGlobal("CSS", {
      supports: (property: string, value: string) =>
        property === "overflow-anchor" && value === "none",
    });
    const { container, contentWrapper, sentinel } = renderBody();

    expect(contentWrapper.classList).toContain("scroll-bottom-anchor-content");
    expect(
      container.querySelectorAll(".scroll-bottom-anchor-content"),
    ).toHaveLength(1);
    expect(contentWrapper.contains(sentinel)).toBe(false);
    expect(sentinel.parentElement).toBe(contentWrapper.parentElement);
    const footer = container.querySelector("[data-scroll-footer]");
    expect(footer?.className).toContain("[overflow-anchor:none]");
    expect(footer?.previousElementSibling).toBe(sentinel);
  });

  it("never applies the exclusion class where scroll anchoring is unsupported", () => {
    vi.stubGlobal("CSS", { supports: () => false });
    const { container } = renderBody();

    expect(container.querySelector(".scroll-bottom-anchor-content")).toBeNull();
    expect(container.querySelector(".scroll-bottom-anchor")).not.toBeNull();
  });
});

describe("BottomAnchoredScrollBody grid", () => {
  it("stacks the scroll port and overlay in one explicit minmax(auto,1fr) row", () => {
    vi.stubGlobal("CSS", { supports: () => false });
    const { container } = renderBody(<nav>Overlay</nav>);
    const scrollPort = container.querySelector(".thread-scrollbar");
    const overlay = container.querySelector("[data-scroll-overlay]");
    const grid = scrollPort?.parentElement;

    expect(overlay?.parentElement).toBe(grid);
    expect(grid?.classList).toContain("grid");
    expect(
      [...(grid?.classList ?? [])].filter((token) =>
        token.startsWith("grid-rows-"),
      ),
    ).toEqual(["grid-rows-[minmax(auto,1fr)]"]);
    for (const item of [scrollPort, overlay]) {
      expect([...(item?.classList ?? [])]).toEqual(
        expect.arrayContaining(["row-start-1", "col-start-1", "min-h-0"]),
      );
    }
  });
});

describe("BottomAnchoredScrollBody history collapse", () => {
  it("retains history and a focused native footer while removing history from interaction", () => {
    vi.stubGlobal("CSS", { supports: () => false });
    const body = (historyCollapsed: boolean) => (
      <BottomAnchoredScrollBody
        footer={
          <div>
            <input aria-label="Message" defaultValue="Draft with an attachment" />
            <button type="button">Stop</button>
            <button type="button">Review permission</button>
            <button type="button">Edit queued message</button>
          </div>
        }
        maxWidthClassName="max-w-none"
        scrollAnchorThreadId="thread-collapse"
        historyCollapsed={historyCollapsed}
      >
        <button type="button">Earlier message action</button>
      </BottomAnchoredScrollBody>
    );
    const view = render(body(false));
    const editor = screen.getByRole("textbox", { name: "Message" }) as HTMLInputElement;
    const earlierAction = screen.getByRole("button", { name: "Earlier message action" });
    editor.focus();
    editor.setSelectionRange(3, 7);
    view.rerender(body(true));
    expect(screen.queryByRole("button", { name: "Earlier message action" })).toBeNull();
    expect(screen.getByRole("button", { name: "Earlier message action", hidden: true })).toBe(earlierAction);
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(editor);
    expect(document.activeElement).toBe(editor);
    expect(editor.selectionStart).toBe(3);
    expect(editor.selectionEnd).toBe(7);
    for (const name of ["Stop", "Review permission", "Edit queued message"]) {
      expect(screen.getByRole("button", { name }).closest("[hidden]")).toBeNull();
    }
    view.rerender(body(false));
    expect(screen.getByRole("button", { name: "Earlier message action" })).toBe(earlierAction);
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(editor);
  });
});
