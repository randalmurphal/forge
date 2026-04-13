import { Option, Schema, SchemaIssue } from "effect";
import {
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
  ProviderItemId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
  WorkflowId,
  WorkflowPhaseId,
} from "../baseSchemas";
import { ChannelMessage, ChannelParticipantType, ChannelStatus, ChannelType } from "../channel";
import {
  InteractiveRequestPayload,
  InteractiveRequestResolution,
  InteractiveRequestType,
} from "../interactiveRequest";
import { ModelSelection, ProviderKind } from "../providerSchemas";
import {
  GateAfter,
  GateResult,
  PhaseType,
  QualityCheckReference,
  QualityCheckResult,
} from "../workflow";
import { DesignOptionSchema, LinkType, PhaseOutputEntry } from "./commands";
import { SessionStatus } from "./readModels";
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
  RuntimeMode,
  SourceProposedPlanReference,
  ThreadSpawnMode,
  ForgeSessionType,
} from "./types";

export const OrchestrationEventType = Schema.Literals([
  "project.created",
  "project.meta-updated",
  "project.deleted",
  "thread.created",
  "thread.deleted",
  "thread.archived",
  "thread.unarchived",
  "thread.pinned",
  "thread.unpinned",
  "thread.meta-updated",
  "thread.runtime-mode-set",
  "thread.interaction-mode-set",
  "thread.message-sent",
  "thread.turn-start-requested",
  "thread.turn-interrupt-requested",
  "thread.interactive-request-response-requested",
  "thread.checkpoint-revert-requested",
  "thread.reverted",
  "thread.session-stop-requested",
  "thread.summary-requested",
  "thread.session-set",
  "thread.proposed-plan-upserted",
  "thread.turn-diff-completed",
  "thread.agent-diff-upserted",
  "thread.activity-appended",
  "thread.activity-inline-diff-upserted",
  "thread.forked",
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
  spawnMode: Schema.optional(ThreadSpawnMode),
  spawnBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  spawnWorktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  workflowId: Schema.NullOr(WorkflowId).pipe(Schema.withDecodingDefault(() => null)),
  discussionId: Schema.NullOr(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(() => null)),
  discussionRoleModels: Schema.optional(Schema.Record(Schema.String, ModelSelection)),
  parentThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(() => null)),
  forkedFromThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(() => null)),
  role: Schema.NullOr(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(() => null)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const SessionCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  parentThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(() => null)),
  phaseRunId: Schema.NullOr(PhaseRunId).pipe(Schema.withDecodingDefault(() => null)),
  sessionType: ForgeSessionType,
  title: TrimmedNonEmptyString,
  description: Schema.String.pipe(Schema.withDecodingDefault(() => "")),
  workflowId: Schema.NullOr(WorkflowId).pipe(Schema.withDecodingDefault(() => null)),
  workflowSnapshot: Schema.optional(Schema.String),
  discussionId: Schema.NullOr(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(() => null)),
  runtimeMode: RuntimeMode,
  model: Schema.NullOr(ModelSelection).pipe(Schema.withDecodingDefault(() => null)),
  provider: Schema.NullOr(ProviderKind).pipe(Schema.withDecodingDefault(() => null)),
  role: Schema.NullOr(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(() => null)),
  branch: Schema.NullOr(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(() => null)),
  bootstrapStatus: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SessionCreatedPayload = typeof SessionCreatedPayload.Type;

export const ThreadDeletedPayload = Schema.Struct({
  threadId: ThreadId,
  deletedAt: IsoDateTime,
});

export const SessionStatusChangedPayload = Schema.Struct({
  threadId: ThreadId,
  status: SessionStatus,
  previousStatus: SessionStatus,
  updatedAt: IsoDateTime,
});
export type SessionStatusChangedPayload = typeof SessionStatusChangedPayload.Type;

export const SessionCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  completedAt: IsoDateTime,
});
export type SessionCompletedPayload = typeof SessionCompletedPayload.Type;

export const SessionFailedPayload = Schema.Struct({
  threadId: ThreadId,
  error: Schema.String,
  failedAt: IsoDateTime,
});
export type SessionFailedPayload = typeof SessionFailedPayload.Type;

export const SessionCancelledPayload = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.optional(Schema.String),
  cancelledAt: IsoDateTime,
});
export type SessionCancelledPayload = typeof SessionCancelledPayload.Type;

