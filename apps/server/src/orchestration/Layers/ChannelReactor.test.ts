import {
  ChannelId,
  EventId,
  PhaseRunId,
  ThreadId,
  type DeliberationState,
  type ForgeEvent,
} from "@t3tools/contracts";
import { Effect, Exit, Layer, ManagedRuntime, Option, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { DeliberationEngine } from "../../channel/Services/DeliberationEngine.ts";
import { ChannelService } from "../../channel/Services/ChannelService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ChannelReactor } from "../Services/ChannelReactor.ts";
import { ChannelReactorLive } from "./ChannelReactor.ts";

const parentThreadId = ThreadId.makeUnsafe("thread-parent-channel-reactor");
const participantAId = ThreadId.makeUnsafe("thread-participant-a");
const participantBId = ThreadId.makeUnsafe("thread-participant-b");
const channelId = ChannelId.makeUnsafe("channel-reactor");
const phaseRunId = PhaseRunId.makeUnsafe("phase-run-reactor");

function makeChannelEvent(
  input: Omit<
    ForgeEvent,
    "eventId" | "sequence" | "occurredAt" | "causationEventId" | "correlationId" | "metadata"
  >,
  sequence: number,
): ForgeEvent {
  return {
    ...input,
    sequence,
    eventId: EventId.makeUnsafe(`event-${sequence}`),
    occurredAt: "2026-04-05T20:00:00.000Z",
    causationEventId: null,
    correlationId: null,
    metadata: {},
  } as ForgeEvent;
}

describe("ChannelReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<any, any> | null = null;
  let scope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  async function createHarness(options?: {
    readonly recordPostShouldConclude?: boolean;
    readonly recordConclusionShouldConclude?: ReadonlyArray<boolean>;
  }) {
    const commands: Array<any> = [];
    const cursorUpdates: Array<any> = [];
    const messagesByChannel = new Map<string, Array<any>>([
      [
        channelId,
        [
          {
            id: "message-1",
            channelId,
            sequence: 0,
            fromType: "agent",
            fromId: participantAId,
            fromRole: "advocate",
            content: "Initial position",
            createdAt: "2026-04-05T20:00:00.000Z",
          },
          {
            id: "message-2",
            channelId,
            sequence: 1,
            fromType: "agent",
            fromId: participantBId,
            fromRole: "critic",
            content: "Counterpoint",
            createdAt: "2026-04-05T20:01:00.000Z",
          },
        ],
      ],
    ]);
    const pubsub = await Effect.runPromise(PubSub.unbounded<ForgeEvent>());
    let eventSequence = 0;
    let conclusionIndex = 0;
    const defaultState = {
      strategy: "ping-pong",
      currentSpeaker: participantAId,
      turnCount: 0,
      maxTurns: 20,
      conclusionProposals: {},
      concluded: false,
      lastPostTimestamp: {},
      nudgeCount: {},
      maxNudges: 3,
      stallTimeoutMs: 120000,
    } satisfies DeliberationState;

    const readModel = {
      snapshotSequence: 0,
      updatedAt: "2026-04-05T20:00:00.000Z",
      projects: [],
      threads: [],
      phaseRuns: [],
      pendingRequests: [],
      workflows: [],
      channels: [
        {
          id: channelId,
          threadId: parentThreadId,
          phaseRunId,
          type: "deliberation",
          status: "open",
          createdAt: "2026-04-05T20:00:00.000Z",
          updatedAt: "2026-04-05T20:00:00.000Z",
        },
      ],
    };

    const orchestrationService = {
      getReadModel: () => Effect.succeed(readModel),
      readEvents: () => Stream.empty,
      streamDomainEvents: Stream.fromPubSub(pubsub),
      dispatch: (command: any) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
    } as any;

    const channelService = {
      createChannel: () => Effect.die("unused"),
      postMessage: () => Effect.die("unused"),
      getUnreadCount: () => Effect.die("unused"),
      getCursor: () => Effect.die("unused"),
      getMessages: ({
        channelId: requestedChannelId,
        afterSequence,
        limit,
      }: {
        readonly channelId: ChannelId;
        readonly afterSequence?: number;
        readonly limit?: number;
      }) =>
        Effect.succeed(
          (messagesByChannel.get(requestedChannelId) ?? [])
            .filter((message) => afterSequence === undefined || message.sequence > afterSequence)
            .slice(0, limit ?? Number.MAX_SAFE_INTEGER),
        ),
      advanceCursor: (input: any) =>
        Effect.sync(() => {
          cursorUpdates.push(input);
        }),
    } as any;

    const deliberationEngine = {
      initialize: () => Effect.succeed(defaultState),
      getState: () => Effect.succeed(Option.some(defaultState)),
      recover: () => Effect.die("unused"),
      recordPost: () =>
        Effect.succeed({
          state: defaultState,
          participantThreadIds: [participantAId, participantBId],
          nextSpeaker: participantBId,
          shouldConcludeChannel: options?.recordPostShouldConclude ?? false,
          forcedConclusion: options?.recordPostShouldConclude ?? false,
        }),
      recordConclusionProposal: () =>
        Effect.succeed({
          state: defaultState,
          participantThreadIds: [participantAId, participantBId],
          nextSpeaker: null,
          shouldConcludeChannel:
            options?.recordConclusionShouldConclude?.[conclusionIndex++] ?? false,
          forcedConclusion: false,
        }),
    } as any;

    const layer = ChannelReactorLive.pipe(
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, orchestrationService)),
      Layer.provideMerge(Layer.succeed(ChannelService, channelService)),
      Layer.provideMerge(Layer.succeed(DeliberationEngine, deliberationEngine)),
    );

    runtime = ManagedRuntime.make(layer as any);
    const reactor = await runtime.runPromise(Effect.service(ChannelReactor));

    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    await Effect.runPromise(Effect.sleep("10 millis"));

    return {
      commands,
      cursorUpdates,
      setMessages: (messages: Array<any>) => {
        messagesByChannel.set(channelId, messages);
      },
      publishEvent: async (event: any) => {
        eventSequence += 1;
        await Effect.runPromise(PubSub.publish(pubsub, makeChannelEvent(event, eventSequence)));
      },
      drain: () => Effect.runPromise(reactor.drain),
    };
  }

  it("advances the posting participant cursor on channel.message-posted", async () => {
    const harness = await createHarness();

    await harness.publishEvent({
      type: "channel.message-posted",
      aggregateKind: "channel",
      aggregateId: channelId,
      commandId: "cmd-channel-message-posted",
      payload: {
        channelId,
        messageId: "message-3",
        sequence: 2,
        fromType: "agent",
        fromId: participantAId,
        fromRole: "advocate",
        content: "Follow-up",
        createdAt: "2026-04-05T20:02:00.000Z",
      },
    });
    await harness.drain();

    expect(harness.cursorUpdates).toEqual([
      {
        channelId,
        sessionId: participantAId,
        sequence: 2,
        updatedAt: "2026-04-05T20:02:00.000Z",
      },
    ]);
    expect(harness.commands).toEqual([]);
  });

  it("does not dispatch channel conclusion after a single conclusion proposal", async () => {
    const harness = await createHarness({
      recordConclusionShouldConclude: [false],
    });

    await harness.publishEvent({
      type: "channel.conclusion-proposed",
      aggregateKind: "channel",
      aggregateId: channelId,
      commandId: "cmd-channel-conclusion-proposed-1",
      payload: {
        channelId,
        threadId: participantAId,
        summary: "We can stop here.",
        proposedAt: "2026-04-05T20:03:00.000Z",
      },
    });
    await harness.drain();

    expect(harness.commands).toEqual([]);
    expect(harness.cursorUpdates).toEqual([
      {
        channelId,
        sessionId: participantAId,
        sequence: 1,
        updatedAt: "2026-04-05T20:03:00.000Z",
      },
    ]);
  });

  it("dispatches channel.mark-concluded once all participants have proposed conclusion", async () => {
    const harness = await createHarness({
      recordConclusionShouldConclude: [false, true],
    });

    await harness.publishEvent({
      type: "channel.conclusion-proposed",
      aggregateKind: "channel",
      aggregateId: channelId,
      commandId: "cmd-channel-conclusion-proposed-1",
      payload: {
        channelId,
        threadId: participantAId,
        summary: "We can stop here.",
        proposedAt: "2026-04-05T20:03:00.000Z",
      },
    });
    await harness.publishEvent({
      type: "channel.conclusion-proposed",
      aggregateKind: "channel",
      aggregateId: channelId,
      commandId: "cmd-channel-conclusion-proposed-2",
      payload: {
        channelId,
        threadId: participantBId,
        summary: "Agreed.",
        proposedAt: "2026-04-05T20:04:00.000Z",
      },
    });
    await harness.drain();

    expect(harness.commands).toEqual([
      {
        type: "channel.mark-concluded",
        commandId: "channel:mark-concluded:channel-reactor",
        channelId,
        createdAt: "2026-04-05T20:04:00.000Z",
      },
    ]);
  });

  it("completes a workflow-backed deliberation phase with the channel transcript", async () => {
    const harness = await createHarness();
    harness.setMessages([
      {
        id: "message-1",
        channelId,
        sequence: 0,
        fromType: "agent",
        fromId: participantAId,
        fromRole: "advocate",
        content: "First finding",
        createdAt: "2026-04-05T20:00:00.000Z",
      },
      {
        id: "message-2",
        channelId,
        sequence: 1,
        fromType: "agent",
        fromId: participantBId,
        fromRole: "critic",
        content: "Second finding",
        createdAt: "2026-04-05T20:01:00.000Z",
      },
    ]);

    await harness.publishEvent({
      type: "channel.concluded",
      aggregateKind: "channel",
      aggregateId: channelId,
      commandId: "cmd-channel-concluded",
      payload: {
        channelId,
        concludedAt: "2026-04-05T20:05:00.000Z",
      },
    });
    await harness.drain();

    expect(harness.commands).toEqual([
      {
        type: "thread.complete-phase",
        commandId: "channel:complete-phase:channel-reactor:phase-run-reactor",
        threadId: parentThreadId,
        phaseRunId,
        outputs: [
          {
            key: "channel",
            content: "[advocate]\nFirst finding\n\n[critic]\nSecond finding",
            sourceType: "channel",
          },
        ],
        createdAt: "2026-04-05T20:05:00.000Z",
      },
    ]);
  });
});
