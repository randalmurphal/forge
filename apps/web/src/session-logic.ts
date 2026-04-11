import {
  ApprovalRequestId,
  EventId,
  isToolLifecycleItemType,
  type OrchestrationLatestTurn,
  type OrchestrationToolInlineDiff,
  type OrchestrationThreadActivity,
  type OrchestrationProposedPlanId,
  type ProviderKind,
  type MessageId,
  type ToolLifecycleItemType,
  type UserInputQuestion,
  type ThreadId,
  type TurnId,
} from "@forgetools/contracts";

import type {
  ChatMessage,
  ProposedPlan,
  SessionPhase,
  Thread,
  TurnDiffFileChange,
  ThreadSession,
  TurnDiffSummary,
} from "./types";

export type ProviderPickerKind = ProviderKind | "cursor";

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
}> = [
  { value: "codex", label: "Codex", available: true },
  { value: "claudeAgent", label: "Claude", available: true },
  { value: "cursor", label: "Cursor", available: false },
];

export interface WorkLogEntry {
  id: string;
  createdAt: string;
  startedAt?: string | undefined;
  turnId?: TurnId | undefined;
  toolCallId?: string | undefined;
  processId?: string | undefined;
  label: string;
  detail?: string;
  command?: string;
  changedFiles?: ReadonlyArray<string>;
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  itemType?: ToolLifecycleItemType;
  requestKind?: PendingApproval["requestKind"];
  inlineDiff?: ToolInlineDiffSummary | undefined;
  toolName?: string | undefined;
  itemStatus?: "inProgress" | "completed" | "failed" | "declined" | undefined;
  exitCode?: number | undefined;
  durationMs?: number | undefined;
  output?: string | undefined;
  hasOutput?: boolean | undefined;
  outputByteLength?: number | undefined;
  outputSource?: "final" | "stream" | undefined;
  isBackgroundCommand?: boolean | undefined;
  commandSource?: string | undefined;
  mcpServer?: string | undefined;
  mcpTool?: string | undefined;
  searchPattern?: string | undefined;
  searchResultCount?: number | undefined;
  filePath?: string | undefined;
  activityKind?: string | undefined;
  agentDescription?: string | undefined;
  agentType?: string | undefined;
  agentModel?: string | undefined;
  agentPrompt?: string | undefined;
  childThreadAttribution?:
    | {
        taskId: string;
        label?: string | undefined;
        childProviderThreadId: string;
        agentType?: string | undefined;
        agentModel?: string | undefined;
      }
    | undefined;
}

interface DerivedWorkLogEntry extends WorkLogEntry {
  activityKind: OrchestrationThreadActivity["kind"];
  collapseKey?: string;
}

export interface BackgroundTrayState {
  subagentGroups: SubagentGroup[];
  commandEntries: WorkLogEntry[];
  hiddenSubagentGroupIds: string[];
  hiddenWorkEntryIds: string[];
  hasRunningTasks: boolean;
  defaultCollapsed: boolean;
}

export type InlineDiffScope = "tool" | "turn";
export type InlineDiffAvailability = "exact_patch" | "summary_only";

export interface ToolInlineDiffSummary {
  id: string;
  turnId?: TurnId | undefined;
  activityId: string;
  toolCallId?: string | undefined;
  title: string;
  files: ReadonlyArray<TurnDiffFileChange>;
  additions?: number | undefined;
  deletions?: number | undefined;
  unifiedDiff?: string | undefined;
  availability: InlineDiffAvailability;
}

export interface TurnInlineDiffSummary extends TurnDiffSummary {
  id: string;
  assistantMessageId?: MessageId | undefined;
}

export type ExpandedInlineDiffState =
  | null
  | {
      scope: "tool";
      id: string;
    }
  | {
      scope: "turn";
      id: string;
    };

export interface PendingApproval {
  requestId: ApprovalRequestId;
  requestKind: "command" | "file-read" | "file-change";
  createdAt: string;
  detail?: string;
}

export interface PendingUserInput {
  requestId: ApprovalRequestId;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
}

export interface ActivePlanState {
  createdAt: string;
  turnId: TurnId | null;
  explanation?: string | null;
  steps: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }>;
}

export interface LatestProposedPlanState {
  id: OrchestrationProposedPlanId;
  createdAt: string;
  updatedAt: string;
  turnId: TurnId | null;
  planMarkdown: string;
  implementedAt: string | null;
  implementationThreadId: ThreadId | null;
}

export type TimelineEntry =
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: ChatMessage;
    }
  | {
      id: string;
      kind: "proposed-plan";
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      entry: WorkLogEntry;
    };

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }
  return formatDuration(endedAt - startedAt);
}

type LatestTurnTiming = Pick<OrchestrationLatestTurn, "turnId" | "startedAt" | "completedAt">;
type SessionActivityState = Pick<ThreadSession, "orchestrationStatus" | "activeTurnId">;

export function isLatestTurnSettled(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  if (!latestTurn?.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  if (!session) return true;
  if (session.orchestrationStatus === "running") return false;
  return true;
}

export function deriveActiveWorkStartedAt(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
  sendStartedAt: string | null,
): string | null {
  if (!isLatestTurnSettled(latestTurn, session)) {
    return latestTurn?.startedAt ?? sendStartedAt;
  }
  return sendStartedAt;
}

function requestKindFromRequestType(requestType: unknown): PendingApproval["requestKind"] | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return null;
  }
}

