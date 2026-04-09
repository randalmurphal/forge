import type { ModelSelection, ServerProvider, WorkflowPhase } from "@forgetools/contracts";
import type { UnifiedSettings } from "@forgetools/contracts/settings";
import { ArrowDownIcon, ArrowUpIcon, BotIcon, GitBranchPlusIcon, Trash2Icon } from "lucide-react";
import { buildToneBadgeStyle, buildToneSurfaceStyle } from "~/lib/appearance";
import { cn } from "~/lib/utils";
import {
  setWorkflowPhaseDeliberation,
  setWorkflowPhaseExecutionKind,
  type WorkflowExecutionKind,
  WORKFLOW_EXECUTION_KIND_OPTIONS,
} from "./WorkflowEditor.logic";
import { FieldLabel, ModelField, PromptField } from "./PhaseCard.fields";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";

function phaseTypeToneColor(phaseType: WorkflowPhase["type"]): string {
  switch (phaseType) {
    case "multi-agent":
      return "var(--feature-phase-multi-agent)";
    case "automated":
      return "var(--feature-phase-automated)";
    case "human":
      return "var(--feature-phase-human)";
    default:
      return "var(--feature-phase-single-agent)";
  }
}

export interface PhaseCardSharedProps {
  phase: WorkflowPhase;
  phaseIndex: number;
  totalPhases: number;
  promptOptions: readonly string[];
  qualityCheckOptions: readonly string[];
  settings: UnifiedSettings;
  providers: readonly ServerProvider[];
  fallbackModelSelection: ModelSelection;
  disabled?: boolean;
  onChange: (phase: WorkflowPhase) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  previousPhaseOptions: readonly string[];
}

function PhaseTypeBadge({ phaseType }: { phaseType: WorkflowPhase["type"] }) {
  const color = phaseTypeToneColor(phaseType);

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.08em]"
      style={buildToneBadgeStyle(color)}
    >
      {phaseType === "multi-agent" ? (
        <GitBranchPlusIcon className="size-3" />
      ) : (
        <BotIcon className="size-3" />
      )}
      {phaseType === "single-agent"
        ? "Single agent"
        : phaseType === "multi-agent"
          ? "Deliberation"
          : phaseType === "automated"
            ? "Automated"
            : "Human"}
    </span>
  );
}

export function PhaseCardHeader(props: PhaseCardSharedProps) {
  return (
    <header className="flex flex-wrap items-start gap-3 border-b border-border/70 px-4 py-4 sm:px-5">
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Phase {props.phaseIndex + 1}
          </span>
          <PhaseTypeBadge phaseType={props.phase.type} />
        </div>
        <Input
          value={props.phase.name}
          onChange={(event) =>
            props.onChange({
              ...props.phase,
              name: event.target.value,
            })
          }
          placeholder="Phase name"
          disabled={props.disabled}
        />
      </div>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={props.disabled || props.phaseIndex === 0}
          onClick={props.onMoveUp}
          aria-label={`Move ${props.phase.name || `phase ${props.phaseIndex + 1}`} up`}
        >
          <ArrowUpIcon className="size-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={props.disabled || props.phaseIndex === props.totalPhases - 1}
          onClick={props.onMoveDown}
          aria-label={`Move ${props.phase.name || `phase ${props.phaseIndex + 1}`} down`}
        >
          <ArrowDownIcon className="size-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={props.disabled}
          onClick={props.onDelete}
          aria-label={`Delete ${props.phase.name || `phase ${props.phaseIndex + 1}`}`}
        >
          <Trash2Icon className="size-4" />
        </Button>
      </div>
    </header>
  );
}

