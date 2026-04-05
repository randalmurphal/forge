import { Option, Schema, SchemaIssue, Struct } from "effect";
import {
  ApprovalRequestId,
  ChannelId,
  ChannelMessageId,
  CheckpointRef,
  CommandId,
  EventId,
  InteractiveRequestId,
  IsoDateTime,
  LinkId,
  MessageId,
  NonNegativeInt,
  PhaseRunId,
  PositiveInt,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
  WorkflowId,
  WorkflowPhaseId,
} from "./baseSchemas";
import {
  Channel,
  ChannelMessage,
  ChannelParticipantType,
  ChannelStatus,
  ChannelType,
} from "./channel";
import {
  InteractiveRequest,
  InteractiveRequestPayload,
  InteractiveRequestResolution,
  InteractiveRequestType,
} from "./interactiveRequest";
import { ModelSelection, ProviderApprovalDecision } from "./providerSchemas";
import {
  GateAfter,
  GateResult,
  PhaseRunStatus,
  PhaseType,
  QualityCheckReference,
  QualityCheckResult,
} from "./workflow";

export * from "./providerSchemas";

export const ORCHESTRATION_WS_METHODS = {
  getSnapshot: "orchestration.getSnapshot",
  dispatchCommand: "orchestration.dispatchCommand",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  replayEvents: "orchestration.replayEvents",
} as const;

export const RuntimeMode = Schema.Literals(["approval-required", "full-access"]);
export type RuntimeMode = typeof RuntimeMode.Type;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
export const ProviderInteractionMode = Schema.Literals(["default", "plan"]);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "default";
export const ProviderRequestKind = Schema.Literals(["command", "file-read", "file-change"]);
export type ProviderRequestKind = typeof ProviderRequestKind.Type;
export const AssistantDeliveryMode = Schema.Literals(["buffered", "streaming"]);
export type AssistantDeliveryMode = typeof AssistantDeliveryMode.Type;
export const ProviderUserInputAnswers = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;

export const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000;
export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS = 14_000_000;
const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;
// Correlation id is command id by design in this model.
export const CorrelationId = CommandId;
export type CorrelationId = typeof CorrelationId.Type;

const ChatAttachmentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHAT_ATTACHMENT_ID_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);
export type ChatAttachmentId = typeof ChatAttachmentId.Type;

export const ChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
});
export type ChatImageAttachment = typeof ChatImageAttachment.Type;

const UploadChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS),
  ),
});
export type UploadChatImageAttachment = typeof UploadChatImageAttachment.Type;

export const ChatAttachment = Schema.Union([ChatImageAttachment]);
export type ChatAttachment = typeof ChatAttachment.Type;
const UploadChatAttachment = Schema.Union([UploadChatImageAttachment]);
export type UploadChatAttachment = typeof UploadChatAttachment.Type;

export const ProjectScriptIcon = Schema.Literals([
  "play",
  "test",
  "lint",
  "configure",
  "build",
  "debug",
]);
export type ProjectScriptIcon = typeof ProjectScriptIcon.Type;

export const ProjectScript = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  icon: ProjectScriptIcon,
  runOnWorktreeCreate: Schema.Boolean,
});
export type ProjectScript = typeof ProjectScript.Type;

export const OrchestrationProject = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationProject = typeof OrchestrationProject.Type;

export const OrchestrationMessageRole = Schema.Literals(["user", "assistant", "system"]);
export type OrchestrationMessageRole = typeof OrchestrationMessageRole.Type;

export const OrchestrationMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationMessage = typeof OrchestrationMessage.Type;

export const OrchestrationProposedPlanId = TrimmedNonEmptyString;
export type OrchestrationProposedPlanId = typeof OrchestrationProposedPlanId.Type;

