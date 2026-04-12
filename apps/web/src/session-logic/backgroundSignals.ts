import type { OrchestrationThreadActivity } from "@forgetools/contracts";

import { asRecord, asTrimmedString } from "@forgetools/shared/narrowing";
import { debugLog, isWebDebugEnabled } from "../debug";

import type {
  BackgroundCommandCompletionSignal,
  CodexBackgroundCommandCandidate,
  DerivedWorkLogEntry,
  LatestTurnTiming,
  ProviderBackgroundTaskSignal,
  WorkLogEntry,
} from "./types";
import { BACKGROUND_TASK_RETENTION_MS } from "./types";
import type { ChatMessage } from "../types";
import { earliestIsoValue, latestIsoValue, shouldInsertBackgroundCompletionBefore } from "./utils";
import {
  extractToolCallId,
  extractCommandSource,
  extractCommandProcessId,
  extractWorkLogItemType,
} from "./toolEnrichment";

const DEBUG_BACKGROUND_TASKS = isWebDebugEnabled("background");

export function collectStreamedCommandOutputByToolCallId(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): Map<string, string> {
  const outputByToolCallId = new Map<string, string>();
  for (const activity of activities) {
    if (activity.kind !== "tool.output.delta") {
      continue;
    }
    const payload = asRecord(activity.payload);
    const streamKind = asTrimmedString(payload?.streamKind);
    const toolCallId = asTrimmedString(payload?.itemId);
    const delta = typeof payload?.delta === "string" ? payload.delta : null;
    if (streamKind !== "command_output" || !toolCallId || !delta || delta.length === 0) {
      continue;
    }
    outputByToolCallId.set(toolCallId, `${outputByToolCallId.get(toolCallId) ?? ""}${delta}`);
  }
  return outputByToolCallId;
}

export function collectStreamedCommandOutputPresenceByToolCallId(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): Set<string> {
  const toolCallIds = new Set<string>();
  for (const activity of activities) {
    if (activity.kind !== "tool.output.delta") {
      continue;
    }
    const payload = asRecord(activity.payload);
    const streamKind = asTrimmedString(payload?.streamKind);
    const toolCallId = asTrimmedString(payload?.itemId);
    const hasDelta =
      (typeof payload?.delta === "string" && payload.delta.length > 0) ||
      (typeof payload?.deltaLength === "number" && payload.deltaLength > 0);
    if (streamKind !== "command_output" || !toolCallId || !hasDelta) {
      continue;
    }
    toolCallIds.add(toolCallId);
  }
  return toolCallIds;
}

export function applyPreCollapseBackgroundCommandSignals(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
  codexBackgroundSignals: {
    backgroundedToolCallIds: ReadonlySet<string>;
    reasonsByToolCallId: ReadonlyMap<string, string>;
  },
): DerivedWorkLogEntry[] {
  void codexBackgroundSignals.reasonsByToolCallId;

  const lifecycleIndexesByToolCallId = new Map<string, number[]>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (
      !entry ||
      entry.itemType !== "command_execution" ||
      !entry.toolCallId ||
      !codexBackgroundSignals.backgroundedToolCallIds.has(entry.toolCallId)
    ) {
      continue;
    }
    const indexes = lifecycleIndexesByToolCallId.get(entry.toolCallId) ?? [];
    indexes.push(index);
    lifecycleIndexesByToolCallId.set(entry.toolCallId, indexes);
  }

  if (lifecycleIndexesByToolCallId.size === 0) {
    return [...entries];
  }

  const nextEntries = [...entries];
  for (const [toolCallId, indexes] of lifecycleIndexesByToolCallId.entries()) {
    const firstIndex = indexes[0];
    if (firstIndex === undefined) {
      continue;
    }

    const lastCompletionIndex = indexes
      .toReversed()
      .find((index) => nextEntries[index]?.activityKind === "tool.completed");

    for (const index of indexes) {
      const entry = nextEntries[index];
      if (!entry) {
        continue;
      }
      const backgroundLifecycleRole =
        lastCompletionIndex !== undefined &&
        indexes.length > 1 &&
        index === lastCompletionIndex &&
        entry.activityKind === "tool.completed"
          ? "completion"
          : "launch";
      nextEntries[index] = {
        ...entry,
        isBackgroundCommand: true,
        backgroundLifecycleRole,
        // Codex unified exec can emit a terminal tool.completed long after the launch row went
        // inline. Marking the lifecycle before collapse lets us keep the launch row stable and
        // surface the later terminal completion as its own history event.
        ...(backgroundLifecycleRole === "launch" ? { itemStatus: "inProgress" } : {}),
      };
    }

    const launchEntry = nextEntries[firstIndex];
    if (
      launchEntry &&
      launchEntry.commandSource === undefined &&
      launchEntry.toolCallId === toolCallId
    ) {
      nextEntries[firstIndex] = {
        ...launchEntry,
        backgroundLifecycleRole: "launch",
      };
    }
  }

  return nextEntries;
}

