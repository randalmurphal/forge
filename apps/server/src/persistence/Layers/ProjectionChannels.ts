import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionChannel,
  ProjectionChannelRepository,
  QueryProjectionChannelsByThreadIdInput,
  UpdateProjectionChannelStatusInput,
  type ProjectionChannelRepositoryShape,
} from "../Services/ProjectionChannels.ts";

const makeProjectionChannelRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const createProjectionChannelRow = SqlSchema.void({
    Request: ProjectionChannel,
    execute: (row) =>
      sql`
        INSERT INTO channels (
          channel_id,
          thread_id,
          phase_run_id,
          type,
          status,
          created_at,
          updated_at
        )
        VALUES (
          ${row.channelId},
          ${row.threadId},
          ${row.phaseRunId},
          ${row.type},
          ${row.status},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (channel_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          phase_run_id = excluded.phase_run_id,
          type = excluded.type,
          status = excluded.status,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `,
  });

  const queryProjectionChannelRowsByThreadId = SqlSchema.findAll({
    Request: QueryProjectionChannelsByThreadIdInput,
    Result: ProjectionChannel,
    execute: ({ threadId }) =>
      sql`
        SELECT
          channel_id AS "channelId",
          thread_id AS "threadId",
          phase_run_id AS "phaseRunId",
          type,
          status,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM channels
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, channel_id ASC
      `,
  });

  const updateProjectionChannelStatusRow = SqlSchema.void({
    Request: UpdateProjectionChannelStatusInput,
    execute: ({ channelId, status, updatedAt }) =>
      sql`
        UPDATE channels
        SET
          status = ${status},
          updated_at = ${updatedAt}
        WHERE channel_id = ${channelId}
      `,
  });

  const create: ProjectionChannelRepositoryShape["create"] = (row) =>
    createProjectionChannelRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionChannelRepository.create:query")),
    );

  const queryByThreadId: ProjectionChannelRepositoryShape["queryByThreadId"] = (input) =>
    queryProjectionChannelRowsByThreadId(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionChannelRepository.queryByThreadId:query")),
    );

  const updateStatus: ProjectionChannelRepositoryShape["updateStatus"] = (input) =>
    updateProjectionChannelStatusRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionChannelRepository.updateStatus:query")),
    );

  return {
    create,
    queryByThreadId,
    updateStatus,
  } satisfies ProjectionChannelRepositoryShape;
});

export const ProjectionChannelRepositoryLive = Layer.effect(
  ProjectionChannelRepository,
  makeProjectionChannelRepository,
);
