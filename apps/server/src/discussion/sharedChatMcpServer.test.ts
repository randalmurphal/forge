import assert from "node:assert/strict";

import { describe, it } from "@effect/vitest";

import { makeSharedChatCodexMcpServerConfig } from "./sharedChatMcpServer.ts";

describe("sharedChatMcpServer", () => {
  it("builds a Codex MCP stdio config with prompt approvals", () => {
    const config = makeSharedChatCodexMcpServerConfig({
      bridgeUrl: "http://127.0.0.1:3773/api/internal/discussion/shared-chat/post",
      bridgeToken: "token-123",
      bridgeAuthToken: "auth-456",
      serverName: "forge-shared-chat-thread-1",
    });

    assert.equal(config.command, process.execPath);
    assert.equal(Array.isArray(config.args), true);
    assert.equal(config.args[1], "shared-chat-mcp");
    assert.deepStrictEqual(config.env, {
      FORGE_SHARED_CHAT_BRIDGE_URL:
        "http://127.0.0.1:3773/api/internal/discussion/shared-chat/post",
      FORGE_SHARED_CHAT_BRIDGE_TOKEN: "token-123",
      FORGE_SHARED_CHAT_BRIDGE_AUTH_TOKEN: "auth-456",
      FORGE_SHARED_CHAT_SERVER_NAME: "forge-shared-chat-thread-1",
    });
    assert.deepStrictEqual(config.tools, {
      post_to_chat: {
        approval_mode: "prompt",
      },
    });
  });
});
