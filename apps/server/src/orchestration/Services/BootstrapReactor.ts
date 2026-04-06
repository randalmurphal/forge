import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface BootstrapReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class BootstrapReactor extends ServiceMap.Service<BootstrapReactor, BootstrapReactorShape>()(
  "forge/orchestration/Services/BootstrapReactor",
) {}
