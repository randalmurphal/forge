import {
  DeliberationState,
  ModelSelection,
  ThreadId,
  WorkflowDefinition,
} from "@forgetools/contracts";
import { Effect, Layer, Option, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  DeleteProjectionThreadInput,
  GetChildThreadIdsInput,
  GetProjectionThreadInput,
  ListProjectionThreadsByProjectInput,
  ProjectionThread,
  ProjectionThreadRepository,
  type ProjectionThreadRepositoryShape,
} from "../Services/ProjectionThreads.ts";

const ProjectionThreadDbRow = ProjectionThread.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
    spawnMode: Schema.NullOr(Schema.Literals(["local", "worktree"])),
    spawnBranch: Schema.NullOr(Schema.String),
    spawnWorktreePath: Schema.NullOr(Schema.String),
    workflowSnapshot: Schema.NullOr(Schema.fromJsonString(WorkflowDefinition)),
    deliberationState: Schema.NullOr(Schema.fromJsonString(DeliberationState)),
    transcriptArchived: Schema.Number,
  }),
);
type ProjectionThreadDbRow = typeof ProjectionThreadDbRow.Type;

function toProjectionThread(row: ProjectionThreadDbRow): ProjectionThread {
  return {
    threadId: row.threadId,
    projectId: row.projectId,
    title: row.title,
    modelSelection: row.modelSelection,
    runtimeMode: row.runtimeMode,
    interactionMode: row.interactionMode,
    branch: row.branch,
    worktreePath: row.worktreePath,
    ...(row.spawnMode !== null ? { spawnMode: row.spawnMode } : {}),
    ...(row.spawnBranch !== null ? { spawnBranch: row.spawnBranch } : {}),
    ...(row.spawnWorktreePath !== null ? { spawnWorktreePath: row.spawnWorktreePath } : {}),
    latestTurnId: row.latestTurnId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    deletedAt: row.deletedAt,
    parentThreadId: row.parentThreadId,
    phaseRunId: row.phaseRunId,
    workflowId: row.workflowId,
    workflowSnapshot: row.workflowSnapshot,
    currentPhaseId: row.currentPhaseId,
    discussionId: row.discussionId,
    role: row.role,
    deliberationState: row.deliberationState,
    bootstrapStatus: row.bootstrapStatus,
    completedAt: row.completedAt,
    transcriptArchived: row.transcriptArchived === 1,
  };
}

const makeProjectionThreadRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadRow = SqlSchema.void({
    Request: ProjectionThread,
    execute: (row) =>
      sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          spawn_mode,
          spawn_branch,
          spawn_worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at,
          parent_thread_id,
          phase_run_id,
          workflow_id,
          workflow_snapshot_json,
          current_phase_id,
          discussion_id,
          role,
          deliberation_state_json,
          bootstrap_status,
          completed_at,
          transcript_archived
        )
        VALUES (
          ${row.threadId},
          ${row.projectId},
          ${row.title},
          ${JSON.stringify(row.modelSelection)},
          ${row.runtimeMode},
          ${row.interactionMode},
          ${row.branch},
          ${row.worktreePath},
          ${row.spawnMode ?? null},
          ${row.spawnBranch ?? null},
          ${row.spawnWorktreePath ?? null},
          ${row.latestTurnId},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.archivedAt},
          ${row.deletedAt},
          ${row.parentThreadId},
          ${row.phaseRunId},
          ${row.workflowId},
          ${row.workflowSnapshot === null ? null : JSON.stringify(row.workflowSnapshot)},
          ${row.currentPhaseId},
          ${row.discussionId},
          ${row.role},
          ${row.deliberationState === null ? null : JSON.stringify(row.deliberationState)},
          ${row.bootstrapStatus},
          ${row.completedAt},
          ${row.transcriptArchived ? 1 : 0}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          title = excluded.title,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          branch = excluded.branch,
          worktree_path = excluded.worktree_path,
          spawn_mode = excluded.spawn_mode,
          spawn_branch = excluded.spawn_branch,
          spawn_worktree_path = excluded.spawn_worktree_path,
          latest_turn_id = excluded.latest_turn_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          archived_at = excluded.archived_at,
          deleted_at = excluded.deleted_at,
          parent_thread_id = excluded.parent_thread_id,
          phase_run_id = excluded.phase_run_id,
          workflow_id = excluded.workflow_id,
          workflow_snapshot_json = excluded.workflow_snapshot_json,
          current_phase_id = excluded.current_phase_id,
          discussion_id = excluded.discussion_id,
          role = excluded.role,
          deliberation_state_json = excluded.deliberation_state_json,
          bootstrap_status = excluded.bootstrap_status,
          completed_at = excluded.completed_at,
          transcript_archived = excluded.transcript_archived
      `,
  });

  const getProjectionThreadRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadInput,
    Result: ProjectionThreadDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          spawn_mode AS "spawnMode",
          spawn_branch AS "spawnBranch",
          spawn_worktree_path AS "spawnWorktreePath",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt",
          parent_thread_id AS "parentThreadId",
          phase_run_id AS "phaseRunId",
          workflow_id AS "workflowId",
          workflow_snapshot_json AS "workflowSnapshot",
          current_phase_id AS "currentPhaseId",
          discussion_id AS "discussionId",
          role,
          deliberation_state_json AS "deliberationState",
          bootstrap_status AS "bootstrapStatus",
          completed_at AS "completedAt",
          transcript_archived AS "transcriptArchived"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const listProjectionThreadRows = SqlSchema.findAll({
    Request: ListProjectionThreadsByProjectInput,
    Result: ProjectionThreadDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          spawn_mode AS "spawnMode",
          spawn_branch AS "spawnBranch",
          spawn_worktree_path AS "spawnWorktreePath",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt",
          parent_thread_id AS "parentThreadId",
          phase_run_id AS "phaseRunId",
          workflow_id AS "workflowId",
          workflow_snapshot_json AS "workflowSnapshot",
          current_phase_id AS "currentPhaseId",
          discussion_id AS "discussionId",
          role,
          deliberation_state_json AS "deliberationState",
          bootstrap_status AS "bootstrapStatus",
          completed_at AS "completedAt",
          transcript_archived AS "transcriptArchived"
        FROM projection_threads
        WHERE project_id = ${projectId}
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const deleteProjectionThreadRow = SqlSchema.void({
    Request: DeleteProjectionThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const getChildThreadIdRows = SqlSchema.findAll({
    Request: GetChildThreadIdsInput,
    Result: Schema.Struct({ threadId: ThreadId }),
    execute: ({ parentThreadId }) =>
      sql`
        SELECT thread_id AS "threadId"
        FROM projection_threads
        WHERE parent_thread_id = ${parentThreadId}
      `,
  });

  const upsert: ProjectionThreadRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.upsert:query")),
    );

  const getById: ProjectionThreadRepositoryShape["getById"] = (input) =>
    getProjectionThreadRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadRepository.getById:query",
          "ProjectionThreadRepository.getById:decodeRow",
        ),
      ),
      Effect.map(Option.map(toProjectionThread)),
    );

  const listByProjectId: ProjectionThreadRepositoryShape["listByProjectId"] = (input) =>
    listProjectionThreadRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadRepository.listByProjectId:query",
          "ProjectionThreadRepository.listByProjectId:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map(toProjectionThread)),
    );

  const deleteById: ProjectionThreadRepositoryShape["deleteById"] = (input) =>
    deleteProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.deleteById:query")),
    );

  const getChildThreadIds: ProjectionThreadRepositoryShape["getChildThreadIds"] = (input) =>
    getChildThreadIdRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadRepository.getChildThreadIds:query",
          "ProjectionThreadRepository.getChildThreadIds:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.threadId)),
    );

  return {
    upsert,
    getById,
    listByProjectId,
    deleteById,
    getChildThreadIds,
  } satisfies ProjectionThreadRepositoryShape;
});

export const ProjectionThreadRepositoryLive = Layer.effect(
  ProjectionThreadRepository,
  makeProjectionThreadRepository,
);
