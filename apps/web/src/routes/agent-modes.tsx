import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

function AgentModesRouteLayout() {
  return <Outlet />;
}

export const Route = createFileRoute("/agent-modes")({
  beforeLoad: ({ location }) => {
    if (location.pathname === "/agent-modes") {
      throw redirect({ to: "/agent-modes/workflows", replace: true });
    }
  },
  component: AgentModesRouteLayout,
});
