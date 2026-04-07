import * as NodeServices from "@effect/platform-node/NodeServices";
import { WorkflowDefinition } from "@forgetools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const decodeWorkflowDefinition = Schema.decodeUnknownEffect(WorkflowDefinition);
const builtinsDir = fileURLToPath(new URL(".", import.meta.url));
const expectedBuiltins = [
  "build-loop.yaml",
  "debate.yaml",
  "explore.yaml",
  "implement.yaml",
  "interrogate.yaml",
] as const;

it.effect("all built-in workflow YAML files parse and validate against WorkflowDefinition", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const entries = yield* fileSystem.readDirectory(builtinsDir, { recursive: false });
    const yamlEntries = entries
      .filter((entry) => entry.endsWith(".yaml"))
      .toSorted((left, right) => left.localeCompare(right));

    assert.deepStrictEqual(yamlEntries, [...expectedBuiltins]);

    const workflows = yield* Effect.forEach(yamlEntries, (entry) =>
      Effect.gen(function* () {
        const raw = yield* fileSystem.readFileString(path.join(builtinsDir, entry));
        return yield* decodeWorkflowDefinition(parseYaml(raw));
      }),
    );

    assert.deepStrictEqual(
      workflows.map((workflow) => workflow.name),
      ["build-loop", "debate", "explore", "implement", "interrogate"],
    );
    assert.ok(workflows.every((workflow) => workflow.builtIn));
    assert.ok(
      workflows.every(
        (workflow) =>
          new Set(workflow.phases.map((phase) => phase.name)).size === workflow.phases.length,
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
