import * as FS from "node:fs";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = Path.resolve(import.meta.dirname, "../../..");
const serverSourceRoot = Path.join(repoRoot, "apps/server/src");
const observabilityDocPath = Path.join(repoRoot, "docs/observability.md");
const ignoredRepoDirectories = new Set(["coverage", "dist", "node_modules", ".turbo", ".git"]);

function collectFiles(directory: string, predicate: (entry: FS.Dirent) => boolean): string[] {
  const entries = FS.readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = Path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (ignoredRepoDirectories.has(entry.name)) {
        continue;
      }
      files.push(...collectFiles(entryPath, predicate));
      continue;
    }

    if (predicate(entry)) {
      files.push(entryPath);
    }
  }

  return files;
}

function collectServerSourceFiles(directory: string): string[] {
  return collectFiles(
    directory,
    (entry) =>
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.endsWith(".test.ts"),
  );
}

function includeSourceFile(entry: FS.Dirent): boolean {
  return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") || entry.name.endsWith(".mjs");
}

const legacyTempPrefix = String.fromCharCode(116, 51, 45);

describe("product identity", () => {
  it("does not leave T3-era service tags in non-test server source", () => {
    const offenders = collectServerSourceFiles(serverSourceRoot)
      .filter((filePath) => FS.readFileSync(filePath, "utf8").includes('"t3/'))
      .map((filePath) => Path.relative(repoRoot, filePath));

    expect(offenders).toEqual([]);
  });

  it("does not leave T3-era metric prefixes in non-test server source", () => {
    const offenders = collectServerSourceFiles(serverSourceRoot)
      .filter((filePath) => {
        const source = FS.readFileSync(filePath, "utf8");
        return source.includes("t3_") || source.includes("t3Code");
      })
      .map((filePath) => Path.relative(repoRoot, filePath));

    expect(offenders).toEqual([]);
  });

  it("ignores the Forge workspace directory instead of the legacy T3 directory", () => {
    const source = FS.readFileSync(Path.join(repoRoot, ".gitignore"), "utf8");

    expect(source).toContain(".forge");
    expect(source).not.toContain(".t3");
  });

  it("documents Forge metric prefixes in observability docs", () => {
    const source = FS.readFileSync(observabilityDocPath, "utf8");

    expect(source).toContain("forge_orchestration_command_ack_duration");
    expect(source).not.toContain("t3_orchestration_command_ack_duration");
    expect(source).not.toContain("t3_rpc_request_duration");
  });

  it("does not leave legacy temp prefixes from the old brand in apps or scripts", () => {
    const offenders = [
      ...collectFiles(Path.join(repoRoot, "apps"), includeSourceFile),
      ...collectFiles(Path.join(repoRoot, "scripts"), includeSourceFile),
    ]
      .filter((filePath) => FS.readFileSync(filePath, "utf8").includes(legacyTempPrefix))
      .map((filePath) => Path.relative(repoRoot, filePath));

    expect(offenders).toEqual([]);
  });
});
