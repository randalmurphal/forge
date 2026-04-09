import { execFileSync, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface WslDistro {
  readonly name: string;
  readonly isDefault: boolean;
  readonly state: "Running" | "Stopped" | "Installing" | string;
  readonly version: number;
}

const WSL_EXEC_TIMEOUT_MS = 10_000;

function resolveWslExePath(): string {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return join(systemRoot, "System32", "wsl.exe");
}

/**
 * Check if WSL is available by testing for wsl.exe on disk.
 * Returns false on non-Windows platforms.
 */
export function isWslAvailable(): boolean {
  if (process.platform !== "win32") return false;

  const wslPath = resolveWslExePath();
  if (existsSync(wslPath)) return true;

  // Fallback: try running wsl.exe in case it's on PATH but not at the expected location
  try {
    execFileSync("wsl.exe", ["--list"], {
      windowsHide: true,
      timeout: 5_000,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse the pre-decoded output of `wsl.exe -l -v` into structured distro entries.
 *
 * Uses column-offset parsing based on the header positions so that distro names
 * containing spaces (e.g. "Ubuntu 24.04 LTS") are handled correctly.
 *
 * Expected format (after UTF-16LE decode, BOM strip, null char removal):
 *   NAME            STATE           VERSION
 * * Ubuntu          Running         2
 *   Debian          Stopped         2
 *
 * The `*` prefix marks the default distro.
 */
export function parseDistroOutput(decoded: string): WslDistro[] {
  const normalized = decoded.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n").filter((line) => line.trim().length > 0);

  if (lines.length < 2) return [];

  const header = lines[0]!;
  const stateCol = header.indexOf("STATE");
  const versionCol = header.indexOf("VERSION");

  // If the header doesn't contain the expected column markers, bail out
  if (stateCol === -1 || versionCol === -1) return [];

  const distros: WslDistro[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;

    // Lines shorter than the STATE column offset can't contain valid data
    if (line.length < stateCol + 1) continue;

    const isDefault = line.trimStart().startsWith("*");

    // NAME field: starts after the `* ` or `  ` prefix and ends at the STATE column
    const nameRaw = line.slice(2, stateCol).trimEnd();
    if (nameRaw.length === 0) continue;

    // STATE field: from stateCol to versionCol
    const stateRaw = line.slice(stateCol, versionCol).trim();
    if (stateRaw.length === 0) continue;

    // VERSION field: from versionCol to end of line
    const versionRaw = line.slice(versionCol).trim();
    const version = parseInt(versionRaw, 10);
    if (isNaN(version)) continue;

    distros.push({ name: nameRaw, isDefault, state: stateRaw, version });
  }

  return distros;
}

/**
 * List installed WSL distros by running `wsl.exe -l -v`.
 *
 * IMPORTANT: wsl.exe outputs UTF-16LE — this is a known quirk.
 * We must decode the raw buffer as utf16le before parsing.
 */
export function listDistros(): WslDistro[] {
  try {
    const raw = execFileSync("wsl.exe", ["-l", "-v"], {
      windowsHide: true,
      timeout: WSL_EXEC_TIMEOUT_MS,
      encoding: "buffer",
    });

    const decoded = raw
      .toString("utf16le")
      // Strip BOM and null characters left by UTF-16LE encoding
      .replace(/\uFEFF/g, "")
      .replace(new RegExp(String.fromCharCode(0), "g"), "");

    return parseDistroOutput(decoded);
  } catch {
    return [];
  }
}

/**
 * Resolve the Linux home directory for a specific distro.
 * Runs: wsl.exe -d <distro> -- bash -lc 'echo $HOME'
 * The -l flag gives a login shell so PATH and env are fully resolved.
 */
export function resolveWslHome(distro: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "wsl.exe",
      ["-d", distro, "--", "bash", "-lc", "echo $HOME"],
      { windowsHide: true, timeout: WSL_EXEC_TIMEOUT_MS, encoding: "utf8" },
      (error, stdout) => {
        if (error) {
          reject(new Error(`Failed to resolve HOME in WSL distro "${distro}"`, { cause: error }));
          return;
        }

        const home = stdout.trim();
        if (home.length === 0) {
          reject(new Error(`wsl.exe returned empty HOME for distro "${distro}"`));
          return;
        }

        resolve(home);
      },
    );
  });
}

/**
 * Check if the forge binary exists in a distro.
 * Runs: wsl.exe -d <distro> -- bash -lc 'which forge'
 * Returns the path if found, undefined if the command fails.
 */
export function findForgeBinary(distro: string): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    execFile(
      "wsl.exe",
      ["-d", distro, "--", "bash", "-lc", "which forge"],
      { windowsHide: true, timeout: WSL_EXEC_TIMEOUT_MS, encoding: "utf8" },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }

        const path = stdout.trim();
        resolve(path.length > 0 ? path : undefined);
      },
    );
  });
}

/**
 * Convert a WSL Linux path to a Windows UNC path.
 * /home/user/.forge → \\wsl.localhost\Ubuntu\home\user\.forge
 */
export function toWslUncPath(distro: string, linuxPath: string): string {
  const windowsSegments = linuxPath.replace(/\//g, "\\");
  return `\\\\wsl.localhost\\${distro}${windowsSegments}`;
}
