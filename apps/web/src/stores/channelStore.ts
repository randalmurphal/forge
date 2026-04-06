import type {
  Channel,
  ChannelId,
  ChannelMessage,
  ChannelPushEvent,
  ChannelType,
  OrchestrationReadModel,
  PhaseRunId,
  ThreadId,
} from "@forgetools/contracts";
import { mutationOptions, queryOptions, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { create } from "zustand";
import { newCommandId, newMessageId } from "../lib/utils";
import { ensureNativeApi } from "../nativeApi";
import { getWsRpcClient } from "../wsRpcClient";

export type ChannelSubscriptionStatus = "idle" | "subscribed";

type ChannelMap = Partial<Record<ChannelId, Channel>>;
type ChannelMessagesMap = Partial<Record<ChannelId, ChannelMessage[]>>;
type ChannelTotalsMap = Partial<Record<ChannelId, number>>;
type ChannelPaginationMap = Partial<Record<ChannelId, ChannelMessagePaginationState>>;
type ChannelSubscriptionsMap = Partial<Record<ChannelId, ChannelSubscriptionState>>;
type ChannelDeliberationMap = Partial<Record<ChannelId, ChannelDeliberationState>>;

export interface ChannelParticipantSummary {
  id: ChannelMessage["fromId"];
  role: ChannelMessage["fromRole"] | null;
  type: ChannelMessage["fromType"];
}

export interface ChannelDeliberationState {
  turnCount: number;
  participants: ChannelParticipantSummary[];
}

export interface ChannelMessagePaginationState {
  requestedAfterSequence: number | null;
  loadedThroughSequence: number | null;
  limit: number | null;
  exhausted: boolean;
}

export interface ChannelSubscriptionState {
  listenerCount: number;
  status: ChannelSubscriptionStatus;
}

export interface ChannelStoreSnapshot {
  channelsById: ChannelMap;
  messagesByChannelId: ChannelMessagesMap;
  messageTotalsByChannelId: ChannelTotalsMap;
  messagePaginationByChannelId: ChannelPaginationMap;
  subscriptionStateByChannelId: ChannelSubscriptionsMap;
  deliberationStateByChannelId: ChannelDeliberationMap;
}

export interface ChannelMessagesPageInput {
  channelId: ChannelId;
  messages: readonly ChannelMessage[];
  total: number;
  limit?: number;
  afterSequence?: number | null;
}

export interface ChannelStoreState extends ChannelStoreSnapshot {
  cacheChannel: (channel: Channel) => void;
  cacheChannelMessagesPage: (input: ChannelMessagesPageInput) => void;
  appendChannelMessage: (message: ChannelMessage) => void;
  applyChannelPushEvent: (event: ChannelPushEvent) => void;
  advanceMessagePagination: (channelId: ChannelId) => void;
  attachChannelSubscription: (channelId: ChannelId) => void;
  detachChannelSubscription: (channelId: ChannelId) => void;
}

const DEFAULT_CHANNEL_MESSAGES_STALE_TIME = 5_000;
const DEFAULT_CHANNEL_MESSAGE_LIMIT = 50;

export const channelQueryKeys = {
  all: ["channels"] as const,
  detail: (channelId: ChannelId | null) => ["channels", "detail", channelId] as const,
  byThread: (input: {
    threadId: ThreadId | null;
    phaseRunId?: PhaseRunId | null;
    channelType?: ChannelType | null;
  }) =>
    [
      "channels",
      "by-thread",
      input.threadId,
      input.phaseRunId ?? null,
      input.channelType ?? null,
    ] as const,
  messages: (input: { channelId: ChannelId | null; afterSequence: number | null; limit: number }) =>
    ["channels", "messages", input.channelId, input.afterSequence, input.limit] as const,
};

export const channelMutationKeys = {
  intervene: (channelId: ChannelId | null) =>
    ["channels", "mutation", "intervene", channelId] as const,
};

export const initialChannelStoreState: ChannelStoreSnapshot = {
  channelsById: {},
  messagesByChannelId: {},
  messageTotalsByChannelId: {},
  messagePaginationByChannelId: {},
  subscriptionStateByChannelId: {},
  deliberationStateByChannelId: {},
};

const DEFAULT_SUBSCRIPTION_STATE: ChannelSubscriptionState = {
  listenerCount: 0,
  status: "idle",
};

function channelEquals(left: Channel | undefined, right: Channel): boolean {
  return (
    left !== undefined &&
    left.id === right.id &&
    left.threadId === right.threadId &&
    left.phaseRunId === right.phaseRunId &&
    left.type === right.type &&
    left.status === right.status &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  );
}

function channelMessagesEqual(
  left: readonly ChannelMessage[] | undefined,
  right: readonly ChannelMessage[],
): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((message, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        candidate.id === message.id &&
        candidate.channelId === message.channelId &&
        candidate.sequence === message.sequence &&
        candidate.fromType === message.fromType &&
        candidate.fromId === message.fromId &&
        candidate.fromRole === message.fromRole &&
        candidate.content === message.content &&
        candidate.createdAt === message.createdAt
      );
    })
  );
}

