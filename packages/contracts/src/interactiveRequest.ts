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
  "permission",
  "mcp-elicitation",
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

export const UserInputQuestionOption = Schema.Struct({
  label: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
});
export type UserInputQuestionOption = typeof UserInputQuestionOption.Type;

export const UserInputQuestion = Schema.Struct({
  id: TrimmedNonEmptyString,
  header: TrimmedNonEmptyString,
  question: Schema.String,
  options: Schema.Array(UserInputQuestionOption),
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

export const AdditionalFileSystemPermissions = Schema.Struct({
  read: Schema.NullOr(Schema.Array(Schema.String)),
  write: Schema.NullOr(Schema.Array(Schema.String)),
});
export type AdditionalFileSystemPermissions = typeof AdditionalFileSystemPermissions.Type;

export const AdditionalNetworkPermissions = Schema.Struct({
  enabled: Schema.NullOr(Schema.Boolean),
});
export type AdditionalNetworkPermissions = typeof AdditionalNetworkPermissions.Type;

export const RequestPermissionProfile = Schema.Struct({
  network: Schema.NullOr(AdditionalNetworkPermissions),
  fileSystem: Schema.NullOr(AdditionalFileSystemPermissions),
});
export type RequestPermissionProfile = typeof RequestPermissionProfile.Type;

export const GrantedPermissionProfile = Schema.Struct({
  network: Schema.optional(AdditionalNetworkPermissions),
  fileSystem: Schema.optional(AdditionalFileSystemPermissions),
});
export type GrantedPermissionProfile = typeof GrantedPermissionProfile.Type;

export const PermissionGrantScope = Schema.Literals(["turn", "session"]);
export type PermissionGrantScope = typeof PermissionGrantScope.Type;

export const PermissionRequestPayload = Schema.Struct({
  type: Schema.Literal("permission"),
  reason: Schema.NullOr(Schema.String),
  permissions: RequestPermissionProfile,
});
export type PermissionRequestPayload = typeof PermissionRequestPayload.Type;

export const PermissionRequestResolution = Schema.Struct({
  scope: PermissionGrantScope,
  permissions: GrantedPermissionProfile,
});
export type PermissionRequestResolution = typeof PermissionRequestResolution.Type;

export const McpElicitationAction = Schema.Literals(["accept", "decline", "cancel"]);
export type McpElicitationAction = typeof McpElicitationAction.Type;

export const McpElicitationQuestionOption = Schema.Struct({
  label: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
});
export type McpElicitationQuestionOption = typeof McpElicitationQuestionOption.Type;

export const McpElicitationQuestion = Schema.Struct({
  id: TrimmedNonEmptyString,
  header: TrimmedNonEmptyString,
  question: TrimmedNonEmptyString,
  options: Schema.Array(McpElicitationQuestionOption),
  multiSelect: Schema.optional(Schema.Boolean),
});
export type McpElicitationQuestion = typeof McpElicitationQuestion.Type;

export const McpElicitationRequestPayload = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("mcp-elicitation"),
    mode: Schema.Literal("form"),
    serverName: TrimmedNonEmptyString,
    message: Schema.String,
    meta: Schema.NullOr(Schema.Unknown),
    requestedSchema: Schema.Unknown,
    questions: Schema.optional(Schema.Array(McpElicitationQuestion)),
    turnId: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("mcp-elicitation"),
    mode: Schema.Literal("url"),
    serverName: TrimmedNonEmptyString,
    message: Schema.String,
    meta: Schema.NullOr(Schema.Unknown),
    url: Schema.String,
    elicitationId: TrimmedNonEmptyString,
    turnId: Schema.optional(TrimmedNonEmptyString),
  }),
]);
export type McpElicitationRequestPayload = typeof McpElicitationRequestPayload.Type;

export const McpElicitationRequestResolution = Schema.Struct({
  action: McpElicitationAction,
  content: Schema.NullOr(Schema.Unknown),
  meta: Schema.NullOr(Schema.Unknown),
});
export type McpElicitationRequestResolution = typeof McpElicitationRequestResolution.Type;

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
  PermissionRequestPayload,
  McpElicitationRequestPayload,
  GateRequestPayload,
  BootstrapFailedRequestPayload,
  CorrectionNeededRequestPayload,
  DesignOptionRequestPayload,
]);
export type InteractiveRequestPayload = typeof InteractiveRequestPayload.Type;

export const InteractiveRequestResolution = Schema.Union([
  ApprovalRequestResolution,
  UserInputRequestResolution,
  PermissionRequestResolution,
  McpElicitationRequestResolution,
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