export const OrchestrationProposedPlan = Schema.Struct({
  id: OrchestrationProposedPlanId,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: TrimmedNonEmptyString,
  implementedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  implementationThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(() => null)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProposedPlan = typeof OrchestrationProposedPlan.Type;

const SourceProposedPlanReference = Schema.Struct({
  threadId: ThreadId,
  planId: OrchestrationProposedPlanId,
});

export const OrchestrationSessionStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);
export type OrchestrationSessionStatus = typeof OrchestrationSessionStatus.Type;

export const OrchestrationSession = Schema.Struct({
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
export type OrchestrationSession = typeof OrchestrationSession.Type;

export const OrchestrationCheckpointFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type OrchestrationCheckpointFile = typeof OrchestrationCheckpointFile.Type;

export const OrchestrationCheckpointStatus = Schema.Literals(["ready", "missing", "error"]);
export type OrchestrationCheckpointStatus = typeof OrchestrationCheckpointStatus.Type;

export const OrchestrationCheckpointSummary = Schema.Struct({
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type OrchestrationCheckpointSummary = typeof OrchestrationCheckpointSummary.Type;

export const OrchestrationThreadActivityTone = Schema.Literals([
  "info",
  "tool",
  "approval",
  "error",
]);
export type OrchestrationThreadActivityTone = typeof OrchestrationThreadActivityTone.Type;

export const OrchestrationThreadActivity = Schema.Struct({
  id: EventId,
  tone: OrchestrationThreadActivityTone,
  kind: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  payload: Schema.Unknown,
  turnId: Schema.NullOr(TurnId),
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type OrchestrationThreadActivity = typeof OrchestrationThreadActivity.Type;

const OrchestrationLatestTurnState = Schema.Literals([
  "running",
  "interrupted",
  "completed",
  "error",
]);
export type OrchestrationLatestTurnState = typeof OrchestrationLatestTurnState.Type;

export const OrchestrationLatestTurn = Schema.Struct({
  turnId: TurnId,
  state: OrchestrationLatestTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
});
export type OrchestrationLatestTurn = typeof OrchestrationLatestTurn.Type;

export const OrchestrationThread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  deletedAt: Schema.NullOr(IsoDateTime),
  parentThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(() => null)),
  phaseRunId: Schema.NullOr(PhaseRunId).pipe(Schema.withDecodingDefault(() => null)),
  workflowId: Schema.NullOr(WorkflowId).pipe(Schema.withDecodingDefault(() => null)),
  currentPhaseId: Schema.NullOr(WorkflowPhaseId).pipe(Schema.withDecodingDefault(() => null)),
  patternId: Schema.NullOr(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(() => null)),
  role: Schema.NullOr(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(() => null)),
  childThreadIds: Schema.Array(ThreadId).pipe(Schema.withDecodingDefault(() => [])),
  bootstrapStatus: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  messages: Schema.Array(OrchestrationMessage),
  proposedPlans: Schema.Array(OrchestrationProposedPlan).pipe(Schema.withDecodingDefault(() => [])),
  activities: Schema.Array(OrchestrationThreadActivity),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  session: Schema.NullOr(OrchestrationSession),
});
export type OrchestrationThread = typeof OrchestrationThread.Type;

export const OrchestrationReadModelPhaseRun = Schema.Struct({
  phaseRunId: PhaseRunId,
  threadId: ThreadId,
  phaseId: WorkflowPhaseId,
  phaseName: TrimmedNonEmptyString,
  phaseType: PhaseType,
  iteration: PositiveInt,
  status: PhaseRunStatus,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationReadModelPhaseRun = typeof OrchestrationReadModelPhaseRun.Type;

export const OrchestrationReadModelWorkflow = Schema.Struct({
  workflowId: WorkflowId,
  name: TrimmedNonEmptyString,
  description: Schema.String,
  builtIn: Schema.Boolean,
});
export type OrchestrationReadModelWorkflow = typeof OrchestrationReadModelWorkflow.Type;

export const OrchestrationReadModel = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProject),
  threads: Schema.Array(OrchestrationThread),
  phaseRuns: Schema.Array(OrchestrationReadModelPhaseRun).pipe(
    Schema.withDecodingDefault(() => []),
  ),
  channels: Schema.Array(Channel).pipe(Schema.withDecodingDefault(() => [])),
  pendingRequests: Schema.Array(InteractiveRequest).pipe(Schema.withDecodingDefault(() => [])),
  workflows: Schema.Array(OrchestrationReadModelWorkflow).pipe(
    Schema.withDecodingDefault(() => []),
  ),
  updatedAt: IsoDateTime,
});
export type OrchestrationReadModel = typeof OrchestrationReadModel.Type;

export const ProjectCreateCommand = Schema.Struct({
  type: Schema.Literal("project.create"),
  commandId: CommandId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  createdAt: IsoDateTime,
});

const ProjectMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.meta.update"),
  commandId: CommandId,
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
});

const ProjectDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.delete"),
  commandId: CommandId,
  projectId: ProjectId,
});

const ThreadCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

const ThreadDeleteCommand = Schema.Struct({
  type: Schema.Literal("thread.delete"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadArchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.archive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.unarchive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.meta.update"),
  commandId: CommandId,
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});

const ThreadRuntimeModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
});

const ThreadInteractionModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.interaction-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});

export const ThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
  }),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

const ClientThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(UploadChatAttachment),
  }),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

const ThreadTurnInterruptCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.interrupt"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadApprovalRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.approval.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

