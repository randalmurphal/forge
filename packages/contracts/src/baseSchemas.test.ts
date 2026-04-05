import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  ChannelId,
  ChannelMessageId,
  InteractiveRequestId,
  LinkId,
  PhaseRunId,
  WorkflowId,
  WorkflowPhaseId,
} from "./baseSchemas";

const entityIdSchemas = [
  ["WorkflowId", WorkflowId],
  ["WorkflowPhaseId", WorkflowPhaseId],
  ["PhaseRunId", PhaseRunId],
  ["ChannelId", ChannelId],
  ["ChannelMessageId", ChannelMessageId],
  ["LinkId", LinkId],
  ["InteractiveRequestId", InteractiveRequestId],
] as const;

for (const [name, schema] of entityIdSchemas) {
  const decode = Schema.decodeUnknownEffect(schema);

  it.effect(`${name} decodes trimmed non-empty identifiers`, () =>
    Effect.gen(function* () {
      const parsed = yield* decode(` ${name.toLowerCase()}-1 `);
      assert.strictEqual(parsed, `${name.toLowerCase()}-1`);
    }),
  );

  it.effect(`${name} rejects identifiers that are empty after trim`, () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(decode("   "));
      assert.strictEqual(result._tag, "Failure");
    }),
  );
}
