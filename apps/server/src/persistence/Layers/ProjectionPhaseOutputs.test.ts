import { PhaseRunId } from "@forgetools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError } from "../Errors.ts";
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

  it.effect("fails with PersistenceDecodeError when stored metadata json is invalid", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionPhaseOutputRepository;
      const sql = yield* SqlClient.SqlClient;
      const phaseRunId = PhaseRunId.makeUnsafe("phase-run-invalid-json");

      yield* sql`
        INSERT INTO phase_outputs (
          phase_run_id,
          output_key,
          content,
          source_type,
          source_id,
          metadata_json,
          created_at,
          updated_at
        )
        VALUES (
          ${phaseRunId},
          ${"output"},
          ${"Broken phase output"},
          ${"conversation"},
          ${"thread-child-invalid"},
          ${"{"},
          ${"2026-04-05T18:30:00.000Z"},
          ${"2026-04-05T18:30:00.000Z"}
        )
      `;

      const result = yield* Effect.result(
        repository.queryByKey({
          phaseRunId,
          outputKey: "output",
        }),
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.ok(Schema.is(PersistenceDecodeError)(result.failure));
        assert.ok(
          result.failure.operation.includes("ProjectionPhaseOutputRepository.queryByKey:decodeRow"),
        );
      }
    }),
  );
});
