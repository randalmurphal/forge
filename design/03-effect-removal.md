# Effect.js Removal

## Why Remove It

Effect.js is a powerful functional effects library, but it's the wrong choice for a codebase that AI agents will heavily contribute to. It's niche (limited training data), has a steep learning curve (generators, Layers, Streams, Queues), and adds framework lock-in for patterns that have simpler alternatives.

Every service in t3-code's server uses Effect.js. This isn't a surgical removal - it's a rewrite of the server's composition layer. The business logic inside the effects is often straightforward; the Effect wrapping is what's complex.

## What Effect.js Currently Provides

### Dependency Injection
Every service is a `Layer` that declares its dependencies and is composed at startup.

```typescript
// Current: Effect.js Layer
const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const eventStore = yield* OrchestrationEventStore
  return { getReadModel, dispatch, streamDomainEvents }
})
export const OrchestrationEngineLive = Layer.effect(OrchestrationEngineService, makeOrchestrationEngine)
```

**Replacement: Constructor injection with a composition root.**

```typescript
// New: Plain class with constructor injection
class OrchestrationEngine {
  constructor(
    private sql: SqlClient,
    private eventStore: OrchestrationEventStore,
  ) {}
  // methods...
}

// Composition root (one place that wires everything)
function createServices(db: Database): Services {
  const sql = new SqlClient(db)
  const eventStore = new OrchestrationEventStore(sql)
  const engine = new OrchestrationEngine(sql, eventStore)
  // ...
  return { engine, /* ... */ }
}
```

No framework. Dependencies are explicit function arguments. The composition root is one file that constructs everything in order. If a dependency is missing, the compiler tells you.

### Structured Concurrency
Effect.js uses Scope, Fiber, and structured cancellation to manage concurrent work.

**Replacement: AbortController + Promise patterns.**

```typescript
class WorkflowRunner {
  private controller = new AbortController()

  async runPhase(phase: Phase): Promise<PhaseResult> {
    const signal = this.controller.signal
    // All async operations receive the signal
    const session = await this.startSession(phase, signal)
    const result = await this.waitForCompletion(session, signal)
    return result
  }

  cancel(): void {
    this.controller.abort()
  }
}
```

AbortController is native, well-understood, and sufficient for our concurrency needs (cancelling agent sessions, timing out operations, cleaning up on shutdown).

### Typed Error Channels
Effect.js tracks error types in the type system: `Effect<A, E, R>` where E is the error type.

**Replacement: Result type or discriminated union errors.**

```typescript
type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E }

// Or simply throw with typed error classes
class SessionNotFoundError extends Error {
  readonly _tag = "SessionNotFoundError" as const
  constructor(public sessionId: string) {
    super(`Session not found: ${sessionId}`)
  }
}
```

For most cases, throwing typed errors is sufficient. Result types are useful at boundaries where callers need to handle specific failure modes.

### Streams and Queues
Effect.js provides `Stream`, `Queue`, and `PubSub` for event processing.

**Replacement: AsyncIterables, EventEmitter, or simple pub/sub.**

```typescript
// Event bus using typed EventEmitter
class EventBus<Events extends Record<string, unknown>> {
  private emitter = new EventEmitter()

  emit<K extends keyof Events>(event: K, data: Events[K]): void {
    this.emitter.emit(event as string, data)
  }

  on<K extends keyof Events>(event: K, handler: (data: Events[K]) => void): () => void {
    this.emitter.on(event as string, handler)
    return () => this.emitter.off(event as string, handler)
  }

  // For async iteration
  async *subscribe<K extends keyof Events>(event: K, signal?: AbortSignal): AsyncIterable<Events[K]> {
    // ... yield events until signal aborts
  }
}
```

For ordered queue processing (like DrainableWorker), a simple async queue:

```typescript
class AsyncQueue<T> {
  private queue: T[] = []
  private resolve: ((value: T) => void) | null = null

  push(item: T): void {
    if (this.resolve) {
      this.resolve(item)
      this.resolve = null
    } else {
      this.queue.push(item)
    }
  }

  async take(): Promise<T> {
    if (this.queue.length > 0) return this.queue.shift()!
    return new Promise(resolve => { this.resolve = resolve })
  }
}
```

### Schema Validation
Effect.js uses `@effect/schema` for runtime validation.

**Replacement: Zod.** t3-code's contracts already use Schema-like definitions. Zod is mainstream, well-supported by AI agents, and does the same thing with simpler syntax.

## Removal Strategy

### Phase 1: Shared utilities FIRST (packages/shared)

Build the plain-TS replacements for Effect concurrency primitives before touching anything else. These must be proven with ported tests before they're used to replace Effect in the server.

