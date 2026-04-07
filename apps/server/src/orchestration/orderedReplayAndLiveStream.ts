import { Effect, PubSub, Ref, Scope, Stream } from "effect";

type OrderedSequenceState<TEvent extends { readonly sequence: number }> = {
  readonly nextSequence: number;
  readonly pendingBySequence: Map<number, TEvent>;
};

function flushSequencedEvents<TEvent extends { readonly sequence: number }>(
  state: OrderedSequenceState<TEvent>,
  event: TEvent,
): [Array<TEvent>, OrderedSequenceState<TEvent>] {
  const { nextSequence, pendingBySequence } = state;
  if (event.sequence < nextSequence || pendingBySequence.has(event.sequence)) {
    return [[], state];
  }

  const updatedPending = new Map(pendingBySequence);
  updatedPending.set(event.sequence, event);

  const emit: Array<TEvent> = [];
  let expected = nextSequence;
  for (;;) {
    const expectedEvent = updatedPending.get(expected);
    if (!expectedEvent) {
      break;
    }
    emit.push(expectedEvent);
    updatedPending.delete(expected);
    expected += 1;
  }

  return [
    emit,
    {
      nextSequence: expected,
      pendingBySequence: updatedPending,
    },
  ];
}

export function orderedReplayAndLiveStream<
  TEvent extends { readonly sequence: number },
  E1,
  R1,
>(input: {
  readonly afterSequence: number;
  readonly replayStream: Stream.Stream<TEvent, E1, R1>;
  readonly liveSubscription: PubSub.Subscription<TEvent>;
}): Stream.Stream<TEvent, E1, Exclude<R1, Scope.Scope>> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const state = yield* Ref.make<OrderedSequenceState<TEvent>>({
        nextSequence: input.afterSequence + 1,
        pendingBySequence: new Map<number, TEvent>(),
      });

      return Stream.merge(input.replayStream, Stream.fromSubscription(input.liveSubscription)).pipe(
        Stream.mapEffect((event) =>
          Ref.modify(state, (current) => flushSequencedEvents(current, event)),
        ),
        Stream.flatMap((events) => Stream.fromIterable(events)),
      );
    }),
  ) as Stream.Stream<TEvent, E1, Exclude<R1, Scope.Scope>>;
}