export function applyStreamedCommandOutput(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
  streamedCommandOutputByToolCallId: ReadonlyMap<string, string>,
  streamedCommandOutputPresenceByToolCallId: ReadonlySet<string>,
): DerivedWorkLogEntry[] {
  return entries.map((entry) => {
    if (entry.itemType !== "command_execution" || !entry.toolCallId) {
      return entry;
    }
    const streamedOutput = streamedCommandOutputByToolCallId.get(entry.toolCallId) ?? null;
    const hasStreamedOutput =
      streamedOutput !== null
        ? streamedOutput.trim().length > 0
        : streamedCommandOutputPresenceByToolCallId.has(entry.toolCallId);
    if (!hasStreamedOutput) {
      return entry;
    }
    const nextEntry: DerivedWorkLogEntry = {
      ...entry,
      hasOutput: true,
      outputSource: "stream",
    };
    if (!entry.output && streamedOutput !== null && streamedOutput.trim().length > 0) {
      nextEntry.output = streamedOutput;
    }
    return nextEntry;
  });
}

export function applyBackgroundCommandSignals(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
  input: {
    activities: ReadonlyArray<OrchestrationThreadActivity>;
    codexBackgroundSignals: {
      backgroundedToolCallIds: ReadonlySet<string>;
      reasonsByToolCallId: ReadonlyMap<string, string>;
    };
  },
): DerivedWorkLogEntry[] {
  const providerBackgroundTaskSignals = deriveProviderBackgroundTaskSignals(input.activities);
  const backgroundCompletionByToolCallId = collectBackgroundCommandCompletionSignals(entries);

  const nextEntries = entries.map((entry) => {
    if (entry.itemType !== "command_execution") {
      return entry;
    }
    const toolCallId = entry.toolCallId ?? null;
    const providerTaskSignal = findProviderBackgroundTaskSignal(
      entry,
      providerBackgroundTaskSignals,
    );
    const backgroundCompletionSignal =
      toolCallId !== null ? backgroundCompletionByToolCallId.get(toolCallId) : undefined;
    const isBackgroundCommand =
      entry.isBackgroundCommand === true ||
      (toolCallId !== null && input.codexBackgroundSignals.backgroundedToolCallIds.has(toolCallId));
    if (!isBackgroundCommand) {
      return entry;
    }
    const backgroundLifecycleRole =
      entry.backgroundLifecycleRole ??
      (entry.activityKind === "task.completed" ||
      (entry.activityKind === "tool.completed" &&
        providerTaskSignal === undefined &&
        !entry.backgroundTaskId)
        ? "completion"
        : "launch");
    const backgroundTaskStatus =
      providerTaskSignal?.status ??
      backgroundCompletionSignal?.status ??
      (backgroundLifecycleRole === "launch" ? "running" : undefined);
    const backgroundTaskId = entry.backgroundTaskId ?? providerTaskSignal?.taskId;
    const backgroundCompletedAt =
      providerTaskSignal?.completedAt ?? backgroundCompletionSignal?.completedAt;
    const backgroundCompletedSequence =
      providerTaskSignal?.completedSequence ?? backgroundCompletionSignal?.sequence;
    const nextEntry: DerivedWorkLogEntry = {
      ...entry,
      isBackgroundCommand: true,
      backgroundLifecycleRole,
    };
    if (backgroundTaskId) {
      nextEntry.backgroundTaskId = backgroundTaskId;
    }
    if (backgroundTaskStatus) {
      nextEntry.backgroundTaskStatus = backgroundTaskStatus;
    }
    if (backgroundCompletedSequence !== undefined) {
      nextEntry.backgroundCompletedSequence = backgroundCompletedSequence;
    }
    if (backgroundCompletedAt) {
      nextEntry.backgroundCompletedAt = backgroundCompletedAt;
      if (backgroundLifecycleRole === "completion") {
        nextEntry.completedAt = backgroundCompletedAt;
      } else {
        nextEntry.completedAt = undefined;
      }
    } else if (backgroundLifecycleRole === "launch") {
      nextEntry.completedAt = undefined;
    }
    if (backgroundLifecycleRole === "launch") {
      nextEntry.itemStatus = "inProgress";
    }
    return nextEntry;
  });

  const ownedBackgroundToolCallIds = new Set(
    nextEntries
      .filter(
        (entry): entry is DerivedWorkLogEntry & { toolCallId: string } =>
          entry.itemType === "command_execution" &&
          entry.isBackgroundCommand === true &&
          entry.backgroundLifecycleRole !== "completion" &&
          typeof entry.toolCallId === "string",
      )
      .map((entry) => entry.toolCallId),
  );
  const ownedBackgroundTaskIds = new Set(
    nextEntries
      .filter(
        (entry): entry is DerivedWorkLogEntry & { backgroundTaskId: string } =>
          entry.itemType === "command_execution" &&
          entry.isBackgroundCommand === true &&
          entry.backgroundLifecycleRole !== "completion" &&
          typeof entry.backgroundTaskId === "string",
      )
      .map((entry) => entry.backgroundTaskId),
  );

  const hiddenBackgroundTaskActivityIds = new Set<string>();
  for (const activity of input.activities) {
    if (
      activity.kind !== "task.started" &&
      activity.kind !== "task.progress" &&
      activity.kind !== "task.completed"
    ) {
      continue;
    }
    const payload = asRecord(activity.payload);
    if (payload?.childThreadAttribution) {
      continue;
    }
    const toolUseId = asTrimmedString(payload?.toolUseId);
    const taskId = asTrimmedString(payload?.taskId);
    if (
      (toolUseId && ownedBackgroundToolCallIds.has(toolUseId)) ||
      (taskId && ownedBackgroundTaskIds.has(taskId))
    ) {
      hiddenBackgroundTaskActivityIds.add(activity.id);
    }
  }

  if (DEBUG_BACKGROUND_TASKS) {
    const commandDecisions = entries
      .map((entry, index) =>
        summarizeBackgroundCommandClassification(
          entry,
          nextEntries[index] ?? entry,
          input.codexBackgroundSignals.reasonsByToolCallId,
        ),
      )
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    if (commandDecisions.length > 0) {
      debugLog({
        topic: "background",
        source: "session-logic",
        label: "command.classification",
        details: commandDecisions,
      });
    }
  }

  return nextEntries.filter((entry) => !hiddenBackgroundTaskActivityIds.has(entry.id));
}

export function appendBackgroundCommandCompletionEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const completionEntries: DerivedWorkLogEntry[] = [];
  const existingCompletionKeys = new Set(
    entries
      .filter(
        (entry): entry is DerivedWorkLogEntry & { itemType: "command_execution" } =>
          entry.itemType === "command_execution" &&
          entry.isBackgroundCommand === true &&
          entry.backgroundLifecycleRole === "completion",
      )
      .map((entry) => backgroundCommandCompletionKey(entry)),
  );

  for (const entry of entries) {
    if (entry.itemType !== "command_execution" || entry.isBackgroundCommand !== true) {
      continue;
    }
    if (entry.backgroundLifecycleRole === "completion" || entry.activityKind === "task.completed") {
      continue;
    }

    const status = deriveBackgroundCommandStatus(entry);
    if (status === "running" || !entry.backgroundCompletedAt) {
      continue;
    }
    if (existingCompletionKeys.has(backgroundCommandCompletionKey(entry))) {
      continue;
    }

    const {
      detail: _detail,
      output: _output,
      hasOutput: _hasOutput,
      outputByteLength: _outputByteLength,
      outputSource: _outputSource,
      exitCode: _exitCode,
      durationMs: _durationMs,
      ...baseEntry
    } = entry;
    completionEntries.push({
      ...baseEntry,
      id: `${entry.id}:background-task-completed`,
      createdAt: entry.backgroundCompletedAt,
      ...(entry.backgroundCompletedSequence !== undefined
        ? { sequence: entry.backgroundCompletedSequence }
        : {}),
      startedAt: entry.startedAt ?? entry.createdAt,
      completedAt: entry.backgroundCompletedAt,
      label: status === "failed" ? "Background command failed" : "Background command completed",
      tone: status === "failed" ? "error" : "tool",
      activityKind: "task.completed",
      itemStatus: status === "failed" ? "failed" : "completed",
      backgroundLifecycleRole: "completion",
      // Keep the launch row's preview command, but do not inherit launch-only output or exit code.
      // Claude background launches often complete the tool call with "background started" text,
      // which is not the same thing as the terminal task output.
    });
  }

  if (completionEntries.length === 0) {
    return [...entries];
  }

  const orderedEntries = [...entries];
  for (const completionEntry of completionEntries) {
    const insertionIndex = orderedEntries.findIndex((entry) =>
      shouldInsertBackgroundCompletionBefore(completionEntry, entry),
    );
    if (insertionIndex === -1) {
      orderedEntries.push(completionEntry);
    } else {
      orderedEntries.splice(insertionIndex, 0, completionEntry);
    }
  }

  return orderedEntries;
}

export function backgroundCommandCompletionKey(
  entry: Pick<WorkLogEntry, "toolCallId" | "backgroundTaskId" | "id">,
): string {
  if (entry.toolCallId) {
    return `tool:${entry.toolCallId}`;
  }
  if (entry.backgroundTaskId) {
    return `task:${entry.backgroundTaskId}`;
  }
  return `entry:${entry.id}`;
}

