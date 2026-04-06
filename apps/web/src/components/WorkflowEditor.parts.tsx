import type { ReactNode } from "react";
import type { Project } from "../types";
import type { WorkflowDefinition, WorkflowId } from "@forgetools/contracts";
import type { WorkflowEditScope } from "../stores/workflowStore";
import { Link2Icon, PlusIcon, SaveIcon, SparklesIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { SidebarTrigger } from "./ui/sidebar";
import { Textarea } from "./ui/textarea";

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
  onCreateNew: () => void;
  onSave: () => void;
  saveDisabled: boolean;
  savePending: boolean;
}) {
  return (
    <header className="border-b border-border px-3 py-2 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <SidebarTrigger className="size-7 shrink-0 md:hidden" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">Workflow editor</p>
          <p className="text-xs text-muted-foreground">
            Build list-based workflows with phase gates, deliberation, and retry behavior.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={props.onCreateNew}>
          <PlusIcon className="size-4" />
          New workflow
        </Button>
        <Button type="button" onClick={props.onSave} disabled={props.saveDisabled}>
          <SaveIcon className="size-4" />
          {props.savePending ? "Saving…" : "Save"}
        </Button>
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
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Workflows
          </p>
          <p className="text-xs text-muted-foreground">Built-in first, then custom.</p>
        </div>
        <Button type="button" size="xs" variant="outline" onClick={props.onCreateNew}>
          <PlusIcon className="size-3.5" />
          New
        </Button>
      </div>
      <div className="max-h-64 overflow-y-auto px-2 py-2 lg:h-full lg:max-h-none">
        <div className="space-y-1">
          {props.workflows.map((workflow) => {
            const active = props.activeWorkflowId === workflow.id;
            return (
              <Button
                key={workflow.id}
                type="button"
                variant="ghost"
                className={cn(
                  "h-auto w-full justify-start rounded-xl px-3 py-3 text-left",
                  active && "bg-accent text-foreground",
                )}
                onClick={() => props.onSelectWorkflow(workflow.id)}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{workflow.name}</span>
                    {workflow.builtIn ? (
                      <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-amber-700 dark:text-amber-300">
                        Built-in
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {workflow.description || "No description"}
                  </p>
                </div>
              </Button>
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
    <section className="rounded-2xl border border-border/80 bg-card/90 shadow-sm">
      <div className="grid gap-5 border-b border-border/70 px-4 py-4 sm:px-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Name
            </label>
            <Input
              value={props.draft?.name ?? ""}
              onChange={(event) => props.onDraftNameChange(event.target.value)}
              placeholder="build-with-review"
              disabled={props.disabled}
            />
          </div>

          <div className="space-y-2">
            <label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Description
            </label>
            <Textarea
              value={props.draft?.description ?? ""}
              onChange={(event) => props.onDraftDescriptionChange(event.target.value)}
              placeholder="Describe what this workflow optimizes for."
              className="min-h-24"
              disabled={props.disabled}
            />
          </div>
        </div>

        <div className="space-y-4 rounded-2xl border border-border/70 bg-background/60 p-4">
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Scope
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={props.scope === "global" ? "secondary" : "outline"}
                onClick={() => props.onScopeChange("global")}
                disabled={props.disabled}
              >
                Global
              </Button>
              <Button
                type="button"
                size="sm"
                variant={props.scope === "project" ? "secondary" : "outline"}
                onClick={props.onProjectScopeRequest}
                disabled={props.disabled || props.projects.length === 0}
              >
                This project
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {props.scope === "project"
                ? props.currentProject
                  ? `Selected project: ${props.currentProject.name}`
                  : "No project is available yet."
                : "Available across every project."}
            </p>
          </div>

          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Status
            </p>
            <div className="rounded-xl border border-border/70 bg-card px-3 py-2 text-sm">
              {props.draftDirty ? "Unsaved changes" : "Saved"}
            </div>
          </div>

          {isReadOnlyBuiltIn ? (
            <div className="space-y-3 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-3">
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">Built-in workflow</p>
                <p className="text-xs text-muted-foreground">
                  Clone it before editing so the shipped template stays read-only.
                </p>
              </div>
              <Button type="button" variant="outline" onClick={props.onCloneBuiltIn}>
                <SparklesIcon className="size-4" />
                Clone to edit
              </Button>
            </div>
          ) : null}

          {props.validationMessage ? (
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              {props.validationMessage}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function WorkflowEditorFootnote() {
  return (
    <section className="rounded-2xl border border-border/70 bg-card/70 px-4 py-4 text-sm text-muted-foreground shadow-sm sm:px-5">
      <div className="flex items-start gap-3">
        <Link2Icon className="mt-0.5 size-4 shrink-0" />
        <p>
          Built-in workflows stay read-only. Clone them to customize, then save as a new workflow.
          The project scope toggle is preserved in editor state so the UI is ready for
          project-backed workflow persistence as the backend catches up.
        </p>
      </div>
    </section>
  );
}
