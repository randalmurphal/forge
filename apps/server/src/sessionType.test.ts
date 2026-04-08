import assert from "node:assert/strict";

import { describe, it } from "vitest";

import { deriveForgeSessionType, isStandaloneAgentSession } from "./sessionType";

describe("sessionType", () => {
  it("classifies top-level direct sessions as agent sessions", () => {
    assert.equal(
      deriveForgeSessionType({
        parentThreadId: null,
        phaseRunId: null,
        workflowId: null,
        discussionId: null,
        role: null,
      }),
      "agent",
    );
    assert.equal(
      isStandaloneAgentSession({
        parentThreadId: null,
        phaseRunId: null,
        workflowId: null,
        discussionId: null,
        role: null,
      }),
      true,
    );
  });

  it("classifies top-level workflow and chat containers distinctly", () => {
    assert.equal(
      deriveForgeSessionType({
        parentThreadId: null,
        phaseRunId: null,
        workflowId: "workflow-1",
        discussionId: null,
        role: null,
      }),
      "workflow",
    );
    assert.equal(
      deriveForgeSessionType({
        parentThreadId: null,
        phaseRunId: null,
        workflowId: null,
        discussionId: "debate",
        role: null,
      }),
      "chat",
    );
  });

  it("does not treat child agent sessions as standalone", () => {
    assert.equal(
      deriveForgeSessionType({
        parentThreadId: "thread-parent",
        phaseRunId: "phase-1",
        workflowId: "workflow-1",
        discussionId: null,
        role: "reviewer",
      }),
      "agent",
    );
    assert.equal(
      isStandaloneAgentSession({
        parentThreadId: "thread-parent",
        phaseRunId: "phase-1",
        workflowId: "workflow-1",
        discussionId: null,
        role: "reviewer",
      }),
      false,
    );
  });
});
