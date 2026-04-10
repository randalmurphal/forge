import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import type {
  OrchestrationReadModel,
  ProviderRuntimeEvent,
  ProviderSession,
} from "@forgetools/contracts";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderItemId,
  type ServerSettings,
  ThreadId,
  TurnId,
} from "@forgetools/contracts";
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CheckpointStoreLive } from "../../checkpointing/Layers/CheckpointStore.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";

function makeTestServerSettingsLayer(overrides: Partial<ServerSettings> = {}) {
  return ServerSettingsService.layerTest(overrides);
}

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderRuntimeEvent["provider"];
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

type LegacyTurnCompletedEvent = LegacyProviderRuntimeEvent & {
  readonly type: "turn.completed";
  readonly payload?: undefined;
  readonly status: "completed" | "failed" | "interrupted" | "cancelled";
  readonly errorMessage?: string | undefined;
};

function isLegacyTurnCompletedEvent(
  event: LegacyProviderRuntimeEvent,
): event is LegacyTurnCompletedEvent {
  return (
    event.type === "turn.completed" &&
    event.payload === undefined &&
    typeof event.status === "string"
  );
}

function createProviderServiceHarness() {
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const runtimeSessions: ProviderSession[] = [];

  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([...runtimeSessions]),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    rollbackConversation: () => unsupported(),
    forkThread: () => unsupported(),
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
  };

  const setSession = (session: ProviderSession): void => {
    const existingIndex = runtimeSessions.findIndex((entry) => entry.threadId === session.threadId);
    if (existingIndex >= 0) {
      runtimeSessions[existingIndex] = session;
      return;
    }
    runtimeSessions.push(session);
  };

  const normalizeLegacyEvent = (event: LegacyProviderRuntimeEvent): ProviderRuntimeEvent => {
    if (isLegacyTurnCompletedEvent(event)) {
      const normalized: Extract<ProviderRuntimeEvent, { type: "turn.completed" }> = {
        ...(event as Omit<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>, "payload">),
        payload: {
          state: event.status,
          ...(typeof event.errorMessage === "string" ? { errorMessage: event.errorMessage } : {}),
        },
      };
      return normalized;
    }

    return event as ProviderRuntimeEvent;
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, normalizeLegacyEvent(event)));
  };

  return {
    service,
    emit,
    setSession,
  };
}

