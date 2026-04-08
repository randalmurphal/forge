import { DiscussionDefinition, type DiscussionScope } from "@forgetools/contracts";
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import * as OS from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  DiscussionRegistryFileError,
  DiscussionRegistryInvariantError,
  DiscussionRegistryParseError,
  DiscussionRegistryScopeError,
  toDiscussionRegistryDecodeError,
} from "../Errors.ts";
import {
  DiscussionRegistry,
  type DiscussionEntry,
  type DiscussionRegistryShape,
  type ManagedDiscussionEntry,
} from "../Services/DiscussionRegistry.ts";

export interface DiscussionRegistryLiveOptions {
  readonly globalDir?: string;
}

type ResolvedDiscussionEntry = DiscussionEntry & { readonly filePath: string };

const decodeDiscussionDefinition = Schema.decodeUnknownEffect(DiscussionDefinition);

function stripYamlExtension(filePath: string): string {
  return filePath.replace(/\.(ya?ml)$/i, "");
}

function toDiscussionEntry(entry: ResolvedDiscussionEntry): DiscussionEntry {
  return {
    name: entry.name,
    description: entry.description,
    participants: entry.participants,
    settings: entry.settings,
    scope: entry.scope,
  };
}

const makeDiscussionRegistry = Effect.fn("makeDiscussionRegistry")(function* (
  options?: DiscussionRegistryLiveOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const globalDir = options?.globalDir ?? path.join(OS.homedir(), ".forge", "discussions");

  const resolveScopeDirectory = (scope: DiscussionScope, workspaceRoot?: string) => {
    if (scope === "global") {
      return Effect.succeed(globalDir);
    }

    if (!workspaceRoot) {
      return Effect.fail(
        new DiscussionRegistryScopeError({
          scope,
          detail: "workspaceRoot is required for project-scoped discussion operations.",
        }),
      );
    }

    return Effect.succeed(path.resolve(workspaceRoot, ".forge", "discussions"));
  };

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

    const expectedName = path.basename(stripYamlExtension(filePath));
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
      return [] as ResolvedDiscussionEntry[];
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

    const results: ResolvedDiscussionEntry[] = [];
    for (const entry of yamlFiles) {
      const filePath = path.join(dirPath, entry);
      const discussion = yield* parseDiscussionFile(filePath);
      results.push({ ...discussion, scope, filePath });
    }

    return results;
  });

  const collectManagedExact = Effect.fn("DiscussionRegistry.collectManagedExact")(
    function* (input: { readonly workspaceRoot?: string }) {
      const dirs: Array<{ dir: string; scope: DiscussionScope }> = [];

      if (input.workspaceRoot) {
        dirs.push({
          dir: path.resolve(input.workspaceRoot, ".forge", "discussions"),
          scope: "project",
        });
      }

      dirs.push({ dir: globalDir, scope: "global" });

      const all: ResolvedDiscussionEntry[] = [];
      for (const { dir, scope } of dirs) {
        const discussions = yield* loadDiscussionsFromDir(dir, scope);
        all.push(...discussions);
      }

      return all;
    },
  );

  const findManagedExact = Effect.fn("DiscussionRegistry.findManagedExact")(function* (input: {
    readonly name: string;
    readonly scope: DiscussionScope;
    readonly workspaceRoot?: string;
  }) {
    const discussions = yield* collectManagedExact(
      input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {},
    );
    return discussions.find(
      (discussion) => discussion.name === input.name && discussion.scope === input.scope,
    );
  });

  const writeDiscussionAtomically = Effect.fn("DiscussionRegistry.writeDiscussionAtomically")(
    function* (filePath: string, discussion: DiscussionDefinition) {
      const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      const encoded = `${stringifyYaml(discussion)}\n`;

      yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new DiscussionRegistryFileError({
              path: filePath,
              operation: "discussionRegistry.makeDirectory",
              detail: cause.message,
              cause,
            }),
        ),
      );
      yield* fileSystem.writeFileString(tempPath, encoded).pipe(
        Effect.mapError(
          (cause) =>
            new DiscussionRegistryFileError({
              path: tempPath,
              operation: "discussionRegistry.writeFile",
              detail: cause.message,
              cause,
            }),
        ),
      );
      yield* fileSystem.rename(tempPath, filePath).pipe(
        Effect.mapError(
          (cause) =>
            new DiscussionRegistryFileError({
              path: filePath,
              operation: "discussionRegistry.renameFile",
              detail: cause.message,
              cause,
            }),
        ),
      );
      yield* fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore({ log: true }));
    },
  );

  const deleteDiscussionFile = Effect.fn("DiscussionRegistry.deleteDiscussionFile")(function* (
    filePath: string,
  ) {
    yield* fileSystem.remove(filePath, { force: true }).pipe(
      Effect.mapError(
        (cause) =>
          new DiscussionRegistryFileError({
            path: filePath,
            operation: "discussionRegistry.removeFile",
            detail: cause.message,
            cause,
          }),
      ),
    );
  });

  const queryAll: DiscussionRegistryShape["queryAll"] = (input) =>
    collectManagedExact(input).pipe(
      Effect.map((discussions) => {
        const seenNames = new Set<string>();
        const resolved: DiscussionEntry[] = [];

        for (const discussion of discussions) {
          if (seenNames.has(discussion.name)) {
            continue;
          }
          seenNames.add(discussion.name);
          resolved.push(toDiscussionEntry(discussion));
        }

        return resolved;
      }),
    );

  const queryByName: DiscussionRegistryShape["queryByName"] = (input) =>
    queryAll(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}).pipe(
      Effect.map((discussions) => {
        const found = discussions.find((discussion) => discussion.name === input.name);
        return found ? Option.some(found) : Option.none();
      }),
    );

  const queryManagedAll: DiscussionRegistryShape["queryManagedAll"] = (input) =>
    collectManagedExact(input).pipe(
      Effect.map((discussions): ReadonlyArray<ManagedDiscussionEntry> => {
        const effectiveProjectNames = new Set(
          discussions
            .filter((discussion) => discussion.scope === "project")
            .map((discussion) => discussion.name),
        );

        return discussions.map((discussion) => ({
          ...toDiscussionEntry(discussion),
          effective: discussion.scope === "project" || !effectiveProjectNames.has(discussion.name),
        }));
      }),
    );

  const queryManagedByName: DiscussionRegistryShape["queryManagedByName"] = (input) =>
    findManagedExact(input).pipe(
      Effect.map((discussion) =>
        discussion ? Option.some(toDiscussionEntry(discussion)) : Option.none(),
      ),
    );

  const create: DiscussionRegistryShape["create"] = (input) =>
    Effect.gen(function* () {
      const existingDiscussion = yield* findManagedExact({
        name: input.discussion.name,
        scope: input.scope,
        ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
      });
      if (existingDiscussion) {
        return yield* new DiscussionRegistryInvariantError({
          path: existingDiscussion.filePath,
          detail: `Discussion '${input.discussion.name}' already exists in scope '${input.scope}'.`,
        });
      }

      const dirPath = yield* resolveScopeDirectory(input.scope, input.workspaceRoot);
      const filePath = path.join(dirPath, `${input.discussion.name}.yaml`);
      yield* writeDiscussionAtomically(filePath, input.discussion);
      return {
        ...input.discussion,
        scope: input.scope,
      };
    });

  const update: DiscussionRegistryShape["update"] = (input) =>
    Effect.gen(function* () {
      const previousEntry = yield* findManagedExact({
        name: input.previousName,
        scope: input.previousScope,
        ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
      });
      if (!previousEntry) {
        return yield* new DiscussionRegistryInvariantError({
          path: input.previousName,
          detail: `Discussion '${input.previousName}' with scope '${input.previousScope}' was not found.`,
        });
      }

      const nextDirPath = yield* resolveScopeDirectory(input.scope, input.workspaceRoot);
      const nextFilePath = path.join(nextDirPath, `${input.discussion.name}.yaml`);
      const conflictingDiscussion = yield* findManagedExact({
        name: input.discussion.name,
        scope: input.scope,
        ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
      });
      if (conflictingDiscussion && conflictingDiscussion.filePath !== previousEntry.filePath) {
        return yield* new DiscussionRegistryInvariantError({
          path: conflictingDiscussion.filePath,
          detail: `Discussion '${input.discussion.name}' already exists in scope '${input.scope}'.`,
        });
      }
      yield* writeDiscussionAtomically(nextFilePath, input.discussion);

      if (previousEntry.filePath !== nextFilePath) {
        yield* deleteDiscussionFile(previousEntry.filePath);
      }

      return {
        ...input.discussion,
        scope: input.scope,
      };
    });

  const deleteManagedDiscussion: DiscussionRegistryShape["delete"] = (input) =>
    Effect.gen(function* () {
      const discussion = yield* findManagedExact(input);
      if (!discussion) {
        return;
      }
      yield* deleteDiscussionFile(discussion.filePath);
    });

  return {
    queryAll,
    queryByName,
    queryManagedAll,
    queryManagedByName,
    create,
    update,
    delete: deleteManagedDiscussion,
  } satisfies DiscussionRegistryShape;
});

export const makeDiscussionRegistryLive = (options?: DiscussionRegistryLiveOptions) =>
  Layer.effect(DiscussionRegistry, makeDiscussionRegistry(options));

export const DiscussionRegistryLive = makeDiscussionRegistryLive();
