import type { OrchestrationThreadActivity, TurnId } from "@forgetools/contracts";
import { EventId } from "@forgetools/contracts";
import { asArray, asRecord, asTrimmedString } from "@forgetools/shared/narrowing";
import { classifyOrchestrationActivityPresentation } from "@forgetools/shared/orchestrationActivityPresentation";

import type {
  ChildThreadMetadata,
  CodexBackgroundCommandCandidate,
  DeriveWorkLogEntriesOptions,
  DerivedWorkLogEntry,
  LatestTurnTiming,
  ProviderBackgroundTaskSignal,
  ToolInlineDiffSummary,
  WorkLogEntry,
  WorkLogProjectionState,
  WorkLogScope,
} from "./types";
import type { ChatMessage, TurnDiffFileChange } from "../types";
import {
  extractToolCallId,
  extractWorkLogItemType,
  summarizeToolInlineDiffFiles,
  toDerivedWorkLogEntry,
} from "./toolEnrichment";
import {
  isCodexControlCollabTool,
  isUnattributedCollabAgentToolEnvelope,
  shouldFilterToolStartedActivity,
} from "./subagentGrouping";
import {
  compareActivitiesByOrder,
  compareActivityLifecycleRank,
  earliestIsoValue,
  latestIsoValue,
} from "./utils";

export function createEmptyWorkLogProjectionState(
  latestTurn: LatestTurnTiming | null = null,
): WorkLogProjectionState {
  return {
    entries: [],
    latestTurn,
    activeLifecycleEntryIdByKey: new Map(),
    commandLaunchEntryIdByToolCallId: new Map(),
    backgroundCompletionEntryIdByToolCallId: new Map(),
    streamedOutputByToolCallId: new Map(),
    streamedOutputPresenceByToolCallId: new Set(),
    providerBackgroundTaskByTaskId: new Map(),
    providerBackgroundTaskByToolUseId: new Map(),
    codexCandidatesByToolCallId: new Map(),
    openCodexCandidateIdsByTurnId: new Map(),
    openCodexCandidateIdsByProcessId: new Map(),
    codexBackgroundReasonsByToolCallId: new Map(),
    realChildTaskStarts: new Set(),
    realChildTaskTerminals: new Set(),
    knownChildThreadIds: new Set(),
    childThreadMetadataById: new Map(),
    taskContextByTaskId: new Map(),
    terminalTaskIds: new Set(),
  };
}

export function bootstrapWorkLogProjectionState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  options?: Pick<DeriveWorkLogEntriesOptions, "messages" | "latestTurn">,
): WorkLogProjectionState {
  const state = createEmptyWorkLogProjectionState(options?.latestTurn ?? null);
  const orderedActivities = [...activities].toSorted(compareActivitiesByOrder);
  for (const activity of orderedActivities) {
    const synthesizedActivities = synthesizeLifecycleActivities(state, activity);
    ingestActivity(state, activity);
    for (const synthesizedActivity of synthesizedActivities) {
      ingestActivity(state, synthesizedActivity);
    }
  }
  for (const message of options?.messages ?? []) {
    ingestMessage(state, message);
  }
  ingestLatestTurn(state, options?.latestTurn ?? null);
  return state;
}

export function deriveProjectedWorkLogEntries(
  state: WorkLogProjectionState,
  input: DeriveWorkLogEntriesOptions | TurnId | undefined,
): WorkLogEntry[] {
  const scope = typeof input === "object" && input !== null ? input.scope : "all-turns";
  const latestTurnId = typeof input === "object" && input !== null ? input.latestTurnId : input;
  return scopeProjectedEntries(state.entries, scope, latestTurnId);
}

export function applyActivityToWorkLogProjectionState(
  previousState: WorkLogProjectionState,
  activity: OrchestrationThreadActivity,
): WorkLogProjectionState {
  const state = cloneProjectionState(previousState);
  const synthesizedActivities = synthesizeLifecycleActivities(state, activity);
  ingestActivity(state, activity);
  for (const synthesizedActivity of synthesizedActivities) {
    ingestActivity(state, synthesizedActivity);
  }
  return state;
}

export function applyMessageToWorkLogProjectionState(
  previousState: WorkLogProjectionState,
  message: ChatMessage,
): WorkLogProjectionState {
  if (message.role !== "assistant" || !message.turnId) {
    return previousState;
  }
  const state = cloneProjectionState(previousState);
  ingestMessage(state, message);
  return state;
}

export function applyLatestTurnToWorkLogProjectionState(
  previousState: WorkLogProjectionState,
  latestTurn: LatestTurnTiming | null,
): WorkLogProjectionState {
  const state = cloneProjectionState(previousState);
  ingestLatestTurn(state, latestTurn);
  return state;
}

function cloneProjectionState(state: WorkLogProjectionState): WorkLogProjectionState {
  return {
    entries: [...state.entries],
    latestTurn: state.latestTurn,
    activeLifecycleEntryIdByKey: new Map(state.activeLifecycleEntryIdByKey),
    commandLaunchEntryIdByToolCallId: new Map(state.commandLaunchEntryIdByToolCallId),
    backgroundCompletionEntryIdByToolCallId: new Map(state.backgroundCompletionEntryIdByToolCallId),
    streamedOutputByToolCallId: new Map(state.streamedOutputByToolCallId),
    streamedOutputPresenceByToolCallId: new Set(state.streamedOutputPresenceByToolCallId),
    providerBackgroundTaskByTaskId: new Map(state.providerBackgroundTaskByTaskId),
    providerBackgroundTaskByToolUseId: new Map(state.providerBackgroundTaskByToolUseId),
    codexCandidatesByToolCallId: new Map(state.codexCandidatesByToolCallId),
    openCodexCandidateIdsByTurnId: cloneSetMap(state.openCodexCandidateIdsByTurnId),
    openCodexCandidateIdsByProcessId: cloneSetMap(state.openCodexCandidateIdsByProcessId),
    codexBackgroundReasonsByToolCallId: new Map(state.codexBackgroundReasonsByToolCallId),
    realChildTaskStarts: new Set(state.realChildTaskStarts),
    realChildTaskTerminals: new Set(state.realChildTaskTerminals),
    knownChildThreadIds: new Set(state.knownChildThreadIds),
    childThreadMetadataById: new Map(state.childThreadMetadataById),
    taskContextByTaskId: new Map(state.taskContextByTaskId),
    terminalTaskIds: new Set(state.terminalTaskIds),
  };
}

