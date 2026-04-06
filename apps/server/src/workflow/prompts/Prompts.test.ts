import * as NodeServices from "@effect/platform-node/NodeServices";
import { PromptTemplate } from "@forgetools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const decodePromptTemplate = Schema.decodeUnknownEffect(PromptTemplate);
const promptsDir = fileURLToPath(new URL(".", import.meta.url));
const expectedPrompts = [
  "advocate.yaml",
  "connector.yaml",
  "critic.yaml",
  "defender.yaml",
  "evaluator.yaml",
  "finalize.yaml",
  "implement.yaml",
  "interrogator.yaml",
  "refiner.yaml",
  "review.yaml",
  "scrutinizer.yaml",
  "synthesize.yaml",
] as const;
const knownVariables = new Set([
  "DEFENDER_FINDINGS",
  "DESCRIPTION",
  "INPUT",
  "ITERATION_CONTEXT",
  "PREVIOUS_OUTPUT",
  "REVIEW_FINDINGS",
  "SCRUTINIZER_FINDINGS",
]);

function extractPlaceholders(text: string): ReadonlyArray<string> {
  return [...text.matchAll(/{{\s*([A-Z_]+)\s*}}/g)].map((match) => match[1] ?? "");
}

it.effect("all built-in prompt templates parse and only reference known placeholders", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const entries = yield* fileSystem.readDirectory(promptsDir, { recursive: false });
    const yamlEntries = entries
      .filter((entry) => entry.endsWith(".yaml"))
      .toSorted((left, right) => left.localeCompare(right));

    assert.deepStrictEqual(yamlEntries, [...expectedPrompts]);

    const prompts = yield* Effect.forEach(yamlEntries, (entry) =>
      Effect.gen(function* () {
        const raw = yield* fileSystem.readFileString(path.join(promptsDir, entry));
        return yield* decodePromptTemplate(parseYaml(raw));
      }),
    );

    assert.deepStrictEqual(
      prompts.map((prompt) => prompt.name),
      [
        "advocate",
        "connector",
        "critic",
        "defender",
        "evaluator",
        "finalize",
        "implement",
        "interrogator",
        "refiner",
        "review",
        "scrutinizer",
        "synthesize",
      ],
    );

    for (const prompt of prompts) {
      const placeholders = [
        ...extractPlaceholders(prompt.system),
        ...extractPlaceholders(prompt.initial ?? ""),
      ];

      assert.ok(
        placeholders.length > 0,
        `${prompt.name} should reference at least one placeholder`,
      );
      assert.ok(
        placeholders.every((placeholder) => knownVariables.has(placeholder)),
        `${prompt.name} should only use known placeholders, got ${placeholders.join(", ")}`,
      );
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
