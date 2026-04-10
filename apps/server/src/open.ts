/**
 * Open - Browser/editor launch service interface.
 *
 * Owns process launch helpers for opening URLs in a browser and workspace
 * paths in a configured editor.
 *
 * @module Open
 */
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { EDITORS, OpenError, type EditorId } from "@forgetools/contracts";
import { ServiceMap, Effect, Layer } from "effect";

// ==============================
// Definitions
// ==============================

export { OpenError };

export interface OpenInEditorInput {
  readonly cwd: string;
  readonly editor: EditorId;
}

interface EditorLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

interface CommandAvailabilityOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}

const TARGET_WITH_POSITION_PATTERN = /^(.*?):(\d+)(?::(\d+))?$/;

function parseTargetPathAndPosition(target: string): {
  path: string;
  line: string | undefined;
  column: string | undefined;
} | null {
  const match = TARGET_WITH_POSITION_PATTERN.exec(target);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  return {
    path: match[1],
    line: match[2],
    column: match[3],
  };
}

function resolveCommandEditorArgs(
  editor: (typeof EDITORS)[number],
  target: string,
): ReadonlyArray<string> {
  const parsedTarget = parseTargetPathAndPosition(target);

  switch (editor.launchStyle) {
    case "direct-path":
      return [target];
    case "goto":
      return parsedTarget ? ["--goto", target] : [target];
    case "line-column": {
      if (!parsedTarget) {
        return [target];
      }

      const { path, line, column } = parsedTarget;
      return [...(line ? ["--line", line] : []), ...(column ? ["--column", column] : []), path];
    }
  }
}

function fileManagerCommandForPlatform(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  switch (platform) {
    case "darwin":
      return "open";
    case "win32":
      return "explorer";
    default:
      // In WSL, explorer.exe opens Windows File Explorer but isn't typically
      // on PATH when Windows PATH entries are stripped from the shell profile.
      // Use the full path via the /mnt/c mount.
      if (env.WSL_DISTRO_NAME) {
        return "/mnt/c/Windows/explorer.exe";
      }
      return "xdg-open";
  }
}

// ==============================
// WSL editor discovery
// ==============================

/**
 * Well-known Windows install paths for editor CLI shims.
 * Each entry maps an editor command to relative paths under user profiles
 * (AppData/Local/Programs) and system-wide Program Files directories.
 *
 * When the server runs inside WSL and Windows PATH entries aren't forwarded
 * (common when the shell profile resets PATH), we scan these locations
 * directly via the /mnt/c mount to find Windows-side editors.
 */
const WSL_EDITOR_INSTALL_PATHS: ReadonlyArray<{
  command: string;
  userRelative: string;
  systemPaths: ReadonlyArray<string>;
}> = [
  {
    command: "code",
    userRelative: "AppData/Local/Programs/Microsoft VS Code/bin/code",
    systemPaths: ["/mnt/c/Program Files/Microsoft VS Code/bin/code"],
  },
  {
    command: "code-insiders",
    userRelative: "AppData/Local/Programs/Microsoft VS Code Insiders/bin/code-insiders",
    systemPaths: ["/mnt/c/Program Files/Microsoft VS Code Insiders/bin/code-insiders"],
  },
  {
    command: "cursor",
    userRelative: "AppData/Local/Programs/cursor/resources/app/bin/cursor",
    systemPaths: [],
  },
  {
    command: "codium",
    userRelative: "AppData/Local/Programs/VSCodium/bin/codium",
    systemPaths: ["/mnt/c/Program Files/VSCodium/bin/codium"],
  },
];

const WSL_USERS_SKIP = new Set(["Default", "Public", "All Users", "Default User"]);

/**
 * Resolve the full WSL-accessible path to a Windows editor command.
 *
 * Scans well-known Windows install locations via the /mnt/c mount.
 * Prefers user installs (AppData/Local/Programs) over system installs
 * (Program Files) since system installs can be stale.
 *
 * Returns the full path (e.g. /mnt/c/Users/alice/AppData/.../bin/code)
 * or null if the editor is not found.
 */
