import { describe, expect, it } from "vitest";

import {
  buildCommandExecutionInlineDiffArtifact,
  parseSupportedShellMutationCommand,
} from "./commandInlineDiffArtifacts.ts";

describe("commandInlineDiffArtifacts", () => {
  it("parses rm and git rm delete commands", () => {
    const direct = parseSupportedShellMutationCommand({
      command: "rm src/remove.ts",
      workspaceRoot: "/repo",
    });
    const git = parseSupportedShellMutationCommand({
      command: "git rm -f -- src/remove.ts",
      workspaceRoot: "/repo",
    });

    expect(direct?.operations).toEqual([{ kind: "delete", path: "src/remove.ts" }]);
    expect(git?.operations).toEqual([{ kind: "delete", path: "src/remove.ts" }]);
  });

  it("parses mv and git mv rename commands", () => {
    const direct = parseSupportedShellMutationCommand({
      command: "mv src/old.ts src/new.ts",
      workspaceRoot: "/repo",
    });
    const git = parseSupportedShellMutationCommand({
      command: "git mv -- src/old.ts src/new.ts",
      workspaceRoot: "/repo",
    });
    const gitKeepExisting = parseSupportedShellMutationCommand({
      command: "git mv -k src/old.ts src/new.ts",
      workspaceRoot: "/repo",
    });

    expect(direct?.operations).toEqual([
      { kind: "rename", oldPath: "src/old.ts", newPath: "src/new.ts" },
    ]);
    expect(git?.operations).toEqual([
      { kind: "rename", oldPath: "src/old.ts", newPath: "src/new.ts" },
    ]);
    expect(gitKeepExisting?.operations).toEqual([
      { kind: "rename", oldPath: "src/old.ts", newPath: "src/new.ts" },
    ]);
  });

  it("parses supported command chains and quoted paths", () => {
    const chained = parseSupportedShellMutationCommand({
      command: '/usr/bin/zsh -lc \'mv "src/old name.ts" "src/new name.ts" && rm src/remove.ts\'',
      workspaceRoot: "/repo",
    });
    const sequential = parseSupportedShellMutationCommand({
      command: "mv src/first.ts src/second.ts; rm src/remove.ts",
      workspaceRoot: "/repo",
    });

    expect(chained?.operations).toEqual([
      { kind: "rename", oldPath: "src/old name.ts", newPath: "src/new name.ts" },
      { kind: "delete", path: "src/remove.ts" },
    ]);
    expect(sequential?.operations).toEqual([
      { kind: "rename", oldPath: "src/first.ts", newPath: "src/second.ts" },
      { kind: "delete", path: "src/remove.ts" },
    ]);
    expect(
      parseSupportedShellMutationCommand({
        command: "rm 'src/[keep]*.ts'",
        workspaceRoot: "/repo",
      })?.operations,
    ).toEqual([{ kind: "delete", path: "src/[keep]*.ts" }]);
    expect(
      parseSupportedShellMutationCommand({
        command: "rm src/\\[keep\\]\\*.ts",
        workspaceRoot: "/repo",
      })?.operations,
    ).toEqual([{ kind: "delete", path: "src/[keep]*.ts" }]);
    expect(
      parseSupportedShellMutationCommand({
        command: 'rm "$TARGET"',
        workspaceRoot: "/repo",
      }),
    ).toBeUndefined();
  });

  it("normalizes absolute paths inside the workspace", () => {
    const parsed = parseSupportedShellMutationCommand({
      command: "rm /repo/src/remove.ts",
      workspaceRoot: "/repo",
    });

    expect(parsed?.operations).toEqual([{ kind: "delete", path: "src/remove.ts" }]);
  });

  it("rejects out-of-repo paths and unsupported shell syntax", () => {
    expect(
      parseSupportedShellMutationCommand({
        command: "rm /outside/remove.ts",
        workspaceRoot: "/repo",
      }),
    ).toBeUndefined();
    expect(
      parseSupportedShellMutationCommand({
        command: "rm src/remove.ts | cat",
        workspaceRoot: "/repo",
      }),
    ).toBeUndefined();
    expect(
      parseSupportedShellMutationCommand({
        command: "rm src/remove.ts || rm src/other.ts",
        workspaceRoot: "/repo",
      }),
    ).toBeUndefined();
    expect(
      parseSupportedShellMutationCommand({
        command: "rm $TARGET",
        workspaceRoot: "/repo",
      }),
    ).toBeUndefined();
    expect(
      parseSupportedShellMutationCommand({
        command: "rm src/*.ts",
        workspaceRoot: "/repo",
      }),
    ).toBeUndefined();
    expect(
      parseSupportedShellMutationCommand({
        command: "rm -r src/remove.ts",
        workspaceRoot: "/repo",
      }),
    ).toBeUndefined();
    expect(
      parseSupportedShellMutationCommand({
        command: "mv src/a.ts src/b.ts src/c.ts",
        workspaceRoot: "/repo",
      }),
    ).toBeUndefined();
    expect(
      parseSupportedShellMutationCommand({
        command: "mv -k src/a.ts src/b.ts",
        workspaceRoot: "/repo",
      }),
    ).toBeUndefined();
    expect(
      parseSupportedShellMutationCommand({
        command: "(rm src/remove.ts)",
        workspaceRoot: "/repo",
      }),
    ).toBeUndefined();
  });

  it("builds exact delete and rename inline diffs", () => {
    const artifact = buildCommandExecutionInlineDiffArtifact({
      operations: [
        {
          kind: "rename",
          oldPath: "src/old.ts",
          newPath: "src/new.ts",
        },
        {
          kind: "delete",
          path: "src/remove.ts",
          originalContent: "export const removed = true;\n",
        },
      ],
    });

    expect(artifact?.availability).toBe("exact_patch");
    expect(artifact?.files).toEqual([
      { path: "src/new.ts", kind: "renamed" },
      { path: "src/remove.ts", kind: "deleted", deletions: 1 },
    ]);
    expect(artifact?.unifiedDiff).toContain("rename from src/old.ts");
    expect(artifact?.unifiedDiff).toContain("rename to src/new.ts");
    expect(artifact?.unifiedDiff).toContain("deleted file mode 100644");
    expect(artifact?.deletions).toBe(1);
  });

  it("falls back to summary-only when any operation lacks exact pre-state", () => {
    const artifact = buildCommandExecutionInlineDiffArtifact({
      operations: [
        {
          kind: "rename",
          oldPath: "src/old.ts",
          newPath: "src/new.ts",
          exact: false,
        },
        {
          kind: "delete",
          path: "src/remove.ts",
        },
      ],
    });

    expect(artifact).toEqual({
      availability: "summary_only",
      files: [
        { path: "src/new.ts", kind: "renamed" },
        { path: "src/remove.ts", kind: "deleted" },
      ],
    });
  });

  it("returns undefined when nothing renderable is classified", () => {
    expect(buildCommandExecutionInlineDiffArtifact({ operations: [] })).toBeUndefined();
  });
});
