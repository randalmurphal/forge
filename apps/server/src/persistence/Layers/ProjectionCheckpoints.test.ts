import { CheckpointRef, ThreadId, TurnId } from "@forgetools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { ProjectionCheckpointRepository } from "../Services/ProjectionCheckpoints.ts";
import { ProjectionCheckpointRepositoryLive } from "./ProjectionCheckpoints.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionCheckpointRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionCheckpointRepository", (it) => {
  it.effect("appends checkpoint history and resolves the latest revision for a turn count", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionCheckpointRepository;
      const threadId = ThreadId.makeUnsafe("thread-checkpoint-history");
      const turnId = TurnId.makeUnsafe("turn-1");

      yield* repository.append({
        threadId,
        turnId,
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe(
          "refs/forge/checkpoints/thread-checkpoint-history/turn/1",
        ),
        status: "missing",
        files: [],
        assistantMessageId: null,
        completedAt: "2026-04-14T00:00:01.000Z",
      });
      yield* repository.append({
        threadId,
        turnId,
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe(
          "refs/forge/checkpoints/thread-checkpoint-history/turn/1",
        ),
        status: "ready",
        files: [{ path: "README.md", kind: "modified", additions: 1, deletions: 0 }],
        assistantMessageId: null,
        completedAt: "2026-04-14T00:00:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      const latest = yield* repository.getByThreadAndTurnCount({
        threadId,
        checkpointTurnCount: 1,
      });

      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.status, "missing");
      assert.equal(rows[1]?.status, "ready");
      assert.equal(Option.isSome(latest), true);
      if (Option.isSome(latest)) {
        assert.equal(latest.value.status, "ready");
        assert.deepEqual(latest.value.files, [
          { path: "README.md", kind: "modified", additions: 1, deletions: 0 },
        ]);
      }
    }),
  );
});
