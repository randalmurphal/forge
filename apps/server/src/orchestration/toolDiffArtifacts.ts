import type {
  OrchestrationDiffFileChange,
  OrchestrationToolInlineDiff,
} from "@forgetools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStatValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeFileChangeKind(value: unknown): OrchestrationDiffFileChange["kind"] {
  const normalized = asTrimmedString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (["create", "created", "add", "added", "new"].includes(normalized)) {
    return "added";
  }
  if (["delete", "deleted", "remove", "removed"].includes(normalized)) {
    return "deleted";
  }
  if (["rename", "renamed"].includes(normalized)) {
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

  const path =
    asTrimmedString(record.path) ??
    asTrimmedString(record.filePath) ??
    asTrimmedString(record.relativePath) ??
    asTrimmedString(record.filename) ??
    asTrimmedString(record.newPath) ??
    asTrimmedString(record.oldPath);
  if (path) {
    const existing = target.get(path);
    const additions = normalizeStatValue(record.additions);
    const deletions = normalizeStatValue(record.deletions);
    target.set(path, {
      path,
      kind:
        normalizeFileChangeKind(record.kind) ??
        normalizeFileChangeKind(record.changeType) ??
        existing?.kind,
      additions: additions ?? existing?.additions,
      deletions: deletions ?? existing?.deletions,
    });
  }

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
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

function collectUnifiedDiffCandidates(
  value: unknown,
  target: string[],
  seen: Set<string>,
  depth: number,
) {
  if (depth > 5) {
    return;
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized.length > 0 && looksLikeUnifiedDiff(normalized) && !seen.has(normalized)) {
      seen.add(normalized);
      target.push(normalized);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectUnifiedDiffCandidates(entry, target, seen, depth + 1);
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  for (const diffKey of ["unifiedDiff", "patch", "diff"]) {
    if (diffKey in record) {
      collectUnifiedDiffCandidates(record[diffKey], target, seen, depth + 1);
    }
  }

  for (const nestedKey of ["item", "result", "input", "data", "changes", "files", "patches"]) {
    if (nestedKey in record) {
      collectUnifiedDiffCandidates(record[nestedKey], target, seen, depth + 1);
    }
  }
}

function extractUnifiedDiffCandidate(payloadData: unknown): string | undefined {
  const candidates: string[] = [];
  collectUnifiedDiffCandidates(payloadData, candidates, new Set<string>(), 0);
  return candidates.length > 0 ? candidates.join("\n\n") : undefined;
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

function normalizeToolChangePath(record: Record<string, unknown>): string | undefined {
  const directPath =
    asTrimmedString(record.path) ??
    asTrimmedString(record.filePath) ??
    asTrimmedString(record.relativePath) ??
    asTrimmedString(record.filename);
  if (directPath) {
    return directPath;
  }
  const oldPath = asTrimmedString(record.oldPath);
  const newPath = asTrimmedString(record.newPath);
  if (newPath && newPath !== "/dev/null") {
    return newPath;
  }
  if (oldPath && oldPath !== "/dev/null") {
    return oldPath;
  }
  return undefined;
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
  if (lines.length === 0) {
    return undefined;
  }
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

function buildDeletedFileUnifiedDiff(path: string, rawContent: string): string | undefined {
  const lines = splitRawFileContentLines(rawContent);
  if (lines.length === 0) {
    return undefined;
  }
  return [
    `diff --git a/${path} b/${path}`,
    "deleted file mode 100644",
    `--- a/${path}`,
    "+++ /dev/null",
    `@@ -1,${lines.length} +0,0 @@`,
    ...lines.map((line) => `-${line}`),
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
  const oldPath = asTrimmedString(record.oldPath);
  const newPath = asTrimmedString(record.newPath);
  if (oldPath === "/dev/null" || (!oldPath && !!newPath)) {
    return "added";
  }
  if (newPath === "/dev/null" || (!!oldPath && !newPath)) {
    return "deleted";
  }
  return "modified";
}

function collectToolChangePatchFragments(
  value: unknown,
  target: string[],
  seen: Set<string>,
  depth: number,
) {
  if (depth > 5) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectToolChangePatchFragments(entry, target, seen, depth + 1);
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  const path = normalizeToolChangePath(record);
  const rawPatch =
    normalizePatchText(record.unifiedDiff) ??
    normalizePatchText(record.patch) ??
    normalizePatchText(record.diff);
  if (path && rawPatch) {
    const normalizedPatch =
      normalizeUnifiedDiffCandidate(rawPatch, [path]) ??
      (inferFileChangeKindFromRecord(record) === "added"
        ? buildCreatedFileUnifiedDiff(path, rawPatch)
        : inferFileChangeKindFromRecord(record) === "deleted"
          ? buildDeletedFileUnifiedDiff(path, rawPatch)
          : undefined);
    if (normalizedPatch && !seen.has(normalizedPatch)) {
      seen.add(normalizedPatch);
      target.push(normalizedPatch);
    }
  }

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectToolChangePatchFragments(record[nestedKey], target, seen, depth + 1);
  }
}

function extractStructuredToolUnifiedDiff(payloadData: unknown): string | undefined {
  const fragments: string[] = [];
  collectToolChangePatchFragments(payloadData, fragments, new Set<string>(), 0);
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

export function buildToolInlineDiffArtifact(
  payloadData: unknown,
): OrchestrationToolInlineDiff | undefined {
  const payloadFiles = extractChangedFileSummaries(payloadData);
  const fallbackPaths = payloadFiles.map((file) => file.path);
  const exactPatch =
    extractStructuredToolUnifiedDiff(payloadData) ??
    normalizeUnifiedDiffCandidate(extractUnifiedDiffCandidate(payloadData), fallbackPaths);
  const patchFiles = exactPatch ? parseUnifiedDiffFiles(exactPatch) : [];
  const files = mergeFileChanges(payloadFiles, patchFiles);

  if (files.length === 0 && exactPatch === undefined) {
    return undefined;
  }

  const fileStats = summarizeFiles(files);
  return {
    availability: exactPatch ? "exact_patch" : "summary_only",
    files,
    ...(exactPatch ? { unifiedDiff: exactPatch } : {}),
    ...(fileStats.additions !== undefined ? { additions: fileStats.additions } : {}),
    ...(fileStats.deletions !== undefined ? { deletions: fileStats.deletions } : {}),
  };
}
