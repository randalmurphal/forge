import {
  ChannelId,
  CommandId,
  PhaseRunId,
  PositiveInt,
  type Channel,
  type ChannelMessage,
  type ForgeCommand,
  type ForgeEvent,
  ThreadId,
} from "@forgetools/contracts";
import { makeDrainableWorker } from "@forgetools/shared/DrainableWorker";
import { Cause, Effect, Layer, Option, Stream } from "effect";

import { DeliberationEngine } from "../../channel/Services/DeliberationEngine.ts";
import { ChannelService } from "../../channel/Services/ChannelService.ts";
import { formatChannelTranscript } from "../../channel/Utils.ts";
import { QUERY_PROJECTION_CHANNEL_MESSAGES_MAX_LIMIT } from "../../persistence/Services/ProjectionChannelMessages.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ChannelReactor, type ChannelReactorShape } from "../Services/ChannelReactor.ts";

type ChannelReactorEvent = Extract<
  ForgeEvent,
  {
    type: "channel.message-posted" | "channel.conclusion-proposed" | "channel.concluded";
  }
>;

const DEFAULT_DELIBERATION_MAX_TURNS = 20 as typeof PositiveInt.Type;
const QUERY_ALL_MESSAGES_LIMIT =
  QUERY_PROJECTION_CHANNEL_MESSAGES_MAX_LIMIT as typeof PositiveInt.Type;

function channelConcludedCommandId(channelId: ChannelId) {
  return CommandId.makeUnsafe(`channel:mark-concluded:${channelId}`);
}

function phaseCompletedCommandId(channelId: ChannelId, phaseRunId: PhaseRunId) {
  return CommandId.makeUnsafe(`channel:complete-phase:${channelId}:${phaseRunId}`);
}

