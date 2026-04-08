import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChannelId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  PhaseRunId,
  ProjectId,
  ThreadId,
  WorkflowId,
  WorkflowPhaseId,
  createInitialDeliberationState,
  type Channel,
  type OrchestrationReadModel,
} from "@forgetools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, ManagedRuntime, Option, Stream } from "effect";

import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionPhaseRunRepositoryLive } from "../../persistence/Layers/ProjectionPhaseRuns.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionPhaseRunRepository } from "../../persistence/Services/ProjectionPhaseRuns.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThread,
} from "../../persistence/Services/ProjectionThreads.ts";
import { DeliberationEngine } from "../Services/DeliberationEngine.ts";
import { DeliberationEngineLive } from "./DeliberationEngine.ts";

const projectId = ProjectId.makeUnsafe("project-deliberation");
const workflowThreadId = ThreadId.makeUnsafe("thread-workflow-deliberation");
const chatThreadId = ThreadId.makeUnsafe("thread-chat-deliberation");
const participantAId = ThreadId.makeUnsafe("thread-participant-a");
const participantBId = ThreadId.makeUnsafe("thread-participant-b");
const workflowChannelId = ChannelId.makeUnsafe("channel-deliberation-phase");
const chatChannelId = ChannelId.makeUnsafe("channel-deliberation-chat");
const phaseRunId = PhaseRunId.makeUnsafe("phase-run-deliberation");
const workflowId = WorkflowId.makeUnsafe("workflow-deliberation");
const phaseId = WorkflowPhaseId.makeUnsafe("phase-deliberation");
const createdAt = "2026-04-05T22:00:00.000Z";

const baseProject = {
  id: projectId,
  title: "Deliberation Project",
  workspaceRoot: "/tmp/deliberation-project",
  defaultModelSelection: null,
  scripts: [],
  createdAt,
  updatedAt: createdAt,
  deletedAt: null,
} satisfies OrchestrationReadModel["projects"][number];

function buildChannel(input: {
  readonly channelId: ChannelId;
  readonly threadId: ThreadId;
  readonly phaseRunId?: PhaseRunId;
}): Channel {
  return {
    id: input.channelId,
    threadId: input.threadId,
    ...(input.phaseRunId === undefined ? {} : { phaseRunId: input.phaseRunId }),
    type: "deliberation",
    status: "open",
    createdAt,
    updatedAt: createdAt,
  };
}

