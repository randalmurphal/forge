import type {
  OrchestrationDiffFileChange,
  OrchestrationToolInlineDiff,
  ProviderKind,
} from "@forgetools/contracts";
import { asRecord, asTrimmedString } from "@forgetools/shared/narrowing";

import { classifyToolDiffPaths } from "./toolDiffPaths.ts";

function normalizeStatValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function extractMovePath(value: unknown): string | undefined {
  const record = asRecord(value);
  return (
    asTrimmedString(record?.movePath) ??
    asTrimmedString(record?.move_path) ??
    asTrimmedString(record?.newPath) ??
    asTrimmedString(record?.new_path)
  );
}

function normalizeFileChangeKind(value: unknown): OrchestrationDiffFileChange["kind"] {
  const record = asRecord(value);
  const normalized =
    asTrimmedString(value)?.toLowerCase() ??
    asTrimmedString(record?.type)?.toLowerCase() ??
    asTrimmedString(record?.kind)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (["create", "created", "add", "added", "new"].includes(normalized)) {
    return "added";
  }
  if (["delete", "deleted", "remove", "removed"].includes(normalized)) {
    return "deleted";
  }
  if (
    ["rename", "renamed"].includes(normalized) ||
    (normalized === "update" && extractMovePath(value) !== undefined)
  ) {
    return "renamed";
  }
  if (["modify", "modified", "update", "updated", "edit", "edited"].includes(normalized)) {
    return "modified";
  }
  return asTrimmedString(value);
}

function mergeFileChanges(
  previous: ReadonlyArray<OrchestrationDiffFileChange>,
  next: ReadonlyArray<OrchestrationDiffFileChange>,
): OrchestrationDiffFileChange[] {
  const byPath = new Map<string, OrchestrationDiffFileChange>();
  for (const file of [...previous, ...next]) {
    const existing = byPath.get(file.path);
    if (!existing) {
      byPath.set(file.path, { ...file });
      continue;
    }
    byPath.set(file.path, {
      ...existing,
      kind: file.kind ?? existing.kind,
      additions: file.additions ?? existing.additions,
      deletions: file.deletions ?? existing.deletions,
    });
  }
  return [...byPath.values()];
}

function normalizeWorkspacePath(
  filePath: string,
  workspaceRoot?: string,
  preserveRawWhenOutOfRepo = true,
): string | undefined {
  const trimmed = filePath.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  if (!workspaceRoot) {
    return trimmed;
  }

  const classified = classifyToolDiffPaths({
    workspaceRoot,
    filePaths: [trimmed],
    ...(process.env.WSL_DISTRO_NAME ? { wslDistroName: process.env.WSL_DISTRO_NAME } : {}),
  });
  const normalized = classified.repoRelativePaths[0];
  if (normalized) {
    return normalized;
  }

  return preserveRawWhenOutOfRepo ? trimmed : undefined;
}

function normalizeFileChangeSummaryPaths(
  files: ReadonlyArray<OrchestrationDiffFileChange>,
  workspaceRoot?: string,
  preserveRawWhenOutOfRepo = true,
): OrchestrationDiffFileChange[] {
  const normalized: OrchestrationDiffFileChange[] = [];
  for (const file of files) {
    const path = normalizeWorkspacePath(file.path, workspaceRoot, preserveRawWhenOutOfRepo);
    if (!path) {
      continue;
    }
    normalized.push({
      ...file,
      path,
    });
  }
  return mergeFileChanges([], normalized);
}

function summarizeFiles(files: ReadonlyArray<OrchestrationDiffFileChange>): {
  additions?: number | undefined;
  deletions?: number | undefined;
} {
  let additions = 0;
  let deletions = 0;
  let hasStats = false;
  for (const file of files) {
    if (typeof file.additions === "number") {
      additions += file.additions;
      hasStats = true;
    }
    if (typeof file.deletions === "number") {
      deletions += file.deletions;
      hasStats = true;
    }
  }
  return hasStats ? { additions, deletions } : {};
}

