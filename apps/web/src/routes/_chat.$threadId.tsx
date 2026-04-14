import { ThreadId } from "@forgetools/contracts";
import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, type ReactNode, useCallback, useEffect, useState } from "react";

import ChatView from "../components/ChatView";
import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import {
  DiffPanelHeaderSkeleton,
  DiffPanelLoadingState,
  DiffPanelShell,
  type DiffPanelMode,
} from "../components/DiffPanelShell";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  type DiffRouteSearch,
  parseDiffRouteSearch,
  stripDiffSearchParams,
} from "../diffRouteSearch";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useStore } from "../store";
import { useThreadById, useThreadDesign } from "../storeSelectors";
import { Sheet, SheetPopup } from "../components/ui/sheet";
import { Sidebar, SidebarInset, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";

const DiffPanel = lazy(() => import("../components/DiffPanel"));
const DesignPreviewPanel = lazy(() => import("../components/DesignPreviewPanel"));
const DIFF_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 1180px)";
const DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_diff_sidebar_width";
const DIFF_INLINE_DEFAULT_WIDTH = "clamp(28rem,48vw,44rem)";
const DIFF_INLINE_SIDEBAR_MIN_WIDTH = 26 * 16;
const DESIGN_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_design_sidebar_width";
const DESIGN_INLINE_DEFAULT_WIDTH = "clamp(28rem,48vw,44rem)";
const DESIGN_INLINE_SIDEBAR_MIN_WIDTH = 26 * 16;
const COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX = 208;

/**
 * Shared resize-guard for inline sidebar panels (diff, design preview).
 * Returns false when the proposed sidebar width would cause composer overflow
 * or violate minimum composer width constraints.
 */
function shouldAcceptInlineSidebarWidth({
  nextWidth,
  wrapper,
}: {
  nextWidth: number;
  wrapper: HTMLElement;
}): boolean {
  const composerForm = document.querySelector<HTMLElement>("[data-chat-composer-form='true']");
  if (!composerForm) return true;
  const composerViewport = composerForm.parentElement;
  if (!composerViewport) return true;
  const previousSidebarWidth = wrapper.style.getPropertyValue("--sidebar-width");
  wrapper.style.setProperty("--sidebar-width", `${nextWidth}px`);

  const viewportStyle = window.getComputedStyle(composerViewport);
  const viewportPaddingLeft = Number.parseFloat(viewportStyle.paddingLeft) || 0;
  const viewportPaddingRight = Number.parseFloat(viewportStyle.paddingRight) || 0;
  const viewportContentWidth = Math.max(
    0,
    composerViewport.clientWidth - viewportPaddingLeft - viewportPaddingRight,
  );
  const formRect = composerForm.getBoundingClientRect();
  const composerFooter = composerForm.querySelector<HTMLElement>(
    "[data-chat-composer-footer='true']",
  );
  const composerRightActions = composerForm.querySelector<HTMLElement>(
    "[data-chat-composer-actions='right']",
  );
  const composerRightActionsWidth = composerRightActions?.getBoundingClientRect().width ?? 0;
  const composerFooterGap = composerFooter
    ? Number.parseFloat(window.getComputedStyle(composerFooter).columnGap) ||
      Number.parseFloat(window.getComputedStyle(composerFooter).gap) ||
      0
    : 0;
  const minimumComposerWidth =
    COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX + composerRightActionsWidth + composerFooterGap;
  const hasComposerOverflow = composerForm.scrollWidth > composerForm.clientWidth + 0.5;
  const overflowsViewport = formRect.width > viewportContentWidth + 0.5;
  const violatesMinimumComposerWidth = composerForm.clientWidth + 0.5 < minimumComposerWidth;

  if (previousSidebarWidth.length > 0) {
    wrapper.style.setProperty("--sidebar-width", previousSidebarWidth);
  } else {
    wrapper.style.removeProperty("--sidebar-width");
  }

  return !hasComposerOverflow && !overflowsViewport && !violatesMinimumComposerWidth;
}

