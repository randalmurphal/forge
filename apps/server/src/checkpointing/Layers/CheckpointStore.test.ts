import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, PlatformError, Scope } from "effect";
import { describe, expect } from "vitest";

import { checkpointRefForThreadTurn } from "../Utils.ts";
import { CheckpointStoreLive } from "./CheckpointStore.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { GitCommandError } from "@forgetools/contracts";
import { ServerConfig } from "../../config.ts";
import { ThreadId } from "@forgetools/contracts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "forge-checkpoint-store-test-",
});
const GitCoreTestLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provide(NodeServices.layer),
);
const CheckpointStoreTestLayer = CheckpointStoreLive.pipe(
  Layer.provide(GitCoreTestLayer),
  Layer.provide(NodeServices.layer),
);
const TestLayer = Layer.mergeAll(NodeServices.layer, GitCoreTestLayer, CheckpointStoreTestLayer);

function makeTmpDir(
  prefix = "checkpoint-store-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function writeTextFile(
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, contents);
  });
}

function git(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, GitCommandError, GitCore> {
  return Effect.gen(function* () {
    const gitCore = yield* GitCore;
    const result = yield* gitCore.execute({
      operation: "CheckpointStore.test.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });
}

function initRepoWithCommit(
  cwd: string,
): Effect.Effect<
  void,
  GitCommandError | PlatformError.PlatformError,
  GitCore | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    yield* core.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(path.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });
}

function buildLargeText(lineCount = 20_000): string {
  return Array.from({ length: lineCount }, (_, index) => `line ${String(index).padStart(5, "0")}`)
    .join("\n")
    .concat("\n");
}

it.layer(TestLayer)("CheckpointStoreLive", (it) => {
  describe("diffCheckpoints", () => {
    it.effect("returns full oversized checkpoint diffs without truncation", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.makeUnsafe("thread-checkpoint-store");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(path.join(tmp, "README.md"), buildLargeText());
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(diff).toContain("diff --git");
        expect(diff).not.toContain("[truncated]");
        expect(diff).toContain("+line 19999");
      }),
    );
  });

  describe("diffCheckpointToWorkspace", () => {
    it.effect("returns a scoped working tree diff for tracked, deleted, and untracked files", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.makeUnsafe("thread-checkpoint-workspace");
        const checkpointRef = checkpointRefForThreadTurn(threadId, 0);

        yield* writeTextFile(path.join(tmp, "tracked-delete.txt"), "delete me\n");
        yield* writeTextFile(path.join(tmp, "ignored.txt"), "keep baseline\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "seed tracked files"]);
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef,
        });

        yield* writeTextFile(path.join(tmp, "README.md"), "# changed\n");
        yield* writeTextFile(path.join(tmp, "untracked.txt"), "brand new\n");
        yield* writeTextFile(path.join(tmp, "ignored.txt"), "should stay out\n");
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.remove(path.join(tmp, "tracked-delete.txt"));

        const diff = yield* checkpointStore.diffCheckpointToWorkspace({
          cwd: tmp,
          checkpointRef,
          paths: ["README.md", "tracked-delete.txt", "untracked.txt"],
        });

        expect(diff).toContain("diff --git a/README.md b/README.md");
        expect(diff).toContain("diff --git a/tracked-delete.txt b/tracked-delete.txt");
        expect(diff).toContain("diff --git a/untracked.txt b/untracked.txt");
        expect(diff).not.toContain("ignored.txt");
      }),
    );
  });
});
