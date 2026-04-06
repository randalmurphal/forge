import * as FS from "node:fs";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = Path.resolve(import.meta.dirname, "../../..");
const serverSourceRoot = Path.join(repoRoot, "apps/server/src");
const observabilityDocPath = Path.join(repoRoot, "docs/observability.md");

function collectServerSourceFiles(directory: string): string[] {
  const entries = FS.readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = Path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectServerSourceFiles(entryPath));
      continue;
    }

    if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.endsWith(".test.ts")
    ) {
      files.push(entryPath);
    }
  }

  return files;
}

describe("product identity", () => {
  it("does not leave T3-era service tags in non-test server source", () => {
    const offenders = collectServerSourceFiles(serverSourceRoot)
      .filter((filePath) => FS.readFileSync(filePath, "utf8").includes('"t3/'))
      .map((filePath) => Path.relative(repoRoot, filePath));

    expect(offenders).toEqual([]);
  });

  it("does not leave T3-era metric prefixes in non-test server source", () => {
    const offenders = collectServerSourceFiles(serverSourceRoot)
      .filter((filePath) => FS.readFileSync(filePath, "utf8").includes("t3_"))
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
});
