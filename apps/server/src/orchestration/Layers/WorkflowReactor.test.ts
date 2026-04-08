import {
  CommandId,
  EventId,
  InteractiveRequestId,
  PhaseRunId,
  ProjectId,
  ThreadId,
  WorkflowId,
  WorkflowPhaseId,
  type ForgeEvent,
  type WorkflowDefinition,
} from "@forgetools/contracts";
import { Effect, Exit, Layer, ManagedRuntime, Option, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ProjectionInteractiveRequestRepository } from "../../persistence/Services/ProjectionInteractiveRequests.ts";
import { ProjectionPhaseRunRepository } from "../../persistence/Services/ProjectionPhaseRuns.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { QualityCheckRunner } from "../../workflow/Services/QualityCheckRunner.ts";
import { WorkflowRegistry } from "../../workflow/Services/WorkflowRegistry.ts";
import { WorkflowEngineLive } from "../../workflow/Layers/WorkflowEngine.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { WorkflowReactor } from "../Services/WorkflowReactor.ts";
import { WorkflowReactorLive } from "./WorkflowReactor.ts";

const projectId = ProjectId.makeUnsafe("project-workflow-reactor");
const threadId = ThreadId.makeUnsafe("thread-workflow-reactor");
const workflowId = WorkflowId.makeUnsafe("workflow-reactor");
const implementPhaseId = WorkflowPhaseId.makeUnsafe("phase-implement");
const reviewPhaseId = WorkflowPhaseId.makeUnsafe("phase-review");
const phaseRunId = PhaseRunId.makeUnsafe("phase-run-1");

const autoWorkflow: WorkflowDefinition = {
  id: workflowId,
  name: "auto-workflow",
  description: "Auto workflow",
  builtIn: true,
  projectId: null,
  createdAt: "2026-04-05T12:00:00.000Z",
  updatedAt: "2026-04-05T12:00:00.000Z",
  phases: [
    {
      id: implementPhaseId,
      name: "implement",
      type: "single-agent",
      agent: {
        prompt: "implement",
        output: { type: "conversation" },
      },
      gate: {
        after: "auto-continue",
        onFail: "retry",
        maxRetries: 3,
      },
    },
    {
      id: reviewPhaseId,
      name: "review",
      type: "single-agent",
      agent: {
        prompt: "review",
        output: { type: "conversation" },
      },
      gate: {
        after: "done",
        onFail: "stop",
        maxRetries: 0,
      },
    },
  ],
};

const humanWorkflow: WorkflowDefinition = {
  ...autoWorkflow,
  name: "human-workflow",
  phases: [
    {
      ...autoWorkflow.phases[0]!,
      gate: {
        after: "human-approval",
        onFail: "retry",
        retryPhase: "implement",
        maxRetries: 3,
      },
    },
    autoWorkflow.phases[1]!,
  ],
};

function makeWorkflowEvent(
  input: Omit<
    ForgeEvent,
    "eventId" | "sequence" | "occurredAt" | "causationEventId" | "correlationId" | "metadata"
  >,
  sequence: number,
): ForgeEvent {
  return {
    ...input,
    sequence,
    eventId: EventId.makeUnsafe(`event-${sequence}`),
    occurredAt: "2026-04-05T12:00:00.000Z",
    causationEventId: null,
    correlationId: null,
    metadata: {},
  } as ForgeEvent;
}

