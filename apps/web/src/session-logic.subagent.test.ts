import { EventId, type OrchestrationThreadActivity } from "@forgetools/contracts";
import { describe, expect, it } from "vitest";

import { deriveWorkLogEntries, type WorkLogEntry } from "./session-logic";
import {
  groupSubagentEntries,
  enrichParentEntriesWithSubagentGroupMetadata,
} from "./session-logic/subagentGrouping";

/** Minimal builder — only fills required fields; callers override what matters. */
function makeEntry(overrides: Partial<WorkLogEntry> & { id: string }): WorkLogEntry {
  return {
    createdAt: "2026-04-01T00:00:00.000Z",
    label: "some entry",
    tone: "tool",
    ...overrides,
  };
}

function makeActivity(overrides: {
  id: string;
  createdAt?: string;
  kind: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
}): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(overrides.id),
    createdAt: overrides.createdAt ?? "2026-04-01T00:00:00.000Z",
    kind: overrides.kind,
    summary: overrides.summary ?? "activity",
    tone: overrides.tone ?? "tool",
    payload: overrides.payload ?? {},
    turnId: null,
  };
}

describe("groupSubagentEntries", () => {
  it("returns empty standalone and subagentGroups for empty input", () => {
    const result = groupSubagentEntries([]);
    expect(result).toEqual({ standalone: [], subagentGroups: [] });
  });

  it("places all entries without childThreadAttribution into standalone", () => {
    const entries = [makeEntry({ id: "a" }), makeEntry({ id: "b", label: "second" })];

    const result = groupSubagentEntries(entries);

    expect(result.standalone).toHaveLength(2);
    expect(result.standalone.map((e) => e.id)).toEqual(["a", "b"]);
    expect(result.subagentGroups).toEqual([]);
  });

  it("groups entries with the same child thread into one SubagentGroup", () => {
    const entries = [
      makeEntry({
        id: "w1",
        childThreadAttribution: {
          taskId: "task-abc",
          childProviderThreadId: "thread-1",
        },
      }),
      makeEntry({
        id: "w2",
        childThreadAttribution: {
          taskId: "task-abc",
          childProviderThreadId: "thread-1",
        },
      }),
    ];

    const result = groupSubagentEntries(entries);

    expect(result.standalone).toEqual([]);
    expect(result.subagentGroups).toHaveLength(1);
    expect(result.subagentGroups[0]!.groupId).toBe("thread-1");
    expect(result.subagentGroups[0]!.taskId).toBe("task-abc");
    expect(result.subagentGroups[0]!.entries).toHaveLength(2);
    expect(result.subagentGroups[0]!.entries.map((e) => e.id)).toEqual(["w1", "w2"]);
  });

  it("creates separate groups for different child threads", () => {
    const entries = [
      makeEntry({
        id: "a1",
        childThreadAttribution: {
          taskId: "task-shared",
          childProviderThreadId: "t1",
        },
      }),
      makeEntry({
        id: "b1",
        childThreadAttribution: {
          taskId: "task-shared",
          childProviderThreadId: "t2",
        },
      }),
      makeEntry({
        id: "a2",
        childThreadAttribution: {
          taskId: "task-shared",
          childProviderThreadId: "t1",
        },
      }),
    ];

    const result = groupSubagentEntries(entries);

    expect(result.subagentGroups).toHaveLength(2);

    const groupX = result.subagentGroups.find((g) => g.groupId === "t1")!;
    const groupY = result.subagentGroups.find((g) => g.groupId === "t2")!;

    expect(groupX.entries.map((e) => e.id)).toEqual(["a1", "a2"]);
    expect(groupY.entries.map((e) => e.id)).toEqual(["b1"]);
  });

  it("sets startedAt and label from a task.started entry", () => {
    const entries = [
      makeEntry({
        id: "started",
        activityKind: "task.started",
        createdAt: "2026-04-01T01:00:00.000Z",
        detail: "Lint the project",
        childThreadAttribution: {
          taskId: "task-1",
          childProviderThreadId: "t1",
        },
      }),
      makeEntry({
        id: "w1",
        createdAt: "2026-04-01T01:00:01.000Z",
        childThreadAttribution: {
          taskId: "task-1",
          childProviderThreadId: "t1",
        },
      }),
    ];

    const result = groupSubagentEntries(entries);
    const group = result.subagentGroups[0]!;

    expect(group.startedAt).toBe("2026-04-01T01:00:00.000Z");
    expect(group.label).toBe("Lint the project");
    // task.started is a lifecycle entry — not pushed into entries[]
    expect(group.entries).toHaveLength(1);
    expect(group.entries[0]!.id).toBe("w1");
  });

  it("sets completedAt and status='completed' from a task.completed entry", () => {
    const entries = [
      makeEntry({
        id: "started",
        activityKind: "task.started",
        createdAt: "2026-04-01T01:00:00.000Z",
        detail: "Run tests",
        childThreadAttribution: {
          taskId: "task-2",
          childProviderThreadId: "t2",
        },
      }),
      makeEntry({
        id: "completed",
        activityKind: "task.completed",
        createdAt: "2026-04-01T01:05:00.000Z",
        tone: "info",
        childThreadAttribution: {
          taskId: "task-2",
          childProviderThreadId: "t2",
        },
      }),
    ];

    const result = groupSubagentEntries(entries);
    const group = result.subagentGroups[0]!;

    expect(group.status).toBe("completed");
    expect(group.completedAt).toBe("2026-04-01T01:05:00.000Z");
  });

  it("sets status='failed' when task.completed has error tone", () => {
    const entries = [
      makeEntry({
        id: "completed-err",
        activityKind: "task.completed",
        createdAt: "2026-04-01T02:00:00.000Z",
        tone: "error",
        childThreadAttribution: {
          taskId: "task-3",
          childProviderThreadId: "t3",
        },
      }),
    ];

    const result = groupSubagentEntries(entries);
    const group = result.subagentGroups[0]!;

    expect(group.status).toBe("failed");
    expect(group.completedAt).toBe("2026-04-01T02:00:00.000Z");
  });

  it("defaults status to 'running' when no task.completed entry exists", () => {
    const entries = [
      makeEntry({
        id: "w1",
        childThreadAttribution: {
          taskId: "task-4",
          childProviderThreadId: "t4",
        },
      }),
    ];

    const result = groupSubagentEntries(entries);

    expect(result.subagentGroups[0]!.status).toBe("running");
    expect(result.subagentGroups[0]!.completedAt).toBeUndefined();
  });

  it("partitions mixed entries: some attributed, some standalone", () => {
    const entries = [
      makeEntry({ id: "standalone-1" }),
      makeEntry({
        id: "agent-1",
        childThreadAttribution: {
          taskId: "task-m",
          childProviderThreadId: "t",
        },
      }),
      makeEntry({ id: "standalone-2" }),
      makeEntry({
        id: "agent-2",
        childThreadAttribution: {
          taskId: "task-m",
          childProviderThreadId: "t",
        },
      }),
    ];

    const result = groupSubagentEntries(entries);

    expect(result.standalone.map((e) => e.id)).toEqual(["standalone-1", "standalone-2"]);
    expect(result.subagentGroups).toHaveLength(1);
    expect(result.subagentGroups[0]!.entries.map((e) => e.id)).toEqual(["agent-1", "agent-2"]);
  });

  it("forms group correctly even when entries arrive before task.started", () => {
    const entries = [
      makeEntry({
        id: "early-work",
        createdAt: "2026-04-01T00:59:00.000Z",
        childThreadAttribution: {
          taskId: "task-early",
          childProviderThreadId: "t",
        },
      }),
      makeEntry({
        id: "started",
        activityKind: "task.started",
        createdAt: "2026-04-01T01:00:00.000Z",
        detail: "Late start",
        childThreadAttribution: {
          taskId: "task-early",
          childProviderThreadId: "t",
        },
      }),
    ];

    const result = groupSubagentEntries(entries);
    const group = result.subagentGroups[0]!;

    // task.started overwrites startedAt even if the first entry was earlier
    expect(group.startedAt).toBe("2026-04-01T01:00:00.000Z");
    expect(group.entries).toHaveLength(1);
    expect(group.entries[0]!.id).toBe("early-work");
    expect(group.label).toBe("Late start");
  });

  it("has empty entries array when group contains only lifecycle events", () => {
    const entries = [
      makeEntry({
        id: "started",
        activityKind: "task.started",
        createdAt: "2026-04-01T01:00:00.000Z",
        detail: "No real work",
        childThreadAttribution: {
          taskId: "task-empty",
          childProviderThreadId: "t",
        },
      }),
      makeEntry({
        id: "completed",
        activityKind: "task.completed",
        createdAt: "2026-04-01T01:01:00.000Z",
        tone: "info",
        childThreadAttribution: {
          taskId: "task-empty",
          childProviderThreadId: "t",
        },
      }),
    ];

    const result = groupSubagentEntries(entries);
    const group = result.subagentGroups[0]!;

    expect(group.entries).toEqual([]);
    expect(group.status).toBe("completed");
  });

  it("falls back to a generic 'Subagent' label when no label is available", () => {
    const entries = [
      makeEntry({
        id: "w1",
        childThreadAttribution: {
          taskId: "abcdef1234567890",
          childProviderThreadId: "t",
          // no label
        },
      }),
    ];

    const result = groupSubagentEntries(entries);

    expect(result.subagentGroups[0]!.label).toBe("Subagent");
  });

  it("prefers attribution label over detail for group label", () => {
    const entries = [
      makeEntry({
        id: "started",
        activityKind: "task.started",
        createdAt: "2026-04-01T01:00:00.000Z",
        detail: "Detail-based label",
        childThreadAttribution: {
          taskId: "task-label",
          label: "Attribution label",
          childProviderThreadId: "t",
        },
      }),
    ];

    const result = groupSubagentEntries(entries);

    // The attribution label is set first (when group is created),
    // so the detail won't overwrite it (guarded by `!group.label`).
    expect(result.subagentGroups[0]!.label).toBe("Attribution label");
  });

  it("uses detail as label when attribution has no label", () => {
    const entries = [
      makeEntry({
        id: "started",
        activityKind: "task.started",
        createdAt: "2026-04-01T01:00:00.000Z",
        detail: "From detail field",
        childThreadAttribution: {
          taskId: "task-detail",
          childProviderThreadId: "t",
          // no label
        },
      }),
    ];

    const result = groupSubagentEntries(entries);

    expect(result.subagentGroups[0]!.label).toBe("From detail field");
  });

  it("preserves insertion order of groups based on first encounter", () => {
    const entries = [
      makeEntry({
        id: "first-b",
        childThreadAttribution: {
          taskId: "task-b",
          childProviderThreadId: "thread-b",
        },
      }),
      makeEntry({
        id: "first-a",
        childThreadAttribution: {
          taskId: "task-a",
          childProviderThreadId: "thread-a",
        },
      }),
    ];

    const result = groupSubagentEntries(entries);

    expect(result.subagentGroups.map((g) => g.taskId)).toEqual(["task-b", "task-a"]);
  });

  it("merges mixed-attribution lifecycle rows for the same child thread", () => {
    const entries = [
      makeEntry({
        id: "started-with-fallback-task-id",
        activityKind: "task.started",
        createdAt: "2026-04-01T00:00:00.000Z",
        childThreadAttribution: {
          taskId: "child-thread-1",
          childProviderThreadId: "child-thread-1",
        },
      }),
      makeEntry({
        id: "progress-with-real-task-id",
        activityKind: "task.progress",
        createdAt: "2026-04-01T00:00:02.000Z",
        childThreadAttribution: {
          taskId: "call-collab-1",
          childProviderThreadId: "child-thread-1",
          label: "Inspect session logic",
        },
      }),
      makeEntry({
        id: "completed-with-real-task-id",
        activityKind: "task.completed",
        createdAt: "2026-04-01T00:00:05.000Z",
        itemStatus: "completed",
        childThreadAttribution: {
          taskId: "call-collab-1",
          childProviderThreadId: "child-thread-1",
          label: "Inspect session logic",
        },
      }),
    ];

    const result = groupSubagentEntries(entries);

    expect(result.subagentGroups).toHaveLength(1);
    expect(result.subagentGroups[0]).toMatchObject({
      groupId: "child-thread-1",
      taskId: "call-collab-1",
      childProviderThreadId: "child-thread-1",
      label: "Inspect session logic",
      status: "completed",
      completedAt: "2026-04-01T00:00:05.000Z",
    });
  });

  it("uses first entry's createdAt as startedAt when no task.started exists", () => {
    const entries = [
      makeEntry({
        id: "w1",
        createdAt: "2026-04-01T00:30:00.000Z",
        childThreadAttribution: {
          taskId: "task-no-start",
          childProviderThreadId: "t",
        },
      }),
      makeEntry({
        id: "w2",
        createdAt: "2026-04-01T00:31:00.000Z",
        childThreadAttribution: {
          taskId: "task-no-start",
          childProviderThreadId: "t",
        },
      }),
    ];

    const result = groupSubagentEntries(entries);

    // startedAt is set from the first entry's createdAt during group creation
    expect(result.subagentGroups[0]!.startedAt).toBe("2026-04-01T00:30:00.000Z");
  });

  it("later attribution label does not overwrite existing label", () => {
    const entries = [
      makeEntry({
        id: "w1",
        childThreadAttribution: {
          taskId: "task-lbl",
          label: "First label",
          childProviderThreadId: "t",
        },
      }),
      makeEntry({
        id: "w2",
        childThreadAttribution: {
          taskId: "task-lbl",
          label: "Second label",
          childProviderThreadId: "t",
        },
      }),
    ];

    const result = groupSubagentEntries(entries);

    // The label guard `!group.label` prevents later labels from overwriting
    expect(result.subagentGroups[0]!.label).toBe("First label");
  });

  it("propagates agentType and agentModel from first entry's childThreadAttribution", () => {
    const entries = [
      makeEntry({
        id: "w1",
        childThreadAttribution: {
          taskId: "task-typed",
          childProviderThreadId: "t",
          agentType: "Reviewer",
          agentModel: "opus",
        },
      }),
      makeEntry({
        id: "w2",
        childThreadAttribution: {
          taskId: "task-typed",
          childProviderThreadId: "t",
        },
      }),
    ];

    const result = groupSubagentEntries(entries);
    const group = result.subagentGroups[0]!;

    expect(group.agentType).toBe("Reviewer");
    expect(group.agentModel).toBe("opus");
  });

  it("propagates agent description and instructions from recorded subagent entries", () => {
    const entries = [
      makeEntry({
        id: "spawn-entry",
        itemType: "collab_agent_tool_call",
        agentDescription: "Inspect the parser",
        agentPrompt: "Run exactly these steps and report only final completion",
        childThreadAttribution: {
          taskId: "task-prompt",
          childProviderThreadId: "child-prompt",
        },
      }),
      makeEntry({
        id: "started",
        activityKind: "task.started",
        detail: "Run exactly these steps and report only final completion",
        childThreadAttribution: {
          taskId: "task-prompt",
          childProviderThreadId: "child-prompt",
        },
      }),
    ];

    const result = groupSubagentEntries(entries);
    const group = result.subagentGroups[0]!;

    expect(group.agentDescription).toBe("Inspect the parser");
    expect(group.agentPrompt).toBe("Run exactly these steps and report only final completion");
  });

  it("defaults agentType and agentModel to undefined when attribution lacks them", () => {
    const entries = [
      makeEntry({
        id: "w1",
        childThreadAttribution: {
          taskId: "task-no-type",
          childProviderThreadId: "t",
        },
      }),
    ];

    const result = groupSubagentEntries(entries);
    const group = result.subagentGroups[0]!;

    expect(group.agentType).toBeUndefined();
    expect(group.agentModel).toBeUndefined();
  });

  it("running groups are separate from completed in the returned array", () => {
    const entries = [
      makeEntry({
        id: "started-a",
        activityKind: "task.started",
        createdAt: "2026-04-01T01:00:00.000Z",
        detail: "Completed task",
        childThreadAttribution: {
          taskId: "task-done",
          childProviderThreadId: "t1",
        },
      }),
      makeEntry({
        id: "completed-a",
        activityKind: "task.completed",
        createdAt: "2026-04-01T01:05:00.000Z",
        tone: "info",
        childThreadAttribution: {
          taskId: "task-done",
          childProviderThreadId: "t1",
        },
      }),
      makeEntry({
        id: "started-b",
        activityKind: "task.started",
        createdAt: "2026-04-01T01:00:00.000Z",
        detail: "Running task",
        childThreadAttribution: {
          taskId: "task-running",
          childProviderThreadId: "t2",
        },
      }),
      makeEntry({
        id: "work-b",
        createdAt: "2026-04-01T01:01:00.000Z",
        childThreadAttribution: {
          taskId: "task-running",
          childProviderThreadId: "t2",
        },
      }),
    ];

    const result = groupSubagentEntries(entries);

    expect(result.subagentGroups).toHaveLength(2);

    const completedGroup = result.subagentGroups.find((g) => g.taskId === "task-done")!;
    const runningGroup = result.subagentGroups.find((g) => g.taskId === "task-running")!;

    expect(completedGroup.status).toBe("completed");
    expect(runningGroup.status).toBe("running");
  });

  it("marks a running group as completed from the Codex fallback completion row", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "task-running-start",
          kind: "task.started",
          summary: "Task started",
          tone: "info",
          payload: {
            taskId: "task-codex-group",
            childThreadAttribution: {
              taskId: "task-codex-group",
              childProviderThreadId: "child-thread-1",
              label: "Review parser",
            },
          },
        }),
        makeActivity({
          id: "codex-parent-complete",
          createdAt: "2026-04-01T00:00:05.000Z",
          kind: "tool.completed",
          summary: "Subagent task",
          payload: {
            itemType: "collab_agent_tool_call",
            data: {
              item: {
                id: "task-codex-group",
                prompt: "Review parser",
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

    const result = groupSubagentEntries(entries);
    expect(result.standalone).toEqual([]);
    expect(result.subagentGroups).toHaveLength(1);
    expect(result.subagentGroups[0]?.status).toBe("completed");
    expect(result.subagentGroups[0]?.completedAt).toBe("2026-04-01T00:00:05.000Z");
  });

  it("keeps a spawned group running when spawn_agent completes but the child agent state is still pending", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "child-command-start",
          createdAt: "2026-04-01T00:00:01.000Z",
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
                source: "unifiedExecStartup",
                processId: "proc-child-1",
              },
            },
            childThreadAttribution: {
              taskId: "task-codex-running",
              childProviderThreadId: "child-thread-running",
              label: "Sleep for 120 seconds",
            },
          },
        }),
        makeActivity({
          id: "spawn-agent-completed",
          createdAt: "2026-04-01T00:00:02.000Z",
          kind: "tool.completed",
          summary: "Subagent task",
          payload: {
            itemType: "collab_agent_tool_call",
            status: "completed",
            data: {
              item: {
                id: "task-codex-running",
                tool: "spawnAgent",
                status: "completed",
                prompt: "Sleep for 120 seconds",
                receiverThreadIds: ["child-thread-running"],
                agentsStates: {
                  "child-thread-running": {
                    status: "running",
                  },
                },
              },
            },
          },
        }),
      ],
      undefined,
    );

    const result = groupSubagentEntries(entries);
    expect(result.standalone.map((entry) => entry.id)).toEqual(["spawn-agent-completed"]);
    expect(result.standalone[0]).toMatchObject({
      itemType: "collab_agent_tool_call",
      toolName: "spawnAgent",
      receiverThreadIds: ["child-thread-running"],
    });
    expect(result.subagentGroups).toHaveLength(1);
    expect(result.subagentGroups[0]?.status).toBe("running");
    expect(result.subagentGroups[0]?.completedAt).toBeUndefined();
    expect(result.subagentGroups[0]?.entries.map((entry) => entry.id)).toEqual([
      "child-command-start",
    ]);
  });

  it("marks a known group as completed when wait_agent returns a terminal child status", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "known-child-start",
          createdAt: "2026-04-01T00:00:01.000Z",
          kind: "tool.started",
          summary: "Command started",
          payload: {
            itemType: "command_execution",
            itemId: "child-command-2",
            status: "inProgress",
            data: {
              item: {
                id: "child-command-2",
                command: ["/bin/zsh", "-lc", "sleep 120"],
                source: "unifiedExecStartup",
                processId: "proc-child-2",
              },
            },
            childThreadAttribution: {
              taskId: "task-known-completion",
              childProviderThreadId: "child-thread-known-completion",
              label: "Wait for completion",
            },
          },
        }),
        makeActivity({
          id: "wait-agent-completed",
          createdAt: "2026-04-01T00:02:00.000Z",
          kind: "tool.completed",
          summary: "Subagent wait",
          payload: {
            itemType: "collab_agent_tool_call",
            data: {
              item: {
                id: "wait-agent-completed",
                tool: "wait",
                receiverThreadIds: ["child-thread-known-completion"],
                agentsStates: {
                  "child-thread-known-completion": {
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

    const result = groupSubagentEntries(entries);
    expect(result.standalone.map((entry) => entry.id)).toEqual(["wait-agent-completed"]);
    expect(result.standalone[0]).toMatchObject({
      itemType: "collab_agent_tool_call",
      toolName: "wait",
      receiverThreadIds: ["child-thread-known-completion"],
    });
    expect(result.subagentGroups).toHaveLength(1);
    expect(result.subagentGroups[0]?.status).toBe("completed");
    expect(result.subagentGroups[0]?.completedAt).toBe("2026-04-01T00:02:00.000Z");
  });

  it("does not create orphan standalone entries for the Codex fallback completion row", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "codex-parent-failed",
          createdAt: "2026-04-01T00:00:07.000Z",
          kind: "tool.completed",
          summary: "Subagent task",
          payload: {
            itemType: "collab_agent_tool_call",
            data: {
              item: {
                id: "task-codex-failed",
                prompt: "Inspect regressions",
                receiverThreadIds: ["child-thread-2"],
                agentsStates: {
                  "child-thread-2": {
                    status: "errored",
                  },
                },
              },
            },
          },
        }),
      ],
      undefined,
    );

    const result = groupSubagentEntries(entries);
    expect(result.standalone).toEqual([]);
    expect(result.subagentGroups).toHaveLength(1);
    expect(result.subagentGroups[0]?.status).toBe("failed");
    expect(result.subagentGroups[0]?.entries).toEqual([]);
  });

  it.each(["wait", "sendInput"] as const)(
    "ignores orphan Codex control collab tool %s when grouping subagent entries",
    (tool) => {
      const entries = deriveWorkLogEntries(
        [
          makeActivity({
            id: `control-${tool}`,
            createdAt: "2026-04-01T00:00:09.000Z",
            kind: "tool.completed",
            summary: "Subagent task",
            payload: {
              itemType: "collab_agent_tool_call",
              data: {
                item: {
                  id: `control-${tool}`,
                  tool,
                  prompt: "This is control traffic, not a spawned agent",
                  receiverThreadIds: ["child-thread-control"],
                  agentsStates: {
                    "child-thread-control": {
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

      const result = groupSubagentEntries(entries);
      expect(result.standalone.map((entry) => entry.id)).toEqual([`control-${tool}`]);
      expect(result.standalone[0]).toMatchObject({
        itemType: "collab_agent_tool_call",
        toolName: tool,
      });
      expect(result.subagentGroups).toEqual([]);
    },
  );
});

describe("enrichParentEntriesWithSubagentGroupMetadata", () => {
  it("attaches subagentGroupMeta to a Claude parent entry matched by toolCallId", () => {
    const entries: WorkLogEntry[] = [
      makeEntry({
        id: "parent-agent",
        itemType: "collab_agent_tool_call",
        toolCallId: "call_abc",
        toolName: "Agent",
        agentModel: "opus",
        agentPrompt: "Research the codebase",
      }),
      makeEntry({
        id: "child-started",
        activityKind: "task.started",
        label: "Task started",
        tone: "info",
        startedAt: "2026-04-01T00:00:01.000Z",
        childThreadAttribution: { taskId: "task-1", childProviderThreadId: "call_abc" },
      }),
      makeEntry({
        id: "child-work",
        label: "Read file",
        tone: "tool",
        itemType: "file_read",
        childThreadAttribution: { taskId: "task-1", childProviderThreadId: "call_abc" },
      }),
      makeEntry({
        id: "child-completed",
        activityKind: "task.completed",
        label: "Task completed",
        tone: "info",
        itemStatus: "completed",
        completedAt: "2026-04-01T00:00:05.000Z",
        childThreadAttribution: { taskId: "task-1", childProviderThreadId: "call_abc" },
      }),
    ];

    const result = enrichParentEntriesWithSubagentGroupMetadata(entries);

    // Only the parent entry should remain (child entries consumed into metadata)
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("parent-agent");
    expect(result[0]!.subagentGroupMeta).toBeDefined();
    expect(result[0]!.subagentGroupMeta!.childProviderThreadId).toBe("call_abc");
    expect(result[0]!.subagentGroupMeta!.status).toBe("completed");
    expect(result[0]!.subagentGroupMeta!.recordedActionCount).toBe(1);
    expect(result[0]!.subagentGroupMeta!.fallbackEntries).toHaveLength(1);
    expect(result[0]!.subagentGroupMeta!.fallbackEntries[0]!.id).toBe("child-work");
  });

  it("attaches subagentGroupMeta to a Codex parent entry matched by receiverThreadIds", () => {
    const entries: WorkLogEntry[] = [
      makeEntry({
        id: "codex-spawn",
        itemType: "collab_agent_tool_call",
        toolName: "spawnAgent",
        receiverThreadIds: ["child-thread-1"],
      }),
      makeEntry({
        id: "child-started",
        activityKind: "task.started",
        label: "Task started",
        tone: "info",
        startedAt: "2026-04-01T00:00:01.000Z",
        childThreadAttribution: { taskId: "task-1", childProviderThreadId: "child-thread-1" },
      }),
      makeEntry({
        id: "child-completed",
        activityKind: "task.completed",
        label: "Task completed",
        tone: "info",
        itemStatus: "completed",
        completedAt: "2026-04-01T00:00:03.000Z",
        childThreadAttribution: { taskId: "task-1", childProviderThreadId: "child-thread-1" },
      }),
    ];

    const result = enrichParentEntriesWithSubagentGroupMetadata(entries);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: "codex-spawn",
      isBackgroundCommand: true,
      backgroundLifecycleRole: "launch",
    });
    expect(result[0]!.subagentGroupMeta).toBeDefined();
    expect(result[0]!.subagentGroupMeta!.childProviderThreadId).toBe("child-thread-1");
    expect(result[0]!.subagentGroupMeta!.status).toBe("completed");
    expect(result[1]).toMatchObject({
      id: "codex-spawn:background-agent-completed",
      backgroundLifecycleRole: "completion",
      itemStatus: "completed",
    });
  });

  it("prefers the Codex spawn row over wait rows for subagent ownership", () => {
    const entries: WorkLogEntry[] = [
      makeEntry({
        id: "codex-spawn",
        itemType: "collab_agent_tool_call",
        toolName: "spawnAgent",
        receiverThreadIds: ["child-thread-1"],
        itemStatus: "completed",
      }),
      makeEntry({
        id: "codex-wait",
        itemType: "collab_agent_tool_call",
        toolName: "wait",
        receiverThreadIds: ["child-thread-1"],
        itemStatus: "completed",
      }),
      makeEntry({
        id: "child-started",
        activityKind: "task.started",
        label: "Task started",
        tone: "info",
        childThreadAttribution: { taskId: "task-1", childProviderThreadId: "child-thread-1" },
      }),
      makeEntry({
        id: "child-completed",
        activityKind: "task.completed",
        label: "Task completed",
        tone: "info",
        itemStatus: "completed",
        completedAt: "2026-04-01T00:00:03.000Z",
        childThreadAttribution: { taskId: "task-1", childProviderThreadId: "child-thread-1" },
      }),
    ];

    const result = enrichParentEntriesWithSubagentGroupMetadata(entries);
    const spawnEntry = result.find((entry) => entry.id === "codex-spawn");
    const waitEntry = result.find((entry) => entry.id === "codex-wait");

    expect(spawnEntry?.subagentGroupMeta).toMatchObject({
      childProviderThreadId: "child-thread-1",
      status: "completed",
    });
    expect(spawnEntry?.isBackgroundCommand).toBe(true);
    expect(spawnEntry?.backgroundLifecycleRole).toBe("launch");
    expect(waitEntry?.subagentGroupMeta).toBeUndefined();
  });

  it("leaves non-agent entries and unmatched agent entries unchanged", () => {
    const entries: WorkLogEntry[] = [
      makeEntry({ id: "command", itemType: "command_execution", command: "ls" }),
      makeEntry({
        id: "unmatched-agent",
        itemType: "collab_agent_tool_call",
        toolCallId: "call_xyz",
        toolName: "Agent",
      }),
    ];

    const result = enrichParentEntriesWithSubagentGroupMetadata(entries);

    expect(result).toHaveLength(2);
    expect(result[0]!.subagentGroupMeta).toBeUndefined();
    expect(result[1]!.subagentGroupMeta).toBeUndefined();
  });

  it("propagates failed status from child completion", () => {
    const entries: WorkLogEntry[] = [
      makeEntry({
        id: "parent",
        itemType: "collab_agent_tool_call",
        toolCallId: "call_fail",
        toolName: "Agent",
      }),
      makeEntry({
        id: "child-started",
        activityKind: "task.started",
        label: "Task started",
        tone: "info",
        childThreadAttribution: { taskId: "t1", childProviderThreadId: "call_fail" },
      }),
      makeEntry({
        id: "child-failed",
        activityKind: "task.completed",
        label: "Task failed",
        tone: "error",
        itemStatus: "failed",
        completedAt: "2026-04-01T00:00:02.000Z",
        childThreadAttribution: { taskId: "t1", childProviderThreadId: "call_fail" },
      }),
    ];

    const result = enrichParentEntriesWithSubagentGroupMetadata(entries);

    expect(result).toHaveLength(1);
    expect(result[0]!.subagentGroupMeta!.status).toBe("failed");
  });

  it("shows running status when child has no completion event", () => {
    const entries: WorkLogEntry[] = [
      makeEntry({
        id: "parent",
        itemType: "collab_agent_tool_call",
        toolCallId: "call_run",
        toolName: "Agent",
      }),
      makeEntry({
        id: "child-started",
        activityKind: "task.started",
        label: "Task started",
        tone: "info",
        childThreadAttribution: { taskId: "t1", childProviderThreadId: "call_run" },
      }),
      makeEntry({
        id: "child-work",
        label: "Editing",
        tone: "tool",
        itemType: "file_change",
        childThreadAttribution: { taskId: "t1", childProviderThreadId: "call_run" },
      }),
    ];

    const result = enrichParentEntriesWithSubagentGroupMetadata(entries);

    expect(result).toHaveLength(1);
    expect(result[0]!.subagentGroupMeta!.status).toBe("running");
    expect(result[0]!.subagentGroupMeta!.recordedActionCount).toBe(1);
  });

  it("truncates fallbackEntries to SUBAGENT_FALLBACK_ENTRY_LIMIT", () => {
    const childWork: WorkLogEntry[] = Array.from({ length: 30 }, (_, i) =>
      makeEntry({
        id: `child-work-${i}`,
        label: `Action ${i}`,
        tone: "tool",
        itemType: "command_execution",
        childThreadAttribution: { taskId: "t1", childProviderThreadId: "call_trunc" },
      }),
    );

    const entries: WorkLogEntry[] = [
      makeEntry({
        id: "parent",
        itemType: "collab_agent_tool_call",
        toolCallId: "call_trunc",
        toolName: "Agent",
      }),
      makeEntry({
        id: "child-started",
        activityKind: "task.started",
        label: "Task started",
        tone: "info",
        childThreadAttribution: { taskId: "t1", childProviderThreadId: "call_trunc" },
      }),
      ...childWork,
      makeEntry({
        id: "child-completed",
        activityKind: "task.completed",
        label: "Task completed",
        tone: "info",
        itemStatus: "completed",
        childThreadAttribution: { taskId: "t1", childProviderThreadId: "call_trunc" },
      }),
    ];

    const result = enrichParentEntriesWithSubagentGroupMetadata(entries);

    expect(result).toHaveLength(1);
    expect(result[0]!.subagentGroupMeta!.recordedActionCount).toBe(30);
    // fallbackEntries should be truncated to the last 20
    expect(result[0]!.subagentGroupMeta!.fallbackEntries).toHaveLength(20);
    expect(result[0]!.subagentGroupMeta!.fallbackEntries[0]!.id).toBe("child-work-10");
    expect(result[0]!.subagentGroupMeta!.fallbackEntries[19]!.id).toBe("child-work-29");
  });

  it("backfills agent metadata from the group onto the parent entry", () => {
    const entries: WorkLogEntry[] = [
      makeEntry({
        id: "parent",
        itemType: "collab_agent_tool_call",
        toolCallId: "call_meta",
        toolName: "Agent",
        // Parent has no agentDescription
      }),
      makeEntry({
        id: "child-started",
        activityKind: "task.started",
        label: "Task started",
        tone: "info",
        agentDescription: "Explore the auth module",
        agentType: "Explore",
        agentModel: "opus",
        childThreadAttribution: {
          taskId: "t1",
          childProviderThreadId: "call_meta",
          agentType: "Explore",
          agentModel: "opus",
        },
      }),
      makeEntry({
        id: "child-completed",
        activityKind: "task.completed",
        label: "Task completed",
        tone: "info",
        itemStatus: "completed",
        childThreadAttribution: { taskId: "t1", childProviderThreadId: "call_meta" },
      }),
    ];

    const result = enrichParentEntriesWithSubagentGroupMetadata(entries);

    expect(result).toHaveLength(1);
    expect(result[0]!.agentType).toBe("Explore");
    expect(result[0]!.agentModel).toBe("opus");
  });

  it("emits a separate completion entry for completed background agents", () => {
    const entries: WorkLogEntry[] = [
      makeEntry({
        id: "bg-parent",
        itemType: "collab_agent_tool_call",
        toolCallId: "call_bg",
        toolName: "Agent",
        isBackgroundCommand: true,
        agentModel: "opus",
        agentDescription: "Research task",
      }),
      makeEntry({
        id: "child-started",
        createdAt: "2026-04-01T00:00:01.000Z",
        activityKind: "task.started",
        label: "Task started",
        tone: "info",
        startedAt: "2026-04-01T00:00:01.000Z",
        childThreadAttribution: { taskId: "t1", childProviderThreadId: "call_bg" },
      }),
      makeEntry({
        id: "child-work",
        label: "Read file",
        tone: "tool",
        itemType: "file_read",
        childThreadAttribution: { taskId: "t1", childProviderThreadId: "call_bg" },
      }),
      makeEntry({
        id: "child-completed",
        createdAt: "2026-04-01T00:00:10.000Z",
        activityKind: "task.completed",
        label: "Task completed",
        tone: "info",
        itemStatus: "completed",
        completedAt: "2026-04-01T00:00:10.000Z",
        childThreadAttribution: { taskId: "t1", childProviderThreadId: "call_bg" },
      }),
    ];

    const result = enrichParentEntriesWithSubagentGroupMetadata(entries);

    // Should have the enriched parent + a separate completion entry
    expect(result).toHaveLength(2);

    // First entry: the parent launch row
    const launch = result[0]!;
    expect(launch.id).toBe("bg-parent");
    expect(launch.backgroundLifecycleRole).toBe("launch");
    expect(launch.subagentGroupMeta).toBeDefined();
    expect(launch.subagentGroupMeta!.status).toBe("completed");

    // Second entry: the completion marker
    const completion = result[1]!;
    expect(completion.id).toBe("bg-parent:background-agent-completed");
    expect(completion.backgroundLifecycleRole).toBe("completion");
    expect(completion.createdAt).toBe("2026-04-01T00:00:10.000Z");
    expect(completion.itemStatus).toBe("completed");
    expect(completion.agentModel).toBe("opus");
    expect(completion.agentDescription).toBe("Research task");
    expect(completion.subagentGroupMeta).toBeUndefined();
  });

  it("treats Codex spawn rows with matched child groups as background launches", () => {
    const entries: WorkLogEntry[] = [
      makeEntry({
        id: "codex-spawn",
        createdAt: "2026-04-01T00:00:00.000Z",
        itemType: "collab_agent_tool_call",
        toolName: "spawnAgent",
        receiverThreadIds: ["child-thread-1"],
        agentDescription: "Inspect parser",
        agentModel: "gpt-5.4-mini",
      }),
      makeEntry({
        id: "child-started",
        createdAt: "2026-04-01T00:00:01.000Z",
        activityKind: "task.started",
        label: "Task started",
        tone: "info",
        startedAt: "2026-04-01T00:00:01.000Z",
        childThreadAttribution: { taskId: "task-1", childProviderThreadId: "child-thread-1" },
      }),
      makeEntry({
        id: "child-completed",
        createdAt: "2026-04-01T00:00:10.000Z",
        activityKind: "task.completed",
        label: "Task completed",
        tone: "info",
        itemStatus: "completed",
        completedAt: "2026-04-01T00:00:10.000Z",
        childThreadAttribution: { taskId: "task-1", childProviderThreadId: "child-thread-1" },
      }),
    ];

    const result = enrichParentEntriesWithSubagentGroupMetadata(entries);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: "codex-spawn",
      isBackgroundCommand: true,
      backgroundLifecycleRole: "launch",
      subagentGroupMeta: {
        childProviderThreadId: "child-thread-1",
        status: "completed",
      },
    });
    expect(result[1]).toMatchObject({
      id: "codex-spawn:background-agent-completed",
      backgroundLifecycleRole: "completion",
      itemStatus: "completed",
    });
  });

  it("emits a failed completion entry for failed background agents", () => {
    const entries: WorkLogEntry[] = [
      makeEntry({
        id: "bg-fail",
        itemType: "collab_agent_tool_call",
        toolCallId: "call_fail_bg",
        toolName: "Agent",
        isBackgroundCommand: true,
      }),
      makeEntry({
        id: "child-started",
        activityKind: "task.started",
        label: "Task started",
        tone: "info",
        childThreadAttribution: { taskId: "t1", childProviderThreadId: "call_fail_bg" },
      }),
      makeEntry({
        id: "child-failed",
        createdAt: "2026-04-01T00:00:05.000Z",
        activityKind: "task.completed",
        label: "Task failed",
        tone: "error",
        itemStatus: "failed",
        completedAt: "2026-04-01T00:00:05.000Z",
        childThreadAttribution: { taskId: "t1", childProviderThreadId: "call_fail_bg" },
      }),
    ];

    const result = enrichParentEntriesWithSubagentGroupMetadata(entries);

    expect(result).toHaveLength(2);
    const completion = result[1]!;
    expect(completion.backgroundLifecycleRole).toBe("completion");
    expect(completion.itemStatus).toBe("failed");
    expect(completion.tone).toBe("error");
    expect(completion.label).toBe("Background agent failed");
  });

  it("does not emit a completion entry for foreground agents", () => {
    const entries: WorkLogEntry[] = [
      makeEntry({
        id: "fg-parent",
        itemType: "collab_agent_tool_call",
        toolCallId: "call_fg",
        toolName: "Agent",
        // no isBackgroundCommand
      }),
      makeEntry({
        id: "child-started",
        activityKind: "task.started",
        label: "Task started",
        tone: "info",
        childThreadAttribution: { taskId: "t1", childProviderThreadId: "call_fg" },
      }),
      makeEntry({
        id: "child-completed",
        activityKind: "task.completed",
        label: "Task completed",
        tone: "info",
        itemStatus: "completed",
        completedAt: "2026-04-01T00:00:05.000Z",
        childThreadAttribution: { taskId: "t1", childProviderThreadId: "call_fg" },
      }),
    ];

    const result = enrichParentEntriesWithSubagentGroupMetadata(entries);

    // Only the parent — no separate completion entry for foreground agents
    expect(result).toHaveLength(1);
    expect(result[0]!.backgroundLifecycleRole).toBeUndefined();
    expect(result[0]!.subagentGroupMeta!.status).toBe("completed");
  });
});
