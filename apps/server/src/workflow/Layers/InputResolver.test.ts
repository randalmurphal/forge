import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChannelId,
  ChannelMessageId,
  PhaseRunId,
  ThreadId,
  WorkflowId,
  WorkflowPhaseId,
} from "@forgetools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionChannelMessageRepositoryLive } from "../../persistence/Layers/ProjectionChannelMessages.ts";
import { ProjectionChannelRepositoryLive } from "../../persistence/Layers/ProjectionChannels.ts";
import { ProjectionPhaseOutputRepositoryLive } from "../../persistence/Layers/ProjectionPhaseOutputs.ts";
import { ProjectionPhaseRunRepositoryLive } from "../../persistence/Layers/ProjectionPhaseRuns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionChannelMessageRepository } from "../../persistence/Services/ProjectionChannelMessages.ts";
import { ProjectionChannelRepository } from "../../persistence/Services/ProjectionChannels.ts";
import { ProjectionPhaseOutputRepository } from "../../persistence/Services/ProjectionPhaseOutputs.ts";
import { ProjectionPhaseRunRepository } from "../../persistence/Services/ProjectionPhaseRuns.ts";
import {
  InputResolverMissingReferenceError,
  InputResolverInvalidReferenceError,
} from "../Errors.ts";
import { resolveInputFrom } from "./InputResolver.ts";

const workflowId = WorkflowId.makeUnsafe("workflow-input-resolver");
const threadId = ThreadId.makeUnsafe("thread-workflow");
const promotedThreadId = ThreadId.makeUnsafe("thread-promoted-chat");
const reviewPhaseId = WorkflowPhaseId.makeUnsafe("phase-review");
const reviewPhaseRun1 = PhaseRunId.makeUnsafe("phase-run-review-1");
const reviewPhaseRun2 = PhaseRunId.makeUnsafe("phase-run-review-2");

async function createRuntime() {
  const layer = Layer.mergeAll(
    ProjectionPhaseRunRepositoryLive,
    ProjectionPhaseOutputRepositoryLive,
    ProjectionChannelRepositoryLive,
    ProjectionChannelMessageRepositoryLive,
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory), Layer.provideMerge(NodeServices.layer));

  return ManagedRuntime.make(layer);
}

it.effect("resolves the most recent completed phase output", () =>
  Effect.promise(async () => {
    const runtime = await createRuntime();
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const phaseRuns = yield* ProjectionPhaseRunRepository;
          const phaseOutputs = yield* ProjectionPhaseOutputRepository;

          yield* phaseRuns.upsert({
            phaseRunId: reviewPhaseRun1,
            threadId,
            workflowId,
            phaseId: reviewPhaseId,
            phaseName: "review",
            phaseType: "single-agent",
            sandboxMode: "workspace-write",
            iteration: 1,
            status: "completed",
            gateResult: null,
            qualityChecks: null,
            deliberationState: null,
            startedAt: "2026-04-05T10:00:00.000Z",
            completedAt: "2026-04-05T10:10:00.000Z",
          });
          yield* phaseRuns.upsert({
            phaseRunId: reviewPhaseRun2,
            threadId,
            workflowId,
            phaseId: reviewPhaseId,
            phaseName: "review",
            phaseType: "single-agent",
            sandboxMode: "workspace-write",
            iteration: 2,
            status: "completed",
            gateResult: null,
            qualityChecks: null,
            deliberationState: null,
            startedAt: "2026-04-05T11:00:00.000Z",
            completedAt: "2026-04-05T11:10:00.000Z",
          });
          yield* phaseOutputs.upsert({
            phaseRunId: reviewPhaseRun1,
            outputKey: "output",
            content: "older output",
            sourceType: "conversation",
            sourceId: null,
            metadata: null,
            createdAt: "2026-04-05T10:10:00.000Z",
            updatedAt: "2026-04-05T10:10:00.000Z",
          });
          yield* phaseOutputs.upsert({
            phaseRunId: reviewPhaseRun2,
            outputKey: "output:scrutinizer",
            content: "role-specific output",
            sourceType: "conversation",
            sourceId: null,
            metadata: null,
            createdAt: "2026-04-05T11:10:00.000Z",
            updatedAt: "2026-04-05T11:10:00.000Z",
          });
          yield* phaseOutputs.upsert({
            phaseRunId: reviewPhaseRun2,
            outputKey: "output",
            content: "latest output",
            sourceType: "conversation",
            sourceId: null,
            metadata: null,
            createdAt: "2026-04-05T11:10:00.000Z",
            updatedAt: "2026-04-05T11:10:00.000Z",
          });
        }),
      );

      const latestOutput = await runtime.runPromise(resolveInputFrom("review.output", threadId));
      assert.strictEqual(latestOutput, "latest output");

      const roleOutput = await runtime.runPromise(
        resolveInputFrom("review.output:scrutinizer", threadId),
      );
      assert.strictEqual(roleOutput, "role-specific output");
    } finally {
      await runtime.dispose();
    }
  }),
);

