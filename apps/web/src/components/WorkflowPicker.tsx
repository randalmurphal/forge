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
  NO_WORKFLOW_VALUE,
  resolveWorkflowPickerLabel,
  sortWorkflowSummariesForPicker,
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
  const availableWorkflows = useMemo(
    () => sortWorkflowSummariesForPicker(workflowQuery.data ?? storedWorkflows),
    [storedWorkflows, workflowQuery.data],
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
    if (availableWorkflows.some((workflow) => workflow.workflowId === draftThread.workflowId)) {
      return;
    }
    setDraftThreadContext(props.threadId, { workflowId: null });
    setSelectedWorkflowId(null);
  }, [
    availableWorkflows,
    draftThread?.workflowId,
    props.threadId,
    setDraftThreadContext,
    setSelectedWorkflowId,
    workflowQuery.isSuccess,
  ]);

  const resolvedWorkflowId = draftThread?.workflowId ?? null;
  const triggerLabel = resolveWorkflowPickerLabel({
    selectedWorkflowId: resolvedWorkflowId,
    workflows: availableWorkflows,
  });

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
            onValueChange={(value) => {
              const nextWorkflowId =
                value === NO_WORKFLOW_VALUE
                  ? null
                  : (availableWorkflows.find((workflow) => workflow.workflowId === value)
                      ?.workflowId ?? null);
              setDraftThreadContext(props.threadId, { workflowId: nextWorkflowId });
              setSelectedWorkflowId(nextWorkflowId);
            }}
          >
            <MenuRadioItem value={NO_WORKFLOW_VALUE}>(none)</MenuRadioItem>
            {availableWorkflows.map((workflow) => (
              <MenuRadioItem key={workflow.workflowId} value={workflow.workflowId}>
                {workflow.name}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
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
