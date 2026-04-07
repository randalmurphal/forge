import { EventId, type ForgeEvent, ThreadId, WS_METHODS } from "@forgetools/contracts";
import { Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import { createWsRpcClient } from "./wsRpcClient";
import type { WsTransport } from "./wsTransport";

function makeEvent(sequence: number): Extract<ForgeEvent, { type: "thread.bootstrap-started" }> {
  return {
    sequence,
    eventId: EventId.makeUnsafe(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: ThreadId.makeUnsafe("thread-1"),
    occurredAt: "2026-04-07T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.bootstrap-started",
    payload: {
      threadId: ThreadId.makeUnsafe("thread-1"),
      startedAt: "2026-04-07T00:00:00.000Z",
    },
  };
}

describe("createWsRpcClient", () => {
  it("resumes orchestration domain event subscriptions from the last delivered sequence", () => {
    const subscribe = vi.fn(
      (
        connect: (client: any) => Stream.Stream<ForgeEvent, Error, never>,
        listener: (event: ForgeEvent) => void,
      ) => {
        subscriptions.push({ connect, listener });
        return () => undefined;
      },
    );
    const subscriptions: Array<{
      connect: (client: any) => Stream.Stream<ForgeEvent, Error, never>;
      listener: (event: ForgeEvent) => void;
    }> = [];
    const transport = {
      subscribe,
      request: vi.fn(),
      requestStream: vi.fn(),
      dispose: vi.fn(),
    } as unknown as WsTransport;
    const client = createWsRpcClient(transport);
    const listener = vi.fn();
    const firstSubscribe = vi.fn(() => Stream.empty);
    const secondSubscribe = vi.fn(() => Stream.empty);
    const thirdSubscribe = vi.fn(() => Stream.empty);

    client.orchestration.onDomainEvent(listener);

    expect(subscribe).toHaveBeenCalledTimes(1);
    subscriptions[0]!.connect({
      [WS_METHODS.subscribeOrchestrationDomainEvents]: firstSubscribe,
    });
    expect(firstSubscribe).toHaveBeenCalledWith({});

    subscriptions[0]!.listener(makeEvent(5));
    subscriptions[0]!.connect({
      [WS_METHODS.subscribeOrchestrationDomainEvents]: secondSubscribe,
    });
    expect(secondSubscribe).toHaveBeenCalledWith({ fromSequenceExclusive: 5 });

    subscriptions[0]!.listener(makeEvent(8));
    subscriptions[0]!.listener(makeEvent(6));
    subscriptions[0]!.connect({
      [WS_METHODS.subscribeOrchestrationDomainEvents]: thirdSubscribe,
    });
    expect(thirdSubscribe).toHaveBeenCalledWith({ fromSequenceExclusive: 8 });
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