export const ThreadArchivedPayload = Schema.Struct({
  threadId: ThreadId,
  archivedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const SessionArchivedPayload = Schema.Struct({
  threadId: ThreadId,
  archivedAt: IsoDateTime,
});
export type SessionArchivedPayload = typeof SessionArchivedPayload.Type;

export const ThreadUnarchivedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});

export const SessionUnarchivedPayload = ThreadUnarchivedPayload;
export type SessionUnarchivedPayload = typeof SessionUnarchivedPayload.Type;

export const ThreadPinnedPayload = Schema.Struct({
  threadId: ThreadId,
  pinnedAt: IsoDateTime,
});

export const ThreadUnpinnedPayload = Schema.Struct({
  threadId: ThreadId,
  unpinnedAt: IsoDateTime,
});

export const ThreadMetaUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(Schema.String),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  updatedAt: IsoDateTime,
});
export const SessionMetaUpdatedPayload = ThreadMetaUpdatedPayload;
export type SessionMetaUpdatedPayload = typeof SessionMetaUpdatedPayload.Type;

export const SessionRestartedPayload = Schema.Struct({
  threadId: ThreadId,
  fromPhaseId: Schema.optional(WorkflowPhaseId),
  restartedAt: IsoDateTime,
});
export type SessionRestartedPayload = typeof SessionRestartedPayload.Type;

export const SessionTurnRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  content: Schema.String,
  createdAt: IsoDateTime,
});
export type SessionTurnRequestedPayload = typeof SessionTurnRequestedPayload.Type;

export const SessionTurnStartedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  startedAt: IsoDateTime,
});
export type SessionTurnStartedPayload = typeof SessionTurnStartedPayload.Type;

export const SessionTurnCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  completedAt: IsoDateTime,
});
export type SessionTurnCompletedPayload = typeof SessionTurnCompletedPayload.Type;

export const SessionTurnRestartedPayload = Schema.Struct({
  threadId: ThreadId,
  restartedAt: IsoDateTime,
});
export type SessionTurnRestartedPayload = typeof SessionTurnRestartedPayload.Type;

export const SessionMessageSentPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  role: TrimmedNonEmptyString,
  content: Schema.String,
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type SessionMessageSentPayload = typeof SessionMessageSentPayload.Type;

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
  attribution: Schema.optional(OrchestrationMessageAttribution),
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

export const ThreadInteractiveRequestResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: InteractiveRequestId,
  resolution: InteractiveRequestResolution,
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

export const ThreadSummaryRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  modelSelection: ModelSelection,
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

export const ThreadAgentDiffUpsertedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  diff: Schema.String,
  files: Schema.Array(OrchestrationCheckpointFile),
  source: OrchestrationAgentDiffSource,
  coverage: OrchestrationAgentDiffCoverage,
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});

export const SessionCheckpointCapturedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  turnCount: NonNegativeInt,
  ref: TrimmedNonEmptyString,
  capturedAt: IsoDateTime,
});
export type SessionCheckpointCapturedPayload = typeof SessionCheckpointCapturedPayload.Type;

export const SessionCheckpointDiffCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
  diff: Schema.String,
  files: Schema.Array(OrchestrationCheckpointFile),
  completedAt: IsoDateTime,
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (payload) =>
        payload.fromTurnCount <= payload.toTurnCount ||
        new SchemaIssue.InvalidValue(Option.some(payload.fromTurnCount), {
          message: "fromTurnCount must be less than or equal to toTurnCount",
        }),
      { identifier: "SessionCheckpointDiffCompletedPayload" },
    ),
  ),
);
export type SessionCheckpointDiffCompletedPayload =
  typeof SessionCheckpointDiffCompletedPayload.Type;

export const SessionCheckpointRevertedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  revertedAt: IsoDateTime,
});
export type SessionCheckpointRevertedPayload = typeof SessionCheckpointRevertedPayload.Type;

export const ThreadActivityAppendedPayload = Schema.Struct({
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
});

export const ThreadActivityInlineDiffUpsertedPayload = Schema.Struct({
  threadId: ThreadId,
  activityId: EventId,
  inlineDiff: OrchestrationToolInlineDiff,
  updatedAt: IsoDateTime,
});
export type ThreadActivityInlineDiffUpsertedPayload =
  typeof ThreadActivityInlineDiffUpsertedPayload.Type;

export const ThreadForkedPayload = Schema.Struct({
  threadId: ThreadId,
  sourceThreadId: ThreadId,
  projectId: ProjectId,
  createdAt: IsoDateTime,
});
export type ThreadForkedPayload = typeof ThreadForkedPayload.Type;

