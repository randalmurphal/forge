import { parsePatchFiles } from "@pierre/diffs";
import { type FileDiffMetadata } from "@pierre/diffs/react";

export const DIFF_THEME_NAMES = {
  light: "pierre-light",
  dark: "pierre-dark",
} as const;

export type DiffThemeName = (typeof DIFF_THEME_NAMES)[keyof typeof DIFF_THEME_NAMES];
export type DiffComplexity = "normal" | "large" | "huge";
export type CompactDiffPreviewLineKind = "hunk" | "context" | "addition" | "deletion";

export interface CompactDiffPreviewLine {
  key: string;
  kind: CompactDiffPreviewLineKind;
  text: string;
}

export interface CompactDiffPreviewModel {
  kind: "parsed";
  lines: CompactDiffPreviewLine[];
  visibleLines: CompactDiffPreviewLine[];
  hiddenLineCount: number;
  hasOverflow: boolean;
}

export interface CompactRawDiffPreviewModel {
  kind: "raw";
  reason: string;
  lines: string[];
  visibleLines: string[];
  hiddenLineCount: number;
  hasOverflow: boolean;
}

export type CompactDiffPreviewContent = CompactDiffPreviewModel | CompactRawDiffPreviewModel;

export const COMPACT_DIFF_PREVIEW_MAX_VISIBLE_LINES = 8;

export interface DiffSizeStats {
  files: number;
  additions: number;
  deletions: number;
  patchChars?: number;
}

export function resolveDiffThemeName(theme: "light" | "dark"): DiffThemeName {
  return theme === "dark" ? DIFF_THEME_NAMES.dark : DIFF_THEME_NAMES.light;
}

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const SECONDARY_HASH_SEED = 0x9e3779b9;
const SECONDARY_HASH_MULTIPLIER = 0x85ebca6b;

export function fnv1a32(
  input: string,
  seed = FNV_OFFSET_BASIS_32,
  multiplier = FNV_PRIME_32,
): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, multiplier) >>> 0;
  }
  return hash >>> 0;
}

export function buildPatchCacheKey(patch: string, scope = "diff-panel"): string {
  const normalizedPatch = patch.trim();
  const primary = fnv1a32(normalizedPatch, FNV_OFFSET_BASIS_32, FNV_PRIME_32).toString(36);
  const secondary = fnv1a32(
    normalizedPatch,
    SECONDARY_HASH_SEED,
    SECONDARY_HASH_MULTIPLIER,
  ).toString(36);
  return `${scope}:${normalizedPatch.length}:${primary}:${secondary}`;
}

export const DIFF_RENDER_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-light-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-dark-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  --diffs-bg-context-override: color-mix(in srgb, var(--background) 97%, var(--foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 95%, var(--foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--background) 90%, var(--foreground));

  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 92%, var(--success));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 88%, var(--success));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--background) 85%, var(--success));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--success));

  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 92%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--background) 88%, var(--destructive));
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--background) 85%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(
    in srgb,
    var(--background) 80%,
    var(--destructive)
  );

  background-color: var(--diffs-bg) !important;
}

[data-file-info] {
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-block-color: var(--border) !important;
  color: var(--foreground) !important;
}

[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-bottom: 1px solid var(--border) !important;
}

[data-title] {
  cursor: pointer;
  transition:
    color 120ms ease,
    text-decoration-color 120ms ease;
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 2px;
}

[data-title]:hover {
  color: color-mix(in srgb, var(--foreground) 84%, var(--primary)) !important;
  text-decoration-color: currentColor;
}

[data-unmodified-lines] {
  color: transparent !important;
  font-size: 0 !important;
  position: relative;
}

[data-unmodified-lines]::before {
  content: "...";
  color: var(--diffs-fg-number) !important;
  font-size: var(--diffs-font-size, 13px);
}
`;

export type RenderablePatch =
  | {
      kind: "files";
      files: FileDiffMetadata[];
    }
  | {
      kind: "raw";
      text: string;
      reason: string;
    };

export function getRenderablePatch(
  patch: string | undefined,
  cacheScope = "diff-panel",
): RenderablePatch | null {
  if (!patch) return null;
  const normalizedPatch = patch.trim();
  if (normalizedPatch.length === 0) return null;

  try {
    const parsedPatches = parsePatchFiles(
      normalizedPatch,
      buildPatchCacheKey(normalizedPatch, cacheScope),
    );
    const files = parsedPatches.flatMap((parsedPatch) => parsedPatch.files);
    if (files.length > 0) {
      return { kind: "files", files };
    }

    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Unsupported diff format. Showing raw patch.",
    };
  } catch {
    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Failed to parse patch. Showing raw patch.",
    };
  }
}

export function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  const raw = fileDiff.name ?? fileDiff.prevName ?? "";
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
}

export function buildFileDiffRenderKey(fileDiff: FileDiffMetadata): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name}`;
}

export function summarizeFileDiff(fileDiff: FileDiffMetadata): {
  additions: number;
  deletions: number;
} {
  return fileDiff.hunks.reduce(
    (totals, hunk) => ({
      additions: totals.additions + hunk.additionLines,
      deletions: totals.deletions + hunk.deletionLines,
    }),
    { additions: 0, deletions: 0 },
  );
}

