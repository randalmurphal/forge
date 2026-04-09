import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function resolveForgeCliEntrypoint(): string {
  const currentEntrypoint = process.argv[1];
  if (currentEntrypoint && existsSync(currentEntrypoint)) {
    return currentEntrypoint;
  }

  const candidates = [
    resolve(import.meta.dirname, "../bin.ts"),
    resolve(import.meta.dirname, "../bin.mjs"),
    resolve(import.meta.dirname, "../bin.js"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("Could not resolve the Forge CLI entrypoint.");
}

export function resolveForgeCliCommand(subcommand: string): {
  readonly command: string;
  readonly args: readonly [string, string];
} {
  return {
    command: process.execPath,
    args: [resolveForgeCliEntrypoint(), subcommand],
  };
}