const ThreadCheckpointRevertCommand = Schema.Struct({
  type: Schema.Literal("thread.checkpoint.revert"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadSessionStopCommand = Schema.Struct({
  type: Schema.Literal("thread.session.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

export const PhaseOutputEntry = Schema.Struct({
  key: TrimmedNonEmptyString,
  content: Schema.String,
  sourceType: TrimmedNonEmptyString,
});
export type PhaseOutputEntry = typeof PhaseOutputEntry.Type;

export const LinkType = Schema.Literals([
  "pr",
  "issue",
  "ci-run",
  "promoted-from",
  "promoted-to",
  "related",
]);
export type LinkType = typeof LinkType.Type;

export const ThreadCorrectCommand = Schema.Struct({
  type: Schema.Literal("thread.correct"),
  commandId: CommandId,
  threadId: ThreadId,
  content: Schema.String,
  createdAt: IsoDateTime,
});
export type ThreadCorrectCommand = typeof ThreadCorrectCommand.Type;

export const ThreadStartPhaseCommand = Schema.Struct({
  type: Schema.Literal("thread.start-phase"),
  commandId: CommandId,
  threadId: ThreadId,
  phaseId: WorkflowPhaseId,
  phaseName: TrimmedNonEmptyString,
  phaseType: PhaseType,
  iteration: PositiveInt,
  createdAt: IsoDateTime,
});
export type ThreadStartPhaseCommand = typeof ThreadStartPhaseCommand.Type;

export const ThreadCompletePhaseCommand = Schema.Struct({
  type: Schema.Literal("thread.complete-phase"),
  commandId: CommandId,
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  outputs: Schema.optional(Schema.Array(PhaseOutputEntry)),
  gateResult: Schema.optional(GateResult),
  createdAt: IsoDateTime,
});
export type ThreadCompletePhaseCommand = typeof ThreadCompletePhaseCommand.Type;

export const ThreadFailPhaseCommand = Schema.Struct({
  type: Schema.Literal("thread.fail-phase"),
  commandId: CommandId,
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  error: Schema.String,
  createdAt: IsoDateTime,
});
export type ThreadFailPhaseCommand = typeof ThreadFailPhaseCommand.Type;

export const ThreadSkipPhaseCommand = Schema.Struct({
  type: Schema.Literal("thread.skip-phase"),
  commandId: CommandId,
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  createdAt: IsoDateTime,
});
export type ThreadSkipPhaseCommand = typeof ThreadSkipPhaseCommand.Type;

export const ThreadEditPhaseOutputCommand = Schema.Struct({
  type: Schema.Literal("thread.edit-phase-output"),
  commandId: CommandId,
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  outputKey: TrimmedNonEmptyString,
  content: Schema.String,
  createdAt: IsoDateTime,
});
export type ThreadEditPhaseOutputCommand = typeof ThreadEditPhaseOutputCommand.Type;

export const ThreadQualityCheckStartCommand = Schema.Struct({
  type: Schema.Literal("thread.quality-check-start"),
  commandId: CommandId,
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  checks: Schema.Array(QualityCheckReference),
  createdAt: IsoDateTime,
});
export type ThreadQualityCheckStartCommand = typeof ThreadQualityCheckStartCommand.Type;

export const ThreadQualityCheckCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.quality-check-complete"),
  commandId: CommandId,
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  results: Schema.Array(QualityCheckResult),
  createdAt: IsoDateTime,
});
export type ThreadQualityCheckCompleteCommand = typeof ThreadQualityCheckCompleteCommand.Type;

export const ThreadBootstrapStartedCommand = Schema.Struct({
  type: Schema.Literal("thread.bootstrap-started"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});
export type ThreadBootstrapStartedCommand = typeof ThreadBootstrapStartedCommand.Type;

export const ThreadBootstrapCompletedCommand = Schema.Struct({
  type: Schema.Literal("thread.bootstrap-completed"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});
export type ThreadBootstrapCompletedCommand = typeof ThreadBootstrapCompletedCommand.Type;

export const ThreadBootstrapFailedCommand = Schema.Struct({
  type: Schema.Literal("thread.bootstrap-failed"),
  commandId: CommandId,
  threadId: ThreadId,
  error: Schema.String,
  stdout: Schema.String,
  command: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type ThreadBootstrapFailedCommand = typeof ThreadBootstrapFailedCommand.Type;

export const ThreadBootstrapSkippedCommand = Schema.Struct({
  type: Schema.Literal("thread.bootstrap-skipped"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});
export type ThreadBootstrapSkippedCommand = typeof ThreadBootstrapSkippedCommand.Type;

export const ThreadAddLinkCommand = Schema.Struct({
  type: Schema.Literal("thread.add-link"),
  commandId: CommandId,
  threadId: ThreadId,
  linkId: LinkId,
  linkType: LinkType,
  linkedThreadId: Schema.optional(ThreadId),
  externalId: Schema.optional(TrimmedNonEmptyString),
  externalUrl: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (input) =>
      input.linkedThreadId !== undefined ||
      input.externalId !== undefined ||
      new SchemaIssue.InvalidValue(Option.some(input), {
        message: "thread.add-link requires linkedThreadId or externalId",
      }),
    { identifier: "ThreadAddLinkCommand" },
  ),
);
export type ThreadAddLinkCommand = typeof ThreadAddLinkCommand.Type;

export const ThreadRemoveLinkCommand = Schema.Struct({
  type: Schema.Literal("thread.remove-link"),
  commandId: CommandId,
  threadId: ThreadId,
  linkId: LinkId,
  createdAt: IsoDateTime,
});
export type ThreadRemoveLinkCommand = typeof ThreadRemoveLinkCommand.Type;

export const ThreadPromoteCommand = Schema.Struct({
  type: Schema.Literal("thread.promote"),
  commandId: CommandId,
  sourceThreadId: ThreadId,
  targetThreadId: ThreadId,
  targetWorkflowId: WorkflowId,
  title: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(Schema.String),
  createdAt: IsoDateTime,
});
export type ThreadPromoteCommand = typeof ThreadPromoteCommand.Type;

export const ThreadAddDependencyCommand = Schema.Struct({
  type: Schema.Literal("thread.add-dependency"),
  commandId: CommandId,
  threadId: ThreadId,
  dependsOnThreadId: ThreadId,
  createdAt: IsoDateTime,
});
export type ThreadAddDependencyCommand = typeof ThreadAddDependencyCommand.Type;

export const ThreadRemoveDependencyCommand = Schema.Struct({
  type: Schema.Literal("thread.remove-dependency"),
  commandId: CommandId,
  threadId: ThreadId,
  dependsOnThreadId: ThreadId,
  createdAt: IsoDateTime,
});
export type ThreadRemoveDependencyCommand = typeof ThreadRemoveDependencyCommand.Type;

export const ChannelCreateCommand = Schema.Struct({
  type: Schema.Literal("channel.create"),
  commandId: CommandId,
  channelId: ChannelId,
  threadId: ThreadId,
  channelType: ChannelType,
  phaseRunId: Schema.optional(PhaseRunId),
  createdAt: IsoDateTime,
});
export type ChannelCreateCommand = typeof ChannelCreateCommand.Type;

export const ChannelPostMessageCommand = Schema.Struct({
  type: Schema.Literal("channel.post-message"),
  commandId: CommandId,
  channelId: ChannelId,
  messageId: ChannelMessageId,
  fromType: ChannelParticipantType,
  fromId: TrimmedNonEmptyString,
  fromRole: Schema.optional(TrimmedNonEmptyString),
  content: Schema.String,
  createdAt: IsoDateTime,
});
export type ChannelPostMessageCommand = typeof ChannelPostMessageCommand.Type;

export const ChannelReadMessagesCommand = Schema.Struct({
  type: Schema.Literal("channel.read-messages"),
  commandId: CommandId,
  channelId: ChannelId,
  threadId: ThreadId,
  upToSequence: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type ChannelReadMessagesCommand = typeof ChannelReadMessagesCommand.Type;

export const ChannelConcludeCommand = Schema.Struct({
  type: Schema.Literal("channel.conclude"),
  commandId: CommandId,
  channelId: ChannelId,
  threadId: ThreadId,
  summary: Schema.String,
  createdAt: IsoDateTime,
});
export type ChannelConcludeCommand = typeof ChannelConcludeCommand.Type;

export const ChannelCloseCommand = Schema.Struct({
  type: Schema.Literal("channel.close"),
  commandId: CommandId,
  channelId: ChannelId,
  createdAt: IsoDateTime,
});
export type ChannelCloseCommand = typeof ChannelCloseCommand.Type;

export const RequestOpenCommand = Schema.Struct({
  type: Schema.Literal("request.open"),
  commandId: CommandId,
  requestId: InteractiveRequestId,
  threadId: ThreadId,
  childThreadId: Schema.optional(ThreadId),
  phaseRunId: Schema.optional(PhaseRunId),
  requestType: InteractiveRequestType,
  payload: InteractiveRequestPayload,
  createdAt: IsoDateTime,
});
export type RequestOpenCommand = typeof RequestOpenCommand.Type;

export const RequestResolveCommand = Schema.Struct({
  type: Schema.Literal("request.resolve"),
  commandId: CommandId,
  requestId: InteractiveRequestId,
  resolvedWith: InteractiveRequestResolution,
  createdAt: IsoDateTime,
});
export type RequestResolveCommand = typeof RequestResolveCommand.Type;

export const RequestMarkStaleCommand = Schema.Struct({
  type: Schema.Literal("request.mark-stale"),
  commandId: CommandId,
  requestId: InteractiveRequestId,
  reason: Schema.String,
  createdAt: IsoDateTime,
});
export type RequestMarkStaleCommand = typeof RequestMarkStaleCommand.Type;

const DispatchableClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadSessionStopCommand,
]);
export type DispatchableClientOrchestrationCommand =
  typeof DispatchableClientOrchestrationCommand.Type;

export const ClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ClientThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadSessionStopCommand,
]);
export type ClientOrchestrationCommand = typeof ClientOrchestrationCommand.Type;

const ThreadSessionSetCommand = Schema.Struct({
  type: Schema.Literal("thread.session.set"),
  commandId: CommandId,
  threadId: ThreadId,
  session: OrchestrationSession,
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantDeltaCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.delta"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  delta: Schema.String,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadProposedPlanUpsertCommand = Schema.Struct({
  type: Schema.Literal("thread.proposed-plan.upsert"),
  commandId: CommandId,
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
  createdAt: IsoDateTime,
});

const ThreadTurnDiffCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.diff.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  completedAt: IsoDateTime,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.optional(MessageId),
  checkpointTurnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadActivityAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.activity.append"),
  commandId: CommandId,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  createdAt: IsoDateTime,
});

const ThreadRevertCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.revert.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const InternalOrchestrationCommand = Schema.Union([
  ThreadSessionSetCommand,
  ThreadMessageAssistantDeltaCommand,
  ThreadMessageAssistantCompleteCommand,
  ThreadProposedPlanUpsertCommand,
  ThreadTurnDiffCompleteCommand,
  ThreadActivityAppendCommand,
  ThreadRevertCompleteCommand,
]);
export type InternalOrchestrationCommand = typeof InternalOrchestrationCommand.Type;

const ForgeDispatchableClientOrchestrationCommand = Schema.Union([
  DispatchableClientOrchestrationCommand,
  ThreadCorrectCommand,
  ThreadAddLinkCommand,
  ThreadRemoveLinkCommand,
  ThreadPromoteCommand,
  ThreadAddDependencyCommand,
  ThreadRemoveDependencyCommand,
  ChannelPostMessageCommand,
  ChannelReadMessagesCommand,
  RequestResolveCommand,
]);

const ForgeInternalOrchestrationCommand = Schema.Union([
  InternalOrchestrationCommand,
  ThreadStartPhaseCommand,
  ThreadCompletePhaseCommand,
  ThreadFailPhaseCommand,
  ThreadSkipPhaseCommand,
  ThreadEditPhaseOutputCommand,
  ThreadQualityCheckStartCommand,
  ThreadQualityCheckCompleteCommand,
  ThreadBootstrapStartedCommand,
  ThreadBootstrapCompletedCommand,
  ThreadBootstrapFailedCommand,
  ThreadBootstrapSkippedCommand,
  ChannelCreateCommand,
  ChannelConcludeCommand,
  ChannelCloseCommand,
  RequestOpenCommand,
  RequestMarkStaleCommand,
]);

export const ForgeCommand = Schema.Union([
  ForgeDispatchableClientOrchestrationCommand,
  ForgeInternalOrchestrationCommand,
]);
export type ForgeCommand = typeof ForgeCommand.Type;

export const OrchestrationCommand = Schema.Union([
  DispatchableClientOrchestrationCommand,
  InternalOrchestrationCommand,
]);
export type OrchestrationCommand = typeof OrchestrationCommand.Type;

export const OrchestrationEventType = Schema.Literals([
  "project.created",
  "project.meta-updated",
  "project.deleted",
  "thread.created",
  "thread.deleted",
  "thread.archived",
  "thread.unarchived",
  "thread.meta-updated",
  "thread.runtime-mode-set",
  "thread.interaction-mode-set",
  "thread.message-sent",
  "thread.turn-start-requested",
  "thread.turn-interrupt-requested",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.checkpoint-revert-requested",
  "thread.reverted",
  "thread.session-stop-requested",
  "thread.session-set",
  "thread.proposed-plan-upserted",
  "thread.turn-diff-completed",
  "thread.activity-appended",
]);
export type OrchestrationEventType = typeof OrchestrationEventType.Type;

export const OrchestrationAggregateKind = Schema.Literals(["project", "thread"]);
export type OrchestrationAggregateKind = typeof OrchestrationAggregateKind.Type;
export const OrchestrationActorKind = Schema.Literals(["client", "server", "provider"]);

export const ProjectCreatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ProjectMetaUpdatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  updatedAt: IsoDateTime,
});

export const ProjectDeletedPayload = Schema.Struct({
  projectId: ProjectId,
  deletedAt: IsoDateTime,
});

export const ThreadCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadDeletedPayload = Schema.Struct({
  threadId: ThreadId,
  deletedAt: IsoDateTime,
});

export const ThreadArchivedPayload = Schema.Struct({
  threadId: ThreadId,
  archivedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnarchivedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});

export const ThreadMetaUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  updatedAt: IsoDateTime,
});

export const ThreadRuntimeModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  updatedAt: IsoDateTime,
});

