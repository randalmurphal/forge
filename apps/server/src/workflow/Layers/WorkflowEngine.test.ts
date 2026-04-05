import {
  CommandId,
  PhaseRunId,
  ProjectId,
  ThreadId,
  WorkflowId,
  WorkflowPhaseId,
  type WorkflowDefinition,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionPhaseRunRepository } from "../../persistence/Services/ProjectionPhaseRuns.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { QualityCheckRunner } from "../Services/QualityCheckRunner.ts";
import { WorkflowRegistry } from "../Services/WorkflowRegistry.ts";
import { WorkflowEngineLive } from "./WorkflowEngine.ts";

const workflowId = WorkflowId.makeUnsafe("workflow-build-loop");
const threadId = ThreadId.makeUnsafe("thread-workflow-1");
const projectId = ProjectId.makeUnsafe("project-1");
const implementPhaseId = WorkflowPhaseId.makeUnsafe("phase-implement");
const reviewPhaseId = WorkflowPhaseId.makeUnsafe("phase-review");
const phaseRunId = PhaseRunId.makeUnsafe("phase-run-1");

const buildLoopWorkflow: WorkflowDefinition = {
  id: workflowId,
  name: "build-loop",
  description: "Build loop",
  builtIn: true,
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
      type: "human",
      gate: {
        after: "done",
        onFail: "stop",
        maxRetries: 0,
      },
    },
  ],
};

function makeWorkflowEngineTestLayer(options: {
  readonly threadWorkflow?: WorkflowDefinition | null;
  readonly threadWorkflowId?: string | null;
  readonly phaseRunsByThread?: ReadonlyArray<any>;
  readonly phaseRunById?: ReadonlyMap<string, any>;
  readonly qualityResults?: ReadonlyArray<any>;
  readonly commands: Array<any>;
  readonly registryWorkflow?: WorkflowDefinition | null;
}) {
  let sequence = 0;

  return WorkflowEngineLive.pipe(
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngineService, {
        getReadModel: () => Effect.die("unused"),
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.empty,
        dispatch: (command: any) =>
          Effect.sync(() => {
            options.commands.push(command);
            sequence += 1;
            return { sequence };
          }),
      } as any),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionThreadRepository, {
        upsert: () => Effect.die("unused"),
        deleteById: () => Effect.die("unused"),
        listByProjectId: () => Effect.die("unused"),
        getById: ({ threadId: requestedThreadId }: { threadId: ThreadId }) =>
          Effect.succeed(
            requestedThreadId === threadId
              ? Option.some({
                  threadId,
                  projectId,
                  title: "Workflow thread",
                  modelSelection: {
                    provider: "codex",
                    model: "gpt-5-codex",
                  },
                  runtimeMode: "approval-required",
                  interactionMode: "default",
                  branch: "forge/thread-workflow-1",
                  worktreePath: "/tmp/forge/thread-workflow-1",
                  latestTurnId: null,
                  createdAt: "2026-04-05T12:00:00.000Z",
                  updatedAt: "2026-04-05T12:00:00.000Z",
                  archivedAt: null,
                  deletedAt: null,
                  parentThreadId: null,
                  phaseRunId: null,
                  workflowId:
                    options.threadWorkflowId === undefined
                      ? workflowId
                      : options.threadWorkflowId === null
                        ? null
                        : WorkflowId.makeUnsafe(options.threadWorkflowId),
                  workflowSnapshot:
                    options.threadWorkflow === undefined
                      ? buildLoopWorkflow
                      : options.threadWorkflow,
                  currentPhaseId: null,
                  patternId: null,
                  role: null,
                  deliberationState: null,
                  bootstrapStatus: "completed",
                  completedAt: null,
                  transcriptArchived: false,
                })
              : Option.none(),
          ),
      } as any),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionProjectRepository, {
        upsert: () => Effect.die("unused"),
        listAll: () => Effect.die("unused"),
        deleteById: () => Effect.die("unused"),
        getById: ({ projectId: requestedProjectId }: { projectId: ProjectId }) =>
          Effect.succeed(
            requestedProjectId === projectId
              ? Option.some({
                  projectId,
                  title: "Project",
                  workspaceRoot: "/tmp/forge/project",
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-04-05T12:00:00.000Z",
                  updatedAt: "2026-04-05T12:00:00.000Z",
                  deletedAt: null,
                })
              : Option.none(),
          ),
      } as any),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionPhaseRunRepository, {
        upsert: () => Effect.die("unused"),
        updateStatus: () => Effect.die("unused"),
        queryByThreadId: () => Effect.succeed(options.phaseRunsByThread ?? []),
        queryById: ({ phaseRunId: requestedPhaseRunId }: { phaseRunId: PhaseRunId }) =>
          Effect.succeed(
            (() => {
              const phaseRun =
                options.phaseRunById?.get(requestedPhaseRunId) ??
                (options.phaseRunsByThread ?? []).find(
                  (entry) => entry.phaseRunId === requestedPhaseRunId,
                ) ??
                null;
              return phaseRun === null ? Option.none() : Option.some(phaseRun);
            })(),
          ),
      } as any),
    ),
    Layer.provideMerge(
      Layer.succeed(WorkflowRegistry, {
        queryAll: () => Effect.succeed([]),
        queryByName: () => Effect.succeed(Option.none()),
        queryById: ({ workflowId: requestedWorkflowId }: { workflowId: WorkflowId }) =>
          Effect.succeed(
            options.registryWorkflow !== undefined &&
              options.registryWorkflow !== null &&
              options.registryWorkflow.id === requestedWorkflowId
              ? Option.some(options.registryWorkflow)
              : Option.none(),
          ),
      } as any),
    ),
    Layer.provideMerge(
      Layer.succeed(QualityCheckRunner, {
        run: () => Effect.succeed(options.qualityResults ?? []),
      } as any),
    ),
  );
}

