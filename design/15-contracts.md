# Type Contracts

Formal type definitions for implementation. Every type, every payload, every default.

This document uses `@effect/schema`-style definitions following the patterns established in `packages/contracts/src/baseSchemas.ts` and `packages/contracts/src/orchestration.ts`. The `makeEntityId` helper creates branded string types. `Schema.Struct` defines object shapes. `Schema.Union` creates discriminated unions. `Schema.Literals` creates string literal unions.

> **Naming note:** The design docs use "session" as the user-facing concept. In the codebase, this maps to "thread." The types below use the **implementation names** (thread, ThreadId) so they can be copied into code as-is. The mapping: session = thread, sessionId = threadId.

---

## 1. Branded Identifiers (packages/contracts/src/baseSchemas.ts)

New branded types added alongside existing `ThreadId`, `ProjectId`, etc.

```typescript
// Add to baseSchemas.ts using the existing makeEntityId helper

export const WorkflowId = makeEntityId("WorkflowId");
export type WorkflowId = typeof WorkflowId.Type;

export const WorkflowPhaseId = makeEntityId("WorkflowPhaseId");
export type WorkflowPhaseId = typeof WorkflowPhaseId.Type;

export const PhaseRunId = makeEntityId("PhaseRunId");
export type PhaseRunId = typeof PhaseRunId.Type;

export const ChannelId = makeEntityId("ChannelId");
export type ChannelId = typeof ChannelId.Type;

export const ChannelMessageId = makeEntityId("ChannelMessageId");
export type ChannelMessageId = typeof ChannelMessageId.Type;

export const LinkId = makeEntityId("LinkId");
export type LinkId = typeof LinkId.Type;

export const InteractiveRequestId = makeEntityId("InteractiveRequestId");
export type InteractiveRequestId = typeof InteractiveRequestId.Type;
```

---

## 2. Workflow Types (packages/contracts/src/workflow.ts)

New file. Defines workflow definitions, phases, gates, and agent configuration.

### Enums and Literals

```typescript
import { Schema } from "effect";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  WorkflowId,
  WorkflowPhaseId,
} from "./baseSchemas";
import { ModelSelection, ProviderSandboxMode } from "./orchestration";

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
```

### Quality Check Reference

```typescript
export const QualityCheckReference = Schema.Struct({
  check: TrimmedNonEmptyString,    // key into project quality check config (e.g., "test", "lint")
  required: Schema.Boolean,         // if false, failure is advisory only
});
export type QualityCheckReference = typeof QualityCheckReference.Type;

export const QualityCheckResult = Schema.Struct({
  check: TrimmedNonEmptyString,
  passed: Schema.Boolean,
  output: Schema.optional(Schema.String),
});
export type QualityCheckResult = typeof QualityCheckResult.Type;
```

### Phase Gate

```typescript
export const PhaseGate = Schema.Struct({
  after: GateAfter,
  qualityChecks: Schema.optional(Schema.Array(QualityCheckReference)),
  // qualityChecks is required when after = "quality-checks", ignored otherwise
  onFail: GateOnFail,
  retryPhase: Schema.optional(TrimmedNonEmptyString),
  // retryPhase is required when onFail = "go-back-to" (phase name to loop back to)
  maxRetries: NonNegativeInt.pipe(Schema.withDecodingDefault(() => 3 as any)),
});
export type PhaseGate = typeof PhaseGate.Type;
```

### Gate Result (materialized after gate evaluation)

```typescript
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
```

### Agent Output Config

```typescript
// Schema output mode: provider enforces JSON shape. Must include summary: string.
export const AgentOutputSchema = Schema.Struct({
  type: Schema.Literal("schema"),
  schema: Schema.Record(Schema.String, Schema.String),
  // Keys are field names, values are type descriptors ("string", "string[]", "number", "boolean")
  // "summary" key is REQUIRED (validated at workflow load time, not by this schema)
});
export type AgentOutputSchema = typeof AgentOutputSchema.Type;

// Channel output mode: the channel conversation IS the output. No config needed.
export const AgentOutputChannel = Schema.Struct({
  type: Schema.Literal("channel"),
});
export type AgentOutputChannel = typeof AgentOutputChannel.Type;

// Conversation output mode: agent's final message is the output. No config needed.
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

// Default when not specified in workflow YAML
export const DEFAULT_AGENT_OUTPUT_CONFIG: AgentOutputConfig = { type: "conversation" };
```

### Agent Definition

```typescript
export const AgentDefinition = Schema.Struct({
  prompt: TrimmedNonEmptyString,
  // Prompt template ID (resolved via prompt template system) or inline text.
  // If value matches a known template name, it's resolved as a template.
  // Otherwise treated as inline system prompt text.
  output: AgentOutputConfig.pipe(
    Schema.withDecodingDefault(() => DEFAULT_AGENT_OUTPUT_CONFIG),
  ),
  model: Schema.optional(ModelSelection),
  // Override per-agent. If omitted, inherits from session model.
});
export type AgentDefinition = typeof AgentDefinition.Type;
```

### Deliberation Config

```typescript
export const DeliberationParticipant = Schema.Struct({
  role: TrimmedNonEmptyString,       // "advocate", "interrogator", "scrutinizer", etc.
  agent: AgentDefinition,
});
export type DeliberationParticipant = typeof DeliberationParticipant.Type;

export const DeliberationConfig = Schema.Struct({
  participants: Schema.Array(DeliberationParticipant).check(
    Schema.isMinLength(2),           // deliberation requires at least 2 participants
  ),
  maxTurns: PositiveInt.pipe(Schema.withDecodingDefault(() => 20 as any)),
});
export type DeliberationConfig = typeof DeliberationConfig.Type;
```

### InputFrom Reference

```typescript
// Simple form: inputFrom: "implement.output" -> binds to {{PREVIOUS_OUTPUT}}
// Object form: inputFrom: { PLAN: "plan-review.channel", CONTEXT: "gather.output" }
export const InputFromSimple = TrimmedNonEmptyString;
export type InputFromSimple = typeof InputFromSimple.Type;

export const InputFromObject = Schema.Record(Schema.String, TrimmedNonEmptyString);
export type InputFromObject = typeof InputFromObject.Type;

export const InputFromReference = Schema.Union([InputFromSimple, InputFromObject]);
export type InputFromReference = typeof InputFromReference.Type;
```

**Reference format grammar:**

```
<phaseName>.<outputKey>          e.g., "implement.output", "review.channel"
<phaseName>.output:<role>        e.g., "independent-review.output:scrutinizer"
promoted-from.channel            follows session_link to source chat session
```

**Resolution algorithm:**

1. Find most recent COMPLETED phase_run matching `phaseName` within this session
2. Read phase_outputs row matching `outputKey`
3. Return content as string
4. Missing reference = phase start failure with clear error message

### Workflow Phase

```typescript
export const WorkflowPhase = Schema.Struct({
  id: WorkflowPhaseId,
  name: TrimmedNonEmptyString,        // unique within workflow, used in inputFrom references
  type: PhaseType,
  agent: Schema.optional(AgentDefinition),
  // Required for single-agent phases. Omitted for multi-agent (use deliberation),
  // automated (scripts only), human (waits for input).
  deliberation: Schema.optional(DeliberationConfig),
  // Required for multi-agent phases. Omitted for others.
  sandboxMode: Schema.optional(ProviderSandboxMode),
  // Default: "workspace-write" for single-agent, "read-only" for multi-agent.
  // Automated phases ignore this. Human phases ignore this.
  inputFrom: Schema.optional(InputFromReference),
  gate: PhaseGate,
  qualityChecks: Schema.optional(Schema.Array(QualityCheckReference)),
  // For automated phases: the checks this phase RUNS.
  // For other phase types: use gate.qualityChecks instead.
  codexMode: Schema.optional(Schema.Literals(["plan", "default"])),
  // Codex collaboration mode. Default: "default".
});
export type WorkflowPhase = typeof WorkflowPhase.Type;
```