export const ThreadInteractionModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  updatedAt: IsoDateTime,
});

export const ThreadMessageSentPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadTurnStartRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

export const ThreadTurnInterruptRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

export const ThreadApprovalResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

export const ThreadCheckpointRevertRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadRevertedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
});

export const ThreadSessionStopRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

export const ThreadSessionSetPayload = Schema.Struct({
  threadId: ThreadId,
  session: OrchestrationSession,
});

export const ThreadProposedPlanUpsertedPayload = Schema.Struct({
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
});

export const ThreadTurnDiffCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});

export const ThreadActivityAppendedPayload = Schema.Struct({
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
});

export const OrchestrationEventMetadata = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(ProviderItemId),
  adapterKey: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(ApprovalRequestId),
  ingestedAt: Schema.optional(IsoDateTime),
});
export type OrchestrationEventMetadata = typeof OrchestrationEventMetadata.Type;

const EventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: OrchestrationEventMetadata,
} as const;

export const OrchestrationEvent = Schema.Union([
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.created"),
    payload: ProjectCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.meta-updated"),
    payload: ProjectMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.deleted"),
    payload: ProjectDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.created"),
    payload: ThreadCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.deleted"),
    payload: ThreadDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.archived"),
    payload: ThreadArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unarchived"),
    payload: ThreadUnarchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.meta-updated"),
    payload: ThreadMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-mode-set"),
    payload: ThreadRuntimeModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.interaction-mode-set"),
    payload: ThreadInteractionModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-sent"),
    payload: ThreadMessageSentPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-start-requested"),
    payload: ThreadTurnStartRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-interrupt-requested"),
    payload: ThreadTurnInterruptRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.approval-response-requested"),
    payload: ThreadApprovalResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.user-input-response-requested"),
    payload: ThreadUserInputResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.checkpoint-revert-requested"),
    payload: ThreadCheckpointRevertRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.reverted"),
    payload: ThreadRevertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-stop-requested"),
    payload: ThreadSessionStopRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-set"),
    payload: ThreadSessionSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.proposed-plan-upserted"),
    payload: ThreadProposedPlanUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-diff-completed"),
    payload: ThreadTurnDiffCompletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.activity-appended"),
    payload: ThreadActivityAppendedPayload,
  }),
]);
export type OrchestrationEvent = typeof OrchestrationEvent.Type;

