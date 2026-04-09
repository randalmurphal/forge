/**
 * Editor launch utilities for WSL mode.
 *
 * When Forge runs as an Electron app on Windows connected to a WSL backend,
 * the server inside WSL cannot find Windows editor commands on PATH. These
 * utilities let the Electron main process resolve and launch editors from
 * the Windows side, translating Linux paths to WSL UNC paths.
 *
 * @module editorLaunch
 */
import { existsSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { EDITORS, type EditorId } from "@forgetools/contracts";

import { toWslUncPath } from "./wsl";

// ---------------------------------------------------------------------------
// Windows PATH scanning
// ---------------------------------------------------------------------------

function resolveWindowsPathExtensions(env: NodeJS.ProcessEnv): readonly string[] {
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
  pathExtensions: readonly string[],
): readonly string[] {
  const extension = extname(command);
  const normalizedExtension = extension.toUpperCase();

  if (extension.length > 0 && pathExtensions.includes(normalizedExtension)) {
    const base = command.slice(0, -extension.length);
    return Array.from(
      new Set([
        command,
        `${base}${normalizedExtension}`,
        `${base}${normalizedExtension.toLowerCase()}`,
      ]),
    );
  }

  const candidates: string[] = [];
  for (const ext of pathExtensions) {
    candidates.push(`${command}${ext}`);
    candidates.push(`${command}${ext.toLowerCase()}`);
  }
  return Array.from(new Set(candidates));
}

function isExecutableFile(filePath: string, pathExtensions: readonly string[]): boolean {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return false;
    const extension = extname(filePath);
    if (extension.length === 0) return false;
    return pathExtensions.includes(extension.toUpperCase());
  } catch {
    return false;
  }
}

/**
 * Check if a command is available on the Windows PATH.
 * Only handles win32 semantics (semicolon-delimited PATH, PATHEXT resolution).
 */
export function isWindowsCommandAvailable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const pathExtensions = resolveWindowsPathExtensions(env);
  const candidates = resolveCommandCandidates(command, pathExtensions);

  // Absolute/relative path — check directly
  if (command.includes("/") || command.includes("\\")) {
    return candidates.some((candidate) => isExecutableFile(candidate, pathExtensions));
  }

  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  if (pathValue.length === 0) return false;

  const pathEntries = pathValue
    .split(";")
    .map((entry) => entry.replace(/^"+|"+$/g, "").trim())
    .filter((entry) => entry.length > 0);

  for (const pathEntry of pathEntries) {
    for (const candidate of candidates) {
      if (isExecutableFile(join(pathEntry, candidate), pathExtensions)) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// WSL editor launch resolution
// ---------------------------------------------------------------------------

/**
 * Matches a target path with optional :line:col suffix.
 * Group 1: path, Group 2: line, Group 3: column (optional).
 */
const TARGET_WITH_POSITION_RE = /^(.*?):(\d+)(?::(\d+))?$/;

interface EditorLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Resolve the command and args needed to open a target in an editor from
 * the Windows side, translating Linux paths to WSL UNC paths.
 *
 * Returns null if the editor definition has no command and isn't file-manager.
 */
export function resolveWslEditorLaunch(
  distro: string,
  target: string,
  editorId: string,
): EditorLaunch | null {
  const editorDef = EDITORS.find((e) => e.id === editorId);
  if (!editorDef) return null;

  // File manager: use explorer.exe with UNC path
  if (editorDef.id === "file-manager") {
    return { command: "explorer.exe", args: [toWslUncPath(distro, target)] };
  }

  if (!editorDef.command) return null;

  const parsedTarget = TARGET_WITH_POSITION_RE.exec(target);

  switch (editorDef.launchStyle) {
    case "direct-path": {
      const uncTarget = toWslUncPath(distro, target);
      return { command: editorDef.command, args: [uncTarget] };
    }
    case "goto": {
      if (parsedTarget?.[1] && parsedTarget[2]) {
        const uncPath = toWslUncPath(distro, parsedTarget[1]);
        const colSuffix = parsedTarget[3] ? `:${parsedTarget[3]}` : "";
        const uncTarget = `${uncPath}:${parsedTarget[2]}${colSuffix}`;
        return { command: editorDef.command, args: ["--goto", uncTarget] };
      }
      const uncTarget = toWslUncPath(distro, target);
      return { command: editorDef.command, args: [uncTarget] };
    }
    case "line-column": {
      if (parsedTarget?.[1] && parsedTarget[2]) {
        const uncPath = toWslUncPath(distro, parsedTarget[1]);
        return {
          command: editorDef.command,
          args: [
            ...(parsedTarget[2] ? ["--line", parsedTarget[2]] : []),
            ...(parsedTarget[3] ? ["--column", parsedTarget[3]] : []),
            uncPath,
          ],
        };
      }
      const uncTarget = toWslUncPath(distro, target);
      return { command: editorDef.command, args: [uncTarget] };
    }
  }
}

// ---------------------------------------------------------------------------
// Available editors discovery
// ---------------------------------------------------------------------------

/**
 * Scan the Windows PATH for available editor commands.
 * Returns editor IDs for editors whose CLI command is found.
 */
export function getWindowsAvailableEditors(env: NodeJS.ProcessEnv = process.env): EditorId[] {
  const available: EditorId[] = [];

  for (const editor of EDITORS) {
    if (editor.id === "file-manager") {
      // explorer.exe is always available on Windows
      if (existsSync("C:\\Windows\\explorer.exe")) {
        available.push(editor.id);
      }
      continue;
    }

    if (editor.command && isWindowsCommandAvailable(editor.command, env)) {
      available.push(editor.id);
    }
  }

  return available;
}