**DrainableWorker** replacement must preserve:
- Enqueue + outstanding count atomic (synchronous in Node.js single-threaded model)
- `drain()` means "queue empty AND current item finished"
- Deterministic test synchronization (no timing-sensitive sleeps)

**KeyedCoalescingWorker** replacement must preserve:
- Multiple enqueues for same key merge into one processing run
- `drainKey()` waits until a specific key has no queued, pending, or active work
- Automatic requeue on process failure
- Recursive processing when merged values appear during active processing

The current implementations use Effect's TxRef and TxQueue for transactional state updates. In plain TS, synchronous code between `await` points is non-preemptive, so Map/Set operations between awaits are atomic. This must be verified by porting the test suites first.

**TTLCache** (used in reactors for deduplication):
- Map with expiry timestamps
- Automatic eviction on capacity overflow
- `get()` returns undefined for expired entries

### Phase 2: Contracts (packages/contracts)
- Replace `@effect/schema` with Zod schemas
- Keep the same type shapes — just change the validation library
- This is mechanical and can be done file-by-file

### Phase 3: Server services (apps/server)

Order of migration (based on dependency graph, bottom-up):

**3a: Persistence layer** — leaf services, no deps
- SqlClient, EventStore, all Repository interfaces
- Replace `Effect.gen` with async methods, `yield*` with constructor deps

**3b: Git services** — depends on persistence
- GitCore, CheckpointStore, CheckpointDiffQuery
- Replace Effect error handling with try/catch + typed errors

**3c: Provider adapters** — depends on persistence
- ClaudeAdapter (~3k lines of actual logic): complex in-memory state for turns, pending approvals, prompt queues. Replace Ref with class fields, Effect.race with Promise.race. Manages child sessions.
- CodexAdapter + CodexAppServerManager: simpler, mostly event mapping.

**3d: Orchestration core** — already pure, minimal Effect
- decider.ts: unwrap `Effect.fn()` to plain functions returning `Result<events, error>`
- projector.ts: already pure, just remove Schema dependency
- commandInvariants.ts: pure lookups, trivial

**3e: Orchestration runtime — THE HARD PART**

This is where the reactor layer lives. Three reactors use Effect concurrency primitives that genuinely earn their keep:

- **ProviderRuntimeIngestion** (~1,300 lines): Three `Cache.make()` instances with TTL expiry, `makeDrainableWorker()`, multi-source `Stream.runForEach()` subscriptions. This is stateful stream processing.
- **ProviderCommandReactor** (~800 lines): `Cache.make()` with 30-minute TTL for deduplication, `Effect.race()` and `Effect.timeout()`.
- **CheckpointReactor** (~800 lines): Subscribes to TWO event sources simultaneously, coordinates between them.

Use the shared utilities from Phase 1. Replace Cache → TTLCache, DrainableWorker → plain DrainableWorker, multi-source Streams → multiple EventEmitter subscriptions with a coordinator pattern.

**3f: WebSocket server** — top-level, wires everything together
- Replace Layer composition with composition root (`createServices()` function)
- Replace Effect runtime with plain async startup sequence

### Phase 4: Test migration
- Replace `Effect.runPromise()` in tests with plain async/await
- Replace mock Layers with constructor-injected mocks
- Port reactor tests carefully — they depend on drain() semantics

## Challenges

### Preserving t3-code's DrainableWorker semantics
DrainableWorker ensures ordered processing and provides `drain()` for test synchronization. The replacement AsyncQueue needs the same guarantees: FIFO ordering, ability to wait until all queued work completes, and error propagation.

### Provider adapter state management
ClaudeAdapter and CodexAdapter use Effect's `Ref` for mutable state management. Replacing with plain class fields is straightforward but we lose Effect's transactional guarantees. Need to ensure state updates are atomic where they need to be (e.g., pending approval maps).

### Startup ordering
Effect's Layer system handles startup ordering automatically (dependencies resolve in topological order). The composition root needs to do this manually. Not hard, but needs to be correct - especially for services that depend on database migrations completing first.

### Stream backpressure
Effect Streams have built-in backpressure. AsyncIterables don't (by default). For high-throughput event streams (provider runtime events), we may need explicit buffering or dropping strategies. In practice, the throughput is low enough (LLM responses are slow) that this shouldn't matter, but worth noting.

## What We Keep

- **Decider/projector pattern**: These are pure functions. They don't need Effect.js. They take state + command/event, return events/state. Keep the pattern, remove the Effect wrapper.
- **Event sourcing**: The concept stays. The aggregate changes from "thread" to "session." Child sessions replace the old agents table. The runtime changes.
- **Provider adapter interface**: The shape stays. The Effect wrappers go.
- **WebSocket protocol**: Push/request patterns stay. Server-side Effect handlers become plain async functions.