function paginationStateEquals(
  left: ChannelMessagePaginationState | undefined,
  right: ChannelMessagePaginationState,
): boolean {
  return (
    left !== undefined &&
    left.requestedAfterSequence === right.requestedAfterSequence &&
    left.loadedThroughSequence === right.loadedThroughSequence &&
    left.limit === right.limit &&
    left.exhausted === right.exhausted
  );
}

function subscriptionStateEquals(
  left: ChannelSubscriptionState | undefined,
  right: ChannelSubscriptionState,
): boolean {
  return (
    left !== undefined && left.listenerCount === right.listenerCount && left.status === right.status
  );
}

function participantsEqual(
  left: readonly ChannelParticipantSummary[],
  right: readonly ChannelParticipantSummary[],
): boolean {
  return (
    left.length === right.length &&
    left.every((participant, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        candidate.id === participant.id &&
        candidate.role === participant.role &&
        candidate.type === participant.type
      );
    })
  );
}

function deliberationStateEquals(
  left: ChannelDeliberationState | undefined,
  right: ChannelDeliberationState,
): boolean {
  return (
    left !== undefined &&
    left.turnCount === right.turnCount &&
    participantsEqual(left.participants, right.participants)
  );
}

function mergeChannelMessages(
  current: readonly ChannelMessage[],
  incoming: readonly ChannelMessage[],
): ChannelMessage[] {
  const messagesById = new Map<ChannelMessage["id"], ChannelMessage>();
  for (const message of current) {
    messagesById.set(message.id, message);
  }
  for (const message of incoming) {
    messagesById.set(message.id, message);
  }

  return [...messagesById.values()].toSorted((left, right) => left.sequence - right.sequence);
}

export function deriveChannelDeliberationState(
  messages: readonly ChannelMessage[],
): ChannelDeliberationState {
  const participants = new Map<
    string,
    {
      id: ChannelParticipantSummary["id"];
      role: ChannelParticipantSummary["role"];
      type: ChannelParticipantSummary["type"];
    }
  >();

  for (const message of messages) {
    const key = `${message.fromType}:${message.fromId}`;
    if (!participants.has(key)) {
      participants.set(key, {
        id: message.fromId,
        role: message.fromRole ?? null,
        type: message.fromType,
      });
    }
  }

  return {
    turnCount: messages.filter((message) => message.fromType !== "system").length,
    participants: [...participants.values()],
  };
}

export function findThreadChannel(
  snapshot: Pick<OrchestrationReadModel, "channels">,
  input: {
    threadId: ThreadId;
    phaseRunId?: PhaseRunId | null;
    channelType?: ChannelType | null;
  },
): Channel | null {
  if (input.phaseRunId !== undefined && input.phaseRunId !== null) {
    const phaseChannel = snapshot.channels.find(
      (channel) =>
        channel.threadId === input.threadId &&
        channel.phaseRunId === input.phaseRunId &&
        (input.channelType === undefined || input.channelType === null
          ? true
          : channel.type === input.channelType),
    );
    if (phaseChannel) {
      return phaseChannel;
    }
  }

  return (
    snapshot.channels.find(
      (channel) =>
        channel.threadId === input.threadId &&
        (input.channelType === undefined || input.channelType === null
          ? true
          : channel.type === input.channelType),
    ) ?? null
  );
}