export const ForgeEventType = Schema.Union([
  OrchestrationEventType,
  Schema.Literals([
    "thread.phase-started",
    "thread.phase-completed",
    "thread.phase-failed",
    "thread.phase-skipped",
    "thread.phase-output-edited",
    "thread.quality-check-started",
    "thread.quality-check-completed",
    "thread.correction-queued",
    "thread.correction-delivered",
    "thread.bootstrap-queued",
    "thread.bootstrap-started",
    "thread.bootstrap-completed",
    "thread.bootstrap-failed",
    "thread.bootstrap-skipped",
    "thread.link-added",
    "thread.link-removed",
    "thread.promoted",
    "thread.dependency-added",
    "thread.dependency-removed",
    "thread.dependencies-satisfied",
    "thread.synthesis-completed",
    "channel.created",
    "channel.message-posted",
    "channel.messages-read",
    "channel.conclusion-proposed",
    "channel.concluded",
    "channel.closed",
    "request.opened",
    "request.resolved",
    "request.stale",
  ]),
]);
export type ForgeEventType = typeof ForgeEventType.Type;

export const ForgeAggregateKind = Schema.Literals(["project", "thread", "channel", "request"]);
export type ForgeAggregateKind = typeof ForgeAggregateKind.Type;

export const ThreadPhaseStartedPayload = Schema.Struct({
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  phaseId: WorkflowPhaseId,
  phaseName: TrimmedNonEmptyString,
  phaseType: PhaseType,
  iteration: PositiveInt,
  startedAt: IsoDateTime,
});
export type ThreadPhaseStartedPayload = typeof ThreadPhaseStartedPayload.Type;

export const ThreadPhaseCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  outputs: Schema.Array(PhaseOutputEntry),
  gateResult: Schema.optional(GateResult),
  completedAt: IsoDateTime,
});
export type ThreadPhaseCompletedPayload = typeof ThreadPhaseCompletedPayload.Type;

export const ThreadPhaseFailedPayload = Schema.Struct({
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  error: Schema.String,
  failedAt: IsoDateTime,
});
export type ThreadPhaseFailedPayload = typeof ThreadPhaseFailedPayload.Type;

export const ThreadPhaseSkippedPayload = Schema.Struct({
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  skippedAt: IsoDateTime,
});
export type ThreadPhaseSkippedPayload = typeof ThreadPhaseSkippedPayload.Type;

export const ThreadPhaseOutputEditedPayload = Schema.Struct({
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  outputKey: TrimmedNonEmptyString,
  previousContent: Schema.String,
  newContent: Schema.String,
  editedAt: IsoDateTime,
});
export type ThreadPhaseOutputEditedPayload = typeof ThreadPhaseOutputEditedPayload.Type;

export const ThreadQualityCheckStartedPayload = Schema.Struct({
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  checks: Schema.Array(QualityCheckReference),
  startedAt: IsoDateTime,
});
export type ThreadQualityCheckStartedPayload = typeof ThreadQualityCheckStartedPayload.Type;

export const ThreadQualityCheckCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  results: Schema.Array(QualityCheckResult),
  completedAt: IsoDateTime,
});
export type ThreadQualityCheckCompletedPayload = typeof ThreadQualityCheckCompletedPayload.Type;

