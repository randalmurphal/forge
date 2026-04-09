import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <div>{text}</div>,
}));

describe("SummaryCard", () => {
  it("renders a markdown copy action for completed summaries", async () => {
    const { SummaryCard } = await import("./SummaryCard");
    const markup = renderToStaticMarkup(
      <SummaryCard text="- item one" model="gpt-5.4" cwd={undefined} isStreaming={false} />,
    );

    expect(markup).toContain("Summary");
    expect(markup).toContain("gpt-5.4");
    expect(markup).toContain("Copy markdown");
  });

  it("hides the markdown copy action while streaming", async () => {
    const { SummaryCard } = await import("./SummaryCard");
    const markup = renderToStaticMarkup(
      <SummaryCard text="- item one" model="gpt-5.4" cwd={undefined} isStreaming />,
    );

    expect(markup).not.toContain("Copy markdown");
  });
});
