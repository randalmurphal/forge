import {
  type ForgeEvent,
  type GateResult,
  type InteractiveRequestResolvedPayload,
  type ThreadBootstrapCompletedPayload,
  type ThreadBootstrapSkippedPayload,
  type ThreadPhaseCompletedPayload,
  type ThreadId,
  type WorkflowDefinition,
} from "@forgetools/contracts";
import { makeDrainableWorker } from "@forgetools/shared/DrainableWorker";
import { Cause, Effect, Layer, Option, Stream } from "effect";

import { ProjectionInteractiveRequestRepository } from "../../persistence/Services/ProjectionInteractiveRequests.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { WorkflowEngine } from "../../workflow/Services/WorkflowEngine.ts";
import { WorkflowRegistry } from "../../workflow/Services/WorkflowRegistry.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { WorkflowReactor, type WorkflowReactorShape } from "../Services/WorkflowReactor.ts";

type WorkflowReactorEvent = Extract<
  ForgeEvent,
  {
    type:
      | "thread.created"
      | "thread.phase-completed"
      | "thread.bootstrap-completed"
      | "thread.bootstrap-skipped"
      | "request.resolved";
  }
>;

function nowIso(): string {
  return new Date().toISOString();
}

export const makeWorkflowReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const workflowEngine = yield* WorkflowEngine;
  const threads = yield* ProjectionThreadRepository;
  const interactiveRequests = yield* ProjectionInteractiveRequestRepository;
  const workflowRegistry = yield* WorkflowRegistry;

  const resolveWorkflow = Effect.fn("WorkflowReactor.resolveWorkflow")(function* (
    threadId: ThreadId,
  ) {
    const threadOption = yield* threads.getById({ threadId });
    if (Option.isNone(threadOption)) {
      return Option.none<WorkflowDefinition>();
    }

    const thread = threadOption.value;
    if (thread.workflowSnapshot !== null) {
      return Option.some(thread.workflowSnapshot);
    }

    if (thread.workflowId === null) {
      return Option.none<WorkflowDefinition>();
    }

    return yield* workflowRegistry.queryById({
      workflowId: thread.workflowId,
    });
  });

  const shouldStartWorkflowOnThreadCreated = Effect.fn(
    "WorkflowReactor.shouldStartWorkflowOnThreadCreated",
  )(function* (threadId: ThreadId) {
    const threadOption = yield* threads.getById({ threadId });
    if (Option.isNone(threadOption)) {
      return false;
    }

    const thread = threadOption.value;
    const hasWorkflow = thread.workflowSnapshot !== null || thread.workflowId !== null;
    if (!hasWorkflow) {
      return false;
    }

    if (thread.worktreePath !== null) {
      return true;
    }

    return thread.bootstrapStatus === "completed" || thread.bootstrapStatus === "skipped";
  });

  const startWorkflowIfAvailable = Effect.fn("WorkflowReactor.startWorkflowIfAvailable")(function* (
    threadId: ThreadId,
  ) {
    const workflowOption = yield* resolveWorkflow(threadId);
    if (Option.isNone(workflowOption)) {
      return;
    }

    yield* workflowEngine.startWorkflow({
      threadId,
      workflow: workflowOption.value,
    });
  });

  const processThreadCreated = Effect.fn("WorkflowReactor.processThreadCreated")(function* (
    event: Extract<WorkflowReactorEvent, { type: "thread.created" }>,
  ) {
    const threadId = event.payload.threadId;
    if (!(yield* shouldStartWorkflowOnThreadCreated(threadId))) {
      return;
    }

    yield* startWorkflowIfAvailable(threadId);
  });

  const processBootstrapReady = Effect.fn("WorkflowReactor.processBootstrapReady")(function* (
    event: Extract<
      WorkflowReactorEvent,
      {
        type: "thread.bootstrap-completed" | "thread.bootstrap-skipped";
      }
    >,
  ) {
    const payload = event.payload as
      | ThreadBootstrapCompletedPayload
      | ThreadBootstrapSkippedPayload;
    yield* startWorkflowIfAvailable(payload.threadId);
  });

  const processPhaseCompleted = Effect.fn("WorkflowReactor.processPhaseCompleted")(function* (
    event: Extract<WorkflowReactorEvent, { type: "thread.phase-completed" }>,
  ) {
    const payload = event.payload as ThreadPhaseCompletedPayload;
    yield* workflowEngine.advancePhase({
      threadId: payload.threadId,
    });
  });

  const processRequestResolved = Effect.fn("WorkflowReactor.processRequestResolved")(function* (
    event: Extract<WorkflowReactorEvent, { type: "request.resolved" }>,
  ) {
    const payload = event.payload as InteractiveRequestResolvedPayload;
    const requestOption = yield* interactiveRequests.queryById({
      requestId: payload.requestId,
    });
    if (Option.isNone(requestOption)) {
      return;
    }

    const request = requestOption.value;
    if (
      request.type !== "gate" ||
      request.payload.type !== "gate" ||
      request.resolvedWith === null
    ) {
      return;
    }

    const resolvedWith = request.resolvedWith;
    if (!("decision" in resolvedWith)) {
      return;
    }
    if (resolvedWith.decision !== "approve" && resolvedWith.decision !== "reject") {
      return;
    }

    const evaluatedAt = request.resolvedAt ?? payload.resolvedAt ?? nowIso();
    const gateResultOverride: GateResult =
      resolvedWith.decision === "approve"
        ? {
            status: "passed",
            humanDecision: "approve",
            ...(request.payload.qualityCheckResults !== undefined
              ? { qualityCheckResults: [...request.payload.qualityCheckResults] }
              : {}),
            evaluatedAt,
          }
        : {
            status: "failed",
            humanDecision: "reject",
            ...(request.payload.qualityCheckResults !== undefined
              ? { qualityCheckResults: [...request.payload.qualityCheckResults] }
              : {}),
            ...("correction" in resolvedWith && resolvedWith.correction !== undefined
              ? { correction: resolvedWith.correction }
              : {}),
            evaluatedAt,
          };

    yield* workflowEngine.advancePhase({
      threadId: request.threadId,
      gateResultOverride,
    });
  });

  const processEvent = Effect.fn("WorkflowReactor.processEvent")(function* (
    event: WorkflowReactorEvent,
  ) {
    switch (event.type) {
      case "thread.created":
        yield* processThreadCreated(event);
        return;
      case "thread.phase-completed":
        yield* processPhaseCompleted(event);
        return;
      case "thread.bootstrap-completed":
      case "thread.bootstrap-skipped":
        yield* processBootstrapReady(event);
        return;
      case "request.resolved":
        yield* processRequestResolved(event);
        return;
    }
  });

  const processEventSafely = (event: WorkflowReactorEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        return Effect.logError("workflow reactor failed to process orchestration event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processEventSafely);

  const start: WorkflowReactorShape["start"] = () =>
    Stream.runForEach(
      Stream.filter(
        orchestrationEngine.streamDomainEvents as unknown as Stream.Stream<ForgeEvent>,
        (event) =>
          event.type === "thread.created" ||
          event.type === "thread.phase-completed" ||
          event.type === "thread.bootstrap-completed" ||
          event.type === "thread.bootstrap-skipped" ||
          event.type === "request.resolved",
      ).pipe(Stream.map((event) => event as WorkflowReactorEvent)),
      worker.enqueue,
    ).pipe(Effect.forkScoped, Effect.asVoid);

  return {
    start,
    drain: worker.drain,
  } satisfies WorkflowReactorShape;
});

export const WorkflowReactorLive = Layer.effect(WorkflowReactor, makeWorkflowReactor);
