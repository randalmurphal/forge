import { describe, expect, it } from "vitest";

import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";
import { type TimelineEntry } from "../../session-logic";

describe("deriveMessagesTimelineRows", () => {
  it("keeps read and search activities grouped as operations", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        makeWorkEntry({
          id: "read-1",
          itemType: "file_read",
          label: "Read",
          filePath: "/tmp/example.ts",
        }),
        makeWorkEntry({
          id: "search-1",
          itemType: "search",
          label: "Grep",
          searchPattern: "storeArtifact",
        }),
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("work-group");
    if (rows[0]?.kind === "work-group") {
      expect(rows[0].groupedEntries.map((entry) => entry.id)).toEqual(["read-1", "search-1"]);
    }
  });

  it("renders commands and file changes as standalone rows", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        makeWorkEntry({
          id: "command-1",
          itemType: "command_execution",
          label: "Command",
          command: "bun fmt",
        }),
        makeWorkEntry({
          id: "edit-1",
          itemType: "file_change",
          label: "Edit",
          changedFiles: ["src/example.ts"],
        }),
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
    });

    expect(rows.map((row) => row.kind)).toEqual(["work-entry", "work-entry"]);
  });

  it("does not group operations across standalone command or edit rows", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        makeWorkEntry({
          id: "read-1",
          itemType: "file_read",
          label: "Read",
          filePath: "/tmp/example.ts",
        }),
        makeWorkEntry({
          id: "command-1",
          itemType: "command_execution",
          label: "Command",
          command: "bun fmt",
        }),
        makeWorkEntry({
          id: "search-1",
          itemType: "search",
          label: "Grep",
          searchPattern: "storeArtifact",
        }),
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
    });

    expect(rows.map((row) => row.kind)).toEqual(["work-group", "work-entry", "work-group"]);
  });

  it("keeps running subagent groups out of the timeline", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        makeWorkEntry({
          id: "subagent-running",
          label: "Subagent task",
          childThreadAttribution: {
            taskId: "task-1",
            childProviderThreadId: "child-1",
          },
        }),
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
    });

    expect(rows).toEqual([]);
  });

  it("keeps completed subagent groups inline in the timeline", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        makeWorkEntry({
          id: "spawn-inline",
          label: "Spawn agent",
          itemType: "collab_agent_tool_call",
          agentPrompt: "Verify background state",
          agentModel: "gpt-5.4-mini",
          receiverThreadIds: ["child-2"],
        }),
        makeWorkEntry({
          id: "task-started",
          label: "Task started",
          activityKind: "task.started",
          detail: "Verify background state",
          childThreadAttribution: {
            taskId: "task-2",
            childProviderThreadId: "child-2",
          },
        }),
        makeWorkEntry({
          id: "subagent-work",
          label: "Subagent task",
          childThreadAttribution: {
            taskId: "task-2",
            childProviderThreadId: "child-2",
          },
        }),
        makeWorkEntry({
          id: "task-completed",
          label: "Task completed",
          activityKind: "task.completed",
          childThreadAttribution: {
            taskId: "task-2",
            childProviderThreadId: "child-2",
          },
        }),
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.kind).toBe("work-entry");
    expect(rows[1]?.kind).toBe("subagent-section");
    if (rows[1]?.kind === "subagent-section") {
      expect(rows[1].subagentGroups).toHaveLength(1);
      expect(rows[1].subagentGroups[0]).toMatchObject({
        status: "completed",
        recordedActionCount: 1,
        entries: [expect.objectContaining({ id: "subagent-work" })],
        label: "Verify background state",
        agentModel: "gpt-5.4-mini",
      });
    }
  });

  it("keeps only a bounded tail of completed subagent activity entries inline", () => {
    const subagentEntries = Array.from({ length: 25 }, (_, index) =>
      makeWorkEntry({
        id: `subagent-work-${index + 1}`,
        label: `Subagent work ${index + 1}`,
        itemType: "command_execution",
        command: `echo ${index + 1}`,
        childThreadAttribution: {
          taskId: "task-tail",
          childProviderThreadId: "child-tail",
        },
      }),
    );

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        makeWorkEntry({
          id: "task-tail-started",
          label: "Task started",
          activityKind: "task.started",
          detail: "Tail preservation",
          childThreadAttribution: {
            taskId: "task-tail",
            childProviderThreadId: "child-tail",
          },
        }),
        ...subagentEntries,
        makeWorkEntry({
          id: "task-tail-completed",
          label: "Task completed",
          activityKind: "task.completed",
          childThreadAttribution: {
            taskId: "task-tail",
            childProviderThreadId: "child-tail",
          },
        }),
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("subagent-section");
    if (rows[0]?.kind === "subagent-section") {
      expect(rows[0].subagentGroups).toHaveLength(1);
      expect(rows[0].subagentGroups[0]?.recordedActionCount).toBe(25);
      expect(rows[0].subagentGroups[0]?.entries.map((entry) => entry.id)).toEqual([
        "subagent-work-6",
        "subagent-work-7",
        "subagent-work-8",
        "subagent-work-9",
        "subagent-work-10",
        "subagent-work-11",
        "subagent-work-12",
        "subagent-work-13",
        "subagent-work-14",
        "subagent-work-15",
        "subagent-work-16",
        "subagent-work-17",
        "subagent-work-18",
        "subagent-work-19",
        "subagent-work-20",
        "subagent-work-21",
        "subagent-work-22",
        "subagent-work-23",
        "subagent-work-24",
        "subagent-work-25",
      ]);
    }
  });
});

function makeWorkEntry(entry: {
  id: string;
  label: string;
  itemType?: string;
  command?: string;
  changedFiles?: string[];
  filePath?: string;
  searchPattern?: string;
  tone?: "tool" | "info" | "error";
  activityKind?: string;
  detail?: string;
  agentPrompt?: string;
  agentModel?: string;
  receiverThreadIds?: string[];
  childThreadAttribution?: {
    taskId: string;
    childProviderThreadId: string;
  };
}): TimelineEntry {
  return {
    id: entry.id,
    kind: "work",
    createdAt: `2026-04-09T01:00:0${entry.id.length}.000Z`,
    entry: {
      id: entry.id,
      createdAt: `2026-04-09T01:00:0${entry.id.length}.000Z`,
      label: entry.label,
      tone: entry.tone ?? "tool",
      ...(entry.itemType ? { itemType: entry.itemType as never } : {}),
      ...(entry.command ? { command: entry.command } : {}),
      ...(entry.changedFiles ? { changedFiles: entry.changedFiles } : {}),
      ...(entry.filePath ? { filePath: entry.filePath } : {}),
      ...(entry.searchPattern ? { searchPattern: entry.searchPattern } : {}),
      ...(entry.activityKind ? { activityKind: entry.activityKind } : {}),
      ...(entry.detail ? { detail: entry.detail } : {}),
      ...(entry.agentPrompt ? { agentPrompt: entry.agentPrompt } : {}),
      ...(entry.agentModel ? { agentModel: entry.agentModel } : {}),
      ...(entry.receiverThreadIds ? { receiverThreadIds: entry.receiverThreadIds } : {}),
      ...(entry.childThreadAttribution
        ? { childThreadAttribution: entry.childThreadAttribution }
        : {}),
    },
  };
}
