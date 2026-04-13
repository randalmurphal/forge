import type { OrchestrationThreadActivity, TurnId } from "@forgetools/contracts";

import { debugLog, isWebDebugEnabled } from "../debug";

import type {
  DerivedWorkLogEntry,
  DeriveWorkLogEntriesOptions,
  ToolInlineDiffSummary,
  WorkLogEntry,
} from "./types";
import type { TurnDiffFileChange } from "../types";
import { compareActivitiesByOrder, earliestIsoValue, latestIsoValue } from "./utils";
import { toDerivedWorkLogEntry, summarizeToolInlineDiffFiles } from "./toolEnrichment";
import {
  synthesizeCodexSubagentLifecycleActivities,
  synthesizeClaudeTaskOutputLifecycleActivities,
  isUnattributedCollabAgentToolEnvelope,
  shouldFilterToolStartedActivity,
  enrichVisibleCollabControlEntriesWithTargetMetadata,
} from "./subagentGrouping";
import {
  collectStreamedCommandOutputByToolCallId,
  collectStreamedCommandOutputPresenceByToolCallId,
  applyPreCollapseBackgroundCommandSignals,
  applyStreamedCommandOutput,
  applyBackgroundCommandSignals,
  appendBackgroundCommandCompletionEntries,
  deriveCodexBackgroundCommandSignals,
  summarizeBackgroundRelevantActivity,
  summarizeBackgroundRelevantEntry,
} from "./backgroundSignals";

const DEBUG_BACKGROUND_TASKS = isWebDebugEnabled("background");

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  input: DeriveWorkLogEntriesOptions | TurnId | undefined,
): WorkLogEntry[] {
  const scope = typeof input === "object" && input !== null ? input.scope : "all-turns";
  const latestTurnId = typeof input === "object" && input !== null ? input.latestTurnId : input;
  const messages = typeof input === "object" && input !== null ? input.messages : undefined;
  const latestTurn =
    typeof input === "object" && input !== null ? (input.latestTurn ?? null) : null;
  const scopedActivities = [...activities]
    .toSorted(compareActivitiesByOrder)
    .filter((activity) =>
      scope === "latest-turn" && latestTurnId ? activity.turnId === latestTurnId : true,
    )
    .filter((activity) => activity.kind !== "context-window.updated")
    .filter((activity) => activity.summary !== "Checkpoint captured")
    .filter((activity) => !isPlanBoundaryToolActivity(activity));
  const ordered = [
    ...scopedActivities,
    ...synthesizeCodexSubagentLifecycleActivities(scopedActivities),
    ...synthesizeClaudeTaskOutputLifecycleActivities(scopedActivities),
  ].toSorted(compareActivitiesByOrder);
  if (DEBUG_BACKGROUND_TASKS) {
    const relevantActivities = ordered
      .map(summarizeBackgroundRelevantActivity)
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    if (relevantActivities.length > 0) {
      debugLog({
        topic: "background",
        source: "session-logic",
        label: "activities",
        details: relevantActivities,
      });
    }
  }
  const streamedCommandOutputByToolCallId = collectStreamedCommandOutputByToolCallId(ordered);
  const streamedCommandOutputPresenceByToolCallId =
    collectStreamedCommandOutputPresenceByToolCallId(ordered);
  const codexBackgroundSignals = deriveCodexBackgroundCommandSignals({
    activities: ordered,
    messages,
    latestTurn: latestTurn ?? null,
  });
  const rawEntries = ordered
    .filter((activity) => !shouldFilterToolStartedActivity(activity))
    .filter((activity) => activity.kind !== "tool.output.delta")
    .filter((activity) => activity.kind !== "tool.terminal.interaction")
    .filter((activity) => !isUnattributedCollabAgentToolEnvelope(activity))
    .filter((activity) => {
      if (
        activity.kind === "task.started" ||
        activity.kind === "task.completed" ||
        activity.kind === "task.updated"
      ) {
        const activityPayload =
          activity.payload && typeof activity.payload === "object"
            ? (activity.payload as Record<string, unknown>)
            : null;
        // Only keep entries that have child thread attribution — these are subagent boundaries.
        // Parent-thread task events (which also have taskId) should stay filtered out.
        // task.updated without attribution still reaches deriveProviderBackgroundTaskSignals
        // via the unfiltered `ordered` activity list.
        return activityPayload?.childThreadAttribution != null;
      }
      return true;
    })
    .map(toDerivedWorkLogEntry);
  const entries = applyPreCollapseBackgroundCommandSignals(rawEntries, codexBackgroundSignals);
  if (DEBUG_BACKGROUND_TASKS) {
    const relevantEntries = entries
      .map(summarizeBackgroundRelevantEntry)
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    if (relevantEntries.length > 0) {
      debugLog({
        topic: "background",
        source: "session-logic",
        label: "entries.preCollapse",
        details: relevantEntries,
      });
    }
  }
  const collapsedEntries = collapseDerivedWorkLogEntries(entries);
  if (DEBUG_BACKGROUND_TASKS) {
    const relevantCollapsedEntries = collapsedEntries
      .map(summarizeBackgroundRelevantEntry)
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    if (relevantCollapsedEntries.length > 0) {
      debugLog({
        topic: "background",
        source: "session-logic",
        label: "entries.collapsed",
        details: relevantCollapsedEntries,
      });
    }
  }
  const entriesWithOutput = applyStreamedCommandOutput(
    collapsedEntries,
    streamedCommandOutputByToolCallId,
    streamedCommandOutputPresenceByToolCallId,
  );
  const entriesWithBackgroundSignals = applyBackgroundCommandSignals(entriesWithOutput, {
    activities: ordered,
    codexBackgroundSignals,
  });
  const entriesWithBackgroundCompletionRows = appendBackgroundCommandCompletionEntries(
    entriesWithBackgroundSignals,
  );
  const entriesWithCollabMetadata = enrichVisibleCollabControlEntriesWithTargetMetadata(
    entriesWithBackgroundCompletionRows,
  );
  if (DEBUG_BACKGROUND_TASKS) {
    const relevantFinalEntries = entriesWithCollabMetadata
      .map(summarizeBackgroundRelevantEntry)
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    if (relevantFinalEntries.length > 0) {
      debugLog({
        topic: "background",
        source: "session-logic",
        label: "entries.final",
        details: relevantFinalEntries,
      });
    }
  }
  return entriesWithCollabMetadata.map(({ collapseKey: _collapseKey, ...entry }) => entry);
}

function isPlanBoundaryToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") {
    return false;
  }

  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return typeof payload?.detail === "string" && payload.detail.startsWith("ExitPlanMode:");
}

function collapseDerivedWorkLogEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const collapsed: DerivedWorkLogEntry[] = [];
  const activeLifecycleEntryIndexes = new Map<string, number>();
  for (const entry of entries) {
    const lifecycleEntryKey = deriveLifecycleEntryKey(entry);
    const activeIndex =
      lifecycleEntryKey === undefined
        ? undefined
        : activeLifecycleEntryIndexes.get(lifecycleEntryKey);
    if (activeIndex !== undefined) {
      const activeEntry = collapsed[activeIndex];
      if (activeEntry && shouldCollapseToolLifecycleEntries(activeEntry, entry)) {
        const mergedEntry = mergeDerivedWorkLogEntries(activeEntry, entry);
        collapsed[activeIndex] = mergedEntry;
        if (lifecycleEntryKey !== undefined) {
          if (isLifecycleEntryCompleted(mergedEntry)) {
            activeLifecycleEntryIndexes.delete(lifecycleEntryKey);
          } else {
            activeLifecycleEntryIndexes.set(lifecycleEntryKey, activeIndex);
          }
        }
        continue;
      }
    }

    const previous = collapsed.at(-1);
    if (previous && shouldCollapseToolLifecycleEntries(previous, entry)) {
      const mergedEntry = mergeDerivedWorkLogEntries(previous, entry);
      collapsed[collapsed.length - 1] = mergedEntry;
      const previousLifecycleKey = deriveLifecycleEntryKey(previous);
      if (previousLifecycleKey !== undefined) {
        if (isLifecycleEntryCompleted(mergedEntry)) {
          activeLifecycleEntryIndexes.delete(previousLifecycleKey);
        } else {
          activeLifecycleEntryIndexes.set(previousLifecycleKey, collapsed.length - 1);
        }
      }
      continue;
    }

    collapsed.push(entry);
    if (lifecycleEntryKey !== undefined && !isLifecycleEntryCompleted(entry)) {
      activeLifecycleEntryIndexes.set(lifecycleEntryKey, collapsed.length - 1);
    }
  }
  return collapsed;
}

