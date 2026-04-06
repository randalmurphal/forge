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

type ChannelMap = Partial<Record<ChannelId, Channel>>;
type ChannelMessagesMap = Partial<Record<ChannelId, ChannelMessage[]>>;
type ChannelPaginationMap = Partial<Record<ChannelId, ChannelMessagePaginationState>>;
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

export interface ChannelStoreSnapshot {
  channelsById: ChannelMap;
  messagesByChannelId: ChannelMessagesMap;
  messagePaginationByChannelId: ChannelPaginationMap;
  deliberationStateByChannelId: ChannelDeliberationMap;
}

export interface ChannelMessagesPageInput {
  channelId: ChannelId;
  messages: readonly ChannelMessage[];
  limit?: number;
  afterSequence?: number | null;
}

export interface ChannelStoreState extends ChannelStoreSnapshot {
  cacheChannel: (channel: Channel) => void;
  cacheChannelMessagesPage: (input: ChannelMessagesPageInput) => void;
  applyChannelPushEvent: (event: ChannelPushEvent) => void;
  advanceMessagePagination: (channelId: ChannelId) => void;
}

const DEFAULT_CHANNEL_MESSAGES_STALE_TIME = 5_000;
const DEFAULT_CHANNEL_MESSAGE_LIMIT = 50;

export const channelQueryKeys = {
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
  messagePaginationByChannelId: {},
  deliberationStateByChannelId: {},
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
  const nextDeliberationState = deriveChannelDeliberationState(nextMessages);

  if (
    channelMessagesEqual(state.messagesByChannelId[input.channelId], nextMessages) &&
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
  const limit = state.messagePaginationByChannelId[message.channelId]?.limit;
  const afterSequence =
    state.messagePaginationByChannelId[message.channelId]?.requestedAfterSequence;

  return syncChannelMessagesPageState(state, {
    channelId: message.channelId,
    messages: [message],
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
  applyChannelPushEvent: (event) => set((state) => applyChannelPushEventState(state, event)),
  advanceMessagePagination: (channelId) =>
    set((state) => advanceChannelMessagePaginationState(state, channelId)),
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
    if (!channelId || !query.data) {
      return;
    }

    cacheChannelMessagesPage({
      channelId,
      messages: query.data.messages,
      limit,
      afterSequence: requestedAfterSequence,
    });
  }, [cacheChannelMessagesPage, channelId, limit, query.data, requestedAfterSequence]);

  return query;
}
