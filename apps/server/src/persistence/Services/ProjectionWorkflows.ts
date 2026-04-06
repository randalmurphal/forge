/**
 * ProjectionWorkflowRepository - Projection repository interface for workflows.
 *
 * Owns persistence operations for workflow definitions materialized into the
 * `workflows` projection table.
 *
 * @module ProjectionWorkflowRepository
 */
import {
  IsoDateTime,
  ProjectId,
  TrimmedNonEmptyString,
  WorkflowCompletionConfig,
  WorkflowId,
  WorkflowPhase,
} from "@forgetools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionWorkflow = Schema.Struct({
  workflowId: WorkflowId,
  name: TrimmedNonEmptyString,
  description: Schema.String,
  phases: Schema.Array(WorkflowPhase),
  builtIn: Schema.Boolean,
  projectId: Schema.NullOr(ProjectId),
  onCompletion: Schema.optional(WorkflowCompletionConfig),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionWorkflow = typeof ProjectionWorkflow.Type;

export const QueryProjectionWorkflowByIdInput = Schema.Struct({
  workflowId: WorkflowId,
});
export type QueryProjectionWorkflowByIdInput = typeof QueryProjectionWorkflowByIdInput.Type;

export const QueryProjectionWorkflowByNameInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
});
export type QueryProjectionWorkflowByNameInput = typeof QueryProjectionWorkflowByNameInput.Type;

export const DeleteProjectionWorkflowInput = Schema.Struct({
  workflowId: WorkflowId,
});
export type DeleteProjectionWorkflowInput = typeof DeleteProjectionWorkflowInput.Type;

/**
 * ProjectionWorkflowRepositoryShape - Service API for persisted workflow rows.
 */
export interface ProjectionWorkflowRepositoryShape {
  /**
   * Insert or replace a workflow row.
   *
   * Upserts by `workflowId`.
   */
  readonly upsert: (row: ProjectionWorkflow) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a workflow row by id.
   */
  readonly queryById: (
    input: QueryProjectionWorkflowByIdInput,
  ) => Effect.Effect<Option.Option<ProjectionWorkflow>, ProjectionRepositoryError>;

  /**
   * Read a workflow row by name.
   *
   * If both a built-in and a user-defined workflow share the same name, the
   * user-defined workflow is returned first.
   */
  readonly queryByName: (
    input: QueryProjectionWorkflowByNameInput,
  ) => Effect.Effect<Option.Option<ProjectionWorkflow>, ProjectionRepositoryError>;

  /**
   * List all workflow rows.
   *
   * Returned in deterministic name order with user-defined workflows before
   * built-ins when names collide.
   */
  readonly queryAll: () => Effect.Effect<
    ReadonlyArray<ProjectionWorkflow>,
    ProjectionRepositoryError
  >;

  /**
   * Delete a workflow row by id.
   */
  readonly delete: (
    input: DeleteProjectionWorkflowInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionWorkflowRepository - Service tag for workflow projection persistence.
 */
export class ProjectionWorkflowRepository extends ServiceMap.Service<
  ProjectionWorkflowRepository,
  ProjectionWorkflowRepositoryShape
>()("forge/persistence/Services/ProjectionWorkflows/ProjectionWorkflowRepository") {}
