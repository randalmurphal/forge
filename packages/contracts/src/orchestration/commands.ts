import { Option, Schema, SchemaIssue } from "effect";
import {
  ApprovalRequestId,
  ChannelId,
  ChannelMessageId,
  CheckpointRef,
  CommandId,
  DesignArtifactId,
  EventId,
  InteractiveRequestId,
  IsoDateTime,
  LinkId,
  MessageId,
  NonNegativeInt,
  PhaseRunId,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
  WorkflowId,
  WorkflowPhaseId,
} from "../baseSchemas";
import { ChannelParticipantType, ChannelType } from "../channel";
import {
  InteractiveRequestPayload,
  InteractiveRequestResolution,
  InteractiveRequestType,
} from "../interactiveRequest";
import { ModelSelection, ProviderApprovalDecision, ProviderKind } from "../providerSchemas";
import { GateResult, PhaseType, QualityCheckReference, QualityCheckResult } from "../workflow";
import {
  ChatAttachment,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  OrchestrationAgentDiffCoverage,
  OrchestrationAgentDiffSource,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointStatus,
  OrchestrationMessageAttribution,
  OrchestrationMessageRole,
  OrchestrationProposedPlan,
  OrchestrationSession,
  OrchestrationThreadActivity,
  OrchestrationToolInlineDiff,
  ProjectScript,
  ProviderInteractionMode,
  ProviderUserInputAnswers,
  RuntimeMode,
  SourceProposedPlanReference,
  ThreadSpawnMode,
  UploadChatAttachment,
  ForgeSessionType,
} from "./types";

export const ProjectCreateCommand = Schema.Struct({
  type: Schema.Literal("project.create"),
  commandId: CommandId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  createdAt: IsoDateTime,
});

export const SessionCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  parentThreadId: Schema.optional(ThreadId),
  phaseRunId: Schema.optional(PhaseRunId),
  sessionType: ForgeSessionType,
  title: TrimmedNonEmptyString,
  description: Schema.String.pipe(Schema.withDecodingDefault(() => "")),
  workflowId: Schema.optional(WorkflowId),
  discussionId: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  model: Schema.optional(ModelSelection),
  provider: Schema.optional(ProviderKind),
  role: Schema.optional(TrimmedNonEmptyString),
  branchOverride: Schema.optional(TrimmedNonEmptyString),
  requiresWorktree: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
});
export type SessionCreateCommand = typeof SessionCreateCommand.Type;

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
  spawnMode: Schema.optional(ThreadSpawnMode),
  workflowId: Schema.optional(WorkflowId),
  discussionId: Schema.optional(TrimmedNonEmptyString),
  discussionRoleModels: Schema.optional(Schema.Record(Schema.String, ModelSelection)),
  parentThreadId: Schema.optional(ThreadId),
  role: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

