import {
  createInitialDeliberationState,
  type Channel,
  type DeliberationState,
  type OrchestrationThread,
  PhaseRunId,
  type ThreadId,
} from "@forgetools/contracts";
import { Effect, Layer, Option } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionPhaseRunRepository } from "../../persistence/Services/ProjectionPhaseRuns.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import {
  DeliberationEngine,
  type DeliberationEngineShape,
  type DeliberationTransition,
} from "../Services/DeliberationEngine.ts";
import {
  DeliberationEngineChannelNotFoundError,
  type DeliberationEngineError,
  DeliberationEngineParticipantNotFoundError,
  DeliberationEngineParticipantsInvalidError,
  DeliberationEnginePhaseRunNotFoundError,
  DeliberationEngineStateNotInitializedError,
  DeliberationEngineThreadNotFoundError,
} from "../Errors.ts";

interface DeliberationContext {
  readonly channel: Channel;
  readonly parentThread: OrchestrationThread;
  readonly participants: ReadonlyArray<OrchestrationThread>;
  readonly persistedState: DeliberationState | null;
  readonly persistState: (
    state: DeliberationState,
    persistedAt: string,
  ) => Effect.Effect<void, DeliberationEngineError>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function nextSpeaker(
  participants: ReadonlyArray<OrchestrationThread>,
  participantThreadId: ThreadId,
): ThreadId | null {
  if (participants.length === 0) {
    return null;
  }

  const currentIndex = participants.findIndex(
    (participant) => participant.id === participantThreadId,
  );
  if (currentIndex < 0) {
    return null;
  }

  return participants[(currentIndex + 1) % participants.length]?.id ?? null;
}

function latestActivityTimestamp(state: DeliberationState): string | null {
  const timestamps = Object.values(state.lastPostTimestamp);
  if (timestamps.length === 0) {
    return null;
  }

  return timestamps.reduce((latest, candidate) =>
    new Date(candidate).getTime() > new Date(latest).getTime() ? candidate : latest,
  );
}

function isTimedOut(now: string, deadlineFrom: string, timeoutMs: number): boolean {
  return new Date(now).getTime() - new Date(deadlineFrom).getTime() > timeoutMs;
}

function nudgeDeliveryForParticipant(participant: OrchestrationThread): "queue" | "inject" {
  return participant.modelSelection.provider === "codex" ? "inject" : "queue";
}

function formatStallNudge(input: {
  readonly participant: OrchestrationThread;
  readonly state: DeliberationState;
}): string {
  const otherParticipantsAlreadyProposed = Object.keys(input.state.conclusionProposals).some(
    (threadId) => threadId !== input.participant.id,
  );
  if (
    otherParticipantsAlreadyProposed &&
    input.state.conclusionProposals[input.participant.id] === undefined
  ) {
    return [
      "=== REMINDER ===",
      "Another participant has already proposed concluding the deliberation.",
      "If you agree, begin your next response with PROPOSE_CONCLUSION followed by your summary.",
      "If you disagree, explain why and continue the discussion.",
      "=== END REMINDER ===",
    ].join("\n");
  }

  return [
    "=== NUDGE ===",
    "The shared deliberation is waiting on your response.",
    "Read the latest channel context and continue the discussion.",
    "If the discussion is complete, use the conclusion flow explicitly.",
    "=== END NUDGE ===",
  ].join("\n");
}

function transitionFromState(
  context: DeliberationContext,
  state: DeliberationState,
  options?: {
    readonly forcedConclusion?: boolean;
    readonly nudge?: DeliberationTransition["nudge"];
    readonly reinjection?: DeliberationTransition["reinjection"];
  },
): DeliberationTransition {
  return {
    state,
    participantThreadIds: context.participants.map((participant) => participant.id),
    nextSpeaker: state.currentSpeaker,
    shouldConcludeChannel: state.concluded,
    forcedConclusion: options?.forcedConclusion ?? false,
    ...(options?.nudge === undefined ? {} : { nudge: options.nudge }),
    ...(options?.reinjection === undefined ? {} : { reinjection: options.reinjection }),
  };
}

export const makeDeliberationEngine = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const phaseRuns = yield* ProjectionPhaseRunRepository;
  const threads = yield* ProjectionThreadRepository;