function cloneSetMap(source: ReadonlyMap<string, ReadonlySet<string>>): Map<string, Set<string>> {
  const next = new Map<string, Set<string>>();
  for (const [key, value] of source.entries()) {
    next.set(key, new Set(value));
  }
  return next;
}

function scopeProjectedEntries(
  entries: ReadonlyArray<WorkLogEntry>,
  scope: WorkLogScope,
  latestTurnId?: TurnId | undefined,
): WorkLogEntry[] {
  return entries
    .filter((entry) =>
      scope === "latest-turn" && latestTurnId ? entry.turnId === latestTurnId : true,
    )
    .toSorted(compareProjectedEntries);
}

function ingestMessage(state: WorkLogProjectionState, message: ChatMessage): void {
  if (message.role !== "assistant" || !message.turnId) {
    return;
  }
  for (const candidate of state.codexCandidatesByToolCallId.values()) {
    if (
      candidate.backgrounded ||
      candidate.turnId !== message.turnId ||
      !isIsoWithinCandidateLifetime(message.createdAt, candidate)
    ) {
      continue;
    }
    markCodexBackgroundCandidate(state, candidate.toolCallId, "assistant message");
  }
}

function ingestLatestTurn(
  state: WorkLogProjectionState,
  latestTurn: LatestTurnTiming | null,
): void {
  state.latestTurn = latestTurn;
  if (!latestTurn?.turnId || !latestTurn.startedAt) {
    return;
  }

  for (const candidate of state.codexCandidatesByToolCallId.values()) {
    if (candidate.backgrounded || !candidate.turnId) {
      continue;
    }
    if (candidate.turnId === latestTurn.turnId) {
      if (
        latestTurn.completedAt &&
        isIsoWithinCandidateLifetime(latestTurn.completedAt, candidate)
      ) {
        markCodexBackgroundCandidate(state, candidate.toolCallId, "turn completed");
      }
      continue;
    }
    if (isIsoWithinCandidateLifetime(latestTurn.startedAt, candidate)) {
      markCodexBackgroundCandidate(state, candidate.toolCallId, "later turn started");
    }
  }
}

function ingestActivity(
  state: WorkLogProjectionState,
  activity: OrchestrationThreadActivity,
): void {
  if (shouldIgnoreActivity(activity)) {
    return;
  }

  const payload = asRecord(activity.payload);
  trackChildTaskState(state, activity, payload);
  const presentation = classifyOrchestrationActivityPresentation(activity);

  if (presentation.visibility === "ignore") {
    return;
  }

  if (presentation.visibility === "state-only") {
    if (activity.kind === "tool.output.delta") {
      ingestCommandOutputDelta(state, payload);
      return;
    }

    if (activity.kind === "tool.terminal.interaction") {
      ingestTerminalInteraction(state, payload);
      return;
    }
  }

  const activityItemType = extractWorkLogItemType(payload);

  if (presentation.visibility === "row") {
    const currentToolCallId =
      activityItemType === "command_execution" ? extractToolCallId(payload) : undefined;
    markCodexBackgroundCandidatesForTurnAdvance(
      state,
      activity.turnId ?? undefined,
      currentToolCallId,
    );
  }

  if (isParentThreadTaskSignal(activity, payload)) {
    if (ingestParentThreadTaskSignal(state, activity, payload)) {
      return;
    }
  }

  if (ingestOwnedParentThreadTaskProgress(state, activity, payload)) {
    return;
  }

  if (
    payload?.childThreadAttribution == null &&
    (activity.kind === "task.started" || activity.kind === "task.completed") &&
    (activityItemType == null || activityItemType === "command_execution")
  ) {
    return;
  }

  if (shouldFilterToolStartedActivity(activity)) {
    return;
  }
  if (isUnattributedCollabAgentToolEnvelope(activity)) {
    return;
  }

  const entry = applyChildThreadMetadataToEntry(state, toDerivedWorkLogEntry(activity));
  if (
    entry.itemType === "command_execution" &&
    entry.isBackgroundCommand === true &&
    !entry.toolCallId
  ) {
    if (entry.activityKind === "tool.completed" && !entry.backgroundTaskId) {
      entry.backgroundLifecycleRole = "completion";
    } else {
      entry.backgroundLifecycleRole = "launch";
      entry.itemStatus = "inProgress";
      entry.completedAt = undefined;
    }
  }
  if (
    entry.itemType === "command_execution" &&
    entry.toolCallId &&
    (entry.isBackgroundCommand === true ||
      state.codexCandidatesByToolCallId.get(entry.toolCallId)?.backgrounded === true)
  ) {
    const existingLaunch = findCommandLaunchEntryByToolCallId(state, entry.toolCallId);
    if (
      entry.activityKind === "tool.completed" &&
      existingLaunch &&
      shouldSplitBackgroundCompletion(state, existingLaunch, entry)
    ) {
      // The launch entry stays frozen as "backgrounded, in-progress". Completion
      // data goes exclusively to a separate completion entry that renders at the
      // actual completion time — the historical launch entry is immutable.
      upsertBackgroundCompletionEntry(state, existingLaunch, entry);
      return;
    }
    entry.isBackgroundCommand = true;
    if (
      entry.activityKind === "tool.completed" &&
      !existingLaunch &&
      !entry.backgroundTaskId &&
      state.codexCandidatesByToolCallId.get(entry.toolCallId)?.backgrounded !== true
    ) {
      entry.backgroundLifecycleRole = "completion";
    } else {
      entry.backgroundLifecycleRole = "launch";
      entry.itemStatus = "inProgress";
      entry.completedAt = undefined;
    }
  }

  upsertDerivedEntry(state, entry);
  captureChildThreadMetadata(state, entry);

  if (entry.itemType === "command_execution" && entry.toolCallId) {
    state.commandLaunchEntryIdByToolCallId.set(
      entry.toolCallId,
      deriveCommandLaunchEntryId(state, entry.toolCallId) ?? entry.id,
    );
    applyStoredCommandOutput(state, entry.toolCallId);
    applyStoredBackgroundSignals(state, entry.toolCallId);
    trackCodexBackgroundCandidate(state, activity, entry);
  }
}