### Workflow Definition

```typescript
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
  // Phases are ordered. Execution proceeds sequentially unless gate.onFail = "go-back-to".
  builtIn: Schema.Boolean,
  onCompletion: Schema.optional(WorkflowCompletionConfig),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorkflowDefinition = typeof WorkflowDefinition.Type;
```

**Workflow invariants:**
- Phase names MUST be unique within a workflow. Validated at creation/load time, not by the schema.
- Workflows are IMMUTABLE once a session starts. `workflow_snapshot_json` on the session captures the definition at creation time.
- `builtIn = true` workflows are materialized from YAML on startup. User workflows have `builtIn = false`.

### Default sandbox mode resolution

```typescript
export function defaultSandboxMode(phaseType: PhaseType): ProviderSandboxMode {
  switch (phaseType) {
    case "single-agent":
      return "workspace-write";
    case "multi-agent":
      return "read-only";
    case "automated":
    case "human":
      return "workspace-write"; // unused but defined for completeness
  }
}
```

---

## 3. Channel Types (packages/contracts/src/channel.ts)

New file. Defines channel entities, messages, and deliberation state.

```typescript
import { Schema } from "effect";
import {
  ChannelId,
  ChannelMessageId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";

export const ChannelType = Schema.Literals(["guidance", "deliberation", "review", "system"]);
export type ChannelType = typeof ChannelType.Type;

export const ChannelStatus = Schema.Literals(["open", "concluded", "closed"]);
export type ChannelStatus = typeof ChannelStatus.Type;

export const ChannelParticipantType = Schema.Literals(["human", "agent", "system"]);
export type ChannelParticipantType = typeof ChannelParticipantType.Type;
```

### Channel Message

```typescript
export const ChannelMessage = Schema.Struct({
  id: ChannelMessageId,
  channelId: ChannelId,
  sequence: NonNegativeInt,
  fromType: ChannelParticipantType,
  fromId: TrimmedNonEmptyString,
  // For agent messages: the thread_id of the posting child session.
  // For human messages: "human".
  // For system messages: "system".
  fromRole: Schema.optional(TrimmedNonEmptyString),
  // Role label (e.g., "advocate", "interrogator") for display. Only set for agent messages.
  content: Schema.String,
  createdAt: IsoDateTime,
});
export type ChannelMessage = typeof ChannelMessage.Type;
```

### Channel Entity

```typescript
export const Channel = Schema.Struct({
  id: ChannelId,
  threadId: ThreadId,            // the parent/container session that owns this channel
  phaseRunId: Schema.optional(TrimmedNonEmptyString),
  // Set for deliberation channels scoped to a phase run. NULL for guidance channels.
  type: ChannelType,
  status: ChannelStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Channel = typeof Channel.Type;
```

### Deliberation State

Stored on `phase_runs.deliberation_state_json` (for workflow multi-agent phases) or `sessions.deliberation_state_json` (for top-level chat sessions). Same schema in both locations.

```typescript
export const DeliberationStrategy = Schema.Literals(["ping-pong"]);
export type DeliberationStrategy = typeof DeliberationStrategy.Type;

export const InjectionStatus = Schema.Literals([
  "injected",
  "response-received",
  "persisted",
]);
export type InjectionStatus = typeof InjectionStatus.Type;

export const InjectionState = Schema.Struct({
  sessionId: ThreadId,                // the child session being injected into
  injectedAtSequence: NonNegativeInt,  // channel sequence at time of injection
  turnCorrelationId: Schema.optional(TrimmedNonEmptyString),
  status: InjectionStatus,
});
export type InjectionState = typeof InjectionState.Type;

export const DeliberationState = Schema.Struct({
  strategy: DeliberationStrategy,
  currentSpeaker: Schema.NullOr(ThreadId),
  turnCount: NonNegativeInt,
  maxTurns: PositiveInt,
  conclusionProposals: Schema.Record(Schema.String, Schema.String),
  // Keys are threadId strings, values are summary text.
  // Conclusion is reached when ALL participants have proposed.
  concluded: Schema.Boolean,
  lastPostTimestamp: Schema.Record(Schema.String, IsoDateTime),
  // Keys are threadId strings.
  nudgeCount: Schema.Record(Schema.String, NonNegativeInt),
  // Keys are threadId strings. Tracks how many times a participant was nudged for stalling.
  maxNudges: NonNegativeInt.pipe(Schema.withDecodingDefault(() => 3 as any)),
  stallTimeoutMs: NonNegativeInt.pipe(Schema.withDecodingDefault(() => 120000 as any)),
  // 2 minutes default. If a participant doesn't post within this window, they are nudged.
  injectionState: Schema.optional(InjectionState),
  // Tracks Codex turn injection state. Only populated for Codex child sessions.
});
export type DeliberationState = typeof DeliberationState.Type;
```

### Default deliberation state factory

```typescript
export function createInitialDeliberationState(maxTurns: number): DeliberationState {
  return {
    strategy: "ping-pong" as any,
    currentSpeaker: null,
    turnCount: 0 as any,
    maxTurns: maxTurns as any,
    conclusionProposals: {},
    concluded: false,
    lastPostTimestamp: {},
    nudgeCount: {},
    maxNudges: 3 as any,
    stallTimeoutMs: 120000 as any,
  };
}
```

---

## 4. Interactive Request Types (packages/contracts/src/interactiveRequest.ts)

New file. Defines the discriminated union of interactive request payloads and resolutions.

```typescript
import { Schema } from "effect";
import {
  InteractiveRequestId,
  IsoDateTime,
  PhaseRunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { ProviderApprovalDecision } from "./orchestration";
import { QualityCheckResult } from "./workflow";

export const InteractiveRequestType = Schema.Literals([
  "approval",
  "user-input",
  "gate",
  "bootstrap-failed",
  "correction-needed",
]);
export type InteractiveRequestType = typeof InteractiveRequestType.Type;

export const InteractiveRequestStatus = Schema.Literals(["pending", "resolved", "stale"]);
export type InteractiveRequestStatus = typeof InteractiveRequestStatus.Type;
```

### Approval Request

```typescript
export const ApprovalRequestPayload = Schema.Struct({
  type: Schema.Literal("approval"),
  requestType: TrimmedNonEmptyString,
  // e.g., "file_change_approval", "file_read_approval", "command_execution_approval"
  detail: Schema.String,              // human-readable tool summary
  toolName: TrimmedNonEmptyString,
  toolInput: Schema.Record(Schema.String, Schema.Unknown),
  suggestions: Schema.optional(Schema.Array(Schema.String)),
  // e.g., ["Write:/src/**"] — suggested permission patterns
});
export type ApprovalRequestPayload = typeof ApprovalRequestPayload.Type;

export const ApprovalRequestResolution = Schema.Struct({
  decision: ProviderApprovalDecision,
  // "accept" | "acceptForSession" | "decline" | "cancel"
  updatedPermissions: Schema.optional(Schema.Array(Schema.String)),
});
export type ApprovalRequestResolution = typeof ApprovalRequestResolution.Type;
```

### User Input Request

```typescript
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
  // Keys are question IDs. Values are single string or string[] for multiSelect.
});
export type UserInputRequestResolution = typeof UserInputRequestResolution.Type;
```

### Gate Request

```typescript
export const GateRequestPayload = Schema.Struct({
  type: Schema.Literal("gate"),
  gateType: TrimmedNonEmptyString,    // "human-approval" | "quality-checks" (for display)
  phaseRunId: PhaseRunId,
  phaseOutput: Schema.optional(Schema.String),
  qualityCheckResults: Schema.optional(Schema.Array(QualityCheckResult)),
});
export type GateRequestPayload = typeof GateRequestPayload.Type;

export const GateRequestResolution = Schema.Struct({
  decision: Schema.Literals(["approve", "reject"]),
  correction: Schema.optional(Schema.String),
  // When decision = "reject", correction is posted to the guidance channel.
});
export type GateRequestResolution = typeof GateRequestResolution.Type;
```

