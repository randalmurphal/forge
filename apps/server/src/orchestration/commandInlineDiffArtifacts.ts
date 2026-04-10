import path from "node:path";

import type {
  OrchestrationDiffFileChange,
  OrchestrationToolInlineDiff,
} from "@forgetools/contracts";

import { classifyToolDiffPaths } from "./toolDiffPaths.ts";

type SupportedShellMutationOperation =
  | {
      readonly kind: "delete";
      readonly path: string;
    }
  | {
      readonly kind: "rename";
      readonly oldPath: string;
      readonly newPath: string;
    };

export type ParsedSupportedShellMutationCommand = {
  readonly normalizedCommand: string;
  readonly operations: ReadonlyArray<SupportedShellMutationOperation>;
};

export type CapturedShellMutationOperation =
  | {
      readonly kind: "delete";
      readonly path: string;
      readonly originalContent?: string;
    }
  | {
      readonly kind: "rename";
      readonly oldPath: string;
      readonly newPath: string;
      readonly exact?: boolean;
    };

function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function splitRawFileContentLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n");
  if (normalized.length === 0) {
    return [];
  }
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function buildDeletedFileUnifiedDiff(path: string, rawContent: string): string {
  const lines = splitRawFileContentLines(rawContent);
  return [
    `diff --git a/${path} b/${path}`,
    "deleted file mode 100644",
    `--- a/${path}`,
    "+++ /dev/null",
    ...(lines.length > 0
      ? [`@@ -1,${lines.length} +0,0 @@`, ...lines.map((line) => `-${line}`)]
      : []),
  ].join("\n");
}

function buildRenamedFileUnifiedDiff(input: {
  readonly oldPath: string;
  readonly newPath: string;
}): string {
  return [
    `diff --git a/${input.oldPath} b/${input.newPath}`,
    `rename from ${input.oldPath}`,
    `rename to ${input.newPath}`,
    `--- a/${input.oldPath}`,
    `+++ b/${input.newPath}`,
  ].join("\n");
}

function basename(command: string): string {
  const normalized = toPosixPath(command);
  const rawBase = path.posix.basename(normalized);
  return rawBase.toLowerCase().replace(/\.exe$/i, "");
}

function isSupportedShellWrapperBinary(command: string): boolean {
  return ["sh", "bash", "zsh"].includes(basename(command));
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function containsUnsupportedShellSyntax(program: string): boolean {
  if (program.trim().length === 0) {
    return true;
  }

  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = 0; index < program.length; index += 1) {
    const current = program[index]!;
    const next = program[index + 1];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (quote === "'") {
      if (current === "'") {
        quote = null;
      }
      continue;
    }

    if (quote === '"') {
      if (current === '"') {
        quote = null;
        continue;
      }
      if (current === "\\") {
        escaped = true;
        continue;
      }
      if (current === "`" || current === "$") {
        return true;
      }
      continue;
    }

    if (current === "\\") {
      escaped = true;
      continue;
    }

    if (current === "'" || current === '"') {
      quote = current;
      continue;
    }

    if (
      current === "`" ||
      current === "|" ||
      current === ">" ||
      current === "<" ||
      current === "(" ||
      current === ")"
    ) {
      return true;
    }
    if (current === "$") {
      return true;
    }
    if (
      current === "*" ||
      current === "?" ||
      current === "[" ||
      current === "]" ||
      current === "{" ||
      current === "}" ||
      current === "~"
    ) {
      return true;
    }
    if (current === "&") {
      if (next !== "&") {
        return true;
      }
      index += 1;
    }
  }

  return escaped || quote !== null;
}

function splitShellStatements(program: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = 0; index < program.length; index += 1) {
    const char = program[index];
    const next = program[index + 1];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      current += char;
      quote = char;
      continue;
    }

    if (char === ";") {
      const statement = current.trim();
      if (statement.length === 0) {
        return null;
      }
      parts.push(statement);
      current = "";
      continue;
    }

    if (char === "&" && next === "&") {
      const statement = current.trim();
      if (statement.length === 0) {
        return null;
      }
      parts.push(statement);
      current = "";
      index += 1;
      continue;
    }

    current += char;
  }

  if (escaped || quote) {
    return null;
  }

  const tail = current.trim();
  if (tail.length === 0) {
    return parts.length > 0 ? parts : null;
  }
  parts.push(tail);
  return parts;
}