export const makeChannelReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const channelService = yield* ChannelService;
  const deliberationEngine = yield* DeliberationEngine;

  const dispatchForgeCommand = (command: ForgeCommand) =>
    orchestrationEngine.dispatch(
      command as unknown as Parameters<typeof orchestrationEngine.dispatch>[0],
    );

  const resolveChannel = Effect.fn("ChannelReactor.resolveChannel")(function* (
    channelId: ChannelId,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const channel = readModel.channels.find((entry) => entry.id === channelId);
    return channel === undefined ? Option.none<Channel>() : Option.some(channel);
  });

  const ensureDeliberationState = Effect.fn("ChannelReactor.ensureDeliberationState")(function* (
    channel: Channel,
    occurredAt: string,
  ) {
    if (channel.type !== "deliberation") {
      return;
    }

    const state = yield* deliberationEngine.getState({
      channelId: channel.id,
    });
    if (Option.isSome(state)) {
      return;
    }

    yield* deliberationEngine.initialize({
      channelId: channel.id,
      maxTurns: DEFAULT_DELIBERATION_MAX_TURNS,
      initializedAt: occurredAt,
    });
  });

  const loadAllMessages = Effect.fn("ChannelReactor.loadAllMessages")(function* (
    channelId: ChannelId,
  ) {
    const messages: Array<ChannelMessage> = [];
    let afterSequence: number | undefined = undefined;

    for (;;) {
      const page: ReadonlyArray<ChannelMessage> = yield* channelService.getMessages({
        channelId,
        ...(afterSequence === undefined ? {} : { afterSequence }),
        limit: QUERY_ALL_MESSAGES_LIMIT,
      });
      messages.push(...page);

      if (page.length < QUERY_PROJECTION_CHANNEL_MESSAGES_MAX_LIMIT) {
        return messages;
      }

      afterSequence = page.at(-1)?.sequence;
    }
  });

  const latestChannelSequence = Effect.fn("ChannelReactor.latestChannelSequence")(function* (
    channelId: ChannelId,
  ) {
    const messages = yield* loadAllMessages(channelId);
    return messages.at(-1)?.sequence ?? -1;
  });

  const dispatchChannelConcluded = Effect.fn("ChannelReactor.dispatchChannelConcluded")(function* (
    channelId: ChannelId,
    concludedAt: string,
  ) {
    yield* dispatchForgeCommand({
      type: "channel.mark-concluded",
      commandId: channelConcludedCommandId(channelId),
      channelId,
      createdAt: concludedAt,
    });
  });

  const processMessagePosted = Effect.fn("ChannelReactor.processMessagePosted")(function* (
    event: Extract<ChannelReactorEvent, { type: "channel.message-posted" }>,
  ) {
    if (event.payload.fromType === "agent") {
      yield* channelService.advanceCursor({
        channelId: event.payload.channelId,
        sessionId: ThreadId.makeUnsafe(event.payload.fromId),
        sequence: event.payload.sequence,
        updatedAt: event.payload.createdAt,
      });
    }

    const channelOption = yield* resolveChannel(event.payload.channelId);
    if (Option.isNone(channelOption) || channelOption.value.type !== "deliberation") {
      return;
    }

    yield* ensureDeliberationState(channelOption.value, event.payload.createdAt);
    const transition = yield* deliberationEngine.recordPost({
      channelId: event.payload.channelId,
      participantThreadId: ThreadId.makeUnsafe(event.payload.fromId),
      postedAt: event.payload.createdAt,
    });

    if (transition.shouldConcludeChannel) {
      yield* dispatchChannelConcluded(event.payload.channelId, event.payload.createdAt);
    }
  });

  const processConclusionProposed = Effect.fn("ChannelReactor.processConclusionProposed")(
    function* (event: Extract<ChannelReactorEvent, { type: "channel.conclusion-proposed" }>) {
      const latestSequence = yield* latestChannelSequence(event.payload.channelId);
      yield* channelService.advanceCursor({
        channelId: event.payload.channelId,
        sessionId: event.payload.threadId,
        sequence: latestSequence,
        updatedAt: event.payload.proposedAt,
      });

      const channelOption = yield* resolveChannel(event.payload.channelId);
      if (Option.isNone(channelOption) || channelOption.value.type !== "deliberation") {
        return;
      }

      yield* ensureDeliberationState(channelOption.value, event.payload.proposedAt);
      const transition = yield* deliberationEngine.recordConclusionProposal({
        channelId: event.payload.channelId,
        participantThreadId: event.payload.threadId,
        summary: event.payload.summary,
        proposedAt: event.payload.proposedAt,
      });

      if (transition.shouldConcludeChannel) {
        yield* dispatchChannelConcluded(event.payload.channelId, event.payload.proposedAt);
      }
    },
  );

  const processChannelConcluded = Effect.fn("ChannelReactor.processChannelConcluded")(function* (
    event: Extract<ChannelReactorEvent, { type: "channel.concluded" }>,
  ) {
    const channelOption = yield* resolveChannel(event.payload.channelId);
    if (Option.isNone(channelOption)) {
      return;
    }

    const channel = channelOption.value;
    const phaseRunId =
      channel.phaseRunId === undefined ? undefined : PhaseRunId.makeUnsafe(channel.phaseRunId);
    if (phaseRunId === undefined) {
      return;
    }

    const messages = yield* loadAllMessages(channel.id);
    yield* dispatchForgeCommand({
      type: "thread.complete-phase",
      commandId: phaseCompletedCommandId(channel.id, phaseRunId),
      threadId: channel.threadId,
      phaseRunId,
      outputs: [
        {
          key: "channel",
          content: formatChannelTranscript(messages),
          sourceType: "channel",
        },
      ],
      createdAt: event.payload.concludedAt,
    });
  });

  const processEvent = Effect.fn("ChannelReactor.processEvent")(function* (
    event: ChannelReactorEvent,
  ) {
    switch (event.type) {
      case "channel.message-posted":
        yield* processMessagePosted(event);
        return;
      case "channel.conclusion-proposed":
        yield* processConclusionProposed(event);
        return;
      case "channel.concluded":
        yield* processChannelConcluded(event);
        return;
    }
  });

  const processEventSafely = (event: ChannelReactorEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        return Effect.logError("channel reactor failed to process orchestration event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processEventSafely);

  const start: ChannelReactorShape["start"] = () =>
    Stream.runForEach(
      Stream.filter(
        orchestrationEngine.streamDomainEvents as unknown as Stream.Stream<ForgeEvent>,
        (event) =>
          event.type === "channel.message-posted" ||
          event.type === "channel.conclusion-proposed" ||
          event.type === "channel.concluded",
      ).pipe(Stream.map((event) => event as ChannelReactorEvent)),
      worker.enqueue,
    ).pipe(Effect.forkScoped, Effect.asVoid);

  return {
    start,
    drain: worker.drain,
  } satisfies ChannelReactorShape;
});

export const ChannelReactorLive = Layer.effect(ChannelReactor, makeChannelReactor);
