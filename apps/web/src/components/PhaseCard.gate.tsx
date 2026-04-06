import type { WorkflowPhase } from "@forgetools/contracts";
import {
  toggleWorkflowPhaseQualityCheck,
  WORKFLOW_GATE_AFTER_OPTIONS,
  WORKFLOW_GATE_ON_FAIL_OPTIONS,
  setWorkflowPhaseAfter,
} from "./WorkflowEditor.logic";
import type { PhaseCardSharedProps } from "./PhaseCard.parts";
import { FieldLabel } from "./PhaseCard.fields";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

export function PhaseGateSection(
  props: Pick<
    PhaseCardSharedProps,
    "phase" | "qualityCheckOptions" | "disabled" | "onChange" | "previousPhaseOptions"
  >,
) {
  const qualityChecks =
    props.phase.type === "automated"
      ? (props.phase.qualityChecks ?? [])
      : (props.phase.gate.qualityChecks ?? []);

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-2">
          <FieldLabel>After</FieldLabel>
          <Select
            value={props.phase.gate.after}
            onValueChange={(value) => {
              if (!value) {
                return;
              }
              props.onChange(
                setWorkflowPhaseAfter(props.phase, value as WorkflowPhase["gate"]["after"]),
              );
            }}
            disabled={props.disabled}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {WORKFLOW_GATE_AFTER_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>

        <div className="space-y-2">
          <FieldLabel>On fail</FieldLabel>
          <Select
            value={props.phase.gate.onFail}
            onValueChange={(value) => {
              if (!value) {
                return;
              }
              if (value === "go-back-to" && props.previousPhaseOptions.length === 0) {
                return;
              }
              props.onChange({
                ...props.phase,
                gate: {
                  ...props.phase.gate,
                  onFail: value as WorkflowPhase["gate"]["onFail"],
                  retryPhase:
                    value === "go-back-to"
                      ? (props.phase.gate.retryPhase ?? props.previousPhaseOptions[0])
                      : undefined,
                },
              });
            }}
            disabled={props.disabled}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {WORKFLOW_GATE_ON_FAIL_OPTIONS.map((option) => (
                <SelectItem
                  key={option.value}
                  value={option.value}
                  className={
                    option.value === "go-back-to" && props.previousPhaseOptions.length === 0
                      ? "pointer-events-none opacity-50"
                      : undefined
                  }
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>

      {props.phase.gate.onFail === "go-back-to" ? (
        <div className="space-y-2">
          <FieldLabel>Retry phase</FieldLabel>
          <Select
            value={props.phase.gate.retryPhase ?? props.previousPhaseOptions[0] ?? ""}
            onValueChange={(value) => {
              if (!value) {
                return;
              }
              props.onChange({
                ...props.phase,
                gate: {
                  ...props.phase.gate,
                  retryPhase: value,
                },
              });
            }}
            disabled={props.disabled || props.previousPhaseOptions.length === 0}
          >
            <SelectTrigger>
              <SelectValue
                placeholder={
                  props.previousPhaseOptions.length === 0
                    ? "Add an earlier phase first"
                    : "Select phase"
                }
              />
            </SelectTrigger>
            <SelectPopup>
              {props.previousPhaseOptions.map((phaseName) => (
                <SelectItem key={phaseName} value={phaseName}>
                  {phaseName}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      ) : null}

      <div className="max-w-48 space-y-2">
        <FieldLabel>Max retries</FieldLabel>
        <Input
          type="number"
          min={0}
          value={String(props.phase.gate.maxRetries)}
          onChange={(event) =>
            props.onChange({
              ...props.phase,
              gate: {
                ...props.phase.gate,
                maxRetries: Math.max(0, Number(event.target.value) || 0),
              },
            })
          }
          disabled={props.disabled}
        />
      </div>

      {props.phase.gate.after === "quality-checks" ? (
        <div className="space-y-3 rounded-2xl border border-border/70 bg-background/60 px-4 py-4">
          <FieldLabel>Checks</FieldLabel>
          <div className="flex flex-wrap gap-3">
            {props.qualityCheckOptions.map((check) => {
              const checked = qualityChecks.some((candidate) => candidate.check === check);
              return (
                <label
                  key={check}
                  className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-card px-3 py-1.5 text-sm"
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(nextChecked) =>
                      props.onChange(
                        toggleWorkflowPhaseQualityCheck(props.phase, check, nextChecked === true),
                      )
                    }
                    disabled={props.disabled}
                  />
                  <span>{check}</span>
                </label>
              );
            })}
          </div>
        </div>
      ) : null}
    </>
  );
}