it.effect("starts the first phase in the workflow", () =>
  Effect.gen(function* () {
    const commands: Array<any> = [];

    yield* Effect.gen(function* () {
      const workflowEngine = yield* WorkflowEngine;
      yield* workflowEngine.startWorkflow({
        threadId,
        workflow: buildLoopWorkflow,
      });
    }).pipe(
      Effect.provide(
        makeWorkflowEngineTestLayer({
          commands,
        }),
      ),
    );

    assert.deepStrictEqual(commands, [
      {
        type: "thread.start-phase",
        commandId: CommandId.makeUnsafe(`workflow:start:${threadId}:${implementPhaseId}:1`),
        threadId,
        phaseId: implementPhaseId,
        phaseName: "implement",
        phaseType: "single-agent",
        iteration: 1,
        createdAt: commands[0]?.createdAt,
      },
    ]);
  }),
);

it.effect("advances to the next phase after a passing gate", () =>
  Effect.gen(function* () {
    const commands: Array<any> = [];
    const gateResult = yield* Effect.gen(function* () {
      const workflowEngine = yield* WorkflowEngine;
      return yield* workflowEngine.advancePhase({
        threadId,
      });
    }).pipe(
      Effect.provide(
        makeWorkflowEngineTestLayer({
          commands,
          phaseRunsByThread: [
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
          ],
        }),
      ),
    );

    assert.strictEqual(gateResult.status, "passed");
    assert.strictEqual(commands.length, 1);
    assert.strictEqual(commands[0]?.type, "thread.start-phase");
    assert.strictEqual(commands[0]?.phaseId, reviewPhaseId);
    assert.strictEqual(commands[0]?.iteration, 1);
  }),
);

it.effect("runs quality checks and retries the phase when a required check fails", () =>
  Effect.gen(function* () {
    const commands: Array<any> = [];
    const qualityWorkflow: WorkflowDefinition = {
      ...buildLoopWorkflow,
      phases: [
        {
          ...buildLoopWorkflow.phases[0]!,
          gate: {
            after: "quality-checks",
            onFail: "retry",
            maxRetries: 3,
            qualityChecks: [{ check: "test", required: true }],
          },
        },
      ],
    };

    const gateResult = yield* Effect.gen(function* () {
      const workflowEngine = yield* WorkflowEngine;
      return yield* workflowEngine.advancePhase({
        threadId,
      });
    }).pipe(
      Effect.provide(
        makeWorkflowEngineTestLayer({
          commands,
          threadWorkflow: qualityWorkflow,
          qualityResults: [
            {
              check: "test",
              passed: false,
              output: "test failed",
            },
          ],
          phaseRunsByThread: [
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
          ],
        }),
      ),
    );

    assert.strictEqual(gateResult.status, "failed");
    assert.deepStrictEqual(gateResult.qualityCheckResults, [
      {
        check: "test",
        passed: false,
        output: "test failed",
      },
    ]);
    assert.deepStrictEqual(
      commands.map((command) => command.type),
      ["thread.quality-check-start", "thread.quality-check-complete", "thread.start-phase"],
    );
    assert.strictEqual(commands[2]?.phaseId, implementPhaseId);
    assert.strictEqual(commands[2]?.iteration, 2);
  }),
);

