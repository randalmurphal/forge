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

import { debugLog, isWebDebugEnabled } from "./debug";
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

const DEBUG_BACKGROUND_TASKS = isWebDebugEnabled("background");

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
  completedAt?: string | undefined;
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
  backgroundTaskId?: string | undefined;
  backgroundTaskStatus?: "running" | "completed" | "failed" | undefined;
  backgroundCompletedAt?: string | undefined;
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
  receiverThreadIds?: string[] | undefined;
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
    }
  | {
      id: string;
      kind: "subagent-section";
      createdAt: string;
      subagentGroups: SubagentGroup[];
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

interface DeriveWorkLogEntriesOptions {
  scope: WorkLogScope;
  latestTurnId?: TurnId | undefined;
  messages?: ReadonlyArray<ChatMessage> | undefined;
  latestTurn?: LatestTurnTiming | null | undefined;
}

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
  const entries = ordered
    .filter((activity) => !shouldFilterToolStartedActivity(activity))
    .filter((activity) => activity.kind !== "tool.output.delta")
    .filter((activity) => activity.kind !== "tool.terminal.interaction")
    .filter((activity) => !isUnattributedCollabAgentToolEnvelope(activity))
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
    messages,
    latestTurn,
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

function synthesizeCodexSubagentLifecycleActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationThreadActivity[] {
  const startsByChildKey = new Set<string>();
  const completionsByChildKey = new Set<string>();
  const knownChildThreadIds = new Set<string>();
  for (const activity of activities) {
    const payload = asRecord(activity.payload);
    const childAttr = asRecord(payload?.childThreadAttribution);
    const childProviderThreadId = asTrimmedString(childAttr?.childProviderThreadId);
    if (childProviderThreadId) {
      knownChildThreadIds.add(childProviderThreadId);
    }

    if (activity.kind === "task.started") {
      const taskId = asTrimmedString(childAttr?.taskId);
      if (taskId && childProviderThreadId) {
        startsByChildKey.add(`${taskId}\u001f${childProviderThreadId}`);
      }
      continue;
    }

    if (activity.kind !== "task.completed") {
      continue;
    }
    const taskId = asTrimmedString(childAttr?.taskId);
    if (taskId && childProviderThreadId) {
      completionsByChildKey.add(`${taskId}\u001f${childProviderThreadId}`);
    }
  }

  const syntheticActivities: OrchestrationThreadActivity[] = [];
  for (const activity of activities) {
    if (
      activity.kind !== "tool.started" &&
      activity.kind !== "tool.updated" &&
      activity.kind !== "tool.completed"
    ) {
      continue;
    }
    const payload = asRecord(activity.payload);
    if (payload?.itemType !== "collab_agent_tool_call" || payload.childThreadAttribution) {
      continue;
    }

    const data = asRecord(payload.data);
    const item = asRecord(data?.item);
    const toolName = asTrimmedString(item?.tool);
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

    for (const childProviderThreadId of receiverThreadIds) {
      const childKey = `${taskId}\u001f${childProviderThreadId}`;
      if (toolName === "spawnAgent" && !startsByChildKey.has(childKey)) {
        startsByChildKey.add(childKey);
        syntheticActivities.push({
          id: EventId.makeUnsafe(
            `${activity.id}:synthetic-subagent-start:${childProviderThreadId}`,
          ),
          tone: "info",
          kind: "task.started",
          summary: "Task started",
          payload: {
            taskId,
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

      const completionKey = `${taskId}\u001f${childProviderThreadId}`;
      if (completionsByChildKey.has(completionKey)) {
        continue;
      }
      if (isCodexControlCollabTool(toolName) && !knownChildThreadIds.has(childProviderThreadId)) {
        continue;
      }

      const agentState = asRecord(agentsStates?.[childProviderThreadId]);
      // Codex marks the collab tool call itself as completed as soon as the channel operation
      // finishes. For spawn_agent that usually means "child thread created", not "child task
      // finished". The app-server tests explicitly assert that spawn_agent can be completed while
      // the child agent state is still pendingInit/running, so we only synthesize a subagent
      // completion from the per-child agentsStates entry once that child reaches a terminal state.
      const normalizedStatus = normalizeCodexCollabAgentTerminalStatus(
        asTrimmedString(agentState?.status),
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

function synthesizeClaudeTaskOutputLifecycleActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationThreadActivity[] {
  const realTerminalTaskIds = new Set<string>();
  const taskContextByTaskId = new Map<
    string,
    {
      toolUseId?: string | undefined;
      childThreadAttribution?: Record<string, unknown> | undefined;
    }
  >();

  for (const activity of activities) {
    const payload = asRecord(activity.payload);
    if (!payload) {
      continue;
    }

    if (
      activity.kind === "task.started" ||
      activity.kind === "task.progress" ||
      activity.kind === "task.completed"
    ) {
      const taskId = asTrimmedString(payload.taskId);
      if (!taskId) {
        continue;
      }

      const existingContext = taskContextByTaskId.get(taskId) ?? {};
      const nextContext = {
        toolUseId: asTrimmedString(payload.toolUseId) ?? existingContext.toolUseId,
        childThreadAttribution:
          asRecord(payload.childThreadAttribution) ?? existingContext.childThreadAttribution,
      };
      taskContextByTaskId.set(taskId, nextContext);

      if (activity.kind === "task.completed") {
        realTerminalTaskIds.add(taskId);
      }
      continue;
    }
  }

  const syntheticActivities: OrchestrationThreadActivity[] = [];
  for (const activity of activities) {
    if (activity.kind !== "tool.completed") {
      continue;
    }

    const resolvedTask = extractClaudeTaskOutputResolvedTask(activity);
    if (!resolvedTask) {
      continue;
    }
    if (realTerminalTaskIds.has(resolvedTask.taskId)) {
      continue;
    }

    const normalizedStatus = normalizeClaudeTaskOutputTaskStatus(resolvedTask.status);
    if (normalizedStatus === "running") {
      continue;
    }

    realTerminalTaskIds.add(resolvedTask.taskId);
    const taskContext = taskContextByTaskId.get(resolvedTask.taskId);
    syntheticActivities.push({
      id: EventId.makeUnsafe(`${activity.id}:synthetic-taskoutput-complete:${resolvedTask.taskId}`),
      tone: normalizedStatus === "failed" ? "error" : "info",
      kind: "task.completed",
      summary: normalizedStatus === "failed" ? "Task failed" : "Task completed",
      payload: {
        taskId: resolvedTask.taskId,
        status: normalizedStatus === "failed" ? "failed" : "completed",
        ...(taskContext?.toolUseId ? { toolUseId: taskContext.toolUseId } : {}),
        ...(resolvedTask.description ? { detail: resolvedTask.description } : {}),
        ...(taskContext?.childThreadAttribution
          ? { childThreadAttribution: taskContext.childThreadAttribution }
          : {}),
      },
      turnId: activity.turnId,
      createdAt: activity.createdAt,
    });
  }

  return syntheticActivities;
}

function extractClaudeTaskOutputResolvedTask(activity: OrchestrationThreadActivity): {
  taskId: string;
  status: string;
  description?: string | undefined;
} | null {
  const payload = asRecord(activity.payload);
  if (!payload) {
    return null;
  }

  const toolName =
    asTrimmedString(payload.toolName) ??
    asTrimmedString(asRecord(payload.data)?.toolName) ??
    asTrimmedString(asRecord(asRecord(payload.data)?.item)?.tool);
  if (toolName !== "TaskOutput") {
    return null;
  }

  const data = asRecord(payload.data);
  const toolUseResult = asRecord(data?.toolUseResult);
  const resolvedTask = asRecord(toolUseResult?.task);
  if (!resolvedTask) {
    return null;
  }

  const taskId = asTrimmedString(resolvedTask.task_id) ?? asTrimmedString(resolvedTask.taskId);
  const status = asTrimmedString(resolvedTask.status);
  if (!taskId || !status) {
    return null;
  }

  return {
    taskId,
    status,
    ...(asTrimmedString(resolvedTask.description)
      ? { description: asTrimmedString(resolvedTask.description) ?? undefined }
      : {}),
  };
}

function normalizeClaudeTaskOutputTaskStatus(status: string): "running" | "completed" | "failed" {
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
  input: {
    activities: ReadonlyArray<OrchestrationThreadActivity>;
    messages?: ReadonlyArray<ChatMessage> | undefined;
    latestTurn?: LatestTurnTiming | null | undefined;
  },
): DerivedWorkLogEntry[] {
  const codexBackgroundSignals = deriveCodexBackgroundCommandSignals({
    activities: input.activities,
    messages: input.messages,
    latestTurn: input.latestTurn ?? null,
  });
  const providerBackgroundTaskSignals = deriveProviderBackgroundTaskSignals(input.activities);

  const nextEntries = entries.map((entry) => {
    if (entry.itemType !== "command_execution") {
      return entry;
    }
    const toolCallId = entry.toolCallId ?? null;
    const providerTaskSignal = findProviderBackgroundTaskSignal(
      entry,
      providerBackgroundTaskSignals,
    );
    const isBackgroundCommand =
      entry.isBackgroundCommand === true ||
      (toolCallId !== null && codexBackgroundSignals.backgroundedToolCallIds.has(toolCallId));
    if (!isBackgroundCommand) {
      return entry;
    }
    const backgroundTaskStatus =
      // Claude background Bash returns a completed tool call immediately and continues under a
      // separate task id. Treat the presence of that task id as "still running" until task.*
      // events tell us otherwise, so the row stays tray-owned instead of flashing inline.
      providerTaskSignal?.status ?? (entry.backgroundTaskId ? "running" : undefined);
    const backgroundTaskId = entry.backgroundTaskId ?? providerTaskSignal?.taskId;
    const backgroundCompletedAt = providerTaskSignal?.completedAt;
    return {
      ...entry,
      isBackgroundCommand: true,
      ...(backgroundTaskId ? { backgroundTaskId } : {}),
      ...(backgroundTaskStatus ? { backgroundTaskStatus } : {}),
      ...(backgroundCompletedAt
        ? { backgroundCompletedAt, completedAt: backgroundCompletedAt }
        : backgroundTaskStatus === "running"
          ? { completedAt: undefined }
          : {}),
    };
  });

  const ownedBackgroundToolCallIds = new Set(
    nextEntries
      .filter(
        (entry): entry is DerivedWorkLogEntry & { toolCallId: string } =>
          entry.itemType === "command_execution" &&
          entry.isBackgroundCommand === true &&
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
          codexBackgroundSignals.reasonsByToolCallId,
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

function appendBackgroundCommandCompletionEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const completionEntries: DerivedWorkLogEntry[] = [];

  for (const entry of entries) {
    if (entry.itemType !== "command_execution" || entry.isBackgroundCommand !== true) {
      continue;
    }
    if (entry.activityKind === "task.completed") {
      continue;
    }

    const status = deriveBackgroundCommandStatus(entry);
    if (status === "running" || !entry.backgroundCompletedAt) {
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
      startedAt: entry.startedAt ?? entry.createdAt,
      completedAt: entry.backgroundCompletedAt,
      label: status === "failed" ? "Background command failed" : "Background command completed",
      tone: status === "failed" ? "error" : "tool",
      activityKind: "task.completed",
      itemStatus: status === "failed" ? "failed" : "completed",
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

interface ProviderBackgroundTaskSignal {
  taskId?: string | undefined;
  toolUseId?: string | undefined;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string | undefined;
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
      ...(status !== "running" ? { completedAt: activity.createdAt } : {}),
    };

    if (existing?.startedAt) {
      signal.startedAt =
        earliestIsoValue(existing.startedAt, activity.createdAt) ?? activity.createdAt;
    }
    if (existing?.completedAt && status === "running") {
      signal.completedAt = existing.completedAt;
    }
    if (existing?.completedAt && status !== "running") {
      signal.completedAt = latestIsoValue(existing.completedAt, activity.createdAt);
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
  payload: Record<string, unknown> | null,
): "running" | "completed" | "failed" {
  if (activityKind !== "task.completed") {
    return "running";
  }
  const status = asTrimmedString(payload?.status);
  return status === "failed" || status === "stopped" ? "failed" : "completed";
}

interface CodexBackgroundCommandCandidate {
  toolCallId: string;
  turnId?: TurnId | undefined;
  processId?: string | undefined;
  startedAt: string;
  completedAt?: string | undefined;
  backgrounded: boolean;
}

function deriveCodexBackgroundCommandSignals(input: {
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
    const toolCallId =
      itemType === "command_execution" ? (extractToolCallId(payload) ?? undefined) : undefined;
    const processId =
      itemType === "command_execution"
        ? (extractCommandProcessId(payload) ?? undefined)
        : undefined;
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
  turnId: TurnId | undefined,
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
  payload: Record<string, unknown> | null,
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

function extractCommandSource(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  return asTrimmedString(item?.source) ?? asTrimmedString(payload?.source);
}

function extractCommandProcessId(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  return asTrimmedString(item?.processId) ?? asTrimmedString(payload?.processId);
}

function shouldFilterToolStartedActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.started") {
    return false;
  }
  const payload = asRecord(activity.payload);
  if (payload?.itemType === "collab_agent_tool_call") {
    return !isVisibleCollabControlTool(extractCollabControlToolName(payload));
  }
  return payload?.itemType !== "command_execution";
}

export interface SubagentGroup {
  groupId: string;
  taskId: string;
  childProviderThreadId: string;
  label: string;
  entries: WorkLogEntry[];
  recordedActionCount: number;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string | undefined;
  agentDescription?: string | undefined;
  agentPrompt?: string | undefined;
  agentType?: string | undefined;
  agentModel?: string | undefined;
}

function isGenericSubagentLabel(label: string | undefined): boolean {
  if (!label) {
    return false;
  }
  return label === "Subagent" || label.startsWith("Subagent ");
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
  if (payload?.itemType !== "collab_agent_tool_call" || payload.childThreadAttribution) {
    return false;
  }
  // Most unattributed collab envelopes are parent-thread bookkeeping noise and should stay out of
  // the timeline. Keep the user-visible control calls (spawn/wait/sendInput/etc.) inline so the
  // history reflects that those tools were actually invoked.
  return !isVisibleCollabControlTool(extractCollabControlToolName(payload));
}

function isCodexControlCollabTool(toolName: string | null): boolean {
  return toolName === "sendInput" || toolName === "wait";
}

function extractCollabControlToolName(payload: Record<string, unknown> | null): string | null {
  if (!payload) {
    return null;
  }

  const payloadToolName = asTrimmedString(payload.toolName);
  if (payloadToolName) {
    return payloadToolName;
  }

  const data = asRecord(payload.data);
  const dataToolName = asTrimmedString(data?.toolName);
  if (dataToolName) {
    return dataToolName;
  }

  const item = asRecord(data?.item);
  return asTrimmedString(item?.tool);
}

function isVisibleCollabControlTool(toolName: string | null): boolean {
  if (!toolName) {
    return false;
  }

  // These are the parent-thread collab control calls we want reflected inline in history.
  // Claude uses `Agent`; Codex uses `spawnAgent` / `wait` / `sendInput` / close-resume controls.
  const normalized = toolName.toLowerCase();
  return (
    normalized === "agent" ||
    normalized === "spawnagent" ||
    normalized === "wait" ||
    normalized === "sendinput" ||
    normalized === "closeagent" ||
    normalized === "resumeagent"
  );
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
      agentDescription?: string | undefined;
      agentPrompt?: string | undefined;
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
        agentDescription: undefined,
        agentPrompt: undefined,
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
      if (!group.agentPrompt && entry.detail) {
        group.agentPrompt = entry.detail;
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
    if (!group.agentDescription && entry.agentDescription) {
      group.agentDescription = entry.agentDescription;
    }
    if (!group.agentPrompt && entry.agentPrompt) {
      group.agentPrompt = entry.agentPrompt;
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
      // Provider task ids like `call_xxx` are implementation noise. Keep a generic fallback here
      // and let control-call metadata replace it when we have real description/prompt context.
      label: group.label ?? "Subagent",
      entries: group.entries,
      recordedActionCount: group.entries.length,
      status: group.status,
      startedAt: group.startedAt,
      completedAt: group.completedAt,
      agentDescription: group.agentDescription,
      agentPrompt: group.agentPrompt,
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
  backgroundTaskId?: string;
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
  receiverThreadIds?: string[];
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
  const claudeToolUseResult = asRecord(data.toolUseResult);

  // Codex shape: { item: { type, command, output, exitCode, durationMs, ... }, ... }
  const codexItem = asRecord(data.item);
  const codexResult = asRecord(codexItem?.result);
  const codexInput = asRecord(codexItem?.input);
  const codexToolName = asTrimmedString(codexItem?.tool);

  if (codexToolName && !enrichments.toolName) {
    enrichments.toolName = codexToolName;
  }

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
    data.run_in_background === true ||
    typeof claudeToolUseResult?.backgroundTaskId === "string" ||
    claudeToolUseResult?.backgroundedByUser === true ||
    claudeToolUseResult?.assistantAutoBackgrounded === true
  ) {
    enrichments.isBackgroundCommand = true;
  }

  const backgroundTaskId = asTrimmedString(claudeToolUseResult?.backgroundTaskId);
  if (backgroundTaskId) {
    enrichments.backgroundTaskId = backgroundTaskId;
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
  const agentModel = asTrimmedString(claudeInput?.model) ?? asTrimmedString(codexItem?.model);
  if (agentModel) {
    enrichments.agentModel = agentModel;
  }
  const agentPrompt = asTrimmedString(claudeInput?.prompt) ?? asTrimmedString(codexItem?.prompt);
  if (agentPrompt) {
    enrichments.agentPrompt = agentPrompt;
  }
  const receiverThreadIds =
    asArray(codexItem?.receiverThreadIds)
      ?.map((value) => asTrimmedString(value))
      .filter((value): value is string => value !== null) ?? [];
  if (receiverThreadIds.length > 0) {
    enrichments.receiverThreadIds = receiverThreadIds;
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
    ...(activity.kind === "tool.completed" || activity.kind === "task.completed"
      ? { completedAt: activity.createdAt }
      : {}),
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
  if (enrichments.backgroundTaskId) entry.backgroundTaskId = enrichments.backgroundTaskId;
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
  if (enrichments.receiverThreadIds) entry.receiverThreadIds = enrichments.receiverThreadIds;

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
  const completedAt = latestIsoValue(previous.completedAt, next.completedAt);
  const itemStatus = next.itemStatus ?? previous.itemStatus;
  const isBackgroundCommand = Boolean(previous.isBackgroundCommand || next.isBackgroundCommand);
  const backgroundTaskId = next.backgroundTaskId ?? previous.backgroundTaskId;
  const backgroundTaskStatus = next.backgroundTaskStatus ?? previous.backgroundTaskStatus;
  const backgroundCompletedAt = latestIsoValue(
    previous.backgroundCompletedAt,
    next.backgroundCompletedAt,
  );
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
    ...(backgroundTaskId ? { backgroundTaskId } : {}),
    ...(backgroundTaskStatus ? { backgroundTaskStatus } : {}),
    ...(backgroundCompletedAt ? { backgroundCompletedAt } : {}),
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

function earliestIsoValue(
  previous: string | undefined,
  next: string | undefined,
): string | undefined {
  if (!previous) return next;
  if (!next) return previous;
  return previous <= next ? previous : next;
}

function latestIsoValue(
  previous: string | undefined,
  next: string | undefined,
): string | undefined {
  if (!previous) return next;
  if (!next) return previous;
  return previous >= next ? previous : next;
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
  if (
    entry.activityKind === "tool.started" &&
    entry.itemType !== "command_execution" &&
    !isVisibleCollabControlWorkEntry(entry)
  ) {
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

function isVisibleCollabControlWorkEntry(
  entry: Pick<DerivedWorkLogEntry, "itemType" | "toolName">,
): boolean {
  // Claude emits user-visible Agent launch rows through the same lifecycle collapse path as Codex
  // spawn/wait controls. If we only whitelist Codex names here, the empty start payload and richer
  // completion payload split into duplicate inline rows instead of one collapsed control entry.
  return (
    entry.itemType === "collab_agent_tool_call" &&
    isVisibleCollabControlTool(entry.toolName ?? null)
  );
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

function shouldInsertBackgroundCompletionBefore(
  left: DerivedWorkLogEntry,
  right: DerivedWorkLogEntry,
): boolean {
  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison < 0;
  }

  const lifecycleRankComparison =
    compareActivityLifecycleRank(left.activityKind) -
    compareActivityLifecycleRank(right.activityKind);
  if (lifecycleRankComparison !== 0) {
    return lifecycleRankComparison < 0;
  }

  return left.id.localeCompare(right.id) < 0;
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
  const { standalone, subagentGroups } = groupSubagentEntries(workEntries);
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
  const workRows: TimelineEntry[] = standalone.map((entry) => ({
    id: entry.id,
    kind: "work",
    createdAt: entry.createdAt,
    entry,
  }));
  const subagentSectionRows: TimelineEntry[] = enrichSubagentGroupsWithControlMetadata(
    subagentGroups,
    standalone,
  )
    .filter((group) => group.status !== "running" && group.completedAt)
    .map((group) => ({
      id: `subagent-section:${group.groupId}:${group.completedAt}`,
      kind: "subagent-section" as const,
      // Completed subagents belong in history when the child task actually finishes, not when the
      // earliest nested child activity started. Using completedAt here keeps history append-stable
      // instead of backfilling old rows once the tray TTL expires.
      createdAt: group.completedAt!,
      subagentGroups: [retainCompletedSubagentEntryTail(group)],
    }));
  return [...messageRows, ...proposedPlanRows, ...workRows, ...subagentSectionRows].toSorted(
    (a, b) => a.createdAt.localeCompare(b.createdAt),
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

export function filterTrayOwnedWorkEntries(
  workEntries: ReadonlyArray<WorkLogEntry>,
  backgroundTrayState: BackgroundTrayState,
): WorkLogEntry[] {
  void backgroundTrayState;
  return [...workEntries];
}

const COMPLETED_SUBAGENT_FALLBACK_ENTRY_LIMIT = 20;

function retainCompletedSubagentEntryTail(group: SubagentGroup): SubagentGroup {
  // Keep a small local tail so completed history rows can still render some activity immediately
  // if the lazy RPC feed is slow or unavailable, without duplicating the entire child transcript
  // into every timeline projection.
  if (group.entries.length <= COMPLETED_SUBAGENT_FALLBACK_ENTRY_LIMIT) {
    return group;
  }

  return {
    ...group,
    entries: group.entries.slice(-COMPLETED_SUBAGENT_FALLBACK_ENTRY_LIMIT),
  };
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
  if (entry.activityKind === "task.completed") {
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

function deriveVisibleBackgroundCommandEntries(
  standaloneEntries: ReadonlyArray<WorkLogEntry>,
  nowIso: string,
): WorkLogEntry[] {
  return standaloneEntries.filter((entry) => isBackgroundCommandVisibleInTray(entry, nowIso));
}

export function enrichSubagentGroupsWithControlMetadata(
  subagentGroups: ReadonlyArray<SubagentGroup>,
  standaloneEntries: ReadonlyArray<WorkLogEntry>,
): SubagentGroup[] {
  const metadataByChildThreadId = collectChildThreadMetadata(standaloneEntries, subagentGroups);

  return subagentGroups.map((group) => {
    const metadata = metadataByChildThreadId.get(group.childProviderThreadId);
    if (!metadata) {
      return group;
    }
    const shouldReplacePlaceholderLabel = isGenericSubagentLabel(group.label);
    return {
      ...group,
      label: shouldReplacePlaceholderLabel && metadata.label ? metadata.label : group.label,
      agentDescription: group.agentDescription ?? metadata.description,
      agentPrompt: group.agentPrompt ?? metadata.prompt,
      agentType: group.agentType ?? metadata.agentType,
      agentModel: group.agentModel ?? metadata.agentModel,
    };
  });
}

function enrichVisibleCollabControlEntriesWithTargetMetadata(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const standaloneEntries = entries.filter((entry) => !entry.childThreadAttribution);
  const metadataByChildThreadId = collectChildThreadMetadata(standaloneEntries, []);

  return entries.map((entry) => {
    if (entry.itemType !== "collab_agent_tool_call") {
      return entry;
    }

    const [firstReceiverThreadId] = entry.receiverThreadIds ?? [];
    if (!firstReceiverThreadId) {
      return entry;
    }

    const metadata = metadataByChildThreadId.get(firstReceiverThreadId);
    if (!metadata) {
      return entry;
    }

    return {
      ...entry,
      agentDescription: entry.agentDescription ?? metadata.label,
      agentPrompt: entry.agentPrompt ?? metadata.prompt,
      agentType: entry.agentType ?? metadata.agentType,
      agentModel: entry.agentModel ?? metadata.agentModel,
    };
  });
}

function collectChildThreadMetadata(
  standaloneEntries: ReadonlyArray<
    Pick<
      WorkLogEntry,
      | "itemType"
      | "receiverThreadIds"
      | "agentDescription"
      | "agentPrompt"
      | "detail"
      | "agentType"
      | "agentModel"
    >
  >,
  subagentGroups: ReadonlyArray<
    Pick<
      SubagentGroup,
      | "childProviderThreadId"
      | "label"
      | "agentDescription"
      | "agentPrompt"
      | "agentType"
      | "agentModel"
    >
  >,
): Map<
  string,
  {
    label?: string;
    description?: string;
    prompt?: string;
    agentType?: string;
    agentModel?: string;
  }
> {
  const metadataByChildThreadId = new Map<
    string,
    {
      label?: string;
      description?: string;
      prompt?: string;
      agentType?: string;
      agentModel?: string;
    }
  >();

  for (const group of subagentGroups) {
    metadataByChildThreadId.set(group.childProviderThreadId, {
      ...(group.label ? { label: group.label } : {}),
      ...(group.agentDescription ? { description: group.agentDescription } : {}),
      ...(group.agentPrompt ? { prompt: group.agentPrompt } : {}),
      ...(group.agentType ? { agentType: group.agentType } : {}),
      ...(group.agentModel ? { agentModel: group.agentModel } : {}),
    });
  }

  for (const entry of standaloneEntries) {
    if (entry.itemType !== "collab_agent_tool_call") {
      continue;
    }

    for (const childThreadId of entry.receiverThreadIds ?? []) {
      const current = metadataByChildThreadId.get(childThreadId) ?? {};
      const description = current.description ?? entry.agentDescription;
      const prompt = current.prompt ?? entry.agentPrompt;
      const label = current.label ?? description ?? prompt ?? entry.detail;
      const agentType = current.agentType ?? entry.agentType;
      const agentModel = current.agentModel ?? entry.agentModel;
      metadataByChildThreadId.set(childThreadId, {
        ...(label ? { label } : {}),
        ...(description ? { description } : {}),
        ...(prompt ? { prompt } : {}),
        ...(agentType ? { agentType } : {}),
        ...(agentModel ? { agentModel } : {}),
      });
    }
  }

  return metadataByChildThreadId;
}

function compactSubagentGroups(subagentGroups: ReadonlyArray<SubagentGroup>): SubagentGroup[] {
  return subagentGroups.map((group) => ({
    ...group,
    entries: [],
  }));
}

function isUnifiedExecCommandSource(value: string | undefined): boolean {
  return value === "unifiedExecStartup" || value === "unifiedExecInteraction";
}

function summarizeBackgroundRelevantActivity(activity: OrchestrationThreadActivity): {
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

function summarizeBackgroundRelevantEntry(entry: DerivedWorkLogEntry): {
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

function summarizeBackgroundCommandClassification(
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

function summarizeBackgroundTrayCommandDecision(
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

export function deriveBackgroundCommandStatus(
  entry: WorkLogEntry,
): "running" | "completed" | "failed" {
  if (entry.backgroundTaskStatus) {
    return entry.backgroundTaskStatus;
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

function isWithinBackgroundTaskRetention(timestampIso: string, nowIso: string): boolean {
  const timestampMs = Date.parse(timestampIso);
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(timestampMs) || Number.isNaN(nowMs)) {
    return false;
  }
  return nowMs - timestampMs <= BACKGROUND_TASK_RETENTION_MS;
}
