import { SettingsIcon, SquarePenIcon } from "lucide-react";
import { SidebarFooter, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { SidebarUpdatePill } from "./SidebarUpdatePill";

export function SidebarFooterNav(props: {
  onOpenAgentModes: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <>
      <SidebarFooter className="p-2">
        <SidebarUpdatePill />
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
              onClick={props.onOpenAgentModes}
            >
              <SquarePenIcon className="size-3.5" />
              <span className="text-xs">Agent Modes</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
              onClick={props.onOpenSettings}
            >
              <SettingsIcon className="size-3.5" />
              <span className="text-xs">Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