const ThreadDeleteCommand = Schema.Struct({
  type: Schema.Literal("thread.delete"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadForkCommand = Schema.Struct({
  type: Schema.Literal("thread.fork"),
  commandId: CommandId,
  sourceThreadId: ThreadId,
  newThreadId: ThreadId,
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

const ThreadPinCommand = Schema.Struct({
  type: Schema.Literal("thread.pin"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadUnpinCommand = Schema.Struct({
  type: Schema.Literal("thread.unpin"),
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

export const SessionPauseCommand = Schema.Struct({
  type: Schema.Literal("thread.pause"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});
export type SessionPauseCommand = typeof SessionPauseCommand.Type;

export const SessionResumeCommand = Schema.Struct({
  type: Schema.Literal("thread.resume"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});
export type SessionResumeCommand = typeof SessionResumeCommand.Type;

export const SessionRecoverCommand = Schema.Struct({
  type: Schema.Literal("thread.recover"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});
export type SessionRecoverCommand = typeof SessionRecoverCommand.Type;

export const SessionCancelCommand = Schema.Struct({
  type: Schema.Literal("thread.cancel"),
  commandId: CommandId,
  threadId: ThreadId,
  reason: Schema.optional(Schema.String),
  createdAt: IsoDateTime,
});
export type SessionCancelCommand = typeof SessionCancelCommand.Type;

export const SessionRestartCommand = Schema.Struct({
  type: Schema.Literal("thread.restart"),
  commandId: CommandId,
  threadId: ThreadId,
  fromPhaseId: Schema.optional(WorkflowPhaseId),
  createdAt: IsoDateTime,
});
export type SessionRestartCommand = typeof SessionRestartCommand.Type;

export const SessionMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.meta-update"),
  commandId: CommandId,
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  createdAt: IsoDateTime,
});
export type SessionMetaUpdateCommand = typeof SessionMetaUpdateCommand.Type;

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

const ThreadSummaryRequestCommand = Schema.Struct({
  type: Schema.Literal("thread.summary.request"),
  commandId: CommandId,
  threadId: ThreadId,
  modelSelection: ModelSelection,
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

export const SessionSendTurnCommand = Schema.Struct({
  type: Schema.Literal("thread.send-turn"),
  commandId: CommandId,
  threadId: ThreadId,
  content: Schema.String,
  attachments: Schema.optional(Schema.Array(Schema.Unknown)),
  createdAt: IsoDateTime,
});
export type SessionSendTurnCommand = typeof SessionSendTurnCommand.Type;

export const SessionRestartTurnCommand = Schema.Struct({
  type: Schema.Literal("thread.restart-turn"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});
export type SessionRestartTurnCommand = typeof SessionRestartTurnCommand.Type;

export const SessionSendMessageCommand = Schema.Struct({
  type: Schema.Literal("thread.send-message"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  role: TrimmedNonEmptyString,
  content: Schema.String,
  createdAt: IsoDateTime,
});
export type SessionSendMessageCommand = typeof SessionSendMessageCommand.Type;

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

export const ChannelMarkConcludedCommand = Schema.Struct({
  type: Schema.Literal("channel.mark-concluded"),
  commandId: CommandId,
  channelId: ChannelId,
  createdAt: IsoDateTime,
});
export type ChannelMarkConcludedCommand = typeof ChannelMarkConcludedCommand.Type;

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

export const DesignOptionSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  description: Schema.String,
  artifactId: DesignArtifactId,
  artifactPath: Schema.String,
});
export type DesignOptionSchema = typeof DesignOptionSchema.Type;

export const ThreadDesignArtifactRenderedCommand = Schema.Struct({
  type: Schema.Literal("thread.design.artifact-rendered"),
  commandId: CommandId,
  threadId: ThreadId,
  artifactId: DesignArtifactId,
  title: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  artifactPath: Schema.String,
  createdAt: IsoDateTime,
});
export type ThreadDesignArtifactRenderedCommand = typeof ThreadDesignArtifactRenderedCommand.Type;

export const ThreadDesignOptionsPresentedCommand = Schema.Struct({
  type: Schema.Literal("thread.design.options-presented"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: InteractiveRequestId,
  prompt: Schema.String,
  options: Schema.Array(DesignOptionSchema),
  createdAt: IsoDateTime,
});
export type ThreadDesignOptionsPresentedCommand = typeof ThreadDesignOptionsPresentedCommand.Type;

export const ThreadDesignOptionChosenCommand = Schema.Struct({
  type: Schema.Literal("thread.design.option-chosen"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: InteractiveRequestId,
  chosenOptionId: TrimmedNonEmptyString,
  chosenTitle: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type ThreadDesignOptionChosenCommand = typeof ThreadDesignOptionChosenCommand.Type;

const DispatchableClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadForkCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadPinCommand,
  ThreadUnpinCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadSessionStopCommand,
  ThreadSummaryRequestCommand,
]);
export type DispatchableClientOrchestrationCommand =
  typeof DispatchableClientOrchestrationCommand.Type;

export const ClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadForkCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadPinCommand,
  ThreadUnpinCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ClientThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadSessionStopCommand,
  ThreadSummaryRequestCommand,
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

const ThreadMessageAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.message.append"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: OrchestrationMessageRole,
    text: Schema.String,
    attachments: Schema.optional(Schema.Array(ChatAttachment)),
    attribution: Schema.optional(OrchestrationMessageAttribution),
  }),
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

const ThreadAgentDiffUpsertCommand = Schema.Struct({
  type: Schema.Literal("thread.agent-diff.upsert"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  diff: Schema.String,
  files: Schema.Array(OrchestrationCheckpointFile),
  source: OrchestrationAgentDiffSource,
  coverage: OrchestrationAgentDiffCoverage,
  assistantMessageId: Schema.optional(MessageId),
  completedAt: IsoDateTime,
  createdAt: IsoDateTime,
});

const ThreadActivityAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.activity.append"),
  commandId: CommandId,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  createdAt: IsoDateTime,
});

const ThreadActivityInlineDiffUpsertCommand = Schema.Struct({
  type: Schema.Literal("thread.activity.inline-diff.upsert"),
  commandId: CommandId,
  threadId: ThreadId,
  activityId: EventId,
  inlineDiff: OrchestrationToolInlineDiff,
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
  ThreadMessageAppendCommand,
  ThreadProposedPlanUpsertCommand,
  ThreadTurnDiffCompleteCommand,
  ThreadAgentDiffUpsertCommand,
  ThreadActivityAppendCommand,
  ThreadActivityInlineDiffUpsertCommand,
  ThreadRevertCompleteCommand,
]);
export type InternalOrchestrationCommand = typeof InternalOrchestrationCommand.Type;

const ForgeDispatchableClientOrchestrationCommand = Schema.Union([
  DispatchableClientOrchestrationCommand,
  SessionCreateCommand,
  SessionPauseCommand,
  SessionResumeCommand,
  SessionCancelCommand,
  SessionRestartCommand,
  SessionMetaUpdateCommand,
  SessionSendTurnCommand,
  SessionRestartTurnCommand,
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
  SessionRecoverCommand,
  SessionSendMessageCommand,
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
  ChannelMarkConcludedCommand,
  ChannelCloseCommand,
  RequestOpenCommand,
  RequestMarkStaleCommand,
  ThreadDesignArtifactRenderedCommand,
  ThreadDesignOptionsPresentedCommand,
  ThreadDesignOptionChosenCommand,
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