function isStalePendingRequestFailureDetail(detail: string | undefined): boolean {
  const normalized = detail?.toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("stale pending user-input request") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending permission request") ||
    normalized.includes("unknown pending user-input request")
  );
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingApproval[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingApproval>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;
    const requestKind =
      payload &&
      (payload.requestKind === "command" ||
        payload.requestKind === "file-read" ||
        payload.requestKind === "file-change")
        ? payload.requestKind
        : payload
          ? requestKindFromRequestType(payload.requestType)
          : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "approval.requested" && requestId && requestKind) {
      openByRequestId.set(requestId, {
        requestId,
        requestKind,
        createdAt: activity.createdAt,
        ...(detail ? { detail } : {}),
      });
      continue;
    }

    if (activity.kind === "approval.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.approval.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId);
      continue;
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  const parsed = questions
    .map<UserInputQuestion | null>((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const question = entry as Record<string, unknown>;
      if (
        typeof question.id !== "string" ||
        typeof question.header !== "string" ||
        typeof question.question !== "string" ||
        !Array.isArray(question.options)
      ) {
        return null;
      }
      const options = question.options
        .map<UserInputQuestion["options"][number] | null>((option) => {
          if (!option || typeof option !== "object") return null;
          const optionRecord = option as Record<string, unknown>;
          if (
            typeof optionRecord.label !== "string" ||
            typeof optionRecord.description !== "string"
          ) {
            return null;
          }
          return {
            label: optionRecord.label,
            description: optionRecord.description,
          };
        })
        .filter((option): option is UserInputQuestion["options"][number] => option !== null);
      if (options.length === 0) {
        return null;
      }
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);
  return parsed.length > 0 ? parsed : null;
}

export function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingUserInput[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingUserInput>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "user-input.requested" && requestId) {
      const questions = parseUserInputQuestions(payload);
      if (!questions) {
        continue;
      }
      openByRequestId.set(requestId, {
        requestId,
        createdAt: activity.createdAt,
        questions,
      });
      continue;
    }

    if (activity.kind === "user-input.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.user-input.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function deriveActivePlanState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): ActivePlanState | null {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const candidates = ordered.filter((activity) => {
    if (activity.kind !== "turn.plan.updated") {
      return false;
    }
    if (!latestTurnId) {
      return true;
    }
    return activity.turnId === latestTurnId;
  });
  const latest = candidates.at(-1);
  if (!latest) {
    return null;
  }
  const payload =
    latest.payload && typeof latest.payload === "object"
      ? (latest.payload as Record<string, unknown>)
      : null;
  const rawPlan = payload?.plan;
  if (!Array.isArray(rawPlan)) {
    return null;
  }
  const steps = rawPlan
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      if (typeof record.step !== "string") {
        return null;
      }
      const status =
        record.status === "completed" || record.status === "inProgress" ? record.status : "pending";
      return {
        step: record.step,
        status,
      };
    })
    .filter(
      (
        step,
      ): step is {
        step: string;
        status: "pending" | "inProgress" | "completed";
      } => step !== null,
    );
  if (steps.length === 0) {
    return null;
  }
  return {
    createdAt: latest.createdAt,
    turnId: latest.turnId,
    ...(payload && "explanation" in payload
      ? { explanation: payload.explanation as string | null }
      : {}),
    steps,
  };
}

export function findLatestProposedPlan(
  proposedPlans: ReadonlyArray<ProposedPlan>,
  latestTurnId: TurnId | string | null | undefined,
): LatestProposedPlanState | null {
  if (latestTurnId) {
    const matchingTurnPlan = [...proposedPlans]
      .filter((proposedPlan) => proposedPlan.turnId === latestTurnId)
      .toSorted(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .at(-1);
    if (matchingTurnPlan) {
      return toLatestProposedPlanState(matchingTurnPlan);
    }
  }

  const latestPlan = [...proposedPlans]
    .toSorted(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .at(-1);
  if (!latestPlan) {
    return null;
  }

  return toLatestProposedPlanState(latestPlan);
}

export function findSidebarProposedPlan(input: {
  threads: ReadonlyArray<Pick<Thread, "id" | "proposedPlans">>;
  latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "sourceProposedPlan"> | null;
  latestTurnSettled: boolean;
  threadId: ThreadId | string | null | undefined;
}): LatestProposedPlanState | null {
  const activeThreadPlans =
    input.threads.find((thread) => thread.id === input.threadId)?.proposedPlans ?? [];

  if (!input.latestTurnSettled) {
    const sourceProposedPlan = input.latestTurn?.sourceProposedPlan;
    if (sourceProposedPlan) {
      const sourcePlan = input.threads
        .find((thread) => thread.id === sourceProposedPlan.threadId)
        ?.proposedPlans.find((plan) => plan.id === sourceProposedPlan.planId);
      if (sourcePlan) {
        return toLatestProposedPlanState(sourcePlan);
      }
    }
  }

  return findLatestProposedPlan(activeThreadPlans, input.latestTurn?.turnId ?? null);
}

export function hasActionableProposedPlan(
  proposedPlan: LatestProposedPlanState | Pick<ProposedPlan, "implementedAt"> | null,
): boolean {
  return proposedPlan !== null && proposedPlan.implementedAt === null;
}

export type WorkLogScope = "latest-turn" | "all-turns";
const BACKGROUND_TASK_RETENTION_MS = 5_000;

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  input:
    | {
        scope: WorkLogScope;
        latestTurnId?: TurnId | undefined;
      }
    | TurnId
    | undefined,
): WorkLogEntry[] {
  const scope = typeof input === "object" && input !== null ? input.scope : "all-turns";
  const latestTurnId = typeof input === "object" && input !== null ? input.latestTurnId : input;
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
    ...synthesizeCodexSubagentCompletionActivities(scopedActivities),
  ].toSorted(compareActivitiesByOrder);
  const streamedCommandOutputByToolCallId = collectStreamedCommandOutputByToolCallId(ordered);
  const streamedCommandOutputPresenceByToolCallId =
    collectStreamedCommandOutputPresenceByToolCallId(ordered);
  const terminalInteractionsByToolCallId = collectTerminalInteractionsByToolCallId(ordered);
  const entries = ordered
    .filter((activity) => !shouldFilterToolStartedActivity(activity))
    .filter((activity) => activity.kind !== "tool.output.delta")
    .filter((activity) => activity.kind !== "tool.terminal.interaction")
    .filter((activity) => {
      return !isUnattributedCollabAgentToolEnvelope(activity);
    })
    .filter((activity) => {
      if (activity.kind === "task.started" || activity.kind === "task.completed") {
        const activityPayload =
          activity.payload && typeof activity.payload === "object"
            ? (activity.payload as Record<string, unknown>)
            : null;
        // Only keep entries that have child thread attribution — these are subagent boundaries.
        // Parent-thread task events (which also have taskId) should stay filtered out.
        return activityPayload?.childThreadAttribution != null;
      }
      return true;
    })
    .map(toDerivedWorkLogEntry);
  const collapsedEntries = collapseDerivedWorkLogEntries(entries);
  const entriesWithOutput = applyStreamedCommandOutput(
    collapsedEntries,
    streamedCommandOutputByToolCallId,
    streamedCommandOutputPresenceByToolCallId,
  );
  const entriesWithBackgroundSignals = applyBackgroundCommandSignals(
    entriesWithOutput,
    terminalInteractionsByToolCallId,
  );
  return entriesWithBackgroundSignals.map(({ collapseKey: _collapseKey, ...entry }) => entry);
}

function synthesizeCodexSubagentCompletionActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationThreadActivity[] {
  const completionsByChildKey = new Set<string>();
  for (const activity of activities) {
    if (activity.kind !== "task.completed") {
      continue;
    }
    const payload = asRecord(activity.payload);
    const childAttr = asRecord(payload?.childThreadAttribution);
    const taskId = asTrimmedString(childAttr?.taskId);
    const childProviderThreadId = asTrimmedString(childAttr?.childProviderThreadId);
    if (taskId && childProviderThreadId) {
      completionsByChildKey.add(`${taskId}\u001f${childProviderThreadId}`);
    }
  }

  const syntheticActivities: OrchestrationThreadActivity[] = [];
  for (const activity of activities) {
    if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") {
      continue;
    }
    const payload = asRecord(activity.payload);
    if (payload?.itemType !== "collab_agent_tool_call" || payload.childThreadAttribution) {
      continue;
    }

    const data = asRecord(payload.data);
    const item = asRecord(data?.item);
    if (isCodexControlCollabTool(asTrimmedString(item?.tool))) {
      continue;
    }
    const taskId = asTrimmedString(item?.id);
    const receiverThreadIds =
      asArray(item?.receiverThreadIds)
        ?.map((value) => asTrimmedString(value))
        .filter((value): value is string => value !== null) ?? [];
    if (!taskId || receiverThreadIds.length === 0) {
      continue;
    }

    const label = asTrimmedString(item?.prompt)?.slice(0, 120);
    const agentModel = asTrimmedString(item?.model) ?? undefined;
    const agentsStates = asRecord(item?.agentsStates);
    const itemStatus = asTrimmedString(item?.status) ?? asTrimmedString(payload.status);

    for (const childProviderThreadId of receiverThreadIds) {
      const completionKey = `${taskId}\u001f${childProviderThreadId}`;
      if (completionsByChildKey.has(completionKey)) {
        continue;
      }

      const agentState = asRecord(agentsStates?.[childProviderThreadId]);
      const normalizedStatus = resolveCodexCollabAgentTerminalStatus(
        asTrimmedString(agentState?.status),
        itemStatus,
      );
      if (normalizedStatus === "running") {
        continue;
      }

      completionsByChildKey.add(completionKey);
      syntheticActivities.push({
        id: EventId.makeUnsafe(
          `${activity.id}:synthetic-subagent-complete:${childProviderThreadId}`,
        ),
        tone: normalizedStatus === "failed" ? "error" : "info",
        kind: "task.completed",
        summary: normalizedStatus === "failed" ? "Task failed" : "Task completed",
        payload: {
          taskId,
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
      });
    }
  }

  return syntheticActivities;
}

function resolveCodexCollabAgentTerminalStatus(
  agentStatus: string | null,
  itemStatus: string | null,
): "running" | "completed" | "failed" {
  const normalizedAgentStatus = normalizeCodexCollabAgentTerminalStatus(agentStatus);
  if (normalizedAgentStatus !== "running") {
    return normalizedAgentStatus;
  }
  return normalizeCodexCollabAgentTerminalStatus(itemStatus);
}