export const ThreadBootstrapQueuedPayload = Schema.Struct({
  threadId: ThreadId,
  queuedAt: IsoDateTime,
});
export type ThreadBootstrapQueuedPayload = typeof ThreadBootstrapQueuedPayload.Type;

export const ThreadBootstrapStartedPayload = Schema.Struct({
  threadId: ThreadId,
  startedAt: IsoDateTime,
});
export type ThreadBootstrapStartedPayload = typeof ThreadBootstrapStartedPayload.Type;

export const ThreadBootstrapCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  completedAt: IsoDateTime,
});
export type ThreadBootstrapCompletedPayload = typeof ThreadBootstrapCompletedPayload.Type;

export const ThreadBootstrapFailedPayload = Schema.Struct({
  threadId: ThreadId,
  error: Schema.String,
  stdout: Schema.String,
  command: TrimmedNonEmptyString,
  failedAt: IsoDateTime,
});
export type ThreadBootstrapFailedPayload = typeof ThreadBootstrapFailedPayload.Type;

export const ThreadBootstrapSkippedPayload = Schema.Struct({
  threadId: ThreadId,
  skippedAt: IsoDateTime,
});
export type ThreadBootstrapSkippedPayload = typeof ThreadBootstrapSkippedPayload.Type;

export const ThreadCorrectionQueuedPayload = Schema.Struct({
  threadId: ThreadId,
  content: Schema.String,
  channelId: ChannelId,
  messageId: ChannelMessageId,
  createdAt: IsoDateTime,
});
export type ThreadCorrectionQueuedPayload = typeof ThreadCorrectionQueuedPayload.Type;

export const ThreadCorrectionDeliveredPayload = Schema.Struct({
  threadId: ThreadId,
  deliveredAt: IsoDateTime,
});
export type ThreadCorrectionDeliveredPayload = typeof ThreadCorrectionDeliveredPayload.Type;

export const ThreadLinkAddedPayload = Schema.Struct({
  threadId: ThreadId,
  linkId: LinkId,
  linkType: LinkType,
  linkedThreadId: Schema.NullOr(ThreadId),
  externalId: Schema.NullOr(TrimmedNonEmptyString),
  externalUrl: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});
export type ThreadLinkAddedPayload = typeof ThreadLinkAddedPayload.Type;

export const ThreadLinkRemovedPayload = Schema.Struct({
  threadId: ThreadId,
  linkId: LinkId,
  removedAt: IsoDateTime,
});
export type ThreadLinkRemovedPayload = typeof ThreadLinkRemovedPayload.Type;

export const ThreadPromotedPayload = Schema.Struct({
  sourceThreadId: ThreadId,
  targetThreadId: ThreadId,
  promotedAt: IsoDateTime,
});
export type ThreadPromotedPayload = typeof ThreadPromotedPayload.Type;

export const ThreadDependencyAddedPayload = Schema.Struct({
  threadId: ThreadId,
  dependsOnThreadId: ThreadId,
  createdAt: IsoDateTime,
});
export type ThreadDependencyAddedPayload = typeof ThreadDependencyAddedPayload.Type;

export const ThreadDependencyRemovedPayload = Schema.Struct({
  threadId: ThreadId,
  dependsOnThreadId: ThreadId,
  removedAt: IsoDateTime,
});
export type ThreadDependencyRemovedPayload = typeof ThreadDependencyRemovedPayload.Type;

export const ThreadDependenciesSatisfiedPayload = Schema.Struct({
  threadId: ThreadId,
  satisfiedAt: IsoDateTime,
});
export type ThreadDependenciesSatisfiedPayload = typeof ThreadDependenciesSatisfiedPayload.Type;

export const ThreadSynthesisCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  content: Schema.String,
  generatedByThreadId: ThreadId,
  completedAt: IsoDateTime,
});
export type ThreadSynthesisCompletedPayload = typeof ThreadSynthesisCompletedPayload.Type;

export const ChannelCreatedPayload = Schema.Struct({
  channelId: ChannelId,
  threadId: ThreadId,
  channelType: ChannelType,
  phaseRunId: Schema.NullOr(PhaseRunId),
  createdAt: IsoDateTime,
});
export type ChannelCreatedPayload = typeof ChannelCreatedPayload.Type;

export const ChannelMessagePostedPayload = Schema.Struct({
  channelId: ChannelId,
  messageId: ChannelMessageId,
  sequence: NonNegativeInt,
  fromType: ChannelParticipantType,
  fromId: TrimmedNonEmptyString,
  fromRole: Schema.NullOr(TrimmedNonEmptyString),
  content: Schema.String,
  createdAt: IsoDateTime,
});
export type ChannelMessagePostedPayload = typeof ChannelMessagePostedPayload.Type;

export const ChannelMessagesReadPayload = Schema.Struct({
  channelId: ChannelId,
  threadId: ThreadId,
  upToSequence: NonNegativeInt,
  readAt: IsoDateTime,
});
export type ChannelMessagesReadPayload = typeof ChannelMessagesReadPayload.Type;

export const ChannelConclusionProposedPayload = Schema.Struct({
  channelId: ChannelId,
  threadId: ThreadId,
  summary: Schema.String,
  proposedAt: IsoDateTime,
});
export type ChannelConclusionProposedPayload = typeof ChannelConclusionProposedPayload.Type;

export const ChannelConcludedPayload = Schema.Struct({
  channelId: ChannelId,
  concludedAt: IsoDateTime,
});
export type ChannelConcludedPayload = typeof ChannelConcludedPayload.Type;

export const ChannelClosedPayload = Schema.Struct({
  channelId: ChannelId,
  closedAt: IsoDateTime,
});
export type ChannelClosedPayload = typeof ChannelClosedPayload.Type;