it.effect("opens a gate request and waits when a human approval gate is reached", () =>
  Effect.gen(function* () {
    const commands: Array<any> = [];
    const humanWorkflow: WorkflowDefinition = {
      ...buildLoopWorkflow,
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
            after: "human-approval",
            onFail: "retry",
            retryPhase: "implement",
            maxRetries: 3,
          },
        },
      ],
    };

    const gateResult = yield* Effect.gen(function* () {
      const workflowEngine = yield* WorkflowEngine;
      return yield* workflowEngine.advancePhase({
        threadId,
      });
    }).pipe(
      Effect.provide(
        makeWorkflowEngineTestLayer({
          commands,
          threadWorkflow: humanWorkflow,
          phaseRunsByThread: [
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
          ],
        }),
      ),
    );

    assert.strictEqual(gateResult.status, "waiting-human");
    assert.deepStrictEqual(
      commands.map((command) => command.type),
      ["request.open"],
    );
    assert.strictEqual(commands[0]?.payload.type, "gate");
    assert.strictEqual(commands[0]?.payload.phaseRunId, phaseRunId);
  }),
);

it.effect("uses a provided gate result override instead of reopening a resolved human gate", () =>
  Effect.gen(function* () {
    const commands: Array<any> = [];
    const humanWorkflow: WorkflowDefinition = {
      ...buildLoopWorkflow,
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
            after: "human-approval",
            onFail: "retry",
            retryPhase: "implement",
            maxRetries: 3,
          },
        },
        buildLoopWorkflow.phases[1]!,
      ],
    };

    const gateResult = yield* Effect.gen(function* () {
      const workflowEngine = yield* WorkflowEngine;
      return yield* workflowEngine.advancePhase({
        threadId,
        gateResultOverride: {
          status: "passed",
          humanDecision: "approve",
          evaluatedAt: "2026-04-05T12:02:00.000Z",
        },
      });
    }).pipe(
      Effect.provide(
        makeWorkflowEngineTestLayer({
          commands,
          threadWorkflow: humanWorkflow,
          phaseRunsByThread: [
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
          ],
        }),
      ),
    );

    assert.strictEqual(gateResult.status, "passed");
    assert.deepStrictEqual(
      commands.map((command) => command.type),
      ["thread.start-phase"],
    );
    assert.strictEqual(commands[0]?.phaseId, reviewPhaseId);
    assert.strictEqual(commands[0]?.iteration, 1);
  }),
);

it.effect("stops advancing when the last phase is already complete", () =>
  Effect.gen(function* () {
    const commands: Array<any> = [];

    const gateResult = yield* Effect.gen(function* () {
      const workflowEngine = yield* WorkflowEngine;
      return yield* workflowEngine.advancePhase({
        threadId,
      });
    }).pipe(
      Effect.provide(
        makeWorkflowEngineTestLayer({
          commands,
          phaseRunsByThread: [
            {
              phaseRunId,
              threadId,
              workflowId,
              phaseId: reviewPhaseId,
              phaseName: "review",
              phaseType: "human",
              sandboxMode: "workspace-write",
              iteration: 1,
              status: "completed",
              gateResult: null,
              qualityChecks: null,
              deliberationState: null,
              startedAt: "2026-04-05T12:02:00.000Z",
              completedAt: "2026-04-05T12:03:00.000Z",
            },
          ],
        }),
      ),
    );

    assert.strictEqual(gateResult.status, "passed");
    assert.deepStrictEqual(commands, []);
  }),
);