function synthesizeLifecycleActivities(
  state: WorkLogProjectionState,
  activity: OrchestrationThreadActivity,
): OrchestrationThreadActivity[] {
  const syntheticActivities: OrchestrationThreadActivity[] = [];
  const codexActivities = synthesizeCodexSubagentActivities(state, activity);
  if (codexActivities.length > 0) {
    syntheticActivities.push(...codexActivities);
  }
  const taskOutputActivity = synthesizeTaskOutputCompletionActivity(state, activity);
  if (taskOutputActivity) {
    syntheticActivities.push(taskOutputActivity);
  }
  return syntheticActivities;
}

function shouldIgnoreActivity(activity: OrchestrationThreadActivity): boolean {
  return (
    activity.kind === "context-window.updated" ||
    activity.summary === "Checkpoint captured" ||
    isPlanBoundaryToolActivity(activity)
  );
}

function isPlanBoundaryToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") {
    return false;
  }
  const payload = asRecord(activity.payload);
  return typeof payload?.detail === "string" && payload.detail.startsWith("ExitPlanMode:");
}

function trackChildTaskState(
  state: WorkLogProjectionState,
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown> | undefined,
): void {
  const childAttr = asRecord(payload?.childThreadAttribution);
  const childProviderThreadId = asTrimmedString(childAttr?.childProviderThreadId);
  const childTaskId = asTrimmedString(childAttr?.taskId);
  const runtimeTaskId = asTrimmedString(payload?.taskId);
  if (childProviderThreadId) {
    state.knownChildThreadIds.add(childProviderThreadId);
  }
  if (runtimeTaskId) {
    const existingContext = state.taskContextByTaskId.get(runtimeTaskId) ?? {};
    state.taskContextByTaskId.set(runtimeTaskId, {
      toolUseId: asTrimmedString(payload?.toolUseId) ?? existingContext.toolUseId,
      childThreadAttribution: childAttr ?? existingContext.childThreadAttribution,
    });
  }

  if (!childTaskId || !childProviderThreadId) {
    return;
  }
  const childKey = `${childTaskId}\u001f${childProviderThreadId}`;
  if (activity.kind === "task.started") {
    state.realChildTaskStarts.add(childKey);
    return;
  }
  if (activity.kind === "task.completed") {
    state.realChildTaskTerminals.add(childKey);
    if (runtimeTaskId) {
      state.terminalTaskIds.add(runtimeTaskId);
    }
    removeSyntheticChildTaskCompletionEntry(state, childTaskId, childProviderThreadId);
    return;
  }
  if (activity.kind === "task.updated") {
    const patchStatus = asTrimmedString(asRecord(payload?.patch)?.status);
    if (patchStatus === "completed" || patchStatus === "failed" || patchStatus === "killed") {
      state.realChildTaskTerminals.add(childKey);
      if (runtimeTaskId) {
        state.terminalTaskIds.add(runtimeTaskId);
      }
      removeSyntheticChildTaskCompletionEntry(state, childTaskId, childProviderThreadId);
    }
  }
}

function synthesizeCodexSubagentActivities(
  state: WorkLogProjectionState,
  activity: OrchestrationThreadActivity,
): OrchestrationThreadActivity[] {
  if (
    activity.kind !== "tool.started" &&
    activity.kind !== "tool.updated" &&
    activity.kind !== "tool.completed"
  ) {
    return [];
  }
  const payload = asRecord(activity.payload);
  if (payload?.itemType !== "collab_agent_tool_call" || payload.childThreadAttribution) {
    return [];
  }

  const data = asRecord(payload.data);
  const item = asRecord(data?.item);
  const toolName = asTrimmedString(item?.tool);
  const taskId = asTrimmedString(item?.id);
  const receiverThreadIds =
    asArray(item?.receiverThreadIds)
      ?.map((value) => asTrimmedString(value))
      .filter((value): value is string => value != null) ?? [];
  if (!taskId || receiverThreadIds.length === 0) {
    return [];
  }

  const label = asTrimmedString(item?.description) ?? asTrimmedString(item?.prompt)?.slice(0, 120);
  const agentModel = asTrimmedString(item?.model) ?? undefined;
  const agentsStates = asRecord(item?.agentsStates);
  const syntheticActivities: OrchestrationThreadActivity[] = [];

  for (const childProviderThreadId of receiverThreadIds) {
    const childKey = `${taskId}\u001f${childProviderThreadId}`;
    if (toolName === "spawnAgent" && !state.realChildTaskStarts.has(childKey)) {
      state.realChildTaskStarts.add(childKey);
      syntheticActivities.push({
        id: EventId.makeUnsafe(`synthetic:codex:task.started:${taskId}:${childProviderThreadId}`),
        tone: "info",
        kind: "task.started",
        summary: "Task started",
        payload: {
          taskId,
          toolUseId: taskId,
          childThreadAttribution: {
            taskId,
            childProviderThreadId,
            ...(label ? { label } : {}),
            ...(agentModel ? { agentModel } : {}),
          },
        },
        turnId: activity.turnId,
        createdAt: activity.createdAt,
        ...(activity.sequence !== undefined ? { sequence: activity.sequence } : {}),
      });
    }

    if (state.realChildTaskTerminals.has(childKey)) {
      continue;
    }
    if (
      isCodexControlCollabTool(toolName) &&
      !state.knownChildThreadIds.has(childProviderThreadId)
    ) {
      continue;
    }
    const agentState = asRecord(agentsStates?.[childProviderThreadId]);
    const normalizedStatus = normalizeCodexCollabAgentTerminalStatus(
      asTrimmedString(agentState?.status),
    );
    if (normalizedStatus === "running") {
      continue;
    }
    state.realChildTaskTerminals.add(childKey);
    state.terminalTaskIds.add(taskId);
    syntheticActivities.push({
      id: EventId.makeUnsafe(`synthetic:codex:task.completed:${taskId}:${childProviderThreadId}`),
      tone: normalizedStatus === "failed" ? "error" : "info",
      kind: "task.completed",
      summary: normalizedStatus === "failed" ? "Task failed" : "Task completed",
      payload: {
        taskId,
        toolUseId: taskId,
        status: normalizedStatus === "failed" ? "failed" : "completed",
        childThreadAttribution: {
          taskId,
          childProviderThreadId,
          ...(label ? { label } : {}),
          ...(agentModel ? { agentModel } : {}),
        },
      },
      turnId: activity.turnId,
      createdAt: activity.createdAt,
      ...(activity.sequence !== undefined ? { sequence: activity.sequence } : {}),
    });
  }

  return syntheticActivities;
}

