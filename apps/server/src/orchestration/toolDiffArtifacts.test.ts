import { describe, expect, it } from "vitest";

import { buildToolInlineDiffArtifact } from "./toolDiffArtifacts.ts";

describe("buildToolInlineDiffArtifact", () => {
  it("keeps an exact unified diff when the payload already includes one", () => {
    const artifact = buildToolInlineDiffArtifact({
      provider: "codex",
      payloadData: {
        diff: [
          "diff --git a/apps/web/src/app.tsx b/apps/web/src/app.tsx",
          "--- a/apps/web/src/app.tsx",
          "+++ b/apps/web/src/app.tsx",
          "@@ -1 +1,2 @@",
          " export const App = () => null;",
          "+console.log('changed');",
        ].join("\n"),
      },
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
      provider: "codex",
      payloadData: {
        item: {
          changes: [{ path: "apps/server/src/orchestration/projector.test.ts" }],
        },
        diff: [
          "@@ -199,12 +199,12 @@",
          '           diff: "diff --git a/src/app.ts b/src/app.ts\\n+hello\\n",',
          '-          files: [{ path: "src/app.ts", additions: 1, deletions: 0 }],',
          '+          files: [{ path: "src/app.ts", kind: "modified", additions: 1, deletions: 0 }],',
        ].join("\n"),
      },
    });

    expect(artifact?.availability).toBe("exact_patch");
    expect(artifact?.unifiedDiff).toContain(
      "diff --git a/apps/server/src/orchestration/projector.test.ts b/apps/server/src/orchestration/projector.test.ts",
    );
  });

  it("builds a mixed exact patch for create, delete, and modify records", () => {
    const artifact = buildToolInlineDiffArtifact({
      provider: "codex",
      payloadData: {
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
      provider: "codex",
      payloadData: {
        item: {
          changes: [{ path: "apps/web/src/session-logic.ts", kind: "modified" }],
        },
      },
    });

    expect(artifact).toEqual({
      availability: "summary_only",
      files: [{ path: "apps/web/src/session-logic.ts", kind: "modified" }],
    });
  });

  it("does not double-count repeated file metadata for the same path", () => {
    const artifact = buildToolInlineDiffArtifact({
      provider: "codex",
      payloadData: {
        item: {
          changes: [{ path: "apps/web/src/session-logic.ts", additions: 1, deletions: 0 }],
          files: [{ path: "apps/web/src/session-logic.ts", additions: 1, deletions: 0 }],
        },
      },
    });

    expect(artifact).toEqual({
      availability: "summary_only",
      files: [{ path: "apps/web/src/session-logic.ts", additions: 1, deletions: 0 }],
      additions: 1,
      deletions: 0,
    });
  });

  it("uses provider-owned Claude exact diffs while keeping generic file metadata", () => {
    const artifact = buildToolInlineDiffArtifact({
      provider: "claudeAgent",
      payloadData: {
        unifiedDiff: [
          "diff --git a/apps/server/src/example.ts b/apps/server/src/example.ts",
          "--- a/apps/server/src/example.ts",
          "+++ b/apps/server/src/example.ts",
          "@@ -1 +1,2 @@",
          " export const value = 1;",
          "+export const next = 2;",
        ].join("\n"),
        result: {
          type: "tool_result",
          tool_use_id: "tool-write-1",
        },
        toolUseResult: {
          type: "update",
          filePath: "apps/server/src/example.ts",
        },
      },
    });

    expect(artifact).toMatchObject({
      availability: "exact_patch",
      files: [{ path: "apps/server/src/example.ts", additions: 1, deletions: 0 }],
      additions: 1,
      deletions: 0,
    });
    expect(artifact?.unifiedDiff).toContain(
      "diff --git a/apps/server/src/example.ts b/apps/server/src/example.ts",
    );
  });

  it("keeps unknown Claude tool results summary-only", () => {
    const artifact = buildToolInlineDiffArtifact({
      provider: "claudeAgent",
      payloadData: {
        item: {
          changes: [{ path: "apps/server/src/example.ts", kind: "modified" }],
        },
        toolUseResult: {
          unexpected: true,
        },
      },
    });

    expect(artifact).toEqual({
      availability: "summary_only",
      files: [{ path: "apps/server/src/example.ts", kind: "modified" }],
    });
  });

  it("does not synthesize exact Claude diffs from unknown nested tool_use_result fields", () => {
    const artifact = buildToolInlineDiffArtifact({
      provider: "claudeAgent",
      payloadData: {
        toolUseResult: {
          filePath: "apps/server/src/example.ts",
          diff: ["@@ -1 +1,2 @@", " export const value = 1;", "+export const next = 2;"].join("\n"),
        },
      },
    });

    expect(artifact).toEqual({
      availability: "summary_only",
      files: [{ path: "apps/server/src/example.ts" }],
    });
  });

  it("parses native Codex multi-file change records with object kinds", () => {
    const artifact = buildToolInlineDiffArtifact({
      provider: "codex",
      payloadData: {
        item: {
          changes: [
            {
              path: "apps/server/src/first.ts",
              kind: { type: "update", move_path: null },
              diff: ["@@ -1 +1,2 @@", " export const first = 1;", "+export const next = 2;"].join(
                "\n",
              ),
            },
            {
              path: "apps/server/src/second.ts",
              kind: { type: "update", move_path: null },
              diff: ["@@ -1 +1,2 @@", " export const second = 1;", "+export const next = 2;"].join(
                "\n",
              ),
            },
          ],
        },
      },
    });

    expect(artifact?.availability).toBe("exact_patch");
    expect(artifact?.files.map((file) => file.path).toSorted()).toEqual([
      "apps/server/src/first.ts",
      "apps/server/src/second.ts",
    ]);
    expect(artifact?.unifiedDiff).toContain("diff --git a/apps/server/src/first.ts");
    expect(artifact?.unifiedDiff).toContain("diff --git a/apps/server/src/second.ts");
  });

  it("parses Codex add, delete, unified_diff, and move_path records", () => {
    const artifact = buildToolInlineDiffArtifact({
      provider: "codex",
      payloadData: {
        item: {
          changes: [
            {
              path: "apps/server/src/created.ts",
              kind: { type: "add" },
              content: "export const created = true;\n",
            },
            {
              path: "apps/server/src/deleted.ts",
              kind: { type: "delete" },
              content: "export const deleted = true;\n",
            },
            {
              path: "apps/server/src/renamed-before.ts",
              kind: { type: "update", move_path: "apps/server/src/renamed-after.ts" },
              unified_diff: [
                "@@ -1 +1 @@",
                '-export const value = "before";',
                '+export const value = "after";',
              ].join("\n"),
            },
          ],
        },
      },
    });

    expect(artifact?.availability).toBe("exact_patch");
    expect(artifact?.files.map((file) => file.path).toSorted()).toEqual([
      "apps/server/src/created.ts",
      "apps/server/src/deleted.ts",
      "apps/server/src/renamed-after.ts",
    ]);
    expect(
      artifact?.files.find((file) => file.path === "apps/server/src/renamed-after.ts")?.kind,
    ).toBe("renamed");
    expect(artifact?.unifiedDiff).toContain("rename from apps/server/src/renamed-before.ts");
    expect(artifact?.unifiedDiff).toContain("rename to apps/server/src/renamed-after.ts");
  });

  it("synthesizes exact Codex diffs for empty add/delete content and pure renames", () => {
    const artifact = buildToolInlineDiffArtifact({
      provider: "codex",
      payloadData: {
        item: {
          changes: [
            {
              path: "apps/server/src/empty-created.ts",
              kind: { type: "add" },
              content: "",
            },
            {
              path: "apps/server/src/empty-deleted.ts",
              kind: { type: "delete" },
              content: "",
            },
            {
              path: "apps/server/src/rename-only-before.ts",
              kind: { type: "update", move_path: "apps/server/src/rename-only-after.ts" },
            },
          ],
        },
      },
    });

    expect(artifact?.availability).toBe("exact_patch");
    expect(artifact?.files.map((file) => file.path).toSorted()).toEqual([
      "apps/server/src/empty-created.ts",
      "apps/server/src/empty-deleted.ts",
      "apps/server/src/rename-only-after.ts",
    ]);
    expect(artifact?.unifiedDiff).toContain("new file mode 100644");
    expect(artifact?.unifiedDiff).toContain("deleted file mode 100644");
    expect(artifact?.unifiedDiff).toContain("rename from apps/server/src/rename-only-before.ts");
    expect(artifact?.unifiedDiff).toContain("rename to apps/server/src/rename-only-after.ts");
  });

  it("normalizes absolute Codex paths into repo-relative exact patches", () => {
    const artifact = buildToolInlineDiffArtifact({
      provider: "codex",
      payloadData: {
        item: {
          changes: [
            {
              path: "/repo/apps/server/src/example.ts",
              kind: { type: "update", move_path: null },
              diff: ["@@ -1 +1,2 @@", " export const value = 1;", "+export const next = 2;"].join(
                "\n",
              ),
            },
          ],
        },
      },
      workspaceRoot: "/repo",
    });

    expect(artifact).toMatchObject({
      availability: "exact_patch",
      files: [{ path: "apps/server/src/example.ts", kind: "modified", additions: 1, deletions: 0 }],
      additions: 1,
      deletions: 0,
    });
    expect(artifact?.unifiedDiff).toContain(
      "diff --git a/apps/server/src/example.ts b/apps/server/src/example.ts",
    );
    expect(artifact?.unifiedDiff).not.toContain("/repo/apps/server/src/example.ts");
  });

  it("downgrades out-of-repo exact patches to summary-only when workspace normalization fails", () => {
    const artifact = buildToolInlineDiffArtifact({
      provider: "codex",
      payloadData: {
        item: {
          changes: [
            {
              path: "C:\\Users\\rmurphy\\Desktop\\notes.txt",
              kind: { type: "update", move_path: null },
              diff: [
                "diff --git a/C:\\Users\\rmurphy\\Desktop\\notes.txt b/C:\\Users\\rmurphy\\Desktop\\notes.txt",
                "--- a/C:\\Users\\rmurphy\\Desktop\\notes.txt",
                "+++ b/C:\\Users\\rmurphy\\Desktop\\notes.txt",
                "@@ -1 +1,2 @@",
                " hello",
                "+outside",
              ].join("\n"),
            },
          ],
        },
      },
      workspaceRoot: "/repo",
    });

    expect(artifact).toEqual({
      availability: "summary_only",
      files: [{ path: "C:\\Users\\rmurphy\\Desktop\\notes.txt", kind: "modified" }],
    });
  });

  it("downgrades out-of-repo Claude exact patches to summary-only when workspace normalization fails", () => {
    const artifact = buildToolInlineDiffArtifact({
      provider: "claudeAgent",
      payloadData: {
        unifiedDiff: [
          "diff --git a/C:\\Users\\rmurphy\\Desktop\\notes.txt b/C:\\Users\\rmurphy\\Desktop\\notes.txt",
          "--- a/C:\\Users\\rmurphy\\Desktop\\notes.txt",
          "+++ b/C:\\Users\\rmurphy\\Desktop\\notes.txt",
          "@@ -1 +1,2 @@",
          " hello",
          "+outside",
        ].join("\n"),
        toolUseResult: {
          filePath: "C:\\Users\\rmurphy\\Desktop\\notes.txt",
          type: "update",
        },
      },
      workspaceRoot: "/repo",
    });

    expect(artifact).toEqual({
      availability: "summary_only",
      files: [{ path: "C:\\Users\\rmurphy\\Desktop\\notes.txt" }],
    });
  });

  it("normalizes absolute multi-file Codex paths for add and update records", () => {
    const artifact = buildToolInlineDiffArtifact({
      provider: "codex",
      payloadData: {
        item: {
          changes: [
            {
              path: "/repo/apps/server/src/created.ts",
              kind: { type: "add" },
              diff: "export const created = true;\n",
            },
            {
              path: "/repo/apps/server/src/example.ts",
              kind: { type: "update", move_path: null },
              diff: ["@@ -1 +1,2 @@", " export const value = 1;", "+export const next = 2;"].join(
                "\n",
              ),
            },
          ],
        },
      },
      workspaceRoot: "/repo",
    });

    expect(artifact?.availability).toBe("exact_patch");
    expect(artifact?.files.map((file) => file.path).toSorted()).toEqual([
      "apps/server/src/created.ts",
      "apps/server/src/example.ts",
    ]);
    expect(artifact?.unifiedDiff).toContain("diff --git a/apps/server/src/created.ts");
    expect(artifact?.unifiedDiff).toContain("diff --git a/apps/server/src/example.ts");
    expect(artifact?.unifiedDiff).not.toContain("/repo/apps/server/src/");
  });

  it("deduplicates absolute Claude Edit metadata against a relative exact patch", () => {
    const artifact = buildToolInlineDiffArtifact({
      provider: "claudeAgent",
      payloadData: {
        unifiedDiff: [
          "diff --git a/apps/server/src/example.ts b/apps/server/src/example.ts",
          "--- a/apps/server/src/example.ts",
          "+++ b/apps/server/src/example.ts",
          "@@ -1 +1,2 @@",
          " export const value = 1;",
          "+export const next = 2;",
        ].join("\n"),
        toolUseResult: {
          filePath: "/repo/apps/server/src/example.ts",
          oldString: "export const value = 1;\n",
          newString: "export const value = 1;\nexport const next = 2;\n",
          originalFile: "export const value = 1;\n",
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 2,
              lines: [" export const value = 1;", "+export const next = 2;"],
            },
          ],
        },
      },
      workspaceRoot: "/repo",
    });

    expect(artifact).toMatchObject({
      availability: "exact_patch",
      files: [{ path: "apps/server/src/example.ts", additions: 1, deletions: 0 }],
      additions: 1,
      deletions: 0,
    });
    expect(artifact?.files).toHaveLength(1);
  });

  it("normalizes absolute Claude Write update and create metadata", () => {
    const updateArtifact = buildToolInlineDiffArtifact({
      provider: "claudeAgent",
      payloadData: {
        unifiedDiff: [
          "diff --git a/apps/server/src/example.ts b/apps/server/src/example.ts",
          "--- a/apps/server/src/example.ts",
          "+++ b/apps/server/src/example.ts",
          "@@ -1,2 +1,2 @@",
          "-export const value = 1;",
          "-export const next = 2;",
          "+export const value = 10;",
          "+export const next = 20;",
        ].join("\n"),
        toolUseResult: {
          type: "update",
          filePath: "/repo/apps/server/src/example.ts",
          content: "export const value = 10;\nexport const next = 20;\n",
          originalFile: "export const value = 1;\nexport const next = 2;\n",
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 2,
              newStart: 1,
              newLines: 2,
              lines: [
                "-export const value = 1;",
                "-export const next = 2;",
                "+export const value = 10;",
                "+export const next = 20;",
              ],
            },
          ],
        },
      },
      workspaceRoot: "/repo",
    });

    const createArtifact = buildToolInlineDiffArtifact({
      provider: "claudeAgent",
      payloadData: {
        unifiedDiff: [
          "diff --git a/apps/server/src/created.ts b/apps/server/src/created.ts",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/apps/server/src/created.ts",
          "@@ -0,0 +1,1 @@",
          "+export const created = true;",
        ].join("\n"),
        toolUseResult: {
          type: "create",
          filePath: "/repo/apps/server/src/created.ts",
          content: "export const created = true;",
          structuredPatch: [],
          originalFile: null,
        },
      },
      workspaceRoot: "/repo",
    });

    expect(updateArtifact?.files).toEqual([
      { path: "apps/server/src/example.ts", additions: 2, deletions: 2 },
    ]);
    expect(createArtifact?.files).toEqual([
      { path: "apps/server/src/created.ts", additions: 1, deletions: 0 },
    ]);
  });

  it("returns undefined when there is no renderable file metadata", () => {
    expect(
      buildToolInlineDiffArtifact({
        provider: "codex",
        payloadData: { item: {} },
      }),
    ).toBeUndefined();
  });
});
