import {
  ChannelId,
  CommandId,
  EventId,
  InteractiveRequestId,
  LinkId,
  PhaseRunId,
  ProjectId,
  ThreadId,
  WorkflowPhaseId,
  type ForgeEvent,
  type OrchestrationReadModel,
} from "@forgetools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

type ProjectedWorkflowReadModel = OrchestrationReadModel & {
  readonly threads: ReadonlyArray<
    OrchestrationReadModel["threads"][number] & {
      readonly phaseRunId: string | null;
      readonly currentPhaseId: string | null;
      readonly bootstrapStatus: string | null;
    }
  >;
  readonly phaseRuns: ReadonlyArray<{
    readonly phaseRunId: string;
    readonly threadId: string;
    readonly phaseId: string;
    readonly phaseName: string;
    readonly phaseType: string;
    readonly iteration: number;
    readonly status: string;
    readonly outputs: ReadonlyArray<{ readonly key: string; readonly content: string }>;
    readonly gateResult: unknown;
    readonly qualityCheckReferences: ReadonlyArray<unknown> | null;
    readonly qualityCheckResults: ReadonlyArray<unknown> | null;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
    readonly failure: string | null;
  }>;
  readonly threadLinks: ReadonlyArray<{
    readonly threadId: string;
    readonly linkId: string;
    readonly linkType: string;
    readonly linkedThreadId: string | null;
  }>;
  readonly threadDependencies: ReadonlyArray<{
    readonly threadId: string;
    readonly dependsOnThreadId: string;
    readonly satisfiedAt: string | null;
  }>;
  readonly corrections: ReadonlyArray<{
    readonly threadId: string;
    readonly deliveredAt: string | null;
  }>;
  readonly synthesis: ReadonlyArray<{
    readonly threadId: string;
    readonly completedAt: string;
  }>;
};

function makeEvent(input: {
  sequence: number;
  type: ForgeEvent["type"];
  occurredAt: string;
  aggregateKind: ForgeEvent["aggregateKind"];
  aggregateId: string;
  commandId: string | null;
  payload: unknown;
}): ForgeEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.makeUnsafe(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: input.aggregateKind,
    aggregateId:
      input.aggregateKind === "project"
        ? ProjectId.makeUnsafe(input.aggregateId)
        : input.aggregateKind === "channel"
          ? ChannelId.makeUnsafe(input.aggregateId)
          : input.aggregateKind === "request"
            ? InteractiveRequestId.makeUnsafe(input.aggregateId)
            : ThreadId.makeUnsafe(input.aggregateId),
    occurredAt: input.occurredAt,
    commandId: input.commandId === null ? null : CommandId.makeUnsafe(input.commandId),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as ForgeEvent;
}

