import { isAbsolute, relative } from "node:path";

interface StructuredPatchHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: ReadonlyArray<string>;
}

interface NormalizedClaudeFileDiff {
  readonly filePath: string;
  readonly status: "added" | "modified";
  readonly hunks: ReadonlyArray<StructuredPatchHunk>;
  readonly newFileContent?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizePath(filePath: string, cwd?: string): string {
  const normalized =
    cwd && isAbsolute(filePath) ? relative(cwd, filePath).replaceAll("\\", "/") : filePath;
  return normalized.replace(/^\.\/+/, "");
}

function readStructuredPatchHunks(value: unknown): ReadonlyArray<StructuredPatchHunk> | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const hunks: StructuredPatchHunk[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      return null;
    }
    const { oldStart, oldLines, newStart, newLines, lines } = entry as Record<string, unknown>;
    if (
      typeof oldStart !== "number" ||
      typeof oldLines !== "number" ||
      typeof newStart !== "number" ||
      typeof newLines !== "number" ||
      !Array.isArray(lines) ||
      !lines.every((line) => typeof line === "string")
    ) {
      return null;
    }
    hunks.push({
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines,
    });
  }
  return hunks;
}

function extractNormalizedClaudeFileDiff(
  toolUseResult: unknown,
  cwd?: string,
): NormalizedClaudeFileDiff | null {
  // Claude's SDK types tool_use_result as unknown, so this normalization is
  // intentionally based on observed Write/Edit payloads rather than a stable
  // provider contract.
  if (!isRecord(toolUseResult)) {
    return null;
  }

  const filePath = typeof toolUseResult.filePath === "string" ? toolUseResult.filePath : null;
  const hunks = readStructuredPatchHunks(toolUseResult.structuredPatch);
  if (!filePath || hunks === null) {
    return null;
  }

  const normalizedPath = normalizePath(filePath, cwd);
  const writeType = toolUseResult.type;
  if (
    (writeType === "create" || writeType === "update") &&
    typeof toolUseResult.content === "string"
  ) {
    return {
      filePath: normalizedPath,
      status: writeType === "create" ? "added" : "modified",
      hunks,
      newFileContent: toolUseResult.content,
    };
  }

  if (typeof toolUseResult.originalFile === "string") {
    return {
      filePath: normalizedPath,
      status: "modified",
      hunks,
    };
  }

  return null;
}

function renderUnifiedDiffHunk(hunk: StructuredPatchHunk): string {
  return [
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...hunk.lines,
  ].join("\n");
}

function createFileHunksFromContent(content: string): ReadonlyArray<StructuredPatchHunk> {
  const lines = content.length === 0 ? [] : content.split("\n").map((line) => `+${line}`);
  return [
    {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: lines.length,
      lines,
    },
  ];
}

export function buildClaudeToolResultDiffFragment(input: {
  readonly cwd?: string;
  readonly toolUseResult: unknown;
}): string | null {
  const normalized = extractNormalizedClaudeFileDiff(input.toolUseResult, input.cwd);
  if (!normalized) {
    return null;
  }

  const hunks =
    normalized.hunks.length > 0
      ? normalized.hunks
      : // Claude can emit an empty structuredPatch for file creation while still
        // including the final file content. Synthesize a full-file addition hunk
        // so the rest of the diff pipeline still gets a renderable unified diff.
        normalized.status === "added" && normalized.newFileContent !== undefined
        ? createFileHunksFromContent(normalized.newFileContent)
        : [];

  if (hunks.length === 0) {
    return "";
  }

  return [
    `diff --git a/${normalized.filePath} b/${normalized.filePath}`,
    ...(normalized.status === "added"
      ? ["new file mode 100644", "--- /dev/null"]
      : [`--- a/${normalized.filePath}`]),
    `+++ b/${normalized.filePath}`,
    ...hunks.map(renderUnifiedDiffHunk),
  ].join("\n");
}