function updateSubscriptionState(
  state: ChannelStoreSnapshot,
  channelId: ChannelId,
  next: ChannelSubscriptionState,
): ChannelStoreSnapshot {
  if (subscriptionStateEquals(state.subscriptionStateByChannelId[channelId], next)) {
    return state;
  }

  return {
    ...state,
    subscriptionStateByChannelId: {
      ...state.subscriptionStateByChannelId,
      [channelId]: next,
    },
  };
}

export function cacheChannelState(
  state: ChannelStoreSnapshot,
  channel: Channel,
): ChannelStoreSnapshot {
  if (channelEquals(state.channelsById[channel.id], channel)) {
    return state;
  }

  return {
    ...state,
    channelsById: {
      ...state.channelsById,
      [channel.id]: channel,
    },
  };
}

export function syncChannelMessagesPageState(
  state: ChannelStoreSnapshot,
  input: ChannelMessagesPageInput,
): ChannelStoreSnapshot {
  const currentMessages = state.messagesByChannelId[input.channelId] ?? [];
  const nextMessages = mergeChannelMessages(currentMessages, input.messages);
  const currentPagination = state.messagePaginationByChannelId[input.channelId];
  const nextLoadedThroughSequence =
    input.messages.at(-1)?.sequence ?? currentPagination?.loadedThroughSequence ?? null;
  const nextPagination: ChannelMessagePaginationState = {
    requestedAfterSequence:
      currentPagination?.requestedAfterSequence ?? input.afterSequence ?? null,
    loadedThroughSequence: nextLoadedThroughSequence,
    limit: input.limit ?? currentPagination?.limit ?? null,
    exhausted: input.limit === undefined ? false : input.messages.length < input.limit,
  };
  const nextTotal = Math.max(
    state.messageTotalsByChannelId[input.channelId] ?? 0,
    input.total,
    nextMessages.length,
  );
  const nextDeliberationState = deriveChannelDeliberationState(nextMessages);

  if (
    channelMessagesEqual(state.messagesByChannelId[input.channelId], nextMessages) &&
    (state.messageTotalsByChannelId[input.channelId] ?? 0) === nextTotal &&
    paginationStateEquals(currentPagination, nextPagination) &&
    deliberationStateEquals(
      state.deliberationStateByChannelId[input.channelId],
      nextDeliberationState,
    )
  ) {
    return state;
  }

  return {
    ...state,
    messagesByChannelId: {
      ...state.messagesByChannelId,
      [input.channelId]: nextMessages,
    },
    messageTotalsByChannelId: {
      ...state.messageTotalsByChannelId,
      [input.channelId]: nextTotal,
    },
    messagePaginationByChannelId: {
      ...state.messagePaginationByChannelId,
      [input.channelId]: nextPagination,
    },
    deliberationStateByChannelId: {
      ...state.deliberationStateByChannelId,
      [input.channelId]: nextDeliberationState,
    },
  };
}

export function appendChannelMessageState(
  state: ChannelStoreSnapshot,
  message: ChannelMessage,
): ChannelStoreSnapshot {
  const currentMessages = state.messagesByChannelId[message.channelId] ?? [];
  const alreadyPresent = currentMessages.some((current) => current.id === message.id);
  const limit = state.messagePaginationByChannelId[message.channelId]?.limit;
  const afterSequence =
    state.messagePaginationByChannelId[message.channelId]?.requestedAfterSequence;

  return syncChannelMessagesPageState(state, {
    channelId: message.channelId,
    messages: [message],
    total:
      (state.messageTotalsByChannelId[message.channelId] ?? currentMessages.length) +
      (alreadyPresent ? 0 : 1),
    ...(limit === null || limit === undefined ? {} : { limit }),
    ...(afterSequence === undefined ? {} : { afterSequence }),
  });
}

