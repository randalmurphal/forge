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

function makeFileDiff(changeLines = 8) {
  const additions = Array.from(
    { length: changeLines },
    (_, index) => `const line${index + 1} = ${index + 1};\n`,
  );
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
            additions: changeLines,
            deletions: 1,
            additionLineIndex: 1,
            deletionLineIndex: 1,
          },
        ],
        hunkSpecs: `@@ -1,2 +1,${changeLines + 2} @@\n`,
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
    additionLines: ["const alpha = 1;\n", ...additions],
    cacheKey: "diff-file-1",
  };
}

describe("CollapsibleFileDiffList", () => {
  it("renders compact artifact-style collapsed file cards without preview code", () => {
    const markup = renderToStaticMarkup(
      <CollapsibleFileDiffList
        files={[makeFileDiff()]}
        resolvedTheme="dark"
        diffRenderMode="stacked"
        diffWordWrap={false}
        defaultExpandMode="none"
        onOpenFile={() => {}}
      />,
    );

    expect(markup).toContain("FileChange");
    expect(markup).toContain("File changes");
    expect(markup).toContain("src/example.ts");
    expect(markup).toContain("Open src/example.ts in editor");
    expect(markup).toContain('data-compact-diff-expand-bar="true"');
    expect(markup).not.toContain("@@ -1,2");
  });

  it("renders the updated split view inside the same card shell", () => {
    const markup = renderToStaticMarkup(
      <CollapsibleFileDiffList
        files={[makeFileDiff()]}
        resolvedTheme="light"
        diffRenderMode="split"
        diffWordWrap={false}
        defaultExpandMode="all"
      />,
    );

    expect(markup).toContain('data-compact-diff-split="true"');
  });

  it("uses a fixed-height scroll container when expanded content is long", () => {
    const markup = renderToStaticMarkup(
      <CollapsibleFileDiffList
        files={[makeFileDiff(24)]}
        resolvedTheme="light"
        diffRenderMode="stacked"
        diffWordWrap={false}
        defaultExpandMode="all"
      />,
    );

    expect(markup).toContain('data-compact-diff-scrollable="true"');
  });
});