export const InteractiveRequestOpenedPayload = Schema.Struct({
  requestId: InteractiveRequestId,
  threadId: ThreadId,
  childThreadId: Schema.NullOr(ThreadId),
  phaseRunId: Schema.NullOr(PhaseRunId),
  requestType: InteractiveRequestType,
  payload: InteractiveRequestPayload,
  createdAt: IsoDateTime,
});
export type InteractiveRequestOpenedPayload = typeof InteractiveRequestOpenedPayload.Type;

export const InteractiveRequestResolvedPayload = Schema.Struct({
  requestId: InteractiveRequestId,
  resolvedWith: InteractiveRequestResolution,
  resolvedAt: IsoDateTime,
});
export type InteractiveRequestResolvedPayload = typeof InteractiveRequestResolvedPayload.Type;

export const InteractiveRequestStalePayload = Schema.Struct({
  requestId: InteractiveRequestId,
  reason: Schema.String,
  staleAt: IsoDateTime,
});
export type InteractiveRequestStalePayload = typeof InteractiveRequestStalePayload.Type;

const ForgeEventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: ForgeAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId, ChannelId, InteractiveRequestId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: OrchestrationEventMetadata,
} as const;

export const ForgeEvent = Schema.Union([
  OrchestrationEvent,
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.phase-started"),
    payload: ThreadPhaseStartedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.phase-completed"),
    payload: ThreadPhaseCompletedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.phase-failed"),
    payload: ThreadPhaseFailedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.phase-skipped"),
    payload: ThreadPhaseSkippedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.phase-output-edited"),
    payload: ThreadPhaseOutputEditedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.quality-check-started"),
    payload: ThreadQualityCheckStartedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.quality-check-completed"),
    payload: ThreadQualityCheckCompletedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.bootstrap-queued"),
    payload: ThreadBootstrapQueuedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.bootstrap-started"),
    payload: ThreadBootstrapStartedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.bootstrap-completed"),
    payload: ThreadBootstrapCompletedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.bootstrap-failed"),
    payload: ThreadBootstrapFailedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.bootstrap-skipped"),
    payload: ThreadBootstrapSkippedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.correction-queued"),
    payload: ThreadCorrectionQueuedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.correction-delivered"),
    payload: ThreadCorrectionDeliveredPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.link-added"),
    payload: ThreadLinkAddedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.link-removed"),
    payload: ThreadLinkRemovedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.promoted"),
    payload: ThreadPromotedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.dependency-added"),
    payload: ThreadDependencyAddedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.dependency-removed"),
    payload: ThreadDependencyRemovedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.dependencies-satisfied"),
    payload: ThreadDependenciesSatisfiedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.synthesis-completed"),
    payload: ThreadSynthesisCompletedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("channel.created"),
    payload: ChannelCreatedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("channel.message-posted"),
    payload: ChannelMessagePostedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("channel.messages-read"),
    payload: ChannelMessagesReadPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("channel.conclusion-proposed"),
    payload: ChannelConclusionProposedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("channel.concluded"),
    payload: ChannelConcludedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("channel.closed"),
    payload: ChannelClosedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("request.opened"),
    payload: InteractiveRequestOpenedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("request.resolved"),
    payload: InteractiveRequestResolvedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("request.stale"),
    payload: InteractiveRequestStalePayload,
  }),
]);
export type ForgeEvent = typeof ForgeEvent.Type;

export const WorkflowPhaseEvent = Schema.Struct({
  channel: Schema.Literal("workflow.phase"),
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  event: Schema.Literals(["started", "completed", "failed", "skipped"]),
  phaseInfo: Schema.Struct({
    phaseId: WorkflowPhaseId,
    phaseName: TrimmedNonEmptyString,
    phaseType: PhaseType,
    iteration: PositiveInt,
  }),
  outputs: Schema.optional(Schema.Array(PhaseOutputEntry)),
  error: Schema.optional(Schema.String),
  timestamp: IsoDateTime,
});
export type WorkflowPhaseEvent = typeof WorkflowPhaseEvent.Type;

export const WorkflowQualityCheckEvent = Schema.Struct({
  channel: Schema.Literal("workflow.quality-check"),
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  checkName: TrimmedNonEmptyString,
  status: Schema.Literals(["running", "passed", "failed"]),
  output: Schema.optional(Schema.String),
  timestamp: IsoDateTime,
});
export type WorkflowQualityCheckEvent = typeof WorkflowQualityCheckEvent.Type;

export const WorkflowBootstrapEvent = Schema.Struct({
  channel: Schema.Literal("workflow.bootstrap"),
  threadId: ThreadId,
  event: Schema.Literals(["started", "output", "completed", "failed", "skipped"]),
  data: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  timestamp: IsoDateTime,
});
export type WorkflowBootstrapEvent = typeof WorkflowBootstrapEvent.Type;

export const WorkflowGateEvent = Schema.Struct({
  channel: Schema.Literal("workflow.gate"),
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  gateType: GateAfter,
  status: Schema.Literals(["evaluating", "passed", "waiting-human", "failed"]),
  requestId: Schema.optional(InteractiveRequestId),
  timestamp: IsoDateTime,
});
export type WorkflowGateEvent = typeof WorkflowGateEvent.Type;

export const WorkflowPushEvent = Schema.Union([
  WorkflowPhaseEvent,
  WorkflowQualityCheckEvent,
  WorkflowBootstrapEvent,
  WorkflowGateEvent,
]);
export type WorkflowPushEvent = typeof WorkflowPushEvent.Type;

export const ChannelMessageEvent = Schema.Struct({
  channel: Schema.Literal("channel.message"),
  channelId: ChannelId,
  threadId: ThreadId,
  message: ChannelMessage,
  timestamp: IsoDateTime,
});
export type ChannelMessageEvent = typeof ChannelMessageEvent.Type;

