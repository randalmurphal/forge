import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { buildCompactDiffPreviewFromFiles } from "~/lib/diffRendering";

import { CompactDiffPreview } from "./CompactDiffPreview";

function makePreviewContent(changeLines = 24) {
  return buildCompactDiffPreviewFromFiles([
    {
      name: "src/example.ts",
      type: "change",
      hunks: [
        {
          collapsedBefore: 0,
          additionStart: 1,
          additionCount: changeLines + 1,
          additionLines: changeLines,
          additionLineIndex: 0,
          deletionStart: 1,
          deletionCount: 2,
          deletionLines: 1,
          deletionLineIndex: 0,
          hunkContent: [
            {
              type: "context",
              lines: 1,
              additionLineIndex: 0,
              deletionLineIndex: 0,
            },
            {
              type: "change",
              additions: changeLines,
              deletions: 1,
              additionLineIndex: 1,
              deletionLineIndex: 1,
            },
          ],
          hunkSpecs: `@@ -1,2 +1,${changeLines + 1} @@\n`,
          splitLineStart: 0,
          splitLineCount: changeLines + 1,
          unifiedLineStart: 0,
          unifiedLineCount: changeLines + 2,
          noEOFCRAdditions: false,
          noEOFCRDeletions: false,
        },
      ],
      splitLineCount: changeLines + 1,
      unifiedLineCount: changeLines + 2,
      isPartial: true,
      deletionLines: ["const alpha = 1;\n", "const beta = 2;\n"],
      additionLines: [
        "const alpha = 1;\n",
        ...Array.from(
          { length: changeLines },
          (_, index) => `const line${index + 1} = ${index + 1};\n`,
        ),
      ],
      cacheKey: `preview:${changeLines}`,
    },
  ]);
}

describe("CompactDiffPreview", () => {
  it("keeps collapsed panel previews hidden", () => {
    const markup = renderToStaticMarkup(
      <CompactDiffPreview
        content={makePreviewContent(8)}
        expanded={false}
        collapsedBehavior="hidden"
        emptyLabel="No preview"
      />,
    );

    expect(markup).toBe("");
  });

  it("uses a scroll container for expanded inline previews once they exceed the max height", () => {
    const markup = renderToStaticMarkup(
      <CompactDiffPreview
        content={makePreviewContent(24)}
        expanded={true}
        emptyLabel="No preview"
      />,
    );

    expect(markup).toContain('data-compact-diff-scrollable="true"');
  });

  it("renders expanded split previews with the compact split layout", () => {
    const markup = renderToStaticMarkup(
      <CompactDiffPreview
        content={makePreviewContent(8)}
        expanded={true}
        renderMode="split"
        emptyLabel="No preview"
      />,
    );

    expect(markup).toContain('data-compact-diff-split="true"');
  });
});
