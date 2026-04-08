import { createFileRoute } from "@tanstack/react-router";

import { DiscussionEditor } from "../components/DiscussionEditor";

function AgentModesDiscussionsIndexRouteView() {
  return <DiscussionEditor discussionName={null} discussionScope={null} projectId={null} />;
}

export const Route = createFileRoute("/agent-modes/discussions/")({
  component: AgentModesDiscussionsIndexRouteView,
});
