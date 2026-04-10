import { describe, expect, it } from "vitest";

import {
  COMPACT_DIFF_PREVIEW_MAX_VISIBLE_LINES,
  DIFF_RENDER_UNSAFE_CSS,
  buildCompactDiffPreviewContent,
  buildCompactDiffPreviewFromFiles,
  buildPatchCacheKey,
  classifyDiffComplexity,
  getDiffLoadingLabel,
  getCompactDiffPreviewContent,
  summarizeFileDiff,
} from "./diffRendering";

describe("buildPatchCacheKey", () => {
  it("returns a stable cache key for identical content", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch)).toBe(buildPatchCacheKey(patch));
  });

  it("normalizes outer whitespace before hashing", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(`\n${patch}\n`)).toBe(buildPatchCacheKey(patch));
  });

  it("changes when diff content changes", () => {
    const before = "diff --git a/a.ts b/a.ts\n+console.log('hello')";
    const after = "diff --git a/a.ts b/a.ts\n+console.log('hello world')";

    expect(buildPatchCacheKey(before)).not.toBe(buildPatchCacheKey(after));
  });

  it("changes when cache scope changes", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch, "diff-panel:light")).not.toBe(
      buildPatchCacheKey(patch, "diff-panel:dark"),
    );
  });
});

describe("summarizeFileDiff", () => {
  it("adds hunk-level additions and deletions for a file diff", () => {
    expect(
      summarizeFileDiff({
        name: "src/example.ts",
        type: "change",
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
            hunkContent: [],
            splitLineStart: 0,
            splitLineCount: 3,
            unifiedLineStart: 0,
            unifiedLineCount: 3,
            noEOFCRAdditions: false,
            noEOFCRDeletions: false,
          },
          {
            collapsedBefore: 4,
            additionStart: 10,
            additionCount: 4,
            additionLines: 1,
            additionLineIndex: 3,
            deletionStart: 9,
            deletionCount: 5,
            deletionLines: 3,
            deletionLineIndex: 2,
            hunkContent: [],
            splitLineStart: 7,
            splitLineCount: 5,
            unifiedLineStart: 7,
            unifiedLineCount: 5,
            noEOFCRAdditions: false,
            noEOFCRDeletions: false,
          },
        ],
        splitLineCount: 12,
        unifiedLineCount: 12,
        isPartial: true,
        deletionLines: [],
        additionLines: [],
      }),
    ).toEqual({
      additions: 3,
      deletions: 4,
    });
  });

  it("classifies large and huge diffs from summary stats", () => {
    expect(classifyDiffComplexity({ files: 4, additions: 100, deletions: 40 })).toBe("normal");
    expect(classifyDiffComplexity({ files: 60, additions: 100, deletions: 40 })).toBe("large");
    expect(classifyDiffComplexity({ files: 20, additions: 12_000, deletions: 4_000 })).toBe("huge");
  });

  it("adds the chonker loading copy for heavy diffs", () => {
    expect(getDiffLoadingLabel("Loading diff...", "normal")).toBe("Loading diff...");
    expect(getDiffLoadingLabel("Loading diff...", "large")).toBe(
      "Loading diff... This is a chonker, be patient.",
    );
  });

  it("replaces verbose unmodified-line labels with a compact ellipsis", () => {
    expect(DIFF_RENDER_UNSAFE_CSS).toContain("[data-unmodified-lines]");
    expect(DIFF_RENDER_UNSAFE_CSS).toContain('content: "..."');
  });
});

describe("compact diff previews", () => {
  it("builds compact preview lines from parsed file diffs", () => {
    const preview = buildCompactDiffPreviewFromFiles([
      {
        name: "src/example.ts",
        type: "change",
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
                type: "context",
                lines: 1,
                additionLineIndex: 0,
                deletionLineIndex: 0,
              },
              {
                type: "change",
                additions: 2,
                deletions: 1,
                additionLineIndex: 1,
                deletionLineIndex: 1,
              },
            ],
            hunkSpecs: "@@ -1,2 +1,3 @@\n",
            splitLineStart: 0,
            splitLineCount: 3,
            unifiedLineStart: 0,
            unifiedLineCount: 4,
            noEOFCRAdditions: false,
            noEOFCRDeletions: false,
          },
        ],
        splitLineCount: 3,
        unifiedLineCount: 4,
        isPartial: true,
        deletionLines: ["const a = 1;\n", "const b = 2;\n"],
        additionLines: ["const a = 1;\n", "const b = 3;\n", "const c = 4;\n"],
        cacheKey: "preview-1",
      },
    ]);

    expect(preview).toMatchObject({
      kind: "parsed",
      hasOverflow: false,
      hiddenLineCount: 0,
      visibleLines: [
        { kind: "hunk", text: "@@ -1,2 +1,3 @@" },
        { kind: "context", text: "const a = 1;" },
        { kind: "deletion", text: "const b = 2;" },
        { kind: "addition", text: "const b = 3;" },
        { kind: "addition", text: "const c = 4;" },
      ],
    });
  });

  it("marks long parsed previews as overflowing with a deterministic clamp", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,10 @@",
      " alpha",
      "-beta",
      "+beta1",
      "+beta2",
      "+beta3",
      "+beta4",
      "+beta5",
      "+beta6",
      "+beta7",
      "+beta8",
    ].join("\n");

    const preview = getCompactDiffPreviewContent(patch, "timeline:test");

    expect(preview?.kind).toBe("parsed");
    expect(preview?.hasOverflow).toBe(true);
    expect(preview?.visibleLines).toHaveLength(COMPACT_DIFF_PREVIEW_MAX_VISIBLE_LINES);
    expect(preview?.hiddenLineCount).toBeGreaterThan(0);
  });

  it("keeps raw diff fallbacks compact when the patch cannot be parsed", () => {
    const preview = getCompactDiffPreviewContent(
      ["@@ -1,2 +1,2 @@", "-old line", "+new line", " trailing text without file headers"].join(
        "\n",
      ),
      "timeline:raw",
    );

    expect(preview).toMatchObject({
      kind: "raw",
      reason: "Unsupported diff format. Showing raw patch.",
      visibleLines: [
        "@@ -1,2 +1,2 @@",
        "-old line",
        "+new line",
        " trailing text without file headers",
      ],
      hasOverflow: false,
    });
  });

  it("builds preview content directly from a raw renderable patch", () => {
    const preview = buildCompactDiffPreviewContent({
      kind: "raw",
      text: ["@@ -1 +1 @@", "-old", "+new"].join("\n"),
      reason: "Failed to parse patch. Showing raw patch.",
    });

    expect(preview).toMatchObject({
      kind: "raw",
      reason: "Failed to parse patch. Showing raw patch.",
      visibleLines: ["@@ -1 +1 @@", "-old", "+new"],
    });
  });
});
