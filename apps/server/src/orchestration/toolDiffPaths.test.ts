import { describe, expect, it } from "vitest";

import { classifyToolDiffPaths, filterUnifiedDiffByPaths } from "./toolDiffPaths.ts";

describe("classifyToolDiffPaths", () => {
  it("keeps safe repo-relative paths and rejects traversal", () => {
    expect(
      classifyToolDiffPaths({
        workspaceRoot: "/home/rmurphy/repos/forge",
        filePaths: ["apps/web/src/app.tsx", "../escape.ts"],
      }),
    ).toEqual({
      repoRelativePaths: ["apps/web/src/app.tsx"],
      outOfRepoPaths: ["../escape.ts"],
    });
  });

  it("normalizes absolute paths inside the workspace root", () => {
    expect(
      classifyToolDiffPaths({
        workspaceRoot: "/home/rmurphy/repos/forge",
        filePaths: ["/home/rmurphy/repos/forge/apps/server/src/index.ts"],
      }),
    ).toEqual({
      repoRelativePaths: ["apps/server/src/index.ts"],
      outOfRepoPaths: [],
    });
  });

  it("maps windows and WSL UNC paths when they resolve into the workspace", () => {
    expect(
      classifyToolDiffPaths({
        workspaceRoot: "/mnt/c/dev/forge",
        filePaths: [
          "C:\\dev\\forge\\apps\\web\\src\\app.tsx",
          "\\\\wsl.localhost\\Ubuntu\\mnt\\c\\dev\\forge\\apps\\server\\src\\index.ts",
        ],
        wslDistroName: "Ubuntu",
      }),
    ).toEqual({
      repoRelativePaths: ["apps/server/src/index.ts", "apps/web/src/app.tsx"],
      outOfRepoPaths: [],
    });
  });

  it("treats unresolved outside paths as out-of-repo", () => {
    expect(
      classifyToolDiffPaths({
        workspaceRoot: "/home/rmurphy/repos/forge",
        filePaths: ["C:\\Users\\rmurphy\\Desktop\\notes.txt", "/tmp/outside.txt"],
      }),
    ).toEqual({
      repoRelativePaths: [],
      outOfRepoPaths: ["/tmp/outside.txt", "C:\\Users\\rmurphy\\Desktop\\notes.txt"],
    });
  });
});

describe("filterUnifiedDiffByPaths", () => {
  it("keeps only the diff chunks for allowed repo-relative paths", () => {
    const diff = [
      "diff --git a/apps/web/src/app.tsx b/apps/web/src/app.tsx",
      "--- a/apps/web/src/app.tsx",
      "+++ b/apps/web/src/app.tsx",
      "@@ -1 +1,2 @@",
      " export const App = () => null;",
      "+export const next = 2;",
      "",
      "diff --git a/../../.claude/plan.md b/../../.claude/plan.md",
      "--- a/../../.claude/plan.md",
      "+++ b/../../.claude/plan.md",
      "@@ -1 +1,2 @@",
      " line",
      "+outside",
    ].join("\n");

    expect(
      filterUnifiedDiffByPaths({
        diff,
        allowedPaths: ["apps/web/src/app.tsx"],
        workspaceRoot: "/home/rmurphy/repos/forge",
      }),
    ).toContain("diff --git a/apps/web/src/app.tsx b/apps/web/src/app.tsx");
    expect(
      filterUnifiedDiffByPaths({
        diff,
        allowedPaths: ["apps/web/src/app.tsx"],
        workspaceRoot: "/home/rmurphy/repos/forge",
      }),
    ).not.toContain("../../.claude/plan.md");
  });
});
