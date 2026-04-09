import { describe, expect, it } from "vitest";

import {
  DIFF_RENDER_UNSAFE_CSS,
  buildPatchCacheKey,
  classifyDiffComplexity,
  getDiffLoadingLabel,
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
