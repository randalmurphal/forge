import { describe, it, expect } from "vitest";
import { deriveSubagentPresentation } from "./subagentPresentation";

describe("deriveSubagentPresentation", () => {
  it("shows type · model as heading with description as preview", () => {
    const result = deriveSubagentPresentation({
      agentType: "Reviewer",
      agentModel: "opus",
      agentDescription: "Find edge cases",
    });
    expect(result.heading).toBe("Reviewer \u00b7 opus");
    expect(result.preview).toBe("Find edge cases");
  });

  it("shows type alone as heading when model is missing", () => {
    const result = deriveSubagentPresentation({
      agentType: "Builder",
      agentDescription: "Implement the feature",
    });
    expect(result.heading).toBe("Builder");
    expect(result.preview).toBe("Implement the feature");
  });

  it("defaults to Agent · model when type is missing", () => {
    const result = deriveSubagentPresentation({
      agentModel: "opus",
      agentDescription: "20s sleep subagent",
    });
    expect(result.heading).toBe("Agent \u00b7 opus");
    expect(result.preview).toBe("20s sleep subagent");
  });

  it("defaults to Agent when both type and model are missing", () => {
    const result = deriveSubagentPresentation({
      agentDescription: "Inspect the parser",
    });
    expect(result.heading).toBe("Agent");
    expect(result.preview).toBe("Inspect the parser");
  });

  it("does not use prompt as preview (prompt is internal metadata)", () => {
    const result = deriveSubagentPresentation({
      agentType: "Explore",
      agentPrompt: "Find all usages of the auth middleware",
    });
    expect(result.heading).toBe("Explore");
    expect(result.preview).toBeNull();
  });

  it("does not use prompt as preview even when it differs from heading", () => {
    const result = deriveSubagentPresentation({
      agentPrompt: "Agent",
    });
    expect(result.heading).toBe("Agent");
    expect(result.preview).toBeNull();
  });

  it("falls back to fallbackLabel for preview", () => {
    const result = deriveSubagentPresentation({
      fallbackLabel: "Check auth module",
    });
    expect(result.heading).toBe("Agent");
    expect(result.preview).toBe("Check auth module");
  });

  it("ignores generic fallbackLabel values", () => {
    const result = deriveSubagentPresentation({
      fallbackLabel: "Subagent",
    });
    expect(result.heading).toBe("Agent");
    expect(result.preview).toBeNull();
  });

  it("returns Agent with no preview when no fields are provided", () => {
    const result = deriveSubagentPresentation({});
    expect(result.heading).toBe("Agent");
    expect(result.preview).toBeNull();
  });

  it("prefers description over prompt for preview", () => {
    const result = deriveSubagentPresentation({
      agentType: "Fixer",
      agentModel: "opus",
      agentDescription: "Fix the auth bug",
      agentPrompt: "The auth module has a bug where sessions expire early...",
    });
    expect(result.heading).toBe("Fixer \u00b7 opus");
    expect(result.preview).toBe("Fix the auth bug");
  });

  it("shows Agent · model with description for generic spawns", () => {
    const result = deriveSubagentPresentation({
      agentModel: "sonnet",
      agentDescription: "Research the codebase",
      agentPrompt: "Find all files that import the auth module",
    });
    expect(result.heading).toBe("Agent \u00b7 sonnet");
    expect(result.preview).toBe("Research the codebase");
  });
});
