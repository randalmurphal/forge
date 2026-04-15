import type {
  GateResult,
  OrchestrationReadModel,
  OrchestrationThread,
  PhaseOutputEntry,
  QualityCheckReference,
  QualityCheckResult,
} from "@forgetools/contracts";

export type OrchestrationRuntimeThread = OrchestrationThread;

export type OrchestrationRuntimePhaseRun = OrchestrationReadModel["phaseRuns"][number] & {
  readonly outputs?: ReadonlyArray<PhaseOutputEntry>;
  readonly gateResult?: GateResult | null;
  readonly qualityCheckReferences?: ReadonlyArray<QualityCheckReference> | null;
  readonly qualityCheckResults?: ReadonlyArray<QualityCheckResult> | null;
  readonly failure?: string | null;
};

export type OrchestrationRuntimeReadModel = Omit<
  OrchestrationReadModel,
  "threads" | "phaseRuns"
> & {
  readonly threads: ReadonlyArray<OrchestrationRuntimeThread>;
  readonly phaseRuns: ReadonlyArray<OrchestrationRuntimePhaseRun>;
};

export function toRuntimeThread(thread: OrchestrationThread): OrchestrationRuntimeThread {
  return {
    ...thread,
    activities: [],
    ...(thread.checkpointHistory !== undefined ? { checkpointHistory: [] } : {}),
    ...(thread.agentDiffs !== undefined ? { agentDiffs: [] } : {}),
  };
}

export function toRuntimeReadModel(
  readModel: OrchestrationReadModel,
): OrchestrationRuntimeReadModel {
  return {
    ...readModel,
    threads: readModel.threads.map(toRuntimeThread),
    phaseRuns: readModel.phaseRuns,
  };
}
