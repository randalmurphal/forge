import {
  GateResult,
  PhaseGate,
  PhaseRunId,
  ThreadId,
  WorkflowDefinition,
} from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { WorkflowEngineError } from "../Errors.ts";

export const StartWorkflowInput = Schema.Struct({
  threadId: ThreadId,
  workflow: WorkflowDefinition,
});
export type StartWorkflowInput = typeof StartWorkflowInput.Type;

export const AdvancePhaseInput = Schema.Struct({
  threadId: ThreadId,
  gateResultOverride: Schema.optional(GateResult),
});
export type AdvancePhaseInput = typeof AdvancePhaseInput.Type;

export const EvaluateGateInput = Schema.Struct({
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  gate: PhaseGate,
});
export type EvaluateGateInput = typeof EvaluateGateInput.Type;

export interface WorkflowEngineShape {
  readonly startWorkflow: (input: StartWorkflowInput) => Effect.Effect<void, WorkflowEngineError>;
  readonly advancePhase: (
    input: AdvancePhaseInput,
  ) => Effect.Effect<GateResult, WorkflowEngineError>;
  readonly evaluateGate: (
    input: EvaluateGateInput,
  ) => Effect.Effect<GateResult, WorkflowEngineError>;
}

export class WorkflowEngine extends ServiceMap.Service<WorkflowEngine, WorkflowEngineShape>()(
  "t3/workflow/Services/WorkflowEngine",
) {}
