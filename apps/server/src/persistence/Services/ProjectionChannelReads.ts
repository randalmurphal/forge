/**
 * ProjectionChannelReadRepository - Projection repository interface for channel read cursors.
 *
 * Owns persistence operations for participant read state keyed by channel/thread.
 *
 * @module ProjectionChannelReadRepository
 */
import { ChannelId, IsoDateTime, ThreadId } from "@forgetools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";
import { ChannelSequenceCursor } from "./ProjectionChannelMessages.ts";

export const ProjectionChannelReadCursor = Schema.Struct({
  channelId: ChannelId,
  threadId: ThreadId,
  lastReadSequence: ChannelSequenceCursor,
  updatedAt: IsoDateTime,
});
export type ProjectionChannelReadCursor = typeof ProjectionChannelReadCursor.Type;

export const GetProjectionChannelReadCursorInput = Schema.Struct({
  channelId: ChannelId,
  threadId: ThreadId,
});
export type GetProjectionChannelReadCursorInput = typeof GetProjectionChannelReadCursorInput.Type;

export const UpdateProjectionChannelReadCursorInput = ProjectionChannelReadCursor;
export type UpdateProjectionChannelReadCursorInput =
  typeof UpdateProjectionChannelReadCursorInput.Type;

/**
 * ProjectionChannelReadRepositoryShape - Service API for channel read cursors.
 */
export interface ProjectionChannelReadRepositoryShape {
  /**
   * Read a participant cursor by `(channelId, threadId)`.
   */
  readonly getCursor: (
    input: GetProjectionChannelReadCursorInput,
  ) => Effect.Effect<Option.Option<ProjectionChannelReadCursor>, ProjectionRepositoryError>;

  /**
   * Insert or advance a participant cursor without allowing it to move backward.
   */
  readonly updateCursor: (
    input: UpdateProjectionChannelReadCursorInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionChannelReadRepository - Service tag for channel read persistence.
 */
export class ProjectionChannelReadRepository extends ServiceMap.Service<
  ProjectionChannelReadRepository,
  ProjectionChannelReadRepositoryShape
>()("forge/persistence/Services/ProjectionChannelReads/ProjectionChannelReadRepository") {}