function buildReadModel(channel: Channel): OrchestrationReadModel {
  const parentThreadId = channel.threadId;
  const parentThread = {
    id: parentThreadId,
    projectId,
    title: `Parent ${parentThreadId}`,
    modelSelection: {
      provider: "codex",
      model: "gpt-5-codex",
    },
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    deletedAt: null,
    parentThreadId: null,
    phaseRunId: null,
    workflowId: channel.phaseRunId === undefined ? null : workflowId,
    currentPhaseId: channel.phaseRunId === undefined ? null : phaseId,
    discussionId: channel.phaseRunId === undefined ? "debate" : null,
    role: null,
    childThreadIds: [participantAId, participantBId],
    bootstrapStatus: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  } satisfies OrchestrationReadModel["threads"][number];

  const participants = [
    {
      id: participantAId,
      projectId,
      title: "Participant A",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
      deletedAt: null,
      parentThreadId,
      phaseRunId: channel.phaseRunId === undefined ? null : phaseRunId,
      workflowId: null,
      currentPhaseId: null,
      discussionId: null,
      role: "advocate",
      childThreadIds: [],
      bootstrapStatus: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
    {
      id: participantBId,
      projectId,
      title: "Participant B",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
      },
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
      deletedAt: null,
      parentThreadId,
      phaseRunId: channel.phaseRunId === undefined ? null : phaseRunId,
      workflowId: null,
      currentPhaseId: null,
      discussionId: null,
      role: "critic",
      childThreadIds: [],
      bootstrapStatus: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ] satisfies ReadonlyArray<OrchestrationReadModel["threads"][number]>;

  return {
    snapshotSequence: 0,
    updatedAt: createdAt,
    projects: [baseProject],
    threads: [parentThread, ...participants],
    phaseRuns:
      channel.phaseRunId === undefined
        ? []
        : [
            {
              phaseRunId,
              threadId: parentThreadId,
              phaseId,
              phaseName: "debate",
              phaseType: "multi-agent",
              iteration: 1,
              status: "running",
              startedAt: createdAt,
              completedAt: null,
            },
          ],
    channels: [channel],
    pendingRequests: [],
    workflows: [],
  };
}

function buildProjectionThread(input: {
  readonly threadId: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly phaseRunId: PhaseRunId | null;
  readonly role: string | null;
  readonly deliberationState: ProjectionThread["deliberationState"];
  readonly workflowId?: WorkflowId | null;
  readonly discussionId?: string | null;
}): ProjectionThread {
  return {
    threadId: input.threadId,
    projectId,
    title: `Projection ${input.threadId}`,
    modelSelection:
      input.threadId === participantBId
        ? {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
          }
        : {
            provider: "codex",
            model: "gpt-5-codex",
          },
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurnId: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    deletedAt: null,
    parentThreadId: input.parentThreadId,
    phaseRunId: input.phaseRunId,
    workflowId: input.workflowId ?? null,
    workflowSnapshot: null,
    currentPhaseId: input.phaseRunId === null ? null : phaseId,
    discussionId: input.discussionId ?? null,
    role: input.role,
    deliberationState: input.deliberationState,
    bootstrapStatus: null,
    completedAt: null,
    transcriptArchived: false,
  };
}

async function createHarness(readModel: OrchestrationReadModel) {
  const orchestrationService: OrchestrationEngineShape = {
    getReadModel: () => Effect.succeed(readModel),
    readEvents: () => Stream.empty,
    streamEventsFromSequence: () => Stream.empty,
    dispatch: () => {
      throw new Error("Unsupported in DeliberationEngine test.");
    },
    streamDomainEvents: Stream.empty,
  };

  const dependenciesLayer = Layer.mergeAll(
    ProjectionThreadRepositoryLive,
    ProjectionPhaseRunRepositoryLive,
    Layer.succeed(OrchestrationEngineService, orchestrationService),
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory), Layer.provideMerge(NodeServices.layer));

  const deliberationLayer = DeliberationEngineLive.pipe(Layer.provide(dependenciesLayer));
  const layer = Layer.mergeAll(dependenciesLayer, deliberationLayer);

  const runtime = ManagedRuntime.make(layer);
  const deliberationEngine = await runtime.runPromise(Effect.service(DeliberationEngine));
  const phaseRuns = await runtime.runPromise(Effect.service(ProjectionPhaseRunRepository));
  const threads = await runtime.runPromise(Effect.service(ProjectionThreadRepository));

  return {
    deliberationEngine,
    phaseRuns,
    threads,
    dispose: () => runtime.dispose(),
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
  };
}

async function seedWorkflowTarget(
  harness: Awaited<ReturnType<typeof createHarness>>,
  initialState: ProjectionThread["deliberationState"] = null,
) {
  await harness.run(
    harness.threads.upsert(
      buildProjectionThread({
        threadId: workflowThreadId,
        parentThreadId: null,
        phaseRunId: null,
        role: null,
        deliberationState: null,
        workflowId,
      }),
    ),
  );
  await harness.run(
    harness.threads.upsert(
      buildProjectionThread({
        threadId: participantAId,
        parentThreadId: workflowThreadId,
        phaseRunId,
        role: "advocate",
        deliberationState: null,
      }),
    ),
  );
  await harness.run(
    harness.threads.upsert(
      buildProjectionThread({
        threadId: participantBId,
        parentThreadId: workflowThreadId,
        phaseRunId,
        role: "critic",
        deliberationState: null,
      }),
    ),
  );
  await harness.run(
    harness.phaseRuns.upsert({
      phaseRunId,
      threadId: workflowThreadId,
      workflowId,
      phaseId,
      phaseName: "debate",
      phaseType: "multi-agent",
      sandboxMode: "read-only",
      iteration: 1,
      status: "running",
      gateResult: null,
      qualityChecks: null,
      deliberationState: initialState,
      startedAt: createdAt,
      completedAt: null,
    }),
  );
}