function collectChangedFileSummaries(
  value: unknown,
  target: Map<string, OrchestrationDiffFileChange>,
  depth: number,
) {
  if (depth > 5) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFileSummaries(entry, target, depth + 1);
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  const normalizedKind =
    normalizeFileChangeKind(record.kind) ?? normalizeFileChangeKind(record.changeType);
  const path =
    (normalizedKind === "renamed"
      ? (extractMovePath(record.kind) ??
        asTrimmedString(record.movePath) ??
        asTrimmedString(record.move_path))
      : undefined) ??
    asTrimmedString(record.path) ??
    asTrimmedString(record.filePath) ??
    asTrimmedString(record.file_path) ??
    asTrimmedString(record.relativePath) ??
    asTrimmedString(record.relative_path) ??
    asTrimmedString(record.filename) ??
    asTrimmedString(record.newPath) ??
    asTrimmedString(record.new_path) ??
    asTrimmedString(record.oldPath) ??
    asTrimmedString(record.old_path);
  if (path) {
    const existing = target.get(path);
    const additions = normalizeStatValue(record.additions);
    const deletions = normalizeStatValue(record.deletions);
    target.set(path, {
      path,
      kind: normalizedKind ?? existing?.kind,
      additions: additions ?? existing?.additions,
      deletions: deletions ?? existing?.deletions,
    });
  }

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "toolUseResult",
    "tool_use_result",
    "changes",
    "files",
    "edits",
    "gitDiff",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFileSummaries(record[nestedKey], target, depth + 1);
  }
}

function extractChangedFileSummaries(
  payloadData: unknown,
): ReadonlyArray<OrchestrationDiffFileChange> {
  const byPath = new Map<string, OrchestrationDiffFileChange>();
  collectChangedFileSummaries(payloadData, byPath, 0);
  return [...byPath.values()];
}

function looksLikeUnifiedDiff(value: string): boolean {
  return (
    /^diff --git /m.test(value) ||
    (/^--- /m.test(value) && /^\+\+\+ /m.test(value)) ||
    /^@@ /m.test(value)
  );
}