function normalizeCodexCollabAgentTerminalStatus(
  status: string | null,
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

function collectStreamedCommandOutputByToolCallId(
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

function collectStreamedCommandOutputPresenceByToolCallId(
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

function collectTerminalInteractionsByToolCallId(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): Set<string> {
  const toolCallIds = new Set<string>();
  for (const activity of activities) {
    if (activity.kind !== "tool.terminal.interaction") {
      continue;
    }
    const payload = asRecord(activity.payload);
    const toolCallId = asTrimmedString(payload?.itemId);
    if (!toolCallId) {
      continue;
    }
    toolCallIds.add(toolCallId);
  }
  return toolCallIds;
}

function applyStreamedCommandOutput(
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

function applyBackgroundCommandSignals(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
  terminalInteractionsByToolCallId: ReadonlySet<string>,
): DerivedWorkLogEntry[] {
  return entries.map((entry) => {
    if (entry.itemType !== "command_execution") {
      return entry;
    }
    const hasUnifiedExecSource = isUnifiedExecCommandSource(entry.commandSource);
    const hasTerminalInteraction =
      entry.toolCallId !== undefined &&
      entry.toolCallId.length > 0 &&
      terminalInteractionsByToolCallId.has(entry.toolCallId);
    if (!entry.isBackgroundCommand && !hasUnifiedExecSource && !hasTerminalInteraction) {
      return entry;
    }
    return {
      ...entry,
      isBackgroundCommand: true,
    };
  });
}

function shouldFilterToolStartedActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.started") {
    return false;
  }
  const payload = asRecord(activity.payload);
  return payload?.itemType !== "command_execution";
}

export interface SubagentGroup {
  groupId: string;
  taskId: string;
  childProviderThreadId: string;
  label: string;
  entries: WorkLogEntry[];
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string | undefined;
  agentType?: string | undefined;
  agentModel?: string | undefined;
}

function isUnattributedCollabAgentToolEnvelope(activity: OrchestrationThreadActivity): boolean {
  if (
    activity.kind !== "tool.started" &&
    activity.kind !== "tool.updated" &&
    activity.kind !== "tool.completed"
  ) {
    return false;
  }
  const payload = asRecord(activity.payload);
  return payload?.itemType === "collab_agent_tool_call" && !payload.childThreadAttribution;
}

function isCodexControlCollabTool(toolName: string | null): boolean {
  return toolName === "sendInput" || toolName === "wait";
}

export function groupSubagentEntries(workEntries: ReadonlyArray<WorkLogEntry>): {
  standalone: WorkLogEntry[];
  subagentGroups: SubagentGroup[];
} {
  const standalone: WorkLogEntry[] = [];
  const groupsByChildThreadId = new Map<
    string,
    {
      groupId: string;
      taskId: string;
      childProviderThreadId: string;
      entries: WorkLogEntry[];
      label: string | undefined;
      startedAt: string;
      completedAt?: string;
      status: SubagentGroup["status"];
      agentType?: string | undefined;
      agentModel?: string | undefined;
    }
  >();

  for (const entry of workEntries) {
    const childThreadAttribution = entry.childThreadAttribution;
    if (!childThreadAttribution) {
      standalone.push(entry);
      continue;
    }
    const groupId = childThreadAttribution.childProviderThreadId;
    const taskId = childThreadAttribution.taskId;

    let group = groupsByChildThreadId.get(groupId);
    if (!group) {
      group = {
        groupId,
        taskId,
        childProviderThreadId: childThreadAttribution.childProviderThreadId,
        entries: [],
        label: childThreadAttribution.label ?? undefined,
        startedAt: entry.startedAt ?? entry.createdAt,
        status: "running",
        agentType: childThreadAttribution.agentType,
        agentModel: childThreadAttribution.agentModel,
      };
      groupsByChildThreadId.set(groupId, group);
    } else if (
      group.taskId === group.childProviderThreadId &&
      taskId !== group.childProviderThreadId
    ) {
      group.taskId = taskId;
    }

    // Update group metadata from task lifecycle entries
    if (entry.activityKind === "task.started") {
      group.startedAt = entry.startedAt ?? entry.createdAt;
      if (!group.label && entry.detail) {
        group.label = entry.detail;
      }
    } else if (entry.activityKind === "task.completed") {
      group.completedAt =
        group.completedAt && group.completedAt > entry.createdAt
          ? group.completedAt
          : entry.createdAt;
      const completedStatus =
        entry.itemStatus === "failed" || entry.itemStatus === "declined" || entry.tone === "error"
          ? "failed"
          : "completed";
      group.status = group.status === "failed" ? "failed" : completedStatus;
    } else {
      // Regular work entry for this subagent
      group.entries.push(entry);
    }

    // Update label from attribution if available
    if (childThreadAttribution.label && !group.label) {
      group.label = childThreadAttribution.label;
    }
    if (!group.agentType && childThreadAttribution.agentType) {
      group.agentType = childThreadAttribution.agentType;
    }
    if (!group.agentModel && childThreadAttribution.agentModel) {
      group.agentModel = childThreadAttribution.agentModel;
    }
  }

  const subagentGroups: SubagentGroup[] = [];
  for (const group of groupsByChildThreadId.values()) {
    subagentGroups.push({
      groupId: group.groupId,
      taskId: group.taskId,
      childProviderThreadId: group.childProviderThreadId,
      label: group.label ?? `Subagent ${group.taskId.slice(0, 8)}`,
      entries: group.entries,
      status: group.status,
      startedAt: group.startedAt,
      completedAt: group.completedAt,
      agentType: group.agentType,
      agentModel: group.agentModel,
    });
  }

  return { standalone, subagentGroups };
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

interface ToolEnrichments {
  toolName?: string;
  exitCode?: number;
  durationMs?: number;
  output?: string;
  hasOutput?: boolean;
  outputByteLength?: number;
  outputSource?: "final" | "stream";
  isBackgroundCommand?: boolean;
  processId?: string;
  commandSource?: string;
  mcpServer?: string;
  mcpTool?: string;
  searchPattern?: string;
  searchResultCount?: number;
  filePath?: string;
  agentDescription?: string;
  agentType?: string;
  agentModel?: string;
  agentPrompt?: string;
}

function extractToolEnrichments(payload: Record<string, unknown> | null): ToolEnrichments {
  const enrichments: ToolEnrichments = {};
  if (!payload) return enrichments;

  // toolName from payload level (set by ingestion from ItemLifecyclePayload.toolName)
  const payloadToolName = asTrimmedString(payload.toolName);
  if (payloadToolName) {
    enrichments.toolName = payloadToolName;
  }

  const data = asRecord(payload.data);
  if (!data) return enrichments;

  // Claude shape: { toolName, input, result? }
  const claudeToolName = asTrimmedString(data.toolName);
  if (claudeToolName && !enrichments.toolName) {
    enrichments.toolName = claudeToolName;
  }

  const claudeInput = asRecord(data.input);
  const claudeResult = asRecord(data.result);

  // Codex shape: { item: { type, command, output, exitCode, durationMs, ... }, ... }
  const codexItem = asRecord(data.item);
  const codexResult = asRecord(codexItem?.result);
  const codexInput = asRecord(codexItem?.input);

  // Exit code
  const exitCodeCandidates = [
    codexItem?.exitCode,
    claudeResult?.exit_code,
    claudeResult?.exitCode,
    codexResult?.exitCode,
  ];
  for (const candidate of exitCodeCandidates) {
    if (typeof candidate === "number" && Number.isInteger(candidate)) {
      enrichments.exitCode = candidate;
      break;
    }
  }

  // Duration
  const durationCandidates = [codexItem?.durationMs, data.durationMs];
  for (const candidate of durationCandidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      enrichments.durationMs = candidate;
      break;
    }
  }

  const finalOutputCandidates = [
    normalizeCommandOutputValue(codexItem?.aggregatedOutput),
    normalizeCommandOutputValue(claudeResult?.output),
    joinCommandOutputParts(
      normalizeCommandOutputValue(claudeResult?.stdout),
      normalizeCommandOutputValue(claudeResult?.stderr),
    ),
    normalizeCommandOutputValue(claudeResult?.stdout),
    normalizeCommandOutputValue(codexResult?.output),
  ];
  for (const candidate of finalOutputCandidates) {
    if (!candidate) {
      continue;
    }
    enrichments.output = candidate;
    enrichments.hasOutput = true;
    enrichments.outputByteLength = candidate.length;
    enrichments.outputSource = "final";
    break;
  }

  const outputSummary = asRecord(payload.outputSummary);
  if (outputSummary?.available === true) {
    const source =
      outputSummary.source === "final" || outputSummary.source === "stream"
        ? outputSummary.source
        : null;
    const byteLength =
      typeof outputSummary.byteLength === "number" && Number.isFinite(outputSummary.byteLength)
        ? outputSummary.byteLength
        : null;
    if (source) {
      enrichments.hasOutput = true;
      enrichments.outputSource = source;
    }
    if (byteLength !== null && byteLength >= 0) {
      enrichments.outputByteLength = byteLength;
    }
  }

  if (enrichments.exitCode === undefined) {
    const outputWithExitCodeCandidates = [
      typeof claudeResult?.output === "string" ? claudeResult.output : null,
      typeof codexResult?.output === "string" ? codexResult.output : null,
    ];
    for (const candidate of outputWithExitCodeCandidates) {
      if (!candidate) {
        continue;
      }
      const detailInfo = stripTrailingExitCode(candidate);
      if (detailInfo.exitCode !== undefined) {
        enrichments.exitCode = detailInfo.exitCode;
        break;
      }
    }
  }

  if (
    claudeInput?.run_in_background === true ||
    codexInput?.run_in_background === true ||
    data.run_in_background === true
  ) {
    enrichments.isBackgroundCommand = true;
  }

  const processId = asTrimmedString(codexItem?.processId);
  if (processId) {
    enrichments.processId = processId;
  }

  const commandSource = asTrimmedString(codexItem?.source);
  if (commandSource) {
    enrichments.commandSource = commandSource;
  }

  // MCP server and tool
  // Codex: item.server, item.tool
  // Claude: toolName is like "mcp__serverName__toolName" or just the tool name
  const mcpServer = asTrimmedString(codexItem?.server);
  const mcpTool = asTrimmedString(codexItem?.tool);
  if (mcpServer) {
    enrichments.mcpServer = mcpServer;
  }
  if (mcpTool) {
    enrichments.mcpTool = mcpTool;
  }
  // Parse Claude MCP tool names: mcp__server__tool
  if (!enrichments.mcpServer && enrichments.toolName) {
    const mcpMatch = /^mcp__([^_]+(?:__[^_]+)*)__([^_]+(?:__[^_]+)*)$/.exec(enrichments.toolName);
    if (mcpMatch?.[1] && mcpMatch[2]) {
      enrichments.mcpServer = mcpMatch[1];
      enrichments.mcpTool = mcpMatch[2];
    }
  }

  // Search pattern and result count
  const searchPattern = asTrimmedString(claudeInput?.pattern) ?? asTrimmedString(codexItem?.query);
  if (searchPattern) {
    enrichments.searchPattern = searchPattern;
  }
  // Try to extract result count from grep/glob results
  if (claudeResult) {
    const resultContent = claudeResult.content;
    if (typeof resultContent === "string") {
      const fileMatches = resultContent.match(/\n/g);
      if (fileMatches) {
        enrichments.searchResultCount = fileMatches.length;
      }
    }
  }

  // File path
  const filePathCandidates = [
    claudeInput?.file_path,
    claudeInput?.filePath,
    claudeInput?.path,
    codexItem?.path,
  ];
  for (const candidate of filePathCandidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      enrichments.filePath = candidate.trim();
      break;
    }
  }

  // Agent/subagent tool call enrichments
  // Claude shape: data.input has { description, subagent_type, model, prompt }
  // Codex shape: data.item has { description, prompt } (no subagent_type or model)
  const agentDescription =
    asTrimmedString(claudeInput?.description) ?? asTrimmedString(codexItem?.description);
  if (agentDescription) {
    enrichments.agentDescription = agentDescription;
  }
  const agentType = asTrimmedString(claudeInput?.subagent_type);
  if (agentType) {
    enrichments.agentType = agentType;
  }
  const agentModel = asTrimmedString(claudeInput?.model);
  if (agentModel) {
    enrichments.agentModel = agentModel;
  }
  const agentPrompt = asTrimmedString(claudeInput?.prompt) ?? asTrimmedString(codexItem?.prompt);
  if (agentPrompt) {
    enrichments.agentPrompt = agentPrompt;
  }

  return enrichments;
}

function toDerivedWorkLogEntry(activity: OrchestrationThreadActivity): DerivedWorkLogEntry {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const command = extractToolCommand(payload);
  const title = extractToolTitle(payload);
  const toolCallId = extractToolCallId(payload);
  const detailInfo =
    payload && typeof payload.detail === "string"
      ? stripTrailingExitCode(payload.detail)
      : { output: null as string | null, exitCode: undefined as number | undefined };
  const entry: DerivedWorkLogEntry = {
    id: activity.id,
    createdAt: activity.createdAt,
    startedAt: activity.createdAt,
    ...(activity.turnId ? { turnId: activity.turnId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    label: activity.summary,
    tone: activity.tone === "approval" ? "info" : activity.tone,
    activityKind: activity.kind,
  };
  const itemType = extractWorkLogItemType(payload);
  const requestKind = extractWorkLogRequestKind(payload);
  if (detailInfo.output) {
    entry.detail = stripToolNamePrefix(detailInfo.output);
  }
  if (command) {
    entry.command = command;
  }
  if (title) {
    entry.toolTitle = title;
  }
  if (itemType) {
    entry.itemType = itemType;
  }
  if (requestKind) {
    entry.requestKind = requestKind;
  }
  const inlineDiff =
    (activity.kind === "tool.updated" || activity.kind === "tool.completed") &&
    (itemType === "file_change" || itemType === "command_execution")
      ? extractPersistedToolInlineDiffSummary({
          activityId: activity.id,
          turnId: activity.turnId ?? undefined,
          toolCallId: toolCallId ?? undefined,
          payload,
          title: title ?? activity.summary,
        })
      : undefined;
  if (inlineDiff) {
    entry.inlineDiff = inlineDiff;
    entry.changedFiles = inlineDiff.files.map((file) => file.path);
  }
  const enrichments = extractToolEnrichments(payload);
  const itemStatus = normalizeWorkItemStatus(payload?.status) ?? deriveActivityItemStatus(activity);
  if (itemStatus) entry.itemStatus = itemStatus;
  if (enrichments.toolName) entry.toolName = enrichments.toolName;
  if (enrichments.exitCode !== undefined) entry.exitCode = enrichments.exitCode;
  else if (detailInfo.exitCode !== undefined) entry.exitCode = detailInfo.exitCode;
  if (enrichments.durationMs !== undefined) entry.durationMs = enrichments.durationMs;
  if (enrichments.output) entry.output = enrichments.output;
  if (enrichments.hasOutput) entry.hasOutput = true;
  if (enrichments.outputByteLength !== undefined)
    entry.outputByteLength = enrichments.outputByteLength;
  if (enrichments.outputSource) entry.outputSource = enrichments.outputSource;
  if (enrichments.isBackgroundCommand) entry.isBackgroundCommand = true;
  if (enrichments.processId) entry.processId = enrichments.processId;
  if (enrichments.commandSource) entry.commandSource = enrichments.commandSource;
  if (enrichments.mcpServer) entry.mcpServer = enrichments.mcpServer;
  if (enrichments.mcpTool) entry.mcpTool = enrichments.mcpTool;
  if (enrichments.searchPattern) entry.searchPattern = enrichments.searchPattern;
  if (enrichments.searchResultCount !== undefined)
    entry.searchResultCount = enrichments.searchResultCount;
  if (enrichments.filePath) entry.filePath = enrichments.filePath;
  if (enrichments.agentDescription) entry.agentDescription = enrichments.agentDescription;
  if (enrichments.agentType) entry.agentType = enrichments.agentType;
  if (enrichments.agentModel) entry.agentModel = enrichments.agentModel;
  if (enrichments.agentPrompt) entry.agentPrompt = enrichments.agentPrompt;

  // Extract child thread attribution for subagent grouping
  const childThreadAttribution = extractChildThreadAttribution(payload);
  if (childThreadAttribution) {
    entry.childThreadAttribution = childThreadAttribution;
  }

  // For task.progress entries (subagent reasoning updates), extract lastToolName as toolName
  if (
    activity.kind === "task.progress" &&
    !entry.toolName &&
    payload &&
    typeof payload.lastToolName === "string"
  ) {
    entry.toolName = payload.lastToolName;
  }
  const collapseKey = deriveToolLifecycleCollapseKey(entry);
  if (collapseKey) {
    entry.collapseKey = collapseKey;
  }
  return entry;
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
  const itemStatus = next.itemStatus ?? previous.itemStatus;
  const isBackgroundCommand = Boolean(previous.isBackgroundCommand || next.isBackgroundCommand);
  const processId = next.processId ?? previous.processId;
  const commandSource = next.commandSource ?? previous.commandSource;
  const mcpServer = next.mcpServer ?? previous.mcpServer;
  const mcpTool = next.mcpTool ?? previous.mcpTool;
  const searchPattern = next.searchPattern ?? previous.searchPattern;
  const searchResultCount = next.searchResultCount ?? previous.searchResultCount;
  const filePath = next.filePath ?? previous.filePath;
  return {
    ...previous,
    ...next,
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
    ...(itemStatus ? { itemStatus } : {}),
    ...(isBackgroundCommand ? { isBackgroundCommand } : {}),
    ...(processId ? { processId } : {}),
    ...(commandSource ? { commandSource } : {}),
    ...(mcpServer ? { mcpServer } : {}),
    ...(mcpTool ? { mcpTool } : {}),
    ...(searchPattern ? { searchPattern } : {}),
    ...(searchResultCount !== undefined ? { searchResultCount } : {}),
    ...(filePath ? { filePath } : {}),
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

function earliestIsoValue(
  previous: string | undefined,
  next: string | undefined,
): string | undefined {
  if (!previous) return next;
  if (!next) return previous;
  return previous <= next ? previous : next;
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

function summarizeToolInlineDiffFiles(files: ReadonlyArray<TurnDiffFileChange>): {
  additions?: number | undefined;
  deletions?: number | undefined;
} {
  let additions = 0;
  let deletions = 0;
  let hasStats = false;
  for (const file of files) {
    if (typeof file.additions === "number") {
      additions += file.additions;
      hasStats = true;
    }
    if (typeof file.deletions === "number") {
      deletions += file.deletions;
      hasStats = true;
    }
  }
  return hasStats ? { additions, deletions } : {};
}

function deriveToolLifecycleCollapseKey(entry: DerivedWorkLogEntry): string | undefined {
  if (
    entry.activityKind !== "tool.started" &&
    entry.activityKind !== "tool.updated" &&
    entry.activityKind !== "tool.completed"
  ) {
    return undefined;
  }
  if (entry.activityKind === "tool.started" && entry.itemType !== "command_execution") {
    return undefined;
  }
  const normalizedLabel = normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
  const itemType = entry.itemType ?? "";
  const stableIdentity = deriveToolLifecycleIdentity(entry);
  if (normalizedLabel.length === 0 && stableIdentity.length === 0 && itemType.length === 0) {
    return undefined;
  }
  return [itemType, normalizedLabel, stableIdentity].join("\u001f");
}

function deriveToolLifecycleIdentity(entry: DerivedWorkLogEntry): string {
  if (entry.toolCallId) {
    return `tool:${entry.toolCallId}`;
  }
  if ((entry.changedFiles?.length ?? 0) > 0) {
    return `files:${[...(entry.changedFiles ?? [])].toSorted().join("|")}`;
  }
  const inlineDiffFiles = entry.inlineDiff?.files;
  if (inlineDiffFiles && inlineDiffFiles.length > 0) {
    const inlineDiffPaths = inlineDiffFiles.map((file) => file.path).toSorted();
    return `diff-files:${inlineDiffPaths.join("|")}`;
  }
  const normalizedDetail = entry.detail?.trim() ?? "";
  if (normalizedDetail.length > 0) {
    return normalizedDetail;
  }
  if (entry.command) {
    return `command:${entry.command}`;
  }
  return "";
}

function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:started|complete|completed)\s*$/i, "").trim();
}

function toLatestProposedPlanState(proposedPlan: ProposedPlan): LatestProposedPlanState {
  return {
    id: proposedPlan.id,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
    turnId: proposedPlan.turnId,
    planMarkdown: proposedPlan.planMarkdown,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Strip leading tool name prefix from detail strings.
 * Claude adapter produces detail like "Read: /some/file.ts" or "Bash: git status".
 * Since we now display the tool name separately in the heading, the prefix is redundant.
 */
function stripToolNamePrefix(detail: string): string {
  // Match "ToolName: rest" where ToolName is a single PascalCase/camelCase word
  const match = /^[A-Za-z][A-Za-z0-9_-]*:\s+/.exec(detail);
  if (!match) return detail;
  const rest = detail.slice(match[0].length).trim();
  // Only strip if there's meaningful content after the prefix
  return rest.length > 0 ? rest : detail;
}

function normalizeCommandValue(value: unknown): string | null {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== null);
  return parts.length > 0 ? parts.join(" ") : null;
}

function extractToolCommand(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const itemInput = asRecord(item?.input);
  const dataInput = asRecord(data?.input);
  const candidates = [
    normalizeCommandValue(item?.command),
    normalizeCommandValue(itemInput?.command),
    normalizeCommandValue(dataInput?.command),
    normalizeCommandValue(itemResult?.command),
    normalizeCommandValue(data?.command),
  ];
  return candidates.find((candidate) => candidate !== null) ?? null;
}

function normalizeCommandOutputValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\r\n/g, "\n");
  if (normalized.trim().length === 0) {
    return null;
  }
  return stripTrailingExitCodePreservingOutput(normalized).output;
}

function joinCommandOutputParts(stdout: string | null, stderr: string | null): string | null {
  if (!stdout && !stderr) {
    return null;
  }
  if (!stdout) {
    return stderr;
  }
  if (!stderr) {
    return stdout;
  }
  if (stdout.endsWith("\n") || stderr.startsWith("\n")) {
    return `${stdout}${stderr}`;
  }
  return `${stdout}\n${stderr}`;
}

function extractToolTitle(payload: Record<string, unknown> | null): string | null {
  return asTrimmedString(payload?.title);
}

function extractToolCallId(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const candidates = [
    asTrimmedString(payload?.toolCallId),
    asTrimmedString(payload?.itemId),
    asTrimmedString(data?.toolUseId),
    asTrimmedString(data?.itemId),
    asTrimmedString(item?.id),
    asTrimmedString(item?.itemId),
    asTrimmedString(itemResult?.tool_use_id),
    asTrimmedString(itemResult?.toolUseId),
  ];
  return candidates.find((candidate) => candidate !== null) ?? null;
}

function stripTrailingExitCode(value: string): {
  output: string | null;
  exitCode?: number | undefined;
} {
  const trimmed = value.trim();
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code (?<code>\d+)>)\s*$/i.exec(
    trimmed,
  );
  if (!match?.groups) {
    return {
      output: trimmed.length > 0 ? trimmed : null,
    };
  }
  const exitCode = Number.parseInt(match.groups.code ?? "", 10);
  const normalizedOutput = match.groups.output?.trim() ?? "";
  return {
    output: normalizedOutput.length > 0 ? normalizedOutput : null,
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
  };
}

function stripTrailingExitCodePreservingOutput(value: string): {
  output: string | null;
  exitCode?: number | undefined;
} {
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code (?<code>\d+)>)\s*$/i.exec(value);
  if (!match?.groups) {
    return {
      output: value,
    };
  }
  const exitCode = Number.parseInt(match.groups.code ?? "", 10);
  return {
    output: match.groups.output ?? "",
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
  };
}

