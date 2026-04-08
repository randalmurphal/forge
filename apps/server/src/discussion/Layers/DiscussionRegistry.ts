import { DiscussionDefinition, type DiscussionScope } from "@forgetools/contracts";
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import * as OS from "node:os";
import { parse as parseYaml } from "yaml";

import {
  DiscussionRegistryFileError,
  DiscussionRegistryInvariantError,
  DiscussionRegistryParseError,
  toDiscussionRegistryDecodeError,
} from "../Errors.ts";
import {
  DiscussionRegistry,
  type DiscussionEntry,
  type DiscussionRegistryShape,
} from "../Services/DiscussionRegistry.ts";

export interface DiscussionRegistryLiveOptions {
  readonly globalDir?: string;
}

const decodeDiscussionDefinition = Schema.decodeUnknownEffect(DiscussionDefinition);

const makeDiscussionRegistry = Effect.fn("makeDiscussionRegistry")(function* (
  options?: DiscussionRegistryLiveOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const globalDir = options?.globalDir ?? path.join(OS.homedir(), ".forge", "discussions");

  const parseDiscussionFile = Effect.fn("DiscussionRegistry.parseDiscussionFile")(function* (
    filePath: string,
  ) {
    const raw = yield* fileSystem.readFileString(filePath).pipe(
      Effect.mapError(
        (cause) =>
          new DiscussionRegistryFileError({
            path: filePath,
            operation: "discussionRegistry.readFile",
            detail: cause.message,
            cause,
          }),
      ),
    );

    const parsed = yield* Effect.try({
      try: () => parseYaml(raw) as unknown,
      catch: (cause) =>
        new DiscussionRegistryParseError({
          path: filePath,
          detail: cause instanceof Error ? cause.message : "Failed to parse YAML discussion file.",
          cause,
        }),
    });

    const discussion = yield* decodeDiscussionDefinition(parsed).pipe(
      Effect.mapError(toDiscussionRegistryDecodeError(filePath)),
    );

    const expectedName = path.basename(filePath, ".yaml");
    if (discussion.name !== expectedName) {
      return yield* new DiscussionRegistryInvariantError({
        path: filePath,
        detail: `Discussion name '${discussion.name}' must match filename '${expectedName}'.`,
      });
    }

    return discussion;
  });

  const loadDiscussionsFromDir = Effect.fn("DiscussionRegistry.loadDiscussionsFromDir")(function* (
    dirPath: string,
    scope: DiscussionScope,
  ) {
    const exists = yield* fileSystem.exists(dirPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return [] as DiscussionEntry[];
    }

    const entries = yield* fileSystem.readDirectory(dirPath, { recursive: false }).pipe(
      Effect.mapError(
        (cause) =>
          new DiscussionRegistryFileError({
            path: dirPath,
            operation: "discussionRegistry.readDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );

    const yamlFiles = [...entries]
      .filter((entry) => entry.endsWith(".yaml") || entry.endsWith(".yml"))
      .toSorted((left, right) => left.localeCompare(right));

    const results: DiscussionEntry[] = [];
    for (const entry of yamlFiles) {
      const discussion = yield* parseDiscussionFile(path.join(dirPath, entry));
      results.push({ ...discussion, scope });
    }
    return results;
  });

  const collectAll = Effect.fn("DiscussionRegistry.collectAll")(function* (input: {
    readonly workspaceRoot?: string;
  }) {
    const dirs: Array<{ dir: string; scope: DiscussionScope }> = [];

    if (input.workspaceRoot) {
      dirs.push({
        dir: path.resolve(input.workspaceRoot, ".forge", "discussions"),
        scope: "project",
      });
    }

    dirs.push({ dir: globalDir, scope: "global" });

    const all: DiscussionEntry[] = [];
    const seenNames = new Set<string>();

    for (const { dir, scope } of dirs) {
      const discussions = yield* loadDiscussionsFromDir(dir, scope);
      for (const discussion of discussions) {
        if (!seenNames.has(discussion.name)) {
          seenNames.add(discussion.name);
          all.push(discussion);
        }
      }
    }

    return all;
  });

  const queryAll: DiscussionRegistryShape["queryAll"] = (input) => collectAll(input);

  const queryByName: DiscussionRegistryShape["queryByName"] = (input) =>
    collectAll(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}).pipe(
      Effect.map((discussions) => {
        const found = discussions.find((d) => d.name === input.name);
        return found ? Option.some(found) : Option.none();
      }),
    );

  return { queryAll, queryByName } satisfies DiscussionRegistryShape;
});

export const makeDiscussionRegistryLive = (options?: DiscussionRegistryLiveOptions) =>
  Layer.effect(DiscussionRegistry, makeDiscussionRegistry(options));

export const DiscussionRegistryLive = makeDiscussionRegistryLive();
