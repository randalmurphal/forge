import assert from "node:assert/strict";

import { describe, it } from "@effect/vitest";

import {
  hasSharedChatBridge,
  invokeSharedChatBridge,
  registerSharedChatBridge,
} from "./sharedChatBridge.ts";

describe("sharedChatBridge", () => {
  it("routes messages to the registered handler", async () => {
    const token = registerSharedChatBridge(async ({ message }) => ({
      content: `posted:${message}`,
      success: true,
    }));

    const result = await invokeSharedChatBridge({
      token,
      message: "hello",
    });

    assert.deepStrictEqual(result, {
      content: "posted:hello",
      success: true,
    });
  });

  it("returns a failed result for unknown tokens", async () => {
    const result = await invokeSharedChatBridge({
      token: "missing-token",
      message: "hello",
    });

    assert.deepStrictEqual(result, {
      content: "Shared chat bridge token was not found.",
      success: false,
    });
  });

  it("tracks whether a token is registered", async () => {
    const token = registerSharedChatBridge(async () => ({
      content: "ok",
      success: true,
    }));

    assert.equal(hasSharedChatBridge(token), true);
    assert.equal(hasSharedChatBridge("missing-token"), false);
  });
});
