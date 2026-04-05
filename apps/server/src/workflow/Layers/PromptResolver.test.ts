import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { PromptTemplateNotFoundError } from "../Errors.ts";
import { PromptResolver } from "../Services/PromptResolver.ts";
import { makePromptResolver, type PromptResolverLiveOptions } from "./PromptResolver.ts";

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "forge-prompts-" });
});

const writePromptFile = Effect.fn("PromptResolverTest.writePromptFile")(function* (
  directory: string,
  fileName: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(Effect.orDie);
  yield* fileSystem.writeFileString(path.join(directory, fileName), contents).pipe(Effect.orDie);
});

const builtInPromptYaml = `
name: implement
description: Built-in prompt
system: |
  Built-in {{DESCRIPTION}}
`;

const globalPromptYaml = `
name: implement
description: Global prompt
system: |
  Global {{DESCRIPTION}}
`;

const projectPromptYaml = `
name: implement
description: Project prompt
system: |
  Project {{DESCRIPTION}}
`;

const promptWithVariablesYaml = `
name: synthesize
description: Synthesize input
system: |
  Description: {{DESCRIPTION}}
  Input: {{INPUT}}
  Previous: {{PREVIOUS_OUTPUT}}
  Retry: {{ITERATION_CONTEXT}}
  Unknown: {{UNKNOWN_VAR}}
initial: "Start with {{INPUT}}"
`;

const makePromptResolverTestLayer = (options: PromptResolverLiveOptions) =>
  Layer.effect(PromptResolver, makePromptResolver(options)).pipe(Layer.provide(NodeServices.layer));

it.effect("resolves prompt templates with project then global then built-in precedence", () =>
  Effect.gen(function* () {
    const builtinsDir = yield* makeTempDir;
    const globalPromptsDir = yield* makeTempDir;
    const projectRoot = yield* makeTempDir;

    yield* writePromptFile(builtinsDir, "implement.yaml", builtInPromptYaml);
    yield* writePromptFile(globalPromptsDir, "implement.yaml", globalPromptYaml);
    yield* writePromptFile(`${projectRoot}/.forge/prompts`, "implement.yaml", projectPromptYaml);

    const resolved = yield* Effect.gen(function* () {
      const resolver = yield* PromptResolver;
      return yield* resolver.resolve({
        name: "implement",
        projectRoot,
      });
    }).pipe(
      Effect.provide(
        makePromptResolverTestLayer({
          builtinsDir,
          globalPromptsDir,
        }),
      ),
    );

    assert.strictEqual(resolved.description, "Project prompt");
    assert.strictEqual(resolved.system.trim(), "Project {{DESCRIPTION}}");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "falls back to global then built-in prompts when higher-precedence sources are absent",
  () =>
    Effect.gen(function* () {
      const builtinsDir = yield* makeTempDir;
      const globalPromptsDir = yield* makeTempDir;
      const projectRoot = yield* makeTempDir;

      yield* writePromptFile(builtinsDir, "implement.yaml", builtInPromptYaml);
      yield* writePromptFile(globalPromptsDir, "implement.yaml", globalPromptYaml);

      const [globalResolved, builtInResolved] = yield* Effect.gen(function* () {
        const resolver = yield* PromptResolver;
        return yield* Effect.all([
          resolver.resolve({
            name: "implement",
            projectRoot,
          }),
          resolver.resolve({
            name: "implement",
          }),
        ]);
      }).pipe(
        Effect.provide(
          makePromptResolverTestLayer({
            builtinsDir,
            globalPromptsDir,
          }),
        ),
      );

      assert.strictEqual(globalResolved.description, "Global prompt");
      assert.strictEqual(builtInResolved.description, "Global prompt");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("applies variable substitution and leaves missing variables as-is", () =>
  Effect.gen(function* () {
    const builtinsDir = yield* makeTempDir;
    yield* writePromptFile(builtinsDir, "synthesize.yaml", promptWithVariablesYaml);

    const resolved = yield* Effect.gen(function* () {
      const resolver = yield* PromptResolver;
      return yield* resolver.resolve({
        name: "synthesize",
        variables: {
          DESCRIPTION: "Summarize the debate",
          INPUT: "Channel transcript",
          PREVIOUS_OUTPUT: "Earlier summary",
          ITERATION_CONTEXT: "Retry because the first summary missed risks",
        },
      });
    }).pipe(
      Effect.provide(
        makePromptResolverTestLayer({
          builtinsDir,
          globalPromptsDir: `${builtinsDir}/missing-global`,
        }),
      ),
    );

    assert.strictEqual(
      resolved.system,
      [
        "Description: Summarize the debate",
        "Input: Channel transcript",
        "Previous: Earlier summary",
        "Retry: Retry because the first summary missed risks",
        "Unknown: {{UNKNOWN_VAR}}",
        "",
      ].join("\n"),
    );
    assert.strictEqual(resolved.initial, "Start with Channel transcript");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("fails with PromptTemplateNotFoundError when the prompt template is missing", () =>
  Effect.gen(function* () {
    const builtinsDir = yield* makeTempDir;
    const globalPromptsDir = yield* makeTempDir;
    const projectRoot = yield* makeTempDir;

    const result = yield* Effect.gen(function* () {
      const resolver = yield* PromptResolver;
      return yield* Effect.flip(
        resolver.resolve({
          name: "missing-prompt",
          projectRoot,
        }),
      );
    }).pipe(
      Effect.provide(
        makePromptResolverTestLayer({
          builtinsDir,
          globalPromptsDir,
        }),
      ),
    );

    assert.strictEqual(result._tag, "PromptTemplateNotFoundError");
    assert.deepStrictEqual((result as PromptTemplateNotFoundError).searchedPaths, [
      `${projectRoot}/.forge/prompts/missing-prompt.yaml`,
      `${globalPromptsDir}/missing-prompt.yaml`,
      `${builtinsDir}/missing-prompt.yaml`,
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);