async function waitForThread(
  engine: OrchestrationEngineShape,
  predicate: (thread: ProviderRuntimeTestThread) => boolean,
  timeoutMs = 2000,
  threadId: ThreadId = asThreadId("thread-1"),
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<ProviderRuntimeTestThread> => {
    const readModel = await Effect.runPromise(engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (thread && predicate(thread)) {
      return thread;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for thread state");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

type ProviderRuntimeTestReadModel = OrchestrationReadModel;
type ProviderRuntimeTestThread = ProviderRuntimeTestReadModel["threads"][number];
type ProviderRuntimeTestMessage = ProviderRuntimeTestThread["messages"][number];
type ProviderRuntimeTestProposedPlan = ProviderRuntimeTestThread["proposedPlans"][number];
type ProviderRuntimeTestActivity = ProviderRuntimeTestThread["activities"][number];
type ProviderRuntimeTestCheckpoint = ProviderRuntimeTestThread["checkpoints"][number];

function activityPayload(
  activity: ProviderRuntimeTestActivity | undefined,
): Record<string, unknown> | undefined {
  return activity?.payload && typeof activity.payload === "object"
    ? (activity.payload as Record<string, unknown>)
    : undefined;
}

function activityInlineDiff(
  activity: ProviderRuntimeTestActivity | undefined,
): Record<string, unknown> | undefined {
  const payload = activityPayload(activity);
  return payload?.inlineDiff && typeof payload.inlineDiff === "object"
    ? (payload.inlineDiff as Record<string, unknown>)
    : undefined;
}

describe("ProviderRuntimeIngestion", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProviderRuntimeIngestionService | CheckpointStore,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function createHarness(options?: { serverSettings?: Partial<ServerSettings> }) {
    const workspaceRoot = makeTempDir("forge-provider-project-");
    fs.mkdirSync(path.join(workspaceRoot, ".git"));
    const provider = createProviderServiceHarness();
    const gitCoreLayer = GitCoreLive.pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provide(NodeServices.layer),
    );
    const checkpointStoreLayer = CheckpointStoreLive.pipe(Layer.provide(gitCoreLayer));
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
    );
    const layer = ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(makeTestServerSettingsLayer(options?.serverSettings)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(checkpointStoreLayer),
      Layer.provideMerge(gitCoreLayer),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
    const checkpointStore = await runtime.runPromise(Effect.service(CheckpointStore));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(ingestion.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(ingestion.drain);

    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-provider-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot,
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
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
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-seed"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
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
    provider.setSession({
      provider: "codex",
      status: "ready",
      runtimeMode: "approval-required",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt,
      updatedAt: createdAt,
    });

    return {
      engine,
      checkpointStore,
      workspaceRoot,
      emit: provider.emit,
      setProviderSession: provider.setSession,
      drain,
    };
  }

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
          message.id === "assistant:item-1" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-1",
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
        (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-buffered",
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
          message.id === "assistant:item-buffered" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffered",
    );
    expect(message?.text).toBe("buffer me");
    expect(message?.streaming).toBe(false);
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
          message.id === "assistant:item-buffer-spill" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffer-spill",
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
            message.id === "assistant:item-complete-dedup" && !message.streaming,
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
        event.payload.messageId === "assistant:item-complete-dedup" &&
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
      requestId: ApprovalRequestId.makeUnsafe("req-open"),
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
      requestId: ApprovalRequestId.makeUnsafe("req-open"),
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

  it("consumes P1 runtime events into thread metadata, diff checkpoints, and activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.metadata.updated",
      eventId: asEventId("evt-thread-metadata-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        name: "Renamed by provider",
        metadata: { source: "provider" },
      },
    });

    harness.emit({
      type: "turn.plan.updated",
      eventId: asEventId("evt-turn-plan-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      payload: {
        explanation: "Working through the plan",
        plan: [
          { step: "Inspect files", status: "completed" },
          { step: "Apply patch", status: "in_progress" },
        ],
      },
    });

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-item-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      itemId: asItemId("item-p1-tool"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run tests",
        detail: "bun test",
        data: { pid: 123 },
      },
    });

    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-runtime-warning"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      payload: {
        message: "Provider got slow",
        detail: { latencyMs: 1500 },
      },
    });

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-turn-diff-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      itemId: asItemId("item-p1-assistant"),
      payload: {
        unifiedDiff: "diff --git a/file.txt b/file.txt\n+hello\n",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.title === "Renamed by provider" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "turn.plan.updated",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.updated",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "runtime.warning",
        ) &&
        entry.checkpoints.some(
          (checkpoint: ProviderRuntimeTestCheckpoint) => checkpoint.turnId === "turn-p1",
        ),
    );

    expect(thread.title).toBe("Renamed by provider");

    const planActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-turn-plan-updated",
    );
    const planPayload =
      planActivity?.payload && typeof planActivity.payload === "object"
        ? (planActivity.payload as Record<string, unknown>)
        : undefined;
    expect(planActivity?.kind).toBe("turn.plan.updated");
    expect(Array.isArray(planPayload?.plan)).toBe(true);

    const toolUpdate = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-item-updated",
    );
    const toolUpdatePayload =
      toolUpdate?.payload && typeof toolUpdate.payload === "object"
        ? (toolUpdate.payload as Record<string, unknown>)
        : undefined;
    expect(toolUpdate?.kind).toBe("tool.updated");
    expect(toolUpdatePayload?.itemId).toBe("item-p1-tool");
    expect(toolUpdatePayload?.itemType).toBe("command_execution");
    expect(toolUpdatePayload?.status).toBe("in_progress");

    const warning = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-runtime-warning",
    );
    const warningPayload =
      warning?.payload && typeof warning.payload === "object"
        ? (warning.payload as Record<string, unknown>)
        : undefined;
    expect(warning?.kind).toBe("runtime.warning");
    expect(warningPayload?.message).toBe("Provider got slow");

    const checkpoint = thread.checkpoints.find(
      (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === "turn-p1",
    );
    expect(checkpoint?.status).toBe("missing");
    expect(checkpoint?.assistantMessageId).toBe("assistant:item-p1-assistant");
    expect(checkpoint?.checkpointRef).toBe("provider-diff:evt-turn-diff-updated");
  });

  it("persists normalized inline diffs on file-change tool activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-file-change-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-file-change"),
      itemId: asItemId("item-file-change"),
      payload: {
        itemType: "file_change",
        status: "in_progress",
        title: "File change",
        detail: "Editing apps/web/src/session-logic.ts",
        data: {
          item: {
            changes: [
              {
                path: "apps/web/src/session-logic.ts",
                kind: "modified",
                diff: ["@@ -1 +1,2 @@", " export const value = 1;", "+export const next = 2;"].join(
                  "\n",
                ),
              },
            ],
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-file-change-updated",
      ),
    );

    const toolUpdate = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-file-change-updated",
    );
    const payload =
      toolUpdate?.payload && typeof toolUpdate.payload === "object"
        ? (toolUpdate.payload as Record<string, unknown>)
        : undefined;
    const inlineDiff =
      payload?.inlineDiff && typeof payload.inlineDiff === "object"
        ? (payload.inlineDiff as Record<string, unknown>)
        : undefined;

    expect(toolUpdate?.kind).toBe("tool.updated");
    expect(payload?.itemId).toBe("item-file-change");
    expect(inlineDiff?.availability).toBe("exact_patch");
    expect(inlineDiff?.unifiedDiff).toContain(
      "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts",
    );
    expect(thread.agentDiffs).toEqual([
      expect.objectContaining({
        turnId: "turn-file-change",
        source: "derived_tool_results",
        coverage: "partial",
        files: [
          expect.objectContaining({
            path: "apps/web/src/session-logic.ts",
          }),
        ],
      }),
    ]);
  });

  it("attaches an exact inline diff to successful rm command rows", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(harness.workspaceRoot, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(harness.workspaceRoot, "src/remove.ts"),
      "export const removed = true;\n",
    );

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-rm-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-rm"),
      itemId: asItemId("item-command-rm"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run command",
        data: {
          item: {
            command: "/usr/bin/zsh -lc 'rm src/remove.ts'",
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-rm-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-rm"),
      itemId: asItemId("item-command-rm"),
      payload: {
        itemType: "command_execution",
        title: "Run command",
        data: {
          item: {
            command: "/usr/bin/zsh -lc 'rm src/remove.ts'",
            exitCode: 0,
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) => {
      const activity = entry.activities.find(
        (candidate: ProviderRuntimeTestActivity) => candidate.id === "evt-command-rm-completed",
      );
      return activityInlineDiff(activity)?.availability === "exact_patch";
    });

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.id === "evt-command-rm-completed",
    );
    const payload = activityPayload(activity);
    const inlineDiff = activityInlineDiff(activity);

    expect(payload?.itemType).toBe("command_execution");
    expect(inlineDiff).toMatchObject({
      availability: "exact_patch",
      files: [{ path: "src/remove.ts", kind: "deleted", deletions: 1 }],
      deletions: 1,
    });
    expect(String(inlineDiff?.unifiedDiff)).toContain("deleted file mode 100644");
  });

  it("attaches an exact inline diff to successful mv command rows", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(harness.workspaceRoot, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(harness.workspaceRoot, "src/old.ts"),
      "export const oldName = true;\n",
    );

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-mv-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-mv"),
      itemId: asItemId("item-command-mv"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run command",
        data: {
          item: {
            command: "mv src/old.ts src/new.ts",
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-mv-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-mv"),
      itemId: asItemId("item-command-mv"),
      payload: {
        itemType: "command_execution",
        title: "Run command",
        data: {
          item: {
            command: "mv src/old.ts src/new.ts",
            exitCode: 0,
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) => {
      const activity = entry.activities.find(
        (candidate: ProviderRuntimeTestActivity) => candidate.id === "evt-command-mv-completed",
      );
      return activityInlineDiff(activity)?.availability === "exact_patch";
    });

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.id === "evt-command-mv-completed",
    );
    const inlineDiff = activityInlineDiff(activity);

    expect(inlineDiff).toMatchObject({
      availability: "exact_patch",
      files: [{ path: "src/new.ts", kind: "renamed" }],
    });
    expect(String(inlineDiff?.unifiedDiff)).toContain("rename from src/old.ts");
    expect(String(inlineDiff?.unifiedDiff)).toContain("rename to src/new.ts");
  });

  it("attaches a multi-file exact inline diff to supported command chains", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(harness.workspaceRoot, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(harness.workspaceRoot, "src/old.ts"),
      "export const oldName = true;\n",
    );
    fs.writeFileSync(
      path.join(harness.workspaceRoot, "src/remove.ts"),
      "export const removeMe = true;\n",
    );

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-chain-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-chain"),
      itemId: asItemId("item-command-chain"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run command chain",
        data: {
          item: {
            command: "/usr/bin/zsh -lc 'mv src/old.ts src/new.ts && rm src/remove.ts'",
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-chain-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-chain"),
      itemId: asItemId("item-command-chain"),
      payload: {
        itemType: "command_execution",
        title: "Run command chain",
        data: {
          item: {
            command: "/usr/bin/zsh -lc 'mv src/old.ts src/new.ts && rm src/remove.ts'",
            exitCode: 0,
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) => {
      const activity = entry.activities.find(
        (candidate: ProviderRuntimeTestActivity) => candidate.id === "evt-command-chain-completed",
      );
      return activityInlineDiff(activity)?.availability === "exact_patch";
    });

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.id === "evt-command-chain-completed",
    );
    const inlineDiff = activityInlineDiff(activity);

    expect(inlineDiff?.files).toEqual([
      { path: "src/new.ts", kind: "renamed" },
      { path: "src/remove.ts", kind: "deleted", deletions: 1 },
    ]);
    expect(String(inlineDiff?.unifiedDiff)).toContain("rename from src/old.ts");
    expect(String(inlineDiff?.unifiedDiff)).toContain("deleted file mode 100644");
  });

  it("supports array-form commands with quoted paths", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(harness.workspaceRoot, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(harness.workspaceRoot, "src/old name.ts"),
      "export const oldName = true;\n",
    );

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-array-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-array"),
      itemId: asItemId("item-command-array"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run array command",
        data: {
          item: {
            command: ["mv", "src/old name.ts", "src/new name.ts"],
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-array-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-array"),
      itemId: asItemId("item-command-array"),
      payload: {
        itemType: "command_execution",
        title: "Run array command",
        data: {
          item: {
            command: ["mv", "src/old name.ts", "src/new name.ts"],
            exitCode: 0,
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) => {
      const activity = entry.activities.find(
        (candidate: ProviderRuntimeTestActivity) => candidate.id === "evt-command-array-completed",
      );
      return activityInlineDiff(activity)?.availability === "exact_patch";
    });

    expect(
      activityInlineDiff(
        thread.activities.find(
          (candidate: ProviderRuntimeTestActivity) =>
            candidate.id === "evt-command-array-completed",
        ),
      ),
    ).toMatchObject({
      availability: "exact_patch",
      files: [{ path: "src/new name.ts", kind: "renamed" }],
    });
  });

  it("keeps dependent command chains as plain command rows without inline diffs", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(harness.workspaceRoot, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(harness.workspaceRoot, "src/old.ts"),
      "export const oldName = true;\n",
    );

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-dependent-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-dependent"),
      itemId: asItemId("item-command-dependent"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run dependent command chain",
        data: {
          item: {
            command: "mv src/old.ts src/new.ts && rm src/new.ts",
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-dependent-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-dependent"),
      itemId: asItemId("item-command-dependent"),
      payload: {
        itemType: "command_execution",
        title: "Run dependent command chain",
        data: {
          item: {
            command: "mv src/old.ts src/new.ts && rm src/new.ts",
            exitCode: 0,
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (candidate: ProviderRuntimeTestActivity) =>
          candidate.id === "evt-command-dependent-completed",
      ),
    );

    expect(
      activityInlineDiff(
        thread.activities.find(
          (candidate: ProviderRuntimeTestActivity) =>
            candidate.id === "evt-command-dependent-completed",
        ),
      ),
    ).toBeUndefined();
  });

  it("keeps unsupported or failed commands as plain command rows without inline diffs", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(harness.workspaceRoot, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(harness.workspaceRoot, "src/remove.ts"),
      "export const removeMe = true;\n",
    );

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-unsupported-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-unsupported"),
      itemId: asItemId("item-command-unsupported"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run unsupported command",
        data: {
          item: {
            command: "rm src/remove.ts | cat",
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-unsupported-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-unsupported"),
      itemId: asItemId("item-command-unsupported"),
      payload: {
        itemType: "command_execution",
        title: "Run unsupported command",
        data: {
          item: {
            command: "rm src/remove.ts | cat",
            exitCode: 0,
          },
        },
      },
    });

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-failed-started"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-failed"),
      itemId: asItemId("item-command-failed"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run failed command",
        data: {
          item: {
            command: "rm src/remove.ts",
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-failed-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-failed"),
      itemId: asItemId("item-command-failed"),
      payload: {
        itemType: "command_execution",
        title: "Run failed command",
        data: {
          item: {
            command: "rm src/remove.ts",
            exitCode: 1,
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "evt-command-unsupported-completed" ||
          activity.id === "evt-command-failed-completed",
      ),
    );

    expect(
      activityInlineDiff(
        thread.activities.find(
          (candidate: ProviderRuntimeTestActivity) =>
            candidate.id === "evt-command-unsupported-completed",
        ),
      ),
    ).toBeUndefined();
    expect(
      activityInlineDiff(
        thread.activities.find(
          (candidate: ProviderRuntimeTestActivity) =>
            candidate.id === "evt-command-failed-completed",
        ),
      ),
    ).toBeUndefined();
  });

  it("keeps directory and overwrite mutations as plain command rows without inline diffs", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(harness.workspaceRoot, "src", "existing-dir"), { recursive: true });
    fs.writeFileSync(
      path.join(harness.workspaceRoot, "src", "old.ts"),
      "export const oldName = true;\n",
    );
    fs.writeFileSync(
      path.join(harness.workspaceRoot, "src", "existing.ts"),
      "export const existing = true;\n",
    );

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-dir-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-dir"),
      itemId: asItemId("item-command-dir"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run directory command",
        data: {
          item: {
            command: "rm src/existing-dir",
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-dir-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-dir"),
      itemId: asItemId("item-command-dir"),
      payload: {
        itemType: "command_execution",
        title: "Run directory command",
        data: {
          item: {
            command: "rm src/existing-dir",
            exitCode: 0,
          },
        },
      },
    });

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-overwrite-started"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-overwrite"),
      itemId: asItemId("item-command-overwrite"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run overwrite command",
        data: {
          item: {
            command: "mv src/old.ts src/existing.ts",
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-overwrite-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-overwrite"),
      itemId: asItemId("item-command-overwrite"),
      payload: {
        itemType: "command_execution",
        title: "Run overwrite command",
        data: {
          item: {
            command: "mv src/old.ts src/existing.ts",
            exitCode: 0,
          },
        },
      },
    });

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-dir-target-started"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-dir-target"),
      itemId: asItemId("item-command-dir-target"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run directory target command",
        data: {
          item: {
            command: "mv src/old.ts src/existing-dir/",
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-dir-target-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-dir-target"),
      itemId: asItemId("item-command-dir-target"),
      payload: {
        itemType: "command_execution",
        title: "Run directory target command",
        data: {
          item: {
            command: "mv src/old.ts src/existing-dir/",
            exitCode: 0,
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "evt-command-dir-completed" ||
          activity.id === "evt-command-overwrite-completed" ||
          activity.id === "evt-command-dir-target-completed",
      ),
    );

    expect(
      activityInlineDiff(
        thread.activities.find(
          (candidate: ProviderRuntimeTestActivity) => candidate.id === "evt-command-dir-completed",
        ),
      ),
    ).toBeUndefined();
    expect(
      activityInlineDiff(
        thread.activities.find(
          (candidate: ProviderRuntimeTestActivity) =>
            candidate.id === "evt-command-overwrite-completed",
        ),
      ),
    ).toBeUndefined();
    expect(
      activityInlineDiff(
        thread.activities.find(
          (candidate: ProviderRuntimeTestActivity) =>
            candidate.id === "evt-command-dir-target-completed",
        ),
      ),
    ).toBeUndefined();
  });

  it("keeps directory delete and rename commands as plain command rows without inline diffs", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(harness.workspaceRoot, "src/remove-dir"), { recursive: true });
    fs.mkdirSync(path.join(harness.workspaceRoot, "src/old-dir"), { recursive: true });

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-dir-rm-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-dir"),
      itemId: asItemId("item-command-dir-rm"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run directory delete",
        data: {
          item: {
            command: "rm -f src/remove-dir",
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-dir-rm-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-dir"),
      itemId: asItemId("item-command-dir-rm"),
      payload: {
        itemType: "command_execution",
        title: "Run directory delete",
        data: {
          item: {
            command: "rm -f src/remove-dir",
            exitCode: 0,
          },
        },
      },
    });

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-dir-mv-started"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-dir"),
      itemId: asItemId("item-command-dir-mv"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run directory rename",
        data: {
          item: {
            command: "mv src/old-dir src/new-dir",
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-dir-mv-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-dir"),
      itemId: asItemId("item-command-dir-mv"),
      payload: {
        itemType: "command_execution",
        title: "Run directory rename",
        data: {
          item: {
            command: "mv src/old-dir src/new-dir",
            exitCode: 0,
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "evt-command-dir-rm-completed" ||
          activity.id === "evt-command-dir-mv-completed",
      ),
    );

    expect(
      activityInlineDiff(
        thread.activities.find(
          (candidate: ProviderRuntimeTestActivity) =>
            candidate.id === "evt-command-dir-rm-completed",
        ),
      ),
    ).toBeUndefined();
    expect(
      activityInlineDiff(
        thread.activities.find(
          (candidate: ProviderRuntimeTestActivity) =>
            candidate.id === "evt-command-dir-mv-completed",
        ),
      ),
    ).toBeUndefined();
  });

  it("accumulates touched repo files across file-change events in the same turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-file-change-a"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-file-change-merge"),
      itemId: asItemId("item-file-change-a"),
      payload: {
        itemType: "file_change",
        status: "in_progress",
        title: "Edit first file",
        data: {
          item: {
            changes: [
              {
                path: "apps/web/src/session-logic.ts",
                kind: "modified",
                diff: ["@@ -1 +1,2 @@", " export const value = 1;", "+export const next = 2;"].join(
                  "\n",
                ),
              },
            ],
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-file-change-b"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-file-change-merge"),
      itemId: asItemId("item-file-change-b"),
      payload: {
        itemType: "file_change",
        title: "Edit second file",
        data: {
          item: {
            changes: [
              {
                path: "apps/server/src/orchestration/projector.ts",
                kind: "modified",
                diff: ["@@ -1 +1,2 @@", " export const value = 1;", "+export const next = 2;"].join(
                  "\n",
                ),
              },
            ],
          },
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.agentDiffs?.find((diff) => diff.turnId === "turn-file-change-merge")?.files.length ===
        2,
    );

    const agentDiff = thread.agentDiffs?.find((entry) => entry.turnId === "turn-file-change-merge");
    expect(agentDiff?.source).toBe("derived_tool_results");
    expect(agentDiff?.coverage).toBe("partial");
    expect(agentDiff?.files.map((file) => file.path).toSorted()).toEqual([
      "apps/server/src/orchestration/projector.ts",
      "apps/web/src/session-logic.ts",
    ]);
  });

  it("uses the pre-turn baseline even when codex already reserved the current turn count", async () => {
    const harness = await createHarness();
    const baselineRef = checkpointRefForThreadTurn(asThreadId("thread-1"), 0);
    const seededAt = new Date().toISOString();

    execFileSync("git", ["init"], { cwd: harness.workspaceRoot });
    fs.writeFileSync(path.join(harness.workspaceRoot, "tracked.ts"), "export const value = 1;\n");
    await Effect.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.workspaceRoot,
        checkpointRef: baselineRef,
      }),
    );
    fs.writeFileSync(path.join(harness.workspaceRoot, "tracked.ts"), "export const value = 2;\n");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-placeholder-turn-count"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-placeholder-baseline"),
        completedAt: seededAt,
        checkpointRef: checkpointRefForThreadTurn(asThreadId("thread-1"), 1),
        status: "missing",
        files: [],
        assistantMessageId: MessageId.makeUnsafe("assistant:turn-placeholder-baseline"),
        checkpointTurnCount: 1,
        createdAt: seededAt,
      }),
    );

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-placeholder-baseline"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-placeholder-baseline"),
      itemId: asItemId("item-placeholder-baseline"),
      payload: {
        itemType: "file_change",
        status: "in_progress",
        title: "Edit tracked file",
        data: {
          item: {
            changes: [
              {
                path: "tracked.ts",
                kind: "modified",
                diff: ["@@ -1 +1 @@", "-export const value = 1;", "+export const value = 2;"].join(
                  "\n",
                ),
              },
            ],
          },
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.agentDiffs?.find((diff) => diff.turnId === "turn-placeholder-baseline")?.coverage ===
        "complete",
    );

    const agentDiff = thread.agentDiffs?.find(
      (entry) => entry.turnId === "turn-placeholder-baseline",
    );
    expect(agentDiff?.files.map((file) => file.path)).toEqual(["tracked.ts"]);
  });

  it("keeps out-of-repo paths inline but excludes them from persisted turn agent diffs", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-file-change-outside"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-file-change-outside"),
      itemId: asItemId("item-file-change-outside"),
      payload: {
        itemType: "file_change",
        status: "in_progress",
        title: "Mixed file change",
        data: {
          item: {
            changes: [
              {
                path: "apps/web/src/session-logic.ts",
                kind: "modified",
                diff: ["@@ -1 +1,2 @@", " export const value = 1;", "+export const next = 2;"].join(
                  "\n",
                ),
              },
              {
                path: "C:\\Users\\rmurphy\\Desktop\\notes.txt",
                kind: "modified",
                diff: ["@@ -1 +1,2 @@", " hello", "+outside"].join("\n"),
              },
            ],
          },
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.id === "evt-file-change-outside",
        ) &&
        (entry.agentDiffs?.some((diff) => diff.turnId === "turn-file-change-outside") ?? false),
    );

    const toolUpdate = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-file-change-outside",
    );
    const payload =
      toolUpdate?.payload && typeof toolUpdate.payload === "object"
        ? (toolUpdate.payload as Record<string, unknown>)
        : undefined;
    const inlineDiff =
      payload?.inlineDiff && typeof payload.inlineDiff === "object"
        ? (payload.inlineDiff as Record<string, unknown>)
        : undefined;
    const inlineFiles = Array.isArray(inlineDiff?.files)
      ? (inlineDiff!.files as Array<{ path?: unknown }>)
      : [];

    expect(inlineFiles.map((file) => file.path)).toContain(
      "C:\\Users\\rmurphy\\Desktop\\notes.txt",
    );

    const agentDiff = thread.agentDiffs?.find(
      (entry) => entry.turnId === "turn-file-change-outside",
    );
    expect(agentDiff?.files.map((file) => file.path)).toEqual(["apps/web/src/session-logic.ts"]);
  });

  it("filters codex native turn diffs down to the existing tool-scoped files", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-file-change-before-native"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-native-overwrite"),
      itemId: asItemId("item-file-change-before-native"),
      payload: {
        itemType: "file_change",
        status: "in_progress",
        title: "File change",
        data: {
          item: {
            changes: [
              {
                path: "apps/web/src/session-logic.ts",
                kind: "modified",
                diff: ["@@ -1 +1,2 @@", " export const value = 1;", "+export const next = 2;"].join(
                  "\n",
                ),
              },
            ],
          },
        },
      },
    });

    await waitForThread(
      harness.engine,
      (entry) => entry.agentDiffs?.some((diff) => diff.turnId === "turn-native-overwrite") ?? false,
    );

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-native-overwrite-attempt"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-native-overwrite"),
      itemId: asItemId("item-native-overwrite"),
      payload: {
        unifiedDiff: [
          "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts",
          "--- a/apps/web/src/session-logic.ts",
          "+++ b/apps/web/src/session-logic.ts",
          "@@ -1 +1,2 @@",
          " export const value = 1;",
          "+export const next = 2;",
          "",
          "diff --git a/apps/server/src/extra.ts b/apps/server/src/extra.ts",
          "--- a/apps/server/src/extra.ts",
          "+++ b/apps/server/src/extra.ts",
          "@@ -0,0 +1 @@",
          "+widened",
        ].join("\n"),
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.agentDiffs?.find((diff) => diff.turnId === "turn-native-overwrite")?.coverage ===
        "complete",
    );

    const agentDiff = thread.agentDiffs?.find((entry) => entry.turnId === "turn-native-overwrite");
    expect(agentDiff?.source).toBe("derived_tool_results");
    expect(agentDiff?.coverage).toBe("complete");
    expect(agentDiff?.files.map((file) => file.path)).toEqual(["apps/web/src/session-logic.ts"]);
    expect(agentDiff?.files).toHaveLength(1);
    expect(
      agentDiff?.files.find((file) => file.path === "apps/server/src/extra.ts"),
    ).toBeUndefined();
  });

  it("upgrades a summary-only codex tool activity when a later exact turn diff is unambiguous", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-summary-only-before-native"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-summary-upgrade"),
      itemId: asItemId("item-summary-only-before-native"),
      payload: {
        itemType: "file_change",
        status: "in_progress",
        title: "File change",
        data: {
          item: {
            changes: [
              {
                path: "apps/web/src/session-logic.ts",
                kind: { type: "update", move_path: null },
              },
            ],
          },
        },
      },
    });

    await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-summary-only-before-native",
      ),
    );

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-summary-only-native-diff"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-summary-upgrade"),
      payload: {
        unifiedDiff: [
          "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts",
          "--- a/apps/web/src/session-logic.ts",
          "+++ b/apps/web/src/session-logic.ts",
          "@@ -1 +1,2 @@",
          " export const value = 1;",
          "+export const next = 2;",
        ].join("\n"),
      },
    });

    const thread = await waitForThread(harness.engine, (entry) => {
      const activity = entry.activities.find(
        (candidate: ProviderRuntimeTestActivity) =>
          candidate.id === "evt-summary-only-before-native",
      );
      const payload =
        activity?.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : undefined;
      const inlineDiff =
        payload?.inlineDiff && typeof payload.inlineDiff === "object"
          ? (payload.inlineDiff as Record<string, unknown>)
          : undefined;
      return inlineDiff?.availability === "exact_patch";
    });

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.id === "evt-summary-only-before-native",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;
    const inlineDiff =
      payload?.inlineDiff && typeof payload.inlineDiff === "object"
        ? (payload.inlineDiff as Record<string, unknown>)
        : undefined;

    expect(inlineDiff?.availability).toBe("exact_patch");
    expect(inlineDiff?.unifiedDiff).toContain(
      "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts",
    );
  });

  it("does not overwrite an existing exact codex tool diff from a later turn diff update", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-existing-exact-before-native"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-existing-exact-before-native"),
      itemId: asItemId("item-existing-exact-before-native"),
      payload: {
        itemType: "file_change",
        status: "in_progress",
        title: "File change",
        data: {
          item: {
            changes: [
              {
                path: "apps/web/src/session-logic.ts",
                kind: { type: "update", move_path: null },
                diff: [
                  "@@ -1 +1,2 @@",
                  " export const value = 1;",
                  "+export const exactToolPatch = 2;",
                ].join("\n"),
              },
            ],
          },
        },
      },
    });

    await waitForThread(harness.engine, (entry) => {
      const activity = entry.activities.find(
        (candidate: ProviderRuntimeTestActivity) =>
          candidate.id === "evt-existing-exact-before-native",
      );
      const payload =
        activity?.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : undefined;
      const inlineDiff =
        payload?.inlineDiff && typeof payload.inlineDiff === "object"
          ? (payload.inlineDiff as Record<string, unknown>)
          : undefined;
      return inlineDiff?.availability === "exact_patch";
    });

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-existing-exact-native-diff"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-existing-exact-before-native"),
      payload: {
        unifiedDiff: [
          "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts",
          "--- a/apps/web/src/session-logic.ts",
          "+++ b/apps/web/src/session-logic.ts",
          "@@ -1 +1,2 @@",
          " export const value = 1;",
          "+export const nativeTurnPatch = 3;",
        ].join("\n"),
      },
    });

    const thread = await waitForThread(harness.engine, (entry) => {
      const activity = entry.activities.find(
        (candidate: ProviderRuntimeTestActivity) =>
          candidate.id === "evt-existing-exact-before-native",
      );
      const payload =
        activity?.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : undefined;
      const inlineDiff =
        payload?.inlineDiff && typeof payload.inlineDiff === "object"
          ? (payload.inlineDiff as Record<string, unknown>)
          : undefined;
      return typeof inlineDiff?.unifiedDiff === "string";
    });

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) =>
        candidate.id === "evt-existing-exact-before-native",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;
    const inlineDiff =
      payload?.inlineDiff && typeof payload.inlineDiff === "object"
        ? (payload.inlineDiff as Record<string, unknown>)
        : undefined;

    expect(inlineDiff?.availability).toBe("exact_patch");
    expect(String(inlineDiff?.unifiedDiff)).toContain("exactToolPatch");
    expect(String(inlineDiff?.unifiedDiff)).not.toContain("nativeTurnPatch");
  });

  it("upgrades a summary-only codex tool activity when file metadata uses absolute paths", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const absoluteToolDiffArtifactsPath = path.join(
      harness.workspaceRoot,
      "apps/server/src/orchestration/toolDiffArtifacts.ts",
    );

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-summary-only-absolute-path"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-summary-absolute-path-upgrade"),
      itemId: asItemId("item-summary-only-absolute-path"),
      payload: {
        itemType: "file_change",
        status: "in_progress",
        title: "File change",
        data: {
          item: {
            changes: [
              {
                path: absoluteToolDiffArtifactsPath,
                kind: { type: "update", move_path: null },
              },
            ],
          },
        },
      },
    });

    await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-summary-only-absolute-path",
      ),
    );

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-summary-only-absolute-path-native-diff"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-summary-absolute-path-upgrade"),
      payload: {
        unifiedDiff: [
          "diff --git a/apps/server/src/orchestration/toolDiffArtifacts.ts b/apps/server/src/orchestration/toolDiffArtifacts.ts",
          "--- a/apps/server/src/orchestration/toolDiffArtifacts.ts",
          "+++ b/apps/server/src/orchestration/toolDiffArtifacts.ts",
          "@@ -1 +1,2 @@",
          ' import { ProviderKind } from "@forgetools/contracts";',
          "+const updated = true;",
        ].join("\n"),
      },
    });

    const thread = await waitForThread(harness.engine, (entry) => {
      const activity = entry.activities.find(
        (candidate: ProviderRuntimeTestActivity) =>
          candidate.id === "evt-summary-only-absolute-path",
      );
      const payload =
        activity?.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : undefined;
      const inlineDiff =
        payload?.inlineDiff && typeof payload.inlineDiff === "object"
          ? (payload.inlineDiff as Record<string, unknown>)
          : undefined;
      return inlineDiff?.availability === "exact_patch";
    });

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.id === "evt-summary-only-absolute-path",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;
    const inlineDiff =
      payload?.inlineDiff && typeof payload.inlineDiff === "object"
        ? (payload.inlineDiff as Record<string, unknown>)
        : undefined;

    expect(inlineDiff?.availability).toBe("exact_patch");
    expect(inlineDiff?.unifiedDiff).toContain(
      "diff --git a/apps/server/src/orchestration/toolDiffArtifacts.ts",
    );
    expect(inlineDiff?.files).toEqual([
      {
        path: "apps/server/src/orchestration/toolDiffArtifacts.ts",
        kind: "modified",
        additions: 1,
        deletions: 0,
      },
    ]);
  });

  it("keeps same-path codex file-change activities summary-only when item ids are missing", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-no-item-id-a"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-no-item-id-overlap"),
      payload: {
        itemType: "file_change",
        status: "in_progress",
        title: "First file change",
        data: {
          item: {
            changes: [
              {
                path: "apps/web/src/session-logic.ts",
                kind: { type: "update", move_path: null },
              },
            ],
          },
        },
      },
    });

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-no-item-id-b"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-no-item-id-overlap"),
      payload: {
        itemType: "file_change",
        status: "in_progress",
        title: "Second file change",
        data: {
          item: {
            changes: [
              {
                path: "apps/web/src/session-logic.ts",
                kind: { type: "update", move_path: null },
              },
            ],
          },
        },
      },
    });

    await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-no-item-id-b",
      ),
    );

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-no-item-id-native-diff"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-no-item-id-overlap"),
      payload: {
        unifiedDiff: [
          "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts",
          "--- a/apps/web/src/session-logic.ts",
          "+++ b/apps/web/src/session-logic.ts",
          "@@ -1 +1,2 @@",
          " export const value = 1;",
          "+export const next = 2;",
        ].join("\n"),
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.filter(
          (activity: ProviderRuntimeTestActivity) =>
            activity.id === "evt-no-item-id-a" || activity.id === "evt-no-item-id-b",
        ).length === 2,
    );

    for (const activityId of ["evt-no-item-id-a", "evt-no-item-id-b"]) {
      const activity = thread.activities.find(
        (candidate: ProviderRuntimeTestActivity) => candidate.id === activityId,
      );
      const payload =
        activity?.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : undefined;
      const inlineDiff =
        payload?.inlineDiff && typeof payload.inlineDiff === "object"
          ? (payload.inlineDiff as Record<string, unknown>)
          : undefined;

      expect(inlineDiff?.availability).toBe("summary_only");
      expect(inlineDiff?.unifiedDiff).toBeUndefined();
    }
  });

  it("keeps overlapping codex file-change tool activities summary-only when exact ownership is ambiguous", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-overlap-a"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-overlap-summary-only"),
      itemId: asItemId("item-overlap-a"),
      payload: {
        itemType: "file_change",
        status: "in_progress",
        title: "First file change",
        data: {
          item: {
            changes: [
              {
                path: "apps/web/src/session-logic.ts",
                kind: { type: "update", move_path: null },
              },
            ],
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-overlap-b"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-overlap-summary-only"),
      itemId: asItemId("item-overlap-b"),
      payload: {
        itemType: "file_change",
        title: "Second file change",
        data: {
          item: {
            changes: [
              {
                path: "apps/web/src/session-logic.ts",
                kind: { type: "update", move_path: null },
              },
            ],
          },
        },
      },
    });

    await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.id === "evt-overlap-a",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.id === "evt-overlap-b",
        ),
    );

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-overlap-native-diff"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-overlap-summary-only"),
      payload: {
        unifiedDiff: [
          "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts",
          "--- a/apps/web/src/session-logic.ts",
          "+++ b/apps/web/src/session-logic.ts",
          "@@ -1 +1,2 @@",
          " export const value = 1;",
          "+export const next = 2;",
        ].join("\n"),
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.agentDiffs?.find((diff) => diff.turnId === "turn-overlap-summary-only")?.coverage ===
        "complete",
    );

    for (const activityId of ["evt-overlap-a", "evt-overlap-b"]) {
      const activity = thread.activities.find(
        (candidate: ProviderRuntimeTestActivity) => candidate.id === activityId,
      );
      const payload =
        activity?.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : undefined;
      const inlineDiff =
        payload?.inlineDiff && typeof payload.inlineDiff === "object"
          ? (payload.inlineDiff as Record<string, unknown>)
          : undefined;
      expect(inlineDiff?.availability).toBe("summary_only");
      expect(inlineDiff?.unifiedDiff).toBeUndefined();
    }
  });

  it("accepts later claude tool-derived turn diffs as refinements of the same turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-claude-file-change"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-refine"),
      itemId: asItemId("item-claude-file-change"),
      payload: {
        itemType: "file_change",
        status: "in_progress",
        title: "File change",
        data: {
          item: {
            changes: [{ path: "apps/web/src/session-logic.ts", kind: "modified" }],
          },
        },
      },
    });

    await waitForThread(
      harness.engine,
      (entry) =>
        entry.agentDiffs?.find((diff) => diff.turnId === "turn-claude-refine")?.coverage ===
        "partial",
    );

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-claude-turn-diff"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-refine"),
      payload: {
        unifiedDiff: [
          "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts",
          "--- a/apps/web/src/session-logic.ts",
          "+++ b/apps/web/src/session-logic.ts",
          "@@ -1 +1,2 @@",
          " export const value = 1;",
          "+export const next = 2;",
        ].join("\n"),
        source: "derived_tool_results",
        coverage: "complete",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.agentDiffs?.find((diff) => diff.turnId === "turn-claude-refine")?.coverage ===
        "complete",
    );

    const agentDiff = thread.agentDiffs?.find((entry) => entry.turnId === "turn-claude-refine");
    expect(agentDiff?.source).toBe("derived_tool_results");
    expect(agentDiff?.files.map((file) => file.path)).toEqual(["apps/web/src/session-logic.ts"]);
  });

  it("projects context window updates into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 1075,
          totalProcessedTokens: 10_200,
          maxTokens: 128_000,
          inputTokens: 1000,
          cachedInputTokens: 500,
          outputTokens: 50,
          reasoningOutputTokens: 25,
          lastUsedTokens: 1075,
          lastInputTokens: 1000,
          lastCachedInputTokens: 500,
          lastOutputTokens: 50,
          lastReasoningOutputTokens: 25,
          compactsAutomatically: true,
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity).toBeDefined();
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 1075,
      totalProcessedTokens: 10_200,
      maxTokens: 128_000,
      inputTokens: 1000,
      cachedInputTokens: 500,
      outputTokens: 50,
      reasoningOutputTokens: 25,
      lastUsedTokens: 1075,
      compactsAutomatically: true,
    });
  });

  it("projects Codex camelCase token usage payloads into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated-camel"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 126,
          totalProcessedTokens: 11_839,
          maxTokens: 258_400,
          inputTokens: 120,
          cachedInputTokens: 0,
          outputTokens: 6,
          reasoningOutputTokens: 0,
          lastUsedTokens: 126,
          lastInputTokens: 120,
          lastCachedInputTokens: 0,
          lastOutputTokens: 6,
          lastReasoningOutputTokens: 0,
          compactsAutomatically: true,
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 126,
      totalProcessedTokens: 11_839,
      maxTokens: 258_400,
      inputTokens: 120,
      cachedInputTokens: 0,
      outputTokens: 6,
      reasoningOutputTokens: 0,
      lastUsedTokens: 126,
      lastInputTokens: 120,
      lastOutputTokens: 6,
      compactsAutomatically: true,
    });
  });

  it("projects Claude usage snapshots with context window into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated-claude-window"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 31_251,
          lastUsedTokens: 31_251,
          maxTokens: 200_000,
          toolUses: 25,
          durationMs: 43_567,
        },
      },
      raw: {
        source: "claude.sdk.message",
        method: "claude/result/success",
        payload: {},
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 31_251,
      lastUsedTokens: 31_251,
      maxTokens: 200_000,
      toolUses: 25,
      durationMs: 43_567,
    });
  });

  it("projects compacted thread state into context compaction activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.state.changed",
      eventId: asEventId("evt-thread-compacted"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: {
        state: "compacted",
        detail: { source: "provider" },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-compaction",
      ),
    );

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.kind === "context-compaction",
    );
    expect(activity?.summary).toBe("Context compacted");
    expect(activity?.tone).toBe("info");
  });

  it("projects Codex task lifecycle chunks into thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "task.started",
      eventId: asEventId("evt-task-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        taskType: "plan",
      },
    });

    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-task-progress"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        description: "Comparing the desktop rollout chunks to the app-server stream.",
        summary: "Code reviewer is validating the desktop rollout chunks.",
      },
    });

    harness.emit({
      type: "task.completed",
      eventId: asEventId("evt-task-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        status: "completed",
        summary: "<proposed_plan>\n# Plan title\n</proposed_plan>",
      },
    });
    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-task-proposed-plan-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        planMarkdown: "# Plan title",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "task.completed",
        ) &&
        entry.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-1:turn:turn-task-1",
        ),
    );

    const started = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-started",
    );
    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-progress",
    );
    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-completed",
    );

    const progressPayload =
      progress?.payload && typeof progress.payload === "object"
        ? (progress.payload as Record<string, unknown>)
        : undefined;
    const completedPayload =
      completed?.payload && typeof completed.payload === "object"
        ? (completed.payload as Record<string, unknown>)
        : undefined;

    expect(started?.kind).toBe("task.started");
    expect(started?.summary).toBe("Plan task started");
    expect(progress?.kind).toBe("task.progress");
    expect(progressPayload?.detail).toBe("Code reviewer is validating the desktop rollout chunks.");
    expect(progressPayload?.summary).toBe(
      "Code reviewer is validating the desktop rollout chunks.",
    );
    expect(completed?.kind).toBe("task.completed");
    expect(completedPayload?.detail).toBe("<proposed_plan>\n# Plan title\n</proposed_plan>");
    expect(
      thread.proposedPlans.find(
        (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-task-1",
      )?.planMarkdown,
    ).toBe("# Plan title");
  });

  it("projects structured user input request and resolution as thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "user-input.requested",
      eventId: asEventId("evt-user-input-requested"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
      payload: {
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
            ],
          },
        ],
      },
    });

    harness.emit({
      type: "user-input.resolved",
      eventId: asEventId("evt-user-input-resolved"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.requested",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.resolved",
        ),
    );

    const requested = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-requested",
    );
    expect(requested?.kind).toBe("user-input.requested");

    const resolved = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-resolved",
    );
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === "object"
        ? (resolved.payload as Record<string, unknown>)
        : undefined;
    expect(resolved?.kind).toBe("user-input.resolved");
    expect(resolvedPayload?.answers).toEqual({
      sandbox_mode: "workspace-write",
    });
  });

  it("continues processing runtime events after a single event handler failure", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-invalid-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-invalid"),
      itemId: asItemId("item-invalid"),
      payload: {
        streamKind: "assistant_text",
        delta: undefined,
      },
    } as unknown as ProviderRuntimeEvent);

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-after-failure"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-after-failure"),
      payload: {
        message: "runtime still processed",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-after-failure" &&
        entry.session?.lastError === "runtime still processed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime still processed");
  });
});
