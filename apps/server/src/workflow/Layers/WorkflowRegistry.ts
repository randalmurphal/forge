import { WorkflowDefinition } from "@forgetools/contracts";
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import {
  ProjectionWorkflowRepository,
  type ProjectionWorkflow,
} from "../../persistence/Services/ProjectionWorkflows.ts";
import { WorkflowRegistry, type WorkflowRegistryShape } from "../Services/WorkflowRegistry.ts";
import {
  WorkflowRegistryFileError,
  WorkflowRegistryInvariantError,
  WorkflowRegistryParseError,
  toWorkflowRegistryDecodeError,
} from "../Errors.ts";

export interface WorkflowRegistryLiveOptions {
  readonly builtinsDir?: string;
}

const decodeWorkflowDefinition = Schema.decodeUnknownEffect(WorkflowDefinition);

function toWorkflowDefinition(row: ProjectionWorkflow): WorkflowDefinition {
  return {
    id: row.workflowId,
    name: row.name,
    description: row.description,
    phases: row.phases,
    builtIn: row.builtIn,
    ...(row.onCompletion ? { onCompletion: row.onCompletion } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function validateWorkflowDefinition(path: string, workflow: WorkflowDefinition) {
  const phaseNames = new Set<string>();
  for (const phase of workflow.phases) {
    if (phaseNames.has(phase.name)) {
      return Effect.fail(
        new WorkflowRegistryInvariantError({
          path,
          detail: `Workflow '${workflow.name}' has duplicate phase name '${phase.name}'.`,
        }),
      );
    }
    phaseNames.add(phase.name);
  }

  if (!workflow.builtIn) {
    return Effect.fail(
      new WorkflowRegistryInvariantError({
        path,
        detail: `Built-in workflow '${workflow.name}' must declare builtIn: true.`,
      }),
    );
  }

  return Effect.void;
}

const defaultBuiltinsDir = fileURLToPath(new URL("../builtins", import.meta.url));

const makeWorkflowRegistry = Effect.fn("makeWorkflowRegistry")(function* (
  options?: WorkflowRegistryLiveOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repository = yield* ProjectionWorkflowRepository;
  const builtinsDir = options?.builtinsDir ?? defaultBuiltinsDir;

  const parseWorkflowFile = Effect.fn("WorkflowRegistry.parseWorkflowFile")(function* (
    filePath: string,
  ) {
    const raw = yield* fileSystem.readFileString(filePath).pipe(
      Effect.mapError(
        (cause) =>
          new WorkflowRegistryFileError({
            path: filePath,
            operation: "workflowRegistry.readFile",
            detail: cause.message,
            cause,
          }),
      ),
    );

    const parsed = yield* Effect.try({
      try: () => parseYaml(raw) as unknown,
      catch: (cause) =>
        new WorkflowRegistryParseError({
          path: filePath,
          detail: cause instanceof Error ? cause.message : "Failed to parse YAML workflow file.",
          cause,
        }),
    });

    const workflow = yield* decodeWorkflowDefinition(parsed).pipe(
      Effect.mapError(toWorkflowRegistryDecodeError(filePath)),
    );
    yield* validateWorkflowDefinition(filePath, workflow);
    return workflow;
  });

  const loadBuiltInWorkflows = Effect.fn("WorkflowRegistry.loadBuiltInWorkflows")(function* () {
    const exists = yield* fileSystem.exists(builtinsDir).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return [] as const;
    }

    const entries = yield* fileSystem.readDirectory(builtinsDir, { recursive: false }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkflowRegistryFileError({
            path: builtinsDir,
            operation: "workflowRegistry.readDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );

    return yield* Effect.forEach(
      [...entries]
        .filter((entry) => entry.endsWith(".yaml") || entry.endsWith(".yml"))
        .toSorted((left, right) => left.localeCompare(right)),
      (entry) => parseWorkflowFile(path.join(builtinsDir, entry)),
    );
  });

  const materializeBuiltInWorkflows = Effect.fn("WorkflowRegistry.materializeBuiltInWorkflows")(
    function* () {
      const workflows = yield* loadBuiltInWorkflows();
      yield* Effect.forEach(
        workflows,
        (workflow) =>
          repository.upsert({
            workflowId: workflow.id,
            name: workflow.name,
            description: workflow.description,
            phases: workflow.phases,
            builtIn: true,
            ...(workflow.onCompletion ? { onCompletion: workflow.onCompletion } : {}),
            createdAt: workflow.createdAt,
            updatedAt: workflow.updatedAt,
          }),
        { discard: true },
      );
    },
  );

  yield* materializeBuiltInWorkflows();

  const queryAll: WorkflowRegistryShape["queryAll"] = () =>
    repository.queryAll().pipe(Effect.map((rows) => rows.map(toWorkflowDefinition)));

  const queryById: WorkflowRegistryShape["queryById"] = (input) =>
    repository
      .queryById({
        workflowId: input.workflowId,
      })
      .pipe(Effect.map(Option.map(toWorkflowDefinition)));

  const queryByName: WorkflowRegistryShape["queryByName"] = (input) =>
    repository
      .queryByName({
        name: input.name,
      })
      .pipe(Effect.map(Option.map(toWorkflowDefinition)));

  return {
    queryAll,
    queryById,
    queryByName,
  } satisfies WorkflowRegistryShape;
});

export const makeWorkflowRegistryLive = (options?: WorkflowRegistryLiveOptions) =>
  Layer.effect(WorkflowRegistry, makeWorkflowRegistry(options));

export const WorkflowRegistryLive = makeWorkflowRegistryLive();
