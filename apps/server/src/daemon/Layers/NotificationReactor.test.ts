import {
  ChannelId,
  InteractiveRequestId,
  PhaseRunId,
  ProjectId,
  ThreadId,
  type ForgeEvent,
  type OrchestrationReadModel as OrchestrationReadModelType,
} from "@forgetools/contracts";
import { assert } from "@effect/vitest";
import { Effect, Exit, Layer, ManagedRuntime, Scope, Stream } from "effect";
import { it } from "vitest";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import { NotificationDispatch } from "../Services/NotificationDispatch.ts";
import { NotificationReactor } from "../Services/NotificationReactor.ts";
import { NotificationReactorLive } from "./NotificationReactor.ts";

interface NotificationCall {
  readonly trigger: "session-needs-attention" | "session-completed" | "deliberation-concluded";
  readonly title: string;
  readonly body: string;
  readonly sessionId?: string;
}

const baseReadModel = (): OrchestrationReadModelType =>
  ({
    snapshotSequence: 0,
    projects: [],
    threads: [],
    phaseRuns: [],
    channels: [],
    pendingRequests: [],
    workflows: [],
    updatedAt: "2026-04-06T00:00:00.000Z",
  }) satisfies OrchestrationReadModelType;

const makeThread = (input: {
  readonly threadId: string;
  readonly title: string;
  readonly parentThreadId?: string | null;
}) => ({
  id: ThreadId.makeUnsafe(input.threadId),
  projectId: ProjectId.makeUnsafe("project-1"),
  title: input.title,
  modelSelection: {
    provider: "codex",
    model: "gpt-5-codex",
  } as const,
  runtimeMode: "approval-required" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-06T00:00:00.000Z",
  updatedAt: "2026-04-06T00:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
  parentThreadId:
    input.parentThreadId === undefined || input.parentThreadId === null
      ? null
      : ThreadId.makeUnsafe(input.parentThreadId),
  phaseRunId: null,
  workflowId: null,
  currentPhaseId: null,
  discussionId: null,
  role: null,
  childThreadIds: [],
  bootstrapStatus: null,
  forkedFromThreadId: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
});

const makeLayer = (input: {
  readonly readModel: OrchestrationReadModelType;
  readonly events: ReadonlyArray<ForgeEvent>;
  readonly notifications: Array<NotificationCall>;
}) =>
  NotificationReactorLive.pipe(
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngineService, {
        getReadModel: () => Effect.succeed(input.readModel),
        readEvents: () => Stream.empty,
        streamEventsFromSequence: (fromSequenceExclusive) =>
          Stream.fromIterable(
            input.events.filter((event) => event.sequence > fromSequenceExclusive),
          ) as unknown as ReturnType<OrchestrationEngineShape["streamEventsFromSequence"]>,
        dispatch: () => Effect.die("unused"),
        streamDomainEvents: Stream.fromIterable(
          input.events,
        ) as unknown as OrchestrationEngineShape["streamDomainEvents"],
      } satisfies OrchestrationEngineShape),
    ),
    Layer.provideMerge(
      Layer.succeed(NotificationDispatch, {
        getPreferences: Effect.succeed({
          sessionNeedsAttention: true,
          sessionCompleted: true,
          deliberationConcluded: true,
        }),
        dispatch: (notification) =>
          Effect.sync(() => {
            input.notifications.push({
              trigger: notification.trigger,
              title: notification.title,
              body: notification.body,
              ...(notification.sessionId === undefined
                ? {}
                : { sessionId: notification.sessionId }),
            });
            return {
              status: "dispatched" as const,
              backend: "notify-send" as const,
            };
          }),
      }),
    ),
  );

const runReactor = async (input: {
  readonly readModel: OrchestrationReadModelType;
  readonly events: ReadonlyArray<ForgeEvent>;
  readonly notifications: Array<NotificationCall>;
}) => {
  const runtime = ManagedRuntime.make(makeLayer(input));
  const reactor = await runtime.runPromise(Effect.service(NotificationReactor));
  const scope = await Effect.runPromise(Scope.make("sequential"));

  try {
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    await Effect.runPromise(Effect.sleep("1 millis"));
    await Effect.runPromise(reactor.drain);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
  }
};

it("dispatches a needs-attention notification for top-level interactive requests", async () => {
  const notifications: Array<NotificationCall> = [];
  const readModel = {
    ...baseReadModel(),
    threads: [makeThread({ threadId: "thread-top", title: "Build Loop" })],
  } as unknown as OrchestrationReadModelType;

  const events = [
    {
      sequence: 1,
      eventId: "evt-request-opened",
      aggregateKind: "thread",
      aggregateId: "thread-top",
      type: "request.opened",
      occurredAt: "2026-04-06T00:00:00.000Z",
      commandId: "cmd-request-opened",
      causationEventId: null,
      correlationId: "cmd-request-opened",
      metadata: {},
      payload: {
        requestId: InteractiveRequestId.makeUnsafe("request-1"),
        threadId: ThreadId.makeUnsafe("thread-top"),
        childThreadId: null,
        phaseRunId: null,
        requestType: "gate",
        payload: {
          type: "gate",
          gateType: "human-approval",
          phaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
        },
        createdAt: "2026-04-06T00:00:00.000Z",
      },
    },
  ] as unknown as ReadonlyArray<ForgeEvent>;

  await runReactor({ readModel, events, notifications });

  assert.deepStrictEqual(notifications, [
    {
      trigger: "session-needs-attention",
      title: "Needs attention: Build Loop",
      body: "Waiting for human approval.",
      sessionId: "thread-top",
    },
  ]);
});

