import {
  ChannelId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  TurnId,
} from "@forgetools/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../../persistence/Layers/ProjectionPendingApprovals.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { makeStartupReconciliation } from "./StartupReconciliation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ServerConfig } from "../../config.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

function now() {
  return new Date().toISOString();
}

async function createTestSystem() {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "forge-startup-reconciliation-test-",
  });
  const orchestrationLayer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
    ),
    ProjectionTurnRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory)),
    ProjectionPendingApprovalRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory)),
  ).pipe(Layer.provideMerge(ServerConfigLayer), Layer.provideMerge(NodeServices.layer));
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const turnRepo = await runtime.runPromise(Effect.service(ProjectionTurnRepository));
  const reconciliation = await runtime.runPromise(makeStartupReconciliation);
  return {
    engine,
    turnRepo,
    reconciliation,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

type TestSystem = Awaited<ReturnType<typeof createTestSystem>>;

async function createProjectAndThread(system: TestSystem) {
  const projectId = ProjectId.makeUnsafe(crypto.randomUUID());
  const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
  const createdAt = now();
  await system.run(
    system.engine.dispatch({
      type: "project.create",
      commandId: CommandId.makeUnsafe(crypto.randomUUID()),
      projectId,
      title: "test-project",
      workspaceRoot: `/tmp/test-${crypto.randomUUID()}`,
      defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
      createdAt,
    }),
  );
  await system.run(
    system.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe(crypto.randomUUID()),
      threadId,
      projectId,
      title: "test-thread",
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt,
    }),
  );
  return { projectId, threadId };
}

async function setSessionStatus(
  system: TestSystem,
  threadId: ThreadId,
  status: "running" | "starting" | "ready" | "stopped",
  activeTurnId: TurnId | null = null,
) {
  await system.run(
    system.engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe(crypto.randomUUID()),
      threadId,
      session: {
        threadId,
        status,
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId,
        lastError: null,
        updatedAt: now(),
      },
      createdAt: now(),
    }),
  );
}

async function insertRunningTurn(system: TestSystem, threadId: ThreadId): Promise<TurnId> {
  const turnId = TurnId.makeUnsafe(crypto.randomUUID());
  await system.run(
    system.turnRepo.upsertByTurnId({
      threadId,
      turnId,
      pendingMessageId: null,
      sourceProposedPlanThreadId: null,
      sourceProposedPlanId: null,
      assistantMessageId: null,
      state: "running",
      requestedAt: now(),
      startedAt: now(),
      completedAt: null,
      checkpointTurnCount: null,
      checkpointRef: null,
      checkpointStatus: null,
      checkpointFiles: [],
    }),
  );
  return turnId;
}