### Bootstrap Failed Request

```typescript
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
```

### Correction Needed Request

```typescript
export const CorrectionNeededRequestPayload = Schema.Struct({
  type: Schema.Literal("correction-needed"),
  reason: Schema.String,
  context: Schema.optional(Schema.String),
});
export type CorrectionNeededRequestPayload = typeof CorrectionNeededRequestPayload.Type;

export const CorrectionNeededRequestResolution = Schema.Struct({
  correction: Schema.String,
  // Content posted to the guidance channel.
});
export type CorrectionNeededRequestResolution = typeof CorrectionNeededRequestResolution.Type;
```

### Union Types

```typescript
export const InteractiveRequestPayload = Schema.Union([
  ApprovalRequestPayload,
  UserInputRequestPayload,
  GateRequestPayload,
  BootstrapFailedRequestPayload,
  CorrectionNeededRequestPayload,
]);
export type InteractiveRequestPayload = typeof InteractiveRequestPayload.Type;

export const InteractiveRequestResolution = Schema.Union([
  ApprovalRequestResolution,
  UserInputRequestResolution,
  GateRequestResolution,
  BootstrapFailedRequestResolution,
  CorrectionNeededRequestResolution,
]);
export type InteractiveRequestResolution = typeof InteractiveRequestResolution.Type;
```

### Interactive Request Entity

```typescript
export const InteractiveRequest = Schema.Struct({
  id: InteractiveRequestId,
  threadId: ThreadId,                  // top-level or leaf session
  childThreadId: Schema.optional(ThreadId),
  // The leaf session, if applicable. NULL for session-level requests (gate, bootstrap).
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
```

---

## 5. Orchestration Commands (packages/contracts/src/orchestration.ts extensions)

New commands added to the existing command union. Each follows the established pattern: `Schema.Struct` with `type` literal discriminator, `commandId`, and entity-specific fields.

### Session Lifecycle Commands

```typescript
// ── Session aggregate commands ───────────────────────────────────────

const SessionCreateCommand = Schema.Struct({
  type: Schema.Literal("session.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  parentThreadId: Schema.optional(ThreadId),
  phaseRunId: Schema.optional(PhaseRunId),
  sessionType: Schema.Literals(["agent", "workflow", "chat"]),
  title: TrimmedNonEmptyString,
  description: Schema.String.pipe(Schema.withDecodingDefault(() => "")),
  workflowId: Schema.optional(WorkflowId),
  patternId: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  model: Schema.optional(ModelSelection),
  provider: Schema.optional(ProviderKind),
  // NULL for container sessions (workflow, chat). Set for leaf sessions.
  role: Schema.optional(TrimmedNonEmptyString),
  // For child sessions: "advocate", "interrogator", etc.
  branchOverride: Schema.optional(TrimmedNonEmptyString),
  requiresWorktree: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
});

const SessionCorrectCommand = Schema.Struct({
  type: Schema.Literal("session.correct"),
  commandId: CommandId,
  threadId: ThreadId,
  content: Schema.String,
  createdAt: IsoDateTime,
});
// For workflow sessions: posts to guidance channel.
// For standalone agent sessions: becomes next user turn (mapped to session.send-turn).

const SessionPauseCommand = Schema.Struct({
  type: Schema.Literal("session.pause"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

const SessionResumeCommand = Schema.Struct({
  type: Schema.Literal("session.resume"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});
// Precondition: status = "paused"

const SessionRecoverCommand = Schema.Struct({
  type: Schema.Literal("session.recover"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});
// Precondition: status = "running" (session was active when daemon crashed)

const SessionCancelCommand = Schema.Struct({
  type: Schema.Literal("session.cancel"),
  commandId: CommandId,
  threadId: ThreadId,
  reason: Schema.optional(Schema.String),
  createdAt: IsoDateTime,
});

const SessionArchiveCommand = Schema.Struct({
  type: Schema.Literal("session.archive"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

const SessionUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("session.unarchive"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

const SessionRestartCommand = Schema.Struct({
  type: Schema.Literal("session.restart"),
  commandId: CommandId,
  threadId: ThreadId,
  fromPhaseId: Schema.optional(WorkflowPhaseId),
  createdAt: IsoDateTime,
});

const SessionMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("session.meta-update"),
  commandId: CommandId,
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  createdAt: IsoDateTime,
});
```

### Phase Commands

```typescript
const SessionStartPhaseCommand = Schema.Struct({
  type: Schema.Literal("session.start-phase"),
  commandId: CommandId,
  threadId: ThreadId,
  phaseId: WorkflowPhaseId,
  phaseName: TrimmedNonEmptyString,
  phaseType: PhaseType,
  iteration: PositiveInt,
  createdAt: IsoDateTime,
});

const SessionCompletePhaseCommand = Schema.Struct({
  type: Schema.Literal("session.complete-phase"),
  commandId: CommandId,
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  outputs: Schema.optional(Schema.Array(Schema.Struct({
    key: TrimmedNonEmptyString,      // "output", "channel", "synthesis", "output:{role}", "corrections"
    content: Schema.String,
    sourceType: TrimmedNonEmptyString, // "agent", "channel", "synthesis", "quality-check", "human"
  }))),
  gateResult: Schema.optional(GateResult),
  createdAt: IsoDateTime,
});

const SessionFailPhaseCommand = Schema.Struct({
  type: Schema.Literal("session.fail-phase"),
  commandId: CommandId,
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  error: Schema.String,
  createdAt: IsoDateTime,
});

const SessionSkipPhaseCommand = Schema.Struct({
  type: Schema.Literal("session.skip-phase"),
  commandId: CommandId,
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  createdAt: IsoDateTime,
});

const SessionEditPhaseOutputCommand = Schema.Struct({
  type: Schema.Literal("session.edit-phase-output"),
  commandId: CommandId,
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  outputKey: TrimmedNonEmptyString,
  content: Schema.String,
  createdAt: IsoDateTime,
});
```

### Quality Check Commands

```typescript
const SessionQualityCheckStartCommand = Schema.Struct({
  type: Schema.Literal("session.quality-check-start"),
  commandId: CommandId,
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  checks: Schema.Array(QualityCheckReference),
  createdAt: IsoDateTime,
});

const SessionQualityCheckCompleteCommand = Schema.Struct({
  type: Schema.Literal("session.quality-check-complete"),
  commandId: CommandId,
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  results: Schema.Array(QualityCheckResult),
  createdAt: IsoDateTime,
});
```

### Bootstrap Commands

```typescript
const SessionBootstrapStartedCommand = Schema.Struct({
  type: Schema.Literal("session.bootstrap-started"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

const SessionBootstrapCompletedCommand = Schema.Struct({
  type: Schema.Literal("session.bootstrap-completed"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

const SessionBootstrapFailedCommand = Schema.Struct({
  type: Schema.Literal("session.bootstrap-failed"),
  commandId: CommandId,
  threadId: ThreadId,
  error: Schema.String,
  stdout: Schema.String,
  command: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

const SessionBootstrapSkippedCommand = Schema.Struct({
  type: Schema.Literal("session.bootstrap-skipped"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});
```

### Turn Commands (leaf sessions)

```typescript
const SessionSendTurnCommand = Schema.Struct({
  type: Schema.Literal("session.send-turn"),
  commandId: CommandId,
  threadId: ThreadId,                 // the leaf session
  content: Schema.String,
  attachments: Schema.optional(Schema.Array(Schema.Unknown)),
  // v2: typed attachments. v1: accepted but ignored.
  createdAt: IsoDateTime,
});

const SessionRestartTurnCommand = Schema.Struct({
  type: Schema.Literal("session.restart-turn"),
  commandId: CommandId,
  threadId: ThreadId,                 // the leaf session
  createdAt: IsoDateTime,
});

const SessionSendMessageCommand = Schema.Struct({
  type: Schema.Literal("session.send-message"),
  commandId: CommandId,
  threadId: ThreadId,                 // the leaf session
  messageId: MessageId,
  role: TrimmedNonEmptyString,
  content: Schema.String,
  createdAt: IsoDateTime,
});
```