export const OrchestrationEventMetadata = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(ProviderItemId),
  adapterKey: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(InteractiveRequestId),
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
    type: Schema.Literal("thread.pinned"),
    payload: ThreadPinnedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unpinned"),
    payload: ThreadUnpinnedPayload,
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
    type: Schema.Literal("thread.interactive-request-response-requested"),
    payload: ThreadInteractiveRequestResponseRequestedPayload,
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
    type: Schema.Literal("thread.summary-requested"),
    payload: ThreadSummaryRequestedPayload,
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
    type: Schema.Literal("thread.agent-diff-upserted"),
    payload: ThreadAgentDiffUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.activity-appended"),
    payload: ThreadActivityAppendedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.activity-inline-diff-upserted"),
    payload: ThreadActivityInlineDiffUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.forked"),
    payload: ThreadForkedPayload,
  }),
]);
export type OrchestrationEvent = typeof OrchestrationEvent.Type;

export const ForgeEventType = Schema.Union([
  OrchestrationEventType,
  Schema.Literals([
    "thread.status-changed",
    "thread.completed",
    "thread.failed",
    "thread.cancelled",
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
    "thread.turn-requested",
    "thread.turn-started",
    "thread.turn-completed",
    "thread.turn-restarted",
    "thread.link-added",
    "thread.link-removed",
    "thread.restarted",
    "thread.promoted",
    "thread.dependency-added",
    "thread.dependency-removed",
    "thread.dependencies-satisfied",
    "thread.synthesis-completed",
    "thread.checkpoint-captured",
    "thread.checkpoint-diff-completed",
    "thread.checkpoint-reverted",
    "channel.created",
    "channel.message-posted",
    "channel.messages-read",
    "channel.conclusion-proposed",
    "channel.concluded",
    "channel.closed",
    "request.opened",
    "request.resolved",
    "request.stale",
    "thread.design.artifact-rendered",
    "thread.design.options-presented",
    "thread.design.option-chosen",
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

export const ThreadDesignArtifactRenderedPayload = Schema.Struct({
  threadId: ThreadId,
  artifactId: DesignArtifactId,
  title: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  artifactPath: Schema.String,
  renderedAt: IsoDateTime,
});
export type ThreadDesignArtifactRenderedPayload = typeof ThreadDesignArtifactRenderedPayload.Type;

export const ThreadDesignOptionsPresentedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: InteractiveRequestId,
  prompt: Schema.String,
  options: Schema.Array(DesignOptionSchema),
  presentedAt: IsoDateTime,
});
export type ThreadDesignOptionsPresentedPayload = typeof ThreadDesignOptionsPresentedPayload.Type;

export const ThreadDesignOptionChosenPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: InteractiveRequestId,
  chosenOptionId: TrimmedNonEmptyString,
  chosenTitle: TrimmedNonEmptyString,
  chosenAt: IsoDateTime,
});
export type ThreadDesignOptionChosenPayload = typeof ThreadDesignOptionChosenPayload.Type;

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
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.created"),
    payload: SessionCreatedPayload,
  }),
  OrchestrationEvent,
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.status-changed"),
    payload: SessionStatusChangedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.completed"),
    payload: SessionCompletedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.failed"),
    payload: SessionFailedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.cancelled"),
    payload: SessionCancelledPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.archived"),
    payload: SessionArchivedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.restarted"),
    payload: SessionRestartedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.turn-requested"),
    payload: SessionTurnRequestedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.turn-started"),
    payload: SessionTurnStartedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.turn-completed"),
    payload: SessionTurnCompletedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.turn-restarted"),
    payload: SessionTurnRestartedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.message-sent"),
    payload: SessionMessageSentPayload,
  }),
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
    type: Schema.Literal("thread.checkpoint-captured"),
    payload: SessionCheckpointCapturedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.checkpoint-diff-completed"),
    payload: SessionCheckpointDiffCompletedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.checkpoint-reverted"),
    payload: SessionCheckpointRevertedPayload,
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
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.design.artifact-rendered"),
    payload: ThreadDesignArtifactRenderedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.design.options-presented"),
    payload: ThreadDesignOptionsPresentedPayload,
  }),
  Schema.Struct({
    ...ForgeEventBaseFields,
    type: Schema.Literal("thread.design.option-chosen"),
    payload: ThreadDesignOptionChosenPayload,
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
