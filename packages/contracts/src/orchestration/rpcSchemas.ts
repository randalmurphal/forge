import { Option, Schema, SchemaIssue, Struct } from "effect";
import {
  CheckpointRef,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProviderItemId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "../baseSchemas";
import { ProviderApprovalDecision } from "../providerSchemas";
import { ClientOrchestrationCommand } from "./commands";
import { ForgeEvent } from "./events";
import {
  OrchestrationClientSnapshot,
  OrchestrationReadModel,
  OrchestrationThreadDetailSnapshot,
} from "./readModels";
import {
  OrchestrationAgentDiffCoverage,
  OrchestrationAgentDiffSource,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointStatus,
  OrchestrationThreadActivity,
} from "./types";

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

export const OrchestrationGetClientSnapshotInput = Schema.Struct({});
export type OrchestrationGetClientSnapshotInput = typeof OrchestrationGetClientSnapshotInput.Type;
const OrchestrationGetClientSnapshotResult = OrchestrationClientSnapshot;
export type OrchestrationGetClientSnapshotResult = typeof OrchestrationGetClientSnapshotResult.Type;

export const OrchestrationGetThreadDetailInput = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestrationGetThreadDetailInput = typeof OrchestrationGetThreadDetailInput.Type;
const OrchestrationGetThreadDetailResult = OrchestrationThreadDetailSnapshot;
export type OrchestrationGetThreadDetailResult = typeof OrchestrationGetThreadDetailResult.Type;

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

export const CommandOutputSource = Schema.Literals(["final", "stream"]);
export type CommandOutputSource = typeof CommandOutputSource.Type;

export const OrchestrationGetCommandOutputInput = Schema.Struct({
  threadId: ThreadId,
  activityId: EventId,
  toolCallId: Schema.optional(ProviderItemId),
});
export type OrchestrationGetCommandOutputInput = typeof OrchestrationGetCommandOutputInput.Type;

export const OrchestrationGetCommandOutputResult = Schema.Struct({
  threadId: ThreadId,
  activityId: EventId,
  toolCallId: ProviderItemId,
  output: Schema.String,
  source: CommandOutputSource,
  omittedLineCount: NonNegativeInt,
});
export type OrchestrationGetCommandOutputResult = typeof OrchestrationGetCommandOutputResult.Type;

export const OrchestrationGetSubagentActivityFeedInput = Schema.Struct({
  threadId: ThreadId,
  childProviderThreadId: TrimmedNonEmptyString,
});
export type OrchestrationGetSubagentActivityFeedInput =
  typeof OrchestrationGetSubagentActivityFeedInput.Type;

export const OrchestrationGetSubagentActivityFeedResult = Schema.Struct({
  threadId: ThreadId,
  childProviderThreadId: TrimmedNonEmptyString,
  activities: Schema.Array(Schema.suspend(() => OrchestrationThreadActivity)),
  omittedActivityCount: NonNegativeInt,
});
export type OrchestrationGetSubagentActivityFeedResult =
  typeof OrchestrationGetSubagentActivityFeedResult.Type;

export const OrchestrationGetTurnAgentDiffInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});
export type OrchestrationGetTurnAgentDiffInput = typeof OrchestrationGetTurnAgentDiffInput.Type;

export const OrchestrationGetTurnAgentDiffResult = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  diff: Schema.String,
  files: Schema.Array(OrchestrationCheckpointFile),
  source: OrchestrationAgentDiffSource,
  coverage: OrchestrationAgentDiffCoverage,
  completedAt: IsoDateTime,
});
export type OrchestrationGetTurnAgentDiffResult = typeof OrchestrationGetTurnAgentDiffResult.Type;

export const OrchestrationGetFullThreadAgentDiffInput = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestrationGetFullThreadAgentDiffInput =
  typeof OrchestrationGetFullThreadAgentDiffInput.Type;

export const OrchestrationGetFullThreadAgentDiffResult = Schema.Struct({
  threadId: ThreadId,
  diff: Schema.String,
  files: Schema.Array(OrchestrationCheckpointFile),
  coverage: OrchestrationAgentDiffCoverage,
});
export type OrchestrationGetFullThreadAgentDiffResult =
  typeof OrchestrationGetFullThreadAgentDiffResult.Type;

export const OrchestrationReplayEventsInput = Schema.Struct({
  fromSequenceExclusive: NonNegativeInt,
});
export type OrchestrationReplayEventsInput = typeof OrchestrationReplayEventsInput.Type;

const OrchestrationReplayEventsResult = Schema.Array(Schema.suspend(() => ForgeEvent));
export type OrchestrationReplayEventsResult = typeof OrchestrationReplayEventsResult.Type;

export const OrchestrationRpcSchemas = {
  getSnapshot: {
    input: OrchestrationGetSnapshotInput,
    output: OrchestrationGetSnapshotResult,
  },
  getClientSnapshot: {
    input: OrchestrationGetClientSnapshotInput,
    output: OrchestrationGetClientSnapshotResult,
  },
  getThreadDetail: {
    input: OrchestrationGetThreadDetailInput,
    output: OrchestrationGetThreadDetailResult,
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
  getCommandOutput: {
    input: OrchestrationGetCommandOutputInput,
    output: OrchestrationGetCommandOutputResult,
  },
  getSubagentActivityFeed: {
    input: OrchestrationGetSubagentActivityFeedInput,
    output: OrchestrationGetSubagentActivityFeedResult,
  },
  getTurnAgentDiff: {
    input: OrchestrationGetTurnAgentDiffInput,
    output: OrchestrationGetTurnAgentDiffResult,
  },
  getFullThreadAgentDiff: {
    input: OrchestrationGetFullThreadAgentDiffInput,
    output: OrchestrationGetFullThreadAgentDiffResult,
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

export class OrchestrationGetCommandOutputError extends Schema.TaggedErrorClass<OrchestrationGetCommandOutputError>()(
  "OrchestrationGetCommandOutputError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class OrchestrationGetSubagentActivityFeedError extends Schema.TaggedErrorClass<OrchestrationGetSubagentActivityFeedError>()(
  "OrchestrationGetSubagentActivityFeedError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class OrchestrationGetTurnAgentDiffError extends Schema.TaggedErrorClass<OrchestrationGetTurnAgentDiffError>()(
  "OrchestrationGetTurnAgentDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class OrchestrationGetFullThreadAgentDiffError extends Schema.TaggedErrorClass<OrchestrationGetFullThreadAgentDiffError>()(
  "OrchestrationGetFullThreadAgentDiffError",
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
