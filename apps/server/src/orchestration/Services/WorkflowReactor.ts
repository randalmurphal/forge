import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface WorkflowReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class WorkflowReactor extends ServiceMap.Service<WorkflowReactor, WorkflowReactorShape>()(
  "forge/orchestration/Services/WorkflowReactor",
) {}
