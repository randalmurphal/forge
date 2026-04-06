import type { Channel, ChannelMessage, ChannelPushEvent } from "@forgetools/contracts";
import { ChannelId, ChannelMessageId, ThreadId } from "@forgetools/contracts";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../wsRpcClient", () => ({
  getWsRpcClient: vi.fn(),
}));

import { getWsRpcClient } from "../wsRpcClient";
import {
  advanceChannelMessagePaginationState,
  appendChannelMessageState,
  applyChannelPushEventState,
  cacheChannelState,
  channelMessagesQueryOptions,
  channelQueryKeys,
  channelQueryOptions,
  deriveChannelDeliberationState,
  initialChannelStoreState,
  syncChannelMessagesPageState,
  useChannelStore,
} from "./channelStore";

const getWsRpcClientMock = vi.mocked(getWsRpcClient);

function makeChannel(channelId = "channel-1", overrides: Partial<Channel> = {}): Channel {
  return {
    id: ChannelId.makeUnsafe(channelId),
    threadId: ThreadId.makeUnsafe("thread-1"),
    type: "deliberation",
    status: "open",
    createdAt: "2026-04-06T00:00:00.000Z",
    updatedAt: "2026-04-06T00:00:00.000Z",
    ...overrides,
  };
}

function makeChannelMessage(
  sequence: number,
  overrides: Partial<ChannelMessage> = {},
): ChannelMessage {
  return {
    id: ChannelMessageId.makeUnsafe(`channel-message-${sequence}`),
    channelId: ChannelId.makeUnsafe("channel-1"),
    sequence,
    fromType: "agent",
    fromId: ThreadId.makeUnsafe(`participant-${sequence}`),
    fromRole: sequence % 2 === 0 ? "interrogator" : "advocate",
    content: `message ${sequence}`,
    createdAt: `2026-04-06T00:00:0${sequence}.000Z`,
    ...overrides,
  };
}

function resetChannelStore() {
  useChannelStore.setState(initialChannelStoreState);
}

beforeEach(() => {
  resetChannelStore();
  vi.resetAllMocks();
});

describe("channel store state helpers", () => {
  it("caches channels by id", () => {
    const channel = makeChannel();
    const next = cacheChannelState(initialChannelStoreState, channel);

    expect(next.channelsById[channel.id]).toEqual(channel);
  });

  it("updates channel messages and derives deliberation participants", () => {
    const channelId = ChannelId.makeUnsafe("channel-1");
    const next = syncChannelMessagesPageState(initialChannelStoreState, {
      channelId,
      messages: [
        makeChannelMessage(1, {
          fromId: ThreadId.makeUnsafe("advocate-thread"),
          fromRole: "advocate",
        }),
        makeChannelMessage(2, {
          fromId: ThreadId.makeUnsafe("interrogator-thread"),
          fromRole: "interrogator",
        }),
      ],
      total: 2,
      limit: 2,
      afterSequence: null,
    });

    expect(next.messagesByChannelId[channelId]?.map((message) => message.sequence)).toEqual([1, 2]);
    expect(next.messagePaginationByChannelId[channelId]).toEqual({
      requestedAfterSequence: null,
      loadedThroughSequence: 2,
      limit: 2,
      exhausted: false,
    });
    expect(next.deliberationStateByChannelId[channelId]).toEqual({
      turnCount: 2,
      participants: [
        {
          id: ThreadId.makeUnsafe("advocate-thread"),
          role: "advocate",
          type: "agent",
        },
        {
          id: ThreadId.makeUnsafe("interrogator-thread"),
          role: "interrogator",
          type: "agent",
        },
      ],
    });
  });

  it("appends push messages without duplicating existing entries", () => {
    const first = makeChannelMessage(1);
    const second = makeChannelMessage(2, {
      fromId: ThreadId.makeUnsafe("participant-2"),
      fromRole: "interrogator",
    });
    const seeded = syncChannelMessagesPageState(initialChannelStoreState, {
      channelId: first.channelId,
      messages: [first],
      total: 1,
      limit: 50,
      afterSequence: null,
    });
    const pushEvent: ChannelPushEvent = {
      channel: "channel.message",
      channelId: first.channelId,
      threadId: ThreadId.makeUnsafe("thread-1"),
      message: second,
      timestamp: "2026-04-06T00:00:02.000Z",
    };

    const next = applyChannelPushEventState(seeded, pushEvent);
    const deduped = appendChannelMessageState(next, second);

    expect(next.messagesByChannelId[first.channelId]?.map((message) => message.sequence)).toEqual([
      1, 2,
    ]);
    expect(deduped.messagesByChannelId[first.channelId]).toHaveLength(2);
    expect(deduped.deliberationStateByChannelId[first.channelId]?.turnCount).toBe(2);
  });

  it("advances the pagination cursor to the most recent loaded sequence", () => {
    const channelId = ChannelId.makeUnsafe("channel-1");
    const seeded = syncChannelMessagesPageState(initialChannelStoreState, {
      channelId,
      messages: [makeChannelMessage(1), makeChannelMessage(2)],
      total: 2,
      limit: 2,
      afterSequence: null,
    });

    const next = advanceChannelMessagePaginationState(seeded, channelId);

    expect(next.messagePaginationByChannelId[channelId]).toEqual({
      requestedAfterSequence: 2,
      loadedThroughSequence: 2,
      limit: 2,
      exhausted: false,
    });
  });

  it("derives participants in first-seen order and ignores system turns in the counter", () => {
    const state = deriveChannelDeliberationState([
      makeChannelMessage(1, {
        fromId: ThreadId.makeUnsafe("participant-a"),
        fromRole: "advocate",
      }),
      makeChannelMessage(2, {
        fromType: "system",
        fromId: "system",
        fromRole: undefined,
      }),
      makeChannelMessage(3, {
        fromId: ThreadId.makeUnsafe("participant-b"),
        fromRole: "interrogator",
      }),
    ]);

    expect(state).toEqual({
      turnCount: 2,
      participants: [
        {
          id: ThreadId.makeUnsafe("participant-a"),
          role: "advocate",
          type: "agent",
        },
        {
          id: "system",
          role: null,
          type: "system",
        },
        {
          id: ThreadId.makeUnsafe("participant-b"),
          role: "interrogator",
          type: "agent",
        },
      ],
    });
  });
});

