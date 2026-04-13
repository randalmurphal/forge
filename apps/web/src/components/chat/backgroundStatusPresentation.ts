import {
  AlertCircleIcon,
  BoxIcon,
  CheckIcon,
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
  showLabel: boolean;
} {
  switch (status) {
    case "running":
      return {
        icon: LoaderIcon,
        className: "text-primary/80",
        showLabel: true,
      };
    case "completed":
      return {
        icon: CheckIcon,
        className: "rounded bg-emerald-500/10 px-1 py-px text-emerald-400/80",
        showLabel: false,
      };
    case "failed":
      return {
        icon: AlertCircleIcon,
        className: "text-destructive/80",
        showLabel: true,
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
