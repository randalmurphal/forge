/**
 * ProjectionChannelRepository - Projection repository interface for channels.
 *
 * Owns persistence operations for projected channel rows rendered in the
 * orchestration read model.
 *
 * @module ProjectionChannelRepository
 */
import {
  ChannelId,
  ChannelStatus,
  ChannelType,
  IsoDateTime,
  PhaseRunId,
  ThreadId,
} from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionChannel = Schema.Struct({
  channelId: ChannelId,
  threadId: ThreadId,
  phaseRunId: Schema.NullOr(PhaseRunId),
  type: ChannelType,
  status: ChannelStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionChannel = typeof ProjectionChannel.Type;

export const QueryProjectionChannelsByThreadIdInput = Schema.Struct({
  threadId: ThreadId,
});
export type QueryProjectionChannelsByThreadIdInput =
  typeof QueryProjectionChannelsByThreadIdInput.Type;

export const UpdateProjectionChannelStatusInput = Schema.Struct({
  channelId: ChannelId,
  status: ChannelStatus,
  updatedAt: IsoDateTime,
});
export type UpdateProjectionChannelStatusInput = typeof UpdateProjectionChannelStatusInput.Type;

/**
 * ProjectionChannelRepositoryShape - Service API for persisted channel rows.
 */
export interface ProjectionChannelRepositoryShape {
  /**
   * Insert or refresh a channel row.
   *
   * Uses `channelId` as the durable identity for idempotent projector writes.
   */
  readonly create: (row: ProjectionChannel) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * List channel rows for a thread.
   *
   * Returned in ascending creation order.
   */
  readonly queryByThreadId: (
    input: QueryProjectionChannelsByThreadIdInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionChannel>, ProjectionRepositoryError>;

  /**
   * Update a channel status row in place.
   */
  readonly updateStatus: (
    input: UpdateProjectionChannelStatusInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionChannelRepository - Service tag for channel projection persistence.
 */
export class ProjectionChannelRepository extends ServiceMap.Service<
  ProjectionChannelRepository,
  ProjectionChannelRepositoryShape
>()("t3/persistence/Services/ProjectionChannels/ProjectionChannelRepository") {}