export const ChannelConclusionEvent = Schema.Struct({
  channel: Schema.Literal("channel.conclusion"),
  channelId: ChannelId,
  threadId: ThreadId,
  sessionId: ThreadId,
  summary: Schema.String,
  allProposed: Schema.Boolean,
  timestamp: IsoDateTime,
});
export type ChannelConclusionEvent = typeof ChannelConclusionEvent.Type;

export const ChannelStatusEvent = Schema.Struct({
  channel: Schema.Literal("channel.status"),
  channelId: ChannelId,
  status: ChannelStatus,
  timestamp: IsoDateTime,
});
export type ChannelStatusEvent = typeof ChannelStatusEvent.Type;

export const ChannelPushEvent = Schema.Union([
  ChannelMessageEvent,
  ChannelConclusionEvent,
  ChannelStatusEvent,
]);
export type ChannelPushEvent = typeof ChannelPushEvent.Type;

export const OrchestrationCommandReceiptStatus = Schema.Literals(["accepted", "rejected"]);
export type OrchestrationCommandReceiptStatus = typeof OrchestrationCommandReceiptStatus.Type;

export const TurnCountRange = Schema.Struct({
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (input) =>
      input.fromTurnCount <= input.toTurnCount ||
      new SchemaIssue.InvalidValue(Option.some(input.fromTurnCount), {
        message: "fromTurnCount must be less than or equal to toTurnCount",
      }),
    { identifier: "OrchestrationTurnDiffRange" },
  ),
);

export const ThreadTurnDiff = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    diff: Schema.String,
  }),
  { unsafePreserveChecks: true },
);

export const ProviderSessionRuntimeStatus = Schema.Literals([
  "starting",
  "running",
  "stopped",
  "error",
]);
export type ProviderSessionRuntimeStatus = typeof ProviderSessionRuntimeStatus.Type;

const ProjectionThreadTurnStatus = Schema.Literals([
  "running",
  "completed",
  "interrupted",
  "error",
]);
export type ProjectionThreadTurnStatus = typeof ProjectionThreadTurnStatus.Type;

const ProjectionCheckpointRow = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type ProjectionCheckpointRow = typeof ProjectionCheckpointRow.Type;

export const ProjectionPendingApprovalStatus = Schema.Literals(["pending", "resolved"]);
export type ProjectionPendingApprovalStatus = typeof ProjectionPendingApprovalStatus.Type;

export const ProjectionPendingApprovalDecision = Schema.NullOr(ProviderApprovalDecision);
export type ProjectionPendingApprovalDecision = typeof ProjectionPendingApprovalDecision.Type;

export const DispatchResult = Schema.Struct({
  sequence: NonNegativeInt,
});
export type DispatchResult = typeof DispatchResult.Type;

export const OrchestrationGetSnapshotInput = Schema.Struct({});
export type OrchestrationGetSnapshotInput = typeof OrchestrationGetSnapshotInput.Type;
const OrchestrationGetSnapshotResult = OrchestrationReadModel;
export type OrchestrationGetSnapshotResult = typeof OrchestrationGetSnapshotResult.Type;

export const OrchestrationGetTurnDiffInput = TurnCountRange.mapFields(
  Struct.assign({ threadId: ThreadId }),
  { unsafePreserveChecks: true },
);
export type OrchestrationGetTurnDiffInput = typeof OrchestrationGetTurnDiffInput.Type;

export const OrchestrationGetTurnDiffResult = ThreadTurnDiff;
export type OrchestrationGetTurnDiffResult = typeof OrchestrationGetTurnDiffResult.Type;

export const OrchestrationGetFullThreadDiffInput = Schema.Struct({
  threadId: ThreadId,
  toTurnCount: NonNegativeInt,
});
export type OrchestrationGetFullThreadDiffInput = typeof OrchestrationGetFullThreadDiffInput.Type;

export const OrchestrationGetFullThreadDiffResult = ThreadTurnDiff;
export type OrchestrationGetFullThreadDiffResult = typeof OrchestrationGetFullThreadDiffResult.Type;

export const OrchestrationReplayEventsInput = Schema.Struct({
  fromSequenceExclusive: NonNegativeInt,
});
export type OrchestrationReplayEventsInput = typeof OrchestrationReplayEventsInput.Type;

const OrchestrationReplayEventsResult = Schema.Array(OrchestrationEvent);
export type OrchestrationReplayEventsResult = typeof OrchestrationReplayEventsResult.Type;

export const OrchestrationRpcSchemas = {
  getSnapshot: {
    input: OrchestrationGetSnapshotInput,
    output: OrchestrationGetSnapshotResult,
  },
  dispatchCommand: {
    input: ClientOrchestrationCommand,
    output: DispatchResult,
  },
  getTurnDiff: {
    input: OrchestrationGetTurnDiffInput,
    output: OrchestrationGetTurnDiffResult,
  },
  getFullThreadDiff: {
    input: OrchestrationGetFullThreadDiffInput,
    output: OrchestrationGetFullThreadDiffResult,
  },
  replayEvents: {
    input: OrchestrationReplayEventsInput,
    output: OrchestrationReplayEventsResult,
  },
} as const;

export class OrchestrationGetSnapshotError extends Schema.TaggedErrorClass<OrchestrationGetSnapshotError>()(
  "OrchestrationGetSnapshotError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class OrchestrationDispatchCommandError extends Schema.TaggedErrorClass<OrchestrationDispatchCommandError>()(
  "OrchestrationDispatchCommandError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class OrchestrationGetTurnDiffError extends Schema.TaggedErrorClass<OrchestrationGetTurnDiffError>()(
  "OrchestrationGetTurnDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class OrchestrationGetFullThreadDiffError extends Schema.TaggedErrorClass<OrchestrationGetFullThreadDiffError>()(
  "OrchestrationGetFullThreadDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class OrchestrationReplayEventsError extends Schema.TaggedErrorClass<OrchestrationReplayEventsError>()(
  "OrchestrationReplayEventsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