function deriveProviderBackgroundTaskSignals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): {
  byTaskId: Map<string, ProviderBackgroundTaskSignal>;
  byToolUseId: Map<string, ProviderBackgroundTaskSignal>;
} {
  const byTaskId = new Map<string, ProviderBackgroundTaskSignal>();
  const byToolUseId = new Map<string, ProviderBackgroundTaskSignal>();

  for (const activity of activities) {
    if (
      activity.kind !== "task.started" &&
      activity.kind !== "task.progress" &&
      activity.kind !== "task.completed"
    ) {
      continue;
    }

    const payload = asRecord(activity.payload);
    if (payload?.childThreadAttribution) {
      continue;
    }

    // These parent-thread task activities are already the normalized orchestration surface.
    // For Claude, terminal `task.completed` comes from SDK `task_notification`, not the raw
    // lower-fidelity `task_updated` patch stream. This helper should follow that normalized
    // lifecycle and never invent terminal state from side-channel patches.
    const taskId = asTrimmedString(payload?.taskId);
    const toolUseId = asTrimmedString(payload?.toolUseId);
    if (!taskId && !toolUseId) {
      continue;
    }

    const existing =
      (toolUseId ? byToolUseId.get(toolUseId) : undefined) ??
      (taskId ? byTaskId.get(taskId) : undefined);
    const status = normalizeProviderBackgroundTaskStatus(activity.kind, payload);
    const signal: ProviderBackgroundTaskSignal = {
      taskId: taskId ?? existing?.taskId,
      toolUseId: toolUseId ?? existing?.toolUseId,
      status,
      startedAt:
        existing?.startedAt ??
        (activity.kind === "task.completed" ? activity.createdAt : activity.createdAt),
      ...(existing?.startedSequence !== undefined
        ? { startedSequence: existing.startedSequence }
        : activity.sequence !== undefined
          ? { startedSequence: activity.sequence }
          : {}),
      ...(status !== "running" ? { completedAt: activity.createdAt } : {}),
      ...(status !== "running" && activity.sequence !== undefined
        ? { completedSequence: activity.sequence }
        : {}),
    };

    if (existing?.startedAt) {
      signal.startedAt =
        earliestIsoValue(existing.startedAt, activity.createdAt) ?? activity.createdAt;
    }
    if (existing?.completedAt && status === "running") {
      signal.completedAt = existing.completedAt;
    }
    if (existing?.completedSequence !== undefined && status === "running") {
      signal.completedSequence = existing.completedSequence;
    }
    if (existing?.completedAt && status !== "running") {
      signal.completedAt = latestIsoValue(existing.completedAt, activity.createdAt);
    }
    if (existing?.completedSequence !== undefined && status !== "running") {
      signal.completedSequence =
        activity.sequence !== undefined
          ? Math.max(existing.completedSequence, activity.sequence)
          : existing.completedSequence;
    }

    if (signal.taskId) {
      byTaskId.set(signal.taskId, signal);
    }
    if (signal.toolUseId) {
      byToolUseId.set(signal.toolUseId, signal);
    }
  }

  return { byTaskId, byToolUseId };
}

function collectBackgroundCommandCompletionSignals(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): Map<string, BackgroundCommandCompletionSignal> {
  const completionByToolCallId = new Map<string, BackgroundCommandCompletionSignal>();

  for (const entry of entries) {
    if (
      entry.itemType !== "command_execution" ||
      entry.isBackgroundCommand !== true ||
      entry.backgroundLifecycleRole !== "completion" ||
      !entry.toolCallId
    ) {
      continue;
    }

    const status =
      entry.itemStatus === "failed" ||
      entry.itemStatus === "declined" ||
      entry.tone === "error" ||
      (entry.exitCode !== undefined && entry.exitCode !== 0)
        ? "failed"
        : "completed";
    completionByToolCallId.set(entry.toolCallId, {
      status,
      completedAt: entry.completedAt ?? entry.createdAt,
      ...(entry.sequence !== undefined ? { sequence: entry.sequence } : {}),
    });
  }

  return completionByToolCallId;
}

function findProviderBackgroundTaskSignal(
  entry: Pick<DerivedWorkLogEntry, "toolCallId" | "backgroundTaskId">,
  signals: {
    byTaskId: ReadonlyMap<string, ProviderBackgroundTaskSignal>;
    byToolUseId: ReadonlyMap<string, ProviderBackgroundTaskSignal>;
  },
): ProviderBackgroundTaskSignal | undefined {
  if (entry.toolCallId) {
    const byToolUseId = signals.byToolUseId.get(entry.toolCallId);
    if (byToolUseId) {
      return byToolUseId;
    }
  }
  if (entry.backgroundTaskId) {
    return signals.byTaskId.get(entry.backgroundTaskId);
  }
  return undefined;
}

function normalizeProviderBackgroundTaskStatus(
  activityKind: OrchestrationThreadActivity["kind"],
  payload: Record<string, unknown> | null | undefined,
): "running" | "completed" | "failed" {
  if (activityKind !== "task.completed") {
    return "running";
  }
  const status = asTrimmedString(payload?.status);
  return status === "failed" || status === "stopped" ? "failed" : "completed";
}

