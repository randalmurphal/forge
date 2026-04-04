# Effect.js

## Decision: Keep Effect.js

Effect.js stays. The existing server, contracts, and shared utilities are built on Effect and work correctly. The runtime protocols (CommandGate, dispatch reconciliation, CheckpointReactor, ProviderRuntimeIngestion, ProviderCommandReactor) use Effect's concurrency primitives for real correctness guarantees that would be risky to reimplement.

The cost of removing Effect (rewriting ~200 service files, reimplementing 5 critical protocols, migrating all contracts, rewriting all tests) far exceeds the benefit (marginally easier AI agent contributions).

## Approach for New Code

New features (workflow engine, channels, deliberation, session tree, workflow editor) are additive. They can be written as Effect services that plug into the existing composition root, following the patterns already established in the codebase. Where existing code needs modification (e.g., extending the decider/projector for the session aggregate), refactor those specific files — don't rewrite the stack.

The existing patterns to follow:
- Services as Effect Layers with dependency injection
- Commands through the OrchestrationEngine's dispatch
- Event handling through the projector
- Background work through reactors (DrainableWorker, KeyedCoalescingWorker)
- Schema validation via @effect/schema
- Persistence through the existing SqlClient pattern

## What This Changes

- Checkpoint A (Effect removal) is eliminated from the build sequence
- The build sequence becomes: Session model → Workflows → Deliberation → Daemon mode
- New code follows Effect patterns. No migration, no dual-style codebase.
- @effect/schema stays (no Zod migration)
