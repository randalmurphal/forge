import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";

import { DiscussionRegistry } from "../Services/DiscussionRegistry.ts";
import { makeDiscussionRegistryLive } from "./DiscussionRegistry.ts";

const makeDiscussionRegistryTestLayer = (globalDir: string) =>
  makeDiscussionRegistryLive({ globalDir }).pipe(Layer.provideMerge(NodeServices.layer));

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectory({ prefix: "forge-discussions-" });
});

const writeFile = Effect.fn("DiscussionRegistryTest.writeFile")(function* (
  directory: string,
  fileName: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(Effect.orDie);
  yield* fileSystem.writeFileString(path.join(directory, fileName), contents).pipe(Effect.orDie);
});

const readFile = Effect.fn("DiscussionRegistryTest.readFile")(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(filePath).pipe(Effect.orDie);
});

const globalYaml = `
name: debate
description: Global debate
participants:
  - role: advocate
    description: Argues for
    system: Keep pushing for the proposal.
  - role: critic
    description: Argues against
    system: Keep pushing back.
settings:
  maxTurns: 12
`;

const projectYaml = `
name: debate
description: Project debate
participants:
  - role: advocate
    description: Argues for
    system: Project advocate
  - role: critic
    description: Argues against
    system: Project critic
settings:
  maxTurns: 9
`;

it.effect(
  "returns the effective discussion by precedence and preserves exact managed duplicates",
  () =>
    Effect.gen(function* () {
      const globalDir = yield* makeTempDir;
      const workspaceRoot = yield* makeTempDir;
      const path = yield* Path.Path;

      yield* writeFile(globalDir, "debate.yaml", globalYaml);
      yield* writeFile(
        path.join(workspaceRoot, ".forge", "discussions"),
        "debate.yaml",
        projectYaml,
      );

      const result = yield* Effect.gen(function* () {
        const registry = yield* DiscussionRegistry;
        const [effectiveList, managedList, effective] = yield* Effect.all([
          registry.queryAll({ workspaceRoot }),
          registry.queryManagedAll({ workspaceRoot }),
          registry.queryByName({ name: "debate", workspaceRoot }),
        ]);

        return {
          effectiveList,
          managedList,
          effective,
        };
      }).pipe(Effect.provide(makeDiscussionRegistryTestLayer(globalDir)));

      assert.deepStrictEqual(
        result.effectiveList.map((entry) => entry.description),
        ["Project debate"],
      );
      assert.deepStrictEqual(
        result.managedList.map((entry) => ({
          description: entry.description,
          effective: entry.effective,
          scope: entry.scope,
        })),
        [
          { description: "Project debate", effective: true, scope: "project" },
          { description: "Global debate", effective: false, scope: "global" },
        ],
      );
      assert.deepStrictEqual(result.effective._tag, "Some");
      assert.strictEqual(Option.getOrThrow(result.effective).description, "Project debate");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("creates, updates, renames, and deletes discussion yaml files atomically", () =>
  Effect.gen(function* () {
    const globalDir = yield* makeTempDir;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const state = yield* Effect.gen(function* () {
      const registry = yield* DiscussionRegistry;

      const created = yield* registry.create({
        scope: "global",
        discussion: {
          name: "retrospective",
          description: "Retro",
          participants: [
            {
              role: "facilitator",
              description: "Leads the room",
              system: "Keep the discussion moving.",
            },
            {
              role: "reviewer",
              description: "Challenges conclusions",
              system: "Ask for evidence.",
            },
          ],
          settings: {
            maxTurns: 6,
          },
        },
      });

      const updated = yield* registry.update({
        previousName: "retrospective",
        previousScope: "global",
        scope: "global",
        discussion: {
          ...created,
          name: "retro-v2",
          description: "Retro updated",
        },
      });

      const content = yield* readFile(path.join(globalDir, "retro-v2.yaml"));

      yield* registry.delete({
        name: "retro-v2",
        scope: "global",
      });

      return {
        created,
        content,
        updated,
      };
    }).pipe(Effect.provide(makeDiscussionRegistryTestLayer(globalDir)));

    const createdFilePath = path.join(globalDir, "retrospective.yaml");
    const updatedFilePath = path.join(globalDir, "retro-v2.yaml");

    assert.strictEqual(state.created.scope, "global");
    assert.strictEqual(state.updated.name, "retro-v2");
    assert.match(state.content, /name: retro-v2/);
    assert.strictEqual(
      yield* fileSystem.exists(createdFilePath).pipe(Effect.orElseSucceed(() => false)),
      false,
    );
    assert.strictEqual(
      yield* fileSystem.exists(updatedFilePath).pipe(Effect.orElseSucceed(() => false)),
      false,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