function extractWorkLogItemType(
  payload: Record<string, unknown> | null,
): WorkLogEntry["itemType"] | undefined {
  if (typeof payload?.itemType === "string" && isToolLifecycleItemType(payload.itemType)) {
    return payload.itemType;
  }
  return undefined;
}

function extractWorkLogRequestKind(
  payload: Record<string, unknown> | null,
): WorkLogEntry["requestKind"] | undefined {
  if (
    payload?.requestKind === "command" ||
    payload?.requestKind === "file-read" ||
    payload?.requestKind === "file-change"
  ) {
    return payload.requestKind;
  }
  return requestKindFromRequestType(payload?.requestType) ?? undefined;
}

function normalizeWorkItemStatus(value: unknown): WorkLogEntry["itemStatus"] | undefined {
  switch (value) {
    case "pending":
    case "running":
    case "in_progress":
    case "inProgress":
      return "inProgress";
    case "completed":
    case "shutdown":
      return "completed";
    case "failed":
    case "error":
    case "errored":
    case "interrupted":
    case "notFound":
      return "failed";
    case "declined":
    case "rejected":
      return "declined";
    default:
      return undefined;
  }
}

function deriveActivityItemStatus(
  activity: OrchestrationThreadActivity,
): WorkLogEntry["itemStatus"] | undefined {
  switch (activity.kind) {
    case "tool.started":
    case "tool.updated":
    case "task.progress":
    case "task.started":
      return "inProgress";
    case "tool.completed":
    case "task.completed":
      return activity.tone === "error" ? "failed" : "completed";
    default:
      return undefined;
  }
}

