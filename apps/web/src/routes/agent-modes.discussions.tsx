import { Outlet } from "@tanstack/react-router";
import { createFileRoute } from "@tanstack/react-router";

function AgentModesDiscussionsRouteLayout() {
  return <Outlet />;
}

export const Route = createFileRoute("/agent-modes/discussions")({
  component: AgentModesDiscussionsRouteLayout,
});