describe("StartupReconciliation", () => {
  // ---------------------------------------------------------------------------
  // No-op when clean
  // ---------------------------------------------------------------------------

  it("returns empty result when no stale state exists", async () => {
    const system = await createTestSystem();
    try {
      const result = await system.run(system.reconciliation.reconcile());
      expect(result.staleSessionsReconciled).toBe(0);
      expect(result.staleTurnsReconciled).toBe(0);
      expect(result.stalePhaseRunsReconciled).toBe(0);
      expect(result.staleChannelsClosed).toBe(0);
      expect(result.stalePendingApprovalsResolved).toBe(0);
      expect(result.staleInteractiveRequestsMarkedStale).toBe(0);
      expect(result.errors).toHaveLength(0);
    } finally {
      await system.dispose();
    }
  });

  // ---------------------------------------------------------------------------
  // Session reconciliation
  // ---------------------------------------------------------------------------

  it("reconciles stale running session to stopped", async () => {
    const system = await createTestSystem();
    try {
      const { threadId } = await createProjectAndThread(system);
      await setSessionStatus(system, threadId, "running");

      const readModelBefore = await system.run(system.engine.getReadModel());
      expect(readModelBefore.threads.find((t) => t.id === threadId)?.session?.status).toBe(
        "running",
      );

      const result = await system.run(system.reconciliation.reconcile());
      expect(result.staleSessionsReconciled).toBe(1);

      const readModelAfter = await system.run(system.engine.getReadModel());
      const thread = readModelAfter.threads.find((t) => t.id === threadId);
      expect(thread?.session?.status).toBe("stopped");
      expect(thread?.session?.lastError).toBe("Session terminated by server restart");
    } finally {
      await system.dispose();
    }
  });

  it("reconciles stale starting session to stopped", async () => {
    const system = await createTestSystem();
    try {
      const { threadId } = await createProjectAndThread(system);
      await setSessionStatus(system, threadId, "starting");

      const result = await system.run(system.reconciliation.reconcile());
      expect(result.staleSessionsReconciled).toBe(1);

      const readModel = await system.run(system.engine.getReadModel());
      expect(readModel.threads.find((t) => t.id === threadId)?.session?.status).toBe("stopped");
    } finally {
      await system.dispose();
    }
  });

  it("does not touch sessions already in ready state", async () => {
    const system = await createTestSystem();
    try {
      const { threadId } = await createProjectAndThread(system);
      await setSessionStatus(system, threadId, "ready");

      const result = await system.run(system.reconciliation.reconcile());
      expect(result.staleSessionsReconciled).toBe(0);

      const readModel = await system.run(system.engine.getReadModel());
      expect(readModel.threads.find((t) => t.id === threadId)?.session?.status).toBe("ready");
    } finally {
      await system.dispose();
    }
  });

  it("reconciles multiple stale threads independently", async () => {
    const system = await createTestSystem();
    try {
      const { threadId: threadId1 } = await createProjectAndThread(system);
      const { threadId: threadId2 } = await createProjectAndThread(system);

      await setSessionStatus(system, threadId1, "running");
      await setSessionStatus(system, threadId2, "running");

      const result = await system.run(system.reconciliation.reconcile());
      expect(result.staleSessionsReconciled).toBe(2);
      expect(result.errors).toHaveLength(0);

      const readModel = await system.run(system.engine.getReadModel());
      expect(readModel.threads.find((t) => t.id === threadId1)?.session?.status).toBe("stopped");
      expect(readModel.threads.find((t) => t.id === threadId2)?.session?.status).toBe("stopped");
    } finally {
      await system.dispose();
    }
  });

  // ---------------------------------------------------------------------------
  // Turn reconciliation
  // ---------------------------------------------------------------------------

  it("interrupts running turns for stale sessions", async () => {
    const system = await createTestSystem();
    try {
      const { threadId } = await createProjectAndThread(system);
      await setSessionStatus(system, threadId, "running");
      const turnId = await insertRunningTurn(system, threadId);

      const result = await system.run(system.reconciliation.reconcile());
      expect(result.staleTurnsReconciled).toBe(1);
      expect(result.staleSessionsReconciled).toBe(1);

      // Verify the turn was interrupted in the projection
      const turns = await system.run(system.turnRepo.listByThreadId({ threadId }));
      const reconciled = turns.find((t) => t.turnId === turnId);
      expect(reconciled?.state).toBe("interrupted");
    } finally {
      await system.dispose();
    }
  });

  // ---------------------------------------------------------------------------
  // Channel reconciliation
  // ---------------------------------------------------------------------------

  it("closes open channels", async () => {
    const system = await createTestSystem();
    try {
      const { threadId } = await createProjectAndThread(system);
      await setSessionStatus(system, threadId, "running");

      // Create an open channel via the channel.create command
      const channelId = ChannelId.makeUnsafe(`channel:${crypto.randomUUID()}`);
      await system.run(
        system.engine.dispatch({
          type: "channel.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          channelId,
          threadId,
          channelType: "deliberation",
          createdAt: now(),
        } as unknown as Parameters<typeof system.engine.dispatch>[0]),
      );

      const readModelBefore = await system.run(system.engine.getReadModel());
      const channelBefore = readModelBefore.channels.find((c) => c.id === channelId);
      expect(channelBefore?.status).toBe("open");

      const result = await system.run(system.reconciliation.reconcile());
      expect(result.staleChannelsClosed).toBe(1);

      const readModelAfter = await system.run(system.engine.getReadModel());
      const channelAfter = readModelAfter.channels.find((c) => c.id === channelId);
      expect(channelAfter?.status).toBe("closed");
    } finally {
      await system.dispose();
    }
  });

  // ---------------------------------------------------------------------------
  // Idempotency
  // ---------------------------------------------------------------------------

  it("is idempotent — running reconcile twice produces no errors", async () => {
    const system = await createTestSystem();
    try {
      const { threadId } = await createProjectAndThread(system);
      await setSessionStatus(system, threadId, "running");
      await insertRunningTurn(system, threadId);

      const firstResult = await system.run(system.reconciliation.reconcile());
      expect(firstResult.staleSessionsReconciled).toBe(1);
      expect(firstResult.staleTurnsReconciled).toBe(1);

      // Second run: session is stopped, turn is interrupted — nothing to do
      const secondResult = await system.run(system.reconciliation.reconcile());
      expect(secondResult.staleSessionsReconciled).toBe(0);
      expect(secondResult.staleTurnsReconciled).toBe(0);
      expect(secondResult.errors).toHaveLength(0);
    } finally {
      await system.dispose();
    }
  });
});