### Link Commands

```typescript
export const LinkType = Schema.Literals([
  "pr",
  "issue",
  "ci-run",
  "promoted-from",
  "promoted-to",
  "related",
]);
export type LinkType = typeof LinkType.Type;

const SessionAddLinkCommand = Schema.Struct({
  type: Schema.Literal("session.add-link"),
  commandId: CommandId,
  threadId: ThreadId,
  linkId: LinkId,
  linkType: LinkType,
  linkedThreadId: Schema.optional(ThreadId),
  externalId: Schema.optional(TrimmedNonEmptyString),
  externalUrl: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});
// Constraint: at least one of linkedThreadId or externalId must be set.

const SessionRemoveLinkCommand = Schema.Struct({
  type: Schema.Literal("session.remove-link"),
  commandId: CommandId,
  threadId: ThreadId,
  linkId: LinkId,
  createdAt: IsoDateTime,
});

const SessionPromoteCommand = Schema.Struct({
  type: Schema.Literal("session.promote"),
  commandId: CommandId,
  sourceThreadId: ThreadId,
  targetThreadId: ThreadId,
  // Deterministic: UUIDv5(clientRequestId, FORGE_NAMESPACE) for retry safety.
  targetWorkflowId: WorkflowId,
  title: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(Schema.String),
  createdAt: IsoDateTime,
});
// Composite command. Decider emits atomically:
//   session.created (new workflow session)
//   session.link-added (promoted-from on new, promoted-to on source)
//   session.archived (source chat session)
```

### Dependency Commands

```typescript
const SessionAddDependencyCommand = Schema.Struct({
  type: Schema.Literal("session.add-dependency"),
  commandId: CommandId,
  threadId: ThreadId,
  dependsOnThreadId: ThreadId,
  createdAt: IsoDateTime,
});

const SessionRemoveDependencyCommand = Schema.Struct({
  type: Schema.Literal("session.remove-dependency"),
  commandId: CommandId,
  threadId: ThreadId,
  dependsOnThreadId: ThreadId,
  createdAt: IsoDateTime,
});
```

### Channel Commands

```typescript
// ── Channel aggregate commands ───────────────────────────────────────

const ChannelCreateCommand = Schema.Struct({
  type: Schema.Literal("channel.create"),
  commandId: CommandId,
  channelId: ChannelId,
  threadId: ThreadId,                 // the parent/container session
  channelType: ChannelType,
  phaseRunId: Schema.optional(PhaseRunId),
  createdAt: IsoDateTime,
});

const ChannelPostMessageCommand = Schema.Struct({
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

const ChannelReadMessagesCommand = Schema.Struct({
  type: Schema.Literal("channel.read-messages"),
  commandId: CommandId,
  channelId: ChannelId,
  threadId: ThreadId,                 // the participating child session
  upToSequence: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ChannelConcludeCommand = Schema.Struct({
  type: Schema.Literal("channel.conclude"),
  commandId: CommandId,
  channelId: ChannelId,
  threadId: ThreadId,                 // the participating child session proposing conclusion
  summary: Schema.String,
  createdAt: IsoDateTime,
});

const ChannelCloseCommand = Schema.Struct({
  type: Schema.Literal("channel.close"),
  commandId: CommandId,
  channelId: ChannelId,
  createdAt: IsoDateTime,
});
```

### Interactive Request Commands

```typescript
// ── Interactive request commands ─────────────────────────────────────

const RequestOpenCommand = Schema.Struct({
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

const RequestResolveCommand = Schema.Struct({
  type: Schema.Literal("request.resolve"),
  commandId: CommandId,
  requestId: InteractiveRequestId,
  resolvedWith: InteractiveRequestResolution,
  createdAt: IsoDateTime,
});

const RequestMarkStaleCommand = Schema.Struct({
  type: Schema.Literal("request.mark-stale"),
  commandId: CommandId,
  requestId: InteractiveRequestId,
  reason: Schema.String,
  createdAt: IsoDateTime,
});
```

### Full Command Union

```typescript
export const ForgeCommand = Schema.Union([
  // Session lifecycle
  SessionCreateCommand,
  SessionCorrectCommand,
  SessionPauseCommand,
  SessionResumeCommand,
  SessionRecoverCommand,
  SessionCancelCommand,
  SessionArchiveCommand,
  SessionUnarchiveCommand,
  SessionRestartCommand,
  SessionMetaUpdateCommand,
  // Phase
  SessionStartPhaseCommand,
  SessionCompletePhaseCommand,
  SessionFailPhaseCommand,
  SessionSkipPhaseCommand,
  SessionEditPhaseOutputCommand,
  // Quality checks
  SessionQualityCheckStartCommand,
  SessionQualityCheckCompleteCommand,
  // Bootstrap
  SessionBootstrapStartedCommand,
  SessionBootstrapCompletedCommand,
  SessionBootstrapFailedCommand,
  SessionBootstrapSkippedCommand,
  // Turns (leaf sessions)
  SessionSendTurnCommand,
  SessionRestartTurnCommand,
  SessionSendMessageCommand,
  // Links
  SessionAddLinkCommand,
  SessionRemoveLinkCommand,
  SessionPromoteCommand,
  // Dependencies
  SessionAddDependencyCommand,
  SessionRemoveDependencyCommand,
  // Channels
  ChannelCreateCommand,
  ChannelPostMessageCommand,
  ChannelReadMessagesCommand,
  ChannelConcludeCommand,
  ChannelCloseCommand,
  // Interactive requests
  RequestOpenCommand,
  RequestResolveCommand,
  RequestMarkStaleCommand,
]);
export type ForgeCommand = typeof ForgeCommand.Type;
```

**Client vs. Internal split:** The socket API exposes a subset of these commands. Internal-only commands (e.g., `session.bootstrap-started`, `session.send-message`, `request.mark-stale`) are dispatched by reactors and the engine, not by external clients. The split follows the existing `DispatchableClientOrchestrationCommand` / `InternalOrchestrationCommand` pattern.

---

## 6. Orchestration Events (packages/contracts/src/orchestration.ts extensions)

Events are the past-tense of commands. Each event carries the `EventBaseFields` and a typed payload. Events use hyphenated names (e.g., `session.phase-started`).

### Event Type Literals

```typescript
export const ForgeEventType = Schema.Literals([
  // Project
  "project.created",
  "project.meta-updated",
  "project.deleted",
  // Session lifecycle
  "session.created",
  "session.meta-updated",
  "session.status-changed",
  "session.completed",
  "session.failed",
  "session.cancelled",
  "session.archived",
  "session.unarchived",
  "session.restarted",
  "session.dependencies-satisfied",
  "session.dependency-added",
  "session.dependency-removed",
  "session.link-added",
  "session.link-removed",
  "session.synthesis-completed",
  // Bootstrap
  "session.bootstrap-queued",
  "session.bootstrap-started",
  "session.bootstrap-completed",
  "session.bootstrap-failed",
  "session.bootstrap-skipped",
  // Phase execution
  "session.phase-started",
  "session.phase-completed",
  "session.phase-failed",
  "session.phase-skipped",
  "session.phase-output-edited",
  // Provider turns
  "session.turn-requested",
  "session.turn-started",
  "session.turn-completed",
  "session.turn-restarted",
  "session.message-sent",
  // Channels
  "channel.created",
  "channel.message-posted",
  "channel.messages-read",
  "channel.conclusion-proposed",
  "channel.concluded",
  "channel.closed",
  // Interactive requests
  "request.opened",
  "request.resolved",
  "request.stale",
  // Quality checks
  "session.quality-check-started",
  "session.quality-check-completed",
  // Corrections
  "session.correction-queued",
  "session.correction-delivered",
  // Checkpoints
  "session.checkpoint-captured",
  "session.checkpoint-diff-completed",
  "session.checkpoint-reverted",
]);
export type ForgeEventType = typeof ForgeEventType.Type;

export const ForgeAggregateKind = Schema.Literals(["project", "session", "channel", "request"]);
export type ForgeAggregateKind = typeof ForgeAggregateKind.Type;
```

