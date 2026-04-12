import { MessageId } from "@forgetools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { type ReactElement } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../ChatMarkdown", () => ({
  default: (props: { text: string }) => <div>{props.text}</div>,
}));

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

beforeAll(() => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});

function renderTimeline(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return renderToStaticMarkup(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("MessagesTimeline", () => {
  it("renders inline terminal labels with the composer chip UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
      <MessagesTimeline
        threadId={null}
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-2"),
              role: "user",
              text: [
                "yoo what's @terminal-1:1-5 mean",
                "",
                "<terminal_context>",
                "- Terminal 1 lines 1-5:",
                "  1 | julius@mac effect-http-ws-cli % bun i",
                "  2 | bun install v1.3.9 (cf6cdbbb)",
                "</terminal_context>",
              ].join("\n"),
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("yoo what&#x27;s ");
  });

  it("renders grouped operation entries inline in chat history", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
      <MessagesTimeline
        threadId={null}
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Context compacted",
              tone: "info",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Context compacted");
    expect(markup).not.toContain("Tool changes");
  });

  it("renders commands as standalone timeline rows instead of grouped operations", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
      <MessagesTimeline
        threadId={null}
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "command-entry",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "command-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Command",
              tone: "tool",
              itemType: "command_execution",
              command: "bun fmt",
              isBackgroundCommand: true,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Command");
    expect(markup).toContain("bun fmt");
    expect(markup).toContain("background");
    expect(markup).not.toContain("Operations");
  });

  it("renders collab control calls as standalone timeline rows with model metadata", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
      <MessagesTimeline
        threadId={null}
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "spawn-entry",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "spawn-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Subagent task",
              tone: "tool",
              itemType: "collab_agent_tool_call",
              toolName: "spawnAgent",
              agentDescription: "Inspect the parser",
              agentModel: "gpt-5.4-mini",
              agentPrompt: "Run exactly these parser checks and report only final completion",
              receiverThreadIds: ["child-thread-inline"],
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("gpt-5.4-mini");
    expect(markup).toContain("Inspect the parser");
    expect(markup).not.toContain("gpt-5.4-mini * Inspect the parser");
    expect(markup).not.toContain("Operations");
  });

  it("renders a spawned badge for completed spawn agent calls", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
      <MessagesTimeline
        threadId={null}
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "spawn-entry",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "spawn-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Subagent task",
              tone: "tool",
              itemType: "collab_agent_tool_call",
              toolName: "spawnAgent",
              itemStatus: "completed",
              agentDescription: "Inspect the parser",
              agentModel: "gpt-5.4-mini",
              agentPrompt: "Run exactly these parser checks and report only final completion",
              receiverThreadIds: ["child-thread-inline"],
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("spawned");
  });

  it("renders a spawned badge for completed Claude Agent launch calls", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
      <MessagesTimeline
        threadId={null}
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "agent-entry",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "agent-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Subagent task",
              tone: "tool",
              itemType: "collab_agent_tool_call",
              toolName: "Agent",
              itemStatus: "completed",
              agentDescription: "Inspect the parser",
              agentModel: "claude-opus-4-6",
              agentPrompt: "Run exactly these parser checks and report only final completion",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("spawned");
  });

  it("renders a completed badge for finished background commands", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
      <MessagesTimeline
        threadId={null}
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "background-command-entry",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "background-command-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Command",
              tone: "tool",
              activityKind: "task.completed",
              itemType: "command_execution",
              command: "sleep 20 && echo done",
              isBackgroundCommand: true,
              backgroundTaskStatus: "completed",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("background");
    expect(markup).toContain("completed");
    expect(markup).toContain("lucide-check");
  });

  it("does not render a completed badge on the launch row for a finished background command", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
      <MessagesTimeline
        threadId={null}
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "launch-row-entry",
            kind: "work",
            createdAt: "2026-02-23T00:00:00.000Z",
            entry: {
              id: "launch-row",
              createdAt: "2026-02-23T00:00:00.000Z",
              label: "Command",
              tone: "tool",
              activityKind: "tool.completed",
              itemType: "command_execution",
              command: "sleep 20 && echo done",
              isBackgroundCommand: true,
              backgroundTaskStatus: "completed",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-02-23T00:00:02.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("background");
    expect(markup).not.toContain("lucide-check");
    expect(markup).not.toContain("completed");
  });

  it("renders a completed badge for finished wait agent calls", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
      <MessagesTimeline
        threadId={null}
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "wait-entry",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "wait-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Wait agent",
              tone: "tool",
              itemType: "collab_agent_tool_call",
              toolName: "wait",
              itemStatus: "completed",
              agentDescription: "Inspect the parser",
              agentModel: "gpt-5.4-mini",
              receiverThreadIds: ["child-thread-inline"],
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("completed");
    expect(markup).toContain("lucide-check");
  });

  it("renders the command output chevron for command rows but not non-command rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const commandMarkup = renderTimeline(
      <MessagesTimeline
        threadId={null}
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "command-entry",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "command-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Command",
              tone: "tool",
              itemType: "command_execution",
              command: "bun fmt",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );
    const fileMarkup = renderTimeline(
      <MessagesTimeline
        threadId={null}
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "file-entry",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "file-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "File change",
              tone: "tool",
              itemType: "file_change",
              changedFiles: ["src/app.ts"],
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(commandMarkup).toContain("lucide-chevron-right");
    expect(fileMarkup).not.toContain("lucide-chevron-right");
  });

  it("keeps failed command output collapsed by default", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
      <MessagesTimeline
        threadId={null}
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "command-entry",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "command-failed",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Command",
              tone: "tool",
              itemType: "command_execution",
              command: "bun run test",
              exitCode: 1,
              hasOutput: true,
              output: "FAIL should reconnect after session drop",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("exit 1");
    expect(markup).not.toContain("Output");
    expect(markup).not.toContain("Copy");
    expect(markup).not.toContain("FAIL should reconnect after session drop");
  });

  it("renders collapsed tool and turn diff blocks inline in chat history", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const assistantMessageId = MessageId.makeUnsafe("assistant-1");
    const markup = renderTimeline(
      <MessagesTimeline
        threadId={null}
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "work-entry",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "tool-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "File change",
              tone: "tool",
              itemType: "file_change",
              changedFiles: ["src/app.ts"],
              inlineDiff: {
                id: "tool-1",
                activityId: "tool-1",
                title: "Edit file",
                availability: "summary_only",
                files: [{ path: "src/app.ts", additions: 1, deletions: 0 }],
                additions: 1,
                deletions: 0,
              },
            },
          },
          {
            id: "assistant-entry",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "Updated the file.",
              turnId: "turn-1" as never,
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId: "turn-1" as never,
                completedAt: "2026-03-17T19:12:30.000Z",
                provenance: "agent",
                coverage: "complete",
                source: "native_turn_diff",
                assistantMessageId,
                files: [{ path: "src/app.ts", additions: 2, deletions: 1 }],
              },
            ],
          ])
        }
        nowIso="2026-03-17T19:12:31.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("File changes");
    expect(markup).toContain("Patch unavailable for this tool call.");
    expect(markup).not.toContain("Summary only");
    expect(markup).toContain("Turn changes");
    expect(markup).toContain("Open in diff panel");
    expect(markup).not.toContain("Open in diff panel</button>");
    expect(markup).not.toContain("Expand");
  });

  it("renders a chevron expand bar for long exact-patch tool diffs", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const longPatch = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,2 +1,10 @@",
      " const alpha = 1;",
      "-const beta = 2;",
      "+const beta = 3;",
      "+const gamma = 4;",
      "+const delta = 5;",
      "+const epsilon = 6;",
      "+const zeta = 7;",
      "+const eta = 8;",
      "+const theta = 9;",
      "+const iota = 10;",
    ].join("\n");

    const markup = renderTimeline(
      <MessagesTimeline
        threadId={null}
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "work-entry",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "tool-2",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "File change",
              tone: "tool",
              itemType: "file_change",
              changedFiles: ["src/app.ts"],
              inlineDiff: {
                id: "tool-2",
                activityId: "tool-2",
                title: "Edit file",
                availability: "exact_patch",
                files: [{ path: "src/app.ts", additions: 8, deletions: 1 }],
                additions: 8,
                deletions: 1,
                unifiedDiff: longPatch,
              },
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:31.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("FileChange");
    expect(markup).toContain("File changes");
    expect(markup).toContain('data-compact-diff-expand-bar="true"');
  });

  it("renders command inline diffs with a Command changes header", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");

    const markup = renderTimeline(
      <MessagesTimeline
        threadId={null}
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "work-entry",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "command-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Command execution",
              tone: "tool",
              itemType: "command_execution",
              command: "mv src/old.ts src/new.ts",
              inlineDiff: {
                id: "command-1",
                activityId: "command-1",
                title: "Run command",
                availability: "summary_only",
                files: [{ path: "src/new.ts", kind: "renamed" }],
              },
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:31.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Command");
    expect(markup).toContain("Command changes");
    expect(markup).not.toContain("Tool changes");
    expect(markup).toContain("Patch unavailable for this tool call.");
  });
});
