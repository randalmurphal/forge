import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { isDebugTopicEnabled, parseDebugTopics, type DebugConfig } from "@forgetools/shared/debug";

export type ServerDebugTopic = string;

const SERVER_DEBUG_CONFIG = parseDebugTopics(process.env.FORGE_DEBUG);

export function resolveServerDebugConfig(env: NodeJS.ProcessEnv = process.env): DebugConfig {
  return parseDebugTopics(env.FORGE_DEBUG);
}

export function isServerDebugEnabled(topic: ServerDebugTopic): boolean {
  return isDebugTopicEnabled(SERVER_DEBUG_CONFIG, topic);
}

export function resolveServerDebugLogPath(
  env: NodeJS.ProcessEnv = process.env,
  homedir = OS.homedir(),
): string {
  const configuredBaseDir = env.FORGE_HOME?.trim();
  const baseDir =
    configuredBaseDir && configuredBaseDir.length > 0
      ? configuredBaseDir
      : Path.join(homedir, ".forge");
  const stateDir = env.VITE_DEV_SERVER_URL ? Path.join(baseDir, "dev") : baseDir;
  return Path.join(stateDir, "logs", "debug.ndjson");
}

export function appendServerDebugRecord(input: {
  readonly topic: ServerDebugTopic;
  readonly source: string;
  readonly label: string;
  readonly details: unknown;
  readonly env?: NodeJS.ProcessEnv;
}): void {
  const env = input.env ?? process.env;
  if (!isDebugTopicEnabled(resolveServerDebugConfig(env), input.topic)) {
    return;
  }

  const filePath = resolveServerDebugLogPath(env);
  const record = {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    topic: input.topic,
    source: input.source,
    label: input.label,
    details: input.details,
  };

  try {
    // Mirror to stderr so `bun run dev` shows live debug immediately, but also persist NDJSON so
    // refreshes or renderer crashes do not erase the evidence we were trying to inspect.
    console.warn(`[forge:${input.topic}:${input.source}] ${input.label}`, input.details);
    FS.mkdirSync(Path.dirname(filePath), { recursive: true });
    FS.appendFileSync(filePath, `${JSON.stringify(record)}\n`);
  } catch {
    // Debug logging must never interfere with runtime behavior.
  }
}

export function describeServerDebugError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }

  return {
    value: String(error),
  };
}
