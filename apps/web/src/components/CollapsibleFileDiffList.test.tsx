import { renderToStaticMarkup } from "react-dom/server";
import { type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: (props: { options: { diffStyle: string } }) => (
    <div data-file-diff-style={props.options.diffStyle}>mock file diff</div>
  ),
  Virtualizer: (props: { children: ReactNode }) => <div>{props.children}</div>,
}));

import { CollapsibleFileDiffList } from "./CollapsibleFileDiffList";

function makeFileDiff() {
  return {
    name: "src/example.ts",
    type: "change" as const,
    hunks: [
      {
        collapsedBefore: 0,
        additionStart: 1,
        additionCount: 3,
        additionLines: 2,
        additionLineIndex: 0,
        deletionStart: 1,
        deletionCount: 2,
        deletionLines: 1,
        deletionLineIndex: 0,
        hunkContent: [
          {
            type: "context" as const,
            lines: 1,
            additionLineIndex: 0,
            deletionLineIndex: 0,
          },
          {
            type: "change" as const,
            additions: 8,
            deletions: 1,
            additionLineIndex: 1,
            deletionLineIndex: 1,
          },
        ],
        hunkSpecs: "@@ -1,2 +1,10 @@\n",
        splitLineStart: 0,
        splitLineCount: 9,
        unifiedLineStart: 0,
        unifiedLineCount: 10,
        noEOFCRAdditions: false,
        noEOFCRDeletions: false,
      },
    ],
    splitLineCount: 9,
    unifiedLineCount: 10,
    isPartial: true,
    deletionLines: ["const alpha = 1;\n", "const beta = 2;\n"],
    additionLines: [
      "const alpha = 1;\n",
      "const beta = 3;\n",
      "const gamma = 4;\n",
      "const delta = 5;\n",
      "const epsilon = 6;\n",
      "const zeta = 7;\n",
      "const eta = 8;\n",
      "const theta = 9;\n",
      "const iota = 10;\n",
    ],
    cacheKey: "diff-file-1",
  };
}

describe("CollapsibleFileDiffList", () => {
  it("renders compact artifact-style collapsed file cards", () => {
    const markup = renderToStaticMarkup(
      <CollapsibleFileDiffList
        files={[makeFileDiff()]}
        resolvedTheme="dark"
        diffRenderMode="stacked"
        diffWordWrap={false}
        defaultExpandMode="selected-only"
        onOpenFile={() => {}}
      />,
    );

    expect(markup).toContain("FileChange");
    expect(markup).toContain("File changes");
    expect(markup).toContain("src/example.ts");
    expect(markup).toContain("Open src/example.ts in editor");
    expect(markup).toContain('data-compact-diff-expand-bar="true"');
  });

  it("keeps split mode wired through when a file card is expanded", () => {
    const markup = renderToStaticMarkup(
      <CollapsibleFileDiffList
        files={[makeFileDiff()]}
        resolvedTheme="light"
        diffRenderMode="split"
        diffWordWrap={false}
        defaultExpandMode="all"
      />,
    );

    expect(markup).toContain('data-file-diff-style="split"');
  });
});
