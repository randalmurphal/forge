import { Schema } from "effect";
import {
  ChannelId,
  InteractiveRequestId,
  IsoDateTime,
  NonNegativeInt,
  PhaseRunId,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  WorkflowId,
  WorkflowPhaseId,
} from "../baseSchemas";
import { Channel, ChannelStatus, ChannelType } from "../channel";
import { InteractiveRequest, InteractiveRequestType } from "../interactiveRequest";
import { ModelSelection, ProviderKind } from "../providerSchemas";
import { PhaseRunStatus, PhaseType } from "../workflow";
import {
  OrchestrationProject,
  OrchestrationReadModelPhaseRun,
  OrchestrationReadModelWorkflow,
  OrchestrationThreadDetail,
  OrchestrationThreadSummary,
  OrchestrationThread,
  ProjectScript,
  RuntimeMode,
  ForgeSessionType,
} from "./types";

export const SessionStatus = Schema.Literals([
  "created",
  "running",
  "needs-attention",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
export type SessionStatus = typeof SessionStatus.Type;

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

const ForgeReadModelProject = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModel: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});

const ForgeReadModelSession = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  parentThreadId: Schema.NullOr(ThreadId),
  phaseRunId: Schema.NullOr(PhaseRunId),
  sessionType: ForgeSessionType,
  title: TrimmedNonEmptyString,
  description: Schema.String,
  status: SessionStatus,
  role: Schema.NullOr(TrimmedNonEmptyString),
  provider: Schema.NullOr(ProviderKind),
  model: Schema.NullOr(ModelSelection),
  runtimeMode: RuntimeMode,
  workflowId: Schema.NullOr(WorkflowId),
  currentPhaseId: Schema.NullOr(WorkflowPhaseId),
  discussionId: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  bootstrapStatus: Schema.NullOr(TrimmedNonEmptyString),
  childThreadIds: Schema.Array(ThreadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});

const ForgeReadModelPhaseRun = Schema.Struct({
  phaseRunId: PhaseRunId,
  threadId: ThreadId,
  workflowId: WorkflowId,
  phaseId: WorkflowPhaseId,
  phaseName: TrimmedNonEmptyString,
  phaseType: PhaseType,
  iteration: PositiveInt,
  status: PhaseRunStatus,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});

const ForgeReadModelChannel = Schema.Struct({
  channelId: ChannelId,
  threadId: ThreadId,
  channelType: ChannelType,
  status: ChannelStatus,
});

const ForgeReadModelPendingRequest = Schema.Struct({
  requestId: InteractiveRequestId,
  threadId: ThreadId,
  childThreadId: Schema.NullOr(ThreadId),
  requestType: InteractiveRequestType,
  status: InteractiveRequest.fields.status,
});

export const WorkflowSummary = Schema.Struct({
  workflowId: WorkflowId,
  name: TrimmedNonEmptyString,
  description: Schema.String,
  builtIn: Schema.Boolean,
  projectId: Schema.NullOr(ProjectId).pipe(Schema.withDecodingDefault(() => null)),
  hasDeliberation: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
});
export type WorkflowSummary = typeof WorkflowSummary.Type;

export const ForgeReadModel = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(ForgeReadModelProject),
  sessions: Schema.Array(ForgeReadModelSession),
  phaseRuns: Schema.Array(ForgeReadModelPhaseRun),
  channels: Schema.Array(ForgeReadModelChannel),
  pendingRequests: Schema.Array(ForgeReadModelPendingRequest),
  workflows: Schema.Array(WorkflowSummary),
  updatedAt: IsoDateTime,
});
export type ForgeReadModel = typeof ForgeReadModel.Type;

export const SessionSummary = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  parentThreadId: Schema.NullOr(ThreadId),
  sessionType: ForgeSessionType,
  title: TrimmedNonEmptyString,
  status: SessionStatus,
  role: Schema.NullOr(TrimmedNonEmptyString),
  provider: Schema.NullOr(ProviderKind),
  model: Schema.NullOr(ModelSelection),
  runtimeMode: RuntimeMode,
  workflowId: Schema.NullOr(WorkflowId),
  currentPhaseId: Schema.NullOr(WorkflowPhaseId),
  discussionId: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  bootstrapStatus: Schema.NullOr(TrimmedNonEmptyString),
  childThreadIds: Schema.Array(ThreadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type SessionSummary = typeof SessionSummary.Type;

const ForgeClientSnapshotPhaseRun = Schema.Struct({
  phaseRunId: PhaseRunId,
  threadId: ThreadId,
  phaseName: TrimmedNonEmptyString,
  phaseType: PhaseType,
  iteration: PositiveInt,
  status: PhaseRunStatus,
});

const ForgeClientSnapshotChannel = Schema.Struct({
  channelId: ChannelId,
  threadId: ThreadId,
  channelType: ChannelType,
  status: ChannelStatus,
  phaseRunId: Schema.NullOr(PhaseRunId),
});

const ForgeClientSnapshotPendingRequest = Schema.Struct({
  requestId: InteractiveRequestId,
  threadId: ThreadId,
  requestType: InteractiveRequestType,
  status: InteractiveRequest.fields.status,
});

export const ForgeClientSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProject),
  sessions: Schema.Array(SessionSummary),
  phaseRuns: Schema.Array(ForgeClientSnapshotPhaseRun),
  channels: Schema.Array(ForgeClientSnapshotChannel),
  pendingRequests: Schema.Array(ForgeClientSnapshotPendingRequest),
  workflows: Schema.Array(WorkflowSummary),
  updatedAt: IsoDateTime,
});
export type ForgeClientSnapshot = typeof ForgeClientSnapshot.Type;

export const OrchestrationClientSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProject),
  threads: Schema.Array(OrchestrationThreadSummary),
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
export type OrchestrationClientSnapshot = typeof OrchestrationClientSnapshot.Type;

export const OrchestrationThreadDetailSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  thread: OrchestrationThreadDetail,
  updatedAt: IsoDateTime,
});
export type OrchestrationThreadDetailSnapshot = typeof OrchestrationThreadDetailSnapshot.Type;