export function deriveCodexBackgroundCommandSignals(input: {
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  messages?: ReadonlyArray<ChatMessage> | undefined;
  latestTurn: LatestTurnTiming | null;
}): {
  backgroundedToolCallIds: Set<string>;
  reasonsByToolCallId: Map<string, string>;
} {
  const candidatesByToolCallId = new Map<string, CodexBackgroundCommandCandidate>();
  const openCandidateIdsByTurnId = new Map<string, Set<string>>();
  const openCandidateIdsByProcessId = new Map<string, Set<string>>();
  const reasonsByToolCallId = new Map<string, string>();

  for (const activity of input.activities) {
    const payload = asRecord(activity.payload);
    const itemType = extractWorkLogItemType(payload);
    const toolCallId = itemType === "command_execution" ? extractToolCallId(payload) : undefined;
    const processId =
      itemType === "command_execution" ? extractCommandProcessId(payload) : undefined;
    const commandSource =
      itemType === "command_execution" ? (extractCommandSource(payload) ?? undefined) : undefined;

    // unifiedExecStartup only tells us Codex launched the command under the unified exec runtime.
    // It does not mean the command was already backgrounded from the user's point of view. We
    // treat these as candidates first and only flip them to background once later turn activity,
    // assistant output, turn completion, or a terminalInteraction proves the process outlived the
    // original tool call.
    if (
      itemType === "command_execution" &&
      toolCallId &&
      commandSource === "unifiedExecStartup" &&
      processId
    ) {
      const candidate = candidatesByToolCallId.get(toolCallId);
      const nextCandidate: CodexBackgroundCommandCandidate = candidate
        ? {
            ...candidate,
            turnId: candidate.turnId ?? activity.turnId ?? undefined,
            processId: candidate.processId ?? processId,
            startedAt:
              earliestIsoValue(candidate.startedAt, activity.createdAt) ?? activity.createdAt,
          }
        : {
            toolCallId,
            turnId: activity.turnId ?? undefined,
            processId,
            startedAt: activity.createdAt,
            backgrounded: false,
          };
      candidatesByToolCallId.set(toolCallId, nextCandidate);
      if (activity.kind !== "tool.completed") {
        trackOpenCodexBackgroundCandidate(openCandidateIdsByTurnId, activity.turnId, toolCallId);
        trackOpenCodexBackgroundCandidate(openCandidateIdsByProcessId, processId, toolCallId);
      }
    }

    if (activity.kind === "tool.terminal.interaction") {
      markCodexBackgroundCandidatesFromTerminalInteraction(
        payload,
        candidatesByToolCallId,
        openCandidateIdsByProcessId,
        reasonsByToolCallId,
      );
      continue;
    }

    if (isCommandBackgroundingActivity(activity)) {
      markCodexBackgroundCandidatesForTurnAdvance(
        activity.turnId ?? undefined,
        toolCallId,
        candidatesByToolCallId,
        openCandidateIdsByTurnId,
        reasonsByToolCallId,
      );
    }

    if (itemType === "command_execution" && toolCallId && activity.kind === "tool.completed") {
      const candidate = candidatesByToolCallId.get(toolCallId);
      if (candidate) {
        candidate.completedAt = activity.createdAt;
      }
      clearOpenCodexBackgroundCandidate(openCandidateIdsByTurnId, activity.turnId, toolCallId);
      clearOpenCodexBackgroundCandidate(openCandidateIdsByProcessId, processId, toolCallId);
    }
  }

  markCodexBackgroundCandidatesFromMessages(
    candidatesByToolCallId,
    input.messages,
    reasonsByToolCallId,
  );
  markCodexBackgroundCandidatesFromLatestTurn(
    candidatesByToolCallId,
    input.latestTurn,
    reasonsByToolCallId,
  );

  return {
    backgroundedToolCallIds: new Set(
      [...candidatesByToolCallId.values()]
        .filter((candidate) => candidate.backgrounded)
        .map((candidate) => candidate.toolCallId),
    ),
    reasonsByToolCallId,
  };
}

function isCommandBackgroundingActivity(activity: OrchestrationThreadActivity): boolean {
  return activity.kind !== "tool.output.delta" && activity.kind !== "tool.terminal.interaction";
}

function trackOpenCodexBackgroundCandidate(
  openCandidateIds: Map<string, Set<string>>,
  key: string | null | undefined,
  toolCallId: string,
): void {
  if (!key) {
    return;
  }
  const next = openCandidateIds.get(key) ?? new Set<string>();
  next.add(toolCallId);
  openCandidateIds.set(key, next);
}

function clearOpenCodexBackgroundCandidate(
  openCandidateIds: Map<string, Set<string>>,
  key: string | null | undefined,
  toolCallId: string | undefined,
): void {
  if (!key || !toolCallId) {
    return;
  }
  const existing = openCandidateIds.get(key);
  if (!existing) {
    return;
  }
  existing.delete(toolCallId);
  if (existing.size === 0) {
    openCandidateIds.delete(key);
  }
}

