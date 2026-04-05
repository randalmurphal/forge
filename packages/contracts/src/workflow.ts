import { Schema } from "effect";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  WorkflowId,
  WorkflowPhaseId,
} from "./baseSchemas";
import { ModelSelection, ProviderSandboxMode } from "./providerSchemas";

export const AgentOutputMode = Schema.Literals(["schema", "channel", "conversation"]);
export type AgentOutputMode = typeof AgentOutputMode.Type;

export const PhaseType = Schema.Literals(["single-agent", "multi-agent", "automated", "human"]);
export type PhaseType = typeof PhaseType.Type;

export const GateAfter = Schema.Literals([
  "auto-continue",
  "quality-checks",
  "human-approval",
  "done",
]);
export type GateAfter = typeof GateAfter.Type;

export const GateOnFail = Schema.Literals(["retry", "go-back-to", "stop"]);
export type GateOnFail = typeof GateOnFail.Type;

export const PhaseRunStatus = Schema.Literals([
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
]);
export type PhaseRunStatus = typeof PhaseRunStatus.Type;

export const QualityCheckReference = Schema.Struct({
  check: TrimmedNonEmptyString,
  required: Schema.Boolean,
});
export type QualityCheckReference = typeof QualityCheckReference.Type;

export const QualityCheckResult = Schema.Struct({
  check: TrimmedNonEmptyString,
  passed: Schema.Boolean,
  output: Schema.optional(Schema.String),
});
export type QualityCheckResult = typeof QualityCheckResult.Type;

export const PhaseGate = Schema.Struct({
  after: GateAfter,
  qualityChecks: Schema.optional(Schema.Array(QualityCheckReference)),
  onFail: GateOnFail,
  retryPhase: Schema.optional(TrimmedNonEmptyString),
  maxRetries: NonNegativeInt.pipe(Schema.withDecodingDefault(() => 3 as any)),
});
export type PhaseGate = typeof PhaseGate.Type;

export const GateResultStatus = Schema.Literals(["passed", "failed", "waiting-human"]);
export type GateResultStatus = typeof GateResultStatus.Type;

export const GateResult = Schema.Struct({
  status: GateResultStatus,
  qualityCheckResults: Schema.optional(Schema.Array(QualityCheckResult)),
  humanDecision: Schema.optional(Schema.Literals(["approve", "reject"])),
  correction: Schema.optional(Schema.String),
  evaluatedAt: IsoDateTime,
});
export type GateResult = typeof GateResult.Type;

export const AgentOutputSchema = Schema.Struct({
  type: Schema.Literal("schema"),
  schema: Schema.Record(Schema.String, Schema.String),
});
export type AgentOutputSchema = typeof AgentOutputSchema.Type;

export const AgentOutputChannel = Schema.Struct({
  type: Schema.Literal("channel"),
});
export type AgentOutputChannel = typeof AgentOutputChannel.Type;

export const AgentOutputConversation = Schema.Struct({
  type: Schema.Literal("conversation"),
});
export type AgentOutputConversation = typeof AgentOutputConversation.Type;

export const AgentOutputConfig = Schema.Union([
  AgentOutputSchema,
  AgentOutputChannel,
  AgentOutputConversation,
]);
export type AgentOutputConfig = typeof AgentOutputConfig.Type;

export const DEFAULT_AGENT_OUTPUT_CONFIG: AgentOutputConfig = { type: "conversation" };

export const AgentDefinition = Schema.Struct({
  prompt: TrimmedNonEmptyString,
  output: AgentOutputConfig.pipe(Schema.withDecodingDefault(() => DEFAULT_AGENT_OUTPUT_CONFIG)),
  model: Schema.optional(ModelSelection),
});
export type AgentDefinition = typeof AgentDefinition.Type;

export const DeliberationParticipant = Schema.Struct({
  role: TrimmedNonEmptyString,
  agent: AgentDefinition,
});
export type DeliberationParticipant = typeof DeliberationParticipant.Type;

export const DeliberationConfig = Schema.Struct({
  participants: Schema.Array(DeliberationParticipant).check(Schema.isMinLength(2)),
  maxTurns: PositiveInt.pipe(Schema.withDecodingDefault(() => 20 as any)),
});
export type DeliberationConfig = typeof DeliberationConfig.Type;

export const InputFromSimple = TrimmedNonEmptyString;
export type InputFromSimple = typeof InputFromSimple.Type;

export const InputFromObject = Schema.Record(Schema.String, TrimmedNonEmptyString);
export type InputFromObject = typeof InputFromObject.Type;

export const InputFromReference = Schema.Union([InputFromSimple, InputFromObject]);
export type InputFromReference = typeof InputFromReference.Type;

export const WorkflowPhase = Schema.Struct({
  id: WorkflowPhaseId,
  name: TrimmedNonEmptyString,
  type: PhaseType,
  agent: Schema.optional(AgentDefinition),
  deliberation: Schema.optional(DeliberationConfig),
  sandboxMode: Schema.optional(ProviderSandboxMode),
  inputFrom: Schema.optional(InputFromReference),
  gate: PhaseGate,
  qualityChecks: Schema.optional(Schema.Array(QualityCheckReference)),
  codexMode: Schema.optional(Schema.Literals(["plan", "default"])),
});
export type WorkflowPhase = typeof WorkflowPhase.Type;

export const WorkflowCompletionConfig = Schema.Struct({
  autoCommit: Schema.optional(Schema.Boolean),
  autoPush: Schema.optional(Schema.Boolean),
  createPr: Schema.optional(Schema.Boolean),
});
export type WorkflowCompletionConfig = typeof WorkflowCompletionConfig.Type;

export const WorkflowDefinition = Schema.Struct({
  id: WorkflowId,
  name: TrimmedNonEmptyString,
  description: Schema.String.pipe(Schema.withDecodingDefault(() => "")),
  phases: Schema.Array(WorkflowPhase).check(Schema.isMinLength(1)),
  builtIn: Schema.Boolean,
  onCompletion: Schema.optional(WorkflowCompletionConfig),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorkflowDefinition = typeof WorkflowDefinition.Type;

export function defaultSandboxMode(phaseType: PhaseType): ProviderSandboxMode {
  switch (phaseType) {
    case "single-agent":
      return "workspace-write";
    case "multi-agent":
      return "read-only";
    case "automated":
    case "human":
      return "workspace-write";
  }
}

export const QualityCheckConfig = Schema.Struct({
  command: TrimmedNonEmptyString,
  timeout: NonNegativeInt.pipe(Schema.withDecodingDefault(() => 300000 as any)),
  required: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
});
export type QualityCheckConfig = typeof QualityCheckConfig.Type;

export const BootstrapConfig = Schema.Struct({
  command: TrimmedNonEmptyString,
  timeout: NonNegativeInt.pipe(Schema.withDecodingDefault(() => 300000 as any)),
});
export type BootstrapConfig = typeof BootstrapConfig.Type;

export const ForgeProjectConfig = Schema.Struct({
  qualityChecks: Schema.optional(Schema.Record(Schema.String, QualityCheckConfig)),
  bootstrap: Schema.optional(BootstrapConfig),
  defaultModel: Schema.optional(ModelSelection),
});
export type ForgeProjectConfig = typeof ForgeProjectConfig.Type;
