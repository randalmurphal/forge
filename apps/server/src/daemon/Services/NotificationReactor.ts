import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface NotificationReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class NotificationReactor extends ServiceMap.Service<
  NotificationReactor,
  NotificationReactorShape
>()("forge/daemon/Services/NotificationReactor") {}