export function PhaseExecutionSection(
  props: Pick<
    PhaseCardSharedProps,
    | "phase"
    | "disabled"
    | "onChange"
    | "fallbackModelSelection"
    | "providers"
    | "promptOptions"
    | "settings"
  >,
) {
  const executionKind = props.phase.type === "multi-agent" ? "agent" : props.phase.type;
  const singleAgentPrompt = props.phase.agent?.prompt ?? "";

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-2">
          <FieldLabel>Execution</FieldLabel>
          <Select
            value={executionKind}
            onValueChange={(value) => {
              if (!value) {
                return;
              }
              props.onChange(
                setWorkflowPhaseExecutionKind(props.phase, value as WorkflowExecutionKind),
              );
            }}
            disabled={props.disabled}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {WORKFLOW_EXECUTION_KIND_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>

        <div
          className={cn(
            "flex items-center justify-between rounded-xl border px-3 py-2.5",
            executionKind === "agent"
              ? "border-border/80 bg-background/70"
              : "border-dashed border-border/60 bg-background/45 text-muted-foreground",
          )}
        >
          <div>
            <p className="text-sm font-medium">Deliberation</p>
            <p className="text-xs text-muted-foreground">
              Adds Advocate and Interrogator participants for this phase.
            </p>
          </div>
          <Switch
            checked={props.phase.type === "multi-agent"}
            disabled={props.disabled || executionKind !== "agent"}
            onCheckedChange={(checked) =>
              props.onChange(setWorkflowPhaseDeliberation(props.phase, checked))
            }
          />
        </div>
      </div>

      {props.phase.type === "single-agent" ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <ModelField
            label="Model"
            modelSelection={props.phase.agent?.model}
            fallbackModelSelection={props.fallbackModelSelection}
            settings={props.settings}
            providers={props.providers}
            disabled={props.disabled ?? false}
            onChange={(model) =>
              props.onChange({
                ...props.phase,
                agent: {
                  ...(props.phase.agent ?? {
                    prompt: "",
                    output: { type: "conversation" as const },
                  }),
                  prompt: props.phase.agent?.prompt ?? "",
                  output: props.phase.agent?.output ?? { type: "conversation" as const },
                  ...(model ? { model } : { model: undefined }),
                },
              })
            }
          />
          <PromptField
            label="Prompt"
            prompt={singleAgentPrompt}
            promptOptions={props.promptOptions}
            disabled={props.disabled ?? false}
            onChange={(prompt) =>
              props.onChange({
                ...props.phase,
                agent: {
                  ...(props.phase.agent ?? { output: { type: "conversation" as const } }),
                  prompt,
                  output: props.phase.agent?.output ?? { type: "conversation" as const },
                },
              })
            }
          />
        </div>
      ) : null}

      {props.phase.type === "multi-agent" ? (
        <PhaseDeliberationSection
          phase={props.phase}
          promptOptions={props.promptOptions}
          settings={props.settings}
          providers={props.providers}
          fallbackModelSelection={props.fallbackModelSelection}
          disabled={props.disabled ?? false}
          onChange={props.onChange}
        />
      ) : null}

      {(props.phase.type === "human" || props.phase.type === "automated") && (
        <div className="rounded-xl border border-dashed border-border/70 bg-background/60 px-3 py-3 text-sm text-muted-foreground">
          {props.phase.type === "automated"
            ? "Automated phases run checks or tooling without a provider-specific model override."
            : "Human phases pause the workflow for review or manual input."}
        </div>
      )}
    </>
  );
}