## Open Questions

1. **Zod vs. no validation library?** Zod is the obvious choice but adds a dependency. For internal types, TypeScript's type system may be sufficient. Validation at boundaries (WebSocket, SQLite reads) needs runtime checking - Zod is worth it there.

2. **How much of t3-code's test suite survives?** Tests that test pure logic (decider, projector) survive with minimal changes. Tests that test Effect composition may need full rewrites. Need to assess test coverage before and after.

3. **Do we remove Effect.js first or change the data model first?** Doing both simultaneously is a nightmare. Effect removal should come first (same semantics, different implementation), then data model change (different semantics, using the new implementation).

## Runtime Protocol Inventory

These protocols from t3-code must be preserved during the Effect.js removal. They encode consistency guarantees that a builder cannot safely rediscover.

### CommandGate (serverRuntimeStartup.ts)

Three-state machine: pending → ready | error. Commands arriving before readiness are queued in FIFO order. On signalReady: drain queue sequentially (one command at a time, in arrival order). On failReady: reject all queued commands with the startup error.

Plain-TS replacement preserving both properties (FIFO drain + fail-all):

    class CommandGate {
      private state: 'pending' | 'ready' | Error = 'pending';
      private queue: Array<{ fn: () => Promise<unknown>; resolve: Function; reject: Function }> = [];
      private draining = false;

      async enqueueCommand<T>(fn: () => Promise<T>): Promise<T> {
        if (this.state === 'ready') return fn();
        if (this.state instanceof Error) throw this.state;
        return new Promise<T>((resolve, reject) => {
          this.queue.push({ fn, resolve, reject });
        });
      }

      signalReady() { this.state = 'ready'; this.drainQueue(); }
      failReady(err: Error) { this.state = err; for (const item of this.queue) item.reject(err); this.queue = []; }

      private async drainQueue() {
        if (this.draining) return;
        this.draining = true;
        while (this.queue.length > 0) {
          const item = this.queue.shift()!;
          try { item.resolve(await item.fn()); }
          catch (e) { item.reject(e); }
        }
        this.draining = false;
      }
    }

Critical: the current Effect version uses a single Queue worker with forkScoped, ensuring FIFO. The naive `await readyPromise; return fn()` pattern fans out all pre-ready commands concurrently — that is a semantic change that breaks ordering guarantees.

### Dispatch Reconciliation Protocol (OrchestrationEngine.ts)

The orchestration engine's processEnvelope has a consistency recovery path:

1. Capture `dispatchStartSequence` (current event store high-water mark) before processing
2. Run command through decider → events
3. SQL transaction: append events + update receipt + project read model updates
4. On success: update in-memory read model, publish events to subscribers
5. On failure: call reconcileReadModelAfterDispatchFailure:
   a. Query event store from dispatchStartSequence forward
   b. Replay any persisted events through the projector
   c. Publish recovered events to subscribers

This handles the edge case where the SQL transaction committed but the process failed before updating the in-memory read model. The reconciliation re-queries the DB and brings the in-memory state back into sync.

The command receipt check (idempotency) runs BEFORE the decider: if a commandId has already been processed, return the cached result sequence without re-executing.

### CheckpointReactor Protocol

Subscribes to BOTH runtime events (from provider) AND domain events (from orchestration engine). Implements a three-part state machine:

**Part 1 — Pre-turn baseline creation (dual-source):**
- On runtime `turn.started`: capture git snapshot as baseline checkpoint BEFORE agent modifies files
- On domain `thread.turn-start-requested` / `thread.message-sent`: same baseline creation from domain event path
- Dual-source ensures baseline exists regardless of which event fires first

**Part 2 — Placeholder checkpoint from ProviderRuntimeIngestion:**
- On Codex `turn/diff/updated` events: ProviderRuntimeIngestion dispatches `thread.turn-diff-completed` with status='missing' — this is a PLACEHOLDER
- The placeholder records that file changes happened but the real git capture hasn't occurred yet

**Part 3 — Placeholder replacement with real checkpoint:**
- On `thread.turn-diff-completed` domain events where status='missing': CheckpointReactor captures actual git state
- Uses the placeholder's turnCount (does NOT increment past it — prevents gaps in numbering)
- On runtime `turn.completed`: also captures checkpoint, checking for existing placeholder first

**Invariants:**
1. Pre-turn baseline captured from BOTH runtime and domain event paths (no gaps)
2. Placeholder checkpoints (status='missing') are always replaced with real git captures
3. TurnCount reuse: placeholders establish numbering; real captures inherit it
4. Dual-source events are idempotent (if both fire, only one baseline/capture is created)

