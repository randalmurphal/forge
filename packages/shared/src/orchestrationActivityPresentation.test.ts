import type { OrchestrationThreadActivity } from "@forgetools/contracts";
import { EventId } from "@forgetools/contracts";
import { describe, expect, it } from "vitest";

import { classifyOrchestrationActivityPresentation } from "./orchestrationActivityPresentation";

function makeActivity(overrides: {
  readonly kind: string;
  readonly summary?: string;
  readonly payload?: Record<string, unknown>;
}): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(crypto.randomUUID()),
    createdAt: "2026-04-14T00:00:00.000Z",
    tone: "info",
    kind: overrides.kind,
    summary: overrides.summary ?? overrides.kind,
    payload: overrides.payload ?? {},
    turnId: null,
  };
}

describe("classifyOrchestrationActivityPresentation", () => {
  it("classifies command output deltas as hidden state-only activity", () => {
    expect(
      classifyOrchestrationActivityPresentation(
        makeActivity({
          kind: "tool.output.delta",
          payload: {
            streamKind: "command_output",
            itemId: "cmd-1",
            delta: "hello",
          },
        }),
      ),
    ).toEqual({
      visibility: "state-only",
      assistantBoundary: false,
    });
  });

  it("classifies terminal interactions as hidden state-only activity", () => {
    expect(
      classifyOrchestrationActivityPresentation(
        makeActivity({
          kind: "tool.terminal.interaction",
          payload: {
            itemId: "cmd-1",
            processId: "proc-1",
            stdin: "",
          },
        }),
      ),
    ).toEqual({
      visibility: "state-only",
      assistantBoundary: false,
    });
  });

  it("ignores non-terminal MCP startup states", () => {
    expect(
      classifyOrchestrationActivityPresentation(
        makeActivity({
          kind: "mcp.status.updated",
          payload: {
            name: "demo",
            status: "starting",
          },
        }),
      ),
    ).toEqual({
      visibility: "ignore",
      assistantBoundary: false,
    });
  });

  it("surfaces terminal MCP failures inline and as assistant boundaries", () => {
    expect(
      classifyOrchestrationActivityPresentation(
        makeActivity({
          kind: "mcp.status.updated",
          payload: {
            name: "demo",
            status: "failed",
            error: "boom",
          },
        }),
      ),
    ).toEqual({
      visibility: "row",
      assistantBoundary: true,
    });
  });

  it("hides cancelled MCP startup updates", () => {
    expect(
      classifyOrchestrationActivityPresentation(
        makeActivity({
          kind: "mcp.status.updated",
          payload: {
            name: "demo",
            status: "cancelled",
          },
        }),
      ),
    ).toEqual({
      visibility: "ignore",
      assistantBoundary: false,
    });
  });

  it("surfaces runtime warnings inline without forcing assistant boundaries", () => {
    expect(
      classifyOrchestrationActivityPresentation(
        makeActivity({
          kind: "runtime.warning",
          payload: {
            message: "warning",
          },
        }),
      ),
    ).toEqual({
      visibility: "row",
      assistantBoundary: false,
    });
  });
});
