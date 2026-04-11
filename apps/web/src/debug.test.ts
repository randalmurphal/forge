import { describe, expect, it } from "vitest";

import { describeWebDebugError, resolveWebDebugConfig } from "./debug";

describe("debug", () => {
  it("parses explicit topics from the renderer env", () => {
    const config = resolveWebDebugConfig({
      FORGE_DEBUG: "background rpc",
    });

    expect(config.enabled).toBe(true);
    expect(config.all).toBe(false);
    expect(config.topics.has("background")).toBe(true);
    expect(config.topics.has("rpc")).toBe(true);
  });

  it("supports all-topics debug values", () => {
    const config = resolveWebDebugConfig({
      FORGE_DEBUG: "all",
    });

    expect(config.enabled).toBe(true);
    expect(config.all).toBe(true);
  });

  it("normalizes error objects for debug payloads", () => {
    const error = describeWebDebugError(new Error("boom"));

    expect(error.message).toBe("boom");
    expect(typeof error.name).toBe("string");
  });
});
