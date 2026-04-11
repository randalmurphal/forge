import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

const DEBUG_TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export const isBackgroundDebugEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  DEBUG_TRUE_VALUES.has(env.FORGE_DEBUG_BACKGROUND_TASKS?.trim().toLowerCase() ?? "");

export const resolveBackgroundDebugLogPath = (
  env: NodeJS.ProcessEnv = process.env,
  homedir = OS.homedir(),
): string => {
  const configuredBaseDir = env.FORGE_HOME?.trim();
  const baseDir =
    configuredBaseDir && configuredBaseDir.length > 0
      ? configuredBaseDir
      : Path.join(homedir, ".forge");
  const stateDir = env.VITE_DEV_SERVER_URL ? Path.join(baseDir, "dev") : baseDir;
  return Path.join(stateDir, "logs", "background-debug.ndjson");
};

export const appendBackgroundDebugRecord = (
  source: string,
  label: string,
  details: unknown,
  env: NodeJS.ProcessEnv = process.env,
): void => {
  if (!isBackgroundDebugEnabled(env)) {
    return;
  }

  const filePath = resolveBackgroundDebugLogPath(env);

  try {
    FS.mkdirSync(Path.dirname(filePath), { recursive: true });
    FS.appendFileSync(
      filePath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        pid: process.pid,
        source,
        label,
        details,
      })}\n`,
    );
  } catch {
    // Debug logging must never interfere with runtime behavior.
  }
};
