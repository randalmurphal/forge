import { type MessageId } from "@forgetools/contracts";
import {
  type ExpandedInlineDiffState,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { estimateTimelineMessageHeight } from "../timelineHeight";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;
const COMMAND_OUTPUT_TIMELINE_MAX_HEIGHT_PX = 320;

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

export type MessagesTimelineRow =
  | {
      kind: "work-group";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
    }
  | {
      kind: "work-entry";
      id: string;
      createdAt: string;
      entry: WorkLogEntry;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showCompletionDivider: boolean;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      kind: "working";
      id: string;
      createdAt: string | null;
      participantLabels: ReadonlyArray<{ label: string; role: string }>;
    };

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  completionDividerBeforeEntryId: string | null;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
  workingParticipantLabels?: ReadonlyArray<{ label: string; role: string }>;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      // Collect all consecutive work entries. Child-attributed entries have already been consumed
      // into subagentGroupMeta on the parent entry by enrichParentEntriesWithSubagentGroupMetadata.
      const allWorkEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (!nextEntry || nextEntry.kind !== "work") break;
        allWorkEntries.push(nextEntry.entry);
        cursor += 1;
      }

      if (allWorkEntries.length === 0) {
        index = cursor - 1;
        continue;
      }

      let workIndex = 0;
      while (workIndex < allWorkEntries.length) {
        const entry = allWorkEntries[workIndex]!;
        if (shouldRenderStandaloneWorkEntry(entry)) {
          nextRows.push({
            kind: "work-entry",
            id: entry.id,
            createdAt: entry.createdAt,
            entry,
          });
          workIndex += 1;
          continue;
        }

        const groupedEntries = [entry];
        let groupCursor = workIndex + 1;
        while (groupCursor < allWorkEntries.length) {
          const nextEntry = allWorkEntries[groupCursor];
          if (!nextEntry || shouldRenderStandaloneWorkEntry(nextEntry)) break;
          groupedEntries.push(nextEntry);
          groupCursor += 1;
        }
        nextRows.push({
          kind: "work-group",
          id: entry.id,
          createdAt: entry.createdAt,
          groupedEntries,
        });
        workIndex = groupCursor;
      }

      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart:
        durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt,
      showCompletionDivider:
        timelineEntry.message.role === "assistant" &&
        input.completionDividerBeforeEntryId === timelineEntry.id,
    });
  }

  if (input.isWorking) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
      participantLabels: input.workingParticipantLabels ?? [],
    });
  }

  return nextRows;
}
export const AGENT_CHILD_ENTRIES_MAX_HEIGHT_PX = 384;

export function estimateMessagesTimelineRowHeight(
  row: MessagesTimelineRow,
  input: {
    timelineWidthPx: number | null;
    expandedWorkGroups?: Readonly<Record<string, boolean>>;
    expandedInlineDiff?: ExpandedInlineDiffState;
    expandedCommandOutputIds?: Readonly<Record<string, boolean>>;
    expandedAgentEntryIds?: Readonly<Record<string, boolean>>;
    turnDiffSummaryByAssistantMessageId?: ReadonlyMap<MessageId, TurnDiffSummary>;
  },
): number {
  switch (row.kind) {
    case "work-group":
      return estimateWorkGroupRowHeight(row, input);
    case "work-entry":
      return estimateStandaloneWorkRowHeight(row, input);
    case "proposed-plan":
      return estimateTimelineProposedPlanHeight(row.proposedPlan);
    case "working":
      return 40 + Math.max(0, row.participantLabels.length - 1) * 18;
    case "message": {
      let estimate = estimateTimelineMessageHeight(row.message, {
        timelineWidthPx: input.timelineWidthPx,
      });
      const turnDiffSummary = input.turnDiffSummaryByAssistantMessageId?.get(row.message.id);
      if (turnDiffSummary && turnDiffSummary.files.length > 0) {
        estimate +=
          input.expandedInlineDiff?.scope === "turn" &&
          input.expandedInlineDiff.id === turnDiffSummary.turnId
            ? 520
            : estimateCollapsedDiffCardHeight();
      }
      return estimate;
    }
  }
}

