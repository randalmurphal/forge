import { InteractiveRequestPayload, InteractiveRequestResolution } from "@t3tools/contracts";
import { Effect, Layer, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  MarkProjectionInteractiveRequestStaleInput,
  ProjectionInteractiveRequest,
  ProjectionInteractiveRequestRepository,
  QueryProjectionInteractiveRequestByIdInput,
  QueryProjectionInteractiveRequestsByThreadIdInput,
  UpdateProjectionInteractiveRequestStatusInput,
  type ProjectionInteractiveRequestRepositoryShape,
} from "../Services/ProjectionInteractiveRequests.ts";

const ProjectionInteractiveRequestDbRow = ProjectionInteractiveRequest.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(InteractiveRequestPayload),
    resolvedWith: Schema.NullOr(Schema.fromJsonString(InteractiveRequestResolution)),
  }),
);

const makeProjectionInteractiveRequestRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionInteractiveRequestRow = SqlSchema.void({
    Request: ProjectionInteractiveRequest,
    execute: (row) =>
      sql`
        INSERT INTO interactive_requests (
          request_id,
          thread_id,
          child_thread_id,
          phase_run_id,
          type,
          status,
          payload_json,
          resolved_with_json,
          created_at,
          resolved_at,
          stale_reason
        )
        VALUES (
          ${row.requestId},
          ${row.threadId},
          ${row.childThreadId},
          ${row.phaseRunId},
          ${row.type},
          ${row.status},
          ${JSON.stringify(row.payload)},
          ${row.resolvedWith === null ? null : JSON.stringify(row.resolvedWith)},
          ${row.createdAt},
          ${row.resolvedAt},
          ${row.staleReason}
        )
        ON CONFLICT (request_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          child_thread_id = excluded.child_thread_id,
          phase_run_id = excluded.phase_run_id,
          type = excluded.type,
          status = excluded.status,
          payload_json = excluded.payload_json,
          resolved_with_json = excluded.resolved_with_json,
          created_at = excluded.created_at,
          resolved_at = excluded.resolved_at,
          stale_reason = excluded.stale_reason
      `,
  });

  const queryProjectionInteractiveRequestByIdRow = SqlSchema.findOneOption({
    Request: QueryProjectionInteractiveRequestByIdInput,
    Result: ProjectionInteractiveRequestDbRow,
    execute: ({ requestId }) =>
      sql`
        SELECT
          request_id AS "requestId",
          thread_id AS "threadId",
          child_thread_id AS "childThreadId",
          phase_run_id AS "phaseRunId",
          type,
          status,
          payload_json AS "payload",
          resolved_with_json AS "resolvedWith",
          created_at AS "createdAt",
          resolved_at AS "resolvedAt",
          stale_reason AS "staleReason"
        FROM interactive_requests
        WHERE request_id = ${requestId}
        LIMIT 1
      `,
  });

  const queryProjectionInteractiveRequestRowsByThreadId = SqlSchema.findAll({
    Request: QueryProjectionInteractiveRequestsByThreadIdInput,
    Result: ProjectionInteractiveRequestDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          request_id AS "requestId",
          thread_id AS "threadId",
          child_thread_id AS "childThreadId",
          phase_run_id AS "phaseRunId",
          type,
          status,
          payload_json AS "payload",
          resolved_with_json AS "resolvedWith",
          created_at AS "createdAt",
          resolved_at AS "resolvedAt",
          stale_reason AS "staleReason"
        FROM interactive_requests
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, request_id ASC
      `,
  });

  const queryPendingProjectionInteractiveRequestRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionInteractiveRequestDbRow,
    execute: () =>
      sql`
        SELECT
          request_id AS "requestId",
          thread_id AS "threadId",
          child_thread_id AS "childThreadId",
          phase_run_id AS "phaseRunId",
          type,
          status,
          payload_json AS "payload",
          resolved_with_json AS "resolvedWith",
          created_at AS "createdAt",
          resolved_at AS "resolvedAt",
          stale_reason AS "staleReason"
        FROM interactive_requests
        WHERE status = 'pending'
        ORDER BY created_at ASC, request_id ASC
      `,
  });

  const updateProjectionInteractiveRequestStatusRow = SqlSchema.void({
    Request: UpdateProjectionInteractiveRequestStatusInput,
    execute: (input) => {
      const hasResolvedWith = Object.hasOwn(input, "resolvedWith");
      const hasResolvedAt = Object.hasOwn(input, "resolvedAt");
      const resolvedWithJson = hasResolvedWith
        ? input.resolvedWith === null
          ? null
          : JSON.stringify(input.resolvedWith)
        : null;

      return sql`
        UPDATE interactive_requests
        SET
          status = ${input.status},
          resolved_with_json = CASE
            WHEN ${hasResolvedWith ? 1 : 0} = 1
              THEN ${resolvedWithJson}
            ELSE resolved_with_json
          END,
          resolved_at = CASE
            WHEN ${hasResolvedAt ? 1 : 0} = 1
              THEN ${input.resolvedAt ?? null}
            ELSE resolved_at
          END
        WHERE request_id = ${input.requestId}
      `;
    },
  });

  const markProjectionInteractiveRequestStaleRow = SqlSchema.void({
    Request: MarkProjectionInteractiveRequestStaleInput,
    execute: ({ requestId, staleReason }) =>
      sql`
        UPDATE interactive_requests
        SET
          status = 'stale',
          stale_reason = ${staleReason}
        WHERE request_id = ${requestId}
      `,
  });

  const upsert: ProjectionInteractiveRequestRepositoryShape["upsert"] = (row) =>
    upsertProjectionInteractiveRequestRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionInteractiveRequestRepository.upsert:query")),
    );

  const queryById: ProjectionInteractiveRequestRepositoryShape["queryById"] = (input) =>
    queryProjectionInteractiveRequestByIdRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionInteractiveRequestRepository.queryById:query"),
      ),
    );

  const queryByThreadId: ProjectionInteractiveRequestRepositoryShape["queryByThreadId"] = (input) =>
    queryProjectionInteractiveRequestRowsByThreadId(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionInteractiveRequestRepository.queryByThreadId:query"),
      ),
    );

  const queryPending: ProjectionInteractiveRequestRepositoryShape["queryPending"] = () =>
    queryPendingProjectionInteractiveRequestRows().pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionInteractiveRequestRepository.queryPending:query"),
      ),
    );

  const updateStatus: ProjectionInteractiveRequestRepositoryShape["updateStatus"] = (input) =>
    updateProjectionInteractiveRequestStatusRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionInteractiveRequestRepository.updateStatus:query"),
      ),
    );

  const markStale: ProjectionInteractiveRequestRepositoryShape["markStale"] = (input) =>
    markProjectionInteractiveRequestStaleRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionInteractiveRequestRepository.markStale:query"),
      ),
    );

  return {
    upsert,
    queryById,
    queryByThreadId,
    queryPending,
    updateStatus,
    markStale,
  } satisfies ProjectionInteractiveRequestRepositoryShape;
});

export const ProjectionInteractiveRequestRepositoryLive = Layer.effect(
  ProjectionInteractiveRequestRepository,
  makeProjectionInteractiveRequestRepository,
);
