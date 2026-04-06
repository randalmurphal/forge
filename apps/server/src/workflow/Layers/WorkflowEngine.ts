import {
  CommandId,
  InteractiveRequestId,
  type ForgeCommand,
  type GateResult,
  type PhaseGate,
  type PhaseRunId,
  type QualityCheckResult,
  type ThreadId,
  type WorkflowDefinition,
  type WorkflowPhase,
} from "@forgetools/contracts";
import { Effect, Layer, Option } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionPhaseRunRepository } from "../../persistence/Services/ProjectionPhaseRuns.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { WorkflowEngine, type WorkflowEngineShape } from "../Services/WorkflowEngine.ts";
import { QualityCheckRunner } from "../Services/QualityCheckRunner.ts";
import { WorkflowRegistry } from "../Services/WorkflowRegistry.ts";
import {
  WorkflowEnginePhaseNotFoundError,
  WorkflowEnginePhaseRunNotFoundError,
  WorkflowEngineProjectNotFoundError,
  WorkflowEngineThreadNotFoundError,
  WorkflowEngineWorkflowNotFoundError,
} from "../Errors.ts";

function nowIso(): string {
  return new Date().toISOString();
}

function phaseStartCommandId(
  threadId: ThreadId,
  phaseId: WorkflowPhase["id"],
  iteration: number,
): CommandId {
  return CommandId.makeUnsafe(`workflow:start:${threadId}:${phaseId}:${iteration}`);
}

function qualityCheckStartCommandId(phaseRunId: PhaseRunId): CommandId {
  return CommandId.makeUnsafe(`workflow:quality-start:${phaseRunId}`);
}

function qualityCheckCompleteCommandId(phaseRunId: PhaseRunId): CommandId {
  return CommandId.makeUnsafe(`workflow:quality-complete:${phaseRunId}`);
}

function gateRequestCommandId(phaseRunId: PhaseRunId): CommandId {
  return CommandId.makeUnsafe(`workflow:gate-request:${phaseRunId}`);
}

function gateRequestId(phaseRunId: PhaseRunId): InteractiveRequestId {
  return InteractiveRequestId.makeUnsafe(`gate-request:${phaseRunId}`);
}

function requiredChecksPassed(
  checks: ReadonlyArray<NonNullable<PhaseGate["qualityChecks"]>[number]>,
  results: ReadonlyArray<QualityCheckResult>,
): boolean {
  return checks.every((check) => {
    if (!check.required) {
      return true;
    }

    const result = results.find((entry) => entry.check === check.check);
    return result?.passed === true;
  });
}

function workflowPhaseById(
  workflow: WorkflowDefinition,
  phaseId: WorkflowPhase["id"],
): WorkflowPhase | undefined {
  return workflow.phases.find((phase) => phase.id === phaseId);
}

function workflowPhaseByName(
  workflow: WorkflowDefinition,
  phaseName: string,
): WorkflowPhase | undefined {
  return workflow.phases.find((phase) => phase.name === phaseName);
}

