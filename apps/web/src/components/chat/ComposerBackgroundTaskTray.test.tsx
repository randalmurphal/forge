import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerBackgroundTaskTray } from "./ComposerBackgroundTaskTray";
import type { BackgroundTrayState } from "../../session-logic";

describe("ComposerBackgroundTaskTray", () => {
  it("renders nothing when there are no background tasks", () => {
    const markup = renderToStaticMarkup(
      <ComposerBackgroundTaskTray
        threadId="thread-1"
        nowIso="2026-04-10T12:00:00.000Z"
        state={makeState()}
      />,
    );

    expect(markup).toBe("");
  });

  it("renders the tray header when background tasks exist", () => {
    const markup = renderToStaticMarkup(
      <ComposerBackgroundTaskTray
        threadId="thread-1"
        nowIso="2026-04-10T12:00:00.000Z"
        state={makeState({
          commandEntries: [
            {
              id: "command-1",
              createdAt: "2026-04-10T12:00:00.000Z",
              startedAt: "2026-04-10T12:00:00.000Z",
              label: "Command",
              tone: "tool",
              itemType: "command_execution",
              command: "bun run build --watch",
              output: "[watch] started",
              isBackgroundCommand: true,
            },
          ],
          hiddenWorkEntryIds: ["command-1"],
          hasRunningTasks: true,
        })}
      />,
    );

    expect(markup).toContain("Background");
    expect(markup).toContain(">1<");
    expect(markup).toContain("bun run build --watch");
  });

  it("defaults to the collapsed state when five or more tasks are visible", () => {
    const commandEntries = Array.from({ length: 5 }, (_, index) => ({
      id: `command-${index}`,
      createdAt: `2026-04-10T12:00:0${index}.000Z`,
      startedAt: `2026-04-10T12:00:0${index}.000Z`,
      label: "Command",
      tone: "tool" as const,
      itemType: "command_execution" as const,
      command: `bun run task-${index}`,
      output: `output-${index}`,
      isBackgroundCommand: true,
    }));

    const markup = renderToStaticMarkup(
      <ComposerBackgroundTaskTray
        threadId="thread-1"
        nowIso="2026-04-10T12:00:10.000Z"
        state={makeState({
          commandEntries,
          hiddenWorkEntryIds: commandEntries.map((entry) => entry.id),
          hasRunningTasks: true,
          defaultCollapsed: true,
        })}
      />,
    );

    expect(markup).toContain("Background");
    expect(markup).toContain(">5<");
    expect(markup).not.toContain("bun run task-0");
  });
});

function makeState(overrides: Partial<BackgroundTrayState> = {}): BackgroundTrayState {
  return {
    subagentGroups: [],
    commandEntries: [],
    hiddenSubagentGroupIds: [],
    hiddenWorkEntryIds: [],
    hasRunningTasks: false,
    defaultCollapsed: false,
    ...overrides,
  };
}
