import {
  ChannelId,
  type ChannelMessage,
  type DeliberationState,
  type InjectionState,
  type IsoDateTime,
  type ThreadId,
} from "@forgetools/contracts";
import { Effect, Option } from "effect";

import { ChannelService } from "../Services/ChannelService.ts";

export const CODEX_CHANNEL_CONCLUSION_PREFIX = "PROPOSE_CONCLUSION" as const;

export interface ParsedCodexChannelResponse {
  readonly isConclusion: boolean;
  readonly content: string;
}

export interface PrepareCodexChannelInjectionInput {
  readonly channelId: ChannelId;
  readonly sessionId: ThreadId;
  readonly messages: ReadonlyArray<ChannelMessage>;
  readonly deliberationState: DeliberationState;
  readonly turnCorrelationId?: string;
  readonly updatedAt?: IsoDateTime;
}

export interface PreparedCodexChannelInjection {
  readonly prompt: string;
  readonly injectedAtSequence: number;
  readonly deliberationState: DeliberationState;
}

function participantLabel(message: ChannelMessage): string {
  return message.fromRole ?? message.fromType;
}

function matchesInjectionState(
  injectionState: InjectionState | undefined,
  input: {
    readonly sessionId: ThreadId;
    readonly turnCorrelationId?: string;
  },
): boolean {
  if (injectionState === undefined) {
    return false;
  }
  if (injectionState.sessionId !== input.sessionId) {
    return false;
  }
  if (
    input.turnCorrelationId !== undefined &&
    injectionState.turnCorrelationId !== undefined &&
    injectionState.turnCorrelationId !== input.turnCorrelationId
  ) {
    return false;
  }
  return true;
}

export function formatChannelInjection(messages: ReadonlyArray<ChannelMessage>): string {
  const header = [
    "=== CHANNEL UPDATE ===",
    "New messages from other participants in the shared deliberation channel.",
    "Read them carefully, then respond.",
    "",
  ].join("\n");

  const body = messages
    .map((message) => [`--- ${participantLabel(message)} ---`, message.content].join("\n"))
    .join("\n\n");

  const footer = [
    "",
    "",
    "=== END CHANNEL UPDATE ===",
    "",
    "Instructions:",
    "- Respond to the messages above with your analysis.",
    "- Your entire response will be posted to the channel.",
    `- If you believe the discussion has reached a conclusion, begin your response with ${CODEX_CHANNEL_CONCLUSION_PREFIX} followed by a summary.`,
  ].join("\n");

  return `${header}${body}${footer}`;
}

export function parseCodexChannelResponse(response: string): ParsedCodexChannelResponse {
  const trimmedStart = response.trimStart();
  if (!trimmedStart.startsWith(CODEX_CHANNEL_CONCLUSION_PREFIX)) {
    return {
      isConclusion: false,
      content: response,
    };
  }

  return {
    isConclusion: true,
    content: trimmedStart.slice(CODEX_CHANNEL_CONCLUSION_PREFIX.length).trim(),
  };
}

export function withCodexInjectionRecorded(
  state: DeliberationState,
  input: {
    readonly sessionId: ThreadId;
    readonly injectedAtSequence: number;
    readonly turnCorrelationId?: string;
  },
): DeliberationState {
  return {
    ...state,
    injectionState: {
      sessionId: input.sessionId,
      injectedAtSequence: input.injectedAtSequence,
      ...(input.turnCorrelationId === undefined
        ? {}
        : { turnCorrelationId: input.turnCorrelationId }),
      status: "injected",
    },
  };
}

export function withCodexInjectionResponseReceived(
  state: DeliberationState,
  input: {
    readonly sessionId: ThreadId;
    readonly turnCorrelationId?: string;
  },
): DeliberationState {
  if (!matchesInjectionState(state.injectionState, input)) {
    return state;
  }

  const injectionState = state.injectionState;
  if (injectionState === undefined) {
    return state;
  }

  return {
    ...state,
    injectionState: {
      ...injectionState,
      status: "response-received",
    },
  };
}

export function withCodexInjectionPersisted(
  state: DeliberationState,
  input: {
    readonly sessionId: ThreadId;
    readonly turnCorrelationId?: string;
  },
): DeliberationState {
  if (!matchesInjectionState(state.injectionState, input)) {
    return state;
  }

  const injectionState = state.injectionState;
  if (injectionState === undefined) {
    return state;
  }

  return {
    ...state,
    injectionState: {
      ...injectionState,
      status: "persisted",
    },
  };
}

export function shouldReinjectCodexChannelUpdate(
  state: DeliberationState,
  sessionId: ThreadId,
): boolean {
  return (
    state.injectionState?.sessionId === sessionId && state.injectionState.status === "injected"
  );
}

export const prepareCodexChannelInjection = Effect.fn("prepareCodexChannelInjection")(function* (
  input: PrepareCodexChannelInjectionInput,
) {
  const latestMessage = input.messages.at(-1);
  if (latestMessage === undefined) {
    return Option.none();
  }

  const channelService = yield* ChannelService;
  yield* channelService.advanceCursor({
    channelId: input.channelId,
    sessionId: input.sessionId,
    sequence: latestMessage.sequence,
    ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
  });

  return Option.some({
    prompt: formatChannelInjection(input.messages),
    injectedAtSequence: latestMessage.sequence,
    deliberationState: withCodexInjectionRecorded(input.deliberationState, {
      sessionId: input.sessionId,
      injectedAtSequence: latestMessage.sequence,
      ...(input.turnCorrelationId === undefined
        ? {}
        : { turnCorrelationId: input.turnCorrelationId }),
    }),
  });
});