function synthesizeTaskOutputCompletionActivity(
  state: WorkLogProjectionState,
  activity: OrchestrationThreadActivity,
): OrchestrationThreadActivity | null {
  if (activity.kind !== "tool.completed") {
    return null;
  }
  const payload = asRecord(activity.payload);
  const toolName =
    asTrimmedString(payload?.toolName) ??
    asTrimmedString(asRecord(payload?.data)?.toolName) ??
    asTrimmedString(asRecord(asRecord(payload?.data)?.item)?.tool);
  if (toolName !== "TaskOutput") {
    return null;
  }
  const toolUseResult = asRecord(asRecord(payload?.data)?.toolUseResult);
  const resolvedTask = asRecord(toolUseResult?.task);
  const taskId = asTrimmedString(resolvedTask?.task_id) ?? asTrimmedString(resolvedTask?.taskId);
  const status = normalizeClaudeTaskOutputTaskStatus(asTrimmedString(resolvedTask?.status));
  if (!taskId || status === "running" || state.terminalTaskIds.has(taskId)) {
    return null;
  }
  state.terminalTaskIds.add(taskId);
  const taskContext = state.taskContextByTaskId.get(taskId);
  const description = asTrimmedString(resolvedTask?.description);
  return {
    id: EventId.makeUnsafe(`synthetic:claude:task.completed:${taskId}`),
    tone: status === "failed" ? "error" : "info",
    kind: "task.completed",
    summary: status === "failed" ? "Task failed" : "Task completed",
    payload: {
      taskId,
      status: status === "failed" ? "failed" : "completed",
      ...(taskContext?.toolUseId ? { toolUseId: taskContext.toolUseId } : {}),
      ...(description ? { detail: description } : {}),
      ...(taskContext?.childThreadAttribution
        ? { childThreadAttribution: taskContext.childThreadAttribution }
        : {}),
    },
    turnId: activity.turnId,
    createdAt: activity.createdAt,
    ...(activity.sequence !== undefined ? { sequence: activity.sequence } : {}),
  };
}

function ingestCommandOutputDelta(
  state: WorkLogProjectionState,
  payload: Record<string, unknown> | undefined,
): void {
  const streamKind = asTrimmedString(payload?.streamKind);
  const toolCallId = asTrimmedString(payload?.itemId);
  const delta = typeof payload?.delta === "string" ? payload.delta : null;
  const hasDelta =
    (typeof payload?.delta === "string" && payload.delta.length > 0) ||
    (typeof payload?.deltaLength === "number" && payload.deltaLength > 0);
  if (streamKind !== "command_output" || !toolCallId) {
    return;
  }
  if (hasDelta) {
    state.streamedOutputPresenceByToolCallId.add(toolCallId);
  }
  if (delta && delta.length > 0) {
    state.streamedOutputByToolCallId.set(
      toolCallId,
      `${state.streamedOutputByToolCallId.get(toolCallId) ?? ""}${delta}`,
    );
  }
  applyStoredCommandOutput(state, toolCallId);
}

function ingestTerminalInteraction(
  state: WorkLogProjectionState,
  payload: Record<string, unknown> | undefined,
): void {
  const toolCallId = asTrimmedString(payload?.itemId);
  const processId = asTrimmedString(payload?.processId);
  const stdin = typeof payload?.stdin === "string" ? payload.stdin : "";
  const reason =
    stdin.length === 0 ? "background terminal wait" : "background terminal interaction";
  if (toolCallId) {
    markCodexBackgroundCandidate(state, toolCallId, reason);
  }
  if (!processId) {
    return;
  }
  const candidateIds = state.openCodexCandidateIdsByProcessId.get(processId);
  if (!candidateIds) {
    return;
  }
  for (const candidateId of candidateIds) {
    markCodexBackgroundCandidate(state, candidateId, reason);
  }
}

function isParentThreadTaskSignal(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown> | undefined,
): boolean {
  const itemType = extractWorkLogItemType(payload);
  if (itemType && itemType !== "command_execution") {
    return false;
  }
  if (
    activity.kind !== "task.started" &&
    activity.kind !== "task.completed" &&
    activity.kind !== "task.updated"
  ) {
    return false;
  }
  return payload?.childThreadAttribution == null;
}