function markCodexBackgroundCandidatesForTurnAdvance(
  turnId: string | undefined,
  currentToolCallId: string | undefined,
  candidatesByToolCallId: Map<string, CodexBackgroundCommandCandidate>,
  openCandidateIdsByTurnId: Map<string, Set<string>>,
  reasonsByToolCallId: Map<string, string>,
): void {
  if (!turnId) {
    return;
  }
  const candidateIds = openCandidateIdsByTurnId.get(turnId);
  if (!candidateIds) {
    return;
  }
  for (const candidateId of candidateIds) {
    if (candidateId === currentToolCallId) {
      continue;
    }
    markCodexBackgroundCandidate(
      candidatesByToolCallId.get(candidateId),
      reasonsByToolCallId,
      "later turn activity",
    );
  }
}

function markCodexBackgroundCandidatesFromTerminalInteraction(
  payload: Record<string, unknown> | null | undefined,
  candidatesByToolCallId: Map<string, CodexBackgroundCommandCandidate>,
  openCandidateIdsByProcessId: Map<string, Set<string>>,
  reasonsByToolCallId: Map<string, string>,
): void {
  const toolCallId = asTrimmedString(payload?.itemId);
  const processId = asTrimmedString(payload?.processId);
  const stdin = typeof payload?.stdin === "string" ? payload.stdin : "";
  const reason =
    stdin.length === 0 ? "background terminal wait" : "background terminal interaction";

  if (toolCallId) {
    markCodexBackgroundCandidate(
      candidatesByToolCallId.get(toolCallId),
      reasonsByToolCallId,
      reason,
    );
  }

  if (!processId) {
    return;
  }
  const candidateIds = openCandidateIdsByProcessId.get(processId);
  if (!candidateIds) {
    return;
  }
  for (const candidateId of candidateIds) {
    markCodexBackgroundCandidate(
      candidatesByToolCallId.get(candidateId),
      reasonsByToolCallId,
      reason,
    );
  }
}

function markCodexBackgroundCandidatesFromMessages(
  candidatesByToolCallId: Map<string, CodexBackgroundCommandCandidate>,
  messages: ReadonlyArray<ChatMessage> | undefined,
  reasonsByToolCallId: Map<string, string>,
): void {
  if (!messages || messages.length === 0) {
    return;
  }
  const assistantMessages = messages
    .filter((message) => message.role === "assistant" && message.turnId)
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  if (assistantMessages.length === 0) {
    return;
  }

  for (const candidate of candidatesByToolCallId.values()) {
    if (!candidate.turnId || candidate.backgrounded) {
      continue;
    }
    const hasLaterAssistantMessage = assistantMessages.some(
      (message) =>
        message.turnId === candidate.turnId &&
        isIsoWithinCandidateLifetime(message.createdAt, candidate),
    );
    if (hasLaterAssistantMessage) {
      markCodexBackgroundCandidate(candidate, reasonsByToolCallId, "assistant message");
    }
  }
}

function markCodexBackgroundCandidatesFromLatestTurn(
  candidatesByToolCallId: Map<string, CodexBackgroundCommandCandidate>,
  latestTurn: LatestTurnTiming | null,
  reasonsByToolCallId: Map<string, string>,
): void {
  if (!latestTurn?.turnId || !latestTurn.startedAt) {
    return;
  }

  for (const candidate of candidatesByToolCallId.values()) {
    if (candidate.backgrounded || !candidate.turnId) {
      continue;
    }

    if (candidate.turnId === latestTurn.turnId) {
      if (
        latestTurn.completedAt &&
        isIsoWithinCandidateLifetime(latestTurn.completedAt, candidate)
      ) {
        markCodexBackgroundCandidate(candidate, reasonsByToolCallId, "turn completed");
      }
      continue;
    }

    if (isIsoWithinCandidateLifetime(latestTurn.startedAt, candidate)) {
      markCodexBackgroundCandidate(candidate, reasonsByToolCallId, "later turn started");
    }
  }
}

function isIsoWithinCandidateLifetime(
  timestamp: string,
  candidate: Pick<CodexBackgroundCommandCandidate, "startedAt" | "completedAt">,
): boolean {
  if (timestamp.localeCompare(candidate.startedAt) <= 0) {
    return false;
  }
  if (candidate.completedAt && timestamp.localeCompare(candidate.completedAt) > 0) {
    return false;
  }
  return true;
}

function markCodexBackgroundCandidate(
  candidate: CodexBackgroundCommandCandidate | undefined,
  reasonsByToolCallId: Map<string, string>,
  reason: string,
): void {
  if (!candidate || candidate.backgrounded) {
    return;
  }
  candidate.backgrounded = true;
  reasonsByToolCallId.set(candidate.toolCallId, reason);
}