function deriveLifecycleEntryKey(entry: DerivedWorkLogEntry): string | undefined {
  if (!isCollapsibleToolLifecycleEntry(entry)) {
    return undefined;
  }
  return `${entry.turnId ?? ""}\u001f${entry.collapseKey}`;
}

function isLifecycleEntryCompleted(entry: DerivedWorkLogEntry): boolean {
  return entry.activityKind === "tool.completed";
}

function shouldCollapseToolLifecycleEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean {
  if (!isCollapsibleToolLifecycleEntry(previous)) {
    return false;
  }
  if (!isCollapsibleToolLifecycleEntry(next)) {
    return false;
  }
  if (previous.activityKind === "tool.completed") {
    return false;
  }
  if (previous.turnId !== next.turnId) {
    return false;
  }
  if (
    previous.itemType === "command_execution" &&
    next.itemType === "command_execution" &&
    (previous.isBackgroundCommand === true || next.isBackgroundCommand === true) &&
    next.backgroundLifecycleRole === "completion"
  ) {
    return false;
  }
  return previous.collapseKey !== undefined && previous.collapseKey === next.collapseKey;
}

function isCollapsibleToolLifecycleEntry(entry: DerivedWorkLogEntry): boolean {
  return (
    (entry.activityKind === "tool.started" ||
      entry.activityKind === "tool.updated" ||
      entry.activityKind === "tool.completed") &&
    entry.collapseKey !== undefined
  );
}

function mergeDerivedWorkLogEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): DerivedWorkLogEntry {
  const createdAt = earliestIsoValue(previous.createdAt, next.createdAt) ?? next.createdAt;
  const changedFiles = mergeChangedFiles(previous.changedFiles, next.changedFiles);
  const detail = next.detail ?? previous.detail;
  const command = next.command ?? previous.command;
  const toolTitle = next.toolTitle ?? previous.toolTitle;
  const itemType = next.itemType ?? previous.itemType;
  const requestKind = next.requestKind ?? previous.requestKind;
  const inlineDiff = mergeToolInlineDiffSummaries(previous.inlineDiff, next.inlineDiff);
  const collapseKey = next.collapseKey ?? previous.collapseKey;
  const toolName = next.toolName ?? previous.toolName;
  const exitCode = next.exitCode ?? previous.exitCode;
  const durationMs = next.durationMs ?? previous.durationMs;
  const output = next.output ?? previous.output;
  const hasOutput = Boolean(previous.hasOutput || next.hasOutput || output);
  const outputByteLength = next.outputByteLength ?? previous.outputByteLength;
  const outputSource = next.outputSource ?? previous.outputSource;
  const startedAt = earliestIsoValue(previous.startedAt, next.startedAt);
  const completedAt = latestIsoValue(previous.completedAt, next.completedAt);
  const itemStatus = next.itemStatus ?? previous.itemStatus;
  const isBackgroundCommand = Boolean(previous.isBackgroundCommand || next.isBackgroundCommand);
  const backgroundLifecycleRole = next.backgroundLifecycleRole ?? previous.backgroundLifecycleRole;
  const backgroundTaskId = next.backgroundTaskId ?? previous.backgroundTaskId;
  const backgroundTaskStatus = next.backgroundTaskStatus ?? previous.backgroundTaskStatus;
  const backgroundCompletedAt = latestIsoValue(
    previous.backgroundCompletedAt,
    next.backgroundCompletedAt,
  );
  const backgroundCompletedSequence =
    next.backgroundCompletedSequence ?? previous.backgroundCompletedSequence;
  const processId = next.processId ?? previous.processId;
  const commandSource = next.commandSource ?? previous.commandSource;
  const mcpServer = next.mcpServer ?? previous.mcpServer;
  const mcpTool = next.mcpTool ?? previous.mcpTool;
  const searchPattern = next.searchPattern ?? previous.searchPattern;
  const searchResultCount = next.searchResultCount ?? previous.searchResultCount;
  const filePath = next.filePath ?? previous.filePath;
  const agentDescription = next.agentDescription ?? previous.agentDescription;
  const agentType = next.agentType ?? previous.agentType;
  const agentModel = next.agentModel ?? previous.agentModel;
  const agentPrompt = next.agentPrompt ?? previous.agentPrompt;
  const receiverThreadIds = next.receiverThreadIds ?? previous.receiverThreadIds;
  return {
    ...previous,
    ...next,
    createdAt,
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(itemType ? { itemType } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(inlineDiff ? { inlineDiff } : {}),
    ...(collapseKey ? { collapseKey } : {}),
    ...(toolName ? { toolName } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(output ? { output } : {}),
    ...(hasOutput ? { hasOutput } : {}),
    ...(outputByteLength !== undefined ? { outputByteLength } : {}),
    ...(outputSource ? { outputSource } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(itemStatus ? { itemStatus } : {}),
    ...(isBackgroundCommand ? { isBackgroundCommand } : {}),
    ...(backgroundLifecycleRole ? { backgroundLifecycleRole } : {}),
    ...(backgroundTaskId ? { backgroundTaskId } : {}),
    ...(backgroundTaskStatus ? { backgroundTaskStatus } : {}),
    ...(backgroundCompletedAt ? { backgroundCompletedAt } : {}),
    ...(backgroundCompletedSequence !== undefined ? { backgroundCompletedSequence } : {}),
    ...(processId ? { processId } : {}),
    ...(commandSource ? { commandSource } : {}),
    ...(mcpServer ? { mcpServer } : {}),
    ...(mcpTool ? { mcpTool } : {}),
    ...(searchPattern ? { searchPattern } : {}),
    ...(searchResultCount !== undefined ? { searchResultCount } : {}),
    ...(filePath ? { filePath } : {}),
    ...(agentDescription ? { agentDescription } : {}),
    ...(agentType ? { agentType } : {}),
    ...(agentModel ? { agentModel } : {}),
    ...(agentPrompt ? { agentPrompt } : {}),
    ...(receiverThreadIds ? { receiverThreadIds } : {}),
  };
}

function mergeChangedFiles(
  previous: ReadonlyArray<string> | undefined,
  next: ReadonlyArray<string> | undefined,
): string[] {
  const merged = [...(previous ?? []), ...(next ?? [])];
  if (merged.length === 0) {
    return [];
  }
  return [...new Set(merged)];
}

function mergeToolInlineDiffSummaries(
  previous: ToolInlineDiffSummary | undefined,
  next: ToolInlineDiffSummary | undefined,
): ToolInlineDiffSummary | undefined {
  if (!previous) return next;
  if (!next) return previous;

  const files = mergeToolInlineDiffFiles(previous.files, next.files);
  const exactPatch =
    next.availability === "exact_patch"
      ? next
      : previous.availability === "exact_patch"
        ? previous
        : next;
  const summarizedFiles = summarizeToolInlineDiffFiles(files);

  return {
    ...previous,
    ...next,
    files,
    availability: exactPatch.availability,
    unifiedDiff: exactPatch.unifiedDiff ?? previous.unifiedDiff,
    additions:
      exactPatch.additions ?? next.additions ?? previous.additions ?? summarizedFiles.additions,
    deletions:
      exactPatch.deletions ?? next.deletions ?? previous.deletions ?? summarizedFiles.deletions,
  };
}

function mergeToolInlineDiffFiles(
  previous: ReadonlyArray<TurnDiffFileChange>,
  next: ReadonlyArray<TurnDiffFileChange>,
): TurnDiffFileChange[] {
  const byPath = new Map<string, TurnDiffFileChange>();
  for (const file of [...previous, ...next]) {
    const existing = byPath.get(file.path);
    if (!existing) {
      byPath.set(file.path, { ...file });
      continue;
    }
    byPath.set(file.path, {
      ...existing,
      kind: file.kind ?? existing.kind,
      additions: file.additions ?? existing.additions,
      deletions: file.deletions ?? existing.deletions,
    });
  }
  return [...byPath.values()];
}