export const makeWorkflowEngine = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const phaseRuns = yield* ProjectionPhaseRunRepository;
  const threads = yield* ProjectionThreadRepository;
  const projects = yield* ProjectionProjectRepository;
  const workflowRegistry = yield* WorkflowRegistry;
  const qualityCheckRunner = yield* QualityCheckRunner;

  const dispatchForgeCommand = (command: ForgeCommand) =>
    orchestrationEngine.dispatch(
      command as unknown as Parameters<typeof orchestrationEngine.dispatch>[0],
    );

  const resolveThreadContext = Effect.fn("WorkflowEngine.resolveThreadContext")(function* (
    threadId: ThreadId,
  ) {
    const threadOption = yield* threads.getById({ threadId });
    if (Option.isNone(threadOption)) {
      return yield* new WorkflowEngineThreadNotFoundError({
        threadId,
      });
    }

    const thread = threadOption.value;
    const projectOption = yield* projects.getById({
      projectId: thread.projectId,
    });
    if (Option.isNone(projectOption)) {
      return yield* new WorkflowEngineProjectNotFoundError({
        threadId,
        projectId: thread.projectId,
      });
    }

    const workflow =
      thread.workflowSnapshot === null
        ? yield* Effect.gen(function* () {
            if (thread.workflowId === null) {
              return yield* new WorkflowEngineWorkflowNotFoundError({
                threadId,
              });
            }

            const workflowOption = yield* workflowRegistry.queryById({
              workflowId: thread.workflowId,
            });
            if (Option.isNone(workflowOption)) {
              return yield* new WorkflowEngineWorkflowNotFoundError({
                threadId,
                workflowId: thread.workflowId,
              });
            }

            return workflowOption.value;
          })
        : thread.workflowSnapshot;

    return {
      thread,
      project: projectOption.value,
      workflow,
    } as const;
  });

  const resolvePhaseRun = Effect.fn("WorkflowEngine.resolvePhaseRun")(function* (
    threadId: ThreadId,
    phaseRunId: PhaseRunId,
  ) {
    const phaseRunOption = yield* phaseRuns.queryById({ phaseRunId });
    if (Option.isNone(phaseRunOption) || phaseRunOption.value.threadId !== threadId) {
      return yield* new WorkflowEnginePhaseRunNotFoundError({
        threadId,
        phaseRunId,
        detail: "Phase run was not found on the workflow thread.",
      });
    }

    return phaseRunOption.value;
  });

  const startPhase = Effect.fn("WorkflowEngine.startPhase")(function* (input: {
    readonly threadId: ThreadId;
    readonly phase: WorkflowPhase;
    readonly iteration: number;
  }) {
    yield* dispatchForgeCommand({
      type: "thread.start-phase",
      commandId: phaseStartCommandId(input.threadId, input.phase.id, input.iteration),
      threadId: input.threadId,
      phaseId: input.phase.id,
      phaseName: input.phase.name,
      phaseType: input.phase.type,
      iteration: input.iteration,
      createdAt: nowIso(),
    });
  });

  const evaluateGate: WorkflowEngineShape["evaluateGate"] = (input) =>
    Effect.gen(function* () {
      const [{ thread, project }, phaseRun] = yield* Effect.all([
        resolveThreadContext(input.threadId),
        resolvePhaseRun(input.threadId, input.phaseRunId),
      ]);

      if (input.gate.after === "quality-checks") {
        const checks = input.gate.qualityChecks ?? [];
        const results =
          phaseRun.qualityChecks ??
          (yield* Effect.gen(function* () {
            yield* dispatchForgeCommand({
              type: "thread.quality-check-start",
              commandId: qualityCheckStartCommandId(input.phaseRunId),
              threadId: input.threadId,
              phaseRunId: input.phaseRunId,
              checks,
              createdAt: nowIso(),
            });

            const executedResults = yield* qualityCheckRunner.run({
              projectRoot: project.workspaceRoot,
              worktreeDir: thread.worktreePath ?? project.workspaceRoot,
              checks,
            });

            yield* dispatchForgeCommand({
              type: "thread.quality-check-complete",
              commandId: qualityCheckCompleteCommandId(input.phaseRunId),
              threadId: input.threadId,
              phaseRunId: input.phaseRunId,
              results: [...executedResults],
              createdAt: nowIso(),
            });

            return executedResults;
          }));

        return {
          status: requiredChecksPassed(checks, results) ? "passed" : "failed",
          qualityCheckResults: [...results],
          evaluatedAt: nowIso(),
        } satisfies GateResult;
      }

      if (input.gate.after === "human-approval") {
        yield* dispatchForgeCommand({
          type: "request.open",
          commandId: gateRequestCommandId(input.phaseRunId),
          requestId: gateRequestId(input.phaseRunId),
          threadId: input.threadId,
          phaseRunId: input.phaseRunId,
          requestType: "gate",
          payload: {
            type: "gate",
            gateType: "human-approval",
            phaseRunId: input.phaseRunId,
            ...(phaseRun.qualityChecks !== null
              ? { qualityCheckResults: [...phaseRun.qualityChecks] }
              : {}),
          },
          createdAt: nowIso(),
        });

        return {
          status: "waiting-human",
          evaluatedAt: nowIso(),
        } satisfies GateResult;
      }

      return {
        status: "passed",
        evaluatedAt: nowIso(),
      } satisfies GateResult;
    });

  const advancePhase: WorkflowEngineShape["advancePhase"] = (input) =>
    Effect.gen(function* () {
      const { thread, workflow } = yield* resolveThreadContext(input.threadId);
      const threadPhaseRuns = yield* phaseRuns.queryByThreadId({
        threadId: input.threadId,
      });

      if (threadPhaseRuns.some((phaseRun) => phaseRun.status === "running")) {
        const latestCompleted = [...threadPhaseRuns]
          .toReversed()
          .find((phaseRun) => phaseRun.status === "completed");
        return (
          latestCompleted?.gateResult ?? {
            status: "passed",
            evaluatedAt: nowIso(),
          }
        );
      }

      const currentPhaseRun = [...threadPhaseRuns]
        .toReversed()
        .find((phaseRun) => phaseRun.status === "completed");
      if (!currentPhaseRun) {
        return yield* new WorkflowEnginePhaseRunNotFoundError({
          threadId: input.threadId,
          detail: "No completed phase run is available to advance from.",
        });
      }

      const currentPhase = workflowPhaseById(workflow, currentPhaseRun.phaseId);
      if (!currentPhase) {
        return yield* new WorkflowEnginePhaseNotFoundError({
          workflowId: workflow.id,
          detail: `Phase '${currentPhaseRun.phaseId}' is missing from the workflow definition.`,
        });
      }

      const gateResult =
        input.gateResultOverride ??
        (yield* evaluateGate({
          threadId: input.threadId,
          phaseRunId: currentPhaseRun.phaseRunId,
          gate: currentPhase.gate,
        }));

      if (gateResult.status === "waiting-human") {
        return gateResult;
      }

      const currentPhaseIndex = workflow.phases.findIndex((phase) => phase.id === currentPhase.id);
      if (currentPhaseIndex < 0) {
        return yield* new WorkflowEnginePhaseNotFoundError({
          workflowId: workflow.id,
          detail: `Phase '${currentPhase.id}' is not ordered in the workflow definition.`,
        });
      }

      if (gateResult.status === "passed") {
        if (currentPhase.gate.after === "done") {
          return gateResult;
        }

        const nextPhase = workflow.phases[currentPhaseIndex + 1];
        if (!nextPhase) {
          return gateResult;
        }

        const nextIteration =
          Math.max(
            0,
            ...threadPhaseRuns
              .filter((phaseRun) => phaseRun.phaseId === nextPhase.id)
              .map((phaseRun) => phaseRun.iteration),
          ) + 1;

        yield* startPhase({
          threadId: thread.threadId,
          phase: nextPhase,
          iteration: nextIteration,
        });
        return gateResult;
      }

      if (currentPhase.gate.onFail === "stop") {
        return gateResult;
      }

      const retryPhase =
        currentPhase.gate.onFail === "retry"
          ? currentPhase
          : currentPhase.gate.retryPhase === undefined
            ? undefined
            : workflowPhaseByName(workflow, currentPhase.gate.retryPhase);

      if (!retryPhase) {
        return yield* new WorkflowEnginePhaseNotFoundError({
          workflowId: workflow.id,
          detail:
            currentPhase.gate.onFail === "retry"
              ? `Phase '${currentPhase.id}' cannot be retried because it is missing.`
              : `Retry phase '${currentPhase.gate.retryPhase ?? ""}' is missing from the workflow definition.`,
        });
      }

      const nextIteration =
        Math.max(
          0,
          ...threadPhaseRuns
            .filter((phaseRun) => phaseRun.phaseId === retryPhase.id)
            .map((phaseRun) => phaseRun.iteration),
        ) + 1;

      if (nextIteration > currentPhase.gate.maxRetries + 1) {
        return gateResult;
      }

      yield* startPhase({
        threadId: thread.threadId,
        phase: retryPhase,
        iteration: nextIteration,
      });

      return gateResult;
    });

  const startWorkflow: WorkflowEngineShape["startWorkflow"] = (input) =>
    Effect.gen(function* () {
      const firstPhase = input.workflow.phases[0];
      if (!firstPhase) {
        return yield* new WorkflowEnginePhaseNotFoundError({
          workflowId: input.workflow.id,
          detail: "Workflow does not contain a first phase.",
        });
      }

      yield* startPhase({
        threadId: input.threadId,
        phase: firstPhase,
        iteration: 1,
      });
    });

  return {
    startWorkflow,
    advancePhase,
    evaluateGate,
  } satisfies WorkflowEngineShape;
});

export const WorkflowEngineLive = Layer.effect(WorkflowEngine, makeWorkflowEngine);
