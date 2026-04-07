import type { OrchestrationEvent } from "@forgetools/contracts";
import { Effect, PubSub, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { orderedReplayAndLiveStream } from "./orderedReplayAndLiveStream.ts";

const makeEvent = (sequence: number): OrchestrationEvent =>
  ({
    sequence,
    eventId: `event-${sequence}`,
    aggregateKind: "thread",
    aggregateId: "thread-1",
    occurredAt: "2026-04-07T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.reverted",
    payload: {
      threadId: "thread-1",
      turnCount: sequence,
    },
  }) as OrchestrationEvent;

describe("orderedReplayAndLiveStream", () => {
  it("deduplicates overlapping replay and live events in sequence order", async () => {
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
          const liveSubscription = yield* PubSub.subscribe(liveEvents);
          yield* PubSub.publish(liveEvents, makeEvent(3));
          yield* PubSub.publish(liveEvents, makeEvent(4));

          return yield* orderedReplayAndLiveStream({
            afterSequence: 1,
            replayStream: Stream.make(makeEvent(2), makeEvent(3)),
            liveSubscription,
          }).pipe(Stream.take(3), Stream.runCollect);
        }),
      ),
    );

    expect(Array.from(events).map((event) => event.sequence)).toEqual([2, 3, 4]);
  });

  it("does not miss a live event published while replay starts", async () => {
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pubsub = yield* PubSub.unbounded<OrchestrationEvent>();
          const liveSubscription = yield* PubSub.subscribe(pubsub);

          return yield* orderedReplayAndLiveStream({
            afterSequence: 0,
            replayStream: Stream.unwrap(
              Effect.gen(function* () {
                yield* PubSub.publish(pubsub, makeEvent(2));
                return Stream.make(makeEvent(1));
              }),
            ),
            liveSubscription,
          }).pipe(Stream.take(2), Stream.runCollect);
        }),
      ),
    );

    expect(Array.from(events).map((event) => event.sequence)).toEqual([1, 2]);
  });
});
