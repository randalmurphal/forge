import type {
  ModelSelection,
  OrchestrationLatestTurn,
  OrchestrationMessageAttribution,
  OrchestrationProposedPlanId,
  OrchestrationSessionStatus,
  OrchestrationThreadActivity,
  PhaseRunId,
  ProjectScript as ContractProjectScript,
  ThreadId,
  ProjectId,
  TurnId,
  MessageId,
  ProviderKind,
  CheckpointRef,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadSpawnMode,
  WorkflowId,
  WorkflowPhaseId,
} from "@forgetools/contracts";

export type SessionPhase = "disconnected" | "connecting" | "ready" | "running";
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

export const DEFAULT_INTERACTION_MODE: ProviderInteractionMode = "default";
export const DEFAULT_THREAD_TERMINAL_HEIGHT = 280;
export const DEFAULT_THREAD_TERMINAL_ID = "default";
export const MAX_TERMINALS_PER_GROUP = 4;
export type ProjectScript = ContractProjectScript;

export interface ThreadTerminalGroup {
  id: string;
  terminalIds: string[];
}

export interface ChatImageAttachment {
  type: "image";
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl?: string;
}

export type ChatAttachment = ChatImageAttachment;

export interface ChatMessage {
  id: MessageId;
  role: "user" | "assistant" | "system";
  text: string;
  attachments?: ChatAttachment[];
  attribution?: OrchestrationMessageAttribution;
  turnId?: TurnId | null;
  createdAt: string;
  completedAt?: string | undefined;
  streaming: boolean;
}

export interface ProposedPlan {
  id: OrchestrationProposedPlanId;
  turnId: TurnId | null;
  planMarkdown: string;
  implementedAt: string | null;
  implementationThreadId: ThreadId | null;
  createdAt: string;
  updatedAt: string;
}

export interface TurnDiffFileChange {
  path: string;
  kind?: string | undefined;
  additions?: number | undefined;
  deletions?: number | undefined;
}

export interface TurnDiffSummary {
  turnId: TurnId;
  completedAt: string;
  status?: string | undefined;
  provenance?: "agent" | "workspace" | undefined;
  coverage?: "complete" | "partial" | "unavailable" | undefined;
  source?: "native_turn_diff" | "derived_tool_results" | undefined;
  files: TurnDiffFileChange[];
  checkpointRef?: CheckpointRef | undefined;
  assistantMessageId?: MessageId | undefined;
  checkpointTurnCount?: number | undefined;
}

export interface Project {
  id: ProjectId;
  name: string;
  cwd: string;
  defaultModelSelection: ModelSelection | null;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  scripts: ProjectScript[];
}

export interface DesignArtifact {
  artifactId: string;
  title: string;
  description: string | null;
  artifactPath: string;
  renderedAt: string;
}

export interface DesignOption {
  id: string;
  title: string;
  description: string;
  artifactId: string;
  artifactPath: string;
}

export interface DesignPendingOptions {
  requestId: string;
  prompt: string;
  options: DesignOption[];
  chosenOptionId: string | null;
}

export interface Thread {
  id: ThreadId;
  codexThreadId: string | null;
  projectId: ProjectId;
  parentThreadId?: ThreadId | null;
  forkedFromThreadId: ThreadId | null;
  phaseRunId?: PhaseRunId | null;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  workflowId?: WorkflowId | null;
  currentPhaseId?: WorkflowPhaseId | null;
  discussionId?: string | null;
  role?: string | null;
  childThreadIds?: ThreadId[];
  session: ThreadSession | null;
  messages: ChatMessage[];
  proposedPlans: ProposedPlan[];
  error: string | null;
  createdAt: string;
  pinnedAt: string | null;
  archivedAt: string | null;
  updatedAt?: string | undefined;
  latestTurn: OrchestrationLatestTurn | null;
  pendingSourceProposedPlan?: OrchestrationLatestTurn["sourceProposedPlan"];
  branch: string | null;
  worktreePath: string | null;
  spawnMode?: ThreadSpawnMode;
  spawnBranch?: string | null;
  spawnWorktreePath?: string | null;
  designArtifacts: DesignArtifact[];
  designPendingOptions: DesignPendingOptions | null;
  agentDiffSummaries?: TurnDiffSummary[];
  turnDiffSummaries: TurnDiffSummary[];
  activities: OrchestrationThreadActivity[];
}

export interface SidebarThreadSummary {
  id: ThreadId;
  projectId: ProjectId;
  parentThreadId?: ThreadId | null;
  phaseRunId?: PhaseRunId | null;
  title: string;
  interactionMode: ProviderInteractionMode;
  workflowId?: WorkflowId | null;
  currentPhaseId?: WorkflowPhaseId | null;
  discussionId?: string | null;
  role?: string | null;
  childThreadIds?: ThreadId[];
  session: ThreadSession | null;
  createdAt: string;
  pinnedAt: string | null;
  archivedAt: string | null;
  updatedAt?: string | undefined;
  latestTurn: OrchestrationLatestTurn | null;
  branch: string | null;
  worktreePath: string | null;
  spawnMode?: ThreadSpawnMode;
  spawnBranch?: string | null;
  spawnWorktreePath?: string | null;
  latestUserMessageAt: string | null;
  lastSortableActivityAt: string | null;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  hasActionableProposedPlan: boolean;
}

export interface ThreadSession {
  provider: ProviderKind;
  status: SessionPhase | "error" | "closed";
  activeTurnId?: TurnId | undefined;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  orchestrationStatus: OrchestrationSessionStatus;
}