export function applyChannelPushEventState(
  state: ChannelStoreSnapshot,
  event: ChannelPushEvent,
): ChannelStoreSnapshot {
  switch (event.channel) {
    case "channel.message":
      return appendChannelMessageState(state, event.message);
    case "channel.status": {
      const currentChannel = state.channelsById[event.channelId];
      if (!currentChannel) {
        return state;
      }
      return cacheChannelState(state, {
        ...currentChannel,
        status: event.status,
        updatedAt: event.timestamp,
      });
    }
    case "channel.conclusion":
      return state;
  }
}

export function advanceChannelMessagePaginationState(
  state: ChannelStoreSnapshot,
  channelId: ChannelId,
): ChannelStoreSnapshot {
  const current = state.messagePaginationByChannelId[channelId];
  if (!current || current.loadedThroughSequence === null || current.exhausted) {
    return state;
  }

  const next: ChannelMessagePaginationState = {
    ...current,
    requestedAfterSequence: current.loadedThroughSequence,
  };

  if (paginationStateEquals(current, next)) {
    return state;
  }

  return {
    ...state,
    messagePaginationByChannelId: {
      ...state.messagePaginationByChannelId,
      [channelId]: next,
    },
  };
}

export function attachChannelSubscriptionState(
  state: ChannelStoreSnapshot,
  channelId: ChannelId,
): ChannelStoreSnapshot {
  const current = state.subscriptionStateByChannelId[channelId] ?? DEFAULT_SUBSCRIPTION_STATE;
  return updateSubscriptionState(state, channelId, {
    listenerCount: current.listenerCount + 1,
    status: "subscribed",
  });
}

export function detachChannelSubscriptionState(
  state: ChannelStoreSnapshot,
  channelId: ChannelId,
): ChannelStoreSnapshot {
  const current = state.subscriptionStateByChannelId[channelId] ?? DEFAULT_SUBSCRIPTION_STATE;
  const listenerCount = Math.max(0, current.listenerCount - 1);
  return updateSubscriptionState(state, channelId, {
    listenerCount,
    status: listenerCount === 0 ? "idle" : "subscribed",
  });
}

export function channelQueryOptions(channelId: ChannelId | null) {
  return queryOptions({
    queryKey: channelQueryKeys.detail(channelId),
    queryFn: async () => {
      if (!channelId) {
        throw new Error("Channel is unavailable.");
      }
      return (await getWsRpcClient().channel.getChannel({ channelId })).channel;
    },
    enabled: channelId !== null,
    staleTime: DEFAULT_CHANNEL_MESSAGES_STALE_TIME,
  });
}

export function threadChannelQueryOptions(input: {
  threadId: ThreadId | null;
  phaseRunId?: PhaseRunId | null;
  channelType?: ChannelType | null;
}) {
  return queryOptions({
    queryKey: channelQueryKeys.byThread(input),
    queryFn: async () => {
      if (!input.threadId) {
        throw new Error("Thread channel is unavailable.");
      }

      const snapshot = await getWsRpcClient().orchestration.getSnapshot();
      return findThreadChannel(snapshot, {
        threadId: input.threadId,
        ...(input.phaseRunId === undefined ? {} : { phaseRunId: input.phaseRunId }),
        ...(input.channelType === undefined ? {} : { channelType: input.channelType }),
      });
    },
    enabled: input.threadId !== null,
    staleTime: DEFAULT_CHANNEL_MESSAGES_STALE_TIME,
    placeholderData: (previous) => previous ?? null,
  });
}

export function channelMessagesQueryOptions(input: {
  channelId: ChannelId | null;
  afterSequence?: number | null;
  limit?: number;
}) {
  const limit = input.limit ?? DEFAULT_CHANNEL_MESSAGE_LIMIT;

  return queryOptions({
    queryKey: channelQueryKeys.messages({
      channelId: input.channelId,
      afterSequence: input.afterSequence ?? null,
      limit,
    }),
    queryFn: async () => {
      if (!input.channelId) {
        throw new Error("Channel messages are unavailable.");
      }
      return await getWsRpcClient().channel.getMessages({
        channelId: input.channelId,
        limit,
        ...(input.afterSequence === null || input.afterSequence === undefined
          ? {}
          : { afterSequence: input.afterSequence }),
      });
    },
    enabled: input.channelId !== null,
    staleTime: DEFAULT_CHANNEL_MESSAGES_STALE_TIME,
    placeholderData: (previous) => previous,
  });
}

