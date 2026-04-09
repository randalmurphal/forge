import {
  type Channel,
  type ForgeEvent,
  type InteractiveRequestPayload,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@forgetools/contracts";
import { makeDrainableWorker } from "@forgetools/shared/DrainableWorker";
import { Cause, Effect, Layer, Stream } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { NotificationDispatch } from "../Services/NotificationDispatch.ts";
import {
  NotificationReactor,
  type NotificationReactorShape,
} from "../Services/NotificationReactor.ts";

type NotificationReactorEvent = Extract<
  ForgeEvent,
  {
    type: "request.opened" | "thread.completed" | "channel.concluded";
  }
>;

const findThread = (
  readModel: OrchestrationReadModel,
  threadId: string,
): OrchestrationThread | undefined => readModel.threads.find((thread) => thread.id === threadId);

const findTopLevelThread = (
  readModel: OrchestrationReadModel,
  threadId: string,
): OrchestrationThread | undefined => {
  const thread = findThread(readModel, threadId);
  return thread?.parentThreadId === null ? thread : undefined;
};

const findChannel = (readModel: OrchestrationReadModel, channelId: string): Channel | undefined =>
  readModel.channels.find((channel) => channel.id === channelId);

function attentionBody(payload: InteractiveRequestPayload): string {
  switch (payload.type) {
    case "approval":
      return `Approval requested for ${payload.toolName}.`;
    case "user-input":
      return payload.questions.length === 1
        ? "1 question needs input."
        : `${payload.questions.length} questions need input.`;
    case "gate":
      switch (payload.gateType) {
        case "human-approval":
          return "Waiting for human approval.";
        case "quality-checks":
          return "Quality checks need review.";
        default:
          return `Waiting on ${payload.gateType}.`;
      }
    case "bootstrap-failed":
      return "Bootstrap failed and needs a decision.";
    case "correction-needed":
      return "The session requested a correction.";
    case "design-option":
      return "Design options are ready for review.";
  }
}

export const makeNotificationReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const notificationDispatch = yield* NotificationDispatch;

  const processRequestOpened = Effect.fn("NotificationReactor.processRequestOpened")(function* (
    event: Extract<NotificationReactorEvent, { type: "request.opened" }>,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = findTopLevelThread(readModel, event.payload.threadId);
    if (thread === undefined) {
      return;
    }

    yield* notificationDispatch.dispatch({
      trigger: "session-needs-attention",
      title: `Needs attention: ${thread.title}`,
      body: attentionBody(event.payload.payload),
      sessionId: thread.id,
    });
  });

  const processThreadCompleted = Effect.fn("NotificationReactor.processThreadCompleted")(function* (
    event: Extract<NotificationReactorEvent, { type: "thread.completed" }>,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = findTopLevelThread(readModel, event.payload.threadId);
    if (thread === undefined) {
      return;
    }

    yield* notificationDispatch.dispatch({
      trigger: "session-completed",
      title: `Session completed: ${thread.title}`,
      body: "Forge finished the session.",
      sessionId: thread.id,
    });
  });

  const processChannelConcluded = Effect.fn("NotificationReactor.processChannelConcluded")(
    function* (event: Extract<NotificationReactorEvent, { type: "channel.concluded" }>) {
      const readModel = yield* orchestrationEngine.getReadModel();
      const channel = findChannel(readModel, event.payload.channelId);
      if (
        channel === undefined ||
        channel.type !== "deliberation" ||
        channel.phaseRunId !== undefined
      ) {
        return;
      }

      const thread = findTopLevelThread(readModel, channel.threadId);
      if (thread === undefined) {
        return;
      }

      yield* notificationDispatch.dispatch({
        trigger: "deliberation-concluded",
        title: `Deliberation concluded: ${thread.title}`,
        body: "Open Forge to review the conclusion.",
        sessionId: thread.id,
      });
    },
  );

  const processEvent = Effect.fn("NotificationReactor.processEvent")(function* (
    event: NotificationReactorEvent,
  ) {
    switch (event.type) {
      case "request.opened":
        yield* processRequestOpened(event);
        return;
      case "thread.completed":
        yield* processThreadCompleted(event);
        return;
      case "channel.concluded":
        yield* processChannelConcluded(event);
        return;
    }
  });

  const processEventSafely = (event: NotificationReactorEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        return Effect.logError("daemon notification reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processEventSafely);

  const start: NotificationReactorShape["start"] = () =>
    Stream.runForEach(
      Stream.filter(
        orchestrationEngine.streamDomainEvents as unknown as Stream.Stream<ForgeEvent>,
        (event) =>
          event.type === "request.opened" ||
          event.type === "thread.completed" ||
          event.type === "channel.concluded",
      ).pipe(Stream.map((event) => event as NotificationReactorEvent)),
      worker.enqueue,
    ).pipe(Effect.forkScoped, Effect.asVoid);

  return {
    start,
    drain: worker.drain,
  } satisfies NotificationReactorShape;
});

export const NotificationReactorLive = Layer.effect(NotificationReactor, makeNotificationReactor);