export function deriveBackgroundCommandStatus(
  entry: WorkLogEntry,
): "running" | "completed" | "failed" {
  if (entry.backgroundTaskStatus) {
    return entry.backgroundTaskStatus;
  }
  if (entry.isBackgroundCommand === true && entry.backgroundLifecycleRole !== "completion") {
    return "running";
  }
  if (entry.backgroundTaskId) {
    return "running";
  }
  if (
    entry.itemStatus === "failed" ||
    entry.itemStatus === "declined" ||
    entry.tone === "error" ||
    (entry.exitCode !== undefined && entry.exitCode !== 0)
  ) {
    return "failed";
  }
  if (entry.itemStatus === "completed" || entry.exitCode === 0) {
    return "completed";
  }
  return "running";
}

export function isWithinBackgroundTaskRetention(timestampIso: string, nowIso: string): boolean {
  const timestampMs = Date.parse(timestampIso);
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(timestampMs) || Number.isNaN(nowMs)) {
    return false;
  }
  return nowMs - timestampMs <= BACKGROUND_TASK_RETENTION_MS;
}

export function isBackgroundCommandVisibleInTray(
  entry: WorkLogEntry,
  nowIso: string,
  input?: { hasSeparateLaunchRow?: boolean | undefined },
): boolean {
  if (entry.itemType !== "command_execution" || !entry.isBackgroundCommand) {
    return false;
  }
  if (
    entry.activityKind === "task.completed" ||
    (entry.backgroundLifecycleRole === "completion" && input?.hasSeparateLaunchRow)
  ) {
    return false;
  }
  const status = deriveBackgroundCommandStatus(entry);
  if (status === "running") {
    return true;
  }
  return isWithinBackgroundTaskRetention(
    entry.backgroundCompletedAt ?? entry.completedAt ?? entry.createdAt,
    nowIso,
  );
}

export function deriveVisibleBackgroundCommandEntries(
  standaloneEntries: ReadonlyArray<WorkLogEntry>,
  nowIso: string,
): WorkLogEntry[] {
  const launchKeys = new Set(
    standaloneEntries
      .filter(
        (entry): entry is WorkLogEntry & { itemType: "command_execution" } =>
          entry.itemType === "command_execution" &&
          entry.isBackgroundCommand === true &&
          entry.backgroundLifecycleRole !== "completion",
      )
      .map((entry) => backgroundCommandCompletionKey(entry)),
  );

  return standaloneEntries.filter((entry) =>
    isBackgroundCommandVisibleInTray(entry, nowIso, {
      hasSeparateLaunchRow:
        entry.backgroundLifecycleRole === "completion" &&
        launchKeys.has(backgroundCommandCompletionKey(entry)),
    }),
  );
}

// Debug helpers

export function summarizeBackgroundRelevantActivity(activity: OrchestrationThreadActivity): {
  id: string;
  createdAt: string;
  kind: string;
  itemType?: string | undefined;
  itemId?: string | undefined;
  rawItemId?: string | undefined;
  processId?: string | undefined;
  source?: string | undefined;
  status?: string | undefined;
  stdinLength?: number | undefined;
  childTaskId?: string | undefined;
  childProviderThreadId?: string | undefined;
} | null {
  const payload = asRecord(activity.payload);
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const childAttr = asRecord(payload?.childThreadAttribution);
  const itemType =
    extractWorkLogItemType(payload) ?? asTrimmedString(payload?.itemType) ?? undefined;
  const summary = {
    id: activity.id,
    createdAt: activity.createdAt,
    kind: activity.kind,
    ...(itemType ? { itemType } : {}),
    ...(asTrimmedString(payload?.itemId)
      ? { itemId: asTrimmedString(payload?.itemId) ?? undefined }
      : {}),
    ...(asTrimmedString(item?.id) ? { rawItemId: asTrimmedString(item?.id) ?? undefined } : {}),
    ...(asTrimmedString(payload?.processId) || asTrimmedString(item?.processId)
      ? {
          processId:
            asTrimmedString(payload?.processId) ?? asTrimmedString(item?.processId) ?? undefined,
        }
      : {}),
    ...(asTrimmedString(item?.source)
      ? { source: asTrimmedString(item?.source) ?? undefined }
      : {}),
    ...(asTrimmedString(payload?.status)
      ? { status: asTrimmedString(payload?.status) ?? undefined }
      : {}),
    ...(typeof payload?.stdin === "string" ? { stdinLength: payload.stdin.length } : {}),
    ...(asTrimmedString(childAttr?.taskId)
      ? { childTaskId: asTrimmedString(childAttr?.taskId) ?? undefined }
      : {}),
    ...(asTrimmedString(childAttr?.childProviderThreadId)
      ? { childProviderThreadId: asTrimmedString(childAttr?.childProviderThreadId) ?? undefined }
      : {}),
  };
  const isRelevant =
    summary.itemType === "command_execution" ||
    summary.itemType === "collab_agent_tool_call" ||
    activity.kind === "tool.output.delta" ||
    activity.kind === "tool.terminal.interaction" ||
    activity.kind === "task.started" ||
    activity.kind === "task.progress" ||
    activity.kind === "task.completed";
  return isRelevant ? summary : null;
}