### Event Payloads

```typescript
// ── Session lifecycle payloads ───────────────────────────────────────

export const SessionCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  parentThreadId: Schema.NullOr(ThreadId),
  phaseRunId: Schema.NullOr(PhaseRunId),
  sessionType: Schema.Literals(["agent", "workflow", "chat"]),
  title: TrimmedNonEmptyString,
  description: Schema.String,
  workflowId: Schema.NullOr(WorkflowId),
  workflowSnapshot: Schema.optional(Schema.String),
  // JSON-serialized WorkflowDefinition, frozen at creation time
  patternId: Schema.NullOr(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  model: Schema.NullOr(ModelSelection),
  provider: Schema.NullOr(ProviderKind),
  role: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  bootstrapStatus: Schema.NullOr(TrimmedNonEmptyString),
  // "queued" if worktree needs bootstrap, NULL otherwise
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const SessionStatusChangedPayload = Schema.Struct({
  threadId: ThreadId,
  status: SessionStatus,
  previousStatus: SessionStatus,
  updatedAt: IsoDateTime,
});

export const SessionCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  completedAt: IsoDateTime,
});

export const SessionFailedPayload = Schema.Struct({
  threadId: ThreadId,
  error: Schema.String,
  failedAt: IsoDateTime,
});

export const SessionCancelledPayload = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.optional(Schema.String),
  cancelledAt: IsoDateTime,
});

// ── Phase payloads ───────────────────────────────────────────────────

export const SessionPhaseStartedPayload = Schema.Struct({
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  phaseId: WorkflowPhaseId,
  phaseName: TrimmedNonEmptyString,
  phaseType: PhaseType,
  iteration: PositiveInt,
  startedAt: IsoDateTime,
});

export const PhaseOutputEntry = Schema.Struct({
  key: TrimmedNonEmptyString,
  content: Schema.String,
  sourceType: TrimmedNonEmptyString,
});
export type PhaseOutputEntry = typeof PhaseOutputEntry.Type;

export const SessionPhaseCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  outputs: Schema.Array(PhaseOutputEntry),
  gateResult: Schema.optional(GateResult),
  completedAt: IsoDateTime,
});

export const SessionPhaseFailedPayload = Schema.Struct({
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  error: Schema.String,
  failedAt: IsoDateTime,
});

export const SessionPhaseSkippedPayload = Schema.Struct({
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  skippedAt: IsoDateTime,
});

export const SessionPhaseOutputEditedPayload = Schema.Struct({
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  outputKey: TrimmedNonEmptyString,
  previousContent: Schema.String,
  newContent: Schema.String,
  editedAt: IsoDateTime,
});

// ── Quality check payloads ───────────────────────────────────────────

export const SessionQualityCheckStartedPayload = Schema.Struct({
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  checks: Schema.Array(QualityCheckReference),
  startedAt: IsoDateTime,
});

export const SessionQualityCheckCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  results: Schema.Array(QualityCheckResult),
  completedAt: IsoDateTime,
});

// ── Bootstrap payloads ───────────────────────────────────────────────

export const SessionBootstrapStartedPayload = Schema.Struct({
  threadId: ThreadId,
  startedAt: IsoDateTime,
});

export const SessionBootstrapCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  completedAt: IsoDateTime,
});

export const SessionBootstrapFailedPayload = Schema.Struct({
  threadId: ThreadId,
  error: Schema.String,
  stdout: Schema.String,
  command: TrimmedNonEmptyString,
  failedAt: IsoDateTime,
});

export const SessionBootstrapSkippedPayload = Schema.Struct({
  threadId: ThreadId,
  skippedAt: IsoDateTime,
});

// ── Correction payloads ──────────────────────────────────────────────

export const SessionCorrectionQueuedPayload = Schema.Struct({
  threadId: ThreadId,
  content: Schema.String,
  channelId: ChannelId,
  messageId: ChannelMessageId,
  createdAt: IsoDateTime,
});
// Emitted when human posts correction. Content is in the guidance channel.

export const SessionCorrectionDeliveredPayload = Schema.Struct({
  threadId: ThreadId,
  deliveredAt: IsoDateTime,
});
// Emitted when correction is injected into provider context on next turn start.

// ── Link payloads ────────────────────────────────────────────────────

export const SessionLinkAddedPayload = Schema.Struct({
  threadId: ThreadId,
  linkId: LinkId,
  linkType: LinkType,
  linkedThreadId: Schema.NullOr(ThreadId),
  externalId: Schema.NullOr(TrimmedNonEmptyString),
  externalUrl: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

export const SessionLinkRemovedPayload = Schema.Struct({
  threadId: ThreadId,
  linkId: LinkId,
  removedAt: IsoDateTime,
});

export const SessionPromotedPayload = Schema.Struct({
  sourceThreadId: ThreadId,
  targetThreadId: ThreadId,
  promotedAt: IsoDateTime,
});

// ── Channel payloads ─────────────────────────────────────────────────

export const ChannelCreatedPayload = Schema.Struct({
  channelId: ChannelId,
  threadId: ThreadId,
  channelType: ChannelType,
  phaseRunId: Schema.NullOr(PhaseRunId),
  createdAt: IsoDateTime,
});

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

export const ChannelMessagesReadPayload = Schema.Struct({
  channelId: ChannelId,
  threadId: ThreadId,
  upToSequence: NonNegativeInt,
  readAt: IsoDateTime,
});

export const ChannelConclusionProposedPayload = Schema.Struct({
  channelId: ChannelId,
  threadId: ThreadId,
  summary: Schema.String,
  proposedAt: IsoDateTime,
});

export const ChannelConcludedPayload = Schema.Struct({
  channelId: ChannelId,
  concludedAt: IsoDateTime,
});

export const ChannelClosedPayload = Schema.Struct({
  channelId: ChannelId,
  closedAt: IsoDateTime,
});

// ── Interactive request payloads ─────────────────────────────────────

export const RequestOpenedPayload = Schema.Struct({
  requestId: InteractiveRequestId,
  threadId: ThreadId,
  childThreadId: Schema.NullOr(ThreadId),
  phaseRunId: Schema.NullOr(PhaseRunId),
  requestType: InteractiveRequestType,
  payload: InteractiveRequestPayload,
  createdAt: IsoDateTime,
});

export const RequestResolvedPayload = Schema.Struct({
  requestId: InteractiveRequestId,
  resolvedWith: InteractiveRequestResolution,
  resolvedAt: IsoDateTime,
});

export const RequestStalePayload = Schema.Struct({
  requestId: InteractiveRequestId,
  reason: Schema.String,
  staleAt: IsoDateTime,
});

// ── Turn payloads (leaf sessions) ────────────────────────────────────

export const SessionTurnRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  content: Schema.String,
  createdAt: IsoDateTime,
});

export const SessionTurnStartedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  startedAt: IsoDateTime,
});

export const SessionTurnCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  completedAt: IsoDateTime,
});

export const SessionTurnRestartedPayload = Schema.Struct({
  threadId: ThreadId,
  restartedAt: IsoDateTime,
});

export const SessionMessageSentPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  role: TrimmedNonEmptyString,
  content: Schema.String,
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
});

// ── Dependency payloads ──────────────────────────────────────────────

export const SessionDependencyAddedPayload = Schema.Struct({
  threadId: ThreadId,
  dependsOnThreadId: ThreadId,
  createdAt: IsoDateTime,
});

export const SessionDependencyRemovedPayload = Schema.Struct({
  threadId: ThreadId,
  dependsOnThreadId: ThreadId,
  removedAt: IsoDateTime,
});

export const SessionDependenciesSatisfiedPayload = Schema.Struct({
  threadId: ThreadId,
  satisfiedAt: IsoDateTime,
});

// ── Checkpoint payloads ──────────────────────────────────────────────

export const SessionCheckpointCapturedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  turnCount: NonNegativeInt,
  ref: TrimmedNonEmptyString,
  capturedAt: IsoDateTime,
});

export const SessionCheckpointDiffCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
  diff: Schema.String,
  files: Schema.Array(Schema.Struct({
    path: TrimmedNonEmptyString,
    kind: TrimmedNonEmptyString,
    additions: NonNegativeInt,
    deletions: NonNegativeInt,
  })),
  completedAt: IsoDateTime,
});

export const SessionCheckpointRevertedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  revertedAt: IsoDateTime,
});

// ── Synthesis payload ────────────────────────────────────────────────

export const SessionSynthesisCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  content: Schema.String,
  generatedByThreadId: ThreadId,
  completedAt: IsoDateTime,
});
```

