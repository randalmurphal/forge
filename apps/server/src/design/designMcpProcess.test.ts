import assert from "node:assert/strict";

import { describe, it } from "@effect/vitest";

import { describeDesignBridgeHttpError } from "./designMcpProcess.ts";

describe("designMcpProcess", () => {
  it("surfaces bridge response details for non-OK responses", async () => {
    const response = new Response(
      JSON.stringify({
        result: "Design bridge token was not found.",
        error: true,
      }),
      {
        status: 404,
        headers: {
          "content-type": "application/json",
        },
      },
    );

    const message = await describeDesignBridgeHttpError(
      response,
      "http://127.0.0.1:3773/api/internal/design/bridge",
    );

    assert.equal(
      message,
      "Design bridge returned HTTP 404 for /api/internal/design/bridge: Design bridge token was not found.",
    );
  });
});