function resolveWslEditorCommand(command: string): string | null {
  const entry = WSL_EDITOR_INSTALL_PATHS.find((e) => e.command === command);
  if (!entry) return null;

  // Scan user profile directories first (preferred over system installs)
  const usersDir = "/mnt/c/Users";
  try {
    const userDirs = readdirSync(usersDir);
    for (const user of userDirs) {
      if (WSL_USERS_SKIP.has(user)) continue;
      const fullPath = join(usersDir, user, entry.userRelative);
      if (existsSync(fullPath)) return fullPath;
    }
  } catch {
    // /mnt/c/Users not accessible — fall through to system paths
  }

  for (const systemPath of entry.systemPaths) {
    if (existsSync(systemPath)) return systemPath;
  }

  return null;
}

/**
 * Convert a Linux path to a Windows UNC path for the given WSL distro.
 * /home/user/project → \\wsl.localhost\Ubuntu\home\user\project
 */
function toWslUncPath(distro: string, linuxPath: string): string {
  const windowsSegments = linuxPath.replace(/\//g, "\\");
  return `\\\\wsl.localhost\\${distro}${windowsSegments}`;
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "");
}

function resolvePathEnvironmentVariable(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

function resolveWindowsPathExtensions(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const rawValue = env.PATHEXT;
  const fallback = [".COM", ".EXE", ".BAT", ".CMD"];
  if (!rawValue) return fallback;

  const parsed = rawValue
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith(".") ? entry.toUpperCase() : `.${entry.toUpperCase()}`));
  return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback;
}

function resolveCommandCandidates(
  command: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (platform !== "win32") return [command];
  const extension = extname(command);
  const normalizedExtension = extension.toUpperCase();

  if (extension.length > 0 && windowsPathExtensions.includes(normalizedExtension)) {
    const commandWithoutExtension = command.slice(0, -extension.length);
    return Array.from(
      new Set([
        command,
        `${commandWithoutExtension}${normalizedExtension}`,
        `${commandWithoutExtension}${normalizedExtension.toLowerCase()}`,
      ]),
    );
  }

  const candidates: string[] = [];
  for (const extension of windowsPathExtensions) {
    candidates.push(`${command}${extension}`);
    candidates.push(`${command}${extension.toLowerCase()}`);
  }
  return Array.from(new Set(candidates));
}

