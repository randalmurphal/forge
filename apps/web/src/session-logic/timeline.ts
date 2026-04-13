import type { OrchestrationLatestTurn, TurnId } from "@forgetools/contracts";

import { debugLog, isWebDebugEnabled } from "../debug";

import type { BackgroundTrayState, TimelineEntry, WorkLogEntry } from "./types";
import type { ChatMessage, ProposedPlan } from "../types";
import { enrichParentEntriesWithSubagentGroupMetadata } from "./subagentGrouping";
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
  const enrichedEntries = enrichParentEntriesWithSubagentGroupMetadata(workEntries);
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
  const workRows: TimelineEntry[] = enrichedEntries.map((entry) => {
    const workRow: TimelineEntry = {
      id: entry.id,
      kind: "work",
      createdAt: entry.createdAt,
      entry,
    };
    if (entry.sequence !== undefined) {
      workRow.sequence = entry.sequence;
    }
    return workRow;
  });
  return [...messageRows, ...proposedPlanRows, ...workRows].toSorted(compareTimelineEntries);
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
  const enrichedEntries = enrichParentEntriesWithSubagentGroupMetadata(workEntries);

  // Background agents: only entries explicitly marked as background with subagent group metadata.
  // Foreground subagents render inline and never appear in the tray.
  const visibleAgentEntries = enrichedEntries.filter((entry) => {
    if (!entry.subagentGroupMeta || entry.isBackgroundCommand !== true) {
      return false;
    }
    const meta = entry.subagentGroupMeta;
    if (meta.status === "running") {
      return true;
    }
    return isWithinBackgroundTaskRetention(meta.completedAt ?? meta.startedAt, nowIso);
  });

  const visibleCommandEntries = deriveVisibleBackgroundCommandEntries(enrichedEntries, nowIso);

  if (DEBUG_BACKGROUND_TASKS) {
    const trayCommandDecisions = enrichedEntries
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
        visibleAgents: visibleAgentEntries.map((entry) => ({
          id: entry.id,
          status: entry.subagentGroupMeta?.status,
          label: entry.agentDescription ?? entry.label,
        })),
      },
    });
  }

  return {
    agentEntries: visibleAgentEntries,
    commandEntries: visibleCommandEntries,
    hiddenWorkEntryIds: [],
    hasRunningTasks:
      visibleAgentEntries.some((entry) => entry.subagentGroupMeta?.status === "running") ||
      visibleCommandEntries.some((entry) => deriveBackgroundCommandStatus(entry) === "running"),
    defaultCollapsed: visibleAgentEntries.length + visibleCommandEntries.length >= 5,
  };
}
