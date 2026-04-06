# Frontend Loop -- Progress Tracker

## Status: IN PROGRESS

## Codebase Patterns

- Frontend query layers can call `getWsRpcClient()` directly when websocket RPC methods exist but `NativeApi` has not exposed them yet.
- New Zustand stores should keep flat state and export pure state transition helpers so most tests stay in fast node-side unit tests.
- React Query hooks should stay thin: fetch a contract-backed payload slice, then mirror successful data into the relevant Zustand store from `useEffect`.

## Known Issues

(Issues found during review phase. Highest severity first.)

## Resolved Issues

(Issues moved here after being fixed and committed.)

## Completed Work Items

- WI-1: Workflow store
- WI-2: Channel store
- WI-3: Sidebar tree -- parent/child hierarchy
- WI-4: Workflow picker in thread creation
- WI-5: Workflow timeline view
- WI-6: Channel view

## Iteration Log

- 2026-04-06: Completed WI-1 by adding `apps/web/src/stores/workflowStore.ts` with workflow list/detail query hooks, flat editing/selection Zustand state, and workflow cache helpers. Extended `apps/web/src/wsRpcClient.ts` with workflow RPC methods needed by the frontend. Added `apps/web/src/stores/workflowStore.test.ts`. Validation passed: `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
- 2026-04-06: Completed WI-2 by adding `apps/web/src/stores/channelStore.ts` with flat channel/message cache state, derived deliberation state, pagination/subscription helpers, and React Query hooks for channel detail/message pages. Extended `apps/web/src/wsRpcClient.ts` with channel fetch and push subscription methods used by the store. Added `apps/web/src/stores/channelStore.test.ts`. Validation passed: `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
- 2026-04-06: Completed WI-3 by adding `apps/web/src/components/SidebarTree.logic.ts` and `apps/web/src/components/SidebarTree.tsx`, extending sidebar/store thread metadata for parent-child hierarchy rendering, and covering tree derivation in `apps/web/src/components/SidebarTree.logic.test.ts`. Sidebar thread rows now support bounded depth-two expansion, child metadata, propagated parent status, and priority sorting for needs-attention, running, paused, and completed threads. Validation passed: `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
- 2026-04-06: Completed WI-4 by adding `apps/web/src/components/WorkflowPicker.tsx` plus `WorkflowPicker.logic.ts`/`.test.ts`, threading `workflowId` through persisted draft-thread state and local draft projection, and forwarding the selected workflow through the first-send `thread.create` path. Added store/browser coverage in `composerDraftStore.test.ts`, `ChatView.logic.test.ts`, and `ChatView.browser.tsx`. Validation passed: `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`. Non-built-in workflows currently share one alphabetical bucket after built-ins because the current `WorkflowSummary` contract only exposes `builtIn`, not project scope.
- 2026-04-06: Completed WI-5 by adding `apps/web/src/components/WorkflowTimeline.tsx` plus `WorkflowTimeline.logic.ts`/`.test.ts`, extending `apps/web/src/wsRpcClient.ts` with `phaseRun` and `phaseOutput` RPC helpers, and dispatching workflow container threads to the timeline from `apps/web/src/routes/_chat.$threadId.tsx` while leaving `ChatView.tsx` unchanged for plain threads. The timeline now renders schema summaries, channel transcripts, conversation outputs, inline quality-check sections, and expandable child-session transcripts with active phase streaming. Validation passed: `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`. The route implementation uses the existing canonical `/$threadId` entrypoint because adding a separate `_workflow.$threadId` pathless route would collide with the current TanStack Router layout.
- 2026-04-06: Completed WI-6 by adding `apps/web/src/components/ChannelView.tsx` plus `ChannelView.logic.ts`/`.test.ts`, extending the thread mapping with `patternId` so deliberation container sessions can dispatch from the canonical `/$threadId` route, and widening `apps/web/src/stores/channelStore.ts`/`.test.ts` with thread-to-channel lookup and intervention mutation helpers. Standalone deliberation sessions now render a live channel view with per-participant color coding, turn counts, inline intervention UI, clickable participant transcript panes, and a split-view toggle while leaving `ChatView.tsx` unchanged for plain threads. Validation passed: `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.

## Review Log

- 2026-04-06: Review fix -- extracted `apps/web/src/components/ChannelView.parts.tsx` from `apps/web/src/components/ChannelView.tsx` to keep the channel view component under the 500-line limit without changing behavior. Validation passed: `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
