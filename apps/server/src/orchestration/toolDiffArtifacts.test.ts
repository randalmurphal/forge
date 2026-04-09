import { describe, expect, it } from "vitest";

import { buildToolInlineDiffArtifact } from "./toolDiffArtifacts.ts";

describe("buildToolInlineDiffArtifact", () => {
  it("keeps an exact unified diff when the payload already includes one", () => {
    const artifact = buildToolInlineDiffArtifact({
      diff: [
        "diff --git a/apps/web/src/app.tsx b/apps/web/src/app.tsx",
        "--- a/apps/web/src/app.tsx",
        "+++ b/apps/web/src/app.tsx",
        "@@ -1 +1,2 @@",
        " export const App = () => null;",
        "+console.log('changed');",
      ].join("\n"),
    });

    expect(artifact).toMatchObject({
      availability: "exact_patch",
      files: [{ path: "apps/web/src/app.tsx", additions: 1, deletions: 0 }],
      additions: 1,
      deletions: 0,
    });
  });

  it("normalizes a single-file hunk into a renderable exact diff", () => {
    const artifact = buildToolInlineDiffArtifact({
      item: {
        changes: [{ path: "apps/server/src/orchestration/projector.test.ts" }],
      },
      diff: [
        "@@ -199,12 +199,12 @@",
        '           diff: "diff --git a/src/app.ts b/src/app.ts\\n+hello\\n",',
        '-          files: [{ path: "src/app.ts", additions: 1, deletions: 0 }],',
        '+          files: [{ path: "src/app.ts", kind: "modified", additions: 1, deletions: 0 }],',
      ].join("\n"),
    });

    expect(artifact?.availability).toBe("exact_patch");
    expect(artifact?.unifiedDiff).toContain(
      "diff --git a/apps/server/src/orchestration/projector.test.ts b/apps/server/src/orchestration/projector.test.ts",
    );
  });

  it("builds a mixed exact patch for create, delete, and modify records", () => {
    const artifact = buildToolInlineDiffArtifact({
      item: {
        changes: [
          {
            path: "diff-render-smoke/tool-created-file.md",
            kind: "created",
            diff: "# Created file\n\nhello\n",
          },
          {
            path: "diff-render-smoke/tool-deleted-file.md",
            kind: "deleted",
            diff: "# Deleted file\n\nbye\n",
          },
          {
            path: "apps/web/src/session-logic.ts",
            kind: "modified",
            diff: [
              "@@ -1,2 +1,3 @@",
              ' import { describe } from "vitest";',
              '+import { expect } from "vitest";',
              " export const value = 1;",
            ].join("\n"),
          },
        ],
      },
    });

    expect(artifact).toMatchObject({
      availability: "exact_patch",
      files: [
        { path: "diff-render-smoke/tool-created-file.md" },
        { path: "diff-render-smoke/tool-deleted-file.md" },
        { path: "apps/web/src/session-logic.ts" },
      ],
    });
    expect(artifact?.unifiedDiff).toContain(
      "diff --git a/diff-render-smoke/tool-created-file.md b/diff-render-smoke/tool-created-file.md",
    );
    expect(artifact?.unifiedDiff).toContain(
      "diff --git a/diff-render-smoke/tool-deleted-file.md b/diff-render-smoke/tool-deleted-file.md",
    );
    expect(artifact?.unifiedDiff).toContain(
      "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts",
    );
  });

  it("returns summary-only metadata when file paths exist but no patch body is available", () => {
    const artifact = buildToolInlineDiffArtifact({
      item: {
        changes: [{ path: "apps/web/src/session-logic.ts", kind: "modified" }],
      },
    });

    expect(artifact).toEqual({
      availability: "summary_only",
      files: [{ path: "apps/web/src/session-logic.ts", kind: "modified" }],
    });
  });

  it("does not double-count repeated file metadata for the same path", () => {
    const artifact = buildToolInlineDiffArtifact({
      item: {
        changes: [{ path: "apps/web/src/session-logic.ts", additions: 1, deletions: 0 }],
        files: [{ path: "apps/web/src/session-logic.ts", additions: 1, deletions: 0 }],
      },
    });

    expect(artifact).toEqual({
      availability: "summary_only",
      files: [{ path: "apps/web/src/session-logic.ts", additions: 1, deletions: 0 }],
      additions: 1,
      deletions: 0,
    });
  });

  it("returns undefined when there is no renderable file metadata", () => {
    expect(buildToolInlineDiffArtifact({ item: {} })).toBeUndefined();
  });
});
