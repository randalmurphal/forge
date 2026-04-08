import { createFileRoute } from "@tanstack/react-router";

import { WorkflowEditor } from "../components/WorkflowEditor";

function AgentModesWorkflowsIndexRouteView() {
  return <WorkflowEditor key="agent-modes-workflow-new" workflowId={null} />;
}

export const Route = createFileRoute("/agent-modes/workflows/")({
  component: AgentModesWorkflowsIndexRouteView,
});