function ingestParentThreadTaskSignal(
  state: WorkLogProjectionState,
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown> | undefined,
): boolean {
  const taskId = asTrimmedString(payload?.taskId);
  const toolUseId = asTrimmedString(payload?.toolUseId);
  if (!taskId && !toolUseId) {
    return false;
  }
  if (taskId) {
    const existingContext = state.taskContextByTaskId.get(taskId) ?? {};
    state.taskContextByTaskId.set(taskId, {
      toolUseId: toolUseId ?? existingContext.toolUseId,
      childThreadAttribution: existingContext.childThreadAttribution,
    });
  }
  const status = normalizeProviderBackgroundTaskStatus(activity.kind, payload);

  // Guard: skip re-processing non-authoritative terminal signals for tasks
  // that already reached terminal state. task.completed (from TaskOutput) is
  // authoritative and always processes; task.updated with terminal status is
  // informational and skips when already terminal to prevent shifting.
  if (
    taskId &&
    status !== "running" &&
    activity.kind !== "task.completed" &&
    state.terminalTaskIds.has(taskId)
  ) {
    return true;
  }
  const existing =
    (toolUseId ? state.providerBackgroundTaskByToolUseId.get(toolUseId) : undefined) ??
    (taskId ? state.providerBackgroundTaskByTaskId.get(taskId) : undefined);
  const signal: ProviderBackgroundTaskSignal = {
    taskId: taskId ?? existing?.taskId,
    toolUseId: toolUseId ?? existing?.toolUseId,
    status,
    startedAt: earliestIsoValue(existing?.startedAt, activity.createdAt) ?? activity.createdAt,
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
  if (signal.taskId) {
    state.providerBackgroundTaskByTaskId.set(signal.taskId, signal);
  }
  if (signal.toolUseId) {
    state.providerBackgroundTaskByToolUseId.set(signal.toolUseId, signal);
  }
  if (taskId && status !== "running") {
    state.terminalTaskIds.add(taskId);
  }

  const entry =
    (toolUseId ? findCommandLaunchEntryByToolCallId(state, toolUseId) : undefined) ??
    (taskId ? findCommandLaunchEntryByBackgroundTaskId(state, taskId) : undefined);
  if (!entry || !isProviderOwnedBackgroundCommandLaunch(state, entry)) {
    return true;
  }
  // Only patch the launch entry with the task ID binding (for matching) and
  // initial background state. Do NOT propagate completion status — the launch
  // entry is immutable once backgrounded.
  if (!entry.backgroundTaskId && signal.taskId) {
    patchBackgroundCommandLaunchEntry(state, entry.id, {
      isBackgroundCommand: true,
      backgroundTaskId: signal.taskId,
      itemStatus: "inProgress",
      completedAt: undefined,
    });
  }
  if (signal.status !== "running") {
    upsertBackgroundCompletionEntry(state, entry, undefined, signal);
  }
  return true;
}

function ingestOwnedParentThreadTaskProgress(
  state: WorkLogProjectionState,
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown> | undefined,
): boolean {
  const itemType = extractWorkLogItemType(payload);
  if (itemType && itemType !== "command_execution") {
    return false;
  }
  if (activity.kind !== "task.progress" || payload?.childThreadAttribution != null) {
    return false;
  }
  const taskId = asTrimmedString(payload?.taskId);
  const toolUseId = asTrimmedString(payload?.toolUseId);
  if (!taskId && !toolUseId) {
    return false;
  }
  const entry =
    (toolUseId ? findCommandLaunchEntryByToolCallId(state, toolUseId) : undefined) ??
    (taskId ? findCommandLaunchEntryByBackgroundTaskId(state, taskId) : undefined);
  if (!entry || !isProviderOwnedBackgroundCommandLaunch(state, entry)) {
    return true;
  }

  if (taskId) {
    const existingContext = state.taskContextByTaskId.get(taskId) ?? {};
    state.taskContextByTaskId.set(taskId, {
      toolUseId: toolUseId ?? existingContext.toolUseId,
      childThreadAttribution: existingContext.childThreadAttribution,
    });
    state.providerBackgroundTaskByTaskId.set(taskId, {
      ...(state.providerBackgroundTaskByTaskId.get(taskId) ?? {
        taskId,
        status: "running",
        startedAt: activity.createdAt,
      }),
      taskId,
      toolUseId,
      status: "running",
      startedAt:
        earliestIsoValue(
          state.providerBackgroundTaskByTaskId.get(taskId)?.startedAt,
          activity.createdAt,
        ) ?? activity.createdAt,
    });
  }
  if (toolUseId) {
    state.providerBackgroundTaskByToolUseId.set(toolUseId, {
      ...(state.providerBackgroundTaskByToolUseId.get(toolUseId) ?? {
        taskId,
        toolUseId,
        status: "running",
        startedAt: activity.createdAt,
      }),
      taskId,
      toolUseId,
      status: "running",
      startedAt:
        earliestIsoValue(
          state.providerBackgroundTaskByToolUseId.get(toolUseId)?.startedAt,
          activity.createdAt,
        ) ?? activity.createdAt,
    });
  }
  patchBackgroundCommandLaunchEntry(state, entry.id, {
    isBackgroundCommand: true,
    ...(taskId ? { backgroundTaskId: taskId } : {}),
    backgroundTaskStatus: "running",
    itemStatus: "inProgress",
    completedAt: undefined,
  });
  return true;
}

function removeSyntheticChildTaskCompletionEntry(
  state: WorkLogProjectionState,
  childTaskId: string,
  childProviderThreadId: string,
): void {
  removeEntryById(
    state,
    EventId.makeUnsafe(`synthetic:codex:task.completed:${childTaskId}:${childProviderThreadId}`),
  );
}

function upsertDerivedEntry(state: WorkLogProjectionState, entry: DerivedWorkLogEntry): void {
  if (isCollapsibleToolLifecycleEntry(entry)) {
    const lifecycleKey = deriveLifecycleEntryKey(entry);
    const activeEntryId =
      lifecycleKey === undefined ? undefined : state.activeLifecycleEntryIdByKey.get(lifecycleKey);
    const activeEntry = activeEntryId ? findEntryById(state, activeEntryId) : undefined;
    if (
      activeEntry &&
      shouldCollapseToolLifecycleEntries(activeEntry as DerivedWorkLogEntry, entry)
    ) {
      const mergedEntry = mergeDerivedWorkLogEntries(activeEntry as DerivedWorkLogEntry, entry);
      replaceEntryAtExistingPosition(state, activeEntry.id, mergedEntry);
      if (lifecycleKey !== undefined) {
        if (isLifecycleEntryCompleted(mergedEntry)) {
          state.activeLifecycleEntryIdByKey.delete(lifecycleKey);
        } else {
          state.activeLifecycleEntryIdByKey.set(lifecycleKey, mergedEntry.id);
        }
      }
      if (mergedEntry.itemType === "command_execution" && mergedEntry.toolCallId) {
        state.commandLaunchEntryIdByToolCallId.set(mergedEntry.toolCallId, mergedEntry.id);
      }
      return;
    }
  }

  pushEntry(state, entry);
  const lifecycleKey = deriveLifecycleEntryKey(entry);
  if (lifecycleKey !== undefined && !isLifecycleEntryCompleted(entry)) {
    state.activeLifecycleEntryIdByKey.set(lifecycleKey, entry.id);
  }
  if (entry.itemType === "command_execution" && entry.toolCallId) {
    state.commandLaunchEntryIdByToolCallId.set(entry.toolCallId, entry.id);
  }
}

function pushEntry(state: WorkLogProjectionState, entry: WorkLogEntry): void {
  state.entries.push(entry);
}

function removeEntryById(state: WorkLogProjectionState, entryId: string): void {
  const index = state.entries.findIndex((candidate) => candidate.id === entryId);
  if (index === -1) {
    return;
  }
  state.entries.splice(index, 1);
}

function upsertEntryPreservingPosition(state: WorkLogProjectionState, entry: WorkLogEntry): void {
  const index = state.entries.findIndex((candidate) => candidate.id === entry.id);
  if (index === -1) {
    state.entries.push(entry);
    return;
  }
  state.entries[index] = entry;
}

function replaceEntryAtExistingPosition(
  state: WorkLogProjectionState,
  previousEntryId: string,
  nextEntry: WorkLogEntry,
): void {
  const index = state.entries.findIndex((candidate) => candidate.id === previousEntryId);
  if (index === -1) {
    upsertEntryPreservingPosition(state, nextEntry);
    return;
  }
  state.entries[index] = nextEntry;
}

function patchBackgroundCommandLaunchEntry(
  state: WorkLogProjectionState,
  entryId: string,
  patch: Partial<WorkLogEntry>,
): void {
  const entry = findEntryById(state, entryId);
  if (
    !entry ||
    entry.itemType !== "command_execution" ||
    entry.backgroundLifecycleRole === "completion"
  ) {
    return;
  }
  upsertEntryPreservingPosition(state, {
    ...entry,
    ...patch,
    backgroundLifecycleRole: "launch",
  });
}

function applyChildThreadMetadataToEntry(
  state: WorkLogProjectionState,
  entry: DerivedWorkLogEntry,
): DerivedWorkLogEntry {
  if (entry.itemType !== "collab_agent_tool_call") {
    return entry;
  }

  const [firstReceiverThreadId] = entry.receiverThreadIds ?? [];
  if (!firstReceiverThreadId) {
    return entry;
  }

  const metadata = state.childThreadMetadataById.get(firstReceiverThreadId);
  if (!metadata) {
    return entry;
  }

  return {
    ...entry,
    agentDescription: entry.agentDescription ?? metadata.label ?? metadata.description,
    agentPrompt: entry.agentPrompt ?? metadata.prompt,
    agentType: entry.agentType ?? metadata.agentType,
    agentModel: entry.agentModel ?? metadata.agentModel,
  };
}

function captureChildThreadMetadata(
  state: WorkLogProjectionState,
  entry: Pick<
    WorkLogEntry,
    | "itemType"
    | "receiverThreadIds"
    | "agentDescription"
    | "agentPrompt"
    | "detail"
    | "agentType"
    | "agentModel"
  >,
): void {
  if (entry.itemType !== "collab_agent_tool_call") {
    return;
  }

  for (const childThreadId of entry.receiverThreadIds ?? []) {
    const current = state.childThreadMetadataById.get(childThreadId) ?? {};
    const nextMetadata: ChildThreadMetadata = {
      label: current.label ?? entry.agentDescription ?? entry.detail,
      description: current.description ?? entry.agentDescription,
      prompt: current.prompt ?? entry.agentPrompt,
      agentType: current.agentType ?? entry.agentType,
      agentModel: current.agentModel ?? entry.agentModel,
    };
    state.childThreadMetadataById.set(childThreadId, nextMetadata);
    backfillChildThreadMetadata(state, childThreadId, nextMetadata);
  }
}

function backfillChildThreadMetadata(
  state: WorkLogProjectionState,
  childThreadId: string,
  metadata: ChildThreadMetadata,
): void {
  state.entries = state.entries.map((entry) => {
    if (
      entry.itemType !== "collab_agent_tool_call" ||
      !entry.receiverThreadIds?.includes(childThreadId)
    ) {
      return entry;
    }
    return {
      ...entry,
      agentDescription: entry.agentDescription ?? metadata.label ?? metadata.description,
      agentPrompt: entry.agentPrompt ?? metadata.prompt,
      agentType: entry.agentType ?? metadata.agentType,
      agentModel: entry.agentModel ?? metadata.agentModel,
    };
  });
}

function findEntryById(
  state: WorkLogProjectionState,
  entryId: string | undefined,
): WorkLogEntry | undefined {
  if (!entryId) {
    return undefined;
  }
  return state.entries.find((entry) => entry.id === entryId);
}

function deriveCommandLaunchEntryId(
  state: WorkLogProjectionState,
  toolCallId: string,
): string | undefined {
  const existing = state.commandLaunchEntryIdByToolCallId.get(toolCallId);
  if (existing) {
    return existing;
  }
  return state.entries.find(
    (entry) =>
      entry.itemType === "command_execution" &&
      entry.toolCallId === toolCallId &&
      entry.backgroundLifecycleRole !== "completion",
  )?.id;
}

function applyStoredCommandOutput(state: WorkLogProjectionState, toolCallId: string): void {
  const launchEntryId = deriveCommandLaunchEntryId(state, toolCallId);
  const launchEntry = findEntryById(state, launchEntryId);
  if (!launchEntry || launchEntry.itemType !== "command_execution") {
    return;
  }
  const streamedOutput = state.streamedOutputByToolCallId.get(toolCallId) ?? null;
  const hasStreamedOutput =
    streamedOutput !== null
      ? streamedOutput.trim().length > 0
      : state.streamedOutputPresenceByToolCallId.has(toolCallId);
  if (!hasStreamedOutput) {
    return;
  }
  upsertEntryPreservingPosition(state, {
    ...launchEntry,
    hasOutput: true,
    outputSource: "stream",
    ...(launchEntry.outputSource === "final" ||
    streamedOutput === null ||
    streamedOutput.trim().length === 0
      ? {}
      : { output: streamedOutput }),
  });
}

function applyStoredBackgroundSignals(state: WorkLogProjectionState, toolCallId: string): void {
  const launchEntryId = deriveCommandLaunchEntryId(state, toolCallId);
  const launchEntry = findEntryById(state, launchEntryId);
  if (!launchEntry || launchEntry.itemType !== "command_execution") {
    return;
  }
  if (!isProviderOwnedBackgroundCommandLaunch(state, launchEntry)) {
    return;
  }
  const providerTaskSignal =
    state.providerBackgroundTaskByToolUseId.get(toolCallId) ??
    (launchEntry.backgroundTaskId
      ? state.providerBackgroundTaskByTaskId.get(launchEntry.backgroundTaskId)
      : undefined);
  if (!providerTaskSignal) {
    return;
  }
  // Only bind the task ID to the launch entry for matching purposes.
  // Completion status goes to a separate completion entry, not the launch.
  const patch: Partial<WorkLogEntry> = {
    isBackgroundCommand: true,
    backgroundLifecycleRole: "launch",
    itemStatus: "inProgress",
    completedAt: undefined,
  };
  if (providerTaskSignal?.taskId) {
    patch.backgroundTaskId = providerTaskSignal.taskId;
  }
  patchBackgroundCommandLaunchEntry(state, launchEntry.id, patch);
}

function trackCodexBackgroundCandidate(
  state: WorkLogProjectionState,
  activity: OrchestrationThreadActivity,
  entry: DerivedWorkLogEntry,
): void {
  if (entry.itemType !== "command_execution" || !entry.toolCallId) {
    return;
  }
  const existing = state.codexCandidatesByToolCallId.get(entry.toolCallId);
  if (!existing && (entry.commandSource !== "unifiedExecStartup" || !entry.processId)) {
    return;
  }
  const candidate: CodexBackgroundCommandCandidate = existing
    ? {
        ...existing,
        turnId: existing.turnId ?? activity.turnId ?? undefined,
        processId: existing.processId ?? entry.processId,
        startedAt: earliestIsoValue(existing.startedAt, activity.createdAt) ?? activity.createdAt,
      }
    : {
        toolCallId: entry.toolCallId,
        turnId: activity.turnId ?? undefined,
        processId: entry.processId,
        startedAt: activity.createdAt,
        backgrounded: false,
      };
  if (activity.kind === "tool.completed") {
    candidate.completedAt = activity.createdAt;
  }
  state.codexCandidatesByToolCallId.set(entry.toolCallId, candidate);
  if (activity.kind !== "tool.completed") {
    trackOpenCodexBackgroundCandidate(
      state.openCodexCandidateIdsByTurnId,
      activity.turnId ?? candidate.turnId,
      entry.toolCallId,
    );
    trackOpenCodexBackgroundCandidate(
      state.openCodexCandidateIdsByProcessId,
      entry.processId ?? candidate.processId,
      entry.toolCallId,
    );
  } else {
    clearOpenCodexBackgroundCandidate(
      state.openCodexCandidateIdsByTurnId,
      activity.turnId ?? candidate.turnId,
      entry.toolCallId,
    );
    clearOpenCodexBackgroundCandidate(
      state.openCodexCandidateIdsByProcessId,
      entry.processId ?? candidate.processId,
      entry.toolCallId,
    );
  }
}

function trackOpenCodexBackgroundCandidate(
  openCandidateIds: Map<string, Set<string>>,
  key: string | null | undefined,
  toolCallId: string,
): void {
  if (!key) {
    return;
  }
  const existing = openCandidateIds.get(key) ?? new Set<string>();
  existing.add(toolCallId);
  openCandidateIds.set(key, existing);
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
  state: WorkLogProjectionState,
  turnId: string | undefined,
  currentToolCallId: string | undefined,
): void {
  if (!turnId) {
    return;
  }
  const candidateIds = state.openCodexCandidateIdsByTurnId.get(turnId);
  if (!candidateIds) {
    return;
  }
  for (const candidateId of candidateIds) {
    if (candidateId === currentToolCallId) {
      continue;
    }
    markCodexBackgroundCandidate(state, candidateId, "later turn activity");
  }
}

function markCodexBackgroundCandidate(
  state: WorkLogProjectionState,
  toolCallId: string,
  reason: string,
): void {
  const candidate = state.codexCandidatesByToolCallId.get(toolCallId);
  if (!candidate || candidate.backgrounded) {
    return;
  }
  state.codexCandidatesByToolCallId.set(toolCallId, { ...candidate, backgrounded: true });
  state.codexBackgroundReasonsByToolCallId.set(toolCallId, reason);
  const entry = findCommandLaunchEntryByToolCallId(state, toolCallId);
  if (!entry) {
    return;
  }
  patchBackgroundCommandLaunchEntry(state, entry.id, {
    isBackgroundCommand: true,
    itemStatus: "inProgress",
    completedAt: undefined,
  });
}

function findCommandLaunchEntryByToolCallId(
  state: WorkLogProjectionState,
  toolCallId: string,
): WorkLogEntry | undefined {
  const entryId = deriveCommandLaunchEntryId(state, toolCallId);
  const entry = findEntryById(state, entryId);
  if (!entry || entry.itemType !== "command_execution") {
    return undefined;
  }
  return entry;
}

function findCommandLaunchEntryByBackgroundTaskId(
  state: WorkLogProjectionState,
  backgroundTaskId: string,
): WorkLogEntry | undefined {
  return state.entries.find(
    (entry) =>
      entry.itemType === "command_execution" &&
      entry.backgroundLifecycleRole !== "completion" &&
      entry.backgroundTaskId === backgroundTaskId,
  );
}

function isProviderOwnedBackgroundCommandLaunch(
  state: WorkLogProjectionState,
  entry: WorkLogEntry,
): boolean {
  if (entry.itemType !== "command_execution") {
    return false;
  }
  if (entry.isBackgroundCommand === true || entry.backgroundTaskId) {
    return true;
  }
  if (!entry.toolCallId) {
    return false;
  }
  return state.codexCandidatesByToolCallId.get(entry.toolCallId)?.backgrounded === true;
}

function upsertBackgroundCompletionEntry(
  state: WorkLogProjectionState,
  launchEntry: WorkLogEntry,
  completionEntry?: DerivedWorkLogEntry,
  signal?: ProviderBackgroundTaskSignal,
): void {
  if (launchEntry.itemType !== "command_execution") {
    return;
  }
  const status =
    signal?.status ??
    (completionEntry
      ? deriveBackgroundCommandStatus(completionEntry)
      : deriveBackgroundCommandStatus(launchEntry));
  if (status === "running") {
    return;
  }
  const completionId =
    completionEntry?.id ??
    state.backgroundCompletionEntryIdByToolCallId.get(launchEntry.toolCallId ?? "") ??
    `${launchEntry.id}:background-task-completed`;
  const existingCompletionEntryCandidate = findEntryById(state, completionId);
  const existingCompletionEntry =
    existingCompletionEntryCandidate?.backgroundLifecycleRole === "completion"
      ? existingCompletionEntryCandidate
      : undefined;
  const completionEntryProvidesAnchor =
    completionEntry?.backgroundLifecycleRole === "completion" ||
    completionEntry?.activityKind === "tool.completed" ||
    completionEntry?.activityKind === "task.completed" ||
    completionEntry?.activityKind === "task.updated";
  const completedAt =
    existingCompletionEntry?.completedAt ??
    existingCompletionEntry?.createdAt ??
    signal?.completedAt ??
    (completionEntryProvidesAnchor
      ? (completionEntry?.completedAt ?? completionEntry?.createdAt)
      : undefined) ??
    launchEntry.backgroundCompletedAt ??
    launchEntry.completedAt ??
    launchEntry.createdAt;
  const nextEntry: WorkLogEntry = {
    ...launchEntry,
    ...existingCompletionEntry,
    ...completionEntry,
    id: completionId,
    createdAt: completedAt,
    ...(existingCompletionEntry?.sequence !== undefined
      ? { sequence: existingCompletionEntry.sequence }
      : signal?.completedSequence !== undefined
        ? { sequence: signal.completedSequence }
        : completionEntryProvidesAnchor && completionEntry?.sequence !== undefined
          ? { sequence: completionEntry.sequence }
          : {}),
    completedAt,
    label: status === "failed" ? "Background command failed" : "Background command completed",
    tone: completionEntry?.tone ?? (status === "failed" ? "error" : "tool"),
    activityKind: completionEntry?.activityKind ?? "task.completed",
    itemStatus: status === "failed" ? "failed" : "completed",
    isBackgroundCommand: true,
    backgroundTaskStatus: status,
    backgroundLifecycleRole: "completion",
  };
  if (!completionEntry && !existingCompletionEntry) {
    delete (nextEntry as Partial<WorkLogEntry>).detail;
    delete (nextEntry as Partial<WorkLogEntry>).output;
    delete (nextEntry as Partial<WorkLogEntry>).hasOutput;
    delete (nextEntry as Partial<WorkLogEntry>).outputByteLength;
    delete (nextEntry as Partial<WorkLogEntry>).outputSource;
    delete (nextEntry as Partial<WorkLogEntry>).exitCode;
    delete (nextEntry as Partial<WorkLogEntry>).durationMs;
  }
  state.backgroundCompletionEntryIdByToolCallId.set(
    launchEntry.toolCallId ?? completionId,
    completionId,
  );
  upsertEntryPreservingPosition(state, nextEntry);
}

function normalizeProviderBackgroundTaskStatus(
  activityKind: OrchestrationThreadActivity["kind"],
  payload: Record<string, unknown> | undefined,
): "running" | "completed" | "failed" {
  if (activityKind === "task.completed") {
    const status = asTrimmedString(payload?.status);
    return status === "failed" || status === "stopped" ? "failed" : "completed";
  }
  if (activityKind === "task.updated") {
    const patchStatus = asTrimmedString(asRecord(payload?.patch)?.status);
    if (patchStatus === "completed") {
      return "completed";
    }
    if (patchStatus === "failed" || patchStatus === "killed") {
      return "failed";
    }
  }
  return "running";
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

function normalizeClaudeTaskOutputTaskStatus(
  status: string | null | undefined,
): "running" | "completed" | "failed" {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "error":
    case "errored":
    case "stopped":
    case "killed":
    case "interrupted":
      return "failed";
    default:
      return "running";
  }
}

function normalizeCodexCollabAgentTerminalStatus(
  status: string | null | undefined,
): "running" | "completed" | "failed" {
  switch (status) {
    case "completed":
    case "shutdown":
      return "completed";
    case "failed":
    case "errored":
    case "interrupted":
    case "notFound":
      return "failed";
    default:
      return "running";
  }
}

function deriveBackgroundCommandStatus(
  entry: Pick<
    WorkLogEntry,
    | "backgroundTaskStatus"
    | "isBackgroundCommand"
    | "backgroundLifecycleRole"
    | "backgroundTaskId"
    | "itemStatus"
    | "tone"
    | "exitCode"
  >,
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

function shouldSplitBackgroundCompletion(
  state: WorkLogProjectionState,
  launchEntry: WorkLogEntry,
  completionEntry: DerivedWorkLogEntry,
): boolean {
  const toolCallId = completionEntry.toolCallId;
  if (!toolCallId) {
    return false;
  }
  if (state.codexCandidatesByToolCallId.get(toolCallId)?.backgrounded === true) {
    return true;
  }
  return Boolean(
    launchEntry.backgroundTaskId ||
    launchEntry.backgroundTaskStatus ||
    launchEntry.backgroundCompletedAt,
  );
}

function isCollapsibleToolLifecycleEntry(entry: DerivedWorkLogEntry): boolean {
  return (
    (entry.activityKind === "tool.started" ||
      entry.activityKind === "tool.updated" ||
      entry.activityKind === "tool.completed") &&
    entry.collapseKey !== undefined
  );
}

function deriveLifecycleEntryKey(entry: DerivedWorkLogEntry): string | undefined {
  if (!isCollapsibleToolLifecycleEntry(entry)) {
    return undefined;
  }
  if (entry.itemType === "command_execution" && entry.toolCallId) {
    return `${entry.turnId ?? ""}\u001fcommand:${entry.toolCallId}`;
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
  if (!isCollapsibleToolLifecycleEntry(previous) || !isCollapsibleToolLifecycleEntry(next)) {
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
  if (
    previous.itemType === "command_execution" &&
    next.itemType === "command_execution" &&
    previous.toolCallId &&
    next.toolCallId
  ) {
    return previous.toolCallId === next.toolCallId;
  }
  return previous.collapseKey !== undefined && previous.collapseKey === next.collapseKey;
}

function mergeDerivedWorkLogEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): DerivedWorkLogEntry {
  const createdAt = earliestIsoValue(previous.createdAt, next.createdAt) ?? next.createdAt;
  const sequence = previous.sequence ?? next.sequence;
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
    ...(sequence !== undefined ? { sequence } : {}),
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
  return merged.length > 0 ? [...new Set(merged)] : [];
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

function compareProjectedEntries(a: WorkLogEntry, b: WorkLogEntry): number {
  if (a.sequence !== undefined && b.sequence !== undefined && a.sequence !== b.sequence) {
    return a.sequence - b.sequence;
  }
  const timeComparison = a.createdAt.localeCompare(b.createdAt);
  if (timeComparison !== 0) {
    return timeComparison;
  }
  const activityRank =
    compareActivityLifecycleRank(
      (a.activityKind as OrchestrationThreadActivity["kind"] | undefined) ?? "tool.updated",
    ) -
    compareActivityLifecycleRank(
      (b.activityKind as OrchestrationThreadActivity["kind"] | undefined) ?? "tool.updated",
    );
  if (activityRank !== 0) {
    return activityRank;
  }
  return a.id.localeCompare(b.id);
}
