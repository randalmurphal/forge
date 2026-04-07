import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface PatternReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class PatternReactor extends ServiceMap.Service<PatternReactor, PatternReactorShape>()(
  "forge/orchestration/Services/PatternReactor",
) {}
