import { ProjectId } from "@forgetools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { DiscussionEditor } from "../components/DiscussionEditor";

function AgentModesProjectDiscussionDetailRouteView() {
  const { discussionName, projectId } = Route.useParams({
    select: (params) => ({
      discussionName: params.discussionName,
      projectId: ProjectId.makeUnsafe(params.projectId),
    }),
  });

  return (
    <DiscussionEditor
      discussionName={discussionName}
      discussionScope="project"
      projectId={projectId}
    />
  );
}

export const Route = createFileRoute("/agent-modes/discussions/project/$projectId/$discussionName")(
  {
    component: AgentModesProjectDiscussionDetailRouteView,
  },
);