function PhaseDeliberationSection(
  props: Pick<
    PhaseCardSharedProps,
    | "phase"
    | "promptOptions"
    | "settings"
    | "providers"
    | "fallbackModelSelection"
    | "disabled"
    | "onChange"
  >,
) {
  const primaryParticipant = props.phase.deliberation?.participants[0];
  const secondaryParticipant = props.phase.deliberation?.participants[1];

  return (
    <div
      className="space-y-4 rounded-2xl border p-4"
      style={buildToneSurfaceStyle("var(--feature-phase-multi-agent)", {
        borderPercent: 20,
        backgroundPercent: 5,
        textColor: "var(--foreground)",
      })}
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <FieldLabel>Advocate</FieldLabel>
          <ModelField
            label="Model"
            modelSelection={primaryParticipant?.agent.model}
            fallbackModelSelection={props.fallbackModelSelection}
            settings={props.settings}
            providers={props.providers}
            disabled={props.disabled ?? false}
            onChange={(model) =>
              props.onChange({
                ...props.phase,
                deliberation: {
                  participants: [
                    {
                      role: primaryParticipant?.role ?? "advocate",
                      agent: {
                        prompt: primaryParticipant?.agent.prompt ?? "advocate",
                        output: primaryParticipant?.agent.output ?? { type: "channel" },
                        ...(model ? { model } : { model: undefined }),
                      },
                    },
                    secondaryParticipant ?? {
                      role: "interrogator",
                      agent: {
                        prompt: "interrogator",
                        output: { type: "channel" },
                      },
                    },
                  ],
                  maxTurns: props.phase.deliberation?.maxTurns ?? 20,
                },
              })
            }
          />
          <PromptField
            label="Prompt"
            prompt={primaryParticipant?.agent.prompt ?? "advocate"}
            promptOptions={props.promptOptions}
            disabled={props.disabled ?? false}
            onChange={(prompt) =>
              props.onChange({
                ...props.phase,
                deliberation: {
                  participants: [
                    {
                      role: primaryParticipant?.role ?? "advocate",
                      agent: {
                        prompt,
                        output: primaryParticipant?.agent.output ?? { type: "channel" },
                        ...(primaryParticipant?.agent.model
                          ? { model: primaryParticipant.agent.model }
                          : {}),
                      },
                    },
                    secondaryParticipant ?? {
                      role: "interrogator",
                      agent: {
                        prompt: "interrogator",
                        output: { type: "channel" },
                      },
                    },
                  ],
                  maxTurns: props.phase.deliberation?.maxTurns ?? 20,
                },
              })
            }
          />
        </div>

        <div className="space-y-4">
          <FieldLabel>Interrogator</FieldLabel>
          <ModelField
            label="Model"
            modelSelection={secondaryParticipant?.agent.model}
            fallbackModelSelection={props.fallbackModelSelection}
            settings={props.settings}
            providers={props.providers}
            disabled={props.disabled ?? false}
            onChange={(model) =>
              props.onChange({
                ...props.phase,
                deliberation: {
                  participants: [
                    primaryParticipant ?? {
                      role: "advocate",
                      agent: {
                        prompt: "advocate",
                        output: { type: "channel" },
                      },
                    },
                    {
                      role: secondaryParticipant?.role ?? "interrogator",
                      agent: {
                        prompt: secondaryParticipant?.agent.prompt ?? "interrogator",
                        output: secondaryParticipant?.agent.output ?? { type: "channel" },
                        ...(model ? { model } : { model: undefined }),
                      },
                    },
                  ],
                  maxTurns: props.phase.deliberation?.maxTurns ?? 20,
                },
              })
            }
          />
          <PromptField
            label="Prompt"
            prompt={secondaryParticipant?.agent.prompt ?? "interrogator"}
            promptOptions={props.promptOptions}
            disabled={props.disabled ?? false}
            onChange={(prompt) =>
              props.onChange({
                ...props.phase,
                deliberation: {
                  participants: [
                    primaryParticipant ?? {
                      role: "advocate",
                      agent: {
                        prompt: "advocate",
                        output: { type: "channel" },
                      },
                    },
                    {
                      role: secondaryParticipant?.role ?? "interrogator",
                      agent: {
                        prompt,
                        output: secondaryParticipant?.agent.output ?? { type: "channel" },
                        ...(secondaryParticipant?.agent.model
                          ? { model: secondaryParticipant.agent.model }
                          : {}),
                      },
                    },
                  ],
                  maxTurns: props.phase.deliberation?.maxTurns ?? 20,
                },
              })
            }
          />
        </div>
      </div>

      <div className="max-w-48 space-y-2">
        <FieldLabel>Max turns</FieldLabel>
        <Input
          type="number"
          min={1}
          value={String(props.phase.deliberation?.maxTurns ?? 20)}
          onChange={(event) =>
            props.onChange({
              ...props.phase,
              deliberation: {
                participants: props.phase.deliberation?.participants ?? [],
                maxTurns: Math.max(1, Number(event.target.value) || 1),
              },
            })
          }
          disabled={props.disabled}
        />
      </div>
    </div>
  );
}
