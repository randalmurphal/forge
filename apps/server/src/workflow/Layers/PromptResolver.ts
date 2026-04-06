import * as OS from "node:os";
import { PromptTemplate } from "@forgetools/contracts";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { PromptResolver, type PromptResolverShape } from "../Services/PromptResolver.ts";
import {
  PromptResolverFileError,
  PromptResolverInvariantError,
  PromptResolverParseError,
  PromptTemplateNotFoundError,
  toPromptResolverDecodeError,
} from "../Errors.ts";

export interface PromptResolverLiveOptions {
  readonly builtinsDir?: string;
  readonly globalPromptsDir?: string;
}

const decodePromptTemplate = Schema.decodeUnknownEffect(PromptTemplate);
const defaultBuiltinsDir = fileURLToPath(new URL("../prompts", import.meta.url));

function substitutePlaceholders(text: string, variables: Readonly<Record<string, string>>): string {
  return text.replaceAll(
    /{{\s*([A-Za-z0-9_]+)\s*}}/g,
    (match, key: string) => variables[key] ?? match,
  );
}

export const makePromptResolver = Effect.fn("makePromptResolver")(function* (
  options?: PromptResolverLiveOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const builtinsDir = options?.builtinsDir ?? defaultBuiltinsDir;
  const globalPromptsDir =
    options?.globalPromptsDir ?? path.join(OS.homedir(), ".forge", "prompts");

  const loadPromptFile = Effect.fn("PromptResolver.loadPromptFile")(function* (filePath: string) {
    const raw = yield* fileSystem.readFileString(filePath).pipe(
      Effect.mapError(
        (cause) =>
          new PromptResolverFileError({
            path: filePath,
            operation: "promptResolver.readFile",
            detail: cause.message,
            cause,
          }),
      ),
    );

    const parsed = yield* Effect.try({
      try: () => parseYaml(raw) as unknown,
      catch: (cause) =>
        new PromptResolverParseError({
          path: filePath,
          detail: cause instanceof Error ? cause.message : "Failed to parse YAML prompt template.",
          cause,
        }),
    });

    const template = yield* decodePromptTemplate(parsed).pipe(
      Effect.mapError(toPromptResolverDecodeError(filePath)),
    );

    const expectedName = path.basename(filePath, ".yaml");
    if (template.name !== expectedName) {
      return yield* new PromptResolverInvariantError({
        path: filePath,
        detail: `Prompt template name '${template.name}' must match filename '${expectedName}'.`,
      });
    }

    return template;
  });

  const resolveCandidatePaths = (name: string, projectRoot?: string): ReadonlyArray<string> => {
    const fileName = `${name}.yaml`;
    const candidates: string[] = [];
    if (projectRoot) {
      candidates.push(path.resolve(projectRoot, ".forge", "prompts", fileName));
    }
    candidates.push(path.resolve(globalPromptsDir, fileName));
    candidates.push(path.resolve(builtinsDir, fileName));
    return candidates;
  };

  const applyVariables: PromptResolverShape["applyVariables"] = (input) =>
    Effect.succeed({
      ...input.template,
      system: substitutePlaceholders(input.template.system, input.variables),
      ...(input.template.initial
        ? { initial: substitutePlaceholders(input.template.initial, input.variables) }
        : {}),
    });

  const resolve: PromptResolverShape["resolve"] = (input) =>
    Effect.gen(function* () {
      const candidatePaths = resolveCandidatePaths(input.name, input.projectRoot);

      for (const candidatePath of candidatePaths) {
        const exists = yield* fileSystem
          .exists(candidatePath)
          .pipe(Effect.orElseSucceed(() => false));
        if (!exists) {
          continue;
        }

        const template = yield* loadPromptFile(candidatePath);
        if (!input.variables) {
          return template;
        }
        return yield* applyVariables({
          template,
          variables: input.variables,
        });
      }

      return yield* new PromptTemplateNotFoundError({
        name: input.name,
        searchedPaths: [...candidatePaths],
      });
    });

  return {
    resolve,
    applyVariables,
  } satisfies PromptResolverShape;
});

export const PromptResolverLive = Layer.effect(PromptResolver, makePromptResolver());
