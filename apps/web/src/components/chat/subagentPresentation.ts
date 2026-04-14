interface SubagentPresentationInput {
  agentType?: string | undefined;
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
  const type = normalizeSubagentText(input.agentType) ?? "Agent";
  const model = normalizeSubagentText(input.agentModel);
  const description =
    normalizeSubagentText(input.agentDescription) ??
    normalizeMeaningfulFallbackLabel(input.fallbackLabel);

  // Heading: "Type · model" when both exist, or just "Type" (which defaults to "Agent")
  const heading = model ? `${type} \u00b7 ${model}` : type;

  // Preview: only show the explicit description. The prompt is internal metadata
  // and should not leak into the timeline as visible text.
  const preview = description ?? null;

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
