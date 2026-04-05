import { Effect, Layer, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  GetProjectionChannelUnreadCountInput,
  ProjectionChannelMessage,
  ProjectionChannelMessageRepository,
  QueryProjectionChannelMessagesByChannelIdInput,
  type ProjectionChannelMessageRepositoryShape,
} from "../Services/ProjectionChannelMessages.ts";

const ProjectionChannelMessageDbRow = ProjectionChannelMessage.mapFields(
  Struct.assign({
    metadata: Schema.NullOr(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))),
  }),
);

const ProjectionChannelUnreadCountRow = Schema.Struct({
  unreadCount: Schema.Number,
});

const makeProjectionChannelMessageRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertProjectionChannelMessageRow = SqlSchema.void({
    Request: ProjectionChannelMessage,
    execute: (row) =>
      sql`
        INSERT INTO channel_messages (
          message_id,
          channel_id,
          sequence,
          from_type,
          from_id,
          from_role,
          content,
          metadata_json,
          created_at,
          deleted_at
        )
        VALUES (
          ${row.messageId},
          ${row.channelId},
          ${row.sequence},
          ${row.fromType},
          ${row.fromId},
          ${row.fromRole},
          ${row.content},
          ${row.metadata === null ? null : JSON.stringify(row.metadata)},
          ${row.createdAt},
          ${row.deletedAt}
        )
        ON CONFLICT (message_id)
        DO UPDATE SET
          channel_id = excluded.channel_id,
          sequence = excluded.sequence,
          from_type = excluded.from_type,
          from_id = excluded.from_id,
          from_role = excluded.from_role,
          content = excluded.content,
          metadata_json = excluded.metadata_json,
          created_at = excluded.created_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const queryProjectionChannelMessageRowsByChannelId = SqlSchema.findAll({
    Request: QueryProjectionChannelMessagesByChannelIdInput,
    Result: ProjectionChannelMessageDbRow,
    execute: ({ channelId, cursor, limit }) =>
      sql`
        SELECT
          message_id AS "messageId",
          channel_id AS "channelId",
          sequence,
          from_type AS "fromType",
          from_id AS "fromId",
          from_role AS "fromRole",
          content,
          metadata_json AS "metadata",
          created_at AS "createdAt",
          deleted_at AS "deletedAt"
        FROM channel_messages
        WHERE channel_id = ${channelId}
          AND (${cursor ?? null} IS NULL OR sequence > ${cursor ?? null})
        ORDER BY sequence ASC, message_id ASC
        LIMIT ${limit}
      `,
  });

  const getProjectionChannelUnreadCountRow = SqlSchema.findOne({
    Request: GetProjectionChannelUnreadCountInput,
    Result: ProjectionChannelUnreadCountRow,
    execute: ({ channelId, threadId }) =>
      sql`
        SELECT
          COUNT(*) AS "unreadCount"
        FROM channel_messages
        WHERE channel_id = ${channelId}
          AND deleted_at IS NULL
          AND sequence > COALESCE(
            (
              SELECT last_read_sequence
              FROM channel_reads
              WHERE channel_id = ${channelId}
                AND thread_id = ${threadId}
              LIMIT 1
            ),
            -1
          )
      `,
  });

  const insert: ProjectionChannelMessageRepositoryShape["insert"] = (row) =>
    insertProjectionChannelMessageRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionChannelMessageRepository.insert:query")),
    );

  const queryByChannelId: ProjectionChannelMessageRepositoryShape["queryByChannelId"] = (input) =>
    queryProjectionChannelMessageRowsByChannelId(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionChannelMessageRepository.queryByChannelId:query",
          "ProjectionChannelMessageRepository.queryByChannelId:decodeRows",
        ),
      ),
    );

  const getUnreadCount: ProjectionChannelMessageRepositoryShape["getUnreadCount"] = (input) =>
    getProjectionChannelUnreadCountRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionChannelMessageRepository.getUnreadCount:query"),
      ),
      Effect.map((row) => row.unreadCount),
    );

  return {
    insert,
    queryByChannelId,
    getUnreadCount,
  } satisfies ProjectionChannelMessageRepositoryShape;
});

export const ProjectionChannelMessageRepositoryLive = Layer.effect(
  ProjectionChannelMessageRepository,
  makeProjectionChannelMessageRepository,
);