function tokenizeShellWords(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === "\\") {
        escaped = true;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (
      char === "*" ||
      char === "?" ||
      char === "[" ||
      char === "]" ||
      char === "{" ||
      char === "}" ||
      char === "~"
    ) {
      return null;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaped || quote) {
    return null;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens.length > 0 ? tokens : null;
}

function unwrapShellProgram(command: string): string | undefined {
  const normalized = command.trim();
  if (normalized.length === 0) {
    return undefined;
  }
  const outerTokens = tokenizeShellWords(normalized);
  if (!outerTokens) {
    return undefined;
  }

  if (
    outerTokens.length === 3 &&
    isSupportedShellWrapperBinary(outerTokens[0] ?? "") &&
    outerTokens[1] === "-lc"
  ) {
    return outerTokens[2]?.trim();
  }

  return normalized;
}

function normalizeRepoRelativePath(
  filePath: string,
  workspaceRoot: string,
  wslDistroName?: string,
): string | undefined {
  return classifyToolDiffPaths({
    workspaceRoot,
    filePaths: [filePath],
    ...(wslDistroName ? { wslDistroName } : {}),
  }).repoRelativePaths[0];
}

function parseDeleteOperation(input: {
  readonly tokens: ReadonlyArray<string>;
  readonly workspaceRoot: string;
  readonly wslDistroName?: string;
}): ReadonlyArray<SupportedShellMutationOperation> | null {
  const paths: SupportedShellMutationOperation[] = [];
  let consumeFlags = true;

  for (const token of input.tokens.slice(1)) {
    if (consumeFlags && token === "--") {
      consumeFlags = false;
      continue;
    }

    if (consumeFlags && token.startsWith("-")) {
      if (token === "-r" || token === "-R" || token === "--recursive" || token === "--cached") {
        return null;
      }
      if (token === "-f") {
        continue;
      }
      if (/^-[^-]+$/.test(token)) {
        const flags = token.slice(1).split("");
        if (flags.every((flag) => flag === "f")) {
          continue;
        }
      }
      return null;
    }

    const normalizedPath = normalizeRepoRelativePath(
      token,
      input.workspaceRoot,
      input.wslDistroName,
    );
    if (!normalizedPath) {
      return null;
    }
    paths.push({
      kind: "delete",
      path: normalizedPath,
    });
  }

  return paths.length > 0 ? paths : null;
}

function parseRenameOperation(input: {
  readonly tokens: ReadonlyArray<string>;
  readonly allowedFlags: ReadonlyArray<string>;
  readonly workspaceRoot: string;
  readonly wslDistroName?: string;
}): SupportedShellMutationOperation | null {
  const args: string[] = [];
  let consumeFlags = true;

  for (const token of input.tokens.slice(1)) {
    if (consumeFlags && token === "--") {
      consumeFlags = false;
      continue;
    }

    if (consumeFlags && token.startsWith("-")) {
      if (/^-[^-]+$/.test(token)) {
        const flags = token.slice(1).split("");
        if (flags.every((flag) => input.allowedFlags.includes(flag))) {
          continue;
        }
      }
      return null;
    }

    args.push(token);
  }

  if (args.length !== 2) {
    return null;
  }

  const oldPath = normalizeRepoRelativePath(
    args[0] ?? "",
    input.workspaceRoot,
    input.wslDistroName,
  );
  const newPath = normalizeRepoRelativePath(
    args[1] ?? "",
    input.workspaceRoot,
    input.wslDistroName,
  );
  if (!oldPath || !newPath || oldPath === newPath) {
    return null;
  }

  return {
    kind: "rename",
    oldPath,
    newPath,
  };
}

function parseStatementOperations(input: {
  readonly statement: string;
  readonly workspaceRoot: string;
  readonly wslDistroName?: string;
}): ReadonlyArray<SupportedShellMutationOperation> | null {
  const tokens = tokenizeShellWords(input.statement);
  if (!tokens || tokens.length === 0) {
    return null;
  }

  const first = basename(tokens[0] ?? "");
  if (first === "rm") {
    return parseDeleteOperation({
      tokens,
      workspaceRoot: input.workspaceRoot,
      ...(input.wslDistroName ? { wslDistroName: input.wslDistroName } : {}),
    });
  }

  if (first === "mv") {
    const rename = parseRenameOperation({
      tokens,
      allowedFlags: ["f", "n", "v"],
      workspaceRoot: input.workspaceRoot,
      ...(input.wslDistroName ? { wslDistroName: input.wslDistroName } : {}),
    });
    return rename ? [rename] : null;
  }

  if (first === "git" && tokens.length >= 2) {
    const subcommand = tokens[1]?.toLowerCase();
    if (subcommand === "rm") {
      return parseDeleteOperation({
        tokens: [tokens[1]!, ...tokens.slice(2)],
        workspaceRoot: input.workspaceRoot,
        ...(input.wslDistroName ? { wslDistroName: input.wslDistroName } : {}),
      });
    }
    if (subcommand === "mv") {
      const rename = parseRenameOperation({
        tokens: [tokens[1]!, ...tokens.slice(2)],
        allowedFlags: ["f", "k", "v"],
        workspaceRoot: input.workspaceRoot,
        ...(input.wslDistroName ? { wslDistroName: input.wslDistroName } : {}),
      });
      return rename ? [rename] : null;
    }
  }

  return null;
}

export function parseSupportedShellMutationCommand(input: {
  readonly command: string;
  readonly workspaceRoot: string;
  readonly wslDistroName?: string;
}): ParsedSupportedShellMutationCommand | undefined {
  const program = unwrapShellProgram(input.command);
  if (!program || containsUnsupportedShellSyntax(program)) {
    return undefined;
  }

  const statements = splitShellStatements(program);
  if (!statements || statements.length === 0) {
    return undefined;
  }

  const operations: SupportedShellMutationOperation[] = [];
  for (const statement of statements) {
    const parsed = parseStatementOperations({
      statement,
      workspaceRoot: input.workspaceRoot,
      ...(input.wslDistroName ? { wslDistroName: input.wslDistroName } : {}),
    });
    if (!parsed) {
      return undefined;
    }
    operations.push(...parsed);
  }

  return operations.length > 0
    ? {
        normalizedCommand: normalizeWhitespace(program),
        operations,
      }
    : undefined;
}

function summarizeCapturedFiles(
  operations: ReadonlyArray<CapturedShellMutationOperation>,
): OrchestrationDiffFileChange[] {
  const byPath = new Map<string, OrchestrationDiffFileChange>();
  for (const operation of operations) {
    const file =
      operation.kind === "delete"
        ? {
            path: operation.path,
            kind: "deleted",
            ...(typeof operation.originalContent === "string"
              ? { deletions: splitRawFileContentLines(operation.originalContent).length }
              : {}),
          }
        : {
            path: operation.newPath,
            kind: "renamed",
          };
    byPath.set(file.path, file);
  }
  return [...byPath.values()];
}

export function buildCommandExecutionInlineDiffArtifact(input: {
  readonly operations: ReadonlyArray<CapturedShellMutationOperation>;
}): OrchestrationToolInlineDiff | undefined {
  if (input.operations.length === 0) {
    return undefined;
  }

  const files = summarizeCapturedFiles(input.operations);
  if (files.length === 0) {
    return undefined;
  }

  const fragments: string[] = [];
  let additions = 0;
  let deletions = 0;
  let exact = true;

  for (const operation of input.operations) {
    if (operation.kind === "delete") {
      if (typeof operation.originalContent !== "string") {
        exact = false;
        continue;
      }
      const lines = splitRawFileContentLines(operation.originalContent);
      deletions += lines.length;
      fragments.push(buildDeletedFileUnifiedDiff(operation.path, operation.originalContent));
      continue;
    }

    if (operation.exact === false) {
      exact = false;
      continue;
    }

    fragments.push(
      buildRenamedFileUnifiedDiff({
        oldPath: operation.oldPath,
        newPath: operation.newPath,
      }),
    );
  }

  if (!exact || fragments.length !== input.operations.length) {
    return {
      availability: "summary_only",
      files,
    };
  }

  return {
    availability: "exact_patch",
    files,
    unifiedDiff: fragments.join("\n\n"),
    ...(additions > 0 ? { additions } : {}),
    ...(deletions > 0 ? { deletions } : {}),
  };
}
