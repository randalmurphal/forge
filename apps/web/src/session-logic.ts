import {
  ApprovalRequestId,
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
  turnId?: TurnId | undefined;
  toolCallId?: string | undefined;
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
  exitCode?: number | undefined;
  durationMs?: number | undefined;
  output?: string | undefined;
  mcpServer?: string | undefined;
  mcpTool?: string | undefined;
  searchPattern?: string | undefined;
  searchResultCount?: number | undefined;
  filePath?: string | undefined;
  activityKind?: string | undefined;
  childThreadAttribution?:
    | {
        taskId: string;
        label?: string | undefined;
        childProviderThreadId: string;
      }
    | undefined;
}

interface DerivedWorkLogEntry extends WorkLogEntry {
  activityKind: OrchestrationThreadActivity["kind"];
  collapseKey?: string;
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
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const entries = ordered
    .filter((activity) =>
      scope === "latest-turn" && latestTurnId ? activity.turnId === latestTurnId : true,
    )
    .filter((activity) => activity.kind !== "tool.started")
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
    .filter((activity) => activity.kind !== "context-window.updated")
    .filter((activity) => activity.summary !== "Checkpoint captured")
    .filter((activity) => !isPlanBoundaryToolActivity(activity))
    .map(toDerivedWorkLogEntry);
  return collapseDerivedWorkLogEntries(entries).map(
    ({ collapseKey: _collapseKey, ...entry }) => entry,
  );
}

export interface SubagentGroup {
  taskId: string;
  label: string;
  entries: WorkLogEntry[];
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string | undefined;
}

export function groupSubagentEntries(workEntries: ReadonlyArray<WorkLogEntry>): {
  standalone: WorkLogEntry[];
  subagentGroups: SubagentGroup[];
} {
  const standalone: WorkLogEntry[] = [];
  const groupsByTaskId = new Map<
    string,
    {
      entries: WorkLogEntry[];
      label: string | undefined;
      startedAt: string;
      completedAt?: string;
      status: SubagentGroup["status"];
    }
  >();

  for (const entry of workEntries) {
    const taskId = entry.childThreadAttribution?.taskId;
    if (!taskId) {
      standalone.push(entry);
      continue;
    }

    let group = groupsByTaskId.get(taskId);
    if (!group) {
      group = {
        entries: [],
        label: entry.childThreadAttribution?.label ?? undefined,
        startedAt: entry.createdAt,
        status: "running",
      };
      groupsByTaskId.set(taskId, group);
    }

    // Update group metadata from task lifecycle entries
    if (entry.activityKind === "task.started") {
      group.startedAt = entry.createdAt;
      if (!group.label && entry.detail) {
        group.label = entry.detail;
      }
    } else if (entry.activityKind === "task.completed") {
      group.completedAt = entry.createdAt;
      group.status = entry.tone === "error" ? "failed" : "completed";
    } else {
      // Regular work entry for this subagent
      group.entries.push(entry);
    }

    // Update label from attribution if available
    if (entry.childThreadAttribution?.label && !group.label) {
      group.label = entry.childThreadAttribution.label;
    }
  }

  const subagentGroups: SubagentGroup[] = [];
  for (const [taskId, group] of groupsByTaskId) {
    subagentGroups.push({
      taskId,
      label: group.label ?? `Subagent ${taskId.slice(0, 8)}`,
      entries: group.entries,
      status: group.status,
      startedAt: group.startedAt,
      completedAt: group.completedAt,
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
  mcpServer?: string;
  mcpTool?: string;
  searchPattern?: string;
  searchResultCount?: number;
  filePath?: string;
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

  // Output (truncated for display)
  const outputCandidates = [
    codexItem?.aggregatedOutput,
    claudeResult?.stdout,
    claudeResult?.output,
    codexResult?.output,
  ];
  for (const candidate of outputCandidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      const trimmed = candidate.trim();
      enrichments.output = trimmed.length > 500 ? `${trimmed.slice(0, 497)}...` : trimmed;
      break;
    }
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
  const entry: DerivedWorkLogEntry = {
    id: activity.id,
    createdAt: activity.createdAt,
    ...(activity.turnId ? { turnId: activity.turnId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    label: activity.summary,
    tone: activity.tone === "approval" ? "info" : activity.tone,
    activityKind: activity.kind,
  };
  const itemType = extractWorkLogItemType(payload);
  const requestKind = extractWorkLogRequestKind(payload);
  if (payload && typeof payload.detail === "string" && payload.detail.length > 0) {
    const detail = stripTrailingExitCode(payload.detail).output;
    if (detail) {
      entry.detail = stripToolNamePrefix(detail);
    }
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
    itemType === "file_change"
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
  if (enrichments.toolName) entry.toolName = enrichments.toolName;
  if (enrichments.exitCode !== undefined) entry.exitCode = enrichments.exitCode;
  if (enrichments.durationMs !== undefined) entry.durationMs = enrichments.durationMs;
  if (enrichments.output) entry.output = enrichments.output;
  if (enrichments.mcpServer) entry.mcpServer = enrichments.mcpServer;
  if (enrichments.mcpTool) entry.mcpTool = enrichments.mcpTool;
  if (enrichments.searchPattern) entry.searchPattern = enrichments.searchPattern;
  if (enrichments.searchResultCount !== undefined)
    entry.searchResultCount = enrichments.searchResultCount;
  if (enrichments.filePath) entry.filePath = enrichments.filePath;

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
  for (const entry of entries) {
    const previous = collapsed.at(-1);
    if (previous && shouldCollapseToolLifecycleEntries(previous, entry)) {
      collapsed[collapsed.length - 1] = mergeDerivedWorkLogEntries(previous, entry);
      continue;
    }
    collapsed.push(entry);
  }
  return collapsed;
}

function shouldCollapseToolLifecycleEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean {
  if (previous.activityKind !== "tool.updated" && previous.activityKind !== "tool.completed") {
    return false;
  }
  if (next.activityKind !== "tool.updated" && next.activityKind !== "tool.completed") {
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
  if (entry.activityKind !== "tool.updated" && entry.activityKind !== "tool.completed") {
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
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
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
  const candidates = [
    normalizeCommandValue(item?.command),
    normalizeCommandValue(itemInput?.command),
    normalizeCommandValue(itemResult?.command),
    normalizeCommandValue(data?.command),
  ];
  return candidates.find((candidate) => candidate !== null) ?? null;
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
  return { taskId, childProviderThreadId, label };
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
