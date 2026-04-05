import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { ChannelMessage, DeliberationState, createInitialDeliberationState } from "./channel";

const decodeChannelMessage = Schema.decodeUnknownEffect(ChannelMessage);
const decodeDeliberationState = Schema.decodeUnknownEffect(DeliberationState);

it.effect("decodes channel messages with trimmed participant fields", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeChannelMessage({
      id: " message-1 ",
      channelId: " channel-1 ",
      sequence: 2,
      fromType: "agent",
      fromId: " thread-2 ",
      fromRole: " advocate ",
      content: "Counterpoint",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    assert.deepStrictEqual(parsed, {
      id: "message-1",
      channelId: "channel-1",
      sequence: 2,
      fromType: "agent",
      fromId: "thread-2",
      fromRole: "advocate",
      content: "Counterpoint",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  }),
);

it.effect("decodes deliberation state defaults and injection state", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeDeliberationState({
      strategy: "ping-pong",
      currentSpeaker: " thread-1 ",
      turnCount: 1,
      maxTurns: 6,
      conclusionProposals: {
        "thread-1": "Proceed",
      },
      concluded: false,
      lastPostTimestamp: {
        "thread-1": "2026-01-01T00:00:00.000Z",
      },
      nudgeCount: {
        "thread-1": 0,
      },
      injectionState: {
        sessionId: " thread-2 ",
        injectedAtSequence: 3,
        turnCorrelationId: " cmd-1 ",
        status: "injected",
      },
    });

    assert.strictEqual(parsed.currentSpeaker, "thread-1");
    assert.strictEqual(parsed.maxNudges, 3);
    assert.strictEqual(parsed.stallTimeoutMs, 120000);
    assert.deepStrictEqual(parsed.injectionState, {
      sessionId: "thread-2",
      injectedAtSequence: 3,
      turnCorrelationId: "cmd-1",
      status: "injected",
    });
  }),
);

it("creates initial deliberation state defaults", () => {
  assert.deepStrictEqual(createInitialDeliberationState(4), {
    strategy: "ping-pong",
    currentSpeaker: null,
    turnCount: 0,
    maxTurns: 4,
    conclusionProposals: {},
    concluded: false,
    lastPostTimestamp: {},
    nudgeCount: {},
    maxNudges: 3,
    stallTimeoutMs: 120000,
  });
});
