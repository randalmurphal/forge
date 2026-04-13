import {
  EventId,
  MessageId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@forgetools/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveBackgroundTrayState,
  deriveWorkLogEntries,
  filterTrayOwnedWorkEntries,
} from "./session-logic";

function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
  sequence?: number;
}): OrchestrationThreadActivity {
  const payload = overrides.payload ?? {};
  return {
    id: EventId.makeUnsafe(overrides.id ?? crypto.randomUUID()),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload,
    turnId: overrides.turnId ? TurnId.makeUnsafe(overrides.turnId) : null,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}

describe("deriveWorkLogEntries", () => {
  it("omits non-command tool started entries and keeps completed entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "tool-start",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Tool call",
        kind: "tool.started",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("keeps command tool.started entries so running commands are visible", () => {
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          id: "command-start",
          createdAt: "2026-02-23T00:00:02.000Z",
          kind: "tool.started",
          summary: "Command started",
          payload: {
            itemType: "command_execution",
            itemId: "command-live-1",
            status: "inProgress",
            data: {
              item: {
                id: "command-live-1",
                command: ["/bin/zsh", "-lc", "sleep 30"],
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entry).toMatchObject({
      id: "command-start",
      activityKind: "tool.started",
      itemType: "command_execution",
      itemStatus: "inProgress",
      toolCallId: "command-live-1",
      command: "/bin/zsh -lc sleep 30",
    });
  });

  it("collapses command tool.started into the later completion entry", () => {
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          id: "command-start",
          createdAt: "2026-02-23T00:00:02.000Z",
          kind: "tool.started",
          summary: "Command started",
          payload: {
            itemType: "command_execution",
            itemId: "command-collapse-1",
            status: "inProgress",
            data: {
              item: {
                id: "command-collapse-1",
                command: ["/bin/zsh", "-lc", "sleep 5"],
              },
            },
          },
        }),
        makeActivity({
          id: "command-complete",
          createdAt: "2026-02-23T00:00:07.000Z",
          kind: "tool.completed",
          summary: "Command",
          payload: {
            itemType: "command_execution",
            itemId: "command-collapse-1",
            status: "completed",
            data: {
              item: {
                id: "command-collapse-1",
                command: ["/bin/zsh", "-lc", "sleep 5"],
                aggregatedOutput: "done",
                exitCode: 0,
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entry).toMatchObject({
      id: "command-complete",
      activityKind: "tool.completed",
      itemType: "command_execution",
      itemStatus: "completed",
      toolCallId: "command-collapse-1",
      startedAt: "2026-02-23T00:00:02.000Z",
      output: "done",
    });
  });

  it("collapses command lifecycle entries even when other activities are interleaved", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "command-start",
          createdAt: "2026-02-23T00:00:02.000Z",
          kind: "tool.started",
          summary: "Command started",
          payload: {
            itemType: "command_execution",
            itemId: "command-interleaved-1",
            status: "inProgress",
            data: {
              item: {
                id: "command-interleaved-1",
                command: ["/bin/zsh", "-lc", "sleep 5"],
              },
            },
          },
        }),
        makeActivity({
          id: "read-file",
          createdAt: "2026-02-23T00:00:03.000Z",
          kind: "tool.completed",
          summary: "Read file",
          payload: {
            itemType: "file_read",
            status: "completed",
            data: {
              input: {
                path: "README.md",
              },
            },
          },
        }),
        makeActivity({
          id: "command-complete",
          createdAt: "2026-02-23T00:00:07.000Z",
          kind: "tool.completed",
          summary: "Command",
          payload: {
            itemType: "command_execution",
            itemId: "command-interleaved-1",
            status: "completed",
            data: {
              item: {
                id: "command-interleaved-1",
                command: ["/bin/zsh", "-lc", "sleep 5"],
                aggregatedOutput: "done",
                exitCode: 0,
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.toolCallId === "command-interleaved-1")).toMatchObject({
      id: "command-complete",
      activityKind: "tool.completed",
      itemStatus: "completed",
      startedAt: "2026-02-23T00:00:02.000Z",
    });
    expect(entries.find((entry) => entry.id === "read-file")?.itemType).toBe("file_read");
  });

  it("omits task start and completion lifecycle entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        summary: "default task started",
        tone: "info",
      }),
      makeActivity({
        id: "task-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Updating files",
        tone: "info",
      }),
      makeActivity({
        id: "task-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        summary: "Task completed",
        tone: "info",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["task-progress"]);
  });

  it("filters by turn id when provided", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "turn-1", turnId: "turn-1", summary: "Tool call", kind: "tool.started" }),
      makeActivity({
        id: "turn-2",
        turnId: "turn-2",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({ id: "no-turn", summary: "Checkpoint captured", tone: "info" }),
    ];

    const entries = deriveWorkLogEntries(activities, TurnId.makeUnsafe("turn-2"));
    expect(entries.map((entry) => entry.id)).toEqual(["turn-2"]);
  });

  it("omits checkpoint captured info entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "checkpoint",
        createdAt: "2026-02-23T00:00:01.000Z",
        summary: "Checkpoint captured",
        tone: "info",
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Ran command",
        tone: "tool",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("omits ExitPlanMode lifecycle entries once the plan card is shown", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "exit-plan-updated",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          detail: 'ExitPlanMode: {"allowedPrompts":[{"tool":"Bash","prompt":"run tests"}]}',
        },
      }),
      makeActivity({
        id: "exit-plan-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          detail: "ExitPlanMode: {}",
        },
      }),
      makeActivity({
        id: "real-work-log",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          detail: "Bash: bun test",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["real-work-log"]);
  });

  it("orders work log by activity sequence when present", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "second",
        createdAt: "2026-02-23T00:00:03.000Z",
        sequence: 2,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "first",
        createdAt: "2026-02-23T00:00:04.000Z",
        sequence: 1,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["first", "second"]);
  });

  it("extracts command text for command tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: ["bun", "run", "lint"],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe("bun run lint");
  });

  it("keeps compact Codex tool metadata used for icons and labels", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-with-metadata",
        kind: "tool.completed",
        summary: "bash",
        payload: {
          itemType: "command_execution",
          title: "bash",
          status: "completed",
          detail: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
          data: {
            item: {
              command: ["bun", "run", "dev"],
              result: {
                content: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
                exitCode: 0,
              },
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      command: "bun run dev",
      detail: '{ "dev": "vite dev --port 3000" }',
      itemType: "command_execution",
      toolTitle: "bash",
    });
  });

  it("extracts changed file paths from persisted tool diff artifacts", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-tool",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          inlineDiff: {
            availability: "summary_only",
            files: [
              { path: "apps/web/src/components/ChatView.tsx" },
              { path: "apps/web/src/session-logic.ts" },
            ],
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.changedFiles).toEqual([
      "apps/web/src/components/ChatView.tsx",
      "apps/web/src/session-logic.ts",
    ]);
  });

  it("keeps historical tool rows across turns in all-turns scope", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-turn-1",
        turnId: "turn-1",
        kind: "tool.completed",
        summary: "Edited file",
        payload: {
          itemType: "file_change",
          title: "Edit",
          detail: "Updated README",
        },
      }),
      makeActivity({
        id: "tool-turn-2",
        turnId: "turn-2",
        kind: "tool.completed",
        summary: "Edited file",
        payload: {
          itemType: "file_change",
          title: "Edit",
          detail: "Updated README",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, { scope: "all-turns" });
    expect(entries.map((entry) => entry.id)).toEqual(["tool-turn-1", "tool-turn-2"]);
  });

  it("reads an exact tool patch from a persisted inline diff artifact", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-tool-with-patch",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          inlineDiff: {
            availability: "exact_patch",
            files: [{ path: "apps/web/src/app.tsx", additions: 1, deletions: 0 }],
            additions: 1,
            deletions: 0,
            unifiedDiff: [
              "diff --git a/apps/web/src/app.tsx b/apps/web/src/app.tsx",
              "--- a/apps/web/src/app.tsx",
              "+++ b/apps/web/src/app.tsx",
              "@@ -1 +1,2 @@",
              " export const App = () => null;",
              "+console.log('changed');",
            ].join("\n"),
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, { scope: "all-turns" });
    expect(entry?.inlineDiff).toMatchObject({
      availability: "exact_patch",
      additions: 1,
      deletions: 0,
      files: [{ path: "apps/web/src/app.tsx", additions: 1, deletions: 0 }],
    });
  });

  it("does not parse raw payload diffs when no persisted inline diff artifact exists", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-tool-with-hunk",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          data: {
            item: {
              changes: [{ path: "apps/server/src/orchestration/projector.test.ts" }],
            },
            diff: [
              "@@ -199,12 +199,12 @@",
              '           diff: "diff --git a/src/app.ts b/src/app.ts\\n+hello\\n",',
              '-          files: [{ path: "src/app.ts", additions: 1, deletions: 0 }],',
              '+          files: [{ path: "src/app.ts", kind: "modified", additions: 1, deletions: 0 }],',
            ].join("\n"),
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, { scope: "all-turns" });
    expect(entry?.inlineDiff).toBeUndefined();
  });

  it("does not create a diff block for file-change tools without patch or file metadata", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "empty-file-change",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          data: {
            item: {},
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, { scope: "all-turns" });
    expect(entry?.inlineDiff).toBeUndefined();
  });

  it("does not create a tool diff block for non-file-change tools even when their payload contains diff-like text", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-with-diff-output",
        kind: "tool.completed",
        summary: "Command execution",
        payload: {
          itemType: "command_execution",
          title: "Command execution",
          data: {
            diff: [
              "diff --git a/apps/web/src/app.tsx b/apps/web/src/app.tsx",
              "--- a/apps/web/src/app.tsx",
              "+++ b/apps/web/src/app.tsx",
              "@@ -1 +1,2 @@",
              " export const App = () => null;",
              "+console.log('changed');",
            ].join("\n"),
            item: {
              command: ["git", "diff", "--", "apps/web/src/app.tsx"],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, { scope: "all-turns" });
    expect(entry?.itemType).toBe("command_execution");
    expect(entry?.inlineDiff).toBeUndefined();
  });

  it("reads persisted exact inline diffs for command rows", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-with-inline-diff",
        kind: "tool.completed",
        summary: "Command execution",
        payload: {
          itemType: "command_execution",
          title: "Run command",
          inlineDiff: {
            availability: "exact_patch",
            files: [{ path: "src/remove.ts", kind: "deleted", deletions: 1 }],
            deletions: 1,
            unifiedDiff: [
              "diff --git a/src/remove.ts b/src/remove.ts",
              "deleted file mode 100644",
              "--- a/src/remove.ts",
              "+++ /dev/null",
              "@@ -1,1 +0,0 @@",
              "-export const removed = true;",
            ].join("\n"),
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, { scope: "all-turns" });
    expect(entry?.itemType).toBe("command_execution");
    expect(entry?.changedFiles).toEqual(["src/remove.ts"]);
    expect(entry?.inlineDiff).toMatchObject({
      availability: "exact_patch",
      files: [{ path: "src/remove.ts", kind: "deleted", deletions: 1 }],
      deletions: 1,
    });
  });

  it("reads summary-only persisted inline diffs for command rows", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-summary-only-diff",
        kind: "tool.completed",
        summary: "Command execution",
        payload: {
          itemType: "command_execution",
          title: "Run command",
          inlineDiff: {
            availability: "summary_only",
            files: [{ path: "src/new.ts", kind: "renamed" }],
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, { scope: "all-turns" });
    expect(entry?.inlineDiff).toMatchObject({
      availability: "summary_only",
      files: [{ path: "src/new.ts", kind: "renamed" }],
    });
    expect(entry?.changedFiles).toEqual(["src/new.ts"]);
  });

  it("reads summary-only persisted artifacts without attempting client-side patch reconstruction", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "mixed-file-change",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          inlineDiff: {
            availability: "summary_only",
            files: [
              { path: "diff-render-smoke/tool-created-file.md", kind: "added" },
              { path: "diff-render-smoke/tool-deleted-file.md", kind: "deleted" },
              { path: "apps/web/src/session-logic.ts", kind: "modified" },
            ],
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, { scope: "all-turns" });
    expect(entry?.inlineDiff).toMatchObject({
      availability: "summary_only",
      files: [
        { path: "diff-render-smoke/tool-created-file.md" },
        { path: "diff-render-smoke/tool-deleted-file.md" },
        { path: "apps/web/src/session-logic.ts" },
      ],
    });
    expect(entry?.inlineDiff?.unifiedDiff).toBeUndefined();
  });

  it("collapses repeated lifecycle updates for the same tool call into one entry", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-update-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-update-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
          data: {
            item: {
              command: ["sed", "-n", "1,40p", "/tmp/app.ts"],
            },
          },
        },
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "tool-complete",
      createdAt: "2026-02-23T00:00:01.000Z",
      completedAt: "2026-02-23T00:00:03.000Z",
      label: "Tool call completed",
      detail: '{"file_path":"/tmp/app.ts"}',
      command: "sed -n 1,40p /tmp/app.ts",
      itemType: "dynamic_tool_call",
      toolTitle: "Tool call",
    });
  });

  it("preserves an exact file-change patch when the completion row only has summary metadata", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-change-updated",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "File change",
        payload: {
          itemType: "file_change",
          title: "File change",
          detail: "Editing apps/web/src/session-logic.ts",
          inlineDiff: {
            availability: "exact_patch",
            files: [{ path: "apps/web/src/session-logic.ts", kind: "modified" }],
            unifiedDiff: [
              "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts",
              "--- a/apps/web/src/session-logic.ts",
              "+++ b/apps/web/src/session-logic.ts",
              "@@ -1 +1,2 @@",
              " export const value = 1;",
              "+export const next = 2;",
            ].join("\n"),
          },
        },
      }),
      makeActivity({
        id: "file-change-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "File change completed",
        payload: {
          itemType: "file_change",
          title: "File change",
          detail: "Updated 1 file",
          inlineDiff: {
            availability: "summary_only",
            files: [{ path: "apps/web/src/session-logic.ts", kind: "modified" }],
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, { scope: "all-turns" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "file-change-completed",
      inlineDiff: {
        availability: "exact_patch",
        files: [{ path: "apps/web/src/session-logic.ts" }],
      },
    });
  });

  it("preserves an exact command patch when the completion row only has summary metadata", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-updated",
        createdAt: "2026-02-23T00:00:01.000Z",
        turnId: "turn-1",
        kind: "tool.updated",
        summary: "Command execution",
        payload: {
          itemType: "command_execution",
          itemId: "command-tool-a",
          title: "Run command",
          inlineDiff: {
            availability: "exact_patch",
            files: [{ path: "src/new.ts", kind: "renamed" }],
            unifiedDiff: [
              "diff --git a/src/old.ts b/src/new.ts",
              "rename from src/old.ts",
              "rename to src/new.ts",
              "--- a/src/old.ts",
              "+++ b/src/new.ts",
            ].join("\n"),
          },
        },
      }),
      makeActivity({
        id: "command-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        turnId: "turn-1",
        kind: "tool.completed",
        summary: "Command completed",
        payload: {
          itemType: "command_execution",
          itemId: "command-tool-a",
          title: "Run command",
          inlineDiff: {
            availability: "summary_only",
            files: [{ path: "src/new.ts", kind: "renamed" }],
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, { scope: "all-turns" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "command-completed",
      inlineDiff: {
        availability: "exact_patch",
        files: [{ path: "src/new.ts", kind: "renamed" }],
      },
    });
  });

  it("collapses file-change lifecycle rows even when file order changes between updates", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-change-updated",
        createdAt: "2026-02-23T00:00:01.000Z",
        turnId: "turn-1",
        kind: "tool.updated",
        summary: "File change",
        payload: {
          itemType: "file_change",
          title: "File change",
          inlineDiff: {
            availability: "summary_only",
            files: [
              { path: "apps/web/src/session-logic.ts" },
              { path: "apps/web/src/components/ChatView.tsx" },
            ],
          },
        },
      }),
      makeActivity({
        id: "file-change-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        turnId: "turn-1",
        kind: "tool.completed",
        summary: "File change completed",
        payload: {
          itemType: "file_change",
          title: "File change",
          inlineDiff: {
            availability: "summary_only",
            files: [
              { path: "apps/web/src/components/ChatView.tsx" },
              { path: "apps/web/src/session-logic.ts" },
            ],
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, { scope: "all-turns" });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("file-change-completed");
    expect(entries[0]?.changedFiles).toEqual([
      "apps/web/src/session-logic.ts",
      "apps/web/src/components/ChatView.tsx",
    ]);
  });

  it("does not double-count per-file stats when collapsing repeated file-change lifecycle rows", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-change-updated",
        createdAt: "2026-02-23T00:00:01.000Z",
        turnId: "turn-1",
        kind: "tool.updated",
        summary: "File change",
        payload: {
          itemType: "file_change",
          itemId: "tool-a",
          title: "File change",
          inlineDiff: {
            availability: "summary_only",
            files: [
              {
                path: "apps/web/src/session-logic.ts",
                additions: 1,
                deletions: 0,
              },
            ],
          },
        },
      }),
      makeActivity({
        id: "file-change-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        turnId: "turn-1",
        kind: "tool.completed",
        summary: "File change completed",
        payload: {
          itemType: "file_change",
          itemId: "tool-a",
          title: "File change",
          inlineDiff: {
            availability: "summary_only",
            files: [
              {
                path: "apps/web/src/session-logic.ts",
                additions: 1,
                deletions: 0,
              },
            ],
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, { scope: "all-turns" });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.inlineDiff).toMatchObject({
      files: [{ path: "apps/web/src/session-logic.ts", additions: 1, deletions: 0 }],
      additions: 1,
      deletions: 0,
    });
  });

  it("keeps separate file-change tool rows when two different tool ids touch the same files", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-change-tool-a",
        createdAt: "2026-02-23T00:00:01.000Z",
        turnId: "turn-1",
        kind: "tool.updated",
        summary: "File change",
        payload: {
          itemType: "file_change",
          itemId: "tool-a",
          title: "File change",
          inlineDiff: {
            availability: "summary_only",
            files: [{ path: "apps/web/src/session-logic.ts" }],
          },
        },
      }),
      makeActivity({
        id: "file-change-tool-b",
        createdAt: "2026-02-23T00:00:02.000Z",
        turnId: "turn-1",
        kind: "tool.updated",
        summary: "File change",
        payload: {
          itemType: "file_change",
          itemId: "tool-b",
          title: "File change",
          inlineDiff: {
            availability: "summary_only",
            files: [{ path: "apps/web/src/session-logic.ts" }],
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, { scope: "all-turns" });
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.toolCallId)).toEqual(["tool-a", "tool-b"]);
  });

  it("keeps separate tool entries when an identical call starts after the prior one completed", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-1-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-1-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-update",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-complete",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries.map((entry) => entry.id)).toEqual(["tool-1-complete", "tool-2-complete"]);
  });

  it("collapses same-timestamp lifecycle rows even when completed sorts before updated by id", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "z-update-earlier",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "a-complete-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "z-update-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("a-complete-same-timestamp");
  });

  it("extracts agent enrichments from Claude-shaped payload", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "agent-claude",
        kind: "tool.completed",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          title: "Subagent task",
          toolName: "Agent",
          detail:
            'Agent: {"description":"Find edge cases","subagent_type":"Reviewer","model":"opus","prompt":"Review the auth module"}',
          data: {
            toolName: "Agent",
            input: {
              description: "Find edge cases",
              subagent_type: "Reviewer",
              model: "opus",
              prompt: "Review the auth module for security issues",
            },
          },
          childThreadAttribution: { taskId: "test-task", childProviderThreadId: "test-thread" },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      itemType: "collab_agent_tool_call",
      toolName: "Agent",
      agentDescription: "Find edge cases",
      agentType: "Reviewer",
      agentModel: "opus",
      agentPrompt: "Review the auth module for security issues",
    });
  });

  it("extracts agent enrichments from Codex-shaped payload", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "agent-codex",
        kind: "tool.completed",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          title: "Subagent task",
          toolName: "collabAgentToolCall",
          detail: "Refactor the auth module",
          data: {
            item: {
              type: "collabAgentToolCall",
              id: "call_collab_1",
              receiverThreadIds: ["child_thread_1"],
              description: "Refactor the auth module",
              prompt: "Write unit tests for the parser module",
            },
          },
          childThreadAttribution: { taskId: "test-task", childProviderThreadId: "test-thread" },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      itemType: "collab_agent_tool_call",
      toolName: "collabAgentToolCall",
      agentDescription: "Refactor the auth module",
      agentPrompt: "Write unit tests for the parser module",
    });
    // Codex does not provide subagent_type or model
    expect(entry?.agentType).toBeUndefined();
    expect(entry?.agentModel).toBeUndefined();
  });

  it("falls back gracefully when agent enrichment fields are absent", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "agent-minimal",
        kind: "tool.completed",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          title: "Subagent task",
          toolName: "Task",
          detail: "Task: some detail",
          data: {
            toolName: "Task",
            input: {},
          },
          childThreadAttribution: { taskId: "test-task", childProviderThreadId: "test-thread" },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.itemType).toBe("collab_agent_tool_call");
    expect(entry?.agentDescription).toBeUndefined();
    expect(entry?.agentType).toBeUndefined();
    expect(entry?.agentModel).toBeUndefined();
    expect(entry?.agentPrompt).toBeUndefined();
  });

  it("filters out unattributed collab noise while keeping visible parent control calls inline", () => {
    const activities: OrchestrationThreadActivity[] = [
      // Should be retained: visible control call without attribution
      makeActivity({
        id: "orphaned-started",
        kind: "tool.started",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          title: "Subagent task",
          toolName: "Agent",
          data: {
            item: {
              tool: "spawnAgent",
              model: "gpt-5.4-mini",
              prompt: "Inspect the parser",
              receiverThreadIds: ["child-thread-control"],
            },
          },
        },
      }),
      // Should be filtered out: generic unattributed collab noise
      makeActivity({
        id: "orphaned-updated",
        kind: "tool.updated",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          title: "Subagent task",
          toolName: "Agent",
        },
      }),
      // Should be retained: the terminal inline launch record for the same visible control call
      makeActivity({
        id: "orphaned-completed",
        kind: "tool.completed",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          title: "Subagent task",
          toolName: "Agent",
        },
      }),
      // Should be retained: collab_agent_tool_call WITH attribution
      makeActivity({
        id: "attributed-updated",
        kind: "tool.updated",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          title: "Subagent task",
          toolName: "Agent",
          toolCallId: "call-2",
          childThreadAttribution: { taskId: "task-2", childProviderThreadId: "thread-2" },
        },
      }),
      makeActivity({
        id: "attributed-completed",
        kind: "tool.completed",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          title: "Subagent task",
          toolName: "Agent",
          childThreadAttribution: { taskId: "task-1", childProviderThreadId: "thread-1" },
        },
      }),
      // Should be retained: non-collab_agent_tool_call without attribution
      makeActivity({
        id: "regular-tool",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          title: "Ran command",
          toolName: "Bash",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    const ids = entries.map((e) => e.id);

    expect(ids).toContain("orphaned-completed");
    expect(ids).not.toContain("orphaned-updated");
    expect(ids).not.toContain("orphaned-started");
    expect(ids).toContain("attributed-updated");
    expect(ids).toContain("attributed-completed");
    expect(ids).toContain("regular-tool");
  });

  it("preserves visible collab control call metadata for inline rendering", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "spawn-inline",
          kind: "tool.completed",
          summary: "Subagent task",
          payload: {
            itemType: "collab_agent_tool_call",
            data: {
              item: {
                id: "spawn-inline",
                tool: "spawnAgent",
                model: "gpt-5.4-mini",
                prompt: "Inspect the parser",
                receiverThreadIds: ["child-thread-inline"],
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entries).toContainEqual(
      expect.objectContaining({
        id: "spawn-inline",
        itemType: "collab_agent_tool_call",
        toolName: "spawnAgent",
        agentModel: "gpt-5.4-mini",
        agentPrompt: "Inspect the parser",
        receiverThreadIds: ["child-thread-inline"],
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        activityKind: "task.started",
        childThreadAttribution: expect.objectContaining({
          taskId: "spawn-inline",
          childProviderThreadId: "child-thread-inline",
        }),
      }),
    );
  });

  it("keeps visible wait_agent start events inline before completion", () => {
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          id: "wait-started-inline",
          kind: "tool.started",
          summary: "Subagent wait",
          payload: {
            itemType: "collab_agent_tool_call",
            status: "inProgress",
            data: {
              item: {
                id: "wait-inline",
                tool: "wait",
                prompt: "Wait for child completion",
                receiverThreadIds: ["child-thread-inline"],
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entry).toMatchObject({
      id: "wait-started-inline",
      activityKind: "tool.started",
      itemType: "collab_agent_tool_call",
      toolName: "wait",
      itemStatus: "inProgress",
    });
  });

  it("keeps wait_agent rows anchored at the start timestamp after completion", () => {
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          id: "wait-started-stable",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.started",
          summary: "Subagent wait",
          payload: {
            itemType: "collab_agent_tool_call",
            status: "inProgress",
            data: {
              item: {
                id: "wait-stable",
                tool: "wait",
                prompt: "Wait for child completion",
                receiverThreadIds: ["child-thread-stable"],
              },
            },
          },
        }),
        makeActivity({
          id: "wait-completed-stable",
          createdAt: "2026-04-10T12:00:15.000Z",
          kind: "tool.completed",
          summary: "Subagent wait",
          payload: {
            itemType: "collab_agent_tool_call",
            status: "completed",
            data: {
              item: {
                id: "wait-stable",
                tool: "wait",
                prompt: "Wait for child completion",
                receiverThreadIds: ["child-thread-stable"],
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entry).toMatchObject({
      id: "wait-completed-stable",
      createdAt: "2026-04-10T12:00:00.000Z",
      completedAt: "2026-04-10T12:00:15.000Z",
      activityKind: "tool.completed",
      itemType: "collab_agent_tool_call",
      toolName: "wait",
      itemStatus: "completed",
    });
  });

  it("synthesizes a running subagent start from spawn_agent before child activity arrives", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "spawn-started-inline",
          kind: "tool.started",
          summary: "Spawned subagent",
          payload: {
            itemType: "collab_agent_tool_call",
            data: {
              item: {
                id: "spawn-task-1",
                tool: "spawnAgent",
                prompt: "Inspect the parser",
                model: "gpt-5.4-mini",
                receiverThreadIds: ["child-thread-early"],
              },
            },
          },
        }),
      ],
      undefined,
    );

    const trayState = deriveBackgroundTrayState(entries, "2026-04-10T12:00:01.000Z");
    expect(trayState.subagentGroups).toHaveLength(1);
    expect(trayState.subagentGroups[0]).toMatchObject({
      childProviderThreadId: "child-thread-early",
      taskId: "spawn-task-1",
      status: "running",
      label: "Inspect the parser",
      agentModel: "gpt-5.4-mini",
    });
  });

  it("carries target metadata into wait_agent rows", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "spawn-completed-inline",
          kind: "tool.completed",
          summary: "Spawned subagent",
          payload: {
            itemType: "collab_agent_tool_call",
            data: {
              item: {
                id: "spawn-task-2",
                tool: "spawnAgent",
                prompt: "Audit the parser",
                model: "gpt-5.4-mini",
                receiverThreadIds: ["child-thread-wait"],
              },
            },
          },
        }),
        makeActivity({
          id: "wait-started-with-target",
          kind: "tool.started",
          summary: "Waited for subagent",
          payload: {
            itemType: "collab_agent_tool_call",
            data: {
              item: {
                id: "wait-task-2",
                tool: "wait",
                receiverThreadIds: ["child-thread-wait"],
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "wait-started-with-target",
          toolName: "wait",
          agentDescription: "Audit the parser",
          agentModel: "gpt-5.4-mini",
        }),
      ]),
    );
  });

  it("synthesizes a completed Codex subagent lifecycle entry when only the parent collab item completes", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "codex-collab-complete",
          kind: "tool.completed",
          summary: "Subagent task",
          payload: {
            itemType: "collab_agent_tool_call",
            data: {
              item: {
                id: "task-codex-1",
                prompt: "Review the parser",
                model: "gpt-5.4-mini",
                status: "completed",
                receiverThreadIds: ["child-thread-1"],
                agentsStates: {
                  "child-thread-1": {
                    status: "completed",
                  },
                },
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      activityKind: "task.completed",
      itemStatus: "completed",
      childThreadAttribution: {
        taskId: "task-codex-1",
        childProviderThreadId: "child-thread-1",
        label: "Review the parser",
        agentModel: "gpt-5.4-mini",
      },
    });
  });

  it("does not synthesize a Codex subagent completion from the parent collab item status alone", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "codex-collab-payload-status-complete",
          kind: "tool.completed",
          summary: "Subagent task",
          payload: {
            itemType: "collab_agent_tool_call",
            status: "completed",
            data: {
              item: {
                id: "task-codex-payload-status",
                prompt: "Review tray rendering",
                receiverThreadIds: ["child-thread-2"],
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entries).toEqual([]);
  });

  it.each(["errored", "interrupted", "notFound"] as const)(
    "maps Codex fallback agent state %s to failed",
    (status) => {
      const [entry] = deriveWorkLogEntries(
        [
          makeActivity({
            id: `codex-collab-${status}`,
            kind: "tool.completed",
            summary: "Subagent task",
            payload: {
              itemType: "collab_agent_tool_call",
              data: {
                item: {
                  id: `task-${status}`,
                  prompt: "Investigate failures",
                  receiverThreadIds: ["child-thread-1"],
                  agentsStates: {
                    "child-thread-1": {
                      status,
                    },
                  },
                },
              },
            },
          }),
        ],
        undefined,
      );

      expect(entry).toMatchObject({
        activityKind: "task.completed",
        tone: "error",
        itemStatus: "failed",
      });
    },
  );

  it("keeps a Codex spawned subagent running when spawn_agent completes but the child agent is still pending", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "codex-collab-parent-complete-child-pending",
          kind: "tool.completed",
          summary: "Subagent task",
          payload: {
            itemType: "collab_agent_tool_call",
            status: "completed",
            data: {
              item: {
                id: "task-parent-complete-child-pending",
                tool: "spawnAgent",
                status: "completed",
                prompt: "Inspect tray state",
                receiverThreadIds: ["child-thread-3"],
                agentsStates: {
                  "child-thread-3": {
                    status: "pendingInit",
                  },
                },
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entries).toContainEqual(
      expect.objectContaining({
        id: "codex-collab-parent-complete-child-pending",
        itemType: "collab_agent_tool_call",
        toolName: "spawnAgent",
        receiverThreadIds: ["child-thread-3"],
        itemStatus: "completed",
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        activityKind: "task.started",
        itemStatus: "inProgress",
        childThreadAttribution: expect.objectContaining({
          taskId: "task-parent-complete-child-pending",
          childProviderThreadId: "child-thread-3",
        }),
      }),
    );
  });

  it("prefers a real attributed task.completed over a synthetic Codex fallback completion", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "codex-parent-complete",
          kind: "tool.completed",
          summary: "Subagent task",
          payload: {
            itemType: "collab_agent_tool_call",
            data: {
              item: {
                id: "task-real-complete",
                prompt: "Investigate regressions",
                receiverThreadIds: ["child-thread-1"],
                agentsStates: {
                  "child-thread-1": {
                    status: "completed",
                  },
                },
              },
            },
          },
        }),
        makeActivity({
          id: "real-task-complete",
          kind: "task.completed",
          summary: "Task completed",
          tone: "info",
          payload: {
            taskId: "task-real-complete",
            status: "completed",
            childThreadAttribution: {
              taskId: "task-real-complete",
              childProviderThreadId: "child-thread-1",
            },
          },
        }),
      ],
      undefined,
    );

    const completedEntries = entries.filter((entry) => entry.activityKind === "task.completed");
    expect(completedEntries).toHaveLength(1);
    expect(completedEntries[0]?.id).toBe("real-task-complete");
  });

  it.each(["wait", "sendInput"] as const)(
    "does not synthesize an orphan fallback subagent completion from Codex control tool %s",
    (tool) => {
      const entries = deriveWorkLogEntries(
        [
          makeActivity({
            id: `codex-control-${tool}`,
            kind: "tool.completed",
            summary: "Subagent task",
            payload: {
              itemType: "collab_agent_tool_call",
              data: {
                item: {
                  id: `control-${tool}`,
                  tool,
                  prompt: "This should not become a subagent",
                  receiverThreadIds: ["child-thread-1"],
                  agentsStates: {
                    "child-thread-1": {
                      status: "completed",
                    },
                  },
                },
              },
            },
          }),
        ],
        undefined,
      );

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        id: `codex-control-${tool}`,
        itemType: "collab_agent_tool_call",
        toolName: tool,
        receiverThreadIds: ["child-thread-1"],
      });
    },
  );

  it("does not synthesize a fallback subagent completion from a timed-out wait_agent call", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "timed-out-wait",
          kind: "tool.completed",
          summary: "Subagent wait",
          payload: {
            itemType: "collab_agent_tool_call",
            data: {
              item: {
                id: "wait-timed-out",
                tool: "wait",
                receiverThreadIds: [],
                agentsStates: {},
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "timed-out-wait",
      itemType: "collab_agent_tool_call",
      toolName: "wait",
      itemStatus: "completed",
    });
  });

  it("synthesizes a fallback subagent completion from wait_agent when a known child reaches a terminal state", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "child-command-start",
          kind: "tool.started",
          summary: "Command started",
          payload: {
            itemType: "command_execution",
            itemId: "child-command-1",
            status: "inProgress",
            data: {
              item: {
                id: "child-command-1",
                command: ["/bin/zsh", "-lc", "sleep 120"],
              },
            },
            childThreadAttribution: {
              taskId: "task-known-child",
              childProviderThreadId: "child-thread-known",
              label: "Known child",
            },
          },
        }),
        makeActivity({
          id: "wait-completed",
          createdAt: "2026-04-10T12:00:05.000Z",
          kind: "tool.completed",
          summary: "Subagent wait",
          payload: {
            itemType: "collab_agent_tool_call",
            data: {
              item: {
                id: "wait-completed",
                tool: "wait",
                receiverThreadIds: ["child-thread-known"],
                agentsStates: {
                  "child-thread-known": {
                    status: "completed",
                  },
                },
              },
            },
          },
        }),
      ],
      undefined,
    );

    const completedEntries = entries.filter((entry) => entry.activityKind === "task.completed");
    expect(completedEntries).toHaveLength(1);
    expect(completedEntries[0]).toMatchObject({
      itemStatus: "completed",
      childThreadAttribution: {
        childProviderThreadId: "child-thread-known",
      },
    });
  });

  it("keeps full Claude command output and marks explicit background commands", () => {
    const longOutput = `${"stdout line\n".repeat(80)}stderr line`;
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          id: "claude-command",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            status: "completed",
            data: {
              input: {
                command: "bun run lint",
                run_in_background: true,
              },
              result: {
                stdout: `${"stdout line\n".repeat(80)}`,
                stderr: "stderr line",
                exit_code: 0,
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entry?.output).toBe(longOutput);
    expect(entry?.outputSource).toBe("final");
    expect(entry?.isBackgroundCommand).toBe(true);
  });

  it("keeps full Codex aggregated command output", () => {
    const output = `${"build line\n".repeat(90)}done`;
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          id: "codex-command",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            status: "completed",
            data: {
              item: {
                id: "codex-command-1",
                command: ["bun", "run", "build"],
                aggregatedOutput: output,
                exitCode: 0,
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entry?.output).toBe(output);
    expect(entry?.outputSource).toBe("final");
  });

  it("marks sanitized command payloads as having output without requiring the full text", () => {
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          id: "sanitized-command",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            status: "completed",
            outputSummary: {
              available: true,
              source: "final",
              byteLength: 2048,
            },
            data: {
              item: {
                id: "sanitized-command-1",
                command: ["bun", "run", "build"],
                exitCode: 0,
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entry?.hasOutput).toBe(true);
    expect(entry?.output).toBeUndefined();
    expect(entry?.outputByteLength).toBe(2048);
    expect(entry?.outputSource).toBe("final");
  });

  it("keeps Codex unified-exec commands inline when no background signal exists", () => {
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          id: "codex-unified-exec",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            status: "completed",
            itemId: "codex-unified-exec-1",
            data: {
              item: {
                id: "codex-unified-exec-1",
                command: ["/bin/zsh", "-lc", "bun run build --watch"],
                source: "unifiedExecStartup",
                processId: "proc-build-watch",
                aggregatedOutput: "watching...\n",
                exitCode: 0,
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entry?.isBackgroundCommand).toBeUndefined();
    expect(entry?.commandSource).toBe("unifiedExecStartup");
    expect(entry?.processId).toBe("proc-build-watch");
  });

  it("only marks commands as background when run_in_background is explicitly true", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "background-command",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            data: {
              input: {
                command: "bun run build",
                run_in_background: true,
              },
            },
          },
        }),
        makeActivity({
          id: "foreground-command",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            data: {
              input: {
                command: "bun run test",
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entries.find((entry) => entry.id === "background-command")?.isBackgroundCommand).toBe(
      true,
    );
    expect(
      entries.find((entry) => entry.id === "foreground-command")?.isBackgroundCommand,
    ).toBeUndefined();
  });

  it("marks a Codex unified-exec command as background from terminal interaction", () => {
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          id: "background-command-start",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.started",
          summary: "Command started",
          payload: {
            itemType: "command_execution",
            itemId: "background-command-1",
            status: "inProgress",
            data: {
              item: {
                id: "background-command-1",
                command: ["/bin/zsh", "-lc", "bun run build --watch"],
                source: "unifiedExecStartup",
                processId: "proc-watch-1",
              },
            },
          },
        }),
        makeActivity({
          id: "background-command-terminal-interaction",
          createdAt: "2026-04-10T12:00:01.000Z",
          kind: "tool.terminal.interaction",
          summary: "Background terminal waited",
          payload: {
            itemId: "background-command-1",
            processId: "proc-watch-1",
            stdin: "",
          },
        }),
      ],
      undefined,
    );

    expect(entry?.toolCallId).toBe("background-command-1");
    expect(entry?.isBackgroundCommand).toBe(true);
  });

  it("keeps a Codex background launch row separate from the later terminal completion", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "codex-background-launch",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.started",
          summary: "Command started",
          sequence: 11,
          payload: {
            itemType: "command_execution",
            itemId: "codex-background-2",
            status: "inProgress",
            data: {
              item: {
                id: "codex-background-2",
                command: ["/bin/zsh", "-lc", "sleep 20"],
                source: "unifiedExecStartup",
                processId: "proc-background-2",
              },
            },
          },
        }),
        makeActivity({
          id: "codex-background-terminal-interaction",
          createdAt: "2026-04-10T12:00:01.000Z",
          kind: "tool.terminal.interaction",
          summary: "Background terminal waited",
          sequence: 12,
          payload: {
            itemId: "codex-background-2",
            processId: "proc-background-2",
            stdin: "",
          },
        }),
        makeActivity({
          id: "codex-background-complete",
          createdAt: "2026-04-10T12:00:20.000Z",
          kind: "tool.completed",
          summary: "Ran command",
          sequence: 19,
          payload: {
            itemType: "command_execution",
            itemId: "codex-background-2",
            status: "completed",
            data: {
              item: {
                id: "codex-background-2",
                command: ["/bin/zsh", "-lc", "sleep 20"],
                source: "unifiedExecStartup",
                processId: "proc-background-2",
                aggregatedOutput: "done\n",
                exitCode: 0,
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entries.map((entry) => entry.id)).toEqual([
      "codex-background-launch",
      "codex-background-complete",
    ]);
    expect(entries[0]).toMatchObject({
      id: "codex-background-launch",
      activityKind: "tool.started",
      isBackgroundCommand: true,
      backgroundLifecycleRole: "launch",
      itemStatus: "inProgress",
      backgroundTaskStatus: "completed",
      backgroundCompletedAt: "2026-04-10T12:00:20.000Z",
    });
    expect(entries[1]).toMatchObject({
      id: "codex-background-complete",
      activityKind: "tool.completed",
      isBackgroundCommand: true,
      backgroundLifecycleRole: "completion",
      itemStatus: "completed",
      output: "done\n",
      exitCode: 0,
    });
  });

  it("keeps the Codex background launch row non-terminal even after the completion row exists", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "codex-background-launch-status",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.started",
          summary: "Command started",
          payload: {
            itemType: "command_execution",
            itemId: "codex-background-status-1",
            status: "inProgress",
            data: {
              item: {
                id: "codex-background-status-1",
                command: ["/bin/zsh", "-lc", "sleep 20"],
                source: "unifiedExecStartup",
                processId: "proc-background-status-1",
              },
            },
          },
        }),
        makeActivity({
          id: "codex-background-terminal-wait-status",
          createdAt: "2026-04-10T12:00:01.000Z",
          kind: "tool.terminal.interaction",
          summary: "Background terminal waited",
          payload: {
            itemId: "codex-background-status-1",
            processId: "proc-background-status-1",
            stdin: "",
          },
        }),
        makeActivity({
          id: "codex-background-complete-status",
          createdAt: "2026-04-10T12:00:20.000Z",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            itemId: "codex-background-status-1",
            status: "completed",
            data: {
              item: {
                id: "codex-background-status-1",
                command: ["/bin/zsh", "-lc", "sleep 20"],
                source: "unifiedExecStartup",
                processId: "proc-background-status-1",
                aggregatedOutput: "done\n",
                exitCode: 0,
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entries[0]).toMatchObject({
      id: "codex-background-launch-status",
      activityKind: "tool.started",
      backgroundLifecycleRole: "launch",
      itemStatus: "inProgress",
      completedAt: undefined,
    });
    expect(entries[1]).toMatchObject({
      id: "codex-background-complete-status",
      activityKind: "tool.completed",
      backgroundLifecycleRole: "completion",
      itemStatus: "completed",
      completedAt: "2026-04-10T12:00:20.000Z",
    });
  });

  it("marks a Codex unified-exec command as background when later work begins while it is still running", () => {
    const turnId = TurnId.makeUnsafe("turn-overlap-1");
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "long-command-start",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.started",
          summary: "Command started",
          turnId: turnId,
          payload: {
            itemType: "command_execution",
            itemId: "command-overlap-1",
            status: "inProgress",
            data: {
              item: {
                id: "command-overlap-1",
                command: ["/bin/zsh", "-lc", "sleep 30"],
                source: "unifiedExecStartup",
                processId: "proc-overlap-1",
              },
            },
          },
        }),
        makeActivity({
          id: "subagent-work",
          createdAt: "2026-04-10T12:00:10.000Z",
          kind: "task.started",
          summary: "Task started",
          tone: "info",
          turnId: turnId,
          payload: {
            taskId: "spawned-child",
            childThreadAttribution: {
              taskId: "spawned-child",
              childProviderThreadId: "child-thread-1",
              label: "Inspect parser",
            },
          },
        }),
        makeActivity({
          id: "long-command-complete",
          createdAt: "2026-04-10T12:00:30.000Z",
          kind: "tool.completed",
          summary: "Ran command",
          turnId: turnId,
          payload: {
            itemType: "command_execution",
            itemId: "command-overlap-1",
            status: "completed",
            data: {
              item: {
                id: "command-overlap-1",
                command: ["/bin/zsh", "-lc", "sleep 30"],
                aggregatedOutput: "done",
                exitCode: 0,
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(
      entries.find((entry) => entry.toolCallId === "command-overlap-1")?.isBackgroundCommand,
    ).toBe(true);
  });

  it("keeps a top-level command inline when later work starts after it completes", () => {
    const turnId = TurnId.makeUnsafe("turn-foreground-inline");
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "foreground-command-start",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.started",
          summary: "Command started",
          turnId: turnId,
          payload: {
            itemType: "command_execution",
            itemId: "foreground-command-1",
            status: "inProgress",
            data: {
              item: {
                id: "foreground-command-1",
                command: ["/bin/zsh", "-lc", "sleep 1"],
                source: "unifiedExecStartup",
                processId: "proc-foreground-1",
              },
            },
          },
        }),
        makeActivity({
          id: "foreground-command-complete",
          createdAt: "2026-04-10T12:00:01.000Z",
          kind: "tool.completed",
          summary: "Ran command",
          turnId: turnId,
          payload: {
            itemType: "command_execution",
            itemId: "foreground-command-1",
            status: "completed",
            data: {
              item: {
                id: "foreground-command-1",
                command: ["/bin/zsh", "-lc", "sleep 1"],
                aggregatedOutput: "done",
                exitCode: 0,
              },
            },
          },
        }),
        makeActivity({
          id: "later-unrelated-work",
          createdAt: "2026-04-10T12:00:03.000Z",
          kind: "tool.completed",
          summary: "Read file",
          turnId: turnId,
          payload: {
            itemType: "file_read",
            status: "completed",
            data: {
              input: {
                path: "README.md",
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(
      entries.find((entry) => entry.toolCallId === "foreground-command-1")?.isBackgroundCommand,
    ).toBeUndefined();
  });

  it("marks a Codex unified-exec command as background when an assistant message arrives while it is still running", () => {
    const turnId = TurnId.makeUnsafe("turn-assistant-message");
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          id: "assistant-message-command-start",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.started",
          summary: "Command started",
          turnId: turnId,
          payload: {
            itemType: "command_execution",
            itemId: "assistant-message-command-1",
            status: "inProgress",
            data: {
              item: {
                id: "assistant-message-command-1",
                command: ["/bin/zsh", "-lc", "bun run dev"],
                source: "unifiedExecStartup",
                processId: "proc-assistant-message-1",
              },
            },
          },
        }),
        makeActivity({
          id: "assistant-message-command-complete",
          createdAt: "2026-04-10T12:00:10.000Z",
          kind: "tool.completed",
          summary: "Ran command",
          turnId: turnId,
          payload: {
            itemType: "command_execution",
            itemId: "assistant-message-command-1",
            status: "completed",
            data: {
              item: {
                id: "assistant-message-command-1",
                command: ["/bin/zsh", "-lc", "bun run dev"],
                source: "unifiedExecStartup",
                processId: "proc-assistant-message-1",
                aggregatedOutput: "ready\n",
                exitCode: 0,
              },
            },
          },
        }),
      ],
      {
        scope: "all-turns",
        messages: [
          {
            id: MessageId.makeUnsafe("assistant-message-1"),
            role: "assistant",
            text: "Build watcher is running in the background.",
            turnId,
            createdAt: "2026-04-10T12:00:05.000Z",
            streaming: false,
          },
        ],
      },
    );

    expect(entry?.toolCallId).toBe("assistant-message-command-1");
    expect(entry?.isBackgroundCommand).toBe(true);
  });

  it("marks a Codex unified-exec command as background when the turn completes while it is still running", () => {
    const turnId = TurnId.makeUnsafe("turn-completed-while-open");
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          id: "turn-complete-command-start",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.started",
          summary: "Command started",
          turnId: turnId,
          payload: {
            itemType: "command_execution",
            itemId: "turn-complete-command-1",
            status: "inProgress",
            data: {
              item: {
                id: "turn-complete-command-1",
                command: ["/bin/zsh", "-lc", "bun run watch"],
                source: "unifiedExecStartup",
                processId: "proc-turn-complete-1",
              },
            },
          },
        }),
        makeActivity({
          id: "turn-complete-command-complete",
          createdAt: "2026-04-10T12:00:12.000Z",
          kind: "tool.completed",
          summary: "Ran command",
          turnId: turnId,
          payload: {
            itemType: "command_execution",
            itemId: "turn-complete-command-1",
            status: "completed",
            data: {
              item: {
                id: "turn-complete-command-1",
                command: ["/bin/zsh", "-lc", "bun run watch"],
                source: "unifiedExecStartup",
                processId: "proc-turn-complete-1",
                aggregatedOutput: "watcher finished\n",
                exitCode: 0,
              },
            },
          },
        }),
      ],
      {
        scope: "all-turns",
        latestTurn: {
          turnId,
          startedAt: "2026-04-10T12:00:00.000Z",
          completedAt: "2026-04-10T12:00:05.000Z",
        },
      },
    );

    expect(entry?.toolCallId).toBe("turn-complete-command-1");
    expect(entry?.isBackgroundCommand).toBe(true);
  });

  it("falls back to streamed command output when no final output is present", () => {
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          id: "stream-before-row",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.output.delta",
          summary: "Command output updated",
          payload: {
            itemId: "command-stream-1",
            streamKind: "command_output",
            delta: "[watch] bundling...\n",
          },
        }),
        makeActivity({
          id: "command-row",
          createdAt: "2026-04-10T12:00:01.000Z",
          kind: "tool.updated",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            itemId: "command-stream-1",
            status: "inProgress",
            data: {
              item: {
                id: "command-stream-1",
                command: ["bun", "run", "build", "--watch"],
              },
            },
          },
        }),
        makeActivity({
          id: "stream-after-row",
          createdAt: "2026-04-10T12:00:02.000Z",
          kind: "tool.output.delta",
          summary: "Command output updated",
          payload: {
            itemId: "command-stream-1",
            streamKind: "command_output",
            delta: "[watch] waiting for changes...\n",
          },
        }),
      ],
      undefined,
    );

    expect(entry?.output).toBe("[watch] bundling...\n[watch] waiting for changes...\n");
    expect(entry?.outputSource).toBe("stream");
  });

  it("marks sanitized streamed command output as available when only delta lengths are present", () => {
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          id: "sanitized-stream-before-row",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.output.delta",
          summary: "Command output updated",
          payload: {
            itemId: "command-stream-sanitized-1",
            streamKind: "command_output",
            deltaLength: 22,
          },
        }),
        makeActivity({
          id: "sanitized-command-row",
          createdAt: "2026-04-10T12:00:01.000Z",
          kind: "tool.updated",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            itemId: "command-stream-sanitized-1",
            status: "inProgress",
            data: {
              item: {
                id: "command-stream-sanitized-1",
                command: ["bun", "run", "build", "--watch"],
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entry?.hasOutput).toBe(true);
    expect(entry?.output).toBeUndefined();
    expect(entry?.outputSource).toBe("stream");
  });

  it("derives transient background tray visibility for running and recently completed background commands", () => {
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "background-running",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.updated",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            status: "inProgress",
            data: {
              input: {
                command: "bun run build --watch",
                run_in_background: true,
              },
            },
          },
        }),
        makeActivity({
          id: "background-completed",
          createdAt: "2026-04-10T12:00:02.000Z",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            status: "completed",
            data: {
              input: {
                command: "bun run build",
                run_in_background: true,
              },
              result: {
                output: "done",
                exit_code: 0,
              },
            },
          },
        }),
      ],
      undefined,
    );

    const visibleState = deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:06.000Z");
    expect(visibleState.commandEntries.map((entry) => entry.id)).toEqual([
      "background-running",
      "background-completed",
    ]);
    expect(visibleState.hiddenWorkEntryIds).toEqual([]);

    const expiredState = deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:08.500Z");
    expect(expiredState.commandEntries.map((entry) => entry.id)).toEqual(["background-running"]);
    expect(expiredState.hiddenWorkEntryIds).toEqual([]);
  });

  it("keeps a Claude background bash command in the tray while its background task is still running", () => {
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "claude-background-command",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            status: "completed",
            itemId: "tool-bash-bg-1",
            data: {
              toolName: "Bash",
              input: {
                command: "sleep 20",
                run_in_background: true,
              },
              result: {
                stdout: "",
                stderr: "",
                exit_code: 0,
              },
              toolUseResult: {
                backgroundTaskId: "task-bash-bg-1",
              },
            },
          },
        }),
        makeActivity({
          id: "claude-background-task-started",
          createdAt: "2026-04-10T12:00:01.000Z",
          kind: "task.started",
          summary: "Background bash is running",
          payload: {
            taskId: "task-bash-bg-1",
            toolUseId: "tool-bash-bg-1",
            description: "Background bash is running",
          },
        }),
        makeActivity({
          id: "claude-background-task-progress",
          createdAt: "2026-04-10T12:00:02.000Z",
          kind: "task.progress",
          summary: "Background bash is still running",
          payload: {
            taskId: "task-bash-bg-1",
            toolUseId: "tool-bash-bg-1",
            description: "Background bash is still running",
          },
        }),
      ],
      undefined,
    );

    const trayState = deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:03.000Z");
    expect(trayState.commandEntries).toHaveLength(1);
    expect(trayState.commandEntries[0]).toMatchObject({
      id: "claude-background-command",
      isBackgroundCommand: true,
      backgroundTaskId: "task-bash-bg-1",
      backgroundTaskStatus: "running",
    });
    expect(trayState.hiddenWorkEntryIds).toEqual([]);

    const visibleEntries = filterTrayOwnedWorkEntries(workEntries, trayState);
    expect(visibleEntries.map((entry) => entry.id)).toEqual(["claude-background-command"]);
  });

  it("hides Claude parent-thread background task progress rows after they are folded into the command lifecycle", () => {
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "claude-background-command",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            status: "completed",
            itemId: "tool-bash-bg-2",
            data: {
              toolName: "Bash",
              input: {
                command: "sleep 20",
                run_in_background: true,
              },
              result: {
                stdout: "",
                stderr: "",
                exit_code: 0,
              },
              toolUseResult: {
                backgroundTaskId: "task-bash-bg-2",
              },
            },
          },
        }),
        makeActivity({
          id: "claude-background-task-progress",
          createdAt: "2026-04-10T12:00:02.000Z",
          kind: "task.progress",
          summary: "Background bash is still running",
          payload: {
            taskId: "task-bash-bg-2",
            toolUseId: "tool-bash-bg-2",
            description: "Background bash is still running",
          },
        }),
      ],
      undefined,
    );

    expect(workEntries.map((entry) => entry.id)).toEqual(["claude-background-command"]);
    expect(workEntries[0]).toMatchObject({
      backgroundTaskId: "task-bash-bg-2",
      backgroundTaskStatus: "running",
    });
  });

  it("returns a Claude background bash command to history only after the background task completes", () => {
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "claude-background-command",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            status: "completed",
            itemId: "tool-bash-bg-3",
            data: {
              toolName: "Bash",
              input: {
                command: "sleep 20",
                run_in_background: true,
              },
              result: {
                stdout: "",
                stderr: "",
                exit_code: 0,
              },
              toolUseResult: {
                backgroundTaskId: "task-bash-bg-3",
              },
            },
          },
        }),
        makeActivity({
          id: "claude-background-task-started",
          createdAt: "2026-04-10T12:00:01.000Z",
          kind: "task.started",
          summary: "Background bash is running",
          payload: {
            taskId: "task-bash-bg-3",
            toolUseId: "tool-bash-bg-3",
            description: "Background bash is running",
          },
        }),
        makeActivity({
          id: "claude-background-task-completed",
          createdAt: "2026-04-10T12:00:20.000Z",
          kind: "task.completed",
          summary: "Background bash completed",
          payload: {
            taskId: "task-bash-bg-3",
            toolUseId: "tool-bash-bg-3",
            status: "completed",
          },
        }),
      ],
      undefined,
    );

    const runningState = deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:10.000Z");
    expect(runningState.commandEntries[0]).toMatchObject({
      backgroundTaskStatus: "completed",
      backgroundCompletedAt: "2026-04-10T12:00:20.000Z",
    });

    const visibleImmediatelyAfterCompletion = filterTrayOwnedWorkEntries(
      workEntries,
      deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:20.500Z"),
    );
    expect(visibleImmediatelyAfterCompletion.map((entry) => entry.id)).toEqual([
      "claude-background-command",
      "claude-background-command:background-task-completed",
    ]);
  });

  it("keeps a Claude Agent launch row inline instead of filtering it as Codex-only control traffic", () => {
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "claude-agent-started",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.started",
          summary: "Spawned subagent",
          payload: {
            itemType: "collab_agent_tool_call",
            toolName: "Agent",
            data: {
              toolName: "Agent",
              input: {
                description: "Inspect tray rendering",
                prompt: "Run exactly these checks and report completion only.",
                run_in_background: true,
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(workEntries).toEqual([
      expect.objectContaining({
        id: "claude-agent-started",
        itemType: "collab_agent_tool_call",
        toolName: "Agent",
        agentDescription: "Inspect tray rendering",
        agentPrompt: "Run exactly these checks and report completion only.",
      }),
    ]);
  });

  it("collapses a Claude Agent launch into one inline row even when the start payload is empty", () => {
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "claude-agent-started-empty",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.started",
          summary: "Subagent task started",
          payload: {
            itemType: "collab_agent_tool_call",
            itemId: "runtime-agent-row-1",
            status: "inProgress",
            toolName: "Agent",
            detail: "Agent",
            data: {
              toolName: "Agent",
              input: {},
            },
          },
        }),
        makeActivity({
          id: "claude-agent-updated",
          createdAt: "2026-04-10T12:00:00.050Z",
          kind: "tool.updated",
          summary: "Subagent task",
          payload: {
            itemType: "collab_agent_tool_call",
            itemId: "runtime-agent-row-1",
            status: "inProgress",
            toolName: "Agent",
            detail: "Agent: Inspect tray rendering",
            data: {
              toolName: "Agent",
              input: {
                description: "Inspect tray rendering",
                prompt: "Run exactly these checks and report completion only.",
                run_in_background: true,
              },
            },
          },
        }),
        makeActivity({
          id: "claude-agent-completed",
          createdAt: "2026-04-10T12:00:00.100Z",
          kind: "tool.completed",
          summary: "Subagent task",
          payload: {
            itemType: "collab_agent_tool_call",
            itemId: "runtime-agent-row-1",
            status: "completed",
            toolName: "Agent",
            detail: "Agent: Inspect tray rendering",
            data: {
              toolName: "Agent",
              input: {
                description: "Inspect tray rendering",
                prompt: "Run exactly these checks and report completion only.",
                run_in_background: true,
              },
              toolUseResult: {
                status: "async_launched",
                agentId: "agent-bg-1",
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(workEntries).toHaveLength(1);
    expect(workEntries[0]).toMatchObject({
      id: "claude-agent-completed",
      toolCallId: "runtime-agent-row-1",
      itemType: "collab_agent_tool_call",
      toolName: "Agent",
      itemStatus: "completed",
      detail: "Inspect tray rendering",
      agentDescription: "Inspect tray rendering",
      agentPrompt: "Run exactly these checks and report completion only.",
    });
  });

  it("tracks a Claude background bash command from launch to terminal task notification", () => {
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "claude-bash-started",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.started",
          summary: "Command started",
          payload: {
            itemType: "command_execution",
            itemId: "runtime-bash-row-1",
            status: "inProgress",
            toolName: "Bash",
            detail: 'Bash: sleep 20 && echo "Bash background done"',
            data: {
              toolName: "Bash",
              input: {
                command: 'sleep 20 && echo "Bash background done"',
                description: "Sleep 20 seconds then print done",
                run_in_background: true,
              },
            },
          },
        }),
        makeActivity({
          id: "claude-bash-launch-completed",
          createdAt: "2026-04-10T12:00:00.100Z",
          kind: "tool.completed",
          summary: "Command",
          payload: {
            itemType: "command_execution",
            itemId: "runtime-bash-row-1",
            status: "completed",
            toolName: "Bash",
            detail:
              "Bash: Command running in background with ID: b5fuznvy7. Output is being written to: /tmp/tasks/b5fuznvy7.output",
            data: {
              toolName: "Bash",
              input: {
                command: 'sleep 20 && echo "Bash background done"',
                description: "Sleep 20 seconds then print done",
                run_in_background: true,
              },
              result: {
                stdout: "",
                stderr: "",
              },
              toolUseResult: {
                backgroundTaskId: "b5fuznvy7",
              },
            },
          },
        }),
        makeActivity({
          id: "claude-bash-task-started",
          createdAt: "2026-04-10T12:00:00.120Z",
          kind: "task.started",
          summary: "local_bash task started",
          payload: {
            taskId: "b5fuznvy7",
            toolUseId: "toolu_01DhucoM2FdeeMKCPqRzX3bM",
            detail: "Sleep 20 seconds then print done",
          },
        }),
        makeActivity({
          id: "claude-bash-task-completed",
          createdAt: "2026-04-10T12:00:20.000Z",
          kind: "task.completed",
          summary: "Task completed",
          payload: {
            taskId: "b5fuznvy7",
            toolUseId: "toolu_01DhucoM2FdeeMKCPqRzX3bM",
            status: "completed",
            detail: 'Background command "Sleep 20 seconds then print done" completed (exit code 0)',
            outputFile: "/tmp/tasks/b5fuznvy7.output",
          },
        }),
      ],
      undefined,
    );

    expect(workEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "claude-bash-launch-completed",
          activityKind: "tool.completed",
          toolCallId: "runtime-bash-row-1",
          itemType: "command_execution",
          isBackgroundCommand: true,
          backgroundTaskId: "b5fuznvy7",
          backgroundTaskStatus: "completed",
          backgroundCompletedAt: "2026-04-10T12:00:20.000Z",
        }),
        expect.objectContaining({
          id: "claude-bash-launch-completed:background-task-completed",
          activityKind: "task.completed",
          toolCallId: "runtime-bash-row-1",
          itemType: "command_execution",
          isBackgroundCommand: true,
          backgroundTaskStatus: "completed",
          backgroundCompletedAt: "2026-04-10T12:00:20.000Z",
        }),
      ]),
    );

    const runningTrayState = deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:20.500Z");
    expect(runningTrayState.commandEntries).toHaveLength(1);
    expect(runningTrayState.commandEntries[0]).toMatchObject({
      id: "claude-bash-launch-completed",
      backgroundTaskStatus: "completed",
    });

    const visibleEntries = filterTrayOwnedWorkEntries(workEntries, runningTrayState);
    expect(visibleEntries.map((entry) => entry.id)).toEqual([
      "claude-bash-launch-completed",
      "claude-bash-launch-completed:background-task-completed",
    ]);

    const expiredTrayState = deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:26.000Z");
    expect(expiredTrayState.commandEntries).toEqual([]);
  });

  it("treats a blocked Claude TaskOutput result as the terminal signal for a background bash task", () => {
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "claude-bash-started",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.started",
          summary: "Command started",
          payload: {
            itemType: "command_execution",
            itemId: "toolu_bash_launch",
            status: "inProgress",
            toolName: "Bash",
            detail: "Bash: sleep 20 && echo done",
            data: {
              toolName: "Bash",
              input: {
                command: "sleep 20 && echo done",
                description: "Sleep 20 seconds then print done",
                run_in_background: true,
              },
            },
          },
        }),
        makeActivity({
          id: "claude-bash-launch-completed",
          createdAt: "2026-04-10T12:00:00.100Z",
          kind: "tool.completed",
          summary: "Command",
          payload: {
            itemType: "command_execution",
            itemId: "toolu_bash_launch",
            status: "completed",
            toolName: "Bash",
            detail: "Bash: Command running in background with ID: bazncp4aq.",
            data: {
              toolName: "Bash",
              input: {
                command: "sleep 20 && echo done",
                description: "Sleep 20 seconds then print done",
                run_in_background: true,
              },
              toolUseResult: {
                backgroundTaskId: "bazncp4aq",
              },
            },
          },
        }),
        makeActivity({
          id: "claude-bash-task-started",
          createdAt: "2026-04-10T12:00:00.120Z",
          kind: "task.started",
          summary: "local_bash task started",
          payload: {
            taskId: "bazncp4aq",
            toolUseId: "toolu_bash_launch",
            detail: "Sleep 20 seconds then print done",
          },
        }),
        makeActivity({
          id: "taskoutput-completed",
          createdAt: "2026-04-10T12:00:20.000Z",
          kind: "tool.completed",
          summary: "Tool call",
          payload: {
            itemType: "dynamic_tool_call",
            itemId: "toolu_taskoutput_wait",
            status: "completed",
            toolName: "TaskOutput",
            detail: 'TaskOutput: {"task_id":"bazncp4aq","block":true,"timeout":60000}',
            data: {
              toolName: "TaskOutput",
              input: {
                task_id: "bazncp4aq",
                block: true,
                timeout: 60000,
              },
              toolUseResult: {
                retrieval_status: "success",
                task: {
                  task_id: "bazncp4aq",
                  task_type: "local_bash",
                  status: "completed",
                  description: "Sleep 20 seconds then print done",
                  output: "done\n",
                  exitCode: 0,
                },
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(workEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "claude-bash-launch-completed",
          activityKind: "tool.completed",
          backgroundTaskId: "bazncp4aq",
          backgroundTaskStatus: "completed",
          backgroundCompletedAt: "2026-04-10T12:00:20.000Z",
        }),
        expect.objectContaining({
          id: "claude-bash-launch-completed:background-task-completed",
          activityKind: "task.completed",
          backgroundTaskId: "bazncp4aq",
          backgroundTaskStatus: "completed",
          backgroundCompletedAt: "2026-04-10T12:00:20.000Z",
        }),
      ]),
    );

    const trayState = deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:20.500Z");
    expect(trayState.commandEntries).toEqual([
      expect.objectContaining({
        id: "claude-bash-launch-completed",
        backgroundTaskStatus: "completed",
      }),
    ]);
  });

  it("moves a Claude background agent from running to completed on task notification", () => {
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "claude-agent-launch-started",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.started",
          summary: "Subagent task started",
          payload: {
            itemType: "collab_agent_tool_call",
            itemId: "runtime-agent-launch-1",
            status: "inProgress",
            toolName: "Agent",
            detail: "Agent: 20-second sleep subagent",
            data: {
              toolName: "Agent",
              input: {
                description: "20-second sleep subagent",
                prompt:
                  'Run a bash command: sleep 20 && echo "Subagent sleep done". Report back the output when it finishes.',
                run_in_background: true,
              },
            },
          },
        }),
        makeActivity({
          id: "claude-agent-launch-completed",
          createdAt: "2026-04-10T12:00:00.100Z",
          kind: "tool.completed",
          summary: "Subagent task",
          payload: {
            itemType: "collab_agent_tool_call",
            itemId: "runtime-agent-launch-1",
            status: "completed",
            toolName: "Agent",
            detail: "Agent: 20-second sleep subagent",
            data: {
              toolName: "Agent",
              input: {
                description: "20-second sleep subagent",
                prompt:
                  'Run a bash command: sleep 20 && echo "Subagent sleep done". Report back the output when it finishes.',
                run_in_background: true,
              },
              toolUseResult: {
                isAsync: true,
                status: "async_launched",
                agentId: "a8aec202a0c364c0c",
                description: "20-second sleep subagent",
                prompt:
                  'Run a bash command: sleep 20 && echo "Subagent sleep done". Report back the output when it finishes.',
                outputFile: "/tmp/tasks/a8aec202a0c364c0c.output",
              },
            },
          },
        }),
        makeActivity({
          id: "claude-agent-task-started",
          createdAt: "2026-04-10T12:00:00.120Z",
          kind: "task.started",
          summary: "local_agent task started",
          payload: {
            taskId: "a8aec202a0c364c0c",
            toolUseId: "toolu_01GaTXWTd9hCLgWwDFCD4hwH",
            detail: "20-second sleep subagent",
            childThreadAttribution: {
              taskId: "toolu_01GaTXWTd9hCLgWwDFCD4hwH",
              childProviderThreadId: "toolu_01GaTXWTd9hCLgWwDFCD4hwH",
              label: "20-second sleep subagent",
            },
          },
        }),
        makeActivity({
          id: "claude-agent-task-progress",
          createdAt: "2026-04-10T12:00:05.000Z",
          kind: "task.progress",
          summary: "Reasoning update",
          payload: {
            taskId: "a8aec202a0c364c0c",
            toolUseId: "toolu_01GaTXWTd9hCLgWwDFCD4hwH",
            detail: "The spawned agent is still sleeping.",
            lastToolName: "Bash",
            childThreadAttribution: {
              taskId: "toolu_01GaTXWTd9hCLgWwDFCD4hwH",
              childProviderThreadId: "toolu_01GaTXWTd9hCLgWwDFCD4hwH",
              label: "20-second sleep subagent",
            },
          },
        }),
        makeActivity({
          id: "claude-agent-task-completed",
          createdAt: "2026-04-10T12:00:20.000Z",
          kind: "task.completed",
          summary: "Task completed",
          payload: {
            taskId: "a8aec202a0c364c0c",
            toolUseId: "toolu_01GaTXWTd9hCLgWwDFCD4hwH",
            status: "completed",
            detail: 'Agent "20-second sleep subagent" completed',
            outputFile: "/tmp/tasks/a8aec202a0c364c0c.output",
            childThreadAttribution: {
              taskId: "toolu_01GaTXWTd9hCLgWwDFCD4hwH",
              childProviderThreadId: "toolu_01GaTXWTd9hCLgWwDFCD4hwH",
              label: "20-second sleep subagent",
            },
          },
        }),
      ],
      undefined,
    );

    const launchEntries = workEntries.filter(
      (entry) => entry.itemType === "collab_agent_tool_call" && !entry.childThreadAttribution,
    );
    expect(launchEntries).toEqual([
      expect.objectContaining({
        id: "claude-agent-launch-completed",
        toolCallId: "runtime-agent-launch-1",
        toolName: "Agent",
        itemStatus: "completed",
        agentDescription: "20-second sleep subagent",
      }),
    ]);

    const trayState = deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:20.500Z");
    expect(trayState.subagentGroups).toEqual([
      expect.objectContaining({
        groupId: "toolu_01GaTXWTd9hCLgWwDFCD4hwH",
        taskId: "toolu_01GaTXWTd9hCLgWwDFCD4hwH",
        status: "completed",
        label: "20-second sleep subagent",
      }),
    ]);

    const visibleEntries = filterTrayOwnedWorkEntries(workEntries, trayState);
    expect(visibleEntries.map((entry) => entry.id)).toEqual([
      "claude-agent-launch-completed",
      "claude-agent-task-started",
      "claude-agent-task-progress",
      "claude-agent-task-completed",
    ]);

    const expiredTrayState = deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:26.000Z");
    expect(expiredTrayState.subagentGroups).toEqual([]);
  });

  it("treats a blocked Claude TaskOutput result as the terminal signal for a background agent", () => {
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "claude-agent-launch-started",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.started",
          summary: "Subagent task started",
          payload: {
            itemType: "collab_agent_tool_call",
            itemId: "toolu_agent_launch",
            status: "inProgress",
            toolName: "Agent",
            detail: "Agent: Sleep 10 then report done",
            data: {
              toolName: "Agent",
              input: {
                description: "Sleep 10 then report done",
                prompt: 'Run the command `sleep 10` in bash, then report "done".',
                run_in_background: true,
              },
            },
          },
        }),
        makeActivity({
          id: "claude-agent-launch-completed",
          createdAt: "2026-04-10T12:00:00.100Z",
          kind: "tool.completed",
          summary: "Subagent task",
          payload: {
            itemType: "collab_agent_tool_call",
            itemId: "toolu_agent_launch",
            status: "completed",
            toolName: "Agent",
            detail: "Agent: Sleep 10 then report done",
            data: {
              toolName: "Agent",
              input: {
                description: "Sleep 10 then report done",
                prompt: 'Run the command `sleep 10` in bash, then report "done".',
                run_in_background: true,
              },
              toolUseResult: {
                isAsync: true,
                status: "async_launched",
                agentId: "a4e7522e10810bf7a",
                description: "Sleep 10 then report done",
                prompt: 'Run the command `sleep 10` in bash, then report "done".',
              },
            },
          },
        }),
        makeActivity({
          id: "claude-agent-task-started",
          createdAt: "2026-04-10T12:00:00.120Z",
          kind: "task.started",
          summary: "local_agent task started",
          payload: {
            taskId: "a4e7522e10810bf7a",
            toolUseId: "toolu_agent_launch",
            detail: "Sleep 10 then report done",
            childThreadAttribution: {
              taskId: "toolu_agent_launch",
              childProviderThreadId: "toolu_agent_launch",
              label: "Sleep 10 then report done",
            },
          },
        }),
        makeActivity({
          id: "claude-agent-task-progress",
          createdAt: "2026-04-10T12:00:02.000Z",
          kind: "task.progress",
          summary: "Reasoning update",
          payload: {
            taskId: "a4e7522e10810bf7a",
            toolUseId: "toolu_agent_launch",
            detail: "Running Sleep for 10 seconds",
            childThreadAttribution: {
              taskId: "toolu_agent_launch",
              childProviderThreadId: "toolu_agent_launch",
              label: "Sleep 10 then report done",
            },
          },
        }),
        makeActivity({
          id: "taskoutput-agent-completed",
          createdAt: "2026-04-10T12:00:10.000Z",
          kind: "tool.completed",
          summary: "Tool call",
          payload: {
            itemType: "dynamic_tool_call",
            itemId: "toolu_taskoutput_agent_wait",
            status: "completed",
            toolName: "TaskOutput",
            detail: 'TaskOutput: {"task_id":"a4e7522e10810bf7a","block":true,"timeout":60000}',
            data: {
              toolName: "TaskOutput",
              input: {
                task_id: "a4e7522e10810bf7a",
                block: true,
                timeout: 60000,
              },
              toolUseResult: {
                retrieval_status: "success",
                task: {
                  task_id: "a4e7522e10810bf7a",
                  task_type: "local_agent",
                  status: "completed",
                  description: "Sleep 10 then report done",
                  prompt: 'Run the command `sleep 10` in bash, then report "done".',
                  output: "Done.",
                },
              },
            },
          },
        }),
      ],
      undefined,
    );

    const trayState = deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:10.500Z");
    expect(trayState.subagentGroups).toEqual([
      expect.objectContaining({
        groupId: "toolu_agent_launch",
        status: "completed",
        label: "Sleep 10 then report done",
      }),
    ]);
  });

  it("keeps the launch row inline and adds a separate history row when a background command completes", () => {
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "background-launch",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.completed",
          summary: "Command",
          payload: {
            itemType: "command_execution",
            itemId: "bg-command-row",
            status: "completed",
            toolName: "Bash",
            detail: "Bash: Command running in background with ID: bg-task-1.",
            data: {
              toolName: "Bash",
              input: {
                command: "sleep 20 && echo done",
                run_in_background: true,
              },
              toolUseResult: {
                backgroundTaskId: "bg-task-1",
              },
            },
          },
        }),
        makeActivity({
          id: "background-completed",
          createdAt: "2026-04-10T12:00:20.000Z",
          kind: "task.completed",
          summary: "Task completed",
          payload: {
            taskId: "bg-task-1",
            toolUseId: "bg-command-row",
            status: "completed",
            detail: 'Background command "sleep 20 && echo done" completed (exit code 0)',
          },
        }),
      ],
      undefined,
    );

    expect(workEntries.map((entry) => entry.id)).toEqual([
      "background-launch",
      "background-launch:background-task-completed",
    ]);
    expect(workEntries.map((entry) => entry.activityKind)).toEqual([
      "tool.completed",
      "task.completed",
    ]);
  });

  it("does not infer background tray ownership from overlap alone", () => {
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "long-command-start",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.started",
          summary: "Command started",
          payload: {
            itemType: "command_execution",
            itemId: "command-overlap-2",
            status: "inProgress",
            data: {
              item: {
                id: "command-overlap-2",
                command: ["/bin/zsh", "-lc", "sleep 30"],
              },
            },
          },
        }),
        makeActivity({
          id: "subagent-start",
          createdAt: "2026-04-10T12:00:05.000Z",
          kind: "task.started",
          summary: "Task started",
          tone: "info",
          payload: {
            taskId: "spawned-child",
            childThreadAttribution: {
              taskId: "spawned-child",
              childProviderThreadId: "child-thread-1",
              label: "Inspect parser",
            },
          },
        }),
      ],
      undefined,
    );

    const trayState = deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:06.500Z");
    expect(trayState.commandEntries.map((entry) => entry.toolCallId)).not.toContain(
      "command-overlap-2",
    );
  });

  it("carries spawn agent metadata into background tray subagent groups", () => {
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "spawn-agent-completed",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.completed",
          summary: "Subagent task",
          payload: {
            itemType: "collab_agent_tool_call",
            data: {
              item: {
                id: "spawn-agent-call",
                tool: "spawnAgent",
                description: "Inspect the parser",
                prompt: "Inspect the parser",
                model: "gpt-5.4-mini",
                receiverThreadIds: ["child-thread-meta"],
              },
            },
          },
        }),
        makeActivity({
          id: "child-command-start",
          createdAt: "2026-04-10T12:00:01.000Z",
          kind: "tool.started",
          summary: "Command started",
          payload: {
            itemType: "command_execution",
            itemId: "child-command-meta",
            status: "inProgress",
            data: {
              item: {
                id: "child-command-meta",
                command: ["/bin/zsh", "-lc", "sleep 120"],
              },
            },
            childThreadAttribution: {
              taskId: "spawn-agent-call",
              childProviderThreadId: "child-thread-meta",
            },
          },
        }),
      ],
      undefined,
    );

    const trayState = deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:03.000Z");
    expect(trayState.subagentGroups).toHaveLength(1);
    expect(trayState.subagentGroups[0]).toMatchObject({
      childProviderThreadId: "child-thread-meta",
      label: "Inspect the parser",
      agentDescription: "Inspect the parser",
      agentPrompt: "Inspect the parser",
      agentModel: "gpt-5.4-mini",
    });
  });

  it("keeps running background commands in the tray until they complete, then returns them to history", () => {
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "background-running",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.updated",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            status: "inProgress",
            data: {
              input: {
                command: "bun run build --watch",
                run_in_background: true,
              },
            },
          },
        }),
        makeActivity({
          id: "background-completed",
          createdAt: "2026-04-10T12:00:02.000Z",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            status: "completed",
            data: {
              input: {
                command: "bun run build",
                run_in_background: true,
              },
              result: {
                output: "done",
                exit_code: 0,
              },
            },
          },
        }),
        makeActivity({
          id: "foreground-command",
          createdAt: "2026-04-10T12:00:03.000Z",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            status: "completed",
            data: {
              input: {
                command: "bun run lint",
              },
            },
          },
        }),
      ],
      undefined,
    );

    const visibleWhileOwned = filterTrayOwnedWorkEntries(
      workEntries,
      deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:06.000Z"),
    );
    expect(visibleWhileOwned.map((entry) => entry.id)).toEqual([
      "background-running",
      "background-completed",
      "foreground-command",
    ]);

    const visibleAfterTtl = filterTrayOwnedWorkEntries(
      workEntries,
      deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:08.500Z"),
    );
    expect(visibleAfterTtl.map((entry) => entry.id)).toEqual([
      "background-running",
      "background-completed",
      "foreground-command",
    ]);
  });

  it("hides mixed-attribution subagent rows by child thread identity instead of raw task id", () => {
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "child-started-before-parent-mapping",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "task.started",
          summary: "Task started",
          payload: {
            taskId: "child-thread-1",
            childThreadAttribution: {
              taskId: "child-thread-1",
              childProviderThreadId: "child-thread-1",
            },
          },
        }),
        makeActivity({
          id: "child-progress-after-parent-mapping",
          createdAt: "2026-04-10T12:00:01.000Z",
          kind: "task.progress",
          summary: "Reasoning update",
          payload: {
            taskId: "call-collab-1",
            childThreadAttribution: {
              taskId: "call-collab-1",
              childProviderThreadId: "child-thread-1",
              label: "Inspect tray behavior",
            },
          },
        }),
        makeActivity({
          id: "foreground-command",
          createdAt: "2026-04-10T12:00:02.000Z",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            status: "completed",
            data: {
              input: {
                command: "bun run lint",
              },
            },
          },
        }),
      ],
      undefined,
    );

    const backgroundTrayState = deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:03.000Z");

    expect(backgroundTrayState.subagentGroups).toHaveLength(1);
    expect(backgroundTrayState.subagentGroups[0]).toMatchObject({
      groupId: "child-thread-1",
      taskId: "call-collab-1",
      label: "Inspect tray behavior",
      status: "running",
    });

    const visibleEntries = filterTrayOwnedWorkEntries(workEntries, backgroundTrayState);
    expect(visibleEntries.map((entry) => entry.id)).toEqual([
      "child-started-before-parent-mapping",
      "child-progress-after-parent-mapping",
      "foreground-command",
    ]);
  });

  it("completes a subagent group via terminal task.updated when no task.completed arrives", () => {
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "agent-launch-started",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.started",
          summary: "Subagent task started",
          payload: {
            itemType: "collab_agent_tool_call",
            itemId: "runtime-agent-1",
            status: "inProgress",
            toolName: "Agent",
            detail: "Agent: Run formatter",
            data: {
              toolName: "Agent",
              input: {
                description: "Run formatter",
                prompt: "Run bun fmt and report results.",
                run_in_background: true,
              },
            },
          },
        }),
        makeActivity({
          id: "agent-launch-completed",
          createdAt: "2026-04-10T12:00:00.100Z",
          kind: "tool.completed",
          summary: "Subagent task",
          payload: {
            itemType: "collab_agent_tool_call",
            itemId: "runtime-agent-1",
            status: "completed",
            toolName: "Agent",
            detail: "Agent: Run formatter",
            data: {
              toolName: "Agent",
              input: {
                description: "Run formatter",
                prompt: "Run bun fmt and report results.",
                run_in_background: true,
              },
              toolUseResult: {
                isAsync: true,
                status: "async_launched",
                agentId: "fmt-agent-001",
                description: "Run formatter",
                prompt: "Run bun fmt and report results.",
              },
            },
          },
        }),
        makeActivity({
          id: "agent-task-started",
          createdAt: "2026-04-10T12:00:00.120Z",
          kind: "task.started",
          summary: "local_agent task started",
          payload: {
            taskId: "fmt-agent-001",
            toolUseId: "toolu_fmt_launch",
            detail: "Run formatter",
            childThreadAttribution: {
              taskId: "toolu_fmt_launch",
              childProviderThreadId: "toolu_fmt_launch",
              label: "Run formatter",
            },
          },
        }),
        makeActivity({
          id: "agent-task-updated",
          createdAt: "2026-04-10T12:00:10.000Z",
          kind: "task.updated",
          summary: "Task updated",
          tone: "info",
          payload: {
            taskId: "fmt-agent-001",
            patch: {
              status: "completed",
            },
            childThreadAttribution: {
              taskId: "toolu_fmt_launch",
              childProviderThreadId: "toolu_fmt_launch",
              label: "Run formatter",
            },
          },
        }),
      ],
      undefined,
    );

    expect(workEntries.length).toBeGreaterThan(0);

    const trayState = deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:10.500Z");
    expect(trayState.subagentGroups).toEqual([
      expect.objectContaining({
        groupId: "toolu_fmt_launch",
        taskId: "toolu_fmt_launch",
        status: "completed",
        label: "Run formatter",
      }),
    ]);
  });

  it("handles both task.updated and task.completed arriving for the same subagent without conflicts", () => {
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "agent-launch-started",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.started",
          summary: "Subagent task started",
          payload: {
            itemType: "collab_agent_tool_call",
            itemId: "runtime-agent-2",
            status: "inProgress",
            toolName: "Agent",
            detail: "Agent: Build the project",
            data: {
              toolName: "Agent",
              input: {
                description: "Build the project",
                prompt: "Run bun run build and report the output.",
                run_in_background: true,
              },
            },
          },
        }),
        makeActivity({
          id: "agent-launch-completed",
          createdAt: "2026-04-10T12:00:00.100Z",
          kind: "tool.completed",
          summary: "Subagent task",
          payload: {
            itemType: "collab_agent_tool_call",
            itemId: "runtime-agent-2",
            status: "completed",
            toolName: "Agent",
            detail: "Agent: Build the project",
            data: {
              toolName: "Agent",
              input: {
                description: "Build the project",
                prompt: "Run bun run build and report the output.",
                run_in_background: true,
              },
              toolUseResult: {
                isAsync: true,
                status: "async_launched",
                agentId: "build-agent-001",
                description: "Build the project",
                prompt: "Run bun run build and report the output.",
              },
            },
          },
        }),
        makeActivity({
          id: "agent-task-started",
          createdAt: "2026-04-10T12:00:00.120Z",
          kind: "task.started",
          summary: "local_agent task started",
          payload: {
            taskId: "build-agent-001",
            toolUseId: "toolu_build_launch",
            detail: "Build the project",
            childThreadAttribution: {
              taskId: "toolu_build_launch",
              childProviderThreadId: "toolu_build_launch",
              label: "Build the project",
            },
          },
        }),
        makeActivity({
          id: "agent-task-updated",
          createdAt: "2026-04-10T12:00:08.000Z",
          kind: "task.updated",
          summary: "Task updated",
          tone: "info",
          payload: {
            taskId: "build-agent-001",
            patch: {
              status: "completed",
            },
            childThreadAttribution: {
              taskId: "toolu_build_launch",
              childProviderThreadId: "toolu_build_launch",
              label: "Build the project",
            },
          },
        }),
        makeActivity({
          id: "agent-task-completed",
          createdAt: "2026-04-10T12:00:10.000Z",
          kind: "task.completed",
          summary: "Task completed",
          payload: {
            taskId: "build-agent-001",
            toolUseId: "toolu_build_launch",
            status: "completed",
            detail: 'Agent "Build the project" completed',
            childThreadAttribution: {
              taskId: "toolu_build_launch",
              childProviderThreadId: "toolu_build_launch",
              label: "Build the project",
            },
          },
        }),
      ],
      undefined,
    );

    const trayState = deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:10.500Z");
    expect(trayState.subagentGroups).toEqual([
      expect.objectContaining({
        groupId: "toolu_build_launch",
        status: "completed",
        label: "Build the project",
      }),
    ]);

    // Verify no duplicate entries — task.started, task.updated, and task.completed are all
    // lifecycle boundaries absorbed by grouping, so only the launch row remains standalone.
    const launchEntries = workEntries.filter(
      (entry) => entry.itemType === "collab_agent_tool_call" && !entry.childThreadAttribution,
    );
    expect(launchEntries).toHaveLength(1);
    expect(launchEntries[0]).toMatchObject({
      id: "agent-launch-completed",
      toolCallId: "runtime-agent-2",
    });
  });

  it("marks a subagent group as failed when task.updated has killed status", () => {
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "agent-launch-started",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.started",
          summary: "Subagent task started",
          payload: {
            itemType: "collab_agent_tool_call",
            itemId: "runtime-agent-3",
            status: "inProgress",
            toolName: "Agent",
            detail: "Agent: Long running task",
            data: {
              toolName: "Agent",
              input: {
                description: "Long running task",
                prompt: "Run a long process.",
                run_in_background: true,
              },
            },
          },
        }),
        makeActivity({
          id: "agent-launch-completed",
          createdAt: "2026-04-10T12:00:00.100Z",
          kind: "tool.completed",
          summary: "Subagent task",
          payload: {
            itemType: "collab_agent_tool_call",
            itemId: "runtime-agent-3",
            status: "completed",
            toolName: "Agent",
            detail: "Agent: Long running task",
            data: {
              toolName: "Agent",
              input: {
                description: "Long running task",
                prompt: "Run a long process.",
                run_in_background: true,
              },
              toolUseResult: {
                isAsync: true,
                status: "async_launched",
                agentId: "long-agent-001",
                description: "Long running task",
                prompt: "Run a long process.",
              },
            },
          },
        }),
        makeActivity({
          id: "agent-task-started",
          createdAt: "2026-04-10T12:00:00.120Z",
          kind: "task.started",
          summary: "local_agent task started",
          payload: {
            taskId: "long-agent-001",
            toolUseId: "toolu_long_launch",
            detail: "Long running task",
            childThreadAttribution: {
              taskId: "toolu_long_launch",
              childProviderThreadId: "toolu_long_launch",
              label: "Long running task",
            },
          },
        }),
        makeActivity({
          id: "agent-task-updated-killed",
          createdAt: "2026-04-10T12:00:05.000Z",
          kind: "task.updated",
          summary: "Task updated",
          tone: "error",
          payload: {
            taskId: "long-agent-001",
            patch: {
              status: "killed",
            },
            childThreadAttribution: {
              taskId: "toolu_long_launch",
              childProviderThreadId: "toolu_long_launch",
              label: "Long running task",
            },
          },
        }),
      ],
      undefined,
    );

    const trayState = deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:05.500Z");
    expect(trayState.subagentGroups).toEqual([
      expect.objectContaining({
        groupId: "toolu_long_launch",
        status: "failed",
        label: "Long running task",
      }),
    ]);
  });

  it("does not change subagent group status on non-terminal task.updated", () => {
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "agent-launch-started",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.started",
          summary: "Subagent task started",
          payload: {
            itemType: "collab_agent_tool_call",
            itemId: "runtime-agent-4",
            status: "inProgress",
            toolName: "Agent",
            detail: "Agent: Incremental build",
            data: {
              toolName: "Agent",
              input: {
                description: "Incremental build",
                prompt: "Watch for file changes and rebuild.",
                run_in_background: true,
              },
            },
          },
        }),
        makeActivity({
          id: "agent-launch-completed",
          createdAt: "2026-04-10T12:00:00.100Z",
          kind: "tool.completed",
          summary: "Subagent task",
          payload: {
            itemType: "collab_agent_tool_call",
            itemId: "runtime-agent-4",
            status: "completed",
            toolName: "Agent",
            detail: "Agent: Incremental build",
            data: {
              toolName: "Agent",
              input: {
                description: "Incremental build",
                prompt: "Watch for file changes and rebuild.",
                run_in_background: true,
              },
              toolUseResult: {
                isAsync: true,
                status: "async_launched",
                agentId: "watch-agent-001",
                description: "Incremental build",
                prompt: "Watch for file changes and rebuild.",
              },
            },
          },
        }),
        makeActivity({
          id: "agent-task-started",
          createdAt: "2026-04-10T12:00:00.120Z",
          kind: "task.started",
          summary: "local_agent task started",
          payload: {
            taskId: "watch-agent-001",
            toolUseId: "toolu_watch_launch",
            detail: "Incremental build",
            childThreadAttribution: {
              taskId: "toolu_watch_launch",
              childProviderThreadId: "toolu_watch_launch",
              label: "Incremental build",
            },
          },
        }),
        makeActivity({
          id: "agent-task-updated-running",
          createdAt: "2026-04-10T12:00:03.000Z",
          kind: "task.updated",
          summary: "Task updated",
          tone: "info",
          payload: {
            taskId: "watch-agent-001",
            patch: {
              status: "running",
            },
            childThreadAttribution: {
              taskId: "toolu_watch_launch",
              childProviderThreadId: "toolu_watch_launch",
              label: "Incremental build",
            },
          },
        }),
      ],
      undefined,
    );

    const trayState = deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:03.500Z");
    expect(trayState.subagentGroups).toEqual([
      expect.objectContaining({
        groupId: "toolu_watch_launch",
        status: "running",
        label: "Incremental build",
      }),
    ]);
  });

  it("prevents duplicate TaskOutput synthesis when task.updated already terminated the task", () => {
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "agent-launch-started",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.started",
          summary: "Subagent task started",
          payload: {
            itemType: "collab_agent_tool_call",
            itemId: "runtime-agent-5",
            status: "inProgress",
            toolName: "Agent",
            detail: "Agent: Check tests",
            data: {
              toolName: "Agent",
              input: {
                description: "Check tests",
                prompt: "Run the test suite and report.",
                run_in_background: true,
              },
            },
          },
        }),
        makeActivity({
          id: "agent-launch-completed",
          createdAt: "2026-04-10T12:00:00.100Z",
          kind: "tool.completed",
          summary: "Subagent task",
          payload: {
            itemType: "collab_agent_tool_call",
            itemId: "runtime-agent-5",
            status: "completed",
            toolName: "Agent",
            detail: "Agent: Check tests",
            data: {
              toolName: "Agent",
              input: {
                description: "Check tests",
                prompt: "Run the test suite and report.",
                run_in_background: true,
              },
              toolUseResult: {
                isAsync: true,
                status: "async_launched",
                agentId: "test-agent-001",
                description: "Check tests",
                prompt: "Run the test suite and report.",
              },
            },
          },
        }),
        makeActivity({
          id: "agent-task-started",
          createdAt: "2026-04-10T12:00:00.120Z",
          kind: "task.started",
          summary: "local_agent task started",
          payload: {
            taskId: "test-agent-001",
            toolUseId: "toolu_test_launch",
            detail: "Check tests",
            childThreadAttribution: {
              taskId: "toolu_test_launch",
              childProviderThreadId: "toolu_test_launch",
              label: "Check tests",
            },
          },
        }),
        makeActivity({
          id: "agent-task-updated-terminal",
          createdAt: "2026-04-10T12:00:08.000Z",
          kind: "task.updated",
          summary: "Task updated",
          tone: "info",
          payload: {
            taskId: "test-agent-001",
            patch: {
              status: "completed",
            },
            childThreadAttribution: {
              taskId: "toolu_test_launch",
              childProviderThreadId: "toolu_test_launch",
              label: "Check tests",
            },
          },
        }),
        makeActivity({
          id: "taskoutput-agent-resolve",
          createdAt: "2026-04-10T12:00:10.000Z",
          kind: "tool.completed",
          summary: "Tool call",
          payload: {
            itemType: "dynamic_tool_call",
            itemId: "toolu_taskoutput_wait",
            status: "completed",
            toolName: "TaskOutput",
            detail: 'TaskOutput: {"task_id":"test-agent-001","block":true,"timeout":60000}',
            data: {
              toolName: "TaskOutput",
              input: {
                task_id: "test-agent-001",
                block: true,
                timeout: 60000,
              },
              toolUseResult: {
                retrieval_status: "success",
                task: {
                  task_id: "test-agent-001",
                  task_type: "local_agent",
                  status: "completed",
                  description: "Check tests",
                  prompt: "Run the test suite and report.",
                  output: "All 42 tests passed.",
                },
              },
            },
          },
        }),
      ],
      undefined,
    );

    // The task.updated with terminal status already marked this task as terminated,
    // so the TaskOutput tool.completed should NOT produce a synthetic task.completed.
    const syntheticCompleted = workEntries.filter(
      (entry) =>
        entry.activityKind === "task.completed" &&
        entry.id.includes("synthetic-taskoutput-complete"),
    );
    expect(syntheticCompleted).toHaveLength(0);

    // The group should still be completed (from the task.updated signal)
    const trayState = deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:10.500Z");
    expect(trayState.subagentGroups).toEqual([
      expect.objectContaining({
        groupId: "toolu_test_launch",
        status: "completed",
        label: "Check tests",
      }),
    ]);
  });

  it("updates bash background command status from terminal task.updated", () => {
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "claude-bash-started",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.started",
          summary: "Command started",
          payload: {
            itemType: "command_execution",
            itemId: "toolu_bash_launch",
            status: "inProgress",
            toolName: "Bash",
            detail: "Bash: sleep 20 && echo done",
            data: {
              toolName: "Bash",
              input: {
                command: "sleep 20 && echo done",
                description: "Sleep 20 seconds then print done",
                run_in_background: true,
              },
            },
          },
        }),
        makeActivity({
          id: "claude-bash-launch-completed",
          createdAt: "2026-04-10T12:00:00.100Z",
          kind: "tool.completed",
          summary: "Command",
          payload: {
            itemType: "command_execution",
            itemId: "toolu_bash_launch",
            status: "completed",
            toolName: "Bash",
            detail: "Bash: Command running in background with ID: bgxyz.",
            data: {
              toolName: "Bash",
              input: {
                command: "sleep 20 && echo done",
                description: "Sleep 20 seconds then print done",
                run_in_background: true,
              },
              toolUseResult: {
                backgroundTaskId: "bgxyz",
              },
            },
          },
        }),
        makeActivity({
          id: "claude-bash-task-started",
          createdAt: "2026-04-10T12:00:00.120Z",
          kind: "task.started",
          summary: "local_bash task started",
          payload: {
            taskId: "bgxyz",
            toolUseId: "toolu_bash_launch",
            detail: "Sleep 20 seconds then print done",
          },
        }),
        // task.updated with terminal status — no task_notification follows
        makeActivity({
          id: "bash-task-updated-terminal",
          createdAt: "2026-04-10T12:00:20.000Z",
          kind: "task.updated",
          summary: "Task updated",
          tone: "info",
          payload: {
            taskId: "bgxyz",
            patch: {
              status: "completed",
              end_time: 1776047120000,
            },
          },
        }),
      ],
      undefined,
    );

    expect(workEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "claude-bash-launch-completed",
          activityKind: "tool.completed",
          backgroundTaskId: "bgxyz",
          backgroundTaskStatus: "completed",
          backgroundCompletedAt: "2026-04-10T12:00:20.000Z",
        }),
      ]),
    );

    const trayState = deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:20.500Z");
    expect(trayState.commandEntries).toEqual([
      expect.objectContaining({
        id: "claude-bash-launch-completed",
        backgroundTaskStatus: "completed",
      }),
    ]);
  });
});

describe("deriveWorkLogEntries context window handling", () => {
  it("excludes context window updates from the work log", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "context-1",
          turnId: "turn-1",
          kind: "context-window.updated",
          summary: "Context window updated",
          tone: "info",
        }),
        makeActivity({
          id: "tool-1",
          turnId: "turn-1",
          kind: "tool.completed",
          summary: "Ran command",
          tone: "tool",
        }),
      ],
      TurnId.makeUnsafe("turn-1"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Ran command");
  });

  it("keeps context compaction activities as normal work log entries", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "compaction-1",
          turnId: "turn-1",
          kind: "context-compaction",
          summary: "Context compacted",
          tone: "info",
        }),
      ],
      TurnId.makeUnsafe("turn-1"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Context compacted");
  });
});
