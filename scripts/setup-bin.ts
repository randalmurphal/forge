#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ForgeBinPaths {
  readonly repoRoot: string;
  readonly serverEntryPath: string;
  readonly binDirectoryPath: string;
  readonly binPath: string;
}

export interface ForgeBinInstallPlan extends ForgeBinPaths {
  readonly nodePath: string;
}

export interface ResolveNodePathResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type ResolveNodePathCommandRunner = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly encoding: BufferEncoding;
    readonly env: NodeJS.ProcessEnv;
  },
) => ResolveNodePathResult;

function resolveScriptDirectory(): string {
  return dirname(fileURLToPath(import.meta.url));
}

export function resolveForgeBinPaths(input?: {
  readonly repoRoot?: string;
  readonly homeDirectory?: string;
}): ForgeBinPaths {
  const repoRoot = resolve(input?.repoRoot ?? join(resolveScriptDirectory(), ".."));
  const homeDirectory = input?.homeDirectory ?? homedir();
  const binDirectoryPath = join(homeDirectory, ".local", "bin");

  return {
    repoRoot,
    serverEntryPath: join(repoRoot, "apps", "server", "dist", "bin.mjs"),
    binDirectoryPath,
    binPath: join(binDirectoryPath, "forge"),
  };
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function resolveNodePath(
  runCommand: ResolveNodePathCommandRunner = spawnSync,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const result = runCommand("bash", ["-lc", "command -v node"], {
    encoding: "utf8",
    env,
  });

  if (result.status !== 0) {
    throw new Error(
      "Could not resolve `node` from the current shell. Make sure Node is installed before running `bun run setup:bin`.",
    );
  }

  const nodePath = result.stdout.trim();
  if (nodePath.length === 0) {
    throw new Error(
      "Could not resolve `node` from the current shell. Make sure Node is installed before running `bun run setup:bin`.",
    );
  }

  return nodePath;
}

export function buildForgeWrapperScript(serverEntryPath: string, nodePath: string): string {
  return [
    "#!/usr/bin/env sh",
    "set -eu",
    `exec ${shellSingleQuote(nodePath)} ${shellSingleQuote(serverEntryPath)} "$@"`,
    "",
  ].join("\n");
}

export function createForgeBinInstallPlan(input?: {
  readonly repoRoot?: string;
  readonly homeDirectory?: string;
  readonly runCommand?: ResolveNodePathCommandRunner;
  readonly env?: NodeJS.ProcessEnv;
}): ForgeBinInstallPlan {
  if (process.platform === "win32") {
    throw new Error("`bun run setup:bin` must run in WSL, Linux, or macOS.");
  }

  const paths = resolveForgeBinPaths(input);
  const nodePath = resolveNodePath(input?.runCommand, input?.env);
  if (!existsSync(paths.serverEntryPath)) {
    throw new Error(
      `Missing server entry at ${paths.serverEntryPath}. Run \`bun run build --filter=@forgetools/server\` first.`,
    );
  }

  return {
    ...paths,
    nodePath,
  };
}

export function installForgeBin(input?: {
  readonly repoRoot?: string;
  readonly homeDirectory?: string;
  readonly runCommand?: ResolveNodePathCommandRunner;
  readonly env?: NodeJS.ProcessEnv;
}): ForgeBinInstallPlan {
  const plan = createForgeBinInstallPlan(input);

  mkdirSync(plan.binDirectoryPath, { recursive: true });
  writeFileSync(plan.binPath, buildForgeWrapperScript(plan.serverEntryPath, plan.nodePath), "utf8");
  chmodSync(plan.binPath, 0o755);

  return plan;
}

function main(): void {
  const paths = installForgeBin();
  console.info(`Installed forge wrapper at ${paths.binPath}`);
  console.info(`Using node at ${paths.nodePath}`);
  console.info(`Targets ${paths.serverEntryPath}`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}