function extractDirectUnifiedDiffCandidate(payloadData: unknown): string | undefined {
  const record = asRecord(payloadData);
  if (!record) {
    return undefined;
  }

  for (const diffKey of ["unifiedDiff", "unified_diff", "patch", "diff"] as const) {
    const candidate = normalizePatchText(record[diffKey]);
    if (candidate && looksLikeUnifiedDiff(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function normalizeUnifiedDiffCandidate(
  patch: string | undefined,
  fallbackPaths: ReadonlyArray<string>,
): string | undefined {
  const normalizedPatch = patch?.trim();
  if (!normalizedPatch) {
    return undefined;
  }

  if (
    /^diff --git /m.test(normalizedPatch) ||
    (/^--- /m.test(normalizedPatch) && /^\+\+\+ /m.test(normalizedPatch))
  ) {
    return normalizedPatch;
  }
  if (!/^@@ /m.test(normalizedPatch)) {
    return undefined;
  }

  const uniquePaths = fallbackPaths.filter(
    (value, index, values) => values.indexOf(value) === index,
  );
  if (uniquePaths.length !== 1) {
    return undefined;
  }

  const [filePath] = uniquePaths;
  if (!filePath) {
    return undefined;
  }

  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    normalizedPatch,
  ].join("\n");
}

function normalizePatchText(value: unknown): string | undefined {
  const text = asTrimmedString(value);
  return text ? text.replace(/\r\n/g, "\n") : undefined;
}

function normalizePossibleFileContent(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.replace(/\r\n/g, "\n");
  return looksLikeUnifiedDiff(text) ? undefined : text;
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

function buildCreatedFileUnifiedDiff(path: string, rawContent: string): string | undefined {
  const lines = splitRawFileContentLines(rawContent);
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    ...(lines.length > 0
      ? [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)]
      : []),
  ].join("\n");
}

function buildDeletedFileUnifiedDiff(path: string, rawContent: string): string | undefined {
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

function inferFileChangeKindFromRecord(
  record: Record<string, unknown>,
): OrchestrationDiffFileChange["kind"] {
  const normalizedKind =
    normalizeFileChangeKind(record.kind) ?? normalizeFileChangeKind(record.changeType);
  if (normalizedKind) {
    return normalizedKind;
  }
  const oldPath = asTrimmedString(record.oldPath) ?? asTrimmedString(record.old_path);
  const newPath = asTrimmedString(record.newPath) ?? asTrimmedString(record.new_path);
  if (oldPath === "/dev/null" || (!oldPath && !!newPath)) {
    return "added";
  }
  if (newPath === "/dev/null" || (!!oldPath && !newPath)) {
    return "deleted";
  }
  return "modified";
}

function wrapUnifiedDiffFragment(input: {
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly kind: OrchestrationDiffFileChange["kind"];
  readonly fragment: string;
}): string | undefined {
  const oldPath = input.oldPath;
  const newPath = input.newPath;

  if (input.kind === "added") {
    if (!newPath) {
      return undefined;
    }
    return [
      `diff --git a/${newPath} b/${newPath}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${newPath}`,
      input.fragment,
    ].join("\n");
  }

  if (input.kind === "deleted") {
    if (!oldPath) {
      return undefined;
    }
    return [
      `diff --git a/${oldPath} b/${oldPath}`,
      "deleted file mode 100644",
      `--- a/${oldPath}`,
      "+++ /dev/null",
      input.fragment,
    ].join("\n");
  }

  if (input.kind === "renamed") {
    if (!oldPath || !newPath) {
      return undefined;
    }
    return [
      `diff --git a/${oldPath} b/${newPath}`,
      `rename from ${oldPath}`,
      `rename to ${newPath}`,
      `--- a/${oldPath}`,
      `+++ b/${newPath}`,
      input.fragment,
    ].join("\n");
  }

  if (!newPath) {
    return undefined;
  }

  return [
    `diff --git a/${newPath} b/${newPath}`,
    `--- a/${oldPath ?? newPath}`,
    `+++ b/${newPath}`,
    input.fragment,
  ].join("\n");
}

function normalizeCodexChangePaths(record: Record<string, unknown>): {
  oldPath?: string;
  newPath?: string;
  summaryPath?: string;
} {
  const movePath =
    extractMovePath(record.kind) ??
    asTrimmedString(record.movePath) ??
    asTrimmedString(record.move_path);
  const directPath =
    asTrimmedString(record.path) ??
    asTrimmedString(record.filePath) ??
    asTrimmedString(record.file_path) ??
    asTrimmedString(record.filename);
  const oldPath = asTrimmedString(record.oldPath) ?? asTrimmedString(record.old_path) ?? directPath;
  const newPath =
    asTrimmedString(record.newPath) ?? asTrimmedString(record.new_path) ?? movePath ?? directPath;
  const normalizedOldPath = oldPath === "/dev/null" ? undefined : oldPath;
  const normalizedNewPath = newPath === "/dev/null" ? undefined : newPath;
  const summaryPath = normalizedNewPath ?? normalizedOldPath;
  return {
    ...(normalizedOldPath ? { oldPath: normalizedOldPath } : {}),
    ...(normalizedNewPath ? { newPath: normalizedNewPath } : {}),
    ...(summaryPath ? { summaryPath } : {}),
  };
}

function buildCodexPatchFromRecord(
  record: Record<string, unknown>,
  workspaceRoot?: string,
): string | undefined {
  const kind = inferFileChangeKindFromRecord(record);
  const normalizedPaths = normalizeCodexChangePaths(record);
  const oldPath = normalizedPaths.oldPath
    ? normalizeWorkspacePath(normalizedPaths.oldPath, workspaceRoot, false)
    : undefined;
  const newPath = normalizedPaths.newPath
    ? normalizeWorkspacePath(normalizedPaths.newPath, workspaceRoot, false)
    : undefined;
  const summaryPath = normalizedPaths.summaryPath
    ? normalizeWorkspacePath(normalizedPaths.summaryPath, workspaceRoot, false)
    : undefined;
  const rawPatch =
    normalizePatchText(record.unifiedDiff) ??
    normalizePatchText(record.unified_diff) ??
    normalizePatchText(record.patch) ??
    normalizePatchText(record.diff);
  const rawContent = normalizePossibleFileContent(record.content);

  if (rawPatch) {
    if (/^diff --git /m.test(rawPatch) || (/^--- /m.test(rawPatch) && /^\+\+\+ /m.test(rawPatch))) {
      return rawPatch;
    }
    if (/^@@ /m.test(rawPatch)) {
      return wrapUnifiedDiffFragment({
        ...(oldPath ? { oldPath } : {}),
        ...(newPath ? { newPath } : {}),
        kind,
        fragment: rawPatch,
      });
    }
    if (kind === "added" && summaryPath) {
      return buildCreatedFileUnifiedDiff(summaryPath, rawPatch);
    }
    if (kind === "deleted" && summaryPath) {
      return buildDeletedFileUnifiedDiff(summaryPath, rawPatch);
    }
  }

  if (kind === "added" && summaryPath && rawContent !== undefined) {
    return buildCreatedFileUnifiedDiff(summaryPath, rawContent);
  }
  if (kind === "deleted" && summaryPath && rawContent !== undefined) {
    return buildDeletedFileUnifiedDiff(summaryPath, rawContent);
  }
  if (kind === "renamed" && oldPath && newPath) {
    return buildRenamedFileUnifiedDiff({
      oldPath,
      newPath,
    });
  }

  return undefined;
}

function extractCodexChangeRecords(payloadData: unknown): ReadonlyArray<Record<string, unknown>> {
  const record = asRecord(payloadData);
  if (!record) {
    return [];
  }

  const item = asRecord(record.item);
  const directChanges = Array.isArray(record.changes) ? record.changes : undefined;
  const itemChanges = Array.isArray(item?.changes) ? item.changes : undefined;
  const changes = itemChanges ?? directChanges;
  if (!changes) {
    return [];
  }

  return changes
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry != null);
}

function buildCodexStructuredToolUnifiedDiff(
  payloadData: unknown,
  workspaceRoot?: string,
): string | undefined {
  const fragments = extractCodexChangeRecords(payloadData)
    .map((record) => buildCodexPatchFromRecord(record, workspaceRoot))
    .filter((patch): patch is string => typeof patch === "string" && patch.trim().length > 0);
  return fragments.length > 0 ? fragments.join("\n\n") : undefined;
}

function parseUnifiedDiffFiles(patch: string): OrchestrationDiffFileChange[] {
  const byPath = new Map<
    string,
    {
      path: string;
      additions: number;
      deletions: number;
    }
  >();
  let currentPath: string | null = null;

  const ensureCurrentFile = (path: string) => {
    currentPath = path;
    const existing = byPath.get(path);
    if (!existing) {
      byPath.set(path, { path, additions: 0, deletions: 0 });
    }
  };

  for (const line of patch.split(/\r?\n/)) {
    const diffGitMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (diffGitMatch) {
      ensureCurrentFile(diffGitMatch[2] ?? diffGitMatch[1] ?? "");
      continue;
    }

    const plusPlusPlusMatch = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plusPlusPlusMatch) {
      ensureCurrentFile(plusPlusPlusMatch[1] ?? "");
      continue;
    }

    if (!currentPath) {
      continue;
    }

    const currentFile = byPath.get(currentPath);
    if (!currentFile) {
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentFile.additions = (currentFile.additions ?? 0) + 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      currentFile.deletions = (currentFile.deletions ?? 0) + 1;
    }
  }

  return [...byPath.values()].map((file) => ({
    path: file.path,
    additions: file.additions,
    deletions: file.deletions,
  }));
}

function normalizeExactPatchFiles(
  patch: string | undefined,
  workspaceRoot?: string,
): {
  readonly exactPatch?: string;
  readonly patchFiles: OrchestrationDiffFileChange[];
} {
  if (!patch) {
    return {
      patchFiles: [],
    };
  }

  const rawPatchFiles = parseUnifiedDiffFiles(patch);
  const patchFiles = normalizeFileChangeSummaryPaths(rawPatchFiles, workspaceRoot, false);

  if (workspaceRoot && (rawPatchFiles.length === 0 || patchFiles.length !== rawPatchFiles.length)) {
    return {
      patchFiles: [],
    };
  }

  return {
    exactPatch: patch,
    patchFiles,
  };
}

function exactPatchCoversSummaryFiles(
  summaryFiles: ReadonlyArray<OrchestrationDiffFileChange>,
  patchFiles: ReadonlyArray<OrchestrationDiffFileChange>,
): boolean {
  if (summaryFiles.length === 0) {
    return patchFiles.length > 0;
  }

  const patchPaths = new Set(patchFiles.map((file) => file.path));
  return summaryFiles.every((file) => patchPaths.has(file.path));
}

function buildCodexToolInlineDiffArtifact(
  payloadData: unknown,
  workspaceRoot?: string,
): OrchestrationToolInlineDiff | undefined {
  const rawPayloadFiles = extractChangedFileSummaries(payloadData);
  const payloadFiles = normalizeFileChangeSummaryPaths(rawPayloadFiles, workspaceRoot);
  const fallbackPaths = payloadFiles.map((file) => file.path);
  const candidateExactPatch =
    buildCodexStructuredToolUnifiedDiff(payloadData, workspaceRoot) ??
    normalizeUnifiedDiffCandidate(extractDirectUnifiedDiffCandidate(payloadData), fallbackPaths);
  const { exactPatch, patchFiles } = normalizeExactPatchFiles(candidateExactPatch, workspaceRoot);
  const files = mergeFileChanges(payloadFiles, patchFiles);
  const canUseExactPatch =
    exactPatch !== undefined && exactPatchCoversSummaryFiles(payloadFiles, patchFiles);

  if (files.length === 0 && exactPatch === undefined) {
    return undefined;
  }

  const fileStats = summarizeFiles(files);
  return {
    availability: canUseExactPatch ? "exact_patch" : "summary_only",
    files,
    ...(canUseExactPatch ? { unifiedDiff: exactPatch } : {}),
    ...(fileStats.additions !== undefined ? { additions: fileStats.additions } : {}),
    ...(fileStats.deletions !== undefined ? { deletions: fileStats.deletions } : {}),
  };
}

function buildClaudeToolInlineDiffArtifact(
  payloadData: unknown,
  workspaceRoot?: string,
): OrchestrationToolInlineDiff | undefined {
  const rawPayloadFiles = extractChangedFileSummaries(payloadData);
  const payloadFiles = normalizeFileChangeSummaryPaths(rawPayloadFiles, workspaceRoot);
  const fallbackPaths = payloadFiles.map((file) => file.path);
  const candidateExactPatch = normalizeUnifiedDiffCandidate(
    extractDirectUnifiedDiffCandidate(payloadData),
    fallbackPaths,
  );
  const { exactPatch, patchFiles } = normalizeExactPatchFiles(candidateExactPatch, workspaceRoot);
  const files = mergeFileChanges(payloadFiles, patchFiles);
  const canUseExactPatch =
    exactPatch !== undefined && exactPatchCoversSummaryFiles(payloadFiles, patchFiles);

  if (files.length === 0 && exactPatch === undefined) {
    return undefined;
  }

  const fileStats = summarizeFiles(files);
  return {
    availability: canUseExactPatch ? "exact_patch" : "summary_only",
    files,
    ...(canUseExactPatch ? { unifiedDiff: exactPatch } : {}),
    ...(fileStats.additions !== undefined ? { additions: fileStats.additions } : {}),
    ...(fileStats.deletions !== undefined ? { deletions: fileStats.deletions } : {}),
  };
}

export function buildToolInlineDiffArtifact(input: {
  readonly provider: ProviderKind;
  readonly payloadData: unknown;
  readonly workspaceRoot?: string;
}): OrchestrationToolInlineDiff | undefined {
  return input.provider === "codex"
    ? buildCodexToolInlineDiffArtifact(input.payloadData, input.workspaceRoot)
    : buildClaudeToolInlineDiffArtifact(input.payloadData, input.workspaceRoot);
}