describe("WorkflowReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<any, any> | null = null;
  let scope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  async function createHarness(options?: { readonly workflow?: WorkflowDefinition }) {
    const workflow = options?.workflow ?? autoWorkflow;
    const threads = new Map<string, any>();
    const projects = new Map<string, any>();
    const phaseRunsByThread = new Map<string, ReadonlyArray<any>>();
    const requests = new Map<string, any>();
    const workflows = new Map<string, WorkflowDefinition>([[workflow.id, workflow]]);
    const commands: Array<any> = [];
    const commandReceipts = new Map<string, number>();
    let sequence = 0;
    const pubsub = await Effect.runPromise(PubSub.unbounded<ForgeEvent>());
    let eventSequence = 0;

    projects.set(projectId, {
      projectId,
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-04-05T12:00:00.000Z",
      updatedAt: "2026-04-05T12:00:00.000Z",
      deletedAt: null,
    });

    const orchestrationService = {
      getReadModel: () => Effect.die("unused"),
      readEvents: () => Stream.empty,
      streamDomainEvents: Stream.fromPubSub(pubsub),
      dispatch: (command: any) =>
        Effect.sync(() => {
          const existingSequence = commandReceipts.get(command.commandId);
          if (existingSequence !== undefined) {
            return { sequence: existingSequence };
          }

          sequence += 1;
          commandReceipts.set(command.commandId, sequence);
          commands.push(command);
          return { sequence };
        }),
    } as any;

    const sharedDependencies = Layer.mergeAll(
      Layer.succeed(OrchestrationEngineService, orchestrationService),
      Layer.succeed(ProjectionThreadRepository, {
        upsert: () => Effect.die("unused"),
        deleteById: () => Effect.die("unused"),
        listByProjectId: () => Effect.die("unused"),
        getById: ({ threadId: requestedThreadId }: { threadId: ThreadId }) =>
          Effect.succeed(
            (() => {
              const thread = threads.get(requestedThreadId);
              return thread === undefined ? Option.none() : Option.some(thread);
            })(),
          ),
      } as any),
      Layer.succeed(ProjectionProjectRepository, {
        upsert: () => Effect.die("unused"),
        listAll: () => Effect.die("unused"),
        deleteById: () => Effect.die("unused"),
        getById: ({ projectId: requestedProjectId }: { projectId: ProjectId }) =>
          Effect.succeed(
            (() => {
              const project = projects.get(requestedProjectId);
              return project === undefined ? Option.none() : Option.some(project);
            })(),
          ),
      } as any),
      Layer.succeed(ProjectionPhaseRunRepository, {
        upsert: () => Effect.die("unused"),
        updateStatus: () => Effect.die("unused"),
        queryByThreadId: ({ threadId: requestedThreadId }: { threadId: ThreadId }) =>
          Effect.succeed(phaseRunsByThread.get(requestedThreadId) ?? []),
        queryById: ({ phaseRunId: requestedPhaseRunId }: { phaseRunId: PhaseRunId }) =>
          Effect.succeed(
            (() => {
              for (const phaseRuns of phaseRunsByThread.values()) {
                const phaseRun = phaseRuns.find(
                  (entry) => entry.phaseRunId === requestedPhaseRunId,
                );
                if (phaseRun) {
                  return Option.some(phaseRun);
                }
              }
              return Option.none();
            })(),
          ),
      } as any),
      Layer.succeed(ProjectionInteractiveRequestRepository, {
        upsert: () => Effect.die("unused"),
        queryByThreadId: () => Effect.die("unused"),
        queryPending: () => Effect.die("unused"),
        updateStatus: () => Effect.die("unused"),
        markStale: () => Effect.die("unused"),
        queryById: ({ requestId }: { requestId: InteractiveRequestId }) =>
          Effect.succeed(
            (() => {
              const request = requests.get(requestId);
              return request === undefined ? Option.none() : Option.some(request);
            })(),
          ),
      } as any),
      Layer.succeed(WorkflowRegistry, {
        queryAll: () => Effect.succeed(Array.from(workflows.values())),
        queryByName: ({ name }: { name: string }) =>
          Effect.succeed(
            (() => {
              const resolved = Array.from(workflows.values()).find((entry) => entry.name === name);
              return resolved === undefined ? Option.none() : Option.some(resolved);
            })(),
          ),
        queryById: ({ workflowId }: { workflowId: WorkflowId }) =>
          Effect.succeed(
            (() => {
              const resolved = workflows.get(workflowId);
              return resolved === undefined ? Option.none() : Option.some(resolved);
            })(),
          ),
      } as any),
      Layer.succeed(QualityCheckRunner, {
        run: () => Effect.succeed([]),
      } as any),
    );

    const workflowEngineLayer = WorkflowEngineLive.pipe(Layer.provide(sharedDependencies));
    const layer = WorkflowReactorLive.pipe(
      Layer.provideMerge(workflowEngineLayer),
      Layer.provideMerge(sharedDependencies),
    );

    runtime = ManagedRuntime.make(layer as any);
    const reactor = await runtime.runPromise(Effect.service(WorkflowReactor));

    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    await Effect.runPromise(Effect.sleep("1 millis"));

    const publish = async (event: ForgeEvent) => {
      await Effect.runPromise(PubSub.publish(pubsub, event));
    };

    return {
      commands,
      setThread: (thread: any) => {
        threads.set(thread.threadId, thread);
      },
      setPhaseRuns: (runs: ReadonlyArray<any>) => {
        phaseRunsByThread.set(threadId, runs);
      },
      setRequest: (request: any) => {
        requests.set(request.requestId, request);
      },
      publishEvent: async (event: any) => {
        eventSequence += 1;
        await publish(makeWorkflowEvent(event, eventSequence));
        // PubSub publication can win the race against the reactor fiber's
        // enqueue, so yield once before callers drain the worker.
        await Effect.runPromise(Effect.sleep("0 millis"));
      },
      drain: () => Effect.runPromise(reactor.drain),
    };
  }

  it("starts the first workflow phase when the thread is ready at creation time", async () => {
    const harness = await createHarness();
    harness.setThread({
      threadId,
      projectId,
      title: "Workflow thread",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: "forge/thread-workflow-reactor",
      worktreePath: "/tmp/thread-workflow-reactor",
      latestTurnId: null,
      createdAt: "2026-04-05T12:00:00.000Z",
      updatedAt: "2026-04-05T12:00:00.000Z",
      archivedAt: null,
      deletedAt: null,
      parentThreadId: null,
      phaseRunId: null,
      workflowId,
      workflowSnapshot: autoWorkflow,
      currentPhaseId: null,
      discussionId: null,
      role: null,
      deliberationState: null,
      bootstrapStatus: "completed",
      completedAt: null,
      transcriptArchived: false,
    });

    await harness.publishEvent({
      type: "thread.created",
      aggregateKind: "thread",
      aggregateId: threadId,
      commandId: CommandId.makeUnsafe("cmd-thread-created"),
      payload: {
        threadId,
        projectId,
        parentThreadId: null,
        phaseRunId: null,
        sessionType: "workflow",
        title: "Workflow thread",
        description: "",
        workflowId,
        runtimeMode: "approval-required",
        model: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        provider: null,
        role: null,
        branch: "forge/thread-workflow-reactor",
        bootstrapStatus: "completed",
        createdAt: "2026-04-05T12:00:00.000Z",
        updatedAt: "2026-04-05T12:00:00.000Z",
      },
    });

    await harness.drain();

    expect(harness.commands).toHaveLength(1);
    expect(harness.commands[0]).toMatchObject({
      type: "thread.start-phase",
      commandId: CommandId.makeUnsafe(`workflow:start:${threadId}:${implementPhaseId}:1`),
      threadId,
      phaseId: implementPhaseId,
      iteration: 1,
    });
  });

  it("advances to the next phase when a completed phase passes its gate", async () => {
    const harness = await createHarness();
    harness.setThread({
      threadId,
      projectId,
      title: "Workflow thread",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: "forge/thread-workflow-reactor",
      worktreePath: "/tmp/thread-workflow-reactor",
      latestTurnId: null,
      createdAt: "2026-04-05T12:00:00.000Z",
      updatedAt: "2026-04-05T12:00:00.000Z",
      archivedAt: null,
      deletedAt: null,
      parentThreadId: null,
      phaseRunId: null,
      workflowId,
      workflowSnapshot: autoWorkflow,
      currentPhaseId: null,
      discussionId: null,
      role: null,
      deliberationState: null,
      bootstrapStatus: "completed",
      completedAt: null,
      transcriptArchived: false,
    });
    harness.setPhaseRuns([
      {
        phaseRunId,
        threadId,
        workflowId,
        phaseId: implementPhaseId,
        phaseName: "implement",
        phaseType: "single-agent",
        sandboxMode: "workspace-write",
        iteration: 1,
        status: "completed",
        gateResult: null,
        qualityChecks: null,
        deliberationState: null,
        startedAt: "2026-04-05T12:00:00.000Z",
        completedAt: "2026-04-05T12:01:00.000Z",
      },
    ]);

    await harness.publishEvent({
      type: "thread.phase-completed",
      aggregateKind: "thread",
      aggregateId: threadId,
      commandId: CommandId.makeUnsafe("cmd-phase-completed"),
      payload: {
        threadId,
        phaseRunId,
        outputs: [],
        completedAt: "2026-04-05T12:01:00.000Z",
      },
    });

    await harness.drain();

    expect(harness.commands).toHaveLength(1);
    expect(harness.commands[0]).toMatchObject({
      type: "thread.start-phase",
      commandId: CommandId.makeUnsafe(`workflow:start:${threadId}:${reviewPhaseId}:1`),
      threadId,
      phaseId: reviewPhaseId,
      iteration: 1,
    });
  });

  it("retries the current phase from a resolved human gate rejection without reopening the request", async () => {
    const harness = await createHarness({ workflow: humanWorkflow });
    const gateRequestId = InteractiveRequestId.makeUnsafe("request-gate-1");
    harness.setThread({
      threadId,
      projectId,
      title: "Workflow thread",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: "forge/thread-workflow-reactor",
      worktreePath: "/tmp/thread-workflow-reactor",
      latestTurnId: null,
      createdAt: "2026-04-05T12:00:00.000Z",
      updatedAt: "2026-04-05T12:00:00.000Z",
      archivedAt: null,
      deletedAt: null,
      parentThreadId: null,
      phaseRunId: null,
      workflowId,
      workflowSnapshot: humanWorkflow,
      currentPhaseId: null,
      discussionId: null,
      role: null,
      deliberationState: null,
      bootstrapStatus: "completed",
      completedAt: null,
      transcriptArchived: false,
    });
    harness.setPhaseRuns([
      {
        phaseRunId,
        threadId,
        workflowId,
        phaseId: implementPhaseId,
        phaseName: "implement",
        phaseType: "single-agent",
        sandboxMode: "workspace-write",
        iteration: 1,
        status: "completed",
        gateResult: null,
        qualityChecks: null,
        deliberationState: null,
        startedAt: "2026-04-05T12:00:00.000Z",
        completedAt: "2026-04-05T12:01:00.000Z",
      },
    ]);
    harness.setRequest({
      requestId: gateRequestId,
      threadId,
      childThreadId: null,
      phaseRunId,
      type: "gate",
      status: "resolved",
      payload: {
        type: "gate",
        gateType: "human-approval",
        phaseRunId,
      },
      resolvedWith: {
        decision: "reject",
        correction: "Fix the edge case first.",
      },
      createdAt: "2026-04-05T12:02:00.000Z",
      resolvedAt: "2026-04-05T12:03:00.000Z",
      staleReason: null,
    });

    await harness.publishEvent({
      type: "request.resolved",
      aggregateKind: "request",
      aggregateId: gateRequestId,
      commandId: CommandId.makeUnsafe("cmd-request-resolved"),
      payload: {
        requestId: gateRequestId,
        resolvedWith: {
          decision: "reject",
          correction: "Fix the edge case first.",
        },
        resolvedAt: "2026-04-05T12:03:00.000Z",
      },
    });

    await harness.drain();

    expect(harness.commands).toHaveLength(1);
    expect(harness.commands[0]).toMatchObject({
      type: "thread.start-phase",
      commandId: CommandId.makeUnsafe(`workflow:start:${threadId}:${implementPhaseId}:2`),
      threadId,
      phaseId: implementPhaseId,
      iteration: 2,
    });
  });

  it("waits for bootstrap completion before starting the workflow after a retry flow", async () => {
    const harness = await createHarness();
    const bootstrapRequestId = InteractiveRequestId.makeUnsafe("request-bootstrap-1");
    harness.setThread({
      threadId,
      projectId,
      title: "Workflow thread",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: "forge/thread-workflow-reactor",
      worktreePath: null,
      latestTurnId: null,
      createdAt: "2026-04-05T12:00:00.000Z",
      updatedAt: "2026-04-05T12:00:00.000Z",
      archivedAt: null,
      deletedAt: null,
      parentThreadId: null,
      phaseRunId: null,
      workflowId,
      workflowSnapshot: autoWorkflow,
      currentPhaseId: null,
      discussionId: null,
      role: null,
      deliberationState: null,
      bootstrapStatus: "failed",
      completedAt: null,
      transcriptArchived: false,
    });

    await harness.publishEvent({
      type: "thread.created",
      aggregateKind: "thread",
      aggregateId: threadId,
      commandId: CommandId.makeUnsafe("cmd-thread-created-bootstrap"),
      payload: {
        threadId,
        projectId,
        parentThreadId: null,
        phaseRunId: null,
        sessionType: "workflow",
        title: "Workflow thread",
        description: "",
        workflowId,
        runtimeMode: "approval-required",
        model: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        provider: null,
        role: null,
        branch: "forge/thread-workflow-reactor",
        bootstrapStatus: "failed",
        createdAt: "2026-04-05T12:00:00.000Z",
        updatedAt: "2026-04-05T12:00:00.000Z",
      },
    });
    harness.setRequest({
      requestId: bootstrapRequestId,
      threadId,
      childThreadId: null,
      phaseRunId: null,
      type: "bootstrap-failed",
      status: "resolved",
      payload: {
        type: "bootstrap-failed",
        error: "bootstrap failed",
        stdout: "stdout",
        command: "bootstrap",
      },
      resolvedWith: {
        action: "retry",
      },
      createdAt: "2026-04-05T12:01:00.000Z",
      resolvedAt: "2026-04-05T12:02:00.000Z",
      staleReason: null,
    });
    await harness.publishEvent({
      type: "request.resolved",
      aggregateKind: "request",
      aggregateId: bootstrapRequestId,
      commandId: CommandId.makeUnsafe("cmd-bootstrap-request-resolved"),
      payload: {
        requestId: bootstrapRequestId,
        resolvedWith: {
          action: "retry",
        },
        resolvedAt: "2026-04-05T12:02:00.000Z",
      },
    });

    await harness.drain();
    expect(harness.commands).toHaveLength(0);

    harness.setThread({
      threadId,
      projectId,
      title: "Workflow thread",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: "forge/thread-workflow-reactor",
      worktreePath: "/tmp/thread-workflow-reactor",
      latestTurnId: null,
      createdAt: "2026-04-05T12:00:00.000Z",
      updatedAt: "2026-04-05T12:03:00.000Z",
      archivedAt: null,
      deletedAt: null,
      parentThreadId: null,
      phaseRunId: null,
      workflowId,
      workflowSnapshot: autoWorkflow,
      currentPhaseId: null,
      discussionId: null,
      role: null,
      deliberationState: null,
      bootstrapStatus: "completed",
      completedAt: null,
      transcriptArchived: false,
    });
    await harness.publishEvent({
      type: "thread.bootstrap-completed",
      aggregateKind: "thread",
      aggregateId: threadId,
      commandId: CommandId.makeUnsafe("cmd-bootstrap-completed"),
      payload: {
        threadId,
        completedAt: "2026-04-05T12:03:00.000Z",
      },
    } as ForgeEvent);

    await harness.drain();

    expect(harness.commands).toHaveLength(1);
    expect(harness.commands[0]).toMatchObject({
      type: "thread.start-phase",
      commandId: CommandId.makeUnsafe(`workflow:start:${threadId}:${implementPhaseId}:1`),
      threadId,
      phaseId: implementPhaseId,
      iteration: 1,
    });
  });

  it("treats replayed phase-completed events as idempotent through command deduplication", async () => {
    const harness = await createHarness();
    const replayedEvent = {
      type: "thread.phase-completed",
      aggregateKind: "thread",
      aggregateId: threadId,
      commandId: CommandId.makeUnsafe("cmd-phase-completed-replayed"),
      payload: {
        threadId,
        phaseRunId,
        outputs: [],
        completedAt: "2026-04-05T12:01:00.000Z",
      },
    };

    harness.setThread({
      threadId,
      projectId,
      title: "Workflow thread",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: "forge/thread-workflow-reactor",
      worktreePath: "/tmp/thread-workflow-reactor",
      latestTurnId: null,
      createdAt: "2026-04-05T12:00:00.000Z",
      updatedAt: "2026-04-05T12:00:00.000Z",
      archivedAt: null,
      deletedAt: null,
      parentThreadId: null,
      phaseRunId: null,
      workflowId,
      workflowSnapshot: autoWorkflow,
      currentPhaseId: null,
      discussionId: null,
      role: null,
      deliberationState: null,
      bootstrapStatus: "completed",
      completedAt: null,
      transcriptArchived: false,
    });
    harness.setPhaseRuns([
      {
        phaseRunId,
        threadId,
        workflowId,
        phaseId: implementPhaseId,
        phaseName: "implement",
        phaseType: "single-agent",
        sandboxMode: "workspace-write",
        iteration: 1,
        status: "completed",
        gateResult: null,
        qualityChecks: null,
        deliberationState: null,
        startedAt: "2026-04-05T12:00:00.000Z",
        completedAt: "2026-04-05T12:01:00.000Z",
      },
    ]);

    await harness.publishEvent(replayedEvent);
    await harness.publishEvent(replayedEvent);

    await harness.drain();

    expect(harness.commands).toHaveLength(1);
    expect(harness.commands[0]?.commandId).toBe(
      CommandId.makeUnsafe(`workflow:start:${threadId}:${reviewPhaseId}:1`),
    );
  });
});
