export interface ProposedPlanHistoryKeyInput {
  readonly id: string;
  readonly updatedAt: string;
}

export interface TurnDiffHistoryFileInput {
  readonly path: string;
  readonly kind?: string | null | undefined;
  readonly additions?: number | null | undefined;
  readonly deletions?: number | null | undefined;
}

export interface TurnDiffHistoryKeyInput {
  readonly turnId: string;
  readonly completedAt: string;
  readonly provenance?: string | null | undefined;
  readonly source?: string | null | undefined;
  readonly coverage?: string | null | undefined;
  readonly status?: string | null | undefined;
  readonly checkpointTurnCount?: number | null | undefined;
  readonly checkpointRef?: string | null | undefined;
  readonly files: ReadonlyArray<TurnDiffHistoryFileInput>;
}

function buildTurnDiffFilesSignature(files: ReadonlyArray<TurnDiffHistoryFileInput>): string {
  return files
    .map((file) => {
      const additions = file.additions ?? "";
      const deletions = file.deletions ?? "";
      const kind = file.kind ?? "";
      return `${file.path}:${kind}:${additions}:${deletions}`;
    })
    .join("|");
}

export function buildProposedPlanHistoryKey(proposedPlan: ProposedPlanHistoryKeyInput): string {
  return `${proposedPlan.id}::${proposedPlan.updatedAt}`;
}

export function compareProposedPlanHistoryEntries<T extends ProposedPlanHistoryKeyInput>(
  left: T,
  right: T,
): number {
  return (
    left.updatedAt.localeCompare(right.updatedAt) ||
    buildProposedPlanHistoryKey(left).localeCompare(buildProposedPlanHistoryKey(right))
  );
}

export function findLatestProposedPlanById<T extends ProposedPlanHistoryKeyInput>(
  proposedPlans: ReadonlyArray<T>,
  planId: string,
): T | undefined {
  return [...proposedPlans]
    .filter((entry) => entry.id === planId)
    .toSorted(compareProposedPlanHistoryEntries)
    .at(-1);
}

export function buildTurnDiffHistoryKey(summary: TurnDiffHistoryKeyInput): string {
  return [
    summary.turnId,
    summary.completedAt,
    summary.provenance ?? "",
    summary.source ?? "",
    summary.coverage ?? "",
    summary.status ?? "",
    summary.checkpointTurnCount ?? "",
    summary.checkpointRef ?? "",
    buildTurnDiffFilesSignature(summary.files),
  ].join("::");
}

export function compareTurnDiffHistoryEntries<T extends TurnDiffHistoryKeyInput>(
  left: T,
  right: T,
): number {
  return (
    left.completedAt.localeCompare(right.completedAt) ||
    buildTurnDiffHistoryKey(left).localeCompare(buildTurnDiffHistoryKey(right))
  );
}
