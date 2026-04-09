import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { QualityCheckResults } from "./QualityCheckResults";

describe("QualityCheckResults", () => {
  it("renders pass and fail rows with their status labels", () => {
    const markup = renderToStaticMarkup(
      <QualityCheckResults
        results={[
          { check: "lint", passed: true, output: "All good." },
          { check: "test", passed: false, output: "1 failed assertion." },
        ]}
      />,
    );

    expect(markup).toContain("Quality Checks");
    expect(markup).toContain("lint");
    expect(markup).toContain("test");
    expect(markup).toContain("passed");
    expect(markup).toContain("failed");
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("All good.");
    expect(markup).toContain("1 failed assertion.");
  });

  it("keeps passing checks collapsed by default and failures expanded", () => {
    const markup = renderToStaticMarkup(
      <QualityCheckResults
        results={[
          { check: "typecheck", passed: true, output: "0 errors." },
          { check: "test", passed: false, output: "Expected 200, received 401." },
        ]}
      />,
    );

    expect(markup).toMatch(/<details class="[^"]*"[^>]*><summary[^>]*>.*typecheck/s);
    expect(markup).toMatch(/<details class="[^"]*"[^>]*open=""[^>]*><summary[^>]*>.*test/s);
  });

  it("renders nothing when there are no results", () => {
    const markup = renderToStaticMarkup(<QualityCheckResults results={[]} />);

    expect(markup).toBe("");
  });
});
