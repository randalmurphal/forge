import { ThreadId, TurnId } from "@forgetools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { ProjectionAgentDiffRepository } from "../Services/ProjectionAgentDiffs.ts";
import { ProjectionAgentDiffRepositoryLive } from "./ProjectionAgentDiffs.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionAgentDiffRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionAgentDiffRepository", (it) => {
  it.effect("appends diff history and resolves the latest diff for a turn", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionAgentDiffRepository;
      const threadId = ThreadId.makeUnsafe("thread-diff-history");
      const turnId = TurnId.makeUnsafe("turn-1");

      yield* repository.append({
        threadId,
        turnId,
        diff: "diff --git a/a.ts b/a.ts\n+first\n",
        files: [{ path: "a.ts", kind: "modified", additions: 1, deletions: 0 }],
        source: "derived_tool_results",
        coverage: "partial",
        assistantMessageId: null,
        completedAt: "2026-04-14T00:00:01.000Z",
      });
      yield* repository.append({
        threadId,
        turnId,
        diff: "diff --git a/a.ts b/a.ts\n+second\n",
        files: [{ path: "a.ts", kind: "modified", additions: 2, deletions: 0 }],
        source: "native_turn_diff",
        coverage: "complete",
        assistantMessageId: null,
        completedAt: "2026-04-14T00:00:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      const latest = yield* repository.getLatestByTurnId({ threadId, turnId });

      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.coverage, "partial");
      assert.equal(rows[1]?.coverage, "complete");
      assert.equal(Option.isSome(latest), true);
      if (Option.isSome(latest)) {
        assert.equal(latest.value.diff, "diff --git a/a.ts b/a.ts\n+second\n");
        assert.equal(latest.value.coverage, "complete");
      }
    }),
  );
});
