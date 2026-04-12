import {
  AlertCircleIcon,
  BoxIcon,
  CheckCircle2Icon,
  EyeIcon,
  FolderSearchIcon,
  GlobeIcon,
  LoaderIcon,
  NetworkIcon,
  SquarePenIcon,
  TerminalIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";

import type { WorkLogEntry } from "../../session-logic";

type BackgroundTaskStatus = "running" | "completed" | "failed";

export function statusPresentation(status: BackgroundTaskStatus): {
  icon: LucideIcon;
  className: string;
} {
  switch (status) {
    case "running":
      return {
        icon: LoaderIcon,
        className: "text-primary/80",
      };
    case "completed":
      return {
        icon: CheckCircle2Icon,
        className: "text-success/80",
      };
    case "failed":
      return {
        icon: AlertCircleIcon,
        className: "text-destructive/80",
      };
  }
}

export function workEntryIcon(entry: WorkLogEntry): LucideIcon {
  switch (entry.itemType) {
    case "file_change":
      return SquarePenIcon;
    case "file_read":
      return EyeIcon;
    case "search":
      return FolderSearchIcon;
    case "mcp_tool_call":
      return NetworkIcon;
    case "web_search":
      return GlobeIcon;
    case "image_view":
      return EyeIcon;
    case "collab_agent_tool_call":
      return BoxIcon;
    case "dynamic_tool_call":
      return WrenchIcon;
    default:
      return TerminalIcon;
  }
}
