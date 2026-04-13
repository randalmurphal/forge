import { deriveSubagentPresentation } from "./subagentPresentation";

/**
 * Shared heading component for all subagent/agent displays.
 * Used by the inline spawn row, background tray, and completed subagent section.
 */
export function SubagentHeading(props: {
  agentType?: string | undefined;
  agentModel?: string | undefined;
  agentDescription?: string | undefined;
  agentPrompt?: string | undefined;
  fallbackLabel?: string | undefined;
}) {
  const { heading, preview } = deriveSubagentPresentation(props);
  return (
    <>
      <span className="text-foreground/80">{heading}</span>
      {preview ? (
        <span className="text-muted-foreground/55">
          {" – "}
          {preview}
        </span>
      ) : null}
    </>
  );
}