function estimateWorkGroupRowHeight(
  row: Extract<MessagesTimelineRow, { kind: "work-group" }>,
  input: {
    expandedWorkGroups?: Readonly<Record<string, boolean>>;
    expandedInlineDiff?: ExpandedInlineDiffState;
    expandedCommandOutputIds?: Readonly<Record<string, boolean>>;
  },
): number {
  const isExpanded = input.expandedWorkGroups?.[row.id] ?? false;
  const hasOverflow = row.groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleEntries =
    hasOverflow && !isExpanded ? MAX_VISIBLE_WORK_LOG_ENTRIES : row.groupedEntries.length;
  const onlyToolEntries = row.groupedEntries.every((entry) => entry.tone === "tool");
  const showHeader = hasOverflow || !onlyToolEntries;

  // Card chrome, optional header, and one compact work-entry row per visible entry.
  let estimate = 28 + (showHeader ? 26 : 0) + visibleEntries * 32;
  for (const entry of row.groupedEntries.slice(-visibleEntries)) {
    estimate += estimateExpandedCommandOutputHeight(entry, input.expandedCommandOutputIds);
    estimate += estimateExpandedDetailItemsHeight(entry, input.expandedCommandOutputIds);
    if (!entry.inlineDiff) continue;
    estimate +=
      input.expandedInlineDiff?.scope === "tool" && input.expandedInlineDiff.id === entry.id
        ? entry.inlineDiff.availability === "exact_patch"
          ? 420
          : 130
        : estimateCollapsedDiffCardHeight();
  }
  return estimate;
}

function estimateStandaloneWorkRowHeight(
  row: Extract<MessagesTimelineRow, { kind: "work-entry" }>,
  input: {
    expandedInlineDiff?: ExpandedInlineDiffState;
    expandedCommandOutputIds?: Readonly<Record<string, boolean>>;
    expandedAgentEntryIds?: Readonly<Record<string, boolean>>;
  },
): number {
  let estimate = 58;
  estimate += estimateExpandedCommandOutputHeight(row.entry, input.expandedCommandOutputIds);
  estimate += estimateExpandedDetailItemsHeight(row.entry, input.expandedCommandOutputIds);
  if (row.entry.inlineDiff) {
    estimate +=
      input.expandedInlineDiff?.scope === "tool" && input.expandedInlineDiff.id === row.entry.id
        ? row.entry.inlineDiff.availability === "exact_patch"
          ? 420
          : 130
        : estimateCollapsedDiffCardHeight();
  }
  // Expanded agent rows show prompt + scrollable child activity feed
  if (input.expandedAgentEntryIds?.[row.entry.id]) {
    const meta = row.entry.subagentGroupMeta;
    if (row.entry.agentPrompt) {
      estimate += 80; // Prompt panel
    }
    if (meta) {
      const childContentHeight = meta.recordedActionCount * 32;
      estimate += Math.min(childContentHeight, AGENT_CHILD_ENTRIES_MAX_HEIGHT_PX) + 24;
    }
  }
  return estimate;
}

function estimateTimelineProposedPlanHeight(proposedPlan: ProposedPlan): number {
  const estimatedLines = Math.max(1, Math.ceil(proposedPlan.planMarkdown.length / 72));
  return 120 + Math.min(estimatedLines * 22, 880);
}

function estimateCollapsedDiffCardHeight(): number {
  return 52;
}

function estimateExpandedCommandOutputHeight(
  entry: WorkLogEntry,
  expandedCommandOutputIds: Readonly<Record<string, boolean>> | undefined,
): number {
  if (
    entry.itemType !== "command_execution" ||
    !(entry.hasOutput || entry.output) ||
    !(expandedCommandOutputIds?.[entry.id] ?? false)
  ) {
    return 0;
  }
  const lineCount = entry.output ? entry.output.split("\n").length : 12;
  const estimatedBodyHeight = Math.min(COMMAND_OUTPUT_TIMELINE_MAX_HEIGHT_PX, lineCount * 17 + 20);
  return 16 + 30 + estimatedBodyHeight;
}

function estimateExpandedDetailItemsHeight(
  entry: WorkLogEntry,
  expandedCommandOutputIds: Readonly<Record<string, boolean>> | undefined,
): number {
  if (!(expandedCommandOutputIds?.[entry.id] ?? false) || (entry.detailItems?.length ?? 0) === 0) {
    return 0;
  }

  const estimatedValueLines = (entry.detailItems ?? []).reduce((total, item) => {
    return total + Math.max(1, Math.ceil(item.value.length / 56));
  }, 0);

  return 16 + 26 + estimatedValueLines * 18;
}

function shouldRenderStandaloneWorkEntry(entry: WorkLogEntry): boolean {
  return (
    entry.itemType === "command_execution" ||
    entry.itemType === "collab_agent_tool_call" ||
    entry.itemType === "file_change" ||
    entry.inlineDiff !== undefined ||
    Boolean(entry.command)
  );
}
