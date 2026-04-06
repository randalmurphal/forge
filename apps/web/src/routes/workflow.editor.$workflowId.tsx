import { WorkflowId } from "@forgetools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { WorkflowEditor } from "../components/WorkflowEditor";

function WorkflowEditorDetailRouteView() {
  const workflowId = Route.useParams({
    select: (params) => WorkflowId.makeUnsafe(params.workflowId),
  });

  return <WorkflowEditor key={workflowId} workflowId={workflowId} />;
}

export const Route = createFileRoute("/workflow/editor/$workflowId")({
  component: WorkflowEditorDetailRouteView,
});
