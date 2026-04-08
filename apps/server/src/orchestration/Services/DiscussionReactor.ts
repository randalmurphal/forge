import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface DiscussionReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class DiscussionReactor extends ServiceMap.Service<
  DiscussionReactor,
  DiscussionReactorShape
>()("forge/orchestration/Services/DiscussionReactor") {}
