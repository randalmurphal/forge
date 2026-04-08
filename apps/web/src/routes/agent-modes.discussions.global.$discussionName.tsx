import { createFileRoute } from "@tanstack/react-router";

import { DiscussionEditor } from "../components/DiscussionEditor";

function AgentModesGlobalDiscussionDetailRouteView() {
  const discussionName = Route.useParams({
    select: (params) => params.discussionName,
  });

  return (
    <DiscussionEditor discussionName={discussionName} discussionScope="global" projectId={null} />
  );
}

export const Route = createFileRoute("/agent-modes/discussions/global/$discussionName")({
  component: AgentModesGlobalDiscussionDetailRouteView,
});
