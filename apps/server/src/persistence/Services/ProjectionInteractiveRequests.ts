/**
 * ProjectionInteractiveRequestRepository - Projection repository interface for interactive requests.
 *
 * Owns persistence operations for materialized workflow, gate, approval, and
 * bootstrap requests in the orchestration read model.
 *
 * @module ProjectionInteractiveRequestRepository
 */
import {
  InteractiveRequestId,
  InteractiveRequestPayload,
  InteractiveRequestResolution,
  InteractiveRequestStatus,
  InteractiveRequestType,
  IsoDateTime,
  PhaseRunId,
  ThreadId,
} from "@forgetools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionInteractiveRequest = Schema.Struct({
  requestId: InteractiveRequestId,
  threadId: ThreadId,
  childThreadId: Schema.NullOr(ThreadId),
  phaseRunId: Schema.NullOr(PhaseRunId),
  type: InteractiveRequestType,
  status: InteractiveRequestStatus,
  payload: InteractiveRequestPayload,
  resolvedWith: Schema.NullOr(InteractiveRequestResolution),
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
  staleReason: Schema.NullOr(Schema.String),
});
export type ProjectionInteractiveRequest = typeof ProjectionInteractiveRequest.Type;

export const QueryProjectionInteractiveRequestsByThreadIdInput = Schema.Struct({
  threadId: ThreadId,
});
export type QueryProjectionInteractiveRequestsByThreadIdInput =
  typeof QueryProjectionInteractiveRequestsByThreadIdInput.Type;

export const QueryProjectionInteractiveRequestByIdInput = Schema.Struct({
  requestId: InteractiveRequestId,
});
export type QueryProjectionInteractiveRequestByIdInput =
  typeof QueryProjectionInteractiveRequestByIdInput.Type;

export const UpdateProjectionInteractiveRequestStatusInput = Schema.Struct({
  requestId: InteractiveRequestId,
  status: InteractiveRequestStatus,
  resolvedWith: Schema.optional(Schema.NullOr(InteractiveRequestResolution)),
  resolvedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
});
export type UpdateProjectionInteractiveRequestStatusInput =
  typeof UpdateProjectionInteractiveRequestStatusInput.Type;

export const MarkProjectionInteractiveRequestStaleInput = Schema.Struct({
  requestId: InteractiveRequestId,
  staleReason: Schema.String,
});
export type MarkProjectionInteractiveRequestStaleInput =
  typeof MarkProjectionInteractiveRequestStaleInput.Type;

export interface ProjectionInteractiveRequestRepositoryShape {
  /**
   * Insert or replace an interactive-request row.
   *
   * Upserts by `requestId`.
   */
  readonly upsert: (
    row: ProjectionInteractiveRequest,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * List interactive requests for a thread.
   *
   * Returned in ascending creation order.
   */
  readonly queryByThreadId: (
    input: QueryProjectionInteractiveRequestsByThreadIdInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionInteractiveRequest>, ProjectionRepositoryError>;

  /**
   * Read a single interactive request by id.
   */
  readonly queryById: (
    input: QueryProjectionInteractiveRequestByIdInput,
  ) => Effect.Effect<Option.Option<ProjectionInteractiveRequest>, ProjectionRepositoryError>;

  /**
   * List all pending interactive requests across threads.
   *
   * Returned in ascending creation order.
   */
  readonly queryPending: () => Effect.Effect<
    ReadonlyArray<ProjectionInteractiveRequest>,
    ProjectionRepositoryError
  >;

  /**
   * Update an interactive request's status and resolved materialized fields.
   *
   * Omitted optional fields preserve the existing persisted value.
   */
  readonly updateStatus: (
    input: UpdateProjectionInteractiveRequestStatusInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Mark an interactive request as stale with a persisted reason.
   */
  readonly markStale: (
    input: MarkProjectionInteractiveRequestStaleInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionInteractiveRequestRepository extends ServiceMap.Service<
  ProjectionInteractiveRequestRepository,
  ProjectionInteractiveRequestRepositoryShape
>()(
  "forge/persistence/Services/ProjectionInteractiveRequests/ProjectionInteractiveRequestRepository",
) {}
