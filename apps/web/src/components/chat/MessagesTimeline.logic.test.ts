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
});

function makeWorkEntry(entry: {
  id: string;
  label: string;
  itemType?: string;
  command?: string;
  changedFiles?: string[];
  filePath?: string;
  searchPattern?: string;
}): TimelineEntry {
  return {
    id: entry.id,
    kind: "work",
    createdAt: `2026-04-09T01:00:0${entry.id.length}.000Z`,
    entry: {
      id: entry.id,
      createdAt: `2026-04-09T01:00:0${entry.id.length}.000Z`,
      label: entry.label,
      tone: "tool",
      ...(entry.itemType ? { itemType: entry.itemType as never } : {}),
      ...(entry.command ? { command: entry.command } : {}),
      ...(entry.changedFiles ? { changedFiles: entry.changedFiles } : {}),
      ...(entry.filePath ? { filePath: entry.filePath } : {}),
      ...(entry.searchPattern ? { searchPattern: entry.searchPattern } : {}),
    },
  };
}
