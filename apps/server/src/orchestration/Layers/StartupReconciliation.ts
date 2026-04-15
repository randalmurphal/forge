/**
 * StartupReconciliation — Detects and repairs stale orchestration state on server boot.
 *
 * When the server restarts, provider sessions are torn down but the orchestration
 * projection layer may still show threads/turns/phases/channels as active. This
 * module dispatches proper orchestration commands to bring the projection back into
 * a consistent state before reactors begin streaming.
 *
 * @module StartupReconciliation
 */
import {
  type ChannelId,
  CommandId,
  type ForgeCommand,
  InteractiveRequestId,
  type OrchestrationReadModel,
  PhaseRunId,
  type ThreadId,
  TurnId,
} from "@forgetools/contracts";
import { Cause, Effect, Layer } from "effect";

import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  StartupReconciliation,
  type ReconciliationResult,
  type StartupReconciliationShape,
} from "../Services/StartupReconciliation.ts";

function reconcileCommandId(tag: string): CommandId {
  return CommandId.makeUnsafe(`reconcile:${tag}:${crypto.randomUUID()}`);
}

function nowIso(): string {
  return new Date().toISOString();
}

interface MutableReconciliationResult {
  staleSessionsReconciled: number;
  staleTurnsReconciled: number;
  stalePhaseRunsReconciled: number;
  staleChannelsClosed: number;
  stalePendingApprovalsResolved: number;
  staleInteractiveRequestsMarkedStale: number;
  errors: Array<{ readonly threadId: string; readonly error: string }>;
}