### Event Union

The full event union follows the existing pattern: each variant is a `Schema.Struct` with `EventBaseFields` spread, a `type` literal, and a typed `payload`.

```typescript
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
  // Project
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("project.created"), payload: ProjectCreatedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("project.meta-updated"), payload: ProjectMetaUpdatedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("project.deleted"), payload: ProjectDeletedPayload }),
  // Session lifecycle
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.created"), payload: SessionCreatedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.meta-updated"), payload: SessionMetaUpdatedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.status-changed"), payload: SessionStatusChangedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.completed"), payload: SessionCompletedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.failed"), payload: SessionFailedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.cancelled"), payload: SessionCancelledPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.archived"), payload: SessionArchivedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.unarchived"), payload: SessionUnarchivedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.restarted"), payload: SessionRestartedPayload }),
  // Bootstrap
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.bootstrap-queued"), payload: SessionBootstrapQueuedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.bootstrap-started"), payload: SessionBootstrapStartedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.bootstrap-completed"), payload: SessionBootstrapCompletedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.bootstrap-failed"), payload: SessionBootstrapFailedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.bootstrap-skipped"), payload: SessionBootstrapSkippedPayload }),
  // Phase
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.phase-started"), payload: SessionPhaseStartedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.phase-completed"), payload: SessionPhaseCompletedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.phase-failed"), payload: SessionPhaseFailedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.phase-skipped"), payload: SessionPhaseSkippedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.phase-output-edited"), payload: SessionPhaseOutputEditedPayload }),
  // Quality checks
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.quality-check-started"), payload: SessionQualityCheckStartedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.quality-check-completed"), payload: SessionQualityCheckCompletedPayload }),
  // Corrections
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.correction-queued"), payload: SessionCorrectionQueuedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.correction-delivered"), payload: SessionCorrectionDeliveredPayload }),
  // Turns
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.turn-requested"), payload: SessionTurnRequestedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.turn-started"), payload: SessionTurnStartedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.turn-completed"), payload: SessionTurnCompletedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.turn-restarted"), payload: SessionTurnRestartedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.message-sent"), payload: SessionMessageSentPayload }),
  // Links
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.link-added"), payload: SessionLinkAddedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.link-removed"), payload: SessionLinkRemovedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.promoted"), payload: SessionPromotedPayload }),
  // Dependencies
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.dependency-added"), payload: SessionDependencyAddedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.dependency-removed"), payload: SessionDependencyRemovedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.dependencies-satisfied"), payload: SessionDependenciesSatisfiedPayload }),
  // Synthesis
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.synthesis-completed"), payload: SessionSynthesisCompletedPayload }),
  // Checkpoints
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.checkpoint-captured"), payload: SessionCheckpointCapturedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.checkpoint-diff-completed"), payload: SessionCheckpointDiffCompletedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("session.checkpoint-reverted"), payload: SessionCheckpointRevertedPayload }),
  // Channels
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("channel.created"), payload: ChannelCreatedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("channel.message-posted"), payload: ChannelMessagePostedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("channel.messages-read"), payload: ChannelMessagesReadPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("channel.conclusion-proposed"), payload: ChannelConclusionProposedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("channel.concluded"), payload: ChannelConcludedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("channel.closed"), payload: ChannelClosedPayload }),
  // Interactive requests
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("request.opened"), payload: RequestOpenedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("request.resolved"), payload: RequestResolvedPayload }),
  Schema.Struct({ ...ForgeEventBaseFields, type: Schema.Literal("request.stale"), payload: RequestStalePayload }),
]);
export type ForgeEvent = typeof ForgeEvent.Type;
```

**Missing payloads note:** The following payloads are referenced in the union above but not defined inline to keep the section focused. They follow identical patterns to the ones shown:

- `SessionMetaUpdatedPayload` — same shape as the session.meta-update command fields, plus `updatedAt`
- `SessionArchivedPayload` — `{ threadId, archivedAt }`
- `SessionUnarchivedPayload` — `{ threadId, updatedAt }`
- `SessionRestartedPayload` — `{ threadId, fromPhaseId?, restartedAt }`
- `SessionBootstrapQueuedPayload` — `{ threadId, queuedAt }`

---

## 7. Push Event Channel Payloads

WebSocket push channels for real-time UI updates. These are delivered via the existing subscription mechanism (`WsSubscribe*Rpc` pattern in `rpc.ts`).

### Subscription Registration

```typescript
// Add to WS_METHODS in rpc.ts:
subscribeWorkflowEvents: "subscribeWorkflowEvents",
subscribeChannelMessages: "subscribeChannelMessages",

// Add to WsRpcGroup:
export const WsSubscribeWorkflowEventsRpc = Rpc.make(
  WS_METHODS.subscribeWorkflowEvents,
  {
    payload: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
    // threadId filter: if set, only events for this session. If omitted, all sessions.
    success: WorkflowPushEvent,
    stream: true,
  },
);

export const WsSubscribeChannelMessagesRpc = Rpc.make(
  WS_METHODS.subscribeChannelMessages,
  {
    payload: Schema.Struct({ channelId: Schema.optional(ChannelId) }),
    success: ChannelPushEvent,
    stream: true,
  },
);
```

### Workflow Push Events

```typescript
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
  data: Schema.optional(Schema.String),    // stdout chunk for "output" event
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
  // Set when status = "waiting-human" so the frontend can render the gate approval UI.
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
```

### Channel Push Events

```typescript
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
  sessionId: ThreadId,            // the participant proposing conclusion
  summary: Schema.String,
  allProposed: Schema.Boolean,    // true when all participants have proposed
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
```

---

## 8. Read Model Extensions

### Forge Read Model (server-side, used by decider)

```typescript
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

export const ForgeReadModel = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(Schema.Struct({
    projectId: ProjectId,
    title: TrimmedNonEmptyString,
    workspaceRoot: TrimmedNonEmptyString,
    defaultModel: Schema.NullOr(ModelSelection),
    scripts: Schema.Array(ProjectScript),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    deletedAt: Schema.NullOr(IsoDateTime),
  })),
  sessions: Schema.Array(Schema.Struct({
    threadId: ThreadId,
    projectId: ProjectId,
    parentThreadId: Schema.NullOr(ThreadId),
    phaseRunId: Schema.NullOr(PhaseRunId),
    sessionType: Schema.Literals(["agent", "workflow", "chat"]),
    title: TrimmedNonEmptyString,
    description: Schema.String,
    status: SessionStatus,
    role: Schema.NullOr(TrimmedNonEmptyString),
    provider: Schema.NullOr(ProviderKind),
    model: Schema.NullOr(ModelSelection),
    runtimeMode: RuntimeMode,
    workflowId: Schema.NullOr(WorkflowId),
    currentPhaseId: Schema.NullOr(WorkflowPhaseId),
    patternId: Schema.NullOr(TrimmedNonEmptyString),
    branch: Schema.NullOr(TrimmedNonEmptyString),
    worktreePath: Schema.NullOr(TrimmedNonEmptyString),
    bootstrapStatus: Schema.NullOr(TrimmedNonEmptyString),
    childThreadIds: Schema.Array(ThreadId),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    archivedAt: Schema.NullOr(IsoDateTime),
  })),
  phaseRuns: Schema.Array(Schema.Struct({
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
  })),
  channels: Schema.Array(Schema.Struct({
    channelId: ChannelId,
    threadId: ThreadId,
    channelType: ChannelType,
    status: ChannelStatus,
  })),
  pendingRequests: Schema.Array(Schema.Struct({
    requestId: InteractiveRequestId,
    threadId: ThreadId,
    childThreadId: Schema.NullOr(ThreadId),
    requestType: InteractiveRequestType,
    status: InteractiveRequestStatus,
  })),
  workflows: Schema.Array(Schema.Struct({
    workflowId: WorkflowId,
    name: TrimmedNonEmptyString,
    description: Schema.String,
    builtIn: Schema.Boolean,
  })),
  updatedAt: IsoDateTime,
});
export type ForgeReadModel = typeof ForgeReadModel.Type;
```

