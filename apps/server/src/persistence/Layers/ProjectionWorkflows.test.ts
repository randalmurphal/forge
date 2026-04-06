import { ProjectId, WorkflowId, WorkflowPhaseId } from "@forgetools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError } from "../Errors.ts";
import { ProjectionWorkflowRepository } from "../Services/ProjectionWorkflows.ts";
import { ProjectionWorkflowRepositoryLive } from "./ProjectionWorkflows.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionWorkflowRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionWorkflowRepository", (it) => {
  it.effect("stores and queries workflows by id and name with user-defined precedence", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionWorkflowRepository;
      const createdAt = "2026-04-05T10:00:00.000Z";
      const updatedAt = "2026-04-05T10:05:00.000Z";

      yield* repository.upsert({
        workflowId: WorkflowId.makeUnsafe("workflow-built-in-implement"),
        name: "implement",
        description: "Built-in implement workflow",
        phases: [
          {
            id: WorkflowPhaseId.makeUnsafe("phase-built-in-plan"),
            name: "plan",
            type: "single-agent",
            agent: {
              prompt: "Plan the implementation",
              output: { type: "conversation" },
            },
            gate: {
              after: "auto-continue",
              onFail: "stop",
              maxRetries: 3,
            },
          },
        ],
        builtIn: true,
        projectId: null,
        onCompletion: {
          autoCommit: true,
          autoPush: true,
        },
        createdAt,
        updatedAt,
      });

      yield* repository.upsert({
        workflowId: WorkflowId.makeUnsafe("workflow-user-implement"),
        name: "implement",
        description: "User override workflow",
        phases: [
          {
            id: WorkflowPhaseId.makeUnsafe("phase-user-review"),
            name: "review",
            type: "single-agent",
            agent: {
              prompt: "Review the result",
              output: { type: "schema", schema: { summary: "string" } },
            },
            gate: {
              after: "done",
              onFail: "retry",
              maxRetries: 1,
            },
          },
        ],
        builtIn: false,
        projectId: null,
        onCompletion: {
          createPr: true,
        },
        createdAt: "2026-04-05T11:00:00.000Z",
        updatedAt: "2026-04-05T11:05:00.000Z",
      });

      const byId = yield* repository.queryById({
        workflowId: WorkflowId.makeUnsafe("workflow-built-in-implement"),
      });
      assert.deepStrictEqual(Option.getOrNull(byId), {
        workflowId: WorkflowId.makeUnsafe("workflow-built-in-implement"),
        name: "implement",
        description: "Built-in implement workflow",
        phases: [
          {
            id: WorkflowPhaseId.makeUnsafe("phase-built-in-plan"),
            name: "plan",
            type: "single-agent",
            agent: {
              prompt: "Plan the implementation",
              output: { type: "conversation" },
            },
            gate: {
              after: "auto-continue",
              onFail: "stop",
              maxRetries: 3,
            },
          },
        ],
        builtIn: true,
        projectId: null,
        onCompletion: {
          autoCommit: true,
          autoPush: true,
        },
        createdAt,
        updatedAt,
      });

      const byName = yield* repository.queryByName({ name: "implement" });
      const workflowByName = Option.getOrNull(byName);
      assert.deepStrictEqual(
        workflowByName?.workflowId,
        WorkflowId.makeUnsafe("workflow-user-implement"),
      );
      assert.strictEqual(workflowByName?.builtIn, false);
      assert.deepStrictEqual(workflowByName?.onCompletion, {
        createPr: true,
      });
    }),
  );

  it.effect("lists workflows deterministically and deletes by id", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionWorkflowRepository;

      yield* repository.upsert({
        workflowId: WorkflowId.makeUnsafe("workflow-alpha"),
        name: "alpha",
        description: "",
        phases: [
          {
            id: WorkflowPhaseId.makeUnsafe("phase-alpha"),
            name: "alpha-phase",
            type: "human",
            gate: {
              after: "done",
              onFail: "stop",
              maxRetries: 0,
            },
          },
        ],
        builtIn: true,
        projectId: null,
        onCompletion: {
          autoPush: true,
        },
        createdAt: "2026-04-05T09:00:00.000Z",
        updatedAt: "2026-04-05T09:00:00.000Z",
      });

      yield* repository.upsert({
        workflowId: WorkflowId.makeUnsafe("workflow-beta"),
        name: "beta",
        description: "",
        phases: [
          {
            id: WorkflowPhaseId.makeUnsafe("phase-beta"),
            name: "beta-phase",
            type: "automated",
            gate: {
              after: "quality-checks",
              qualityChecks: [{ check: "typecheck", required: true }],
              onFail: "go-back-to",
              retryPhase: "beta-phase",
              maxRetries: 2,
            },
            qualityChecks: [{ check: "typecheck", required: true }],
          },
        ],
        builtIn: false,
        projectId: null,
        onCompletion: {
          createPr: true,
        },
        createdAt: "2026-04-05T09:30:00.000Z",
        updatedAt: "2026-04-05T09:30:00.000Z",
      });

      const beforeDelete = yield* repository.queryAll();
      const relevantBeforeDelete = beforeDelete.filter(
        (workflow) =>
          workflow.workflowId === "workflow-alpha" || workflow.workflowId === "workflow-beta",
      );
      assert.deepStrictEqual(
        relevantBeforeDelete.map((workflow) => workflow.workflowId),
        [WorkflowId.makeUnsafe("workflow-alpha"), WorkflowId.makeUnsafe("workflow-beta")],
      );

      yield* repository.delete({
        workflowId: WorkflowId.makeUnsafe("workflow-alpha"),
      });

      const remaining = yield* repository.queryAll();
      const relevantRemaining = remaining.filter(
        (workflow) => workflow.workflowId === "workflow-beta",
      );
      assert.deepStrictEqual(
        relevantRemaining.map((workflow) => workflow.workflowId),
        [WorkflowId.makeUnsafe("workflow-beta")],
      );
      const deletedWorkflow = yield* repository.queryById({
        workflowId: WorkflowId.makeUnsafe("workflow-alpha"),
      });
      assert.deepStrictEqual(Option.getOrNull(deletedWorkflow), null);
    }),
  );

  it.effect("prefers a matching project-scoped workflow when querying by name", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionWorkflowRepository;
      const projectId = ProjectId.makeUnsafe("project-1");

      yield* repository.upsert({
        workflowId: WorkflowId.makeUnsafe("workflow-built-in-review"),
        name: "review",
        description: "Built-in review",
        phases: [
          {
            id: WorkflowPhaseId.makeUnsafe("phase-built-in-review"),
            name: "review",
            type: "single-agent",
            agent: {
              prompt: "review",
              output: { type: "conversation" },
            },
            gate: {
              after: "done",
              onFail: "stop",
              maxRetries: 0,
            },
          },
        ],
        builtIn: true,
        projectId: null,
        createdAt: "2026-04-05T12:00:00.000Z",
        updatedAt: "2026-04-05T12:00:00.000Z",
      });

      yield* repository.upsert({
        workflowId: WorkflowId.makeUnsafe("workflow-global-review"),
        name: "review",
        description: "Global review",
        phases: [
          {
            id: WorkflowPhaseId.makeUnsafe("phase-global-review"),
            name: "review",
            type: "single-agent",
            agent: {
              prompt: "review",
              output: { type: "conversation" },
            },
            gate: {
              after: "done",
              onFail: "retry",
              maxRetries: 1,
            },
          },
        ],
        builtIn: false,
        projectId: null,
        createdAt: "2026-04-05T12:01:00.000Z",
        updatedAt: "2026-04-05T12:01:00.000Z",
      });

      yield* repository.upsert({
        workflowId: WorkflowId.makeUnsafe("workflow-project-review"),
        name: "review",
        description: "Project review",
        phases: [
          {
            id: WorkflowPhaseId.makeUnsafe("phase-project-review"),
            name: "review",
            type: "single-agent",
            agent: {
              prompt: "review",
              output: { type: "conversation" },
            },
            gate: {
              after: "done",
              onFail: "retry",
              maxRetries: 2,
            },
          },
        ],
        builtIn: false,
        projectId,
        createdAt: "2026-04-05T12:02:00.000Z",
        updatedAt: "2026-04-05T12:02:00.000Z",
      });

      const scoped = yield* repository.queryByName({ name: "review", projectId });
      const unscoped = yield* repository.queryByName({ name: "review" });

      assert.strictEqual(
        Option.getOrNull(scoped)?.workflowId,
        WorkflowId.makeUnsafe("workflow-project-review"),
      );
      assert.strictEqual(
        Option.getOrNull(unscoped)?.workflowId,
        WorkflowId.makeUnsafe("workflow-global-review"),
      );
    }),
  );

  it.effect("fails with PersistenceDecodeError when stored phases json is invalid", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionWorkflowRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        INSERT INTO workflows (
          workflow_id,
          name,
          description,
          phases_json,
          built_in,
          created_at,
          updated_at
        )
        VALUES (
          ${WorkflowId.makeUnsafe("workflow-invalid-json")},
          ${"invalid-json"},
          ${"Broken workflow row"},
          ${"{"},
          ${1},
          ${"2026-04-05T18:00:00.000Z"},
          ${"2026-04-05T18:00:00.000Z"}
        )
      `;

      const result = yield* Effect.result(
        repository.queryById({
          workflowId: WorkflowId.makeUnsafe("workflow-invalid-json"),
        }),
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.ok(Schema.is(PersistenceDecodeError)(result.failure));
        assert.ok(
          result.failure.operation.includes("ProjectionWorkflowRepository.queryById:decodeRow"),
        );
      }
    }),
  );
});
