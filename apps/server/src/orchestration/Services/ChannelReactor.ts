import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface ChannelReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class ChannelReactor extends ServiceMap.Service<ChannelReactor, ChannelReactorShape>()(
  "forge/orchestration/Services/ChannelReactor",
) {}