  const resolveContext = Effect.fn("DeliberationEngine.resolveContext")(function* (
    channelId: Channel["id"],
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const channel = readModel.channels.find((candidate) => candidate.id === channelId);
    if (!channel) {
      return yield* new DeliberationEngineChannelNotFoundError({
        channelId,
      });
    }

    const parentThread = readModel.threads.find((candidate) => candidate.id === channel.threadId);
    if (!parentThread) {
      return yield* new DeliberationEngineThreadNotFoundError({
        threadId: channel.threadId,
        channelId,
      });
    }

    const phaseRunId =
      channel.phaseRunId === undefined ? undefined : PhaseRunId.makeUnsafe(channel.phaseRunId);

    const participants = readModel.threads
      .filter((candidate) => {
        if (candidate.deletedAt !== null) {
          return false;
        }
        const attachedToParent =
          candidate.parentThreadId === parentThread.id ||
          parentThread.childThreadIds.includes(candidate.id);
        if (!attachedToParent) {
          return false;
        }
        if (phaseRunId !== undefined && candidate.phaseRunId !== phaseRunId) {
          return false;
        }
        return true;
      })
      .toSorted((left, right) => left.id.localeCompare(right.id));

    if (participants.length < 2) {
      return yield* new DeliberationEngineParticipantsInvalidError({
        channelId,
        actual: participants.length,
      });
    }

    if (phaseRunId !== undefined) {
      const phaseRunOption = yield* phaseRuns.queryById({
        phaseRunId,
      });
      if (Option.isNone(phaseRunOption)) {
        return yield* new DeliberationEnginePhaseRunNotFoundError({
          phaseRunId,
          channelId,
        });
      }

      const phaseRun = phaseRunOption.value;
      return {
        channel,
        parentThread,
        participants,
        persistedState: phaseRun.deliberationState,
        persistState: (state: DeliberationState, _persistedAt: string) =>
          phaseRuns.updateStatus({
            phaseRunId: phaseRun.phaseRunId,
            status: phaseRun.status,
            deliberationState: state,
            ...(phaseRun.startedAt === null ? {} : { startedAt: phaseRun.startedAt }),
            ...(phaseRun.completedAt === null ? {} : { completedAt: phaseRun.completedAt }),
          }),
      };
    }

    const threadOption = yield* threads.getById({
      threadId: parentThread.id,
    });
    if (Option.isNone(threadOption)) {
      return yield* new DeliberationEngineThreadNotFoundError({
        threadId: parentThread.id,
        channelId,
      });
    }

    const thread = threadOption.value;
    return {
      channel,
      parentThread,
      participants,
      persistedState: thread.deliberationState,
      persistState: (state: DeliberationState, persistedAt: string) =>
        threads.upsert({
          ...thread,
          deliberationState: state,
          updatedAt: persistedAt,
        }),
    };
  });

  const requireInitializedState = Effect.fn("DeliberationEngine.requireInitializedState")(
    function* (context: DeliberationContext) {
      if (context.persistedState === null) {
        return yield* new DeliberationEngineStateNotInitializedError({
          channelId: context.channel.id,
        });
      }

      return context.persistedState;
    },
  );

  const requireParticipant = Effect.fn("DeliberationEngine.requireParticipant")(function* (
    context: DeliberationContext,
    participantThreadId: ThreadId,
  ) {
    const participant = context.participants.find(
      (candidate) => candidate.id === participantThreadId,
    );
    if (!participant) {
      return yield* new DeliberationEngineParticipantNotFoundError({
        channelId: context.channel.id,
        participantThreadId,
      });
    }

    return participant;
  });

  const initialize: DeliberationEngineShape["initialize"] = (input) =>
    Effect.gen(function* () {
      const context = yield* resolveContext(input.channelId);
      if (context.persistedState !== null) {
        return context.persistedState;
      }

      const initializedState = createInitialDeliberationState(input.maxTurns);
      const persistedAt = input.initializedAt ?? nowIso();
      yield* context.persistState(initializedState, persistedAt);
      return initializedState;
    });

  const getState: DeliberationEngineShape["getState"] = (input) =>
    Effect.gen(function* () {
      const context = yield* resolveContext(input.channelId);
      return context.persistedState === null
        ? Option.none<DeliberationState>()
        : Option.some(context.persistedState);
    });

