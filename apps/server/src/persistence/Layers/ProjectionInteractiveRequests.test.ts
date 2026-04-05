import { InteractiveRequestId, PhaseRunId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { ProjectionInteractiveRequestRepository } from "../Services/ProjectionInteractiveRequests.ts";
import { ProjectionInteractiveRequestRepositoryLive } from "./ProjectionInteractiveRequests.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionInteractiveRequestRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionInteractiveRequestRepository", (it) => {
  it.effect("stores and queries interactive requests by id and thread", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionInteractiveRequestRepository;

      yield* repository.upsert({
        requestId: InteractiveRequestId.makeUnsafe("request-approval"),
        threadId: ThreadId.makeUnsafe("thread-foundation"),
        childThreadId: ThreadId.makeUnsafe("thread-child-review"),
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-review"),
        type: "approval",
        status: "pending",
        payload: {
          type: "approval",
          requestType: "command_execution_approval",
          detail: "Run lint before concluding the phase",
          toolName: "Bash",
          toolInput: { cmd: "bun lint" },
          suggestions: ["Bash:bun lint"],
        },
        resolvedWith: null,
        createdAt: "2026-04-05T15:00:00.000Z",
        resolvedAt: null,
        staleReason: null,
      });

      yield* repository.upsert({
        requestId: InteractiveRequestId.makeUnsafe("request-gate"),
        threadId: ThreadId.makeUnsafe("thread-foundation"),
        childThreadId: null,
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-gate"),
        type: "gate",
        status: "pending",
        payload: {
          type: "gate",
          gateType: "human-approval",
          phaseRunId: PhaseRunId.makeUnsafe("phase-run-gate"),
          phaseOutput: "Implemented the feature with passing checks.",
          qualityCheckResults: [{ check: "typecheck", passed: true, output: "ok" }],
        },
        resolvedWith: null,
        createdAt: "2026-04-05T15:05:00.000Z",
        resolvedAt: null,
        staleReason: null,
      });

      const byId = yield* repository.queryById({
        requestId: InteractiveRequestId.makeUnsafe("request-approval"),
      });
      assert.deepStrictEqual(Option.getOrNull(byId), {
        requestId: InteractiveRequestId.makeUnsafe("request-approval"),
        threadId: ThreadId.makeUnsafe("thread-foundation"),
        childThreadId: ThreadId.makeUnsafe("thread-child-review"),
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-review"),
        type: "approval",
        status: "pending",
        payload: {
          type: "approval",
          requestType: "command_execution_approval",
          detail: "Run lint before concluding the phase",
          toolName: "Bash",
          toolInput: { cmd: "bun lint" },
          suggestions: ["Bash:bun lint"],
        },
        resolvedWith: null,
        createdAt: "2026-04-05T15:00:00.000Z",
        resolvedAt: null,
        staleReason: null,
      });

      const byThreadId = yield* repository.queryByThreadId({
        threadId: ThreadId.makeUnsafe("thread-foundation"),
      });
      assert.deepStrictEqual(
        byThreadId.map((request) => request.requestId),
        [
          InteractiveRequestId.makeUnsafe("request-approval"),
          InteractiveRequestId.makeUnsafe("request-gate"),
        ],
      );
    }),
  );

  it.effect("updates resolved requests without disturbing unrelated persisted fields", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionInteractiveRequestRepository;

      yield* repository.upsert({
        requestId: InteractiveRequestId.makeUnsafe("request-user-input"),
        threadId: ThreadId.makeUnsafe("thread-resolution"),
        childThreadId: null,
        phaseRunId: null,
        type: "user-input",
        status: "pending",
        payload: {
          type: "user-input",
          questions: [
            {
              id: "target",
              question: "Which target should run?",
              options: ["lint", "typecheck"],
            },
          ],
        },
        resolvedWith: null,
        createdAt: "2026-04-05T16:00:00.000Z",
        resolvedAt: null,
        staleReason: "older stale detail that should persist",
      });

      yield* repository.updateStatus({
        requestId: InteractiveRequestId.makeUnsafe("request-user-input"),
        status: "resolved",
        resolvedWith: {
          answers: {
            target: "typecheck",
          },
        },
        resolvedAt: "2026-04-05T16:01:00.000Z",
      });

      const updated = yield* repository.queryById({
        requestId: InteractiveRequestId.makeUnsafe("request-user-input"),
      });
      assert.deepStrictEqual(Option.getOrNull(updated), {
        requestId: InteractiveRequestId.makeUnsafe("request-user-input"),
        threadId: ThreadId.makeUnsafe("thread-resolution"),
        childThreadId: null,
        phaseRunId: null,
        type: "user-input",
        status: "resolved",
        payload: {
          type: "user-input",
          questions: [
            {
              id: "target",
              question: "Which target should run?",
              options: ["lint", "typecheck"],
            },
          ],
        },
        resolvedWith: {
          answers: {
            target: "typecheck",
          },
        },
        createdAt: "2026-04-05T16:00:00.000Z",
        resolvedAt: "2026-04-05T16:01:00.000Z",
        staleReason: "older stale detail that should persist",
      });
    }),
  );

  it.effect("queries only pending requests and marks requests stale", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionInteractiveRequestRepository;

      yield* repository.upsert({
        requestId: InteractiveRequestId.makeUnsafe("request-bootstrap"),
        threadId: ThreadId.makeUnsafe("thread-pending"),
        childThreadId: null,
        phaseRunId: null,
        type: "bootstrap-failed",
        status: "pending",
        payload: {
          type: "bootstrap-failed",
          error: "Bootstrap script exited with 1",
          stdout: "missing dependency",
          command: "bun install",
        },
        resolvedWith: null,
        createdAt: "2026-04-05T17:00:00.000Z",
        resolvedAt: null,
        staleReason: null,
      });

      yield* repository.upsert({
        requestId: InteractiveRequestId.makeUnsafe("request-correction"),
        threadId: ThreadId.makeUnsafe("thread-pending"),
        childThreadId: ThreadId.makeUnsafe("thread-child-correction"),
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-correction"),
        type: "correction-needed",
        status: "pending",
        payload: {
          type: "correction-needed",
          reason: "Address the review feedback",
          context: "Fix the failing edge case",
        },
        resolvedWith: null,
        createdAt: "2026-04-05T17:01:00.000Z",
        resolvedAt: null,
        staleReason: null,
      });

      yield* repository.upsert({
        requestId: InteractiveRequestId.makeUnsafe("request-resolved"),
        threadId: ThreadId.makeUnsafe("thread-other"),
        childThreadId: null,
        phaseRunId: null,
        type: "approval",
        status: "resolved",
        payload: {
          type: "approval",
          requestType: "file_read_approval",
          detail: "Read the design doc",
          toolName: "Read",
          toolInput: { file_path: "design/15-contracts.md" },
        },
        resolvedWith: {
          decision: "accept",
        },
        createdAt: "2026-04-05T17:02:00.000Z",
        resolvedAt: "2026-04-05T17:03:00.000Z",
        staleReason: null,
      });

      const pendingBeforeStale = yield* repository.queryPending();
      const relevantPendingBeforeStale = pendingBeforeStale.filter(
        (request) =>
          request.requestId === "request-bootstrap" || request.requestId === "request-correction",
      );
      assert.deepStrictEqual(
        relevantPendingBeforeStale.map((request) => request.requestId),
        [
          InteractiveRequestId.makeUnsafe("request-bootstrap"),
          InteractiveRequestId.makeUnsafe("request-correction"),
        ],
      );

      yield* repository.markStale({
        requestId: InteractiveRequestId.makeUnsafe("request-bootstrap"),
        staleReason: "session restarted after crash",
      });

      const staleRequest = yield* repository.queryById({
        requestId: InteractiveRequestId.makeUnsafe("request-bootstrap"),
      });
      assert.deepStrictEqual(Option.getOrNull(staleRequest), {
        requestId: InteractiveRequestId.makeUnsafe("request-bootstrap"),
        threadId: ThreadId.makeUnsafe("thread-pending"),
        childThreadId: null,
        phaseRunId: null,
        type: "bootstrap-failed",
        status: "stale",
        payload: {
          type: "bootstrap-failed",
          error: "Bootstrap script exited with 1",
          stdout: "missing dependency",
          command: "bun install",
        },
        resolvedWith: null,
        createdAt: "2026-04-05T17:00:00.000Z",
        resolvedAt: null,
        staleReason: "session restarted after crash",
      });

      const pendingAfterStale = yield* repository.queryPending();
      const relevantPendingAfterStale = pendingAfterStale.filter(
        (request) =>
          request.requestId === "request-bootstrap" || request.requestId === "request-correction",
      );
      assert.deepStrictEqual(
        relevantPendingAfterStale.map((request) => request.requestId),
        [InteractiveRequestId.makeUnsafe("request-correction")],
      );
    }),
  );
});