export function summarizeBackgroundRelevantEntry(entry: DerivedWorkLogEntry): {
  id: string;
  createdAt: string;
  activityKind: string;
  itemType?: string | undefined;
  toolCallId?: string | undefined;
  backgroundTaskId?: string | undefined;
  processId?: string | undefined;
  commandSource?: string | undefined;
  itemStatus?: string | undefined;
  backgroundTaskStatus?: string | undefined;
  isBackgroundCommand?: boolean | undefined;
  command?: string | undefined;
  collapseKey?: string | undefined;
} | null {
  if (
    entry.itemType !== "command_execution" &&
    entry.itemType !== "collab_agent_tool_call" &&
    !entry.childThreadAttribution
  ) {
    return null;
  }
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    activityKind: entry.activityKind,
    ...(entry.itemType ? { itemType: entry.itemType } : {}),
    ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
    ...(entry.backgroundTaskId ? { backgroundTaskId: entry.backgroundTaskId } : {}),
    ...(entry.processId ? { processId: entry.processId } : {}),
    ...(entry.commandSource ? { commandSource: entry.commandSource } : {}),
    ...(entry.itemStatus ? { itemStatus: entry.itemStatus } : {}),
    ...(entry.backgroundTaskStatus ? { backgroundTaskStatus: entry.backgroundTaskStatus } : {}),
    ...(entry.isBackgroundCommand !== undefined
      ? { isBackgroundCommand: entry.isBackgroundCommand }
      : {}),
    ...(entry.command ? { command: entry.command } : {}),
    ...(entry.collapseKey ? { collapseKey: entry.collapseKey } : {}),
  };
}

export function summarizeBackgroundCommandClassification(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
  reasonsByToolCallId: ReadonlyMap<string, string>,
): {
  id: string;
  toolCallId?: string | undefined;
  processId?: string | undefined;
  commandSource?: string | undefined;
  hadExplicitBackgroundSignal: boolean;
  hadUnifiedExecSignal: boolean;
  finalIsBackgroundCommand: boolean;
  reason: string;
  itemStatus?: string | undefined;
} | null {
  if (previous.itemType !== "command_execution") {
    return null;
  }

  const hadExplicitBackgroundSignal = previous.isBackgroundCommand === true;
  const hadUnifiedExecSignal = isUnifiedExecCommandSource(previous.commandSource);
  const reason =
    (previous.toolCallId ? reasonsByToolCallId.get(previous.toolCallId) : undefined) ??
    (hadExplicitBackgroundSignal ? "explicit" : "none");

  return {
    id: previous.id,
    ...(previous.toolCallId ? { toolCallId: previous.toolCallId } : {}),
    ...(previous.processId ? { processId: previous.processId } : {}),
    ...(previous.commandSource ? { commandSource: previous.commandSource } : {}),
    hadExplicitBackgroundSignal,
    hadUnifiedExecSignal,
    finalIsBackgroundCommand: next.isBackgroundCommand === true,
    reason,
    ...(next.itemStatus ? { itemStatus: next.itemStatus } : {}),
  };
}

export function summarizeBackgroundTrayCommandDecision(
  entry: WorkLogEntry,
  nowIso: string,
): {
  id: string;
  toolCallId?: string | undefined;
  backgroundTaskId?: string | undefined;
  processId?: string | undefined;
  isBackgroundCommand: boolean;
  commandSource?: string | undefined;
  itemStatus?: string | undefined;
  backgroundTaskStatus?: string | undefined;
  derivedStatus?: "running" | "completed" | "failed" | undefined;
  visibleInTray: boolean;
} | null {
  if (entry.itemType !== "command_execution") {
    return null;
  }

  const visibleInTray = isBackgroundCommandVisibleInTray(entry, nowIso);
  return {
    id: entry.id,
    ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
    ...(entry.backgroundTaskId ? { backgroundTaskId: entry.backgroundTaskId } : {}),
    ...(entry.processId ? { processId: entry.processId } : {}),
    isBackgroundCommand: entry.isBackgroundCommand === true,
    ...(entry.commandSource ? { commandSource: entry.commandSource } : {}),
    ...(entry.itemStatus ? { itemStatus: entry.itemStatus } : {}),
    ...(entry.backgroundTaskStatus ? { backgroundTaskStatus: entry.backgroundTaskStatus } : {}),
    ...(entry.isBackgroundCommand ? { derivedStatus: deriveBackgroundCommandStatus(entry) } : {}),
    visibleInTray,
  };
}

function isUnifiedExecCommandSource(value: string | undefined): boolean {
  return value === "unifiedExecStartup" || value === "unifiedExecInteraction";
}
