import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionChannelReadCursorInput,
  ProjectionChannelReadCursor,
  ProjectionChannelReadRepository,
  UpdateProjectionChannelReadCursorInput,
  type ProjectionChannelReadRepositoryShape,
} from "../Services/ProjectionChannelReads.ts";

const makeProjectionChannelReadRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getProjectionChannelReadCursorRow = SqlSchema.findOneOption({
    Request: GetProjectionChannelReadCursorInput,
    Result: ProjectionChannelReadCursor,
    execute: ({ channelId, threadId }) =>
      sql`
        SELECT
          channel_id AS "channelId",
          thread_id AS "threadId",
          last_read_sequence AS "lastReadSequence",
          updated_at AS "updatedAt"
        FROM channel_reads
        WHERE channel_id = ${channelId}
          AND thread_id = ${threadId}
        LIMIT 1
      `,
  });

  const updateProjectionChannelReadCursorRow = SqlSchema.void({
    Request: UpdateProjectionChannelReadCursorInput,
    execute: ({ channelId, threadId, lastReadSequence, updatedAt }) =>
      sql`
        INSERT INTO channel_reads (
          channel_id,
          thread_id,
          last_read_sequence,
          updated_at
        )
        VALUES (
          ${channelId},
          ${threadId},
          ${lastReadSequence},
          ${updatedAt}
        )
        ON CONFLICT (channel_id, thread_id)
        DO UPDATE SET
          last_read_sequence = excluded.last_read_sequence,
          updated_at = excluded.updated_at
      `,
  });

  const getCursor: ProjectionChannelReadRepositoryShape["getCursor"] = (input) =>
    getProjectionChannelReadCursorRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionChannelReadRepository.getCursor:query")),
    );

  const updateCursor: ProjectionChannelReadRepositoryShape["updateCursor"] = (input) =>
    updateProjectionChannelReadCursorRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionChannelReadRepository.updateCursor:query")),
    );

  return {
    getCursor,
    updateCursor,
  } satisfies ProjectionChannelReadRepositoryShape;
});

export const ProjectionChannelReadRepositoryLive = Layer.effect(
  ProjectionChannelReadRepository,
  makeProjectionChannelReadRepository,
);
