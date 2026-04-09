import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface DesignModeReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly setupDesignMode: (input: {
    readonly threadId: string;
    readonly provider: "codex" | "claudeAgent";
    readonly artifactsBaseDir: string;
  }) => void;
  readonly teardownDesignMode: (threadId: string) => void;
  readonly drain: Effect.Effect<void>;
}

export class DesignModeReactor extends ServiceMap.Service<
  DesignModeReactor,
  DesignModeReactorShape
>()("forge/orchestration/Services/DesignModeReactor") {}
