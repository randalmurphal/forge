import {
  Channel,
  ChannelId,
  ChannelMessage,
  ChannelMessageId,
  ChannelParticipantType,
  ChannelType,
  CommandId,
  IsoDateTime,
  PhaseRunId,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "@forgetools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import {
  ChannelSequenceCursor,
  QUERY_PROJECTION_CHANNEL_MESSAGES_MAX_LIMIT,
} from "../../persistence/Services/ProjectionChannelMessages.ts";
import type { ChannelServiceError } from "../Errors.ts";

const ChannelServiceMessageLimit = PositiveInt.check(
  Schema.isLessThanOrEqualTo(QUERY_PROJECTION_CHANNEL_MESSAGES_MAX_LIMIT),
);

export const CreateChannelInput = Schema.Struct({
  threadId: ThreadId,
  type: ChannelType,
  phaseRunId: Schema.optional(PhaseRunId),
  channelId: Schema.optional(ChannelId),
  commandId: Schema.optional(CommandId),
  createdAt: Schema.optional(IsoDateTime),
});
export type CreateChannelInput = typeof CreateChannelInput.Type;

export const PostChannelMessageInput = Schema.Struct({
  channelId: ChannelId,
  fromType: ChannelParticipantType,
  fromId: TrimmedNonEmptyString,
  fromRole: Schema.optional(TrimmedNonEmptyString),
  content: Schema.String,
  cursorThreadId: Schema.optional(ThreadId),
  messageId: Schema.optional(ChannelMessageId),
  commandId: Schema.optional(CommandId),
  createdAt: Schema.optional(IsoDateTime),
});
export type PostChannelMessageInput = typeof PostChannelMessageInput.Type;

export const GetChannelMessagesInput = Schema.Struct({
  channelId: ChannelId,
  afterSequence: Schema.optional(ChannelSequenceCursor),
  limit: Schema.optional(ChannelServiceMessageLimit),
});
export type GetChannelMessagesInput = typeof GetChannelMessagesInput.Type;

export const GetChannelUnreadCountInput = Schema.Struct({
  channelId: ChannelId,
  sessionId: ThreadId,
});
export type GetChannelUnreadCountInput = typeof GetChannelUnreadCountInput.Type;

export const GetChannelCursorInput = Schema.Struct({
  channelId: ChannelId,
  sessionId: ThreadId,
});
export type GetChannelCursorInput = typeof GetChannelCursorInput.Type;

export const AdvanceChannelCursorInput = Schema.Struct({
  channelId: ChannelId,
  sessionId: ThreadId,
  sequence: ChannelSequenceCursor,
  updatedAt: Schema.optional(IsoDateTime),
});
export type AdvanceChannelCursorInput = typeof AdvanceChannelCursorInput.Type;

export interface ChannelServiceShape {
  readonly createChannel: (
    input: CreateChannelInput,
  ) => Effect.Effect<Channel, ChannelServiceError>;
  readonly postMessage: (
    input: PostChannelMessageInput,
  ) => Effect.Effect<ChannelMessage, ChannelServiceError>;
  readonly getMessages: (
    input: GetChannelMessagesInput,
  ) => Effect.Effect<ReadonlyArray<ChannelMessage>, ChannelServiceError>;
  readonly getUnreadCount: (
    input: GetChannelUnreadCountInput,
  ) => Effect.Effect<number, ChannelServiceError>;
  readonly getCursor: (
    input: GetChannelCursorInput,
  ) => Effect.Effect<ChannelSequenceCursor, ChannelServiceError>;
  readonly advanceCursor: (
    input: AdvanceChannelCursorInput,
  ) => Effect.Effect<void, ChannelServiceError>;
}

export class ChannelService extends ServiceMap.Service<ChannelService, ChannelServiceShape>()(
  "t3/channel/Services/ChannelService",
) {}
