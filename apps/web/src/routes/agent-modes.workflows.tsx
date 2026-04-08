import { Outlet } from "@tanstack/react-router";
import { createFileRoute } from "@tanstack/react-router";

function AgentModesWorkflowsRouteLayout() {
  return <Outlet />;
}

export const Route = createFileRoute("/agent-modes/workflows")({
  component: AgentModesWorkflowsRouteLayout,
});