export function channelInterveneMutationOptions(input: {
  channelId: ChannelId | null;
  fromRole?: string | null;
}) {
  return mutationOptions({
    mutationKey: channelMutationKeys.intervene(input.channelId),
    mutationFn: async (content: string) => {
      if (!input.channelId) {
        throw new Error("Channel intervention is unavailable.");
      }

      const api = ensureNativeApi();
      return api.orchestration.dispatchCommand({
        type: "channel.post-message",
        commandId: newCommandId(),
        channelId: input.channelId,
        messageId: newMessageId(),
        fromType: "human",
        fromId: "human",
        content,
        ...(input.fromRole ? { fromRole: input.fromRole } : {}),
        createdAt: new Date().toISOString(),
      } as unknown as Parameters<typeof api.orchestration.dispatchCommand>[0]);
    },
  });
}

export const useChannelStore = create<ChannelStoreState>((set) => ({
  ...initialChannelStoreState,
  cacheChannel: (channel) => set((state) => cacheChannelState(state, channel)),
  cacheChannelMessagesPage: (input) => set((state) => syncChannelMessagesPageState(state, input)),
  appendChannelMessage: (message) => set((state) => appendChannelMessageState(state, message)),
  applyChannelPushEvent: (event) => set((state) => applyChannelPushEventState(state, event)),
  advanceMessagePagination: (channelId) =>
    set((state) => advanceChannelMessagePaginationState(state, channelId)),
  attachChannelSubscription: (channelId) =>
    set((state) => attachChannelSubscriptionState(state, channelId)),
  detachChannelSubscription: (channelId) =>
    set((state) => detachChannelSubscriptionState(state, channelId)),
}));

export function useChannel(channelId: ChannelId | null) {
  const cacheChannel = useChannelStore((state) => state.cacheChannel);
  const query = useQuery(channelQueryOptions(channelId));

  useEffect(() => {
    if (query.data) {
      cacheChannel(query.data);
    }
  }, [cacheChannel, query.data]);

  return query;
}

export function useThreadChannel(input: {
  threadId: ThreadId | null;
  phaseRunId?: PhaseRunId | null;
  channelType?: ChannelType | null;
}) {
  const cacheChannel = useChannelStore((state) => state.cacheChannel);
  const query = useQuery(threadChannelQueryOptions(input));

  useEffect(() => {
    if (query.data) {
      cacheChannel(query.data);
    }
  }, [cacheChannel, query.data]);

  return query;
}

export function useChannelMessages(
  channelId: ChannelId | null,
  limit = DEFAULT_CHANNEL_MESSAGE_LIMIT,
) {
  const attachChannelSubscription = useChannelStore((state) => state.attachChannelSubscription);
  const detachChannelSubscription = useChannelStore((state) => state.detachChannelSubscription);
  const applyChannelPushEvent = useChannelStore((state) => state.applyChannelPushEvent);
  const cacheChannelMessagesPage = useChannelStore((state) => state.cacheChannelMessagesPage);
  const requestedAfterSequence = useChannelStore(
    (state) =>
      (channelId ? state.messagePaginationByChannelId[channelId]?.requestedAfterSequence : null) ??
      null,
  );

  const query = useQuery(
    channelMessagesQueryOptions({
      channelId,
      afterSequence: requestedAfterSequence,
      limit,
    }),
  );

  useEffect(() => {
    if (!channelId) {
      return undefined;
    }

    attachChannelSubscription(channelId);
    const unsubscribe = getWsRpcClient().channel.onEvent({ channelId }, (event) => {
      applyChannelPushEvent(event);
    });

    return () => {
      unsubscribe();
      detachChannelSubscription(channelId);
    };
  }, [applyChannelPushEvent, attachChannelSubscription, channelId, detachChannelSubscription]);

  useEffect(() => {
    if (!channelId || !query.data) {
      return;
    }

    cacheChannelMessagesPage({
      channelId,
      messages: query.data.messages,
      total: query.data.total,
      limit,
      afterSequence: requestedAfterSequence,
    });
  }, [cacheChannelMessagesPage, channelId, limit, query.data, requestedAfterSequence]);

  return query;
}
