import { Effect, Layer } from "effect";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { BootstrapReactor } from "../Services/BootstrapReactor.ts";
import { ChannelReactor } from "../Services/ChannelReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { DesignModeReactor } from "../Services/DesignModeReactor.ts";
import { DiscussionReactor } from "../Services/DiscussionReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { WorkflowReactor } from "../Services/WorkflowReactor.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const discussionReactor = yield* DiscussionReactor;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const bootstrapReactor = yield* BootstrapReactor;
  const workflowReactor = yield* WorkflowReactor;
  const channelReactor = yield* ChannelReactor;
  const designModeReactor = yield* DesignModeReactor;

  const start: OrchestrationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* providerRuntimeIngestion.start();
    // DiscussionReactor must start before ProviderCommandReactor so it can
    // intercept turn-start-requested events for discussion container threads.
    yield* discussionReactor.start();
    yield* designModeReactor.start();
    yield* providerCommandReactor.start();
    yield* checkpointReactor.start();
    yield* bootstrapReactor.start();
    yield* workflowReactor.start();
    yield* channelReactor.start();
  });

  return {
    start,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