### ProviderRuntimeIngestion Protocol

Subscribes to ALL runtime events from the provider adapter's event stream.

**State:** Three TTL caches:
- `turnMessageIdsByTurnKey`: 120-minute TTL, 10K capacity. Maps turn keys to message IDs for deduplication.
- `bufferedAssistantTextByMessageId`: 120-minute TTL, 20K capacity, 24K char buffer max before flush. Buffers streaming text before persisting.
- `bufferedProposedPlanById`: 120-minute TTL, 10K capacity. Buffers proposed plan markdown.

**Invariant:** STRICT_PROVIDER_LIFECYCLE_GUARD enforces event ordering: turn.started must precede turn items, which must precede turn.completed. Out-of-order events are logged and rejected.

**Key behavior:** On Codex `turn/diff/updated` → dispatches placeholder `thread.turn-diff-completed` (status='missing') to trigger CheckpointReactor.

### ProviderCommandReactor Protocol

Reacts to orchestration domain events by dispatching provider commands.

**State:** TTL cache (30-minute TTL) for command deduplication. Prevents the same domain event from triggering duplicate provider calls.

**Key behaviors:**
- On `thread.turn-start-requested`: start provider turn
- On `thread.approval-response-requested`: send approval response to provider
- On `thread.user-input-response-requested`: send user input answer to provider
- Semantic branch renaming: on first user message, generates semantic branch name from prompt, renames worktree branch, dispatches meta update

### Effect.Schema → Zod Migration Reference

Key semantic differences to handle during migration:

| Effect.Schema | Zod equivalent | Gotcha |
|--------------|---------------|--------|
| `Schema.Literals(["a", "b"])` | `z.enum(["a", "b"])` | Direct |
| `TrimmedNonEmptyString.check(isMaxLength(n))` | `z.string().trim().min(1).max(n)` | Chain order matters |
| `Schema.optionalKey()` | `z.optional()` | optionalKey = key absent; Zod optional = value undefined. For JSON parsing both work, but for TypeScript types the semantics differ |
| `Schema.TaggedErrorClass` | Custom class extending Error + Zod schema for validation | No direct equivalent. Create a factory: `createTypedError(tag, schema)` |
| `Schema.Union([A, B])` with discriminant | `z.discriminatedUnion("field", [A, B])` | Requires explicit discriminant field |
| `Schema.Struct({ nested: Schema.Struct(...) })` | `z.object({ nested: z.object(...) })` | Direct |
| `Schema.NullOr(T)` | `z.nullable(T)` | Direct |

## Sequencing Checkpoints

The Effect removal, aggregate rewrite, and new feature work form a SERIAL chain. The system is not usable at intermediate points between steps. The docs must be explicit about this.

### Checkpoint A: t3-code without Effect.js
- All existing tests pass
- Same thread-centric semantics, plain TS implementation
- DrainableWorker, KeyedCoalescingWorker, TTLCache proven with ported tests
- Composition root replaces Layer graph
- This is the first demoable state

### Checkpoint B: Session model with basic workflow
- Thread aggregate replaced with Session aggregate
- Create session → assign workflow → run single-agent implement phase → complete
- Sessions (with parent/child hierarchy), phase runs, channels tables exist
- Sidebar shows sessions, not threads
- Product identity renamed (forge://, ~/.forge/, @forgetools/*)

### Checkpoint C: Multi-agent deliberation
- Channel tools working (Claude MCP + Codex turn injection)
- Two child sessions exchange messages via shared channel
- Deliberation liveness state persisted and recoverable
- Chat mode (standalone deliberation) functional
- Phase outputs persisted, inputFrom resolution working

### Checkpoint D: Daemon mode
- Background execution survives app close
- Socket API functional (CLI commands work)
- OS notifications dispatched
- Session recovery on restart (resume or context summary)
- Singleton discovery, stale socket recovery

Steps between checkpoints are serial. Checkpoint A must be complete before B starts. The aggregate rewrite (B) only makes sense after the runtime is plain TS (A). Channel tools (C) require the new aggregate. Daemon mode (D) requires a stable server.

Estimated critical path to Checkpoint A: foundation work.  
Estimated critical path to Checkpoint B: session aggregate + UI rewrite.
Estimated critical path to Checkpoint C: channel implementation.
Estimated critical path to Checkpoint D: daemon infrastructure.

## Related Documents

- [01-architecture.md](./01-architecture.md) - System architecture
- [13-sessions-first-redesign.md](./13-sessions-first-redesign.md) - Sessions-first data model (done after Effect removal)
