import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

import { Button } from "./ui/button";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";

export type AgentModesTab = "workflows" | "discussions";

const TAB_TO_ROUTE = {
  discussions: "/agent-modes/discussions",
  workflows: "/agent-modes/workflows",
} as const;

export function AgentModesPage(props: { activeTab: AgentModesTab; children: ReactNode }) {
  const navigate = useNavigate();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col bg-background text-foreground">
        <header className="border-b border-border px-3 py-2 sm:px-5">
          <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3">
            <div className="flex items-center">
              <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            </div>
            <div className="flex justify-center">
              <div className="flex items-center gap-1 rounded-xl border border-border/70 bg-card/70 p-1">
                {(["workflows", "discussions"] as const).map((tab) => (
                  <Button
                    key={tab}
                    type="button"
                    size="sm"
                    variant={props.activeTab === tab ? "secondary" : "ghost"}
                    className="h-8 px-3 capitalize"
                    onClick={() => void navigate({ to: TAB_TO_ROUTE[tab] })}
                  >
                    {tab}
                  </Button>
                ))}
              </div>
            </div>
            <div />
          </div>
        </header>
        {props.children}
      </div>
    </SidebarInset>
  );
}
