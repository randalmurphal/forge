export interface ForgeSessionIdentityInput {
  readonly parentThreadId: string | null;
  readonly phaseRunId: string | null;
  readonly workflowId: string | null;
  readonly patternId: string | null;
  readonly role: string | null;
}

export type ForgeSessionType = "agent" | "workflow" | "chat";

export function deriveForgeSessionType(input: ForgeSessionIdentityInput): ForgeSessionType {
  if (input.parentThreadId === null && input.workflowId !== null) {
    return "workflow";
  }
  if (input.parentThreadId === null && input.patternId !== null) {
    return "chat";
  }
  return "agent";
}

export function isStandaloneAgentSession(input: ForgeSessionIdentityInput): boolean {
  return (
    deriveForgeSessionType(input) === "agent" &&
    input.parentThreadId === null &&
    input.phaseRunId === null &&
    input.workflowId === null &&
    input.patternId === null &&
    input.role === null
  );
}