function emptyResult(): MutableReconciliationResult {
  return {
    staleSessionsReconciled: 0,
    staleTurnsReconciled: 0,
    stalePhaseRunsReconciled: 0,
    staleChannelsClosed: 0,
    stalePendingApprovalsResolved: 0,
    staleInteractiveRequestsMarkedStale: 0,
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Stale-state detection helpers (pure, no service dependencies)
// ---------------------------------------------------------------------------

function findStaleThreadIds(readModel: OrchestrationReadModel): ThreadId[] {
  return readModel.threads
    .filter(
      (thread) =>
        thread.session !== null &&
        (thread.session.status === "running" || thread.session.status === "starting"),
    )
    .map((thread) => thread.id);
}

function findOpenChannelIds(readModel: OrchestrationReadModel): ChannelId[] {
  return readModel.channels
    .filter((channel) => channel.status === "open")
    .map((channel) => channel.id);
}

/**
 * Collect phase-run IDs that should be failed because their owning or child
 * threads had stale sessions. Returns tuples of (ownerThreadId, phaseRunId).
 */
function findStalePhaseRuns(
  readModel: OrchestrationReadModel,
  staleThreadIds: ReadonlySet<string>,
): Array<{ ownerThreadId: ThreadId; phaseRunId: string }> {
  const results: Array<{ ownerThreadId: ThreadId; phaseRunId: string }> = [];
  const seen = new Set<string>();

  for (const thread of readModel.threads) {
    if (thread.phaseRunId === null) continue;
    if (seen.has(thread.phaseRunId)) continue;

    const parentStale = thread.parentThreadId !== null && staleThreadIds.has(thread.parentThreadId);
    const selfStale = staleThreadIds.has(thread.id);
    if (!parentStale && !selfStale) continue;

    // The parent thread that owns this phase run is the one whose
    // childThreadIds include this thread.
    const ownerThread =
      thread.parentThreadId !== null
        ? readModel.threads.find((t) => t.id === thread.parentThreadId)
        : null;
    if (!ownerThread) continue;

    seen.add(thread.phaseRunId);
    results.push({ ownerThreadId: ownerThread.id, phaseRunId: thread.phaseRunId });
  }

  return results;
}

export const makeStartupReconciliation = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const projectionPendingApprovalRepository = yield* ProjectionPendingApprovalRepository;

  const dispatch = (command: Parameters<typeof orchestrationEngine.dispatch>[0]) =>
    orchestrationEngine.dispatch(command).pipe(Effect.asVoid);

  const dispatchForgeCommand = (command: ForgeCommand) =>
    dispatch(command as unknown as Parameters<typeof orchestrationEngine.dispatch>[0]);

  // ---------------------------------------------------------------------------
  // Per-category reconciliation
  // ---------------------------------------------------------------------------

  const reconcileInteractiveRequests = Effect.fn("reconcileInteractiveRequests")(function* (
    readModel: OrchestrationReadModel,
    result: MutableReconciliationResult,
  ) {
    const pendingRequests = readModel.pendingRequests;
    if (pendingRequests.length === 0) return;

    const createdAt = nowIso();
    for (const request of pendingRequests) {
      const dispatched = yield* dispatchForgeCommand({
        type: "request.mark-stale",
        commandId: reconcileCommandId(`request:${request.id}`),
        requestId: InteractiveRequestId.makeUnsafe(request.id),
        reason: "Request orphaned by server restart",
        createdAt,
      }).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logDebug("reconciliation: skipping interactive request (already resolved)", {
            requestId: request.id,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      );
      if (dispatched) {
        result.staleInteractiveRequestsMarkedStale++;
      }
    }
  });

  const reconcilePendingApprovals = Effect.fn("reconcilePendingApprovals")(function* (
    threadId: ThreadId,
    result: MutableReconciliationResult,
  ) {
    const approvals = yield* projectionPendingApprovalRepository.listByThreadId({ threadId });
    const pendingApprovals = approvals.filter((approval) => approval.status === "pending");
    if (pendingApprovals.length === 0) return;

    const createdAt = nowIso();
    for (const approval of pendingApprovals) {
      const dispatched = yield* dispatchForgeCommand({
        type: "request.mark-stale",
        commandId: reconcileCommandId(`approval:${approval.requestId}`),
        requestId: InteractiveRequestId.makeUnsafe(approval.requestId),
        reason: "Legacy approval request orphaned by server restart",
        createdAt,
      } as ForgeCommand).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logDebug("reconciliation: skipping pending approval (dispatch failed)", {
            requestId: approval.requestId,
            threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      );
      if (dispatched) {
        result.stalePendingApprovalsResolved++;
      }
    }
  });

  const reconcilePhaseRuns = Effect.fn("reconcilePhaseRuns")(function* (
    stalePhaseRuns: ReadonlyArray<{ ownerThreadId: ThreadId; phaseRunId: string }>,
    result: MutableReconciliationResult,
  ) {
    if (stalePhaseRuns.length === 0) return;

    const createdAt = nowIso();
    for (const { ownerThreadId, phaseRunId } of stalePhaseRuns) {
      const dispatched = yield* dispatchForgeCommand({
        type: "thread.fail-phase",
        commandId: reconcileCommandId(`phase:${phaseRunId}`),
        threadId: ownerThreadId,
        phaseRunId: PhaseRunId.makeUnsafe(phaseRunId),
        error: "Phase terminated by server restart",
        createdAt,
      } as ForgeCommand).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logDebug("reconciliation: skipping phase run (already completed or invalid)", {
            phaseRunId,
            threadId: ownerThreadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      );
      if (dispatched) {
        result.stalePhaseRunsReconciled++;
      }
    }
  });

  const reconcileChannels = Effect.fn("reconcileChannels")(function* (
    staleChannelIds: ReadonlyArray<ChannelId>,
    result: MutableReconciliationResult,
  ) {
    if (staleChannelIds.length === 0) return;

    const createdAt = nowIso();
    for (const channelId of staleChannelIds) {
      const dispatched = yield* dispatchForgeCommand({
        type: "channel.close",
        commandId: reconcileCommandId(`channel:${channelId}`),
        channelId,
        createdAt,
      }).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logDebug("reconciliation: skipping channel (already closed)", {
            channelId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      );
      if (dispatched) {
        result.staleChannelsClosed++;
      }
    }
  });

  const reconcileTurns = Effect.fn("reconcileTurns")(function* (
    threadId: ThreadId,
    result: MutableReconciliationResult,
  ) {
    const turns = yield* projectionTurnRepository.listByThreadId({ threadId });
    const runningTurns = turns.filter((turn) => turn.state === "running" && turn.turnId !== null);
    if (runningTurns.length === 0) return;

    const createdAt = nowIso();
    for (const turn of runningTurns) {
      const dispatched = yield* dispatch({
        type: "thread.turn.interrupt",
        commandId: reconcileCommandId(`turn:${turn.turnId}`),
        threadId,
        turnId: TurnId.makeUnsafe(turn.turnId!),
        createdAt,
      }).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logDebug("reconciliation: skipping turn (dispatch failed)", {
            turnId: turn.turnId,
            threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      );
      if (dispatched) {
        result.staleTurnsReconciled++;
      }
    }
  });

  const reconcileSession = Effect.fn("reconcileSession")(function* (
    thread: OrchestrationReadModel["threads"][number],
    result: MutableReconciliationResult,
  ) {
    const createdAt = nowIso();
    yield* dispatch({
      type: "thread.session.set",
      commandId: reconcileCommandId(`session:${thread.id}`),
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        runtimeMode: thread.session?.runtimeMode ?? "full-access",
        activeTurnId: null,
        lastError: "Session terminated by server restart",
        updatedAt: createdAt,
      },
      createdAt,
    });
    result.staleSessionsReconciled++;
  });

  // ---------------------------------------------------------------------------
  // Top-level reconcile
  // ---------------------------------------------------------------------------

  const reconcileAll = Effect.fn("StartupReconciliation.reconcileAll")(function* () {
    const readModel = yield* orchestrationEngine.getRuntimeReadModel();
    const result = emptyResult();

    const staleThreadIds = findStaleThreadIds(readModel);
    const openChannelIds = findOpenChannelIds(readModel);
    const stalePhaseRuns = findStalePhaseRuns(readModel, new Set(staleThreadIds));
    const hasPendingRequests = readModel.pendingRequests.length > 0;

    if (
      staleThreadIds.length === 0 &&
      openChannelIds.length === 0 &&
      stalePhaseRuns.length === 0 &&
      !hasPendingRequests
    ) {
      yield* Effect.logDebug("startup reconciliation: no stale state detected");
      return result;
    }

    yield* Effect.logInfo("startup reconciliation: detected stale state", {
      staleSessionCount: staleThreadIds.length,
      openChannelCount: openChannelIds.length,
      stalePhaseRunCount: stalePhaseRuns.length,
      pendingRequestCount: readModel.pendingRequests.length,
    });

    // 1. Interactive requests
    yield* reconcileInteractiveRequests(readModel, result);

    // 2-6. Per-thread reconciliation (approvals, turns, sessions)
    for (const threadId of staleThreadIds) {
      yield* Effect.gen(function* () {
        const thread = readModel.threads.find((t) => t.id === threadId);
        if (!thread) return;

        // 2. Pending approvals
        yield* reconcilePendingApprovals(threadId, result);

        // 5. Running turns (before session set, needs turnId)
        yield* reconcileTurns(threadId, result);

        // 6. Session → stopped
        yield* reconcileSession(thread, result);
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          result.errors.push({
            threadId,
            error: Cause.pretty(cause),
          });
          return Effect.logWarning("startup reconciliation: thread reconciliation failed", {
            threadId,
            cause: Cause.pretty(cause),
          });
        }),
      );
    }

    // 3. Phase runs
    yield* reconcilePhaseRuns(stalePhaseRuns, result);

    // 4. Channels (all open channels, not just those from stale sessions)
    yield* reconcileChannels(openChannelIds, result);

    return result;
  });

  const reconcile: StartupReconciliationShape["reconcile"] = () =>
    reconcileAll().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("startup reconciliation failed (non-fatal)", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(emptyResult())),
      ),
      Effect.map((result) => result as ReconciliationResult),
    );

  return { reconcile } satisfies StartupReconciliationShape;
});

export const StartupReconciliationLive = Layer.effect(
  StartupReconciliation,
  makeStartupReconciliation,
);