### Client Snapshot (wire-optimized, sent to frontend)

The client snapshot is a subset of the server read model, projected for UI rendering efficiency. It omits fields the UI doesn't need for initial render (e.g., full workflow definitions) and includes computed fields the UI needs (e.g., `childThreadIds` as a pre-materialized array).

```typescript
export const ForgeClientSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProject),
  sessions: Schema.Array(Schema.Struct({
    threadId: ThreadId,
    projectId: ProjectId,
    parentThreadId: Schema.NullOr(ThreadId),
    sessionType: Schema.Literals(["agent", "workflow", "chat"]),
    title: TrimmedNonEmptyString,
    status: SessionStatus,
    role: Schema.NullOr(TrimmedNonEmptyString),
    provider: Schema.NullOr(ProviderKind),
    model: Schema.NullOr(ModelSelection),
    runtimeMode: RuntimeMode,
    workflowId: Schema.NullOr(WorkflowId),
    currentPhaseId: Schema.NullOr(WorkflowPhaseId),
    patternId: Schema.NullOr(TrimmedNonEmptyString),
    branch: Schema.NullOr(TrimmedNonEmptyString),
    bootstrapStatus: Schema.NullOr(TrimmedNonEmptyString),
    childThreadIds: Schema.Array(ThreadId),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    archivedAt: Schema.NullOr(IsoDateTime),
  })),
  phaseRuns: Schema.Array(Schema.Struct({
    phaseRunId: PhaseRunId,
    threadId: ThreadId,
    phaseName: TrimmedNonEmptyString,
    phaseType: PhaseType,
    iteration: PositiveInt,
    status: PhaseRunStatus,
  })),
  channels: Schema.Array(Schema.Struct({
    channelId: ChannelId,
    threadId: ThreadId,
    channelType: ChannelType,
    status: ChannelStatus,
    phaseRunId: Schema.NullOr(PhaseRunId),
  })),
  pendingRequests: Schema.Array(Schema.Struct({
    requestId: InteractiveRequestId,
    threadId: ThreadId,
    requestType: InteractiveRequestType,
    status: InteractiveRequestStatus,
  })),
  workflows: Schema.Array(Schema.Struct({
    workflowId: WorkflowId,
    name: TrimmedNonEmptyString,
    description: Schema.String,
    builtIn: Schema.Boolean,
  })),
  updatedAt: IsoDateTime,
});
export type ForgeClientSnapshot = typeof ForgeClientSnapshot.Type;
```

---

## 9. Quality Check Config

Project-level configuration for quality checks and bootstrap.

```typescript
// File: .forge/config.json (project root)
// Fallback: ~/.forge/config.json (global defaults)
// Resolution: project > global (first match wins per key)

export const QualityCheckConfig = Schema.Struct({
  command: TrimmedNonEmptyString,      // shell command to execute
  timeout: NonNegativeInt.pipe(Schema.withDecodingDefault(() => 300000 as any)),
  // ms, default 5 minutes
  required: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  // if false, failure is advisory
});
export type QualityCheckConfig = typeof QualityCheckConfig.Type;

export const BootstrapConfig = Schema.Struct({
  command: TrimmedNonEmptyString,      // e.g., "npm install", "bun install"
  timeout: NonNegativeInt.pipe(Schema.withDecodingDefault(() => 300000 as any)),
  // ms, default 5 minutes
});
export type BootstrapConfig = typeof BootstrapConfig.Type;

export const ForgeProjectConfig = Schema.Struct({
  qualityChecks: Schema.optional(Schema.Record(Schema.String, QualityCheckConfig)),
  // Keys are check names referenced in workflow YAML (e.g., "test", "lint", "typecheck")
  bootstrap: Schema.optional(BootstrapConfig),
  defaultModel: Schema.optional(ModelSelection),
});
export type ForgeProjectConfig = typeof ForgeProjectConfig.Type;
```

Example `.forge/config.json`:

```json
{
  "qualityChecks": {
    "test": { "command": "bun run test", "timeout": 300000 },
    "lint": { "command": "bun lint", "timeout": 60000 },
    "typecheck": { "command": "bun typecheck", "timeout": 120000 }
  },
  "bootstrap": {
    "command": "bun install",
    "timeout": 300000
  }
}
```

---

## 10. Prompt Template Format

Prompt templates are YAML files with simple `{{VAR}}` placeholder syntax.

```typescript
export const PromptTemplate = Schema.Struct({
  name: TrimmedNonEmptyString,         // unique identifier, matches filename
  description: Schema.String,
  system: Schema.String,               // system prompt text with {{VAR}} placeholders
  initial: Schema.optional(Schema.String),
  // Optional initial user message to kick off the phase.
});
export type PromptTemplate = typeof PromptTemplate.Type;
```

### Resolution Order

1. `.forge/prompts/{name}.yaml` (project-level)
2. `~/.forge/prompts/{name}.yaml` (user global)
3. Bundled app resources (built-in)

First match wins. No merging.

### Built-In Placeholders

Engine-injected, always available in every prompt template:

| Placeholder | Source | Description |
|-------------|--------|-------------|
| `{{DESCRIPTION}}` | User input | Session description from the user |
| `{{PREVIOUS_OUTPUT}}` | Phase output system | Previous phase's output (summary for schema, transcript for channel, message for conversation) |
| `{{ITERATION_CONTEXT}}` | Phase output + guidance channel | On retry: quality check failures, previous corrections, error messages |
| `{{INPUT}}` | `inputFrom` (simple form) | Resolved input from a referenced phase output |

For `inputFrom` object form, each key becomes a placeholder: `inputFrom: { PLAN: "plan-review.channel" }` creates `{{PLAN}}`.

### Placeholder Semantics

- Simple string replacement. `{{VAR_NAME}}` replaced with literal string value.
- No nesting, no escaping, no conditionals, no loops.
- Unresolved placeholders remain as-is in the prompt text. The agent sees `{{UNKNOWN_VAR}}` literally. Easy to debug.

### Example Template (`implement.yaml`)

```yaml
name: implement
description: Implement a feature or fix based on a description
system: |
  You are a software engineer implementing changes to a codebase.

  ## Task
  {{DESCRIPTION}}

  ## Previous Context
  {{PREVIOUS_OUTPUT}}

  ## Instructions
  - Read the relevant code before making changes
  - Write tests for your changes
  - Run existing tests to make sure nothing breaks
  - Commit your changes with a clear message
```

---

## 11. InputFrom Reference Syntax

### Grammar

```
Simple form (binds to {{PREVIOUS_OUTPUT}} or {{INPUT}}):
  inputFrom: "<phaseName>.<outputKey>"

Object form (binds to named placeholders):
  inputFrom:
    VAR_NAME: "<phaseName>.<outputKey>"
    VAR_NAME2: "<phaseName>.<outputKey>"
```

### Reference Format