describe("useChannelStore actions", () => {
  it("tracks subscription ref counts per channel", () => {
    const channelId = ChannelId.makeUnsafe("channel-1");
    const store = useChannelStore.getState();

    store.attachChannelSubscription(channelId);
    store.attachChannelSubscription(channelId);
    expect(useChannelStore.getState().subscriptionStateByChannelId[channelId]).toEqual({
      listenerCount: 2,
      status: "subscribed",
    });

    store.detachChannelSubscription(channelId);
    store.detachChannelSubscription(channelId);
    expect(useChannelStore.getState().subscriptionStateByChannelId[channelId]).toEqual({
      listenerCount: 0,
      status: "idle",
    });
  });
});

describe("channel query options", () => {
  it("fetches a channel with a typed result", async () => {
    const channel = makeChannel();
    const getChannel = vi.fn().mockResolvedValue({ channel });
    getWsRpcClientMock.mockReturnValue({
      channel: {
        getChannel,
        getMessages: vi.fn(),
        onEvent: vi.fn(),
      },
    } as unknown as ReturnType<typeof getWsRpcClient>);

    const queryClient = new QueryClient();
    const result = await queryClient.fetchQuery(channelQueryOptions(channel.id));
    const typedResult: Channel = result;

    expect(typedResult).toEqual(channel);
    expect(getChannel).toHaveBeenCalledWith({ channelId: channel.id });
  });

  it("fetches a page of channel messages with a typed payload", async () => {
    const messages = [makeChannelMessage(1), makeChannelMessage(2)];
    const getMessages = vi.fn().mockResolvedValue({
      messages,
      total: 2,
    });
    getWsRpcClientMock.mockReturnValue({
      channel: {
        getChannel: vi.fn(),
        getMessages,
        onEvent: vi.fn(),
      },
    } as unknown as ReturnType<typeof getWsRpcClient>);

    const queryClient = new QueryClient();
    const result = await queryClient.fetchQuery(
      channelMessagesQueryOptions({
        channelId: messages[0]!.channelId,
        afterSequence: 1,
        limit: 2,
      }),
    );
    const typedMessages: ReadonlyArray<ChannelMessage> = result.messages;

    expect(typedMessages).toEqual(messages);
    expect(result.total).toBe(2);
    expect(getMessages).toHaveBeenCalledWith({
      channelId: messages[0]!.channelId,
      afterSequence: 1,
      limit: 2,
    });
  });

  it("scopes channel message queries by cursor", () => {
    expect(
      channelQueryKeys.messages({
        channelId: ChannelId.makeUnsafe("channel-1"),
        afterSequence: 1,
        limit: 50,
      }),
    ).not.toEqual(
      channelQueryKeys.messages({
        channelId: ChannelId.makeUnsafe("channel-1"),
        afterSequence: 2,
        limit: 50,
      }),
    );
  });
});
