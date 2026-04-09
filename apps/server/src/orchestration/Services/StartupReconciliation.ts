import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface ReconciliationResult {
  readonly staleSessionsReconciled: number;
  readonly staleTurnsReconciled: number;
  readonly stalePhaseRunsReconciled: number;
  readonly staleChannelsClosed: number;
  readonly stalePendingApprovalsResolved: number;
  readonly staleInteractiveRequestsMarkedStale: number;
  readonly errors: ReadonlyArray<{ readonly threadId: string; readonly error: string }>;
}

export interface StartupReconciliationShape {
  readonly reconcile: () => Effect.Effect<ReconciliationResult>;
}

export class StartupReconciliation extends ServiceMap.Service<
  StartupReconciliation,
  StartupReconciliationShape
>()("forge/orchestration/Services/StartupReconciliation") {}
