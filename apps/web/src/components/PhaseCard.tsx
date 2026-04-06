import {
  type PhaseCardSharedProps,
  PhaseCardHeader,
  PhaseExecutionSection,
} from "./PhaseCard.parts";
import { PhaseGateSection } from "./PhaseCard.gate";

export function PhaseCard(props: PhaseCardSharedProps) {
  return (
    <section className="rounded-2xl border border-border/80 bg-card/90 shadow-sm">
      <PhaseCardHeader {...props} />

      <div className="space-y-5 px-4 py-4 sm:px-5">
        <PhaseExecutionSection {...props} />
        <PhaseGateSection {...props} />
      </div>
    </section>
  );
}
