import { describe, expect, it } from "vitest";

import { isDebugTopicEnabled, parseDebugTopics } from "./debug";

describe("debug", () => {
  it("parses explicit topic lists", () => {
    const config = parseDebugTopics("background orchestration,rpc");

    expect(config.enabled).toBe(true);
    expect(config.all).toBe(false);
    expect(isDebugTopicEnabled(config, "background")).toBe(true);
    expect(isDebugTopicEnabled(config, "orchestration")).toBe(true);
    expect(isDebugTopicEnabled(config, "rpc")).toBe(true);
    expect(isDebugTopicEnabled(config, "provider")).toBe(false);
  });

  it("supports all-topics debug values", () => {
    const config = parseDebugTopics("all");

    expect(config.enabled).toBe(true);
    expect(config.all).toBe(true);
    expect(isDebugTopicEnabled(config, "background")).toBe(true);
    expect(isDebugTopicEnabled(config, "provider")).toBe(true);
  });

  it("ignores empty debug input", () => {
    const config = parseDebugTopics("");

    expect(config.enabled).toBe(false);
    expect(config.all).toBe(false);
    expect(isDebugTopicEnabled(config, "background")).toBe(false);
  });
});
