import type {
  ApprovalRequestId,
  OrchestrationLatestTurn,
  OrchestrationProposedPlanId,
  OrchestrationThreadActivity,
  ProviderKind,
  MessageId,
  ToolLifecycleItemType,
  UserInputQuestion,
  ThreadId,
  TurnId,
} from "@forgetools/contracts";

import type {
  ChatMessage,
  ProposedPlan,
  TurnDiffFileChange,
  ThreadSession,
  TurnDiffSummary,
} from "../types";

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
  sequence?: number | undefined;
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
  backgroundLifecycleRole?: "launch" | "completion" | undefined;
  backgroundTaskId?: string | undefined;
  backgroundTaskStatus?: "running" | "completed" | "failed" | undefined;
  backgroundCompletedAt?: string | undefined;
  backgroundCompletedSequence?: number | undefined;
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
  subagentGroupMeta?:
    | {
        childProviderThreadId: string;
        status: "running" | "completed" | "failed";
        startedAt: string;
        completedAt?: string | undefined;
        recordedActionCount: number;
        fallbackEntries: WorkLogEntry[];
      }
    | undefined;
}

export interface DerivedWorkLogEntry extends WorkLogEntry {
  activityKind: OrchestrationThreadActivity["kind"];
  collapseKey?: string;
}

export interface BackgroundTrayState {
  agentEntries: WorkLogEntry[];
  commandEntries: WorkLogEntry[];
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
      sequence?: number | undefined;
      message: ChatMessage;
    }
  | {
      id: string;
      kind: "proposed-plan";
      createdAt: string;
      sequence?: number | undefined;
      proposedPlan: ProposedPlan;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      sequence?: number | undefined;
      entry: WorkLogEntry;
    };

export type LatestTurnTiming = Pick<
  OrchestrationLatestTurn,
  "turnId" | "startedAt" | "completedAt"
>;
export type SessionActivityState = Pick<ThreadSession, "orchestrationStatus" | "activeTurnId">;

export type WorkLogScope = "latest-turn" | "all-turns";
export const BACKGROUND_TASK_RETENTION_MS = 5_000;

export interface DeriveWorkLogEntriesOptions {
  scope: WorkLogScope;
  latestTurnId?: TurnId | undefined;
  messages?: ReadonlyArray<ChatMessage> | undefined;
  latestTurn?: LatestTurnTiming | null | undefined;
}

export interface ToolEnrichments {
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

export interface ProviderBackgroundTaskSignal {
  taskId?: string | undefined;
  toolUseId?: string | undefined;
  status: "running" | "completed" | "failed";
  startedAt: string;
  startedSequence?: number | undefined;
  completedAt?: string | undefined;
  completedSequence?: number | undefined;
}

export interface BackgroundCommandCompletionSignal {
  status: "completed" | "failed";
  completedAt: string;
  sequence?: number | undefined;
}

export interface CodexBackgroundCommandCandidate {
  toolCallId: string;
  turnId?: TurnId | undefined;
  processId?: string | undefined;
  startedAt: string;
  completedAt?: string | undefined;
  backgrounded: boolean;
}

/** Max child entries to retain on a parent entry's subagentGroupMeta.fallbackEntries for
 *  immediate display before the lazy RPC feed loads. */
export const SUBAGENT_FALLBACK_ENTRY_LIMIT = 20;
