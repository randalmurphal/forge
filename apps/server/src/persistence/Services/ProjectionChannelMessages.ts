/**
 * ProjectionChannelMessageRepository - Projection repository interface for channel messages.
 *
 * Owns persistence operations for projected channel transcript rows.
 *
 * @module ProjectionChannelMessageRepository
 */
import {
  ChannelId,
  ChannelMessageId,
  ChannelParticipantType,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ChannelSequenceCursor = Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1));
export type ChannelSequenceCursor = typeof ChannelSequenceCursor.Type;

const ProjectionChannelMessageMetadata = Schema.Record(Schema.String, Schema.Unknown);

export const ProjectionChannelMessage = Schema.Struct({
  messageId: ChannelMessageId,
  channelId: ChannelId,
  sequence: NonNegativeInt,
  fromType: ChannelParticipantType,
  fromId: TrimmedNonEmptyString,
  fromRole: Schema.NullOr(TrimmedNonEmptyString),
  content: Schema.String,
  metadata: Schema.NullOr(ProjectionChannelMessageMetadata),
  createdAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionChannelMessage = typeof ProjectionChannelMessage.Type;

export const QUERY_PROJECTION_CHANNEL_MESSAGES_DEFAULT_LIMIT = 50;
export const QUERY_PROJECTION_CHANNEL_MESSAGES_MAX_LIMIT = 200;

export const QueryProjectionChannelMessagesByChannelIdInput = Schema.Struct({
  channelId: ChannelId,
  cursor: Schema.optional(ChannelSequenceCursor),
  limit: PositiveInt.check(
    Schema.isLessThanOrEqualTo(QUERY_PROJECTION_CHANNEL_MESSAGES_MAX_LIMIT),
  ).pipe(Schema.withDecodingDefault(() => QUERY_PROJECTION_CHANNEL_MESSAGES_DEFAULT_LIMIT as any)),
});
export type QueryProjectionChannelMessagesByChannelIdInput =
  typeof QueryProjectionChannelMessagesByChannelIdInput.Type;

export const GetProjectionChannelUnreadCountInput = Schema.Struct({
  channelId: ChannelId,
  threadId: ThreadId,
});
export type GetProjectionChannelUnreadCountInput = typeof GetProjectionChannelUnreadCountInput.Type;

/**
 * ProjectionChannelMessageRepositoryShape - Service API for channel messages.
 */
export interface ProjectionChannelMessageRepositoryShape {
  /**
   * Insert or refresh a projected channel message row.
   *
   * Uses `messageId` as the durable identity for idempotent projector writes.
   */
  readonly insert: (
    row: ProjectionChannelMessage,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * List channel messages for a channel using forward pagination by sequence.
   *
   * When `cursor` is provided, only messages with `sequence > cursor` are returned.
   */
  readonly queryByChannelId: (
    input: QueryProjectionChannelMessagesByChannelIdInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionChannelMessage>, ProjectionRepositoryError>;

  /**
   * Count unread messages for a participating thread using `channel_reads`.
   *
   * Soft-deleted messages are excluded from the count.
   */
  readonly getUnreadCount: (
    input: GetProjectionChannelUnreadCountInput,
  ) => Effect.Effect<number, ProjectionRepositoryError>;
}

/**
 * ProjectionChannelMessageRepository - Service tag for channel message persistence.
 */
export class ProjectionChannelMessageRepository extends ServiceMap.Service<
  ProjectionChannelMessageRepository,
  ProjectionChannelMessageRepositoryShape
>()("t3/persistence/Services/ProjectionChannelMessages/ProjectionChannelMessageRepository") {}
