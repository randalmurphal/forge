import { PhaseRunId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { ProjectionPhaseOutputRepository } from "../Services/ProjectionPhaseOutputs.ts";
import { ProjectionPhaseOutputRepositoryLive } from "./ProjectionPhaseOutputs.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionPhaseOutputRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionPhaseOutputRepository", (it) => {
  it.effect("stores phase outputs, queries them by phase run, and reads by composite key", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionPhaseOutputRepository;
      const phaseRunId = PhaseRunId.makeUnsafe("phase-run-outputs");

      yield* repository.upsert({
        phaseRunId,
        outputKey: "channel",
        content: "Channel transcript",
        sourceType: "channel",
        sourceId: "channel-deliberation",
        metadata: { renderedFrom: "messages" },
        createdAt: "2026-04-05T15:00:00.000Z",
        updatedAt: "2026-04-05T15:00:00.000Z",
      });

      yield* repository.upsert({
        phaseRunId,
        outputKey: "output",
        content: "Implementation summary",
        sourceType: "conversation",
        sourceId: "thread-child-implementer",
        metadata: null,
        createdAt: "2026-04-05T15:01:00.000Z",
        updatedAt: "2026-04-05T15:01:00.000Z",
      });

      yield* repository.upsert({
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-other"),
        outputKey: "output",
        content: "Other phase output",
        sourceType: "conversation",
        sourceId: "thread-child-other",
        metadata: null,
        createdAt: "2026-04-05T15:02:00.000Z",
        updatedAt: "2026-04-05T15:02:00.000Z",
      });

      const byPhaseRunId = yield* repository.queryByPhaseRunId({ phaseRunId });
      assert.deepStrictEqual(byPhaseRunId, [
        {
          phaseRunId,
          outputKey: "channel",
          content: "Channel transcript",
          sourceType: "channel",
          sourceId: "channel-deliberation",
          metadata: { renderedFrom: "messages" },
          createdAt: "2026-04-05T15:00:00.000Z",
          updatedAt: "2026-04-05T15:00:00.000Z",
        },
        {
          phaseRunId,
          outputKey: "output",
          content: "Implementation summary",
          sourceType: "conversation",
          sourceId: "thread-child-implementer",
          metadata: null,
          createdAt: "2026-04-05T15:01:00.000Z",
          updatedAt: "2026-04-05T15:01:00.000Z",
        },
      ]);

      const byKey = yield* repository.queryByKey({
        phaseRunId,
        outputKey: "channel",
      });
      assert.deepStrictEqual(Option.getOrNull(byKey), {
        phaseRunId,
        outputKey: "channel",
        content: "Channel transcript",
        sourceType: "channel",
        sourceId: "channel-deliberation",
        metadata: { renderedFrom: "messages" },
        createdAt: "2026-04-05T15:00:00.000Z",
        updatedAt: "2026-04-05T15:00:00.000Z",
      });
    }),
  );

  it.effect("upserts phase outputs by composite key", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionPhaseOutputRepository;
      const phaseRunId = PhaseRunId.makeUnsafe("phase-run-output-upsert");

      yield* repository.upsert({
        phaseRunId,
        outputKey: "output",
        content: "Initial content",
        sourceType: "conversation",
        sourceId: "thread-child-initial",
        metadata: null,
        createdAt: "2026-04-05T15:10:00.000Z",
        updatedAt: "2026-04-05T15:10:00.000Z",
      });

      yield* repository.upsert({
        phaseRunId,
        outputKey: "output",
        content: "Edited content",
        sourceType: "human-edit",
        sourceId: null,
        metadata: { originalContent: "Initial content" },
        createdAt: "2026-04-05T15:10:00.000Z",
        updatedAt: "2026-04-05T15:12:00.000Z",
      });

      const persisted = yield* repository.queryByKey({
        phaseRunId,
        outputKey: "output",
      });
      assert.deepStrictEqual(Option.getOrNull(persisted), {
        phaseRunId,
        outputKey: "output",
        content: "Edited content",
        sourceType: "human-edit",
        sourceId: null,
        metadata: { originalContent: "Initial content" },
        createdAt: "2026-04-05T15:10:00.000Z",
        updatedAt: "2026-04-05T15:12:00.000Z",
      });
    }),
  );
});
