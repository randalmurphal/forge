import { createFileRoute, Outlet } from "@tanstack/react-router";

function WorkflowEditorLayout() {
  return <Outlet />;
}

export const Route = createFileRoute("/workflow/editor")({
  component: WorkflowEditorLayout,
});