const DiffPanelSheet = (props: {
  children: ReactNode;
  diffOpen: boolean;
  onCloseDiff: () => void;
}) => {
  return (
    <Sheet
      open={props.diffOpen}
      onOpenChange={(open) => {
        if (!open) {
          props.onCloseDiff();
        }
      }}
    >
      <SheetPopup
        side="right"
        showCloseButton={false}
        keepMounted
        className="w-[min(88vw,820px)] max-w-[820px] p-0"
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
};

const DiffLoadingFallback = (props: { mode: DiffPanelMode }) => {
  return (
    <DiffPanelShell mode={props.mode} header={<DiffPanelHeaderSkeleton />}>
      <DiffPanelLoadingState label="Loading diff viewer..." />
    </DiffPanelShell>
  );
};

const LazyDiffPanel = (props: { mode: DiffPanelMode }) => {
  return (
    <DiffWorkerPoolProvider>
      <Suspense fallback={<DiffLoadingFallback mode={props.mode} />}>
        <DiffPanel mode={props.mode} />
      </Suspense>
    </DiffWorkerPoolProvider>
  );
};

const DiffPanelInlineSidebar = (props: {
  diffOpen: boolean;
  onCloseDiff: () => void;
  onOpenDiff: () => void;
  renderDiffContent: boolean;
}) => {
  const { diffOpen, onCloseDiff, onOpenDiff, renderDiffContent } = props;
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        onOpenDiff();
        return;
      }
      onCloseDiff();
    },
    [onCloseDiff, onOpenDiff],
  );

  return (
    <SidebarProvider
      defaultOpen={false}
      open={diffOpen}
      onOpenChange={onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent"
      style={{ "--sidebar-width": DIFF_INLINE_DEFAULT_WIDTH } as React.CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          minWidth: DIFF_INLINE_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: shouldAcceptInlineSidebarWidth,
          storageKey: DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        {renderDiffContent ? <LazyDiffPanel mode="sidebar" /> : null}
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
};

const LazyDesignPreviewPanel = (props: { mode: DiffPanelMode; threadId: ThreadId }) => {
  return (
    <Suspense
      fallback={
        <DiffPanelShell mode={props.mode} header={<DiffPanelHeaderSkeleton />}>
          <DiffPanelLoadingState label="Loading design preview..." />
        </DiffPanelShell>
      }
    >
      <DesignPreviewPanel mode={props.mode} threadId={props.threadId} />
    </Suspense>
  );
};

const DesignPreviewInlineSidebar = (props: {
  threadId: ThreadId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  renderContent: boolean;
}) => {
  const { threadId, open, onOpenChange, renderContent } = props;

  return (
    <SidebarProvider
      defaultOpen={false}
      open={open}
      onOpenChange={onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent"
      style={{ "--sidebar-width": DESIGN_INLINE_DEFAULT_WIDTH } as React.CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          minWidth: DESIGN_INLINE_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: shouldAcceptInlineSidebarWidth,
          storageKey: DESIGN_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        {renderContent ? <LazyDesignPreviewPanel mode="sidebar" threadId={threadId} /> : null}
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
};

const DesignPreviewSheet = (props: { children: ReactNode; open: boolean; onClose: () => void }) => {
  return (
    <Sheet
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <SheetPopup
        side="right"
        showCloseButton={false}
        keepMounted
        className="w-[min(88vw,820px)] max-w-[820px] p-0"
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
};

function ChatThreadRouteView() {
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const navigate = useNavigate();
  const threadId = Route.useParams({
    select: (params) => ThreadId.makeUnsafe(params.threadId),
  });
  const search = Route.useSearch();
  const threadExists = useStore((store) => store.threads.some((thread) => thread.id === threadId));
  const draftThreadExists = useComposerDraftStore((store) =>
    Object.hasOwn(store.draftThreadsByThreadId, threadId),
  );
  const routeThreadExists = threadExists || draftThreadExists;
  const diffOpen = search.diff === "1";
  const shouldUseDiffSheet = useMediaQuery(DIFF_INLINE_LAYOUT_MEDIA_QUERY);

  // Read thread to determine interaction mode and design artifact availability
  const thread = useThreadById(threadId);
  const threadDesignSlice = useThreadDesign(threadId);
  const isDesignMode = thread?.interactionMode === "design";
  const hasDesignArtifacts =
    isDesignMode &&
    ((threadDesignSlice?.designArtifacts?.length ?? 0) > 0 ||
      (threadDesignSlice?.designPendingOptions !== null &&
        threadDesignSlice?.designPendingOptions !== undefined));

  const designPanelOpen = search.designPanel === "1";
  const toggleDesignPanel = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return designPanelOpen
          ? { ...rest, designPanel: undefined }
          : { ...rest, designPanel: "1" };
      },
    });
  }, [designPanelOpen, navigate, threadId]);
  // Auto-open the design panel when first artifacts arrive
  const [hasAutoOpened, setHasAutoOpened] = useState(false);
  useEffect(() => {
    if (hasDesignArtifacts && !designPanelOpen && !hasAutoOpened) {
      setHasAutoOpened(true);
      void navigate({
        to: "/$threadId",
        params: { threadId },
        replace: true,
        search: (previous) => ({ ...previous, designPanel: "1" }),
      });
    }
  }, [hasDesignArtifacts, designPanelOpen, hasAutoOpened, navigate, threadId]);

  // TanStack Router keeps active route components mounted across param-only navigations
  // unless remountDeps are configured, so this stays warm across thread switches.
  const [hasOpenedDiff, setHasOpenedDiff] = useState(diffOpen);
  const closeDiff = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: { diff: undefined },
    });
  }, [navigate, threadId]);
  const openDiff = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1" };
      },
    });
  }, [navigate, threadId]);

  useEffect(() => {
    if (diffOpen) {
      setHasOpenedDiff(true);
    }
  }, [diffOpen]);

  useEffect(() => {
    if (!bootstrapComplete) {
      return;
    }

    if (!routeThreadExists) {
      void navigate({ to: "/", replace: true });
      return;
    }
  }, [bootstrapComplete, navigate, routeThreadExists, threadId]);

  if (!bootstrapComplete || !routeThreadExists) {
    return null;
  }

  const shouldRenderDiffContent = diffOpen || hasOpenedDiff;

  const hasOpenedDesignPanel = designPanelOpen || hasAutoOpened;

  // Design mode: show design preview panel instead of diff panel
  if (isDesignMode) {
    if (!shouldUseDiffSheet) {
      return (
        <>
          <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
            <ChatView threadId={threadId} />
          </SidebarInset>
          <DesignPreviewInlineSidebar
            threadId={threadId}
            open={designPanelOpen}
            onOpenChange={() => toggleDesignPanel()}
            renderContent={hasOpenedDesignPanel}
          />
        </>
      );
    }

    return (
      <>
        <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
          <ChatView threadId={threadId} />
        </SidebarInset>
        <DesignPreviewSheet open={designPanelOpen} onClose={toggleDesignPanel}>
          {hasOpenedDesignPanel ? (
            <LazyDesignPreviewPanel mode="sheet" threadId={threadId} />
          ) : null}
        </DesignPreviewSheet>
      </>
    );
  }

  // Default mode: show diff panel
  if (!shouldUseDiffSheet) {
    return (
      <>
        <SidebarInset className="h-dvh  min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
          <ChatView threadId={threadId} />
        </SidebarInset>
        <DiffPanelInlineSidebar
          diffOpen={diffOpen}
          onCloseDiff={closeDiff}
          onOpenDiff={openDiff}
          renderDiffContent={shouldRenderDiffContent}
        />
      </>
    );
  }

  return (
    <>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <ChatView threadId={threadId} />
      </SidebarInset>
      <DiffPanelSheet diffOpen={diffOpen} onCloseDiff={closeDiff}>
        {shouldRenderDiffContent ? <LazyDiffPanel mode="sheet" /> : null}
      </DiffPanelSheet>
    </>
  );
}

export const Route = createFileRoute("/_chat/$threadId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  search: {
    middlewares: [retainSearchParams<DiffRouteSearch>(["diff", "diffMode", "designPanel"])],
  },
  component: ChatThreadRouteView,
});
