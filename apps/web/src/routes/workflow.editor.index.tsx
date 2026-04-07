import { createFileRoute } from "@tanstack/react-router";
import { WorkflowEditor } from "../components/WorkflowEditor";

function WorkflowEditorNewRouteView() {
  return <WorkflowEditor key="workflow-editor-new" workflowId={null} />;
}

export const Route = createFileRoute("/workflow/editor/")({
  component: WorkflowEditorNewRouteView,
});