function extractChildThreadAttribution(
  payload: Record<string, unknown> | null,
): WorkLogEntry["childThreadAttribution"] {
  if (!payload) return undefined;
  const attr = payload.childThreadAttribution;
  if (!attr || typeof attr !== "object") return undefined;
  const record = attr as Record<string, unknown>;
  const taskId = typeof record.taskId === "string" ? record.taskId : undefined;
  const childProviderThreadId =
    typeof record.childProviderThreadId === "string" ? record.childProviderThreadId : undefined;
  if (!taskId || !childProviderThreadId) return undefined;
  const label = typeof record.label === "string" ? record.label : undefined;
  const agentType =
    typeof record.agentType === "string" && record.agentType.length > 0
      ? record.agentType
      : undefined;
  const agentModel =
    typeof record.agentModel === "string" && record.agentModel.length > 0
      ? record.agentModel
      : undefined;
  return { taskId, childProviderThreadId, label, agentType, agentModel };
}

function normalizeStatValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function toTurnDiffFileChange(
  file: OrchestrationToolInlineDiff["files"][number],
): TurnDiffFileChange | undefined {
  const path = asTrimmedString(file.path);
  if (!path) {
    return undefined;
  }
  const kind = asTrimmedString(file.kind);
  const additions = normalizeStatValue(file.additions);
  const deletions = normalizeStatValue(file.deletions);
  return {
    path,
    ...(kind ? { kind } : {}),
    ...(additions !== undefined ? { additions } : {}),
    ...(deletions !== undefined ? { deletions } : {}),
  };
}