it.effect(
  "resolves promoted-from.channel through session links and channel transcript formatting",
  () =>
    Effect.promise(async () => {
      const runtime = await createRuntime();
      try {
        await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const channels = yield* ProjectionChannelRepository;
            const channelMessages = yield* ProjectionChannelMessageRepository;

            yield* sql`
            INSERT INTO session_links (
              link_id,
              session_id,
              linked_session_id,
              link_type,
              metadata_json,
              created_at,
              updated_at
            )
            VALUES (
              ${"link-promoted-from"},
              ${threadId},
              ${promotedThreadId},
              ${"promoted-from"},
              ${"{}"},
              ${"2026-04-05T12:00:00.000Z"},
              ${"2026-04-05T12:00:00.000Z"}
            )
          `;

            yield* channels.create({
              channelId: ChannelId.makeUnsafe("channel-promoted"),
              threadId: promotedThreadId,
              phaseRunId: null,
              type: "deliberation",
              status: "open",
              createdAt: "2026-04-05T12:00:00.000Z",
              updatedAt: "2026-04-05T12:00:00.000Z",
            });

            yield* channelMessages.insert({
              messageId: ChannelMessageId.makeUnsafe("message-1"),
              channelId: ChannelId.makeUnsafe("channel-promoted"),
              sequence: 0,
              fromType: "agent",
              fromId: ThreadId.makeUnsafe("thread-advocate"),
              fromRole: "advocate",
              content: "First point",
              metadata: null,
              createdAt: "2026-04-05T12:01:00.000Z",
              deletedAt: null,
            });
            yield* channelMessages.insert({
              messageId: ChannelMessageId.makeUnsafe("message-2"),
              channelId: ChannelId.makeUnsafe("channel-promoted"),
              sequence: 1,
              fromType: "agent",
              fromId: ThreadId.makeUnsafe("thread-critic"),
              fromRole: "critic",
              content: "Second point",
              metadata: null,
              createdAt: "2026-04-05T12:02:00.000Z",
              deletedAt: null,
            });
          }),
        );

        const transcript = await runtime.runPromise(
          resolveInputFrom("promoted-from.channel", threadId),
        );
        assert.strictEqual(transcript, "[advocate]\nFirst point\n\n[critic]\nSecond point");
      } finally {
        await runtime.dispose();
      }
    }),
);

it.effect("fails clearly for missing phase outputs and invalid references", () =>
  Effect.promise(async () => {
    const runtime = await createRuntime();
    try {
      const missing = await runtime.runPromise(
        Effect.flip(resolveInputFrom("implement.output", threadId)),
      );
      assert.strictEqual(missing._tag, "InputResolverMissingReferenceError");
      assert.strictEqual(
        (missing as InputResolverMissingReferenceError).reference,
        "implement.output",
      );

      const invalid = await runtime.runPromise(
        Effect.flip(resolveInputFrom("not-a-reference", threadId)),
      );
      assert.strictEqual(invalid._tag, "InputResolverInvalidReferenceError");
      assert.strictEqual(
        (invalid as InputResolverInvalidReferenceError).reference,
        "not-a-reference",
      );
    } finally {
      await runtime.dispose();
    }
  }),
);