function isExecutableFile(
  filePath: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
): boolean {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return false;
    if (platform === "win32") {
      const extension = extname(filePath);
      if (extension.length === 0) return false;
      return windowsPathExtensions.includes(extension.toUpperCase());
    }
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

export function isCommandAvailable(
  command: string,
  options: CommandAvailabilityOptions = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const windowsPathExtensions = platform === "win32" ? resolveWindowsPathExtensions(env) : [];
  const commandCandidates = resolveCommandCandidates(command, platform, windowsPathExtensions);

  if (command.includes("/") || command.includes("\\")) {
    return commandCandidates.some((candidate) =>
      isExecutableFile(candidate, platform, windowsPathExtensions),
    );
  }

  const pathValue = resolvePathEnvironmentVariable(env);
  if (pathValue.length === 0) return false;
  const pathEntries = pathValue
    .split(resolvePathDelimiter(platform))
    .map((entry) => stripWrappingQuotes(entry.trim()))
    .filter((entry) => entry.length > 0);

  for (const pathEntry of pathEntries) {
    for (const candidate of commandCandidates) {
      if (isExecutableFile(join(pathEntry, candidate), platform, windowsPathExtensions)) {
        return true;
      }
    }
  }
  return false;
}

export function resolveAvailableEditors(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<EditorId> {
  const available: EditorId[] = [];
  const wsl =
    platform === "linux" &&
    typeof env.WSL_DISTRO_NAME === "string" &&
    env.WSL_DISTRO_NAME.length > 0;

  for (const editor of EDITORS) {
    const command = editor.command ?? fileManagerCommandForPlatform(platform, env);
    if (isCommandAvailable(command, { platform, env })) {
      available.push(editor.id);
      continue;
    }

    // In WSL, Windows editors aren't on the Linux PATH when the shell profile
    // strips Windows PATH entries. Scan well-known Windows install locations.
    if (wsl && editor.command && resolveWslEditorCommand(editor.command)) {
      available.push(editor.id);
    }
  }

  return available;
}

/**
 * OpenShape - Service API for browser and editor launch actions.
 */
export interface OpenShape {
  /**
   * Open a URL target in the default browser.
   */
  readonly openBrowser: (target: string) => Effect.Effect<void, OpenError>;

  /**
   * Open a workspace path in a selected editor integration.
   *
   * Launches the editor as a detached process so server startup is not blocked.
   */
  readonly openInEditor: (input: OpenInEditorInput) => Effect.Effect<void, OpenError>;
}

/**
 * Open - Service tag for browser/editor launch operations.
 */
export class Open extends ServiceMap.Service<Open, OpenShape>()("forge/open") {}

// ==============================
// Implementations
// ==============================

export const resolveEditorLaunch = Effect.fn("resolveEditorLaunch")(function* (
  input: OpenInEditorInput,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<EditorLaunch, OpenError> {
  yield* Effect.annotateCurrentSpan({
    "open.editor": input.editor,
    "open.cwd": input.cwd,
    "open.platform": platform,
  });
  const editorDef = EDITORS.find((editor) => editor.id === input.editor);
  if (!editorDef) {
    return yield* new OpenError({ message: `Unknown editor: ${input.editor}` });
  }

  const distro = env.WSL_DISTRO_NAME;
  const wsl = platform === "linux" && typeof distro === "string" && distro.length > 0;

  if (editorDef.command) {
    let command: string = editorDef.command;

    // In WSL, the editor command may not be on PATH. Resolve the full path
    // to the Windows-side binary via well-known install locations.
    if (wsl && !isCommandAvailable(command, { platform, env })) {
      const wslPath = resolveWslEditorCommand(command);
      if (!wslPath) {
        return yield* new OpenError({
          message: `Editor "${editorDef.label}" not found. Install it on Windows and ensure it is in a standard location.`,
        });
      }
      command = wslPath;
    }

    return {
      command,
      args: resolveCommandEditorArgs(editorDef, input.cwd),
    };
  }

  if (editorDef.id !== "file-manager") {
    return yield* new OpenError({ message: `Unsupported editor: ${input.editor}` });
  }

  const fileManagerCommand = fileManagerCommandForPlatform(platform, env);
  // In WSL, explorer.exe needs a Windows UNC path, not a Linux path
  const fileManagerArgs = wsl && distro ? [toWslUncPath(distro, input.cwd)] : [input.cwd];

  return { command: fileManagerCommand, args: fileManagerArgs };
});

export const launchDetached = (launch: EditorLaunch) =>
  Effect.gen(function* () {
    if (!isCommandAvailable(launch.command)) {
      return yield* new OpenError({ message: `Editor command not found: ${launch.command}` });
    }

    yield* Effect.callback<void, OpenError>((resume) => {
      let child;
      try {
        child = spawn(launch.command, [...launch.args], {
          detached: true,
          stdio: "ignore",
          shell: process.platform === "win32",
        });
      } catch (error) {
        return resume(
          Effect.fail(new OpenError({ message: "failed to spawn detached process", cause: error })),
        );
      }

      const handleSpawn = () => {
        child.unref();
        resume(Effect.void);
      };

      child.once("spawn", handleSpawn);
      child.once("error", (cause) =>
        resume(Effect.fail(new OpenError({ message: "failed to spawn detached process", cause }))),
      );
    });
  });

const make = Effect.gen(function* () {
  const open = yield* Effect.tryPromise({
    try: () => import("open"),
    catch: (cause) => new OpenError({ message: "failed to load browser opener", cause }),
  });

  return {
    openBrowser: (target) =>
      Effect.tryPromise({
        try: () => open.default(target),
        catch: (cause) => new OpenError({ message: "Browser auto-open failed", cause }),
      }),
    openInEditor: (input) => Effect.flatMap(resolveEditorLaunch(input), launchDetached),
  } satisfies OpenShape;
});

export const OpenLive = Layer.effect(Open, make);