function extractPersistedToolInlineDiffSummary(input: {
  activityId: string;
  turnId?: TurnId | undefined;
  toolCallId?: string | undefined;
  payload: Record<string, unknown> | null;
  title: string;
}): ToolInlineDiffSummary | undefined {
  const inlineDiff = asRecord(input.payload?.inlineDiff);
  if (!inlineDiff || !Array.isArray(inlineDiff.files)) {
    return undefined;
  }

  const availability =
    inlineDiff.availability === "exact_patch" || inlineDiff.availability === "summary_only"
      ? inlineDiff.availability
      : null;
  if (!availability) {
    return undefined;
  }

  const files = inlineDiff.files
    .map((file) => toTurnDiffFileChange(file as OrchestrationToolInlineDiff["files"][number]))
    .filter((file): file is TurnDiffFileChange => file !== undefined);
  if (files.length === 0) {
    return undefined;
  }

  const fileStats = summarizeToolInlineDiffFiles(files);
  const additions = normalizeStatValue(inlineDiff.additions) ?? fileStats.additions;
  const deletions = normalizeStatValue(inlineDiff.deletions) ?? fileStats.deletions;
  return {
    id: input.activityId,
    activityId: input.activityId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    title: input.title,
    files,
    availability,
    ...(typeof inlineDiff.unifiedDiff === "string" && inlineDiff.unifiedDiff.trim().length > 0
      ? { unifiedDiff: inlineDiff.unifiedDiff }
      : {}),
    ...(additions !== undefined ? { additions } : {}),
    ...(deletions !== undefined ? { deletions } : {}),
  };
}

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  const lifecycleRankComparison =
    compareActivityLifecycleRank(left.kind) - compareActivityLifecycleRank(right.kind);
  if (lifecycleRankComparison !== 0) {
    return lifecycleRankComparison;
  }

  return left.id.localeCompare(right.id);
}

