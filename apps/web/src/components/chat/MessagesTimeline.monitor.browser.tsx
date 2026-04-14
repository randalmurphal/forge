import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { MessagesTimeline } from "./MessagesTimeline";
import { deriveTimelineEntries, type WorkLogEntry } from "../../session-logic";

function MessagesTimelineBrowserHarness(
  props: Omit<ComponentProps<typeof MessagesTimeline>, "scrollContainer">,
) {
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);

  return (
    <div
      ref={setScrollContainer}
      data-testid="messages-timeline-scroll-container"
      className="h-full overflow-y-auto overscroll-y-contain"
    >
      <MessagesTimeline {...props} scrollContainer={scrollContainer} />
    </div>
  );
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

function createTimelineProps(
  workEntries: WorkLogEntry[],
): Omit<ComponentProps<typeof MessagesTimeline>, "scrollContainer"> {
  return {
    threadId: null,
    hasMessages: true,
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnStartedAt: null,
    timelineEntries: deriveTimelineEntries([], [], workEntries),
    completionDividerBeforeEntryId: null,
    completionSummary: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    expandedWorkGroups: {},
    onToggleWorkGroup: () => {},
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
  };
}

async function waitForLayout() {
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
}

describe("MessagesTimeline monitor rows", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows bash file metadata inside the launch-row dropdown", async () => {
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <div className="h-[480px] w-[960px] overflow-hidden">
          <MessagesTimelineBrowserHarness
            {...createTimelineProps([
              {
                id: "monitor-launch",
                createdAt: "2026-04-10T12:00:00.000Z",
                label: "Tool call",
                tone: "tool",
                itemType: "dynamic_tool_call",
                toolName: "Monitor",
                detail: "Monitor: Watch the dev server",
                detailItems: [
                  {
                    label: "Bash file",
                    value: "/tmp/forge-monitor-123.sh",
                  },
                ],
              },
            ])}
          />
        </div>
      </QueryClientProvider>,
    );

    try {
      await vi.waitFor(() => {
        expect(page.getByText("Monitor: Watch the dev server")).toBeTruthy();
      });
      expect(document.body.textContent).not.toContain("Bash file");

      await page.getByRole("button").click();
      await waitForLayout();

      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Bash file");
        expect(document.body.textContent).toContain("/tmp/forge-monitor-123.sh");
      });
    } finally {
      await screen.unmount();
    }
  });
});
