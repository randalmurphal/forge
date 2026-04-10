import assert from "node:assert/strict";

import { describe, it } from "@effect/vitest";

import { describeSharedChatBridgeHttpError } from "./sharedChatMcpProcess.ts";

describe("sharedChatMcpProcess", () => {
  it("surfaces bridge response details for non-OK responses", async () => {
    const response = new Response(
      JSON.stringify({
        content: "Shared chat bridge token was not found.",
        success: false,
      }),
      {
        status: 404,
        headers: {
          "content-type": "application/json",
        },
      },
    );

    const message = await describeSharedChatBridgeHttpError(
      response,
      "http://127.0.0.1:3773/api/internal/discussion/shared-chat/post",
    );

    assert.equal(
      message,
      "Shared chat bridge returned HTTP 404 for /api/internal/discussion/shared-chat/post: Shared chat bridge token was not found.",
    );
  });
});
