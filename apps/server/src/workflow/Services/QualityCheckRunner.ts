import { QualityCheckReference, QualityCheckResult } from "@forgetools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { QualityCheckRunnerError } from "../Errors.ts";

export const RunQualityChecksInput = Schema.Struct({
  projectRoot: Schema.String,
  worktreeDir: Schema.String,
  checks: Schema.Array(QualityCheckReference),
});
export type RunQualityChecksInput = typeof RunQualityChecksInput.Type;

export interface QualityCheckRunnerShape {
  readonly run: (
    input: RunQualityChecksInput,
  ) => Effect.Effect<ReadonlyArray<QualityCheckResult>, QualityCheckRunnerError>;
}

export class QualityCheckRunner extends ServiceMap.Service<
  QualityCheckRunner,
  QualityCheckRunnerShape
>()("t3/workflow/Services/QualityCheckRunner") {}
