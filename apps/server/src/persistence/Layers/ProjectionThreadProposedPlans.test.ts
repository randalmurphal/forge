import { ThreadId } from "@forgetools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { findLatestProposedPlanById } from "@forgetools/shared/threadHistory";

import { ProjectionThreadProposedPlanRepository } from "../Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "./ProjectionThreadProposedPlans.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadProposedPlanRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadProposedPlanRepository", (it) => {
  it.effect("preserves append-only plan history for the same logical plan id", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadProposedPlanRepository;
      const threadId = ThreadId.makeUnsafe("thread-plan-history");

      yield* repository.append({
        planId: "plan-1",
        threadId,
        turnId: null,
        planMarkdown: "# First",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: "2026-04-14T00:00:00.000Z",
        updatedAt: "2026-04-14T00:00:01.000Z",
      });
      yield* repository.append({
        planId: "plan-1",
        threadId,
        turnId: null,
        planMarkdown: "# Second",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: "2026-04-14T00:00:00.000Z",
        updatedAt: "2026-04-14T00:00:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });

      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.planMarkdown, "# First");
      assert.equal(rows[1]?.planMarkdown, "# Second");
      assert.equal(
        findLatestProposedPlanById(
          rows.map((row) => ({
            id: row.planId,
            planMarkdown: row.planMarkdown,
            updatedAt: row.updatedAt,
          })),
          "plan-1",
        )?.planMarkdown,
        "# Second",
      );
    }),
  );
});
