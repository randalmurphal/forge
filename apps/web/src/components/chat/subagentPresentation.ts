interface SubagentPresentationInput {
  agentModel?: string | undefined;
  agentDescription?: string | undefined;
  agentPrompt?: string | undefined;
  fallbackLabel?: string | undefined;
}

export interface SubagentPresentation {
  heading: string;
  preview: string | null;
}

export function deriveSubagentPresentation(input: SubagentPresentationInput): SubagentPresentation {
  const model = normalizeSubagentText(input.agentModel);
  const description =
    normalizeSubagentText(input.agentDescription) ??
    normalizeMeaningfulFallbackLabel(input.fallbackLabel);
  const prompt = normalizeSubagentText(input.agentPrompt);
  const heading = model ?? description ?? "Subagent";
  const preview =
    description ??
    (prompt && normalizeSubagentComparison(prompt) !== normalizeSubagentComparison(heading)
      ? prompt
      : null);

  return { heading, preview };
}

function normalizeMeaningfulFallbackLabel(label: string | undefined): string | undefined {
  const normalized = normalizeSubagentText(label);
  if (!normalized) {
    return undefined;
  }
  return normalized === "Subagent" || normalized.startsWith("Subagent ") ? undefined : normalized;
}

function normalizeSubagentText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function normalizeSubagentComparison(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