it("skips child-session interactive requests to avoid noisy daemon notifications", async () => {
  const notifications: Array<NotificationCall> = [];
  const readModel = {
    ...baseReadModel(),
    threads: [makeThread({ threadId: "thread-child", title: "Implement", parentThreadId: "root" })],
  } as unknown as OrchestrationReadModelType;

  const events = [
    {
      sequence: 1,
      eventId: "evt-child-request-opened",
      aggregateKind: "thread",
      aggregateId: "thread-child",
      type: "request.opened",
      occurredAt: "2026-04-06T00:00:00.000Z",
      commandId: "cmd-child-request-opened",
      causationEventId: null,
      correlationId: "cmd-child-request-opened",
      metadata: {},
      payload: {
        requestId: InteractiveRequestId.makeUnsafe("request-child"),
        threadId: ThreadId.makeUnsafe("thread-child"),
        childThreadId: null,
        phaseRunId: null,
        requestType: "bootstrap-failed",
        payload: {
          type: "bootstrap-failed",
          error: "bootstrap failed",
          stdout: "stderr",
          command: "git worktree add",
        },
        createdAt: "2026-04-06T00:00:00.000Z",
      },
    },
  ] as unknown as ReadonlyArray<ForgeEvent>;

  await runReactor({ readModel, events, notifications });

  assert.deepStrictEqual(notifications, []);
});

it("dispatches a completion notification for top-level completed sessions", async () => {
  const notifications: Array<NotificationCall> = [];
  const readModel = {
    ...baseReadModel(),
    threads: [makeThread({ threadId: "thread-complete", title: "Plan Then Implement" })],
  } as unknown as OrchestrationReadModelType;

  const events = [
    {
      sequence: 1,
      eventId: "evt-thread-completed",
      aggregateKind: "thread",
      aggregateId: "thread-complete",
      type: "thread.completed",
      occurredAt: "2026-04-06T00:00:00.000Z",
      commandId: "cmd-thread-completed",
      causationEventId: null,
      correlationId: "cmd-thread-completed",
      metadata: {},
      payload: {
        threadId: ThreadId.makeUnsafe("thread-complete"),
        completedAt: "2026-04-06T00:00:00.000Z",
      },
    },
  ] as unknown as ReadonlyArray<ForgeEvent>;

  await runReactor({ readModel, events, notifications });

  assert.deepStrictEqual(notifications, [
    {
      trigger: "session-completed",
      title: "Session completed: Plan Then Implement",
      body: "Forge finished the session.",
      sessionId: "thread-complete",
    },
  ]);
});

it("dispatches deliberation notifications only for standalone deliberation channels", async () => {
  const notifications: Array<NotificationCall> = [];
  const readModel = {
    ...baseReadModel(),
    threads: [
      makeThread({ threadId: "thread-chat", title: "Architecture Debate" }),
      makeThread({ threadId: "thread-workflow", title: "Workflow Debate" }),
    ],
    channels: [
      {
        id: ChannelId.makeUnsafe("channel-chat"),
        threadId: ThreadId.makeUnsafe("thread-chat"),
        phaseRunId: undefined,
        type: "deliberation" as const,
        status: "concluded" as const,
        createdAt: "2026-04-06T00:00:00.000Z",
        updatedAt: "2026-04-06T00:00:01.000Z",
      },
      {
        id: ChannelId.makeUnsafe("channel-phase"),
        threadId: ThreadId.makeUnsafe("thread-workflow"),
        phaseRunId: "phase-run-workflow",
        type: "deliberation" as const,
        status: "concluded" as const,
        createdAt: "2026-04-06T00:00:00.000Z",
        updatedAt: "2026-04-06T00:00:01.000Z",
      },
    ],
  } as unknown as OrchestrationReadModelType;

  const events = [
    {
      sequence: 1,
      eventId: "evt-channel-concluded-chat",
      aggregateKind: "thread",
      aggregateId: "thread-chat",
      type: "channel.concluded",
      occurredAt: "2026-04-06T00:00:01.000Z",
      commandId: "cmd-channel-concluded-chat",
      causationEventId: null,
      correlationId: "cmd-channel-concluded-chat",
      metadata: {},
      payload: {
        channelId: ChannelId.makeUnsafe("channel-chat"),
        concludedAt: "2026-04-06T00:00:01.000Z",
      },
    },
    {
      sequence: 2,
      eventId: "evt-channel-concluded-phase",
      aggregateKind: "thread",
      aggregateId: "thread-workflow",
      type: "channel.concluded",
      occurredAt: "2026-04-06T00:00:02.000Z",
      commandId: "cmd-channel-concluded-phase",
      causationEventId: null,
      correlationId: "cmd-channel-concluded-phase",
      metadata: {},
      payload: {
        channelId: ChannelId.makeUnsafe("channel-phase"),
        concludedAt: "2026-04-06T00:00:02.000Z",
      },
    },
  ] as unknown as ReadonlyArray<ForgeEvent>;

  await runReactor({ readModel, events, notifications });

  assert.deepStrictEqual(notifications, [
    {
      trigger: "deliberation-concluded",
      title: "Deliberation concluded: Architecture Debate",
      body: "Open Forge to review the conclusion.",
      sessionId: "thread-chat",
    },
  ]);
});