```
<phaseName>.<outputKey>            Standard: "implement.output", "review.channel"
<phaseName>.output:<role>          Role-specific: "independent-review.output:scrutinizer"
promoted-from.channel              Promotion: follows session_link to source chat session
```

### Output Key Dictionary

| Key | Source | When produced |
|-----|--------|---------------|
| `output` | Last assistant transcript entry from child session | Single-agent phases, automated phases |
| `channel` | Formatted channel transcript (all messages) | Multi-agent phases with deliberation channel |
| `synthesis` | Synthesis child session's final output | Multi-agent phases with synthesis sub-phase |
| `output:{role}` | Last assistant transcript entry from role's child session | Multi-agent phases without channel |
| `corrections` | JSON array of guidance channel messages during phase run | Any phase with corrections |

### Resolution Algorithm

```sql
-- Find most recent COMPLETED phase_run matching phaseName
SELECT po.content FROM phase_outputs po
JOIN phase_runs pr ON po.phase_run_id = pr.phase_run_id
WHERE pr.session_id = :sessionId
  AND pr.phase_name = :phaseName
  AND po.output_key = :outputKey
  AND pr.status = 'completed'
ORDER BY pr.iteration DESC
LIMIT 1
```

- Always picks the most recent completed iteration (handles retries naturally).
- Missing reference = phase start failure with clear error message.
- `source_type` on phase_outputs is informational (debugging, UI display), not used in resolution.

### Promotion Reference

`inputFrom: promoted-from.channel` follows `session_links` (link_type = 'promoted-from') to find the source chat session, then reads that session's deliberation channel content.

---

## 12. Session Creation Defaults

| Field | Default | Override |
|-------|---------|----------|
| `model` | `project.defaultModel` if set, else first available provider's default model | Explicit in create command |
| `runtimeMode` | `"full-access"` (existing default) | Explicit in create command |
| `branch` | `"forge/{threadId}"` (auto-generated, unique by construction) | `branchOverride` in create command |
| `worktreePath` | `~/.forge/worktrees/{threadId}/` for sessions that need worktrees | Not overridable |
| `bootstrapStatus` | `null` for agent sessions without worktree; `"queued"` for sessions that will bootstrap | Derived from `requiresWorktree` + project bootstrap config |
| `sessionType` | `"agent"` if no workflow selected | Derived: workflow with phases -> `"workflow"`, deliberation pattern -> `"chat"` |
| `provider` | Resolved from `ModelSelection.provider` for leaf sessions; `null` for container sessions | Explicit in create command |

### Session Type Derivation

```typescript
function deriveSessionType(
  workflowId: WorkflowId | undefined,
  workflow: WorkflowDefinition | undefined,
  patternId: string | undefined,
): "agent" | "workflow" | "chat" {
  if (!workflowId) return "agent";
  if (patternId) return "chat";
  if (workflow && workflow.phases.length > 0) return "workflow";
  return "agent";
}
```

### Project Resolution

If no project selected: resolve from cwd (existing behavior via `serverRuntimeStartup`). Create project record if needed.

### Branch Claim Rules

1. Branch name must not be checked out in the main repo
2. Branch name must not be claimed by another active session (status NOT IN completed, cancelled, failed AND archived_at IS NULL)
3. Validated by the decider against the ForgeReadModel (serialized in command queue, no race)

---

## 13. Reactor Command ID Derivation

Deterministic IDs for idempotent reactor completion commands.

| Reactor | commandId pattern | Example |
|---------|-------------------|---------|
| BootstrapReactor | `bootstrap:{threadId}:{attempt}` | `bootstrap:abc123:1` |
| ProviderCommandReactor | `turn:{threadId}:{turnCorrelationId}` | `turn:abc123:corr456` |
| QualityCheckReactor | `qc:{phaseRunId}:{checkKey}` | `qc:pr789:test` |
| AutomatedPhaseReactor | `auto-phase:{phaseRunId}` | `auto-phase:pr789` |
| SynthesisReactor | `synthesis:{threadId}` | `synthesis:abc123` |
| CodexConclusionParser | `conclusion:{threadId}:{turnCorrelationId}` | `conclusion:abc123:corr456` |

The engine's existing command receipt system deduplicates on commandId. Retry-safe across daemon restarts.

---

## 14. Socket API Method Registry

Extension of the existing `WS_METHODS` for new session/channel/request operations.

```typescript
// Add to WS_METHODS:
export const FORGE_WS_METHODS = {
  // Session operations
  sessionCreate: "session.create",
  sessionCorrect: "session.correct",
  sessionPause: "session.pause",
  sessionResume: "session.resume",
  sessionCancel: "session.cancel",
  sessionArchive: "session.archive",
  sessionUnarchive: "session.unarchive",
  sessionSendTurn: "session.sendTurn",
  sessionGetTranscript: "session.getTranscript",
  sessionGetChildren: "session.getChildren",

  // Gate operations
  gateApprove: "gate.approve",
  gateReject: "gate.reject",

  // Request operations
  requestResolve: "request.resolve",

  // Channel operations
  channelGetMessages: "channel.getMessages",
  channelIntervene: "channel.intervene",

  // Phase output operations
  phaseOutputUpdate: "phaseOutput.update",

  // Workflow operations
  workflowList: "workflow.list",
  workflowGet: "workflow.get",

  // Push subscriptions
  subscribeWorkflowEvents: "subscribeWorkflowEvents",
  subscribeChannelMessages: "subscribeChannelMessages",
} as const;
```

### Socket Method to Command Mapping

| Socket Method | Enrichment | Command |
|--------------|------------|---------|
| `session.create` | Generate threadId, resolve projectId from path, resolve default model | `session.create { ... }` |
| `session.correct` | Resolve guidance channelId for this session | `session.correct` -> engine resolves to `channel.post-message` |
| `session.sendTurn` | None (threadId IS the leaf session) | `session.send-turn { ... }` |
| `gate.approve` | Resolve requestId from threadId + phaseRunId | `request.resolve { requestId, resolvedWith: { decision: "approve" } }` |
| `gate.reject` | Resolve requestId from threadId + phaseRunId | `request.resolve { requestId, resolvedWith: { decision: "reject", correction? } }` |
| `request.resolve` | None | `request.resolve { ... }` |
| `channel.intervene` | None | `channel.post-message { channelId, fromType: "human", ... }` |
| `phaseOutput.update` | None | `session.edit-phase-output { ... }` |

### Query Methods (direct DB, not commands)

| Socket Method | Returns |
|--------------|---------|
| `session.getTranscript` | `{ entries: TranscriptEntry[], total: number }` |
| `session.getChildren` | `{ children: SessionSummary[] }` |
| `channel.getMessages` | `{ messages: ChannelMessage[], total: number }` |
| `workflow.list` | `{ workflows: WorkflowSummary[] }` |
| `workflow.get` | `{ workflow: WorkflowDefinition }` |

---

## 15. File Layout

New files to create:

```
packages/contracts/src/
  baseSchemas.ts          (extend: add WorkflowId, WorkflowPhaseId, PhaseRunId, ChannelId, etc.)
  workflow.ts             (new: WorkflowDefinition, WorkflowPhase, PhaseGate, AgentDefinition, etc.)
  channel.ts              (new: Channel, ChannelMessage, DeliberationState, etc.)
  interactiveRequest.ts   (new: InteractiveRequest, payload/resolution unions)
  orchestration.ts        (extend: add ForgeCommand, ForgeEvent unions alongside existing types)
  rpc.ts                  (extend: add new WS_METHODS and Rpc definitions)
  index.ts                (extend: re-export new modules)
```

The existing `orchestration.ts` types (`OrchestrationCommand`, `OrchestrationEvent`, `OrchestrationReadModel`) remain for backward compatibility during migration. New types (`ForgeCommand`, `ForgeEvent`, `ForgeReadModel`) are the target. Migration strategy: implement new types first, then migrate consumers, then remove old types.
