import { PhaseRunId, ThreadId } from "@forgetools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <div>{text}</div>,
}));

beforeAll(() => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    location: {
      protocol: "http:",
      host: "localhost:3000",
      origin: "http://localhost:3000",
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});

describe("GateApproval", () => {
  it("renders the gate summary, unresolved items, changes, and actions", async () => {
    const { GateApproval } = await import("./GateApproval");
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <GateApproval
          threadId={ThreadId.makeUnsafe("thread-1")}
          phaseRunId={PhaseRunId.makeUnsafe("phase-1")}
          phaseName="Review"
          summaryMarkdown="Agent reviewed the implementation and found one open issue."
          qualityCheckResults={[{ check: "test", passed: false, output: "1 failed assertion." }]}
          unresolvedItems={["Auth fallback behavior is still ambiguous."]}
          changesSummary={["4 files changed", "Added auth regression coverage"]}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain("Human Review Required");
    expect(markup).toContain("Waiting for approval.");
    expect(markup).toContain("Agent reviewed the implementation and found one open issue.");
    expect(markup).toContain("Auth fallback behavior is still ambiguous.");
    expect(markup).toContain("4 files changed");
    expect(markup).toContain('aria-keyshortcuts="a"');
    expect(markup).toContain('aria-keyshortcuts="r"');
    expect(markup).toContain("Approve &amp; Continue");
    expect(markup).toContain("Correct &amp; Retry");
    expect(markup).toContain("Reject");
  });
});
