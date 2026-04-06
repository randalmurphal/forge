import type { ThreadId } from "@forgetools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useComposerDraftStore } from "../composerDraftStore";
import { useWorkflowStore, useWorkflows } from "../stores/workflowStore";
import { Button } from "./ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import {
  buildWorkflowPickerSections,
  compactWorkflowPickerSections,
  NO_WORKFLOW_VALUE,
  resolveWorkflowPickerLabel,
} from "./WorkflowPicker.logic";
import { cn } from "~/lib/utils";

export function WorkflowPicker(props: {
  threadId: ThreadId;
  compact?: boolean;
  disabled?: boolean;
}) {
  const draftThread = useComposerDraftStore((store) => store.getDraftThread(props.threadId));
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const storedWorkflows = useWorkflowStore((store) => store.availableWorkflows);
  const selectedWorkflowId = useWorkflowStore((store) => store.selectedWorkflowId);
  const setSelectedWorkflowId = useWorkflowStore((store) => store.setSelectedWorkflowId);
  const workflowQuery = useWorkflows();
  const availableWorkflows = workflowQuery.data ?? storedWorkflows;
  const workflowSections = useMemo(
    () =>
      compactWorkflowPickerSections(
        buildWorkflowPickerSections({
          projectId: draftThread?.projectId ?? null,
          workflows: availableWorkflows,
        }),
      ),
    [availableWorkflows, draftThread?.projectId],
  );
  const selectableWorkflows = useMemo(
    () => workflowSections.flatMap((section) => section.workflows),
    [workflowSections],
  );

  useEffect(() => {
    const draftWorkflowId = draftThread?.workflowId ?? null;
    if (selectedWorkflowId !== draftWorkflowId) {
      setSelectedWorkflowId(draftWorkflowId);
    }
  }, [draftThread?.workflowId, selectedWorkflowId, setSelectedWorkflowId]);

  useEffect(() => {
    if (!draftThread?.workflowId) {
      return;
    }
    if (!workflowQuery.isSuccess) {
      return;
    }
    if (selectableWorkflows.some((workflow) => workflow.workflowId === draftThread.workflowId)) {
      return;
    }
    setDraftThreadContext(props.threadId, { workflowId: null });
    setSelectedWorkflowId(null);
  }, [
    draftThread?.workflowId,
    props.threadId,
    setDraftThreadContext,
    setSelectedWorkflowId,
    selectableWorkflows,
    workflowQuery.isSuccess,
  ]);

  const resolvedWorkflowId = draftThread?.workflowId ?? null;
  const triggerLabel = resolveWorkflowPickerLabel({
    selectedWorkflowId: resolvedWorkflowId,
    workflows: selectableWorkflows,
  });
  const selectWorkflow = (value: string) => {
    const nextWorkflowId =
      value === NO_WORKFLOW_VALUE
        ? null
        : (selectableWorkflows.find((workflow) => workflow.workflowId === value)?.workflowId ??
          null);
    setDraftThreadContext(props.threadId, { workflowId: nextWorkflowId });
    setSelectedWorkflowId(nextWorkflowId);
  };

  if (!draftThread) {
    return null;
  }

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3",
              props.compact ? "min-w-0" : "max-w-56",
            )}
            aria-label="Workflow picker"
            data-testid="workflow-picker-trigger"
            disabled={props.disabled}
          />
        }
      >
        <span className="max-w-40 truncate">{triggerLabel}</span>
        <ChevronDownIcon className="size-3 opacity-50" />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-56">
        <MenuGroup>
          <MenuGroupLabel>Workflow</MenuGroupLabel>
          <MenuRadioGroup
            value={resolvedWorkflowId ?? NO_WORKFLOW_VALUE}
            onValueChange={selectWorkflow}
          >
            <MenuRadioItem value={NO_WORKFLOW_VALUE}>(none)</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        {workflowSections.map((section) => (
          <MenuGroup key={section.key}>
            <MenuGroupLabel>{section.label}</MenuGroupLabel>
            <MenuRadioGroup
              value={resolvedWorkflowId ?? NO_WORKFLOW_VALUE}
              onValueChange={selectWorkflow}
            >
              {section.workflows.map((workflow) => (
                <MenuRadioItem
                  key={workflow.workflowId}
                  value={workflow.workflowId}
                  className="min-h-11 items-start"
                >
                  <div className="flex min-w-0 flex-col gap-0.5 py-0.5">
                    <span className="truncate font-medium text-foreground">{workflow.name}</span>
                    {workflow.description.trim().length > 0 ? (
                      <span className="line-clamp-2 text-xs text-muted-foreground">
                        {workflow.description}
                      </span>
                    ) : null}
                  </div>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        ))}
        {workflowQuery.isPending ? (
          <>
            <MenuSeparator />
            <div className="px-2 py-1.5 text-muted-foreground text-xs">Loading workflows...</div>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