async function seedChatTarget(
  harness: Awaited<ReturnType<typeof createHarness>>,
  initialState: ProjectionThread["deliberationState"] = null,
) {
  await harness.run(
    harness.threads.upsert(
      buildProjectionThread({
        threadId: chatThreadId,
        parentThreadId: null,
        phaseRunId: null,
        role: null,
        deliberationState: initialState,
        discussionId: "debate",
      }),
    ),
  );
  await harness.run(
    harness.threads.upsert(
      buildProjectionThread({
        threadId: participantAId,
        parentThreadId: chatThreadId,
        phaseRunId: null,
        role: "advocate",
        deliberationState: null,
      }),
    ),
  );
  await harness.run(
    harness.threads.upsert(
      buildProjectionThread({
        threadId: participantBId,
        parentThreadId: chatThreadId,
        phaseRunId: null,
        role: "critic",
        deliberationState: null,
      }),
    ),
  );
}

it.effect("alternates speakers ping-pong style and persists workflow-phase state", () =>
  Effect.promise(async () => {
    const harness = await createHarness(
      buildReadModel(
        buildChannel({
          channelId: workflowChannelId,
          threadId: workflowThreadId,
          phaseRunId,
        }),
      ),
    );
    try {
      await seedWorkflowTarget(harness);
      await harness.run(
        harness.deliberationEngine.initialize({
          channelId: workflowChannelId,
          maxTurns: 4,
          initializedAt: createdAt,
        }),
      );

      const afterFirstPost = await harness.run(
        harness.deliberationEngine.recordPost({
          channelId: workflowChannelId,
          participantThreadId: participantAId,
          postedAt: "2026-04-05T22:01:00.000Z",
        }),
      );
      assert.strictEqual(afterFirstPost.nextSpeaker, participantBId);
      assert.strictEqual(afterFirstPost.state.currentSpeaker, participantBId);
      assert.strictEqual(afterFirstPost.state.turnCount, 1);

      const afterSecondPost = await harness.run(
        harness.deliberationEngine.recordPost({
          channelId: workflowChannelId,
          participantThreadId: participantBId,
          postedAt: "2026-04-05T22:02:00.000Z",
        }),
      );
      assert.strictEqual(afterSecondPost.nextSpeaker, participantAId);
      assert.strictEqual(afterSecondPost.state.currentSpeaker, participantAId);
      assert.strictEqual(afterSecondPost.state.turnCount, 2);

      const persisted = await harness.run(
        harness.phaseRuns.queryById({
          phaseRunId,
        }),
      );
      assert.strictEqual(Option.isSome(persisted), true);
      if (Option.isSome(persisted)) {
        assert.strictEqual(persisted.value.deliberationState?.currentSpeaker, participantAId);
        assert.strictEqual(persisted.value.deliberationState?.turnCount, 2);
      }
    } finally {
      await harness.dispose();
    }
  }),
);

it.effect("detects stalled speakers and returns provider-specific nudge delivery", () =>
  Effect.promise(async () => {
    const harness = await createHarness(
      buildReadModel(
        buildChannel({
          channelId: workflowChannelId,
          threadId: workflowThreadId,
          phaseRunId,
        }),
      ),
    );
    try {
      await seedWorkflowTarget(harness);
      await harness.run(
        harness.deliberationEngine.initialize({
          channelId: workflowChannelId,
          maxTurns: 6,
          initializedAt: createdAt,
        }),
      );
      await harness.run(
        harness.deliberationEngine.recordPost({
          channelId: workflowChannelId,
          participantThreadId: participantAId,
          postedAt: "2026-04-05T22:01:00.000Z",
        }),
      );

      const recovered = await harness.run(
        harness.deliberationEngine.recover({
          channelId: workflowChannelId,
          now: "2026-04-05T22:04:01.000Z",
        }),
      );

      assert.deepStrictEqual(recovered.nudge, {
        participantThreadId: participantBId,
        delivery: "queue",
        message: [
          "=== NUDGE ===",
          "The shared deliberation is waiting on your response.",
          "Read the latest channel context and continue the discussion.",
          "If the discussion is complete, use the conclusion flow explicitly.",
          "=== END NUDGE ===",
        ].join("\n"),
      });
      assert.strictEqual(recovered.state.nudgeCount[participantBId], 1);
    } finally {
      await harness.dispose();
    }
  }),
);

