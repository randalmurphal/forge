import type {
  OrchestrationGetFullThreadAgentDiffInput,
  OrchestrationGetFullThreadAgentDiffResult,
  OrchestrationGetTurnAgentDiffInput,
  OrchestrationGetTurnAgentDiffResult,
} from "@forgetools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface AgentDiffQueryShape {
  readonly getTurnAgentDiff: (
    input: OrchestrationGetTurnAgentDiffInput,
  ) => Effect.Effect<OrchestrationGetTurnAgentDiffResult, ProjectionRepositoryError>;

  readonly getFullThreadAgentDiff: (
    input: OrchestrationGetFullThreadAgentDiffInput,
  ) => Effect.Effect<OrchestrationGetFullThreadAgentDiffResult, ProjectionRepositoryError>;
}

export class AgentDiffQuery extends ServiceMap.Service<AgentDiffQuery, AgentDiffQueryShape>()(
  "forge/orchestration/Services/AgentDiffQuery",
) {}