function compareActivityLifecycleRank(kind: string): number {
  if (kind.endsWith(".started") || kind === "tool.started") {
    return 0;
  }
  if (kind.endsWith(".progress") || kind.endsWith(".updated")) {
    return 1;
  }
  if (kind.endsWith(".completed") || kind.endsWith(".resolved")) {
    return 2;
  }
  return 1;
}

export function hasToolActivityForTurn(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
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
  const messageRows: TimelineEntry[] = messages.map((message) => ({
    id: message.id,
    kind: "message",
    createdAt: message.createdAt,
    message,
  }));
  const proposedPlanRows: TimelineEntry[] = proposedPlans.map((proposedPlan) => ({
    id: proposedPlan.id,
    kind: "proposed-plan",
    createdAt: proposedPlan.createdAt,
    proposedPlan,
  }));
  const workRows: TimelineEntry[] = workEntries.map((entry) => ({
    id: entry.id,
    kind: "work",
    createdAt: entry.createdAt,
    entry,
  }));
  return [...messageRows, ...proposedPlanRows, ...workRows].toSorted((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
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

export function inferCheckpointTurnCountByTurnId(
  summaries: TurnDiffSummary[],
): Record<TurnId, number> {
  const sorted = [...summaries].toSorted((a, b) => a.completedAt.localeCompare(b.completedAt));
  const result: Record<TurnId, number> = {};
  for (let index = 0; index < sorted.length; index += 1) {
    const summary = sorted[index];
    if (!summary) continue;
    result[summary.turnId] = index + 1;
  }
  return result;
}

export function derivePhase(session: ThreadSession | null): SessionPhase {
  if (!session || session.status === "closed") return "disconnected";
  if (session.status === "connecting") return "connecting";
  if (session.status === "running") return "running";
  return "ready";
}

export function deriveBackgroundTrayState(
  workEntries: ReadonlyArray<WorkLogEntry>,
  nowIso: string,
): BackgroundTrayState {
  const { standalone, subagentGroups } = groupSubagentEntries(workEntries);
  const visibleSubagentGroups = subagentGroups.filter((group) =>
    isSubagentGroupVisibleInTray(group, nowIso),
  );
  const visibleCommandEntries = deriveVisibleBackgroundCommandEntries(standalone, nowIso);

  return {
    subagentGroups: visibleSubagentGroups,
    commandEntries: visibleCommandEntries,
    hiddenSubagentGroupIds: visibleSubagentGroups.map((group) => group.groupId),
    hiddenWorkEntryIds: visibleCommandEntries.map((entry) => entry.id),
    hasRunningTasks:
      visibleSubagentGroups.some((group) => group.status === "running") ||
      visibleCommandEntries.some((entry) => deriveBackgroundCommandStatus(entry) === "running"),
    defaultCollapsed: visibleSubagentGroups.length + visibleCommandEntries.length >= 5,
  };
}

export function filterTrayOwnedWorkEntries(
  workEntries: ReadonlyArray<WorkLogEntry>,
  backgroundTrayState: BackgroundTrayState,
): WorkLogEntry[] {
  const hiddenSubagentGroupIds = new Set(backgroundTrayState.hiddenSubagentGroupIds);
  const hiddenWorkEntryIds = new Set(backgroundTrayState.hiddenWorkEntryIds);

  return workEntries.filter((entry) => {
    if (hiddenWorkEntryIds.has(entry.id)) {
      return false;
    }
    const groupId = entry.childThreadAttribution?.childProviderThreadId;
    if (groupId && hiddenSubagentGroupIds.has(groupId)) {
      return false;
    }
    return true;
  });
}

function isSubagentGroupVisibleInTray(group: SubagentGroup, nowIso: string): boolean {
  if (group.status === "running") {
    return true;
  }
  return isWithinBackgroundTaskRetention(group.completedAt ?? group.startedAt, nowIso);
}

function isBackgroundCommandVisibleInTray(entry: WorkLogEntry, nowIso: string): boolean {
  if (entry.itemType !== "command_execution" || !entry.isBackgroundCommand) {
    return false;
  }
  const status = deriveBackgroundCommandStatus(entry);
  if (status === "running") {
    return true;
  }
  return isWithinBackgroundTaskRetention(entry.createdAt, nowIso);
}

function deriveVisibleBackgroundCommandEntries(
  standaloneEntries: ReadonlyArray<WorkLogEntry>,
  nowIso: string,
): WorkLogEntry[] {
  return standaloneEntries.filter((entry) => isBackgroundCommandVisibleInTray(entry, nowIso));
}

function isUnifiedExecCommandSource(value: string | undefined): boolean {
  return value === "unifiedExecStartup" || value === "unifiedExecInteraction";
}

export function deriveBackgroundCommandStatus(
  entry: WorkLogEntry,
): "running" | "completed" | "failed" {
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

function isWithinBackgroundTaskRetention(timestampIso: string, nowIso: string): boolean {
  const timestampMs = Date.parse(timestampIso);
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(timestampMs) || Number.isNaN(nowMs)) {
    return false;
  }
  return nowMs - timestampMs <= BACKGROUND_TASK_RETENTION_MS;
}
