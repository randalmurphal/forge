import type { OrchestrationLatestTurn, TurnId } from "@forgetools/contracts";

import { debugLog, isWebDebugEnabled } from "../debug";

import type { BackgroundTrayState, SubagentGroup, TimelineEntry, WorkLogEntry } from "./types";
import type { ChatMessage, ProposedPlan } from "../types";
import {
  groupSubagentEntries,
  enrichSubagentGroupsWithControlMetadata,
  retainCompletedSubagentEntryTail,
  compactSubagentGroups,
} from "./subagentGrouping";
import {
  deriveBackgroundCommandStatus,
  deriveVisibleBackgroundCommandEntries,
  isWithinBackgroundTaskRetention,
  summarizeBackgroundTrayCommandDecision,
} from "./backgroundSignals";

const DEBUG_BACKGROUND_TASKS = isWebDebugEnabled("background");

export function hasToolActivityForTurn(
  activities: ReadonlyArray<{ turnId?: TurnId | null; tone: string }>,
  turnId: TurnId | null | undefined,
): boolean {
  if (!turnId) return false;
  return activities.some((activity) => activity.turnId === turnId && activity.tone === "tool");
}

export function deriveTimelineEntries(
  messages: ChatMessage[],
  proposedPlans: ProposedPlan[],
  workEntries: WorkLogEntry[],
): TimelineEntry[] {
  const { standalone, subagentGroups } = groupSubagentEntries(workEntries);
  const messageRows: TimelineEntry[] = messages.map((message) => ({
    id: message.id,
    kind: "message",
    createdAt: message.createdAt,
    ...(message.sequence !== undefined ? { sequence: message.sequence } : {}),
    message,
  }));
  const proposedPlanRows: TimelineEntry[] = proposedPlans.map((proposedPlan) => ({
    id: proposedPlan.id,
    kind: "proposed-plan",
    createdAt: proposedPlan.createdAt,
    proposedPlan,
  }));
  const workRows: TimelineEntry[] = standalone.map((entry) => ({
    id: entry.id,
    kind: "work",
    createdAt: entry.createdAt,
    ...(entry.sequence !== undefined ? { sequence: entry.sequence } : {}),
    entry,
  }));
  const subagentSectionRows: TimelineEntry[] = enrichSubagentGroupsWithControlMetadata(
    subagentGroups,
    standalone,
  )
    .filter((group) => group.status !== "running" && group.completedAt)
    .map((group) => {
      const row: TimelineEntry = {
        id: `subagent-section:${group.groupId}:${group.completedAt}`,
        kind: "subagent-section",
        // Completed subagents belong in history when the child task actually finishes, not when the
        // earliest nested child activity started. Using completedAt here keeps history append-stable
        // instead of backfilling old rows once the tray TTL expires.
        createdAt: group.completedAt!,
        subagentGroups: [retainCompletedSubagentEntryTail(group)],
      };
      if (group.completedSequence !== undefined) {
        row.sequence = group.completedSequence;
      }
      return row;
    });
  return [...messageRows, ...proposedPlanRows, ...workRows, ...subagentSectionRows].toSorted(
    compareTimelineEntries,
  );
}

function compareTimelineEntries(left: TimelineEntry, right: TimelineEntry): number {
  if (
    left.sequence !== undefined &&
    right.sequence !== undefined &&
    left.sequence !== right.sequence
  ) {
    return left.sequence - right.sequence;
  }

  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  return left.id.localeCompare(right.id);
}

export function deriveCompletionDividerBeforeEntryId(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  latestTurn: Pick<
    OrchestrationLatestTurn,
    "assistantMessageId" | "startedAt" | "completedAt"
  > | null,
): string | null {
  if (!latestTurn?.startedAt || !latestTurn.completedAt) {
    return null;
  }

  if (latestTurn.assistantMessageId) {
    const exactMatch = timelineEntries.find(
      (timelineEntry) =>
        timelineEntry.kind === "message" &&
        timelineEntry.message.role === "assistant" &&
        timelineEntry.message.id === latestTurn.assistantMessageId,
    );
    if (exactMatch) {
      return exactMatch.id;
    }
  }

  const turnStartedAt = Date.parse(latestTurn.startedAt);
  const turnCompletedAt = Date.parse(latestTurn.completedAt);
  if (Number.isNaN(turnStartedAt) || Number.isNaN(turnCompletedAt)) {
    return null;
  }

  let inRangeMatch: string | null = null;
  let fallbackMatch: string | null = null;
  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message" || timelineEntry.message.role !== "assistant") {
      continue;
    }
    const messageAt = Date.parse(timelineEntry.message.createdAt);
    if (Number.isNaN(messageAt) || messageAt < turnStartedAt) {
      continue;
    }
    fallbackMatch = timelineEntry.id;
    if (messageAt <= turnCompletedAt) {
      inRangeMatch = timelineEntry.id;
    }
  }
  return inRangeMatch ?? fallbackMatch;
}

export function deriveBackgroundTrayState(
  workEntries: ReadonlyArray<WorkLogEntry>,
  nowIso: string,
): BackgroundTrayState {
  const { standalone, subagentGroups } = groupSubagentEntries(workEntries);
  const visibleSubagentGroups = compactSubagentGroups(
    enrichSubagentGroupsWithControlMetadata(
      subagentGroups.filter((group) => isSubagentGroupVisibleInTray(group, nowIso)),
      standalone,
    ),
  );
  const visibleCommandEntries = deriveVisibleBackgroundCommandEntries(standalone, nowIso);

  if (DEBUG_BACKGROUND_TASKS) {
    const trayCommandDecisions = standalone
      .map((entry) => summarizeBackgroundTrayCommandDecision(entry, nowIso))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    debugLog({
      topic: "background",
      source: "session-logic",
      label: "tray",
      details: {
        nowIso,
        commandDecisions: trayCommandDecisions,
        visibleCommands: visibleCommandEntries.map((entry) => ({
          id: entry.id,
          toolCallId: entry.toolCallId,
          processId: entry.processId,
          command: entry.command,
          itemStatus: entry.itemStatus,
          isBackgroundCommand: entry.isBackgroundCommand === true,
          commandSource: entry.commandSource ?? null,
          status: deriveBackgroundCommandStatus(entry),
        })),
        visibleSubagents: visibleSubagentGroups.map((group) => ({
          groupId: group.groupId,
          taskId: group.taskId,
          status: group.status,
          label: group.label,
        })),
      },
    });
  }

  return {
    subagentGroups: visibleSubagentGroups,
    commandEntries: visibleCommandEntries,
    // The tray mirrors active background work. It is not allowed to own timeline visibility,
    // otherwise rows disappear and later reappear at older timestamps.
    hiddenSubagentGroupIds: [],
    hiddenWorkEntryIds: [],
    hasRunningTasks:
      visibleSubagentGroups.some((group) => group.status === "running") ||
      visibleCommandEntries.some((entry) => deriveBackgroundCommandStatus(entry) === "running"),
    defaultCollapsed: visibleSubagentGroups.length + visibleCommandEntries.length >= 5,
  };
}

function isSubagentGroupVisibleInTray(group: SubagentGroup, nowIso: string): boolean {
  if (group.status === "running") {
    return true;
  }
  return isWithinBackgroundTaskRetention(group.completedAt ?? group.startedAt, nowIso);
}
