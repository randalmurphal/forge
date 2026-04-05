import assert from "node:assert/strict";

import {
  ChannelId,
  ThreadId,
  createInitialDeliberationState,
  type ChannelMessage,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { vi } from "vitest";

import type { ChannelServiceShape } from "../Services/ChannelService.ts";
import { ChannelService } from "../Services/ChannelService.ts";
import {
  CODEX_CHANNEL_CONCLUSION_PREFIX,
  formatChannelInjection,
  parseCodexChannelResponse,
  prepareCodexChannelInjection,
  shouldReinjectCodexChannelUpdate,
  withCodexInjectionPersisted,
  withCodexInjectionRecorded,
  withCodexInjectionResponseReceived,
} from "./CodexChannelInjection.ts";

const channelId = ChannelId.makeUnsafe("channel-codex-injection");
const sessionId = ThreadId.makeUnsafe("thread-codex-session");
const otherSessionId = ThreadId.makeUnsafe("thread-other-session");

const messages: ReadonlyArray<ChannelMessage> = [
  {
    id: "message-1" as ChannelMessage["id"],
    channelId,
    sequence: 1,
    fromType: "agent",
    fromId: otherSessionId,
    fromRole: "advocate",
    content: "We should tighten the retry guard.",
    createdAt: "2026-04-05T21:00:00.000Z",
  },
  {
    id: "message-2" as ChannelMessage["id"],
    channelId,
    sequence: 2,
    fromType: "agent",
    fromId: otherSessionId,
    content: "The current branch ignores timeout cleanup.",
    createdAt: "2026-04-05T21:01:00.000Z",
  },
];

function unsupported(): never {
  throw new Error("Unsupported in CodexChannelInjection test.");
}

it("formats channel messages into a synthetic Codex user turn", () => {
  assert.strictEqual(
    formatChannelInjection(messages),
    [
      "=== CHANNEL UPDATE ===",
      "New messages from other participants in the shared deliberation channel.",
      "Read them carefully, then respond.",
      "--- advocate ---",
      "We should tighten the retry guard.",
      "",
      "--- agent ---",
      "The current branch ignores timeout cleanup.",
      "",
      "=== END CHANNEL UPDATE ===",
      "",
      "Instructions:",
      "- Respond to the messages above with your analysis.",
      "- Your entire response will be posted to the channel.",
      `- If you believe the discussion has reached a conclusion, begin your response with ${CODEX_CHANNEL_CONCLUSION_PREFIX} followed by a summary.`,
    ].join("\n"),
  );
});

it("parses Codex conclusion responses by exact prefix", () => {
  assert.deepStrictEqual(
    parseCodexChannelResponse(`  ${CODEX_CHANNEL_CONCLUSION_PREFIX} Ready to merge after lint.`),
    {
      isConclusion: true,
      content: "Ready to merge after lint.",
    },
  );
});

it("treats non-prefixed Codex responses as regular channel posts", () => {
  const response = `I agree with the conclusion marker ${CODEX_CHANNEL_CONCLUSION_PREFIX}, but we still need more evidence.`;
  assert.deepStrictEqual(parseCodexChannelResponse(response), {
    isConclusion: false,
    content: response,
  });
});

it("tracks injection-state transitions and pending reinjection safely", () => {
  const initialState = createInitialDeliberationState(6);
  const recorded = withCodexInjectionRecorded(initialState, {
    sessionId,
    injectedAtSequence: 2,
    turnCorrelationId: "turn-123",
  });

  assert.deepStrictEqual(recorded.injectionState, {
    sessionId,
    injectedAtSequence: 2,
    turnCorrelationId: "turn-123",
    status: "injected",
  });
  assert.strictEqual(shouldReinjectCodexChannelUpdate(recorded, sessionId), true);

  const responseReceived = withCodexInjectionResponseReceived(recorded, {
    sessionId,
    turnCorrelationId: "turn-123",
  });
  assert.strictEqual(responseReceived.injectionState?.status, "response-received");

  const persisted = withCodexInjectionPersisted(responseReceived, {
    sessionId,
    turnCorrelationId: "turn-123",
  });
  assert.strictEqual(persisted.injectionState?.status, "persisted");
  assert.strictEqual(shouldReinjectCodexChannelUpdate(persisted, sessionId), false);

  const mismatched = withCodexInjectionResponseReceived(recorded, {
    sessionId: otherSessionId,
    turnCorrelationId: "turn-123",
  });
  assert.deepStrictEqual(mismatched, recorded);
});

it.effect(
  "advances the cursor when preparing a Codex injection and records the injected state",
  () =>
    Effect.gen(function* () {
      const advanceCursor = vi.fn(
        (_: Parameters<ChannelServiceShape["advanceCursor"]>[0]) => Effect.void,
      );
      const channelService: ChannelServiceShape = {
        createChannel: () => unsupported(),
        postMessage: () => unsupported(),
        getMessages: () => unsupported(),
        getUnreadCount: () => unsupported(),
        getCursor: () => unsupported(),
        advanceCursor: advanceCursor as ChannelServiceShape["advanceCursor"],
      };

      const prepared = yield* prepareCodexChannelInjection({
        channelId,
        sessionId,
        messages,
        deliberationState: createInitialDeliberationState(6),
        turnCorrelationId: "turn-456",
        updatedAt: "2026-04-05T21:02:00.000Z",
      }).pipe(Effect.provideService(ChannelService, channelService));

      assert.strictEqual(advanceCursor.mock.calls.length, 1);
      assert.deepStrictEqual(advanceCursor.mock.calls[0]?.[0], {
        channelId,
        sessionId,
        sequence: 2,
        updatedAt: "2026-04-05T21:02:00.000Z",
      });

      assert.ok(Option.isSome(prepared));
      assert.strictEqual(prepared.value.injectedAtSequence, 2);
      assert.strictEqual(prepared.value.deliberationState.injectionState?.status, "injected");
      assert.match(prepared.value.prompt, /CHANNEL UPDATE/);
    }),
);

it.effect("does not advance the cursor when there is nothing to inject", () =>
  Effect.gen(function* () {
    const advanceCursor = vi.fn(
      (_: Parameters<ChannelServiceShape["advanceCursor"]>[0]) => Effect.void,
    );
    const channelService: ChannelServiceShape = {
      createChannel: () => unsupported(),
      postMessage: () => unsupported(),
      getMessages: () => unsupported(),
      getUnreadCount: () => unsupported(),
      getCursor: () => unsupported(),
      advanceCursor: advanceCursor as ChannelServiceShape["advanceCursor"],
    };

    const prepared = yield* prepareCodexChannelInjection({
      channelId,
      sessionId,
      messages: [],
      deliberationState: createInitialDeliberationState(6),
    }).pipe(Effect.provideService(ChannelService, channelService));

    assert.strictEqual(advanceCursor.mock.calls.length, 0);
    assert.strictEqual(Option.isNone(prepared), true);
  }),
);
