import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ThreadId, type TurnId } from "@forgetools/contracts";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns2Icon,
  Rows3Icon,
  TextWrapIcon,
} from "lucide-react";
import {
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { openInPreferredEditor } from "../editorPreferences";
import { gitStatusQueryOptions, gitWorkingTreeDiffQueryOptions } from "~/lib/gitReactQuery";
import { agentDiffQueryOptions, checkpointDiffQueryOptions } from "~/lib/providerReactQuery";
import { cn } from "~/lib/utils";
import { readNativeApi } from "../nativeApi";
import { resolvePathLinkTarget } from "../terminal-links";
import { parseDiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import { useTheme } from "../hooks/useTheme";
import {
  buildPatchCacheKey,
  classifyDiffComplexity,
  getDiffLoadingLabel,
  getRenderablePatch,
  resolveFileDiffPath,
  shouldDefaultCollapseDiffFiles,
  shouldDeferDiffRendering,
  summarizeDiffFileSummaries,
  summarizeFileDiff,
} from "../lib/diffRendering";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useStore } from "../store";
import { useSettings } from "../hooks/useSettings";
import { formatShortTimestamp } from "../timestampFormat";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { ToggleGroup, Toggle } from "./ui/toggle-group";
import { Button } from "./ui/button";
import { CollapsibleFileDiffList } from "./CollapsibleFileDiffList";

type DiffRenderMode = "stacked" | "split";
interface DiffPanelProps {
  mode?: DiffPanelMode;
}

function DiffTotalsLabel(props: { files: number; additions: number; deletions: number }) {
  return (
    <div className="flex items-center gap-2 text-[11px] font-medium">
      <span className="text-muted-foreground/75">
        {props.files} file{props.files === 1 ? "" : "s"}
      </span>
      <span className="text-emerald-500/85">+{props.additions}</span>
      <span className="text-red-500/80">-{props.deletions}</span>
    </div>
  );
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function DiffPanel({ mode = "inline" }: DiffPanelProps) {
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const settings = useSettings();
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("stacked");
  const [diffWordWrap, setDiffWordWrap] = useState(settings.diffWordWrap);
  const patchViewportRef = useRef<HTMLDivElement>(null);
  const turnStripRef = useRef<HTMLDivElement>(null);
  const previousDiffOpenRef = useRef(false);
  const [canScrollTurnStripLeft, setCanScrollTurnStripLeft] = useState(false);
  const [canScrollTurnStripRight, setCanScrollTurnStripRight] = useState(false);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const diffSearch = useSearch({ strict: false, select: (search) => parseDiffRouteSearch(search) });
  const diffOpen = diffSearch.diff === "1";
  const diffMode = diffSearch.diffMode ?? "agent";
  const activeThreadId = routeThreadId;
  const activeThread = useStore((store) =>
    activeThreadId ? store.threads.find((thread) => thread.id === activeThreadId) : undefined,
  );
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useStore((store) =>
    activeProjectId ? store.projects.find((project) => project.id === activeProjectId) : undefined,
  );
  const activeCwd = activeThread?.worktreePath ?? activeProject?.cwd;
  const gitStatusQuery = useQuery(gitStatusQueryOptions(activeCwd ?? null));
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const { inferredCheckpointTurnCountByTurnId } = useTurnDiffSummaries(activeThread);
  const orderedAgentDiffSummaries = useMemo(
    () =>
      [...(activeThread?.agentDiffSummaries ?? [])].toSorted((left, right) => {
        const leftTurnCount =
          left.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[left.turnId] ?? 0;
        const rightTurnCount =
          right.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[right.turnId] ?? 0;
        if (leftTurnCount !== rightTurnCount) {
          return rightTurnCount - leftTurnCount;
        }
        return right.completedAt.localeCompare(left.completedAt);
      }),
    [activeThread?.agentDiffSummaries, inferredCheckpointTurnCountByTurnId],
  );

  const selectedTurnId = diffMode === "agent" ? (diffSearch.diffTurnId ?? null) : null;
  const selectedFilePath =
    diffMode === "agent" && selectedTurnId !== null ? (diffSearch.diffFilePath ?? null) : null;
  const selectedTurn =
    selectedTurnId === null
      ? undefined
      : (orderedAgentDiffSummaries.find((summary) => summary.turnId === selectedTurnId) ??
        orderedAgentDiffSummaries[0]);
  const selectedCheckpointTurnCount =
    selectedTurn &&
    (selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[selectedTurn.turnId]);
  const selectedCheckpointRange = useMemo(
    () =>
      typeof selectedCheckpointTurnCount === "number"
        ? {
            fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
            toTurnCount: selectedCheckpointTurnCount,
          }
        : null,
    [selectedCheckpointTurnCount],
  );
  const conversationAgentCacheScope = useMemo(() => {
    if (selectedTurn || orderedAgentDiffSummaries.length === 0) {
      return null;
    }
    return `conversation:${orderedAgentDiffSummaries.map((summary) => summary.turnId).join(",")}`;
  }, [orderedAgentDiffSummaries, selectedTurn]);
  const activeAgentDiffQuery = useQuery(
    agentDiffQueryOptions({
      threadId: activeThreadId,
      turnId: selectedTurn?.turnId ?? null,
      cacheScope: selectedTurn ? `turn:${selectedTurn.turnId}` : conversationAgentCacheScope,
      enabled: diffMode === "agent",
    }),
  );
  const selectedAgentCoverage = selectedTurn
    ? (activeAgentDiffQuery.data?.coverage ?? "unavailable")
    : undefined;
  // Only single-turn agent diffs fall back to checkpoint/workspace snapshots.
  // Whole-thread mode keeps the agent-composed view so we do not splice together
  // incompatible sources from different turns.
  const showWorkspaceFallback =
    diffMode === "agent" &&
    !!selectedTurn &&
    selectedAgentCoverage === "unavailable" &&
    !!selectedCheckpointRange;
  const selectedTurnCheckpointDiffQuery = useQuery(
    checkpointDiffQueryOptions({
      threadId: activeThreadId,
      fromTurnCount: selectedCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: selectedCheckpointRange?.toTurnCount ?? null,
      cacheScope: selectedTurn ? `turn:${selectedTurn.turnId}` : null,
      enabled: isGitRepo && showWorkspaceFallback,
    }),
  );
  const workspaceSourceStats = useMemo(() => {
    if (!gitStatusQuery.data) return null;
    return {
      files: gitStatusQuery.data.workingTree.files.length,
      additions: gitStatusQuery.data.workingTree.insertions,
      deletions: gitStatusQuery.data.workingTree.deletions,
    };
  }, [gitStatusQuery.data]);
  const agentSourceStats = useMemo(() => {
    if (selectedTurn) {
      return summarizeDiffFileSummaries(selectedTurn.files);
    }

    if (activeAgentDiffQuery.data) {
      return summarizeDiffFileSummaries(activeAgentDiffQuery.data.files);
    }

    return null;
  }, [activeAgentDiffQuery.data, selectedTurn]);
  const sourceStats = diffMode === "workspace" ? workspaceSourceStats : agentSourceStats;
  const sourceDiffComplexity = classifyDiffComplexity({
    files: sourceStats?.files ?? 0,
    additions: sourceStats?.additions ?? 0,
    deletions: sourceStats?.deletions ?? 0,
  });
  const shouldUseLiveWorkspaceRefresh =
    diffMode === "workspace" && sourceDiffComplexity === "normal";
  const workspaceDiffQuery = useQuery(
    gitWorkingTreeDiffQueryOptions(activeCwd ?? null, {
      enabled: diffMode === "workspace" && isGitRepo,
      live: shouldUseLiveWorkspaceRefresh,
    }),
  );
  const selectedPatch =
    diffMode === "workspace"
      ? workspaceDiffQuery.data?.diff
      : showWorkspaceFallback
        ? selectedTurnCheckpointDiffQuery.data?.diff
        : selectedTurn
          ? activeAgentDiffQuery.data?.diff
          : activeAgentDiffQuery.data?.diff;
  const selectedPatchIdentity = useMemo(
    () =>
      typeof selectedPatch === "string"
        ? buildPatchCacheKey(selectedPatch, `selection:${diffMode}`)
        : "pending",
    [diffMode, selectedPatch],
  );
  const activeDiffIdentity = `${activeThreadId ?? "none"}:${diffMode}:${selectedTurn?.turnId ?? "all"}:${showWorkspaceFallback ? "fallback" : "direct"}:${selectedPatchIdentity}`;
  const [deferredDiffRenderKey, setDeferredDiffRenderKey] = useState<string | null>(null);
  useEffect(() => {
    setDeferredDiffRenderKey(null);
  }, [activeDiffIdentity]);
  const diffComplexity = classifyDiffComplexity({
    files: sourceStats?.files ?? 0,
    additions: sourceStats?.additions ?? 0,
    deletions: sourceStats?.deletions ?? 0,
    ...(typeof selectedPatch === "string" ? { patchChars: selectedPatch.length } : {}),
  });
  const isLoadingPatch =
    diffMode === "workspace"
      ? workspaceDiffQuery.isLoading
      : showWorkspaceFallback
        ? selectedTurnCheckpointDiffQuery.isLoading
        : activeAgentDiffQuery.isLoading;
  const patchError =
    diffMode === "workspace"
      ? workspaceDiffQuery.error instanceof Error
        ? workspaceDiffQuery.error.message
        : workspaceDiffQuery.error
          ? "Failed to load workspace diff."
          : null
      : showWorkspaceFallback
        ? selectedTurnCheckpointDiffQuery.error instanceof Error
          ? selectedTurnCheckpointDiffQuery.error.message
          : selectedTurnCheckpointDiffQuery.error
            ? "Failed to load workspace fallback diff."
            : null
        : activeAgentDiffQuery.error instanceof Error
          ? activeAgentDiffQuery.error.message
          : activeAgentDiffQuery.error
            ? "Failed to load agent diff."
            : null;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
  const isWholeThreadNetDiffUnavailable =
    diffMode === "agent" &&
    selectedTurn === undefined &&
    activeAgentDiffQuery.data?.coverage === "unavailable";
  const showDeferredRenderCard =
    shouldDeferDiffRendering(diffComplexity) && deferredDiffRenderKey !== activeDiffIdentity;
  const renderablePatch = useMemo(
    () =>
      showDeferredRenderCard
        ? null
        : getRenderablePatch(selectedPatch, `diff-panel:${resolvedTheme}`),
    [resolvedTheme, selectedPatch, showDeferredRenderCard],
  );
  const renderableFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return renderablePatch.files.toSorted((left, right) =>
      resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }, [renderablePatch]);
  const viewDiffTotals = useMemo(() => {
    if (renderableFiles.length > 0) {
      return renderableFiles.reduce(
        (totals, file) => {
          const stats = summarizeFileDiff(file);
          return {
            files: totals.files + 1,
            additions: totals.additions + stats.additions,
            deletions: totals.deletions + stats.deletions,
          };
        },
        { files: 0, additions: 0, deletions: 0 },
      );
    }

    if (sourceStats) {
      return {
        files: sourceStats.files,
        additions: sourceStats.additions,
        deletions: sourceStats.deletions,
      };
    }

    if (hasNoNetChanges) {
      return { files: 0, additions: 0, deletions: 0 };
    }

    return null;
  }, [hasNoNetChanges, renderableFiles, sourceStats]);

  useEffect(() => {
    if (diffOpen && !previousDiffOpenRef.current) {
      setDiffWordWrap(settings.diffWordWrap);
    }
    previousDiffOpenRef.current = diffOpen;
  }, [diffOpen, settings.diffWordWrap]);

  useEffect(() => {
    if (!selectedFilePath || !patchViewportRef.current) {
      return;
    }
    const target = Array.from(
      patchViewportRef.current.querySelectorAll<HTMLElement>("[data-diff-file-path]"),
    ).find((element) => element.dataset.diffFilePath === selectedFilePath);
    target?.scrollIntoView({ block: "nearest" });
  }, [selectedFilePath, renderableFiles]);

  const openDiffFileInEditor = useCallback(
    (filePath: string) => {
      const api = readNativeApi();
      if (!api) return;
      const targetPath = activeCwd ? resolvePathLinkTarget(filePath, activeCwd) : filePath;
      void openInPreferredEditor(api, targetPath).catch((error) => {
        console.warn("Failed to open diff file in editor.", error);
      });
    },
    [activeCwd],
  );

  const selectTurn = (turnId: TurnId) => {
    if (!activeThread) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: activeThread.id },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1", diffMode: "agent", diffTurnId: turnId };
      },
    });
  };
  const selectWholeConversation = () => {
    if (!activeThread) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: activeThread.id },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1", diffMode: "agent" };
      },
    });
  };
  const selectDiffMode = (nextMode: "agent" | "workspace") => {
    if (!activeThread) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: activeThread.id },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return nextMode === "workspace"
          ? { ...rest, diff: "1", diffMode: "workspace" }
          : { ...rest, diff: "1", diffMode: "agent" };
      },
    });
  };
  const updateTurnStripScrollState = useCallback(() => {
    const element = turnStripRef.current;
    if (!element) {
      setCanScrollTurnStripLeft(false);
      setCanScrollTurnStripRight(false);
      return;
    }

    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    setCanScrollTurnStripLeft(element.scrollLeft > 4);
    setCanScrollTurnStripRight(element.scrollLeft < maxScrollLeft - 4);
  }, []);
  const scrollTurnStripBy = useCallback((offset: number) => {
    const element = turnStripRef.current;
    if (!element) return;
    element.scrollBy({ left: offset, behavior: "smooth" });
  }, []);
  const onTurnStripWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const element = turnStripRef.current;
    if (!element) return;
    if (element.scrollWidth <= element.clientWidth + 1) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

    event.preventDefault();
    element.scrollBy({ left: event.deltaY, behavior: "auto" });
  }, []);

  useEffect(() => {
    const element = turnStripRef.current;
    if (!element) return;

    const frameId = window.requestAnimationFrame(() => updateTurnStripScrollState());
    const onScroll = () => updateTurnStripScrollState();

    element.addEventListener("scroll", onScroll, { passive: true });

    const resizeObserver = new ResizeObserver(() => updateTurnStripScrollState());
    resizeObserver.observe(element);

    return () => {
      window.cancelAnimationFrame(frameId);
      element.removeEventListener("scroll", onScroll);
      resizeObserver.disconnect();
    };
  }, [updateTurnStripScrollState]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => updateTurnStripScrollState());
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [orderedAgentDiffSummaries, selectedTurnId, updateTurnStripScrollState]);

  useEffect(() => {
    const element = turnStripRef.current;
    if (!element) return;

    const selectedChip = element.querySelector<HTMLElement>("[data-turn-chip-selected='true']");
    selectedChip?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [selectedTurn?.turnId, selectedTurnId]);

  const headerRow = (
    <div className="flex min-w-0 flex-1 flex-col gap-2 [-webkit-app-region:no-drag]">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <div className="flex min-w-0 items-center">
          {viewDiffTotals ? <DiffTotalsLabel {...viewDiffTotals} /> : null}
        </div>
        <div className="flex justify-center">
          <ToggleGroup
            className="shrink-0"
            variant="outline"
            size="sm"
            value={[diffMode]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "agent" || next === "workspace") {
                selectDiffMode(next);
              }
            }}
          >
            <Toggle aria-label="Agent diff mode" value="agent" className="min-w-16 px-4">
              Agent
            </Toggle>
            <Toggle
              aria-label="Full workspace diff mode"
              value="workspace"
              className="min-w-14 px-4"
            >
              Full
            </Toggle>
          </ToggleGroup>
        </div>
        <div className="flex justify-end gap-1">
          {diffMode === "workspace" && !shouldUseLiveWorkspaceRefresh ? (
            <Button size="xs" variant="outline" onClick={() => void workspaceDiffQuery.refetch()}>
              Refresh
            </Button>
          ) : null}
          <ToggleGroup
            className="shrink-0"
            variant="outline"
            size="xs"
            value={[diffRenderMode]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "stacked" || next === "split") {
                setDiffRenderMode(next);
              }
            }}
          >
            <Toggle aria-label="Stacked diff view" value="stacked">
              <Rows3Icon className="size-3" />
            </Toggle>
            <Toggle aria-label="Split diff view" value="split">
              <Columns2Icon className="size-3" />
            </Toggle>
          </ToggleGroup>
          <Toggle
            aria-label={diffWordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
            title={diffWordWrap ? "Disable line wrapping" : "Enable line wrapping"}
            variant="outline"
            size="xs"
            pressed={diffWordWrap}
            onPressedChange={(pressed) => {
              setDiffWordWrap(Boolean(pressed));
            }}
          >
            <TextWrapIcon className="size-3" />
          </Toggle>
        </div>
      </div>
      <div className="relative min-w-0 flex-1">
        {diffMode === "agent" ? (
          <div>
            {canScrollTurnStripLeft && (
              <div className="pointer-events-none absolute inset-y-0 left-8 z-10 w-7 bg-linear-to-r from-card to-transparent" />
            )}
            {canScrollTurnStripRight && (
              <div className="pointer-events-none absolute inset-y-0 right-8 z-10 w-7 bg-linear-to-l from-card to-transparent" />
            )}
            <button
              type="button"
              className={cn(
                "absolute left-0 top-1/2 z-20 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md border bg-background/90 text-muted-foreground transition-colors",
                canScrollTurnStripLeft
                  ? "border-border/70 hover:border-border hover:text-foreground"
                  : "cursor-not-allowed border-border/40 text-muted-foreground/40",
              )}
              onClick={() => scrollTurnStripBy(-180)}
              disabled={!canScrollTurnStripLeft}
              aria-label="Scroll turn list left"
            >
              <ChevronLeftIcon className="size-3.5" />
            </button>
            <button
              type="button"
              className={cn(
                "absolute right-0 top-1/2 z-20 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md border bg-background/90 text-muted-foreground transition-colors",
                canScrollTurnStripRight
                  ? "border-border/70 hover:border-border hover:text-foreground"
                  : "cursor-not-allowed border-border/40 text-muted-foreground/40",
              )}
              onClick={() => scrollTurnStripBy(180)}
              disabled={!canScrollTurnStripRight}
              aria-label="Scroll turn list right"
            >
              <ChevronRightIcon className="size-3.5" />
            </button>
            <div
              ref={turnStripRef}
              className="turn-chip-strip flex gap-1 overflow-x-auto px-8 py-0.5"
              onWheel={onTurnStripWheel}
            >
              <button
                type="button"
                className="shrink-0 rounded-md"
                onClick={selectWholeConversation}
                data-turn-chip-selected={selectedTurnId === null}
              >
                <div
                  className={cn(
                    "rounded-md border px-2 py-1 text-left transition-colors",
                    selectedTurnId === null
                      ? "border-border bg-accent text-accent-foreground"
                      : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
                  )}
                >
                  <div className="text-[10px] leading-tight font-medium">All turns</div>
                </div>
              </button>
              {orderedAgentDiffSummaries.map((summary) => (
                <button
                  key={summary.turnId}
                  type="button"
                  className="shrink-0 rounded-md"
                  onClick={() => selectTurn(summary.turnId)}
                  title={summary.turnId}
                  data-turn-chip-selected={summary.turnId === selectedTurn?.turnId}
                >
                  <div
                    className={cn(
                      "rounded-md border px-2 py-1 text-left transition-colors",
                      summary.turnId === selectedTurn?.turnId
                        ? "border-border bg-accent text-accent-foreground"
                        : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
                    )}
                  >
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] leading-tight font-medium">
                        Turn{" "}
                        {summary.checkpointTurnCount ??
                          inferredCheckpointTurnCountByTurnId[summary.turnId] ??
                          "?"}
                      </span>
                      <span className="text-[9px] leading-tight opacity-70">
                        {formatShortTimestamp(summary.completedAt, settings.timestampFormat)}
                      </span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect diffs.
        </div>
      ) : !isGitRepo ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Diffs are unavailable because this project is not a git repository.
        </div>
      ) : diffMode === "agent" && orderedAgentDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          No agent-attributed diffs are available yet.
        </div>
      ) : (
        <>
          <div
            ref={patchViewportRef}
            className="diff-panel-viewport min-h-0 min-w-0 flex-1 overflow-hidden"
          >
            {showWorkspaceFallback && (
              <div className="px-3 pt-2">
                <p className="mb-2 text-[11px] text-muted-foreground/75">
                  Agent attribution is unavailable for this turn. Showing workspace changes during
                  the turn instead.
                </p>
              </div>
            )}
            {patchError && !renderablePatch && (
              <div className="px-3">
                <p className="mb-2 text-[11px] text-red-500/80">{patchError}</p>
              </div>
            )}
            {!renderablePatch ? (
              showDeferredRenderCard ? (
                <div className="flex h-full items-center justify-center px-4 py-3">
                  <div className="w-full max-w-sm rounded-lg border border-border/70 bg-card/50 p-4">
                    <p className="text-sm font-medium text-foreground/90">This diff is huge.</p>
                    <p className="mt-1 text-[11px] text-muted-foreground/70">
                      Rich rendering is deferred to keep the UI responsive.
                    </p>
                    {viewDiffTotals ? (
                      <div className="mt-3">
                        <DiffTotalsLabel {...viewDiffTotals} />
                      </div>
                    ) : null}
                    <div className="mt-4 flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setDeferredDiffRenderKey(activeDiffIdentity)}
                      >
                        Render diff
                      </Button>
                      {diffMode === "workspace" && !shouldUseLiveWorkspaceRefresh ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void workspaceDiffQuery.refetch()}
                        >
                          Refresh
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : isLoadingPatch ? (
                <DiffPanelLoadingState
                  label={getDiffLoadingLabel(
                    diffMode === "workspace"
                      ? "Loading workspace diff..."
                      : showWorkspaceFallback
                        ? "Loading workspace fallback diff..."
                        : "Loading agent diff...",
                    diffComplexity,
                  )}
                />
              ) : (
                <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
                  <p>
                    {isWholeThreadNetDiffUnavailable
                      ? "No net diff available for this agent yet."
                      : hasNoNetChanges
                        ? diffMode === "workspace"
                          ? "Working tree is clean."
                          : "No net changes in this selection."
                        : "No patch available for this selection."}
                  </p>
                </div>
              )
            ) : renderablePatch.kind === "files" ? (
              <CollapsibleFileDiffList
                files={renderableFiles}
                resolvedTheme={resolvedTheme}
                diffRenderMode={diffRenderMode}
                diffWordWrap={diffWordWrap}
                selectedFilePath={selectedFilePath}
                onOpenFile={openDiffFileInEditor}
                virtualized={true}
                className="diff-render-surface"
                defaultExpandMode={
                  shouldDefaultCollapseDiffFiles(diffComplexity) ? "selected-only" : "all"
                }
                confirmExpandAll={diffComplexity !== "normal"}
              />
            ) : (
              <div className="h-full overflow-auto p-2">
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground/75">{renderablePatch.reason}</p>
                  <pre
                    className={cn(
                      "max-h-[72vh] rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90",
                      diffWordWrap
                        ? "overflow-auto whitespace-pre-wrap wrap-break-word"
                        : "overflow-auto",
                    )}
                  >
                    {renderablePatch.text}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </DiffPanelShell>
  );
}
