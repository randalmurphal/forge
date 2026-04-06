import type { ReactNode } from "react";
import type { SidebarTreeVisibleNode } from "./SidebarTree.logic";

export function SidebarTree(props: {
  nodes: readonly SidebarTreeVisibleNode[];
  renderNode: (node: SidebarTreeVisibleNode) => ReactNode;
}) {
  return <>{props.nodes.map((node) => props.renderNode(node))}</>;
}