describe("orchestration projector", () => {
  it("applies thread.created events", async () => {
    const now = new Date().toISOString();
    const model = createEmptyReadModel(now);

    const next = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "cmd-thread-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );

    expect(next.snapshotSequence).toBe(1);
    expect(next.threads).toEqual([
      {
        id: "thread-1",
        projectId: "project-1",
        title: "demo",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
        parentThreadId: null,
        phaseRunId: null,
        workflowId: null,
        currentPhaseId: null,
        patternId: null,
        role: null,
        childThreadIds: [],
        bootstrapStatus: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ]);
  });

  it("fails when event payload cannot be decoded by runtime schema", async () => {
    const now = new Date().toISOString();
    const model = createEmptyReadModel(now);

    await expect(
      Effect.runPromise(
        projectEvent(
          model,
          makeEvent({
            sequence: 1,
            type: "thread.created",
            aggregateKind: "thread",
            aggregateId: "thread-1",
            occurredAt: now,
            commandId: "cmd-invalid",
            payload: {
              // missing required threadId
              projectId: "project-1",
              title: "demo",
              modelSelection: {
                provider: "codex",
                model: "gpt-5-codex",
              },
              branch: null,
              worktreePath: null,
              createdAt: now,
              updatedAt: now,
            },
          }),
        ),
      ),
    ).rejects.toBeDefined();
  });

  it("accepts staged thread.created payloads without failing legacy projection replay", async () => {
    const now = new Date().toISOString();
    const model = createEmptyReadModel(now);

    const next = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-staged-1",
          occurredAt: now,
          commandId: "cmd-thread-create-staged",
          payload: {
            threadId: "thread-staged-1",
            projectId: "project-1",
            parentThreadId: null,
            phaseRunId: null,
            sessionType: "workflow",
            title: "staged workflow session",
            description: "future forge session payload",
            workflowId: null,
            patternId: null,
            runtimeMode: "full-access",
            model: null,
            provider: null,
            role: null,
            branch: null,
            bootstrapStatus: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );

    expect(next.snapshotSequence).toBe(1);
    expect(next.updatedAt).toBe(now);
    expect(next.threads).toEqual([]);
  });

  it("applies thread.archived and thread.unarchived events", async () => {
    const now = new Date().toISOString();
    const later = new Date(Date.parse(now) + 1_000).toISOString();
    const created = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(now),
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "cmd-thread-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );

    const archived = await Effect.runPromise(
      projectEvent(
        created,
        makeEvent({
          sequence: 2,
          type: "thread.archived",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: later,
          commandId: "cmd-thread-archive",
          payload: {
            threadId: "thread-1",
            archivedAt: later,
            updatedAt: later,
          },
        }),
      ),
    );
    expect(archived.threads[0]?.archivedAt).toBe(later);

    const unarchived = await Effect.runPromise(
      projectEvent(
        archived,
        makeEvent({
          sequence: 3,
          type: "thread.unarchived",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: later,
          commandId: "cmd-thread-unarchive",
          payload: {
            threadId: "thread-1",
            updatedAt: later,
          },
        }),
      ),
    );
    expect(unarchived.threads[0]?.archivedAt).toBeNull();
  });

  it("applies staged thread turn lifecycle events", async () => {
    const createdAt = "2026-04-05T17:00:00.000Z";
    const startedAt = "2026-04-05T17:00:05.000Z";
    const completedAt = "2026-04-05T17:00:10.000Z";

    const created = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(createdAt),
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-turn-stage",
          occurredAt: createdAt,
          commandId: "cmd-thread-turn-stage-create",
          payload: {
            threadId: "thread-turn-stage",
            projectId: "project-turn-stage",
            title: "turn stage",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const started = await Effect.runPromise(
      projectEvent(
        created,
        makeEvent({
          sequence: 2,
          type: "thread.turn-started",
          aggregateKind: "thread",
          aggregateId: "thread-turn-stage",
          occurredAt: startedAt,
          commandId: "cmd-thread-turn-stage-started",
          payload: {
            threadId: "thread-turn-stage",
            turnId: "turn-stage-1",
            startedAt,
          },
        }),
      ),
    );

    expect(started.threads[0]?.latestTurn).toEqual({
      turnId: "turn-stage-1",
      state: "running",
      requestedAt: startedAt,
      startedAt,
      completedAt: null,
      assistantMessageId: null,
    });

    const completed = await Effect.runPromise(
      projectEvent(
        started,
        makeEvent({
          sequence: 3,
          type: "thread.turn-completed",
          aggregateKind: "thread",
          aggregateId: "thread-turn-stage",
          occurredAt: completedAt,
          commandId: "cmd-thread-turn-stage-completed",
          payload: {
            threadId: "thread-turn-stage",
            turnId: "turn-stage-1",
            completedAt,
          },
        }),
      ),
    );

    expect(completed.threads[0]?.latestTurn).toEqual({
      turnId: "turn-stage-1",
      state: "completed",
      requestedAt: startedAt,
      startedAt,
      completedAt,
      assistantMessageId: null,
    });
    expect(completed.threads[0]?.updatedAt).toBe(completedAt);
  });

  it("applies staged checkpoint capture and revert events", async () => {
    const createdAt = "2026-04-05T17:10:00.000Z";
    const startedAt = "2026-04-05T17:10:05.000Z";
    const messageAt = "2026-04-05T17:10:06.000Z";
    const capturedAt = "2026-04-05T17:10:08.000Z";
    const revertedAt = "2026-04-05T17:10:09.000Z";

    const created = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(createdAt),
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-checkpoint-stage",
          occurredAt: createdAt,
          commandId: "cmd-thread-checkpoint-stage-create",
          payload: {
            threadId: "thread-checkpoint-stage",
            projectId: "project-checkpoint-stage",
            title: "checkpoint stage",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const started = await Effect.runPromise(
      projectEvent(
        created,
        makeEvent({
          sequence: 2,
          type: "thread.turn-started",
          aggregateKind: "thread",
          aggregateId: "thread-checkpoint-stage",
          occurredAt: startedAt,
          commandId: "cmd-thread-checkpoint-stage-started",
          payload: {
            threadId: "thread-checkpoint-stage",
            turnId: "turn-checkpoint-stage-1",
            startedAt,
          },
        }),
      ),
    );

    const withMessage = await Effect.runPromise(
      projectEvent(
        started,
        makeEvent({
          sequence: 3,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-checkpoint-stage",
          occurredAt: messageAt,
          commandId: "cmd-thread-checkpoint-stage-message",
          payload: {
            threadId: "thread-checkpoint-stage",
            messageId: "message-checkpoint-stage-1",
            role: "assistant",
            text: "checkpoint output",
            turnId: "turn-checkpoint-stage-1",
            streaming: false,
            createdAt: messageAt,
            updatedAt: messageAt,
          },
        }),
      ),
    );

    const captured = await Effect.runPromise(
      projectEvent(
        withMessage,
        makeEvent({
          sequence: 4,
          type: "thread.checkpoint-captured",
          aggregateKind: "thread",
          aggregateId: "thread-checkpoint-stage",
          occurredAt: capturedAt,
          commandId: "cmd-thread-checkpoint-stage-captured",
          payload: {
            threadId: "thread-checkpoint-stage",
            turnId: "turn-checkpoint-stage-1",
            turnCount: 1,
            ref: "refs/t3/checkpoints/thread-checkpoint-stage/turn/1",
            capturedAt,
          },
        }),
      ),
    );

    expect(captured.threads[0]?.checkpoints).toEqual([
      {
        turnId: "turn-checkpoint-stage-1",
        checkpointTurnCount: 1,
        checkpointRef: "refs/t3/checkpoints/thread-checkpoint-stage/turn/1",
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: capturedAt,
      },
    ]);

    const reverted = await Effect.runPromise(
      projectEvent(
        captured,
        makeEvent({
          sequence: 5,
          type: "thread.checkpoint-reverted",
          aggregateKind: "thread",
          aggregateId: "thread-checkpoint-stage",
          occurredAt: revertedAt,
          commandId: "cmd-thread-checkpoint-stage-reverted",
          payload: {
            threadId: "thread-checkpoint-stage",
            turnCount: 0,
            revertedAt,
          },
        }),
      ),
    );

    expect(reverted.threads[0]?.checkpoints).toEqual([]);
    expect(reverted.threads[0]?.messages).toEqual([]);
    expect(reverted.threads[0]?.latestTurn).toBeNull();
    expect(reverted.threads[0]?.updatedAt).toBe(revertedAt);
  });

  it("accepts staged thread.archived payloads without updatedAt", async () => {
    const now = new Date().toISOString();
    const later = new Date(Date.parse(now) + 1_000).toISOString();
    const created = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(now),
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "cmd-thread-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );

    const archived = await Effect.runPromise(
      projectEvent(
        created,
        makeEvent({
          sequence: 2,
          type: "thread.archived",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: later,
          commandId: "cmd-thread-archive",
          payload: {
            threadId: "thread-1",
            archivedAt: later,
          },
        }),
      ),
    );

    expect(archived.threads[0]).toMatchObject({
      id: "thread-1",
      archivedAt: later,
      updatedAt: later,
    });
  });

  it("keeps projector forward-compatible for unhandled event types", async () => {
    const now = new Date().toISOString();
    const model = createEmptyReadModel(now);

    const next = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 7,
          type: "thread.turn-start-requested",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: "2026-01-01T00:00:00.000Z",
          commandId: "cmd-unhandled",
          payload: {
            threadId: "thread-1",
            messageId: "message-1",
            runtimeMode: "approval-required",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      ),
    );

    expect(next.snapshotSequence).toBe(7);
    expect(next.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(next.threads).toEqual([]);
  });

  it("tracks latest turn id from session lifecycle events", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const startedAt = "2026-02-23T08:00:05.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterRunning = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: startedAt,
          commandId: "cmd-running",
          payload: {
            threadId: "thread-1",
            session: {
              threadId: "thread-1",
              status: "running",
              providerName: "codex",
              providerSessionId: "session-1",
              providerThreadId: "provider-thread-1",
              runtimeMode: "approval-required",
              activeTurnId: "turn-1",
              lastError: null,
              updatedAt: startedAt,
            },
          },
        }),
      ),
    );

    const thread = afterRunning.threads[0];
    expect(thread?.latestTurn?.turnId).toBe("turn-1");
    expect(thread?.session?.status).toBe("running");
  });

  it("updates canonical thread runtime mode from thread.runtime-mode-set", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const updatedAt = "2026-02-23T08:00:05.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterUpdate = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.runtime-mode-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: updatedAt,
          commandId: "cmd-runtime-mode-set",
          payload: {
            threadId: "thread-1",
            runtimeMode: "approval-required",
            updatedAt,
          },
        }),
      ),
    );

    expect(afterUpdate.threads[0]?.runtimeMode).toBe("approval-required");
    expect(afterUpdate.threads[0]?.updatedAt).toBe(updatedAt);
  });

  it("marks assistant messages completed with non-streaming updates", async () => {
    const createdAt = "2026-02-23T09:00:00.000Z";
    const deltaAt = "2026-02-23T09:00:01.000Z";
    const completeAt = "2026-02-23T09:00:03.500Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterDelta = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: deltaAt,
          commandId: "cmd-delta",
          payload: {
            threadId: "thread-1",
            messageId: "assistant:msg-1",
            role: "assistant",
            text: "hello",
            turnId: "turn-1",
            streaming: true,
            createdAt: deltaAt,
            updatedAt: deltaAt,
          },
        }),
      ),
    );

    const afterComplete = await Effect.runPromise(
      projectEvent(
        afterDelta,
        makeEvent({
          sequence: 3,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: completeAt,
          commandId: "cmd-complete",
          payload: {
            threadId: "thread-1",
            messageId: "assistant:msg-1",
            role: "assistant",
            text: "",
            turnId: "turn-1",
            streaming: false,
            createdAt: completeAt,
            updatedAt: completeAt,
          },
        }),
      ),
    );

    const message = afterComplete.threads[0]?.messages[0];
    expect(message?.id).toBe("assistant:msg-1");
    expect(message?.text).toBe("hello");
    expect(message?.streaming).toBe(false);
    expect(message?.updatedAt).toBe(completeAt);
  });

  it("prunes reverted turn messages from in-memory thread snapshot", async () => {
    const createdAt = "2026-02-23T10:00:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const events: ReadonlyArray<ForgeEvent> = [
      makeEvent({
        sequence: 2,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:01.000Z",
        commandId: "cmd-user-1",
        payload: {
          threadId: "thread-1",
          messageId: "user-msg-1",
          role: "user",
          text: "First edit",
          turnId: null,
          streaming: false,
          createdAt: "2026-02-23T10:00:01.000Z",
          updatedAt: "2026-02-23T10:00:01.000Z",
        },
      }),
      makeEvent({
        sequence: 3,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:02.000Z",
        commandId: "cmd-assistant-1",
        payload: {
          threadId: "thread-1",
          messageId: "assistant-msg-1",
          role: "assistant",
          text: "Updated README to v2.\n",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-02-23T10:00:02.000Z",
          updatedAt: "2026-02-23T10:00:02.000Z",
        },
      }),
      makeEvent({
        sequence: 4,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:02.500Z",
        commandId: "cmd-turn-1-complete",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          checkpointTurnCount: 1,
          checkpointRef: "refs/t3/checkpoints/thread-1/turn/1",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-msg-1",
          completedAt: "2026-02-23T10:00:02.500Z",
        },
      }),
      makeEvent({
        sequence: 5,
        type: "thread.activity-appended",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:02.750Z",
        commandId: "cmd-activity-1",
        payload: {
          threadId: "thread-1",
          activity: {
            id: "activity-1",
            tone: "tool",
            kind: "tool.started",
            summary: "Edit file started",
            payload: { toolKind: "command" },
            turnId: "turn-1",
            createdAt: "2026-02-23T10:00:02.750Z",
          },
        },
      }),
      makeEvent({
        sequence: 6,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:03.000Z",
        commandId: "cmd-user-2",
        payload: {
          threadId: "thread-1",
          messageId: "user-msg-2",
          role: "user",
          text: "Second edit",
          turnId: null,
          streaming: false,
          createdAt: "2026-02-23T10:00:03.000Z",
          updatedAt: "2026-02-23T10:00:03.000Z",
        },
      }),
      makeEvent({
        sequence: 7,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:04.000Z",
        commandId: "cmd-assistant-2",
        payload: {
          threadId: "thread-1",
          messageId: "assistant-msg-2",
          role: "assistant",
          text: "Updated README to v3.\n",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-02-23T10:00:04.000Z",
          updatedAt: "2026-02-23T10:00:04.000Z",
        },
      }),
      makeEvent({
        sequence: 8,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:04.500Z",
        commandId: "cmd-turn-2-complete",
        payload: {
          threadId: "thread-1",
          turnId: "turn-2",
          checkpointTurnCount: 2,
          checkpointRef: "refs/t3/checkpoints/thread-1/turn/2",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-msg-2",
          completedAt: "2026-02-23T10:00:04.500Z",
        },
      }),
      makeEvent({
        sequence: 9,
        type: "thread.activity-appended",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:04.750Z",
        commandId: "cmd-activity-2",
        payload: {
          threadId: "thread-1",
          activity: {
            id: "activity-2",
            tone: "tool",
            kind: "tool.completed",
            summary: "Edit file complete",
            payload: { toolKind: "command" },
            turnId: "turn-2",
            createdAt: "2026-02-23T10:00:04.750Z",
          },
        },
      }),
      makeEvent({
        sequence: 10,
        type: "thread.reverted",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:05.000Z",
        commandId: "cmd-revert",
        payload: {
          threadId: "thread-1",
          turnCount: 1,
        },
      }),
    ];

    const afterRevert = await events.reduce<Promise<ReturnType<typeof createEmptyReadModel>>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterCreate),
    );

    const thread = afterRevert.threads[0];
    expect(thread?.messages.map((message) => ({ role: message.role, text: message.text }))).toEqual(
      [
        { role: "user", text: "First edit" },
        { role: "assistant", text: "Updated README to v2.\n" },
      ],
    );
    expect(
      thread?.activities.map((activity) => ({ id: activity.id, turnId: activity.turnId })),
    ).toEqual([{ id: "activity-1", turnId: "turn-1" }]);
    expect(thread?.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount)).toEqual([1]);
    expect(thread?.latestTurn?.turnId).toBe("turn-1");
  });

  it("does not fallback-retain messages tied to removed turn IDs", async () => {
    const createdAt = "2026-02-26T12:00:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-revert",
          occurredAt: createdAt,
          commandId: "cmd-create-revert",
          payload: {
            threadId: "thread-revert",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const events: ReadonlyArray<ForgeEvent> = [
      makeEvent({
        sequence: 2,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:01.000Z",
        commandId: "cmd-turn-1",
        payload: {
          threadId: "thread-revert",
          turnId: "turn-1",
          checkpointTurnCount: 1,
          checkpointRef: "refs/t3/checkpoints/thread-revert/turn/1",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-keep",
          completedAt: "2026-02-26T12:00:01.000Z",
        },
      }),
      makeEvent({
        sequence: 3,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:01.100Z",
        commandId: "cmd-assistant-keep",
        payload: {
          threadId: "thread-revert",
          messageId: "assistant-keep",
          role: "assistant",
          text: "kept",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-02-26T12:00:01.100Z",
          updatedAt: "2026-02-26T12:00:01.100Z",
        },
      }),
      makeEvent({
        sequence: 4,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:02.000Z",
        commandId: "cmd-turn-2",
        payload: {
          threadId: "thread-revert",
          turnId: "turn-2",
          checkpointTurnCount: 2,
          checkpointRef: "refs/t3/checkpoints/thread-revert/turn/2",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-remove",
          completedAt: "2026-02-26T12:00:02.000Z",
        },
      }),
      makeEvent({
        sequence: 5,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:02.050Z",
        commandId: "cmd-user-remove",
        payload: {
          threadId: "thread-revert",
          messageId: "user-remove",
          role: "user",
          text: "removed",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-02-26T12:00:02.050Z",
          updatedAt: "2026-02-26T12:00:02.050Z",
        },
      }),
      makeEvent({
        sequence: 6,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:02.100Z",
        commandId: "cmd-assistant-remove",
        payload: {
          threadId: "thread-revert",
          messageId: "assistant-remove",
          role: "assistant",
          text: "removed",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-02-26T12:00:02.100Z",
          updatedAt: "2026-02-26T12:00:02.100Z",
        },
      }),
      makeEvent({
        sequence: 7,
        type: "thread.reverted",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:03.000Z",
        commandId: "cmd-revert",
        payload: {
          threadId: "thread-revert",
          turnCount: 1,
        },
      }),
    ];

    const afterRevert = await events.reduce<Promise<ReturnType<typeof createEmptyReadModel>>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterCreate),
    );

    const thread = afterRevert.threads[0];
    expect(
      thread?.messages.map((message) => ({
        id: message.id,
        role: message.role,
        turnId: message.turnId,
      })),
    ).toEqual([{ id: "assistant-keep", role: "assistant", turnId: "turn-1" }]);
  });

  it("caps message and checkpoint retention for long-lived threads", async () => {
    const createdAt = "2026-03-01T10:00:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-capped",
          occurredAt: createdAt,
          commandId: "cmd-create-capped",
          payload: {
            threadId: "thread-capped",
            projectId: "project-1",
            title: "capped",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const messageEvents: ReadonlyArray<ForgeEvent> = Array.from({ length: 2_100 }, (_, index) =>
      makeEvent({
        sequence: index + 2,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-capped",
        occurredAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
        commandId: `cmd-message-${index}`,
        payload: {
          threadId: "thread-capped",
          messageId: `msg-${index}`,
          role: "assistant",
          text: `message-${index}`,
          turnId: `turn-${index}`,
          streaming: false,
          createdAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
          updatedAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
        },
      }),
    );
    const afterMessages = await messageEvents.reduce<
      Promise<ReturnType<typeof createEmptyReadModel>>
    >(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterCreate),
    );

    const checkpointEvents: ReadonlyArray<ForgeEvent> = Array.from({ length: 600 }, (_, index) =>
      makeEvent({
        sequence: index + 2_102,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-capped",
        occurredAt: `2026-03-01T10:30:${String(index % 60).padStart(2, "0")}.000Z`,
        commandId: `cmd-checkpoint-${index}`,
        payload: {
          threadId: "thread-capped",
          turnId: `turn-${index}`,
          checkpointTurnCount: index + 1,
          checkpointRef: `refs/t3/checkpoints/thread-capped/turn/${index + 1}`,
          status: "ready",
          files: [],
          assistantMessageId: `msg-${index}`,
          completedAt: `2026-03-01T10:30:${String(index % 60).padStart(2, "0")}.000Z`,
        },
      }),
    );
    const finalState = await checkpointEvents.reduce<
      Promise<ReturnType<typeof createEmptyReadModel>>
    >(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterMessages),
    );

    const thread = finalState.threads[0];
    expect(thread?.messages).toHaveLength(2_000);
    expect(thread?.messages[0]?.id).toBe("msg-100");
    expect(thread?.messages.at(-1)?.id).toBe("msg-2099");
    expect(thread?.checkpoints).toHaveLength(500);
    expect(thread?.checkpoints[0]?.turnId).toBe("turn-100");
    expect(thread?.checkpoints.at(-1)?.turnId).toBe("turn-599");
  });

  it("projects workflow phase lifecycle, quality checks, bootstrap, corrections, and synthesis", async () => {
    const createdAt = "2026-04-05T12:00:00.000Z";
    const phaseStartedAt = "2026-04-05T12:01:00.000Z";
    const qualityStartedAt = "2026-04-05T12:02:00.000Z";
    const qualityCompletedAt = "2026-04-05T12:03:00.000Z";
    const phaseCompletedAt = "2026-04-05T12:04:00.000Z";
    const bootstrapStartedAt = "2026-04-05T12:05:00.000Z";
    const bootstrapCompletedAt = "2026-04-05T12:06:00.000Z";
    const correctionQueuedAt = "2026-04-05T12:07:00.000Z";
    const correctionDeliveredAt = "2026-04-05T12:08:00.000Z";
    const synthesisCompletedAt = "2026-04-05T12:09:00.000Z";

    const events: ReadonlyArray<ForgeEvent> = [
      makeEvent({
        sequence: 1,
        type: "thread.created",
        aggregateKind: "thread",
        aggregateId: "thread-workflow",
        occurredAt: createdAt,
        commandId: "cmd-create-workflow-thread",
        payload: {
          threadId: "thread-workflow",
          projectId: "project-1",
          title: "Workflow thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      }),
      makeEvent({
        sequence: 2,
        type: "thread.phase-started",
        aggregateKind: "thread",
        aggregateId: "thread-workflow",
        occurredAt: phaseStartedAt,
        commandId: "cmd-phase-start",
        payload: {
          threadId: "thread-workflow",
          phaseRunId: "phase-run-1",
          phaseId: "phase-plan",
          phaseName: "Plan",
          phaseType: "single-agent",
          iteration: 1,
          startedAt: phaseStartedAt,
        },
      }),
      makeEvent({
        sequence: 3,
        type: "thread.quality-check-started",
        aggregateKind: "thread",
        aggregateId: "thread-workflow",
        occurredAt: qualityStartedAt,
        commandId: "cmd-quality-start",
        payload: {
          threadId: "thread-workflow",
          phaseRunId: "phase-run-1",
          checks: [{ check: "lint", required: true }],
          startedAt: qualityStartedAt,
        },
      }),
      makeEvent({
        sequence: 4,
        type: "thread.quality-check-completed",
        aggregateKind: "thread",
        aggregateId: "thread-workflow",
        occurredAt: qualityCompletedAt,
        commandId: "cmd-quality-complete",
        payload: {
          threadId: "thread-workflow",
          phaseRunId: "phase-run-1",
          results: [{ check: "lint", passed: true, output: "ok" }],
          completedAt: qualityCompletedAt,
        },
      }),
      makeEvent({
        sequence: 5,
        type: "thread.phase-completed",
        aggregateKind: "thread",
        aggregateId: "thread-workflow",
        occurredAt: phaseCompletedAt,
        commandId: "cmd-phase-complete",
        payload: {
          threadId: "thread-workflow",
          phaseRunId: "phase-run-1",
          outputs: [{ key: "output", content: "phase complete", sourceType: "agent" }],
          gateResult: {
            status: "passed",
            qualityCheckResults: [{ check: "lint", passed: true, output: "ok" }],
            evaluatedAt: phaseCompletedAt,
          },
          completedAt: phaseCompletedAt,
        },
      }),
      makeEvent({
        sequence: 6,
        type: "thread.bootstrap-started",
        aggregateKind: "thread",
        aggregateId: "thread-workflow",
        occurredAt: bootstrapStartedAt,
        commandId: "cmd-bootstrap-start",
        payload: {
          threadId: "thread-workflow",
          startedAt: bootstrapStartedAt,
        },
      }),
      makeEvent({
        sequence: 7,
        type: "thread.bootstrap-completed",
        aggregateKind: "thread",
        aggregateId: "thread-workflow",
        occurredAt: bootstrapCompletedAt,
        commandId: "cmd-bootstrap-complete",
        payload: {
          threadId: "thread-workflow",
          completedAt: bootstrapCompletedAt,
        },
      }),
      makeEvent({
        sequence: 8,
        type: "thread.correction-queued",
        aggregateKind: "thread",
        aggregateId: "thread-workflow",
        occurredAt: correctionQueuedAt,
        commandId: "cmd-correction-queued",
        payload: {
          threadId: "thread-workflow",
          content: "Tighten the plan.",
          channelId: "channel-guidance-1",
          messageId: "channel-message-1",
          createdAt: correctionQueuedAt,
        },
      }),
      makeEvent({
        sequence: 9,
        type: "thread.correction-delivered",
        aggregateKind: "thread",
        aggregateId: "thread-workflow",
        occurredAt: correctionDeliveredAt,
        commandId: "cmd-correction-delivered",
        payload: {
          threadId: "thread-workflow",
          deliveredAt: correctionDeliveredAt,
        },
      }),
      makeEvent({
        sequence: 10,
        type: "thread.synthesis-completed",
        aggregateKind: "thread",
        aggregateId: "thread-workflow",
        occurredAt: synthesisCompletedAt,
        commandId: "cmd-synthesis-complete",
        payload: {
          threadId: "thread-workflow",
          content: "Final synthesis",
          generatedByThreadId: "thread-workflow",
          completedAt: synthesisCompletedAt,
        },
      }),
    ];

    const finalState = (await events.reduce<Promise<OrchestrationReadModel>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(createEmptyReadModel(createdAt)),
    )) as ProjectedWorkflowReadModel;

    const thread = finalState.threads[0];
    const phaseRun = finalState.phaseRuns[0];
    const guidanceChannel = finalState.channels[0];
    const correction = finalState.corrections[0];
    const synthesis = finalState.synthesis[0];

    expect(thread?.phaseRunId).toBeNull();
    expect(thread?.currentPhaseId).toBeNull();
    expect(thread?.bootstrapStatus).toBe("completed");
    expect(phaseRun).toEqual({
      phaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
      threadId: ThreadId.makeUnsafe("thread-workflow"),
      phaseId: WorkflowPhaseId.makeUnsafe("phase-plan"),
      phaseName: "Plan",
      phaseType: "single-agent",
      iteration: 1,
      status: "completed",
      outputs: [{ key: "output", content: "phase complete", sourceType: "agent" }],
      gateResult: {
        status: "passed",
        qualityCheckResults: [{ check: "lint", passed: true, output: "ok" }],
        evaluatedAt: phaseCompletedAt,
      },
      qualityCheckReferences: [{ check: "lint", required: true }],
      qualityCheckResults: [{ check: "lint", passed: true, output: "ok" }],
      startedAt: phaseStartedAt,
      completedAt: phaseCompletedAt,
      failure: null,
    });
    expect(correction).toEqual(
      expect.objectContaining({
        threadId: ThreadId.makeUnsafe("thread-workflow"),
        deliveredAt: correctionDeliveredAt,
      }),
    );
    expect(guidanceChannel).toEqual({
      id: ChannelId.makeUnsafe("channel-guidance-1"),
      threadId: ThreadId.makeUnsafe("thread-workflow"),
      type: "guidance",
      status: "open",
      createdAt: correctionQueuedAt,
      updatedAt: correctionQueuedAt,
    });
    expect(synthesis).toEqual(
      expect.objectContaining({
        threadId: ThreadId.makeUnsafe("thread-workflow"),
        completedAt: synthesisCompletedAt,
      }),
    );
  });

  it("projects queued bootstrap status before bootstrap starts", async () => {
    const createdAt = "2026-04-05T12:30:00.000Z";
    const queuedAt = "2026-04-05T12:31:00.000Z";

    const created = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(createdAt),
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-bootstrap",
          occurredAt: createdAt,
          commandId: "cmd-create-bootstrap",
          payload: {
            threadId: "thread-bootstrap",
            projectId: "project-1",
            title: "Bootstrap thread",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const queued = await Effect.runPromise(
      projectEvent(
        created,
        makeEvent({
          sequence: 2,
          type: "thread.bootstrap-queued",
          aggregateKind: "thread",
          aggregateId: "thread-bootstrap",
          occurredAt: queuedAt,
          commandId: "cmd-bootstrap-queued",
          payload: {
            threadId: "thread-bootstrap",
            queuedAt,
          },
        }),
      ),
    );

    expect(queued.threads[0]?.bootstrapStatus).toBe("queued");
    expect(queued.threads[0]?.updatedAt).toBe(queuedAt);
  });

  it("reuses an existing guidance channel when projecting queued corrections", async () => {
    const createdAt = "2026-04-05T12:40:00.000Z";
    const channelCreatedAt = "2026-04-05T12:41:00.000Z";
    const correctionQueuedAt = "2026-04-05T12:42:00.000Z";

    const events: ReadonlyArray<ForgeEvent> = [
      makeEvent({
        sequence: 1,
        type: "project.created",
        aggregateKind: "project",
        aggregateId: "project-guidance",
        occurredAt: createdAt,
        commandId: "cmd-guidance-project",
        payload: {
          projectId: "project-guidance",
          title: "Guidance project",
          workspaceRoot: "/tmp/project-guidance",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      }),
      makeEvent({
        sequence: 2,
        type: "thread.created",
        aggregateKind: "thread",
        aggregateId: "thread-guidance",
        occurredAt: createdAt,
        commandId: "cmd-guidance-thread",
        payload: {
          threadId: "thread-guidance",
          projectId: "project-guidance",
          title: "Guidance thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      }),
      makeEvent({
        sequence: 3,
        type: "channel.created",
        aggregateKind: "channel",
        aggregateId: "channel-guidance-existing",
        occurredAt: channelCreatedAt,
        commandId: "cmd-guidance-channel",
        payload: {
          channelId: "channel-guidance-existing",
          threadId: "thread-guidance",
          phaseRunId: null,
          channelType: "guidance",
          createdAt: channelCreatedAt,
        },
      }),
      makeEvent({
        sequence: 4,
        type: "thread.correction-queued",
        aggregateKind: "thread",
        aggregateId: "thread-guidance",
        occurredAt: correctionQueuedAt,
        commandId: "cmd-guidance-correction",
        payload: {
          threadId: "thread-guidance",
          content: "Add the retry branch.",
          channelId: "channel-guidance-existing",
          messageId: "channel-message-guidance-1",
          createdAt: correctionQueuedAt,
        },
      }),
    ];

    const finalState = await events.reduce<Promise<OrchestrationReadModel>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(createEmptyReadModel(createdAt)),
    );

    expect(finalState.channels).toEqual([
      {
        id: ChannelId.makeUnsafe("channel-guidance-existing"),
        threadId: ThreadId.makeUnsafe("thread-guidance"),
        type: "guidance",
        status: "open",
        createdAt: channelCreatedAt,
        updatedAt: correctionQueuedAt,
      },
    ]);
  });

  it("projects workflow link, promotion, and dependency state", async () => {
    const createdAt = "2026-04-05T13:00:00.000Z";
    const linkCreatedAt = "2026-04-05T13:01:00.000Z";
    const promotedAt = "2026-04-05T13:02:00.000Z";
    const dependencyCreatedAt = "2026-04-05T13:03:00.000Z";
    const dependenciesSatisfiedAt = "2026-04-05T13:04:00.000Z";
    const dependencyRemovedAt = "2026-04-05T13:05:00.000Z";
    const linkRemovedAt = "2026-04-05T13:06:00.000Z";

    const events: ReadonlyArray<ForgeEvent> = [
      makeEvent({
        sequence: 1,
        type: "thread.created",
        aggregateKind: "thread",
        aggregateId: "thread-source",
        occurredAt: createdAt,
        commandId: "cmd-create-source",
        payload: {
          threadId: "thread-source",
          projectId: "project-1",
          title: "Source",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      }),
      makeEvent({
        sequence: 2,
        type: "thread.created",
        aggregateKind: "thread",
        aggregateId: "thread-target",
        occurredAt: createdAt,
        commandId: "cmd-create-target",
        payload: {
          threadId: "thread-target",
          projectId: "project-1",
          title: "Target",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      }),
      makeEvent({
        sequence: 3,
        type: "thread.link-added",
        aggregateKind: "thread",
        aggregateId: "thread-source",
        occurredAt: linkCreatedAt,
        commandId: "cmd-link-add",
        payload: {
          threadId: "thread-source",
          linkId: "link-related-1",
          linkType: "related",
          linkedThreadId: "thread-target",
          externalId: null,
          externalUrl: null,
          createdAt: linkCreatedAt,
        },
      }),
      makeEvent({
        sequence: 4,
        type: "thread.promoted",
        aggregateKind: "thread",
        aggregateId: "thread-source",
        occurredAt: promotedAt,
        commandId: "cmd-promote",
        payload: {
          sourceThreadId: "thread-source",
          targetThreadId: "thread-target",
          promotedAt,
        },
      }),
      makeEvent({
        sequence: 5,
        type: "thread.dependency-added",
        aggregateKind: "thread",
        aggregateId: "thread-target",
        occurredAt: dependencyCreatedAt,
        commandId: "cmd-dependency-add",
        payload: {
          threadId: "thread-target",
          dependsOnThreadId: "thread-source",
          createdAt: dependencyCreatedAt,
        },
      }),
      makeEvent({
        sequence: 6,
        type: "thread.dependencies-satisfied",
        aggregateKind: "thread",
        aggregateId: "thread-target",
        occurredAt: dependenciesSatisfiedAt,
        commandId: "cmd-dependency-satisfied",
        payload: {
          threadId: "thread-target",
          satisfiedAt: dependenciesSatisfiedAt,
        },
      }),
      makeEvent({
        sequence: 7,
        type: "thread.dependency-removed",
        aggregateKind: "thread",
        aggregateId: "thread-target",
        occurredAt: dependencyRemovedAt,
        commandId: "cmd-dependency-remove",
        payload: {
          threadId: "thread-target",
          dependsOnThreadId: "thread-source",
          removedAt: dependencyRemovedAt,
        },
      }),
      makeEvent({
        sequence: 8,
        type: "thread.link-removed",
        aggregateKind: "thread",
        aggregateId: "thread-source",
        occurredAt: linkRemovedAt,
        commandId: "cmd-link-remove",
        payload: {
          threadId: "thread-source",
          linkId: "link-related-1",
          removedAt: linkRemovedAt,
        },
      }),
    ];

    const finalState = (await events.reduce<Promise<OrchestrationReadModel>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(createEmptyReadModel(createdAt)),
    )) as ProjectedWorkflowReadModel;

    expect(finalState.threadLinks).toEqual([]);
    expect(finalState.threadDependencies).toEqual([]);

    const promotedThread = finalState.threads.find((thread) => thread.id === "thread-source");
    const promotedChild = finalState.threads.find((thread) => thread.id === "thread-target");
    expect(promotedThread?.childThreadIds).toEqual([ThreadId.makeUnsafe("thread-target")]);
    expect(promotedThread?.updatedAt).toBe(linkRemovedAt);
    expect(promotedChild?.parentThreadId).toBe(ThreadId.makeUnsafe("thread-source"));

    const intermediateState = (await events
      .slice(0, 6)
      .reduce<Promise<OrchestrationReadModel>>(
        (statePromise, event) =>
          statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
        Promise.resolve(createEmptyReadModel(createdAt)),
      )) as ProjectedWorkflowReadModel;

    expect(intermediateState.threadLinks).toEqual([
      expect.objectContaining({
        threadId: ThreadId.makeUnsafe("thread-source"),
        linkId: LinkId.makeUnsafe("link-related-1"),
        linkType: "related",
        linkedThreadId: ThreadId.makeUnsafe("thread-target"),
      }),
    ]);
    expect(intermediateState.threadDependencies).toEqual([
      expect.objectContaining({
        threadId: ThreadId.makeUnsafe("thread-target"),
        dependsOnThreadId: ThreadId.makeUnsafe("thread-source"),
        satisfiedAt: dependenciesSatisfiedAt,
      }),
    ]);
  });

  it("projects channel and request events into the additive read model", async () => {
    const createdAt = "2026-04-05T14:00:00.000Z";
    const channelCreatedAt = "2026-04-05T14:01:00.000Z";
    const messagePostedAt = "2026-04-05T14:02:00.000Z";
    const conclusionProposedAt = "2026-04-05T14:03:00.000Z";
    const channelConcludedAt = "2026-04-05T14:04:00.000Z";
    const requestOpenedAt = "2026-04-05T14:05:00.000Z";
    const requestResolvedAt = "2026-04-05T14:06:00.000Z";
    const requestOpenedAgainAt = "2026-04-05T14:07:00.000Z";
    const requestStaleAt = "2026-04-05T14:08:00.000Z";
    const channelClosedAt = "2026-04-05T14:09:00.000Z";

    const events: ReadonlyArray<ForgeEvent> = [
      makeEvent({
        sequence: 1,
        type: "thread.created",
        aggregateKind: "thread",
        aggregateId: "thread-channel",
        occurredAt: createdAt,
        commandId: "cmd-thread-channel",
        payload: {
          threadId: "thread-channel",
          projectId: "project-1",
          title: "Channel thread",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      }),
      makeEvent({
        sequence: 2,
        type: "channel.created",
        aggregateKind: "thread",
        aggregateId: "thread-channel",
        occurredAt: channelCreatedAt,
        commandId: "cmd-channel-create",
        payload: {
          channelId: "channel-1",
          threadId: "thread-channel",
          channelType: "guidance",
          phaseRunId: null,
          createdAt: channelCreatedAt,
        },
      }),
      makeEvent({
        sequence: 3,
        type: "channel.message-posted",
        aggregateKind: "thread",
        aggregateId: "thread-channel",
        occurredAt: messagePostedAt,
        commandId: "cmd-channel-post",
        payload: {
          channelId: "channel-1",
          messageId: "channel-message-1",
          sequence: 0,
          fromType: "human",
          fromId: "human-1",
          fromRole: null,
          content: "Please adjust the plan",
          createdAt: messagePostedAt,
        },
      }),
      makeEvent({
        sequence: 4,
        type: "channel.messages-read",
        aggregateKind: "channel",
        aggregateId: "channel-1",
        occurredAt: "2026-04-05T10:03:30.000Z",
        commandId: "cmd-channel-read",
        payload: {
          channelId: "channel-1",
          threadId: "thread-channel",
          upToSequence: 0,
          readAt: "2026-04-05T10:03:30.000Z",
        },
      }),
      makeEvent({
        sequence: 5,
        type: "channel.conclusion-proposed",
        aggregateKind: "thread",
        aggregateId: "thread-channel",
        occurredAt: conclusionProposedAt,
        commandId: "cmd-channel-propose",
        payload: {
          channelId: "channel-1",
          threadId: "thread-channel",
          summary: "Looks good",
          proposedAt: conclusionProposedAt,
        },
      }),
      makeEvent({
        sequence: 6,
        type: "channel.concluded",
        aggregateKind: "thread",
        aggregateId: "thread-channel",
        occurredAt: channelConcludedAt,
        commandId: "cmd-channel-conclude",
        payload: {
          channelId: "channel-1",
          concludedAt: channelConcludedAt,
        },
      }),
      makeEvent({
        sequence: 7,
        type: "request.opened",
        aggregateKind: "thread",
        aggregateId: "thread-channel",
        occurredAt: requestOpenedAt,
        commandId: "cmd-request-open",
        payload: {
          requestId: "request-1",
          threadId: "thread-channel",
          childThreadId: null,
          phaseRunId: null,
          requestType: "user-input",
          payload: {
            type: "user-input",
            questions: [{ id: "q1", question: "Proceed?" }],
          },
          createdAt: requestOpenedAt,
        },
      }),
      makeEvent({
        sequence: 8,
        type: "request.resolved",
        aggregateKind: "thread",
        aggregateId: "thread-channel",
        occurredAt: requestResolvedAt,
        commandId: "cmd-request-resolve",
        payload: {
          requestId: "request-1",
          resolvedWith: { answers: { q1: "yes" } },
          resolvedAt: requestResolvedAt,
        },
      }),
      makeEvent({
        sequence: 9,
        type: "request.opened",
        aggregateKind: "thread",
        aggregateId: "thread-channel",
        occurredAt: requestOpenedAgainAt,
        commandId: "cmd-request-open-2",
        payload: {
          requestId: "request-2",
          threadId: "thread-channel",
          childThreadId: null,
          phaseRunId: null,
          requestType: "correction-needed",
          payload: {
            type: "correction-needed",
            reason: "Tighten the summary",
          },
          createdAt: requestOpenedAgainAt,
        },
      }),
      makeEvent({
        sequence: 10,
        type: "request.stale",
        aggregateKind: "thread",
        aggregateId: "thread-channel",
        occurredAt: requestStaleAt,
        commandId: "cmd-request-stale",
        payload: {
          requestId: "request-2",
          reason: "Superseded",
          staleAt: requestStaleAt,
        },
      }),
      makeEvent({
        sequence: 11,
        type: "channel.closed",
        aggregateKind: "thread",
        aggregateId: "thread-channel",
        occurredAt: channelClosedAt,
        commandId: "cmd-channel-close",
        payload: {
          channelId: "channel-1",
          closedAt: channelClosedAt,
        },
      }),
    ];

    const finalState = await events.reduce<Promise<OrchestrationReadModel>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(createEmptyReadModel(createdAt)),
    );

    expect(finalState.channels).toEqual([
      {
        id: "channel-1",
        threadId: "thread-channel",
        type: "guidance",
        status: "closed",
        createdAt: channelCreatedAt,
        updatedAt: channelClosedAt,
      },
    ]);
    expect(finalState.pendingRequests).toEqual([]);

    const thread = finalState.threads.find((entry) => entry.id === "thread-channel");
    expect(thread?.updatedAt).toBe(channelClosedAt);
  });
});
