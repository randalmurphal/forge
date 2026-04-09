import type { ReactNode } from "react";
import type { Project } from "../types";
import type { WorkflowDefinition, WorkflowId, WorkflowPhase } from "@forgetools/contracts";
import type { WorkflowEditScope } from "../stores/workflowStore";
import { Link2Icon, PlusIcon, SaveIcon, SparklesIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { resolveWorkflowScopeLabel } from "./WorkflowEditor.logic";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { SidebarTrigger } from "./ui/sidebar";
import { Textarea } from "./ui/textarea";

const PHASE_TYPE_DOT_COLOR: Record<WorkflowPhase["type"], string> = {
  "single-agent": "var(--feature-phase-single-agent)",
  "multi-agent": "var(--feature-phase-multi-agent)",
  automated: "var(--feature-phase-automated)",
  human: "var(--feature-phase-human)",
};

function ScopeBadge({ label }: { label: string }) {
  const isProject = label.toLowerCase() === "project";
  const color = isProject
    ? "var(--feature-discussion-project)"
    : label.toLowerCase() === "built-in"
      ? "var(--feature-phase-automated)"
      : "var(--feature-discussion-global)";
  return (
    <span
      className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none tracking-[0.04em]"
      style={{
        backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
        color,
      }}
    >
      {label}
    </span>
  );
}

export function WorkflowEditorShell(props: {
  children?: ReactNode;
  title?: string;
  subtitle?: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="border-b border-border px-3 py-2 sm:px-5">
        <div className="flex items-center gap-2">
          <SidebarTrigger className="size-7 shrink-0 md:hidden" />
          <div className="min-w-0 flex-1">
            <span className="text-sm font-medium text-foreground">
              {props.title ?? "Workflow editor"}
            </span>
            {props.subtitle ? (
              <p className="text-xs text-muted-foreground">{props.subtitle}</p>
            ) : null}
          </div>
        </div>
      </header>
      {props.children}
    </div>
  );
}

export function WorkflowEditorTopBar(props: {
  workflowName: string;
  scopeLabel: string;
  isExisting: boolean;
  onCreateNew: () => void;
  onSave: () => void;
  onDelete?: () => void;
  saveDisabled: boolean;
  savePending: boolean;
  deleteDisabled?: boolean;
}) {
  return (
    <header className="border-b border-border px-4 py-3 sm:px-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h1 className="truncate text-lg font-semibold text-foreground">
            {props.workflowName || "New workflow"}
          </h1>
          <ScopeBadge label={props.scopeLabel} />
        </div>
        <div className="flex items-center gap-1.5">
          {props.isExisting && props.onDelete ? (
            <button
              type="button"
              onClick={props.onDelete}
              disabled={props.deleteDisabled}
              className="rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground/60 transition-colors hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
            >
              Delete
            </button>
          ) : null}
          <Button type="button" size="sm" variant="outline" onClick={props.onCreateNew}>
            <PlusIcon className="size-3.5" />
            New
          </Button>
          <Button type="button" size="sm" onClick={props.onSave} disabled={props.saveDisabled}>
            <SaveIcon className="size-3.5" />
            {props.savePending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </header>
  );
}

export function WorkflowEditorSidebar(props: {
  workflows: readonly WorkflowDefinition[];
  activeWorkflowId: WorkflowId | null;
  onSelectWorkflow: (workflowId: WorkflowId) => void;
  onCreateNew: () => void;
}) {
  return (
    <aside className="min-h-0 border-b border-border/70 bg-card/50 lg:border-r lg:border-b-0">
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/60">
          Workflows
        </span>
        <Button type="button" size="xs" variant="outline" onClick={props.onCreateNew}>
          <PlusIcon className="size-3.5" />
          New
        </Button>
      </div>
      <div className="max-h-64 overflow-y-auto px-2 py-2 lg:h-full lg:max-h-none">
        <div className="flex flex-col gap-0.5">
          {props.workflows.map((workflow) => {
            const active = props.activeWorkflowId === workflow.id;
            const scopeLabel = resolveWorkflowScopeLabel(workflow);
            const phaseTypes = workflow.phases.map((phase) => phase.type);
            const uniquePhaseTypes = [...new Set(phaseTypes)];
            return (
              <button
                key={workflow.id}
                type="button"
                className={cn(
                  "w-full cursor-pointer rounded-[10px] border px-3 py-2.5 text-left transition-all",
                  active
                    ? "border-border bg-[var(--panel-elevated)]"
                    : "border-transparent hover:bg-[var(--panel-elevated)]",
                )}
                onClick={() => props.onSelectWorkflow(workflow.id)}
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-foreground">
                    {workflow.name || "Untitled"}
                  </span>
                  <ScopeBadge label={scopeLabel} />
                </div>
                {uniquePhaseTypes.length > 0 ? (
                  <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground/60">
                    {uniquePhaseTypes.map((phaseType, index) => (
                      <span key={phaseType} className="inline-flex items-center gap-1">
                        {index > 0 ? <span className="text-border">·</span> : null}
                        <span
                          className="inline-block size-[5px] shrink-0 rounded-full"
                          style={{ backgroundColor: PHASE_TYPE_DOT_COLOR[phaseType] }}
                        />
                        <span>
                          {phaseType === "single-agent"
                            ? "single"
                            : phaseType === "multi-agent"
                              ? "delib"
                              : phaseType}
                        </span>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 truncate text-[11px] text-muted-foreground/60">
                    {workflow.description || "No phases"}
                  </p>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

export function WorkflowEditorBasicsSection(props: {
  draft: WorkflowDefinition | null;
  disabled: boolean;
  scope: WorkflowEditScope;
  projects: readonly Project[];
  currentProject: Project | null;
  draftDirty: boolean;
  sourceWorkflow: WorkflowDefinition | null;
  validationMessage: string | null;
  onDraftNameChange: (name: string) => void;
  onDraftDescriptionChange: (description: string) => void;
  onScopeChange: (scope: WorkflowEditScope) => void;
  onProjectScopeRequest: () => void;
  onCloneBuiltIn: () => void;
}) {
  const isReadOnlyBuiltIn =
    props.sourceWorkflow !== null &&
    props.sourceWorkflow.builtIn &&
    props.draft?.id === props.sourceWorkflow.id;

  return (
    <div className="space-y-5">
      {/* Identity row: name + scope inline */}
      <div className="flex items-end gap-3.5">
        <div className="min-w-0 flex-1 max-w-56 space-y-1">
          <label className="text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground/60">
            Name
          </label>
          <Input
            value={props.draft?.name ?? ""}
            onChange={(event) => props.onDraftNameChange(event.target.value)}
            placeholder="build-with-review"
            disabled={props.disabled}
          />
        </div>
        <div className="space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground/60">
            Scope
          </span>
          <div className="flex overflow-hidden rounded-lg border border-border bg-[var(--panel-elevated)]">
            <button
              type="button"
              onClick={() => props.onScopeChange("global")}
              disabled={props.disabled}
              className={cn(
                "px-3.5 py-[7px] text-xs font-medium transition-all whitespace-nowrap",
                props.scope === "global"
                  ? "text-white"
                  : "bg-transparent text-muted-foreground/60 hover:text-muted-foreground disabled:pointer-events-none disabled:opacity-50",
              )}
              style={
                props.scope === "global"
                  ? { backgroundColor: "var(--feature-discussion-global)" }
                  : undefined
              }
            >
              Global
            </button>
            <button
              type="button"
              onClick={props.onProjectScopeRequest}
              disabled={props.disabled || props.projects.length === 0}
              className={cn(
                "px-3.5 py-[7px] text-xs font-medium transition-all whitespace-nowrap",
                props.scope === "project"
                  ? "text-white"
                  : "bg-transparent text-muted-foreground/60 hover:text-muted-foreground disabled:pointer-events-none disabled:opacity-50",
              )}
              style={
                props.scope === "project"
                  ? { backgroundColor: "var(--feature-discussion-project)" }
                  : undefined
              }
            >
              Project
            </button>
          </div>
        </div>
      </div>

      {/* Scope detail */}
      {props.scope === "project" ? (
        <p className="text-xs text-muted-foreground">
          {props.currentProject ? `Project: ${props.currentProject.name}` : "No project available."}
        </p>
      ) : null}

      {/* Description */}
      <div className="space-y-1">
        <label className="text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground/60">
          Description
        </label>
        <Textarea
          value={props.draft?.description ?? ""}
          onChange={(event) => props.onDraftDescriptionChange(event.target.value)}
          placeholder="Describe what this workflow optimizes for."
          className="[&_textarea]:min-h-10"
          disabled={props.disabled}
        />
      </div>

      {/* Compact alerts area */}
      {isReadOnlyBuiltIn ? (
        <div
          className="flex items-center gap-3 rounded-lg border px-3 py-2.5"
          style={{
            borderColor: "color-mix(in srgb, var(--warning) 20%, transparent)",
            backgroundColor: "color-mix(in srgb, var(--warning) 10%, transparent)",
          }}
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">Built-in workflow</p>
            <p className="text-xs text-muted-foreground">
              Clone before editing so the template stays read-only.
            </p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={props.onCloneBuiltIn}>
            <SparklesIcon className="size-3.5" />
            Clone
          </Button>
        </div>
      ) : null}

      {props.draftDirty && props.validationMessage ? (
        <div
          className="rounded-lg border px-3 py-2 text-sm"
          style={{
            borderColor: "color-mix(in srgb, var(--warning) 20%, transparent)",
            backgroundColor: "color-mix(in srgb, var(--warning) 10%, transparent)",
            color: "var(--warning-foreground)",
          }}
        >
          {props.validationMessage}
        </div>
      ) : null}

      {/* Section divider */}
      <div className="h-px bg-border" />
    </div>
  );
}

export function WorkflowEditorFootnote() {
  return (
    <section className="rounded-xl border border-border/70 bg-card/70 px-4 py-3.5 text-sm text-muted-foreground shadow-sm sm:px-5">
      <div className="flex items-start gap-3">
        <Link2Icon className="mt-0.5 size-4 shrink-0" />
        <p>
          Built-in workflows stay read-only. Clone them to customize, then save them globally or for
          a single project from the scope controls above.
        </p>
      </div>
    </section>
  );
}
