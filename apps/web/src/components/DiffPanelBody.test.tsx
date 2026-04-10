import { type ComponentProps, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./CollapsibleFileDiffList", () => ({
  CollapsibleFileDiffList: (props: { files: unknown[] }) => (
    <div data-collapsible-file-count={props.files.length}>mock file list</div>
  ),
}));

import { DiffPanelBody } from "./DiffPanelBody";

function makeFileDiff() {
  return {
    name: "src/example.ts",
    type: "change" as const,
    hunks: [
      {
        collapsedBefore: 0,
        additionStart: 1,
        additionCount: 2,
        additionLines: 1,
        additionLineIndex: 0,
        deletionStart: 1,
        deletionCount: 1,
        deletionLines: 0,
        deletionLineIndex: 0,
        hunkContent: [
          {
            type: "change" as const,
            additions: 1,
            deletions: 0,
            additionLineIndex: 0,
            deletionLineIndex: 0,
          },
        ],
        hunkSpecs: "@@ -1 +1,2 @@\n",
        splitLineStart: 0,
        splitLineCount: 1,
        unifiedLineStart: 0,
        unifiedLineCount: 2,
        noEOFCRAdditions: false,
        noEOFCRDeletions: false,
      },
    ],
    splitLineCount: 1,
    unifiedLineCount: 2,
    isPartial: true,
    deletionLines: [],
    additionLines: ["const alpha = 1;\n"],
    cacheKey: "file-1",
  };
}

function renderBody(overrides: Partial<ComponentProps<typeof DiffPanelBody>> = {}) {
  const props: ComponentProps<typeof DiffPanelBody> = {
    patchViewportRef: createRef<HTMLDivElement>(),
    diffSurfaceLabel: "Turn changes",
    diffMode: "agent",
    renderablePatch: null,
    renderableFiles: [],
    resolvedTheme: "dark",
    diffRenderMode: "stacked",
    diffWordWrap: false,
    selectedFilePath: null,
    onOpenFile: () => {},
    showWorkspaceFallback: false,
    showDeferredRenderCard: false,
    onRenderDeferred: () => {},
    canRefreshWorkspace: false,
    onRefreshWorkspace: () => {},
    isLoadingPatch: false,
    loadingLabel: "Loading agent diff...",
    patchError: null,
    hasNoNetChanges: false,
    isWholeThreadNetDiffUnavailable: false,
    viewDiffTotals: null,
    confirmExpandAll: false,
    ...overrides,
  };

  return renderToStaticMarkup(<DiffPanelBody {...props} />);
}

describe("DiffPanelBody", () => {
  it("renders the compact fallback note above file lists", () => {
    const file = makeFileDiff();
    const markup = renderBody({
      showWorkspaceFallback: true,
      renderablePatch: { kind: "files", files: [file] },
      renderableFiles: [file],
    });

    expect(markup).toContain("Agent attribution is unavailable for this turn.");
    expect(markup).toContain('data-collapsible-file-count="1"');
  });

  it("renders raw patches inside the compact diff shell", () => {
    const rawText = Array.from({ length: 28 }, (_, index) => `+line ${index + 1}`).join("\n");
    const markup = renderBody({
      renderablePatch: {
        kind: "raw",
        text: rawText,
        reason: "Failed to parse patch. Showing raw patch.",
      },
      viewDiffTotals: { files: 1, additions: 28, deletions: 0 },
    });

    expect(markup).toContain("Turn changes");
    expect(markup).toContain("Failed to parse patch. Showing raw patch.");
    expect(markup).toContain('data-compact-diff-scrollable="true"');
  });

  it("renders deferred huge diffs inside the compact card shell", () => {
    const markup = renderBody({
      diffSurfaceLabel: "Workspace changes",
      diffMode: "workspace",
      showDeferredRenderCard: true,
      canRefreshWorkspace: true,
      viewDiffTotals: { files: 3, additions: 47, deletions: 12 },
    });

    expect(markup).toContain("Workspace changes");
    expect(markup).toContain("This diff is huge.");
    expect(markup).toContain("Render diff");
    expect(markup).toContain("Refresh");
  });

  it("renders loading states inside the compact shell", () => {
    const markup = renderBody({
      isLoadingPatch: true,
      loadingLabel: "Loading workspace diff... This is a chonker, be patient.",
    });

    expect(markup).toContain("Loading diff");
    expect(markup).toContain("Loading workspace diff... This is a chonker, be patient.");
  });

  it("renders patch errors inside the compact shell", () => {
    const markup = renderBody({
      patchError: "Failed to load workspace diff.",
    });

    expect(markup).toContain("Diff unavailable");
    expect(markup).toContain("Failed to load workspace diff.");
  });

  it("renders clean empty states inside the compact shell", () => {
    const markup = renderBody({
      diffMode: "workspace",
      hasNoNetChanges: true,
    });

    expect(markup).toContain("No diff to render");
    expect(markup).toContain("Working tree is clean.");
  });
});