it.effect(
  "marks the deliberation ready to conclude once all participants propose a conclusion",
  () =>
    Effect.promise(async () => {
      const harness = await createHarness(
        buildReadModel(
          buildChannel({
            channelId: workflowChannelId,
            threadId: workflowThreadId,
            phaseRunId,
          }),
        ),
      );
      try {
        await seedWorkflowTarget(harness);
        await harness.run(
          harness.deliberationEngine.initialize({
            channelId: workflowChannelId,
            maxTurns: 6,
            initializedAt: createdAt,
          }),
        );

        const afterFirstProposal = await harness.run(
          harness.deliberationEngine.recordConclusionProposal({
            channelId: workflowChannelId,
            participantThreadId: participantAId,
            summary: "Ready after the retry guard lands.",
            proposedAt: "2026-04-05T22:03:00.000Z",
          }),
        );
        assert.strictEqual(afterFirstProposal.shouldConcludeChannel, false);
        assert.strictEqual(afterFirstProposal.nextSpeaker, participantBId);

        const afterSecondProposal = await harness.run(
          harness.deliberationEngine.recordConclusionProposal({
            channelId: workflowChannelId,
            participantThreadId: participantBId,
            summary: "Agreed once lint passes.",
            proposedAt: "2026-04-05T22:03:30.000Z",
          }),
        );
        assert.strictEqual(afterSecondProposal.shouldConcludeChannel, true);
        assert.strictEqual(afterSecondProposal.state.concluded, true);
        assert.strictEqual(afterSecondProposal.nextSpeaker, null);
      } finally {
        await harness.dispose();
      }
    }),
);

it.effect("forces conclusion when the configured max-turn limit is reached", () =>
  Effect.promise(async () => {
    const harness = await createHarness(
      buildReadModel(
        buildChannel({
          channelId: workflowChannelId,
          threadId: workflowThreadId,
          phaseRunId,
        }),
      ),
    );
    try {
      await seedWorkflowTarget(harness);
      await harness.run(
        harness.deliberationEngine.initialize({
          channelId: workflowChannelId,
          maxTurns: 2,
          initializedAt: createdAt,
        }),
      );
      await harness.run(
        harness.deliberationEngine.recordPost({
          channelId: workflowChannelId,
          participantThreadId: participantAId,
          postedAt: "2026-04-05T22:01:00.000Z",
        }),
      );

      const terminalTransition = await harness.run(
        harness.deliberationEngine.recordPost({
          channelId: workflowChannelId,
          participantThreadId: participantBId,
          postedAt: "2026-04-05T22:02:00.000Z",
        }),
      );

      assert.strictEqual(terminalTransition.forcedConclusion, true);
      assert.strictEqual(terminalTransition.shouldConcludeChannel, true);
      assert.strictEqual(terminalTransition.state.concluded, true);
      assert.strictEqual(terminalTransition.nextSpeaker, null);
    } finally {
      await harness.dispose();
    }
  }),
);

it.effect(
  "recovers from persisted chat-session state and loads reinjection or nudge actions from storage",
  () =>
    Effect.promise(async () => {
      const chatState = {
        ...createInitialDeliberationState(6),
        currentSpeaker: participantAId,
        lastPostTimestamp: {
          [participantBId]: "2026-04-05T22:01:00.000Z",
        },
        injectionState: {
          sessionId: participantAId,
          injectedAtSequence: 4,
          turnCorrelationId: "turn-recover",
          status: "injected" as const,
        },
      };
      const harness = await createHarness(
        buildReadModel(
          buildChannel({
            channelId: chatChannelId,
            threadId: chatThreadId,
          }),
        ),
      );
      try {
        await seedChatTarget(harness, chatState);

        const recovered = await harness.run(
          harness.deliberationEngine.recover({
            channelId: chatChannelId,
            now: "2026-04-05T22:04:30.000Z",
          }),
        );

        assert.deepStrictEqual(recovered.reinjection, {
          participantThreadId: participantAId,
          injectedAtSequence: 4,
          turnCorrelationId: "turn-recover",
        });
        assert.deepStrictEqual(recovered.nudge, {
          participantThreadId: participantAId,
          delivery: "inject",
          message: [
            "=== NUDGE ===",
            "The shared deliberation is waiting on your response.",
            "Read the latest channel context and continue the discussion.",
            "If the discussion is complete, use the conclusion flow explicitly.",
            "=== END NUDGE ===",
          ].join("\n"),
        });

        const persistedParent = await harness.run(
          harness.threads.getById({
            threadId: chatThreadId,
          }),
        );
        assert.strictEqual(Option.isSome(persistedParent), true);
        if (Option.isSome(persistedParent)) {
          assert.strictEqual(
            persistedParent.value.deliberationState?.nudgeCount[participantAId],
            1,
          );
        }
      } finally {
        await harness.dispose();
      }
    }),
);
