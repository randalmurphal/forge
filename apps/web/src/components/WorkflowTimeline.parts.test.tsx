import { PhaseRunId, ThreadId } from "@forgetools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkflowTimelineTransitionPanel } from "./WorkflowTimeline.parts";

vi.mock("./ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <div>{text}</div>,
}));

describe("WorkflowTimelineTransitionPanel", () => {
  it("renders push-driven transition updates as polite live regions", () => {
    const markup = renderToStaticMarkup(
      <WorkflowTimelineTransitionPanel
        state={{
          kind: "quality-checks",
          anchorPhaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
          phaseName: "Implement",
          checks: [
            {
              channel: "workflow.quality-check",
              threadId: ThreadId.makeUnsafe("thread-1"),
              phaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
              checkName: "bun typecheck",
              status: "running",
              timestamp: "2026-04-06T02:00:11.000Z",
              output: "Checking workflow types...",
            },
          ],
        }}
      />,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("Running quality checks...");
    expect(markup).toContain("Checking workflow types...");
  });
});
