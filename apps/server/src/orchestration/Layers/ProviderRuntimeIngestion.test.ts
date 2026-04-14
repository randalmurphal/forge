import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  InteractiveRequestId,
  ThreadId,
} from "@forgetools/contracts";
import { Effect, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  asEventId,
  asItemId,
  asMessageId,
  asProjectId,
  asThreadId,
  asTurnId,
} from "../../__test__/ids.ts";
import {
  makeTestLifecycle,
  waitForThread,
  activityPayload,
  type ProviderRuntimeTestActivity,
  type ProviderRuntimeTestMessage,
  type ProviderRuntimeTestProposedPlan,
} from "./runtimeIngestion/testHarness.ts";

describe("ProviderRuntimeIngestion", () => {
  const { createHarness, cleanup } = makeTestLifecycle();

  afterEach(cleanup);

  it("maps turn started/completed events into thread session updates", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-1"),
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "running" && thread.session?.activeTurnId === "turn-1",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-1"),
      payload: {
        state: "failed",
        errorMessage: "turn failed",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "turn failed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("turn failed");
  });

  it("applies provider session.state.changed transitions directly", async () => {
    const harness = await createHarness();
    const waitingAt = new Date().toISOString();

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-waiting"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: waitingAt,
      payload: {
        state: "waiting",
        reason: "awaiting approval",
      },
    });

    let thread = await waitForThread(
      harness.engine,
      (entry) => entry.session?.status === "running" && entry.session?.activeTurnId === null,
    );
    expect(thread.session?.status).toBe("running");
    expect(thread.session?.lastError).toBeNull();

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-error"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        state: "error",
        reason: "provider crashed",
      },
    });

    thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "provider crashed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("provider crashed");

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-stopped"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        state: "stopped",
      },
    });

    thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "stopped" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "provider crashed",
    );
    expect(thread.session?.status).toBe("stopped");
    expect(thread.session?.lastError).toBe("provider crashed");

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-ready"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        state: "ready",
      },
    });

    thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === null,
    );
    expect(thread.session?.status).toBe("ready");
    expect(thread.session?.lastError).toBeNull();
  });

  it("does not clear active turn when session/thread started arrives mid-turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-midturn-lifecycle"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-midturn-lifecycle"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-midturn-lifecycle",
    );

    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started-midturn-lifecycle"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
    });
    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started-midturn-lifecycle"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-midturn-lifecycle");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-midturn-lifecycle"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-midturn-lifecycle"),
      status: "completed",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("accepts claude turn lifecycle when seeded thread id is a synthetic placeholder", async () => {
    const harness = await createHarness();
    const seededAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-seed-claude-placeholder"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: seededAt,
          lastError: null,
        },
        createdAt: seededAt,
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-claude-placeholder"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-placeholder"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-claude-placeholder",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-claude-placeholder"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-placeholder"),
      status: "completed",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores auxiliary turn completions from a different provider thread", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-primary"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-primary"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-primary",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-aux"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-aux"),
      status: "completed",
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-primary");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-primary"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-primary"),
      status: "completed",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores non-active turn completion when runtime omits thread id", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-guarded"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-main"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-guarded-main",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-other"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-other"),
      status: "completed",
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-guarded-main");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-main"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-main"),
      status: "completed",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("maps canonical content delta/item completed into finalized assistant messages", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-1"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-2"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: " world",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-1:flush:evt-message-completed" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) =>
        entry.id === "assistant:item-1:flush:evt-message-completed",
    );
    expect(message?.text).toBe("hello world");
    expect(message?.streaming).toBe(false);
  });

  it("uses assistant item completion detail when no assistant deltas were streamed", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-assistant-item-completed-no-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-no-delta"),
      itemId: asItemId("item-no-delta"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "assistant-only final text",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-no-delta" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-no-delta",
    );
    expect(message?.text).toBe("assistant-only final text");
    expect(message?.streaming).toBe(false);
  });

  it("projects completed plan items into first-class proposed plans", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-item-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-final"),
      payload: {
        planMarkdown: "## Ship plan\n\n- wire projection\n- render follow-up",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.proposedPlans.some(
        (proposedPlan: ProviderRuntimeTestProposedPlan) =>
          proposedPlan.id === "plan:thread-1:turn:turn-plan-final",
      ),
    );
    const proposedPlan = thread.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-plan-final",
    );
    expect(proposedPlan?.planMarkdown).toBe(
      "## Ship plan\n\n- wire projection\n- render follow-up",
    );
  });

  it("marks the source proposed plan implemented only after the target turn starts", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-implement");
    const sourceTurnId = asTurnId("turn-plan-source");
    const targetTurnId = asTurnId("turn-plan-implement");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-source"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-source"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-target"),
        threadId: targetThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Target",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-target"),
        threadId: targetThreadId,
        session: {
          threadId: targetThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    harness.setProviderSession({
      provider: "codex",
      status: "ready",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: targetTurnId,
    });

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed"),
      provider: "codex",
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-plan-target"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

    const sourceThreadBeforeStart = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === sourcePlan.id && proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    expect(
      sourceThreadBeforeStart.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-plan-target-started"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: targetThreadId,
      turnId: targetTurnId,
    });

    const sourceThreadAfterStart = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === sourcePlan.id &&
            proposedPlan.implementedAt !== null &&
            proposedPlan.implementationThreadId === targetThreadId,
        ),
      2_000,
      sourceThreadId,
    );
    expect(
      sourceThreadAfterStart.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementationThreadId: "thread-implement",
    });
  });

  it("does not mark the source proposed plan implemented for a rejected turn.started event", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-1");
    const sourceTurnId = asTurnId("turn-plan-source");
    const activeTurnId = asTurnId("turn-already-running");
    const staleTurnId = asTurnId("turn-stale-start");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-source-guarded"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-source-guarded"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    harness.setProviderSession({
      provider: "codex",
      status: "running",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-already-running"),
      provider: "codex",
      createdAt,
      threadId: targetThreadId,
      turnId: activeTurnId,
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === activeTurnId,
      2_000,
      targetThreadId,
    );

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed-guarded"),
      provider: "codex",
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-plan-target-guarded"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target-guarded"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-stale-plan-implementation"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: targetThreadId,
      turnId: staleTurnId,
    });

    await harness.drain();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const sourceThreadAfterRejectedStart = readModel.threads.find(
      (entry) => entry.id === sourceThreadId,
    );
    expect(
      sourceThreadAfterRejectedStart?.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });

    const targetThreadAfterRejectedStart = readModel.threads.find(
      (entry) => entry.id === targetThreadId,
    );
    expect(targetThreadAfterRejectedStart?.session?.status).toBe("running");
    expect(targetThreadAfterRejectedStart?.session?.activeTurnId).toBe(activeTurnId);
  });

  it("does not mark the source proposed plan implemented for an unrelated turn.started when no thread active turn is tracked", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-implement");
    const sourceTurnId = asTurnId("turn-plan-source");
    const expectedTurnId = asTurnId("turn-plan-implement");
    const replayedTurnId = asTurnId("turn-replayed");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-source-unrelated"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-source-unrelated"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-target-unrelated"),
        threadId: targetThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Target",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-target-unrelated"),
        threadId: targetThreadId,
        session: {
          threadId: targetThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed-unrelated"),
      provider: "codex",
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-plan-target-unrelated"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target-unrelated"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

    harness.setProviderSession({
      provider: "codex",
      status: "running",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: expectedTurnId,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-unrelated-plan-implementation"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: targetThreadId,
      turnId: replayedTurnId,
    });

    await harness.drain();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const sourceThreadAfterUnrelatedStart = readModel.threads.find(
      (entry) => entry.id === sourceThreadId,
    );
    expect(
      sourceThreadAfterUnrelatedStart?.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });
  });

  it("finalizes buffered proposed-plan deltas into a first-class proposed plan on turn completion", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-plan-buffer"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-plan-buffer",
    );

    harness.emit({
      type: "turn.proposed.delta",
      eventId: asEventId("evt-plan-delta-1"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        delta: "## Buffered plan\n\n- first",
      },
    });
    harness.emit({
      type: "turn.proposed.delta",
      eventId: asEventId("evt-plan-delta-2"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        delta: "\n- second",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-plan-buffer"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        state: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.proposedPlans.some(
        (proposedPlan: ProviderRuntimeTestProposedPlan) =>
          proposedPlan.id === "plan:thread-1:turn:turn-plan-buffer",
      ),
    );
    const proposedPlan = thread.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-1:turn:turn-plan-buffer",
    );
    expect(proposedPlan?.planMarkdown).toBe("## Buffered plan\n\n- first\n- second");
  });

  it("buffers assistant deltas by default until completion", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-buffered",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
      itemId: asItemId("item-buffered"),
      payload: {
        streamKind: "assistant_text",
        delta: "buffer me",
      },
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(
      midThread?.messages.some(
        (message: ProviderRuntimeTestMessage) => message.text === "buffer me",
      ),
    ).toBe(false);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
      itemId: asItemId("item-buffered"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered:flush:evt-message-completed-buffered" &&
          !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) =>
        entry.id === "assistant:item-buffered:flush:evt-message-completed-buffered",
    );
    expect(message?.text).toBe("buffer me");
    expect(message?.streaming).toBe(false);
  });

  it("preserves buffered assistant start timing on completion", async () => {
    const harness = await createHarness();
    const deltaAt = "2026-04-10T12:00:00.000Z";
    const completedAt = "2026-04-10T12:00:05.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered-order"),
      provider: "codex",
      createdAt: deltaAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-order"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffered-order",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-order"),
      provider: "codex",
      createdAt: deltaAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-order"),
      itemId: asItemId("item-buffered-order"),
      payload: {
        streamKind: "assistant_text",
        delta: "first chunk",
      },
    });
    await harness.drain();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffered-order"),
      provider: "codex",
      createdAt: completedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-order"),
      itemId: asItemId("item-buffered-order"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id ===
            "assistant:item-buffered-order:flush:evt-message-completed-buffered-order" &&
          !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) =>
        entry.id === "assistant:item-buffered-order:flush:evt-message-completed-buffered-order",
    );
    expect(message?.text).toBe("first chunk");
    expect(message?.createdAt).toBe(deltaAt);
    expect(message?.updatedAt).toBe(completedAt);

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const assistantEvents = events.filter(
      (event) =>
        event.type === "thread.message-sent" &&
        event.payload.messageId ===
          "assistant:item-buffered-order:flush:evt-message-completed-buffered-order",
    );
    expect(assistantEvents).toHaveLength(1);
    expect(assistantEvents[0]).toMatchObject({
      payload: {
        streaming: false,
        text: "first chunk",
        createdAt: deltaAt,
        updatedAt: completedAt,
      },
    });
  });

  it("flushes buffered assistant chunks before later tool events in stream order", async () => {
    const harness = await createHarness();
    const turnAt = "2026-04-10T12:00:00.000Z";
    const commandAt = "2026-04-10T12:00:01.000Z";
    const finalAt = "2026-04-10T12:00:02.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered-boundary"),
      provider: "codex",
      createdAt: turnAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-boundary"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffered-boundary",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-boundary-1"),
      provider: "codex",
      createdAt: turnAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-boundary"),
      itemId: asItemId("item-buffered-boundary"),
      payload: {
        streamKind: "assistant_text",
        delta: "before tool",
      },
    });
    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-started-buffered-boundary"),
      provider: "codex",
      createdAt: commandAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-boundary"),
      itemId: asItemId("cmd-buffered-boundary"),
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        title: "Command",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-boundary-2"),
      provider: "codex",
      createdAt: finalAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-boundary"),
      itemId: asItemId("item-buffered-boundary"),
      payload: {
        streamKind: "assistant_text",
        delta: " after tool",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffered-boundary"),
      provider: "codex",
      createdAt: finalAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-boundary"),
      itemId: asItemId("item-buffered-boundary"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) => entry.messages.length === 2);
    expect(
      thread.messages
        .filter((message: ProviderRuntimeTestMessage) => message.role === "assistant")
        .map((message: ProviderRuntimeTestMessage) => message.text),
    ).toEqual(["before tool", " after tool"]);

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const relevantEvents: string[] = [];
    for (const event of events) {
      if (event.type === "thread.message-sent") {
        relevantEvents.push(`${event.type}:${event.payload.text}`);
        continue;
      }
      if (event.type !== "thread.activity-appended") {
        continue;
      }

      const { activity } = event.payload;
      if (activity.kind !== "tool.started") {
        continue;
      }

      if (typeof activity.payload !== "object" || activity.payload === null) {
        continue;
      }

      const { itemId } = activity.payload as { itemId?: string };
      if (itemId === "cmd-buffered-boundary") {
        relevantEvents.push(`${event.type}:${activity.kind}`);
      }
    }
    expect(relevantEvents).toEqual([
      "thread.message-sent:before tool",
      "thread.activity-appended:tool.started",
      "thread.message-sent: after tool",
    ]);
  });

  it("does not split buffered assistant chunks on non-transcript metadata events", async () => {
    const harness = await createHarness();
    const turnAt = "2026-04-10T12:00:00.000Z";
    const renameAt = "2026-04-10T12:00:01.000Z";
    const finalAt = "2026-04-10T12:00:02.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered-metadata"),
      provider: "codex",
      createdAt: turnAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-metadata"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffered-metadata",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-metadata-1"),
      provider: "codex",
      createdAt: turnAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-metadata"),
      itemId: asItemId("item-buffered-metadata"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello",
      },
    });
    harness.emit({
      type: "thread.metadata.updated",
      eventId: asEventId("evt-thread-metadata-buffered-metadata"),
      provider: "codex",
      createdAt: renameAt,
      threadId: asThreadId("thread-1"),
      payload: {
        name: "Renamed thread",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-metadata-2"),
      provider: "codex",
      createdAt: finalAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-metadata"),
      itemId: asItemId("item-buffered-metadata"),
      payload: {
        streamKind: "assistant_text",
        delta: " world",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffered-metadata"),
      provider: "codex",
      createdAt: finalAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-metadata"),
      itemId: asItemId("item-buffered-metadata"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id ===
            "assistant:item-buffered-metadata:flush:evt-message-completed-buffered-metadata" &&
          !message.streaming,
      ),
    );
    expect(
      thread.messages.filter((message: ProviderRuntimeTestMessage) => message.role === "assistant"),
    ).toHaveLength(1);
    expect(
      thread.messages.find(
        (message: ProviderRuntimeTestMessage) =>
          message.id ===
          "assistant:item-buffered-metadata:flush:evt-message-completed-buffered-metadata",
      )?.text,
    ).toBe("hello world");
  });

  it("emits a later buffered assistant completion without deltas in the same turn", async () => {
    const harness = await createHarness();
    const turnAt = "2026-04-10T12:00:00.000Z";
    const commandAt = "2026-04-10T12:00:01.000Z";
    const completionAt = "2026-04-10T12:00:02.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered-later-complete"),
      provider: "codex",
      createdAt: turnAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-later-complete"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffered-later-complete",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-later-complete"),
      provider: "codex",
      createdAt: turnAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-later-complete"),
      itemId: asItemId("item-buffered-later-complete-1"),
      payload: {
        streamKind: "assistant_text",
        delta: "before tool",
      },
    });
    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-started-buffered-later-complete"),
      provider: "codex",
      createdAt: commandAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-later-complete"),
      itemId: asItemId("cmd-buffered-later-complete"),
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        title: "Command",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffered-later-complete"),
      provider: "codex",
      createdAt: completionAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-later-complete"),
      itemId: asItemId("item-buffered-later-complete-2"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "after tool",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.messages.filter((message: ProviderRuntimeTestMessage) => message.role === "assistant")
          .length === 2,
    );
    expect(
      thread.messages
        .filter((message: ProviderRuntimeTestMessage) => message.role === "assistant")
        .map((message: ProviderRuntimeTestMessage) => message.text),
    ).toEqual(["before tool", "after tool"]);
  });

  it("flushes buffered assistant text on turn completion when item completion is missing", async () => {
    const harness = await createHarness();
    const turnAt = "2026-04-10T12:00:00.000Z";
    const completedAt = "2026-04-10T12:00:02.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered-turn-complete"),
      provider: "codex",
      createdAt: turnAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-turn-complete"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffered-turn-complete",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-turn-complete"),
      provider: "codex",
      createdAt: turnAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-turn-complete"),
      itemId: asItemId("item-buffered-turn-complete"),
      payload: {
        streamKind: "assistant_text",
        delta: "still keep this",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-buffered-turn-complete"),
      provider: "codex",
      createdAt: completedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-turn-complete"),
      payload: {
        state: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id ===
            "assistant:item-buffered-turn-complete:flush:evt-turn-completed-buffered-turn-complete" &&
          !message.streaming,
      ),
    );
    expect(
      thread.messages.find(
        (message: ProviderRuntimeTestMessage) =>
          message.id ===
          "assistant:item-buffered-turn-complete:flush:evt-turn-completed-buffered-turn-complete",
      )?.text,
    ).toBe("still keep this");
  });

  it("streams assistant deltas when thread.turn.start requests streaming mode", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-streaming-mode"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("message-streaming-mode"),
          role: "user",
          text: "stream please",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-streaming-mode"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-mode",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-mode"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello live",
      },
    });

    const liveThread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-mode" &&
          message.streaming &&
          message.text === "hello live",
      ),
    );
    const liveMessage = liveThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
    );
    expect(liveMessage?.streaming).toBe(true);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-streaming-mode"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "hello live",
      },
    });

    const finalThread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-mode" && !message.streaming,
      ),
    );
    const finalMessage = finalThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
    );
    expect(finalMessage?.text).toBe("hello live");
    expect(finalMessage?.streaming).toBe(false);
  });

  it("emits a later streaming assistant completion without prior deltas in the same turn", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-streaming-later-complete"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("message-streaming-later-complete"),
          role: "user",
          text: "stream please",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-streaming-later-complete"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-later-complete"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-later-complete",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-later-complete"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-later-complete"),
      itemId: asItemId("item-streaming-later-complete-1"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello live",
      },
    });
    await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-later-complete-1" &&
          message.streaming &&
          message.text === "hello live",
      ),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-streaming-later-complete-1"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-later-complete"),
      itemId: asItemId("item-streaming-later-complete-1"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "hello live",
      },
    });
    await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-later-complete-1" && !message.streaming,
      ),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-streaming-later-complete-2"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-later-complete"),
      itemId: asItemId("item-streaming-later-complete-2"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "follow-up without deltas",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-later-complete-2" && !message.streaming,
      ),
    );
    expect(
      thread.messages.find(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-later-complete-2",
      )?.text,
    ).toBe("follow-up without deltas");
  });

  it("spills oversized buffered deltas and still finalizes full assistant text", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const oversizedText = "x".repeat(40_000);

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffer-spill"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffer-spill",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffer-spill"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
      payload: {
        streamKind: "assistant_text",
        delta: oversizedText,
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffer-spill"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffer-spill:flush:evt-message-delta-buffer-spill" &&
          !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) =>
        entry.id === "assistant:item-buffer-spill:flush:evt-message-delta-buffer-spill",
    );
    expect(message?.text.length).toBe(oversizedText.length);
    expect(message?.text).toBe(oversizedText);
    expect(message?.streaming).toBe(false);
  });

  it("does not duplicate assistant completion when item.completed is followed by turn.completed", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-complete-dedup",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      itemId: asItemId("item-complete-dedup"),
      payload: {
        streamKind: "assistant_text",
        delta: "done",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      itemId: asItemId("item-complete-dedup"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      payload: {
        state: "completed",
      },
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "ready" &&
        thread.session?.activeTurnId === null &&
        thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id ===
              "assistant:item-complete-dedup:flush:evt-message-completed-for-complete-dedup" &&
            !message.streaming,
        ),
    );

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const completionEvents = events.filter((event) => {
      if (event.type !== "thread.message-sent") {
        return false;
      }
      return (
        event.payload.messageId ===
          "assistant:item-complete-dedup:flush:evt-message-completed-for-complete-dedup" &&
        event.payload.streaming === false
      );
    });
    expect(completionEvents).toHaveLength(1);
  });

  it("maps canonical request events into approval activities with requestKind", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: InteractiveRequestId.makeUnsafe("req-open"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    harness.emit({
      type: "request.resolved",
      eventId: asEventId("evt-request-resolved"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: InteractiveRequestId.makeUnsafe("req-open"),
      payload: {
        requestType: "command_execution_approval",
        decision: "accept",
      },
    });

    await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.requested",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.resolved",
        ),
    );

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread).toBeDefined();

    const requested = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-opened",
    );
    const requestedPayload =
      requested?.payload && typeof requested.payload === "object"
        ? (requested.payload as Record<string, unknown>)
        : undefined;
    expect(requestedPayload?.requestKind).toBe("command");
    expect(requestedPayload?.requestType).toBe("command_execution_approval");

    const resolved = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-resolved",
    );
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === "object"
        ? (resolved.payload as Record<string, unknown>)
        : undefined;
    expect(resolvedPayload?.requestKind).toBe("command");
    expect(resolvedPayload?.requestType).toBe("command_execution_approval");
  });

  it("ignores non-approval request events such as dynamic tool calls", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-dynamic-tool-opened"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        requestType: "dynamic_tool_call",
        detail: "post_to_chat",
      },
    });

    harness.emit({
      type: "request.resolved",
      eventId: asEventId("evt-dynamic-tool-resolved"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        requestType: "dynamic_tool_call",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) => entry.id === "thread-1");

    expect(
      thread.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "evt-dynamic-tool-opened" || activity.id === "evt-dynamic-tool-resolved",
      ),
    ).toBe(false);
    expect(
      thread.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.kind === "approval.requested" || activity.kind === "approval.resolved",
      ),
    ).toBe(false);
  });

  it("maps permission escalation request events into approval activities and pending requests", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-permission-opened"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: InteractiveRequestId.makeUnsafe("req-permission-open"),
      payload: {
        requestType: "permission_approval",
        detail: "Need broader workspace access",
        args: {
          reason: "Need broader workspace access",
          permissions: {
            network: {
              enabled: true,
            },
            fileSystem: {
              read: ["/tmp/project/src"],
              write: ["/tmp/project/out"],
            },
          },
        },
      },
    });

    await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-permission-opened",
      ),
    );

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    const pendingRequest = readModel.pendingRequests.find(
      (request) => request.id === InteractiveRequestId.makeUnsafe("req-permission-open"),
    );

    expect(
      thread?.activities.find((activity) => activity.id === "evt-permission-opened")?.kind,
    ).toBe("approval.requested");
    expect(pendingRequest).toEqual(
      expect.objectContaining({
        id: InteractiveRequestId.makeUnsafe("req-permission-open"),
        type: "permission",
        payload: {
          type: "permission",
          reason: "Need broader workspace access",
          permissions: {
            network: {
              enabled: true,
            },
            fileSystem: {
              read: ["/tmp/project/src"],
              write: ["/tmp/project/out"],
            },
          },
        },
      }),
    );
  });

  it("preserves MCP elicitation form questions in pending interactive requests", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-mcp-opened"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-mcp"),
      requestId: InteractiveRequestId.makeUnsafe("req-mcp-open"),
      payload: {
        requestType: "mcp_elicitation",
        detail: "MCP input requested",
        args: {
          mode: "form",
          serverName: "workspace",
          message: "Choose the sandbox mode",
          requestedSchema: {
            type: "object",
          },
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
                {
                  label: "full-access",
                  description: "Allow full local access",
                },
              ],
            },
          ],
          _meta: {
            source: "forge",
          },
        },
      },
    });

    await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-mcp-opened",
      ),
    );

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    const pendingRequest = readModel.pendingRequests.find(
      (request) => request.id === InteractiveRequestId.makeUnsafe("req-mcp-open"),
    );

    expect(thread?.activities.find((activity) => activity.id === "evt-mcp-opened")?.kind).toBe(
      "user-input.requested",
    );
    expect(pendingRequest).toEqual(
      expect.objectContaining({
        id: InteractiveRequestId.makeUnsafe("req-mcp-open"),
        type: "mcp-elicitation",
        payload: {
          type: "mcp-elicitation",
          mode: "form",
          serverName: "workspace",
          message: "Choose the sandbox mode",
          requestedSchema: {
            type: "object",
          },
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
                {
                  label: "full-access",
                  description: "Allow full local access",
                },
              ],
            },
          ],
          meta: {
            source: "forge",
          },
          turnId: "turn-mcp",
        },
      }),
    );
  });

  it("maps runtime.error into errored session state", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-3"),
      payload: {
        message: "runtime exploded",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-3" &&
        entry.session?.lastError === "runtime exploded",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime exploded");
  });

  it("records runtime.error activities from the typed payload message", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-activity"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-runtime-error-activity"),
      payload: {
        message: "runtime activity exploded",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.id === "evt-runtime-error-activity"),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-runtime-error-activity",
    );
    const activityPayload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(activity?.kind).toBe("runtime.error");
    expect(activityPayload?.message).toBe("runtime activity exploded");
  });

  it("keeps the session running when a runtime.warning arrives during an active turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-warning-turn-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-warning"),
      payload: {},
    });

    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-warning-runtime"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-warning"),
      payload: {
        message: "Reconnecting... 2/5",
        detail: {
          willRetry: true,
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "running" &&
        entry.session?.activeTurnId === "turn-warning" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) =>
            activity.id === "evt-warning-runtime" && activity.kind === "runtime.warning",
        ),
    );
    expect(thread.session?.status).toBe("running");
    expect(thread.session?.activeTurnId).toBe("turn-warning");
    expect(thread.session?.lastError).toBeNull();
  });

  it("maps session/thread lifecycle and item.started into session/activity projections", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      message: "session started",
    });
    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
    });
    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-tool-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-9"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Read file",
        detail: "/tmp/file.ts",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.started",
        ),
    );

    expect(thread.session?.status).toBe("ready");
    expect(
      thread.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.started",
      ),
    ).toBe(true);
  });

  it("preserves command data on tool.started activities for command executions", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-started-with-data"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-started"),
      itemId: asItemId("command-item-1"),
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        title: "Command",
        toolName: "commandExecution",
        data: {
          item: {
            id: "command-item-1",
            source: "unifiedExecStartup",
            processId: "proc-123",
            command: ["/bin/zsh", "-lc", "echo hello"],
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-command-started-with-data",
      ),
    );

    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-command-started-with-data",
    );
    const payload = activityPayload(activity);
    const data =
      payload?.data && typeof payload.data === "object"
        ? (payload.data as Record<string, unknown>)
        : undefined;
    const item =
      data?.item && typeof data.item === "object"
        ? (data.item as Record<string, unknown>)
        : undefined;

    expect(activity?.kind).toBe("tool.started");
    expect(payload?.itemType).toBe("command_execution");
    expect(item?.source).toBe("unifiedExecStartup");
    expect(item?.processId).toBe("proc-123");
  });

  it("does not split buffered assistant text when token-usage events arrive mid-stream", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-token-usage"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-token-usage"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-token-usage",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-delta-before-usage"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-token-usage"),
      itemId: asItemId("item-token-usage"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello",
      },
    });
    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-token-usage-mid-stream"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-token-usage"),
      payload: {
        usage: {
          usedTokens: 500,
          maxTokens: 128000,
          totalProcessedTokens: 500,
        },
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-delta-after-usage"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-token-usage"),
      itemId: asItemId("item-token-usage"),
      payload: {
        streamKind: "assistant_text",
        delta: " world",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-completed-token-usage"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-token-usage"),
      itemId: asItemId("item-token-usage"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-token-usage:flush:evt-completed-token-usage" &&
          !message.streaming,
      ),
    );
    const assistantMessages = thread.messages.filter(
      (message: ProviderRuntimeTestMessage) => message.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.text).toBe("hello world");
  });

  it("does not split buffered assistant text when task.progress arrives mid-stream", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-task-progress"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-progress"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-task-progress",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-delta-before-task-progress"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-progress"),
      itemId: asItemId("item-task-progress"),
      payload: {
        streamKind: "assistant_text",
        delta: "before",
      },
    });
    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-task-progress-mid-stream"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-progress"),
      payload: {
        taskId: "task-1",
        description: "Reasoning update",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-delta-after-task-progress"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-progress"),
      itemId: asItemId("item-task-progress"),
      payload: {
        streamKind: "assistant_text",
        delta: " after",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-completed-task-progress"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-progress"),
      itemId: asItemId("item-task-progress"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-task-progress:flush:evt-completed-task-progress" &&
          !message.streaming,
      ),
    );
    const assistantMessages = thread.messages.filter(
      (message: ProviderRuntimeTestMessage) => message.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.text).toBe("before after");
  });

  it("flushes buffered assistant text when runtime.error arrives", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-error-flush"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-error-flush"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-error-flush",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-delta-before-error"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-error-flush"),
      itemId: asItemId("item-error-flush"),
      payload: {
        streamKind: "assistant_text",
        delta: "text before error",
      },
    });
    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-error-flush"),
      payload: {
        message: "Something went wrong",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.role === "assistant" && message.text === "text before error",
      ),
    );
    const assistantMessages = thread.messages.filter(
      (message: ProviderRuntimeTestMessage) => message.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.text).toBe("text before error");
  });

  it("keeps buffered assistant text intact when hidden command output arrives", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-cmd-output"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-cmd-output"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-cmd-output",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-delta-before-cmd-output"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-cmd-output"),
      itemId: asItemId("item-cmd-output-text"),
      payload: {
        streamKind: "assistant_text",
        delta: "running ",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-cmd-output-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-cmd-output"),
      itemId: asItemId("item-cmd-output-cmd"),
      payload: {
        streamKind: "command_output",
        delta: "$ echo hello\n",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-delta-after-cmd-output"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-cmd-output"),
      itemId: asItemId("item-cmd-output-text"),
      payload: {
        streamKind: "assistant_text",
        delta: "command",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-cmd-output-text-complete"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-cmd-output"),
      itemId: asItemId("item-cmd-output-text"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.role === "assistant" && message.text === "running command",
      ),
    );
    const assistantMessages = thread.messages.filter(
      (message: ProviderRuntimeTestMessage) => message.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.text).toBe("running command");

    const commandOutputActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-cmd-output-delta",
    );
    expect(commandOutputActivity?.kind).toBe("tool.output.delta");
  });

  it("treats unknown Codex item types as dynamic_tool_call and flushes buffer", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-unknown-tool"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-unknown-tool"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-unknown-tool",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-delta-before-unknown-tool"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-unknown-tool"),
      itemId: asItemId("item-unknown-tool-text"),
      payload: {
        streamKind: "assistant_text",
        delta: "let me monitor that",
      },
    });
    // Simulate a new tool type that Codex added (e.g., "Monitor") which
    // toCanonicalItemType doesn't recognize. It should be treated as
    // dynamic_tool_call, produce an activity, and flush the buffer.
    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-unknown-tool-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-unknown-tool"),
      itemId: asItemId("item-unknown-tool"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "inProgress",
        title: "Tool call",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.role === "assistant" && message.text === "let me monitor that",
      ),
    );
    const assistantMessages = thread.messages.filter(
      (message: ProviderRuntimeTestMessage) => message.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.text).toBe("let me monitor that");

    // Verify the unknown tool produced an activity
    const toolActivity = thread.activities.find(
      (a: ProviderRuntimeTestActivity) => a.kind === "tool.started",
    );
    expect(toolActivity).toBeDefined();
    expect(activityPayload(toolActivity)?.itemType).toBe("dynamic_tool_call");
  });
});