  const recordPost: DeliberationEngineShape["recordPost"] = (input) =>
    Effect.gen(function* () {
      const context = yield* resolveContext(input.channelId);
      yield* requireParticipant(context, input.participantThreadId);
      const currentState = yield* requireInitializedState(context);
      const nextTurnCount = currentState.turnCount + 1;
      const concluded = nextTurnCount >= currentState.maxTurns;
      const updatedState: DeliberationState = {
        ...currentState,
        turnCount: nextTurnCount,
        currentSpeaker: concluded
          ? null
          : nextSpeaker(context.participants, input.participantThreadId),
        concluded,
        lastPostTimestamp: {
          ...currentState.lastPostTimestamp,
          [input.participantThreadId]: input.postedAt,
        },
      };

      yield* context.persistState(updatedState, input.postedAt);
      return transitionFromState(context, updatedState, {
        forcedConclusion: concluded,
      });
    });

  const recordConclusionProposal: DeliberationEngineShape["recordConclusionProposal"] = (input) =>
    Effect.gen(function* () {
      const context = yield* resolveContext(input.channelId);
      yield* requireParticipant(context, input.participantThreadId);
      const currentState = yield* requireInitializedState(context);
      const conclusionProposals = {
        ...currentState.conclusionProposals,
        [input.participantThreadId]: input.summary,
      };
      const concluded = context.participants.every(
        (participant) => conclusionProposals[participant.id] !== undefined,
      );
      const updatedState: DeliberationState = {
        ...currentState,
        conclusionProposals,
        concluded,
        currentSpeaker: concluded
          ? null
          : nextSpeaker(context.participants, input.participantThreadId),
      };

      yield* context.persistState(updatedState, input.proposedAt);
      return transitionFromState(context, updatedState);
    });

  const recover: DeliberationEngineShape["recover"] = (input) =>
    Effect.gen(function* () {
      const context = yield* resolveContext(input.channelId);
      const currentState = yield* requireInitializedState(context);
      const currentTime = input.now ?? nowIso();

      if (currentState.concluded) {
        return transitionFromState(context, currentState);
      }

      if (currentState.turnCount >= currentState.maxTurns) {
        const forcedState: DeliberationState = {
          ...currentState,
          currentSpeaker: null,
          concluded: true,
        };
        yield* context.persistState(forcedState, currentTime);
        return transitionFromState(context, forcedState, {
          forcedConclusion: true,
        });
      }

      const reinjection =
        currentState.injectionState?.status === "injected"
          ? {
              participantThreadId: currentState.injectionState.sessionId,
              injectedAtSequence: currentState.injectionState.injectedAtSequence,
              ...(currentState.injectionState.turnCorrelationId === undefined
                ? {}
                : { turnCorrelationId: currentState.injectionState.turnCorrelationId }),
            }
          : undefined;

      if (currentState.currentSpeaker === null) {
        return transitionFromState(
          context,
          currentState,
          reinjection === undefined ? undefined : { reinjection },
        );
      }

      const currentSpeakerParticipant = yield* requireParticipant(
        context,
        currentState.currentSpeaker,
      );
      const lastActivityAt = latestActivityTimestamp(currentState);
      if (
        lastActivityAt === null ||
        !isTimedOut(currentTime, lastActivityAt, currentState.stallTimeoutMs)
      ) {
        return transitionFromState(
          context,
          currentState,
          reinjection === undefined ? undefined : { reinjection },
        );
      }

      const currentNudgeCount = currentState.nudgeCount[currentState.currentSpeaker] ?? 0;
      if (currentNudgeCount >= currentState.maxNudges) {
        const forcedState: DeliberationState = {
          ...currentState,
          currentSpeaker: null,
          concluded: true,
        };
        yield* context.persistState(forcedState, currentTime);
        return transitionFromState(context, forcedState, {
          forcedConclusion: true,
          ...(reinjection === undefined ? {} : { reinjection }),
        });
      }

      const nudgedState: DeliberationState = {
        ...currentState,
        nudgeCount: {
          ...currentState.nudgeCount,
          [currentState.currentSpeaker]: currentNudgeCount + 1,
        },
      };
      yield* context.persistState(nudgedState, currentTime);
      return transitionFromState(context, nudgedState, {
        nudge: {
          participantThreadId: currentSpeakerParticipant.id,
          delivery: nudgeDeliveryForParticipant(currentSpeakerParticipant),
          message: formatStallNudge({
            participant: currentSpeakerParticipant,
            state: nudgedState,
          }),
        },
        ...(reinjection === undefined ? {} : { reinjection }),
      });
    });

  return {
    initialize,
    getState,
    recordPost,
    recordConclusionProposal,
    recover,
  } satisfies DeliberationEngineShape;
});

export const DeliberationEngineLive = Layer.effect(DeliberationEngine, makeDeliberationEngine);
