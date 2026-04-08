import { WorkflowId } from "@forgetools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { WorkflowEditor } from "../components/WorkflowEditor";

function AgentModesWorkflowDetailRouteView() {
  const workflowId = Route.useParams({
    select: (params) => WorkflowId.makeUnsafe(params.workflowId),
  });

  return <WorkflowEditor key={workflowId} workflowId={workflowId} />;
}

export const Route = createFileRoute("/agent-modes/workflows/$workflowId")({
  component: AgentModesWorkflowDetailRouteView,
});
