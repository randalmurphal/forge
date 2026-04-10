import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  buildForgeWrapperScript,
  installForgeBin,
  resolveForgeBinPaths,
  resolveNodePath,
  type ResolveNodePathResult,
} from "./setup-bin.ts";

const tempDirectories: Array<string> = [];

const resolvedNodePath = "/home/rmurphy/.nvm/versions/node/v24.14.1/bin/node";

function successfulResolveNodePathCommand(): ResolveNodePathResult {
  return {
    status: 0,
    stdout: `${resolvedNodePath}\n`,
    stderr: "",
  };
}

function failingResolveNodePathCommand(): ResolveNodePathResult {
  return {
    status: 1,
    stdout: "",
    stderr: "node not found",
  };
}

function makeTempDirectory(prefix: string): string {
  const directoryPath = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directoryPath);
  return directoryPath;
}

process.on("exit", () => {
  for (const directoryPath of tempDirectories.splice(0, tempDirectories.length)) {
    rmSync(directoryPath, { recursive: true, force: true });
  }
});

describe("resolveForgeBinPaths", () => {
  it.effect("resolves the repo server entry and ~/.local/bin target", () =>
    Effect.sync(() => {
      const paths = resolveForgeBinPaths({
        repoRoot: "/workspace/forge",
        homeDirectory: "/home/rmurphy",
      });

      assert.deepStrictEqual(paths, {
        repoRoot: "/workspace/forge",
        serverEntryPath: "/workspace/forge/apps/server/dist/bin.mjs",
        binDirectoryPath: "/home/rmurphy/.local/bin",
        binPath: "/home/rmurphy/.local/bin/forge",
      });
    }),
  );
});

describe("buildForgeWrapperScript", () => {
  it.effect("quotes server paths for POSIX shells", () =>
    Effect.sync(() => {
      const script = buildForgeWrapperScript(
        "/tmp/forge repo/it's/bin.mjs",
        "/tmp/node bins/node's",
      );

      assert.equal(
        script,
        "#!/usr/bin/env sh\nset -eu\nexec '/tmp/node bins/node'\"'\"'s' '/tmp/forge repo/it'\"'\"'s/bin.mjs' \"$@\"\n",
      );
    }),
  );
});

describe("resolveNodePath", () => {
  it.effect("uses the current shell to resolve node", () =>
    Effect.sync(() => {
      assert.equal(resolveNodePath(successfulResolveNodePathCommand), resolvedNodePath);
    }),
  );

  it.effect("fails clearly when node cannot be resolved", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Effect.try({
          try: () => resolveNodePath(failingResolveNodePathCommand),
          catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
        }),
      );

      assert.equal(
        error,
        "Could not resolve `node` from the current shell. Make sure Node is installed before running `bun run setup:bin`.",
      );
    }),
  );
});

describe("installForgeBin", () => {
  it.effect("writes an executable wrapper pointing at the repo build", () =>
    Effect.sync(() => {
      const repoRoot = makeTempDirectory("forge-setup-bin-repo-");
      const homeDirectory = makeTempDirectory("forge-setup-bin-home-");
      const serverEntryPath = join(repoRoot, "apps", "server", "dist", "bin.mjs");

      mkdirSync(join(repoRoot, "apps", "server", "dist"), { recursive: true });
      writeFileSync(serverEntryPath, "#!/usr/bin/env node\n", { encoding: "utf8" });
      chmodSync(serverEntryPath, 0o755);

      const paths = installForgeBin({
        repoRoot,
        homeDirectory,
        runCommand: successfulResolveNodePathCommand,
      });
      const wrapper = readFileSync(paths.binPath, "utf8");
      const wrapperMode = statSync(paths.binPath).mode & 0o777;

      assert.equal(paths.serverEntryPath, serverEntryPath);
      assert.equal(paths.nodePath, resolvedNodePath);
      assert.equal(
        wrapper,
        `#!/usr/bin/env sh\nset -eu\nexec '${resolvedNodePath}' '${serverEntryPath}' "$@"\n`,
      );
      assert.equal(wrapperMode, 0o755);
    }),
  );

  it.effect("fails clearly when the server build is missing", () =>
    Effect.gen(function* () {
      const repoRoot = makeTempDirectory("forge-setup-bin-missing-repo-");
      const homeDirectory = makeTempDirectory("forge-setup-bin-missing-home-");

      const error = yield* Effect.flip(
        Effect.try({
          try: () =>
            installForgeBin({
              repoRoot,
              homeDirectory,
              runCommand: successfulResolveNodePathCommand,
            }),
          catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
        }),
      );

      assert.equal(
        error,
        `Missing server entry at ${join(repoRoot, "apps", "server", "dist", "bin.mjs")}. Run \`bun run build --filter=@forgetools/server\` first.`,
      );
    }),
  );
});