export function summarizeDiffFileSummaries(
  files: ReadonlyArray<{ additions?: number | undefined; deletions?: number | undefined }>,
): DiffSizeStats {
  return files.reduce<DiffSizeStats>(
    (totals, file) => ({
      files: totals.files + 1,
      additions: totals.additions + (file.additions ?? 0),
      deletions: totals.deletions + (file.deletions ?? 0),
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
}

export function classifyDiffComplexity(stats: DiffSizeStats): DiffComplexity {
  const changedLines = stats.additions + stats.deletions;
  const patchChars = stats.patchChars ?? 0;

  if (stats.files >= 200 || changedLines >= 15_000 || patchChars >= 800_000) {
    return "huge";
  }

  if (stats.files >= 50 || changedLines >= 3_500 || patchChars >= 180_000) {
    return "large";
  }

  return "normal";
}

export function shouldDefaultCollapseDiffFiles(complexity: DiffComplexity): boolean {
  return complexity !== "normal";
}

export function shouldDeferDiffRendering(complexity: DiffComplexity): boolean {
  return complexity === "huge";
}

export function getDiffLoadingLabel(baseLabel: string, complexity: DiffComplexity): string {
  return complexity === "normal" ? baseLabel : `${baseLabel} This is a chonker, be patient.`;
}

function trimDiffLine(value: string | undefined): string {
  return (value ?? "").replace(/\r?\n$/, "");
}

function finalizeCompactDiffPreviewLines(
  lines: ReadonlyArray<CompactDiffPreviewLine>,
  maxVisibleLines = COMPACT_DIFF_PREVIEW_MAX_VISIBLE_LINES,
): CompactDiffPreviewModel | null {
  if (lines.length === 0) {
    return null;
  }

  const visibleLines = lines.slice(0, maxVisibleLines);
  return {
    kind: "parsed",
    lines: [...lines],
    visibleLines,
    hiddenLineCount: Math.max(0, lines.length - visibleLines.length),
    hasOverflow: lines.length > visibleLines.length,
  };
}

function finalizeCompactRawDiffPreviewLines(
  lines: ReadonlyArray<string>,
  reason: string,
  maxVisibleLines = COMPACT_DIFF_PREVIEW_MAX_VISIBLE_LINES,
): CompactRawDiffPreviewModel | null {
  if (lines.length === 0) {
    return null;
  }

  const visibleLines = lines.slice(0, maxVisibleLines);
  return {
    kind: "raw",
    reason,
    lines: [...lines],
    visibleLines,
    hiddenLineCount: Math.max(0, lines.length - visibleLines.length),
    hasOverflow: lines.length > visibleLines.length,
  };
}

export function buildCompactDiffPreviewFromFiles(
  files: ReadonlyArray<FileDiffMetadata>,
  maxVisibleLines = COMPACT_DIFF_PREVIEW_MAX_VISIBLE_LINES,
): CompactDiffPreviewModel | null {
  const lines: CompactDiffPreviewLine[] = [];

  for (const file of files) {
    for (const [hunkIndex, hunk] of file.hunks.entries()) {
      lines.push({
        key: `${buildFileDiffRenderKey(file)}:hunk:${hunkIndex}`,
        kind: "hunk",
        text: trimDiffLine(hunk.hunkSpecs),
      });

      let additionIndex = hunk.additionLineIndex;
      let deletionIndex = hunk.deletionLineIndex;

      for (const [segmentIndex, segment] of hunk.hunkContent.entries()) {
        if (segment.type === "context") {
          for (let offset = 0; offset < segment.lines; offset += 1) {
            lines.push({
              key: `${buildFileDiffRenderKey(file)}:ctx:${hunkIndex}:${segmentIndex}:${offset}`,
              kind: "context",
              text: trimDiffLine(
                file.additionLines[additionIndex + offset] ??
                  file.deletionLines[deletionIndex + offset],
              ),
            });
          }

          additionIndex += segment.lines;
          deletionIndex += segment.lines;
          continue;
        }

        for (let offset = 0; offset < segment.deletions; offset += 1) {
          lines.push({
            key: `${buildFileDiffRenderKey(file)}:del:${hunkIndex}:${segmentIndex}:${offset}`,
            kind: "deletion",
            text: trimDiffLine(file.deletionLines[deletionIndex + offset]),
          });
        }

        for (let offset = 0; offset < segment.additions; offset += 1) {
          lines.push({
            key: `${buildFileDiffRenderKey(file)}:add:${hunkIndex}:${segmentIndex}:${offset}`,
            kind: "addition",
            text: trimDiffLine(file.additionLines[additionIndex + offset]),
          });
        }

        deletionIndex += segment.deletions;
        additionIndex += segment.additions;
      }
    }
  }

  return finalizeCompactDiffPreviewLines(lines, maxVisibleLines);
}

export function getCompactDiffPreviewContent(
  patch: string | undefined,
  cacheScope = "diff-panel",
  maxVisibleLines = COMPACT_DIFF_PREVIEW_MAX_VISIBLE_LINES,
): CompactDiffPreviewContent | null {
  const renderablePatch = getRenderablePatch(patch, cacheScope);
  if (!renderablePatch) {
    return null;
  }

  if (renderablePatch.kind === "files") {
    return buildCompactDiffPreviewFromFiles(renderablePatch.files, maxVisibleLines);
  }

  return finalizeCompactRawDiffPreviewLines(
    renderablePatch.text.split("\n"),
    renderablePatch.reason,
    maxVisibleLines,
  );
}
