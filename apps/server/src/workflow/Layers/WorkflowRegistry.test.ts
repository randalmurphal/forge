import * as NodeServices from "@effect/platform-node/NodeServices";
import { WorkflowId, WorkflowPhaseId } from "@forgetools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";

import { ProjectionWorkflowRepository } from "../../persistence/Services/ProjectionWorkflows.ts";
import { ProjectionWorkflowRepositoryLive } from "../../persistence/Layers/ProjectionWorkflows.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorkflowRegistry } from "../Services/WorkflowRegistry.ts";
import { makeWorkflowRegistryLive } from "./WorkflowRegistry.ts";

const ProjectionLayer = ProjectionWorkflowRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

const makeWorkflowRegistryTestLayer = (builtinsDir: string) =>
  makeWorkflowRegistryLive({ builtinsDir }).pipe(
    Layer.provideMerge(ProjectionLayer),
    Layer.provideMerge(NodeServices.layer),
  );

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "forge-workflows-" });
});

const writeFile = Effect.fn("WorkflowRegistryTest.writeFile")(function* (
  directory: string,
  fileName: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(Effect.orDie);
  yield* fileSystem.writeFileString(path.join(directory, fileName), contents).pipe(Effect.orDie);
});

const builtInWorkflowYaml = `
id: workflow-built-in-implement
name: implement
description: Built-in workflow
builtIn: true
onCompletion:
  autoCommit: true
  createPr: true
createdAt: "2026-04-05T10:00:00.000Z"
updatedAt: "2026-04-05T10:05:00.000Z"
phases:
  - id: phase-built-in-plan
    name: plan
    type: single-agent
    agent:
      prompt: implement
      output:
        type: conversation
    gate:
      after: auto-continue
      onFail: stop
      maxRetries: 3
`;

it.effect("loads built-in workflow YAML files and materializes them into the workflows table", () =>
  Effect.gen(function* () {
    const builtinsDir = yield* makeTempDir;
    yield* writeFile(builtinsDir, "implement.yaml", builtInWorkflowYaml);

    const stored = yield* Effect.gen(function* () {
      yield* WorkflowRegistry;
      const repository = yield* ProjectionWorkflowRepository;
      return yield* repository.queryById({
        workflowId: WorkflowId.makeUnsafe("workflow-built-in-implement"),
      });
    }).pipe(Effect.provide(makeWorkflowRegistryTestLayer(builtinsDir)));

    assert.deepStrictEqual(Option.getOrNull(stored), {
      workflowId: WorkflowId.makeUnsafe("workflow-built-in-implement"),
      name: "implement",
      description: "Built-in workflow",
      phases: [
        {
          id: WorkflowPhaseId.makeUnsafe("phase-built-in-plan"),
          name: "plan",
          type: "single-agent",
          agent: {
            prompt: "implement",
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
        createPr: true,
      },
      createdAt: "2026-04-05T10:00:00.000Z",
      updatedAt: "2026-04-05T10:05:00.000Z",
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("resolves workflows by name with user-defined precedence over built-ins", () =>
  Effect.gen(function* () {
    const builtinsDir = yield* makeTempDir;
    yield* writeFile(builtinsDir, "implement.yaml", builtInWorkflowYaml);

    const resolved = yield* Effect.gen(function* () {
      const repository = yield* ProjectionWorkflowRepository;
      const registry = yield* WorkflowRegistry;

      yield* repository.upsert({
        workflowId: WorkflowId.makeUnsafe("workflow-user-implement"),
        name: "implement",
        description: "User override",
        phases: [
          {
            id: WorkflowPhaseId.makeUnsafe("phase-user-review"),
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
        onCompletion: {
          autoPush: true,
        },
        createdAt: "2026-04-05T11:00:00.000Z",
        updatedAt: "2026-04-05T11:05:00.000Z",
      });

      return yield* registry.queryByName({ name: "implement" });
    }).pipe(Effect.provide(makeWorkflowRegistryTestLayer(builtinsDir)));

    assert.deepStrictEqual(Option.getOrNull(resolved)?.id, "workflow-user-implement");
    assert.strictEqual(Option.getOrNull(resolved)?.builtIn, false);
    assert.deepStrictEqual(Option.getOrNull(resolved)?.onCompletion, {
      autoPush: true,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("returns none when a workflow is missing", () =>
  Effect.gen(function* () {
    const builtinsDir = yield* makeTempDir;
    const [byName, byId] = yield* Effect.gen(function* () {
      const registry = yield* WorkflowRegistry;
      return yield* Effect.all([
        registry.queryByName({ name: "missing-workflow" }),
        registry.queryById({
          workflowId: WorkflowId.makeUnsafe("workflow-missing"),
        }),
      ]);
    }).pipe(Effect.provide(makeWorkflowRegistryTestLayer(builtinsDir)));

    assert.deepStrictEqual(Option.getOrNull(byName), null);
    assert.deepStrictEqual(Option.getOrNull(byId), null);
  }).pipe(Effect.provide(NodeServices.layer)),
);
