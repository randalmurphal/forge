import { Schema } from "effect";
import {
  InteractiveRequestId,
  IsoDateTime,
  PhaseRunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { ProviderApprovalDecision } from "./providerSchemas";
import { QualityCheckResult } from "./workflow";

export const InteractiveRequestType = Schema.Literals([
  "approval",
  "user-input",
  "gate",
  "bootstrap-failed",
  "correction-needed",
  "design-option",
]);
export type InteractiveRequestType = typeof InteractiveRequestType.Type;

export const InteractiveRequestStatus = Schema.Literals(["pending", "resolved", "stale"]);
export type InteractiveRequestStatus = typeof InteractiveRequestStatus.Type;

export const ApprovalRequestPayload = Schema.Struct({
  type: Schema.Literal("approval"),
  requestType: TrimmedNonEmptyString,
  detail: Schema.String,
  toolName: TrimmedNonEmptyString,
  toolInput: Schema.Record(Schema.String, Schema.Unknown),
  suggestions: Schema.optional(Schema.Array(Schema.String)),
});
export type ApprovalRequestPayload = typeof ApprovalRequestPayload.Type;

export const ApprovalRequestResolution = Schema.Struct({
  decision: ProviderApprovalDecision,
  updatedPermissions: Schema.optional(Schema.Array(Schema.String)),
});
export type ApprovalRequestResolution = typeof ApprovalRequestResolution.Type;

export const UserInputQuestion = Schema.Struct({
  id: TrimmedNonEmptyString,
  question: Schema.String,
  options: Schema.optional(Schema.Array(Schema.String)),
  multiSelect: Schema.optional(Schema.Boolean),
});
export type UserInputQuestion = typeof UserInputQuestion.Type;

export const UserInputRequestPayload = Schema.Struct({
  type: Schema.Literal("user-input"),
  questions: Schema.Array(UserInputQuestion),
});
export type UserInputRequestPayload = typeof UserInputRequestPayload.Type;

export const UserInputRequestResolution = Schema.Struct({
  answers: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)])),
});
export type UserInputRequestResolution = typeof UserInputRequestResolution.Type;

export const GateRequestPayload = Schema.Struct({
  type: Schema.Literal("gate"),
  gateType: TrimmedNonEmptyString,
  phaseRunId: PhaseRunId,
  phaseOutput: Schema.optional(Schema.String),
  qualityCheckResults: Schema.optional(Schema.Array(QualityCheckResult)),
});
export type GateRequestPayload = typeof GateRequestPayload.Type;

export const GateRequestResolution = Schema.Struct({
  decision: Schema.Literals(["approve", "reject"]),
  correction: Schema.optional(Schema.String),
});
export type GateRequestResolution = typeof GateRequestResolution.Type;

export const BootstrapFailedRequestPayload = Schema.Struct({
  type: Schema.Literal("bootstrap-failed"),
  error: Schema.String,
  stdout: Schema.String,
  command: TrimmedNonEmptyString,
});
export type BootstrapFailedRequestPayload = typeof BootstrapFailedRequestPayload.Type;

export const BootstrapFailedRequestResolution = Schema.Struct({
  action: Schema.Literals(["retry", "skip", "fail"]),
});
export type BootstrapFailedRequestResolution = typeof BootstrapFailedRequestResolution.Type;

export const CorrectionNeededRequestPayload = Schema.Struct({
  type: Schema.Literal("correction-needed"),
  reason: Schema.String,
  context: Schema.optional(Schema.String),
});
export type CorrectionNeededRequestPayload = typeof CorrectionNeededRequestPayload.Type;

export const CorrectionNeededRequestResolution = Schema.Struct({
  correction: Schema.String,
});
export type CorrectionNeededRequestResolution = typeof CorrectionNeededRequestResolution.Type;

export const DesignOptionRequestPayload = Schema.Struct({
  type: Schema.Literal("design-option"),
  prompt: Schema.String,
  options: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      title: TrimmedNonEmptyString,
      description: Schema.String,
      artifactId: TrimmedNonEmptyString,
      artifactPath: Schema.String,
    }),
  ),
});
export type DesignOptionRequestPayload = typeof DesignOptionRequestPayload.Type;

export const DesignOptionRequestResolution = Schema.Struct({
  chosenOptionId: TrimmedNonEmptyString,
});
export type DesignOptionRequestResolution = typeof DesignOptionRequestResolution.Type;

export const InteractiveRequestPayload = Schema.Union([
  ApprovalRequestPayload,
  UserInputRequestPayload,
  GateRequestPayload,
  BootstrapFailedRequestPayload,
  CorrectionNeededRequestPayload,
  DesignOptionRequestPayload,
]);
export type InteractiveRequestPayload = typeof InteractiveRequestPayload.Type;

export const InteractiveRequestResolution = Schema.Union([
  ApprovalRequestResolution,
  UserInputRequestResolution,
  GateRequestResolution,
  BootstrapFailedRequestResolution,
  CorrectionNeededRequestResolution,
  DesignOptionRequestResolution,
]);
export type InteractiveRequestResolution = typeof InteractiveRequestResolution.Type;

export const InteractiveRequest = Schema.Struct({
  id: InteractiveRequestId,
  threadId: ThreadId,
  childThreadId: Schema.optional(ThreadId),
  phaseRunId: Schema.optional(PhaseRunId),
  type: InteractiveRequestType,
  status: InteractiveRequestStatus,
  payload: InteractiveRequestPayload,
  resolvedWith: Schema.optional(InteractiveRequestResolution),
  createdAt: IsoDateTime,
  resolvedAt: Schema.optional(IsoDateTime),
  staleReason: Schema.optional(Schema.String),
});
export type InteractiveRequest = typeof InteractiveRequest.Type;
