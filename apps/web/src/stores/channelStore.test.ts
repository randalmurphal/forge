import type { Channel, ChannelMessage, ChannelPushEvent } from "@forgetools/contracts";
import { ChannelId, ChannelMessageId, PhaseRunId, ThreadId } from "@forgetools/contracts";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../wsRpcClient", () => ({
  getWsRpcClient: vi.fn(),
}));
vi.mock("../nativeApi", () => ({
  ensureNativeApi: vi.fn(),
}));

import { ensureNativeApi } from "../nativeApi";
import { getWsRpcClient } from "../wsRpcClient";
import {
  advanceChannelMessagePaginationState,
  appendChannelMessageState,
  applyChannelPushEventState,
  cacheChannelState,
  channelInterveneMutationOptions,
  channelMessagesQueryOptions,
  channelQueryKeys,
  channelQueryOptions,
  deriveChannelDeliberationState,
  findThreadChannel,
  initialChannelStoreState,
  syncChannelMessagesPageState,
  threadChannelQueryOptions,
  useChannelStore,
} from "./channelStore";

const getWsRpcClientMock = vi.mocked(getWsRpcClient);
const ensureNativeApiMock = vi.mocked(ensureNativeApi);

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

function mockWsRpcClient(
  overrides: {
    getChannel?: ReturnType<typeof vi.fn>;
    getMessages?: ReturnType<typeof vi.fn>;
    getSnapshot?: ReturnType<typeof vi.fn>;
  } = {},
) {
  getWsRpcClientMock.mockReturnValue({
    channel: {
      getChannel: overrides.getChannel ?? vi.fn(),
      getMessages: overrides.getMessages ?? vi.fn(),
      onEvent: vi.fn(),
    },
    orchestration: {
      getSnapshot: overrides.getSnapshot ?? vi.fn(),
    },
  } as unknown as ReturnType<typeof getWsRpcClient>);
}

function mockNativeApiDispatch(dispatchCommand = vi.fn()) {
  ensureNativeApiMock.mockReturnValue({
    orchestration: {
      dispatchCommand,
    },
  } as unknown as ReturnType<typeof ensureNativeApi>);
  return dispatchCommand;
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

  it("finds the deliberation channel for a thread and prefers an exact phase run match", () => {
    const threadId = ThreadId.makeUnsafe("thread-parent");
    const exact = makeChannel("channel-exact", {
      threadId,
      phaseRunId: "phase-run-2",
      type: "deliberation",
    });
    const fallback = makeChannel("channel-fallback", {
      threadId,
      phaseRunId: "phase-run-1",
      type: "deliberation",
    });

    const result = findThreadChannel(
      {
        channels: [
          makeChannel("channel-guidance", { threadId, type: "guidance" }),
          fallback,
          exact,
        ],
      },
      {
        threadId,
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-2"),
        channelType: "deliberation",
      },
    );

    expect(result).toEqual(exact);
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
    mockWsRpcClient({ getChannel });

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
    mockWsRpcClient({ getMessages });

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

  it("fetches a deliberation channel by thread id through the snapshot query", async () => {
    const threadId = ThreadId.makeUnsafe("thread-parent");
    const channel = makeChannel("channel-lookup", {
      threadId,
      type: "deliberation",
    });
    const getSnapshot = vi.fn().mockResolvedValue({
      snapshotSequence: 1,
      projects: [],
      threads: [],
      phaseRuns: [],
      channels: [channel],
      pendingRequests: [],
      workflows: [],
      updatedAt: "2026-04-06T00:00:00.000Z",
    });
    mockWsRpcClient({ getSnapshot });

    const queryClient = new QueryClient();
    const result = await queryClient.fetchQuery(
      threadChannelQueryOptions({
        threadId,
        channelType: "deliberation",
      }),
    );

    expect(result).toEqual(channel);
    expect(getSnapshot).toHaveBeenCalledTimes(1);
  });
});

describe("channel mutation options", () => {
  it("posts human interventions through the orchestration command api", async () => {
    const dispatchCommand = mockNativeApiDispatch(vi.fn().mockResolvedValue({ ok: true }));
    const channelId = ChannelId.makeUnsafe("channel-1");

    const options = channelInterveneMutationOptions({
      channelId,
      fromRole: "human-reviewer",
    });
    await options.mutationFn?.("Please test the rollback path.", {} as never);

    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "channel.post-message",
        channelId,
        fromType: "human",
        fromId: "human",
        content: "Please test the rollback path.",
        fromRole: "human-reviewer",
      }),
    );
  });
});
