# Deliberation Patterns

## What This Is

Deliberation is structured disagreement between two child sessions. The value is that one agent will confidently give you an answer; two child sessions forced to respond to each other surface disagreements, edge cases, and blind spots neither would find alone. The friction is the feature.

This document covers how HerdingLlamas' multi-agent patterns translate into forge workflows.

## Patterns from HerdingLlamas

### Interrogate (Plan Review)

**Purpose:** Exhaustively validate a plan before implementation.

**Roles:**

- **Advocate**: Reads the plan deeply, builds the strongest evidence-based defense, proactively surfaces gaps found during deep read
- **Interrogator**: Works through a structured checklist (assumptions, data flow, boundaries, failure modes, state, dependencies, operations, performance, sequencing, ambiguity), cannot conclude until every dimension is addressed

**Why it works:** The interrogator has a checklist that forces systematic coverage. The advocate's "proactive gap finding" means even the defender is looking for problems. The result is a plan that's been examined from every angle.

**In forge:** This becomes a `deliberate` phase in workflow sessions like `plan-then-implement`. The interrogator's checklist is embedded in the role prompt. The channel transcript becomes the plan review document. The synthesis phase condenses findings for the human.

### Code Review

**Purpose:** Dual-perspective review of code changes.

**Roles:**

- **Scrutinizer**: Works from the diff outward. Reads changed code, traces into callers/dependencies. Reviews for correctness, safety, edge cases, failure modes.
- **Defender**: Works from the system inward. Reads tests and callers first. Reviews for architectural fit, design intent, maintainability, integration, backwards compatibility.

**Sequencing:** Three phases within the deliberation:

1. Independent review (both agents review separately, post findings)
2. Cross-examination (each responds to the other's findings)
3. Convergence (resolve contested items)

**In forge:** The parallel-then-respond pattern (used for code review) is expressed as separate workflow phases within a workflow session, not as a sub-state machine within the deliberation engine. Independent review is one multi-agent phase (no channel), cross-examination is a second multi-agent phase (with channel). See doc 04's code-review workflow. The deliberation engine only handles ping-pong turn-taking within a single channeled phase.

### Explore (Lateral Thinking)

**Purpose:** Find non-obvious connections and structural parallels from unrelated domains.

**Roles:**

- **Connector**: Searches ONLY unrelated domains (biology, economics, game theory). Explicitly forbidden from researching the topic directly.
- **Critic**: Researches the topic directly, stress-tests analogies against reality, designs "what would it take to build" for novel ideas.

**Why it works:** Asymmetric information access prevents convergence. The connector can't just agree because they literally don't know the domain details. The critic can't dismiss analogies without explaining why the domain difference matters.

**In forge:** Same multi-agent pattern, different role prompts. The key constraint (connector can't research the topic) is enforced by the system prompt, not by tool restrictions.

### Prompt Refinement

**Purpose:** Systematically improve a prompt against prompt engineering principles.

**Roles:**

- **Evaluator**: Assesses against 10 dimensions (clarity, specificity, structure, framing, role definition, context efficiency, constraint completeness, technique fit, redundancy, rationale)
- **Refiner**: Defends intentional choices, proposes exact before/after text replacements

**In forge:** Useful for improving workflow phase prompts themselves. Meta-tool: use deliberation to improve the prompts that deliberation uses.

## Implementation in Forge

### Channel Orchestration

The engine manages the deliberation lifecycle:

```
1. Create channel (type: deliberation)
2. Spawn child session A with role prompt + channel tools
3. Spawn child session B with role prompt + channel tools
4. Send initial message to both:
   Child session A: "You are the [role]. Here is the [question/plan/code]. Begin your analysis."
   Child session B: "You are the [role]. Here is the [question/plan/code]. Begin your analysis."
5. Monitor loop:
   - Child session posts to channel -> notify other child session
   - Child session reads channel -> return unread messages
   - Child session proposes conclusion -> check if both agree
   - Max turns reached -> force conclusion
   - Human intervenes -> inject into both child sessions' context
6. On conclusion:
   - Collect full channel transcript
   - If part of workflow: pass to synthesis phase
   - If standalone: present to human
```

### Turn-Taking Strategies

**Ping-pong (default for v1):**

```
A posts -> B reads and responds -> A reads and responds -> ...
```

Simple, predictable, easy to render in UI. The engine waits for one child session to post before nudging the other.

**Parallel-then-respond (for code review):**
This pattern is now expressed as separate workflow phases rather than as a sub-state within the deliberation engine. Independent review is one multi-agent phase (no channel, `sandboxMode: read-only`), cross-examination is a second multi-agent phase (with channel). See doc 04's code-review workflow. The deliberation engine does NOT manage this sequencing internally.

**Free-form (stretch goal):**

```
Either child session can post at any time. The engine just delivers messages.
```

Most natural but hardest to render cleanly and hardest to ensure both child sessions participate equally.

### Synthesis

After deliberation concludes, a synthesis step is usually needed. Options:

1. **Agent synthesis**: A third child session reads the channel transcript and produces a summary. This is what HerdingLlamas does with `herd summary`.

2. **Structured extraction**: Parse the channel transcript for specific patterns (concessions, unresolved disagreements, agreed findings) and present them structured.

3. **Human synthesis**: Just show the transcript. The human reads and decides.

For v1: agent synthesis. It's simple and produces useful output. The synthesis child session gets the full channel transcript plus the original question/plan/code, and produces a structured summary.

### Role Prompt Design

Role prompts are the engine of behavior control. They need to:

1. **Define the perspective clearly** - what the agent is responsible for examining
2. **Embed evaluation checklists** - structured dimensions to probe (like the interrogator's 10 dimensions)
3. **Require evidence** - agents must cite code, documentation, research, not just assert
4. **Include tool documentation** - exact channel tool signatures and when to use them
5. **Set conclusion criteria** - when the agent should propose concluding
6. **Prevent premature convergence** - explicitly tell agents to push back, not agree to be polite

**Example structure (interrogator role prompt):**

```
You are the Interrogator. Your job is to systematically probe the proposed plan
for gaps, unstated assumptions, and failure modes. You are NOT trying to be
helpful or supportive. You are trying to find every way this plan could fail.

## Your checklist (cover ALL dimensions before concluding):
1. Assumptions: What is the plan assuming that might not be true?
2. Data flow: Where does data enter, transform, and exit? What's unvalidated?
3. Boundaries: What are the system boundaries? What crosses them?
[... 7 more dimensions ...]

## How to work:
1. RESEARCH FIRST. Read the codebase, search for similar patterns, check docs.
2. Post your findings to the channel using post_to_channel.
3. Read the Advocate's responses using read_channel.
4. Challenge their responses with evidence. Don't accept hand-waving.
5. Do NOT propose conclusion until all 10 dimensions are addressed.

## Tools:
- post_to_channel: Post your analysis or response
- read_channel: Read unread messages from the Advocate
- propose_conclusion: Propose ending (only after all dimensions covered)
```

## Challenges

### Deliberation termination model (CORRECTED)

**Deliberation MUST NOT gate workflow progress on text parsing or heuristic classification.** Termination is based on discrete, reliable signals only:

1. **Both child sessions call `propose_conclusion`** — explicit tool call (Claude) or explicit prefix (Codex). Reliable.
2. **Max turns reached** — hard limit. Reliable.
3. **Human intervenes** — explicit action. Reliable.

**Coverage tracking is advisory only.** The UI can show which interrogation dimensions appear to have been addressed (keyword/pattern heuristics) as a visual aid. But this NEVER gates phase progression. The human sees the advisory indicators and can send a nudge ("you haven't addressed failure modes"), extend max turns, or conclude anyway. Automatic nudges based on coverage detection are opt-in and off by default.

**Role enforcement is not v1.** Detecting "interrogator is agreeing too easily" requires sentiment analysis that would be unreliable. Trust the role prompts and let the human monitor.

### Agent compliance with role constraints

The primary mechanism is the system prompt. For the interrogator pattern, the prompt embeds the 10-dimension checklist and explicitly says "do NOT propose conclusion until all dimensions are addressed." This works well enough in practice (HerdingLlamas proves it). When it fails, the human sees it in the channel view and can intervene.

### Cost management

Deliberation is expensive. Two child sessions, multiple turns each, full tool access. A 20-turn deliberation could easily cost $10-20 in API calls.

- Default max turns: 20 (configurable per workflow)
- Token budget per deliberation (configurable)
- Early termination if both agents agree quickly
- Show running cost in the UI

### When to deliberate vs. when to just implement

Not every session needs two child sessions arguing. Deliberation is valuable for:

- Plans before complex implementations
- Code reviews of significant changes
- Design decisions with multiple valid approaches
- Anything where you'd want a second opinion

It's overkill for:

- Trivial bug fixes
- Straightforward implementations
- Tasks where the approach is obvious

The workflow template determines when deliberation happens. The user picks the workflow when creating a session. Standalone deliberations use chat sessions (type: "chat"), which are first-class — no indirection needed.

### Deliberation quality varies by provider combination

Some provider combinations produce better deliberation than others:

- Claude vs. Claude: good reasoning but may converge too quickly (same training)
- Claude vs. Codex: different perspectives, different strengths, good tension
- Same provider, different models: potential sweet spot (same tool interface, different reasoning)

Need to experiment and document which combinations work best for each pattern.

### Channel message format

Should channel messages be plain text, or structured? Options:

- **Plain text**: Simplest. Agents post natural language. Human reads it.
- **Structured**: Agents post JSON with fields like `dimension`, `finding`, `severity`, `evidence`. Engine can track coverage.
- **Hybrid**: Plain text with optional metadata that the engine parses.

Structured is better for the engine (checklist tracking, synthesis) but harder for agents to produce reliably. Hybrid is probably right: agents post natural text, but the engine uses pattern matching or a lightweight classifier to extract structure.

## Open Questions

1. **Should deliberation results be editable?** After synthesis, should the human be able to edit the summary before it flows to the next phase? This is useful for correcting misinterpretations but adds UI complexity.

2. **Can deliberation be async?** Instead of both agents running simultaneously, could one agent run to completion, then the other reviews? Simpler orchestration, but loses the back-and-forth dynamic that surfaces deeper insights.

3. **How do we handle deliberation on code that's actively changing?** If a deliberation runs on a PR, and the PR gets updated mid-deliberation, agents may be arguing about stale code. Need a mechanism to detect this and restart or update.

4. **Should we support more than two child sessions?** A three-way deliberation (e.g., advocate, interrogator, domain expert) could be valuable for complex decisions. But the orchestration complexity grows quickly. Probably two child sessions only for v1.

5. **Can deliberation templates be shared/published?** Users might want to share effective role prompts and checklist dimensions. A community library of deliberation patterns could be valuable. Stretch goal.

## Related Documents

- [04-workflow-engine.md](./04-workflow-engine.md) - How deliberation phases fit in workflows
- [06-agent-integration.md](./06-agent-integration.md) - Provider session lifecycle and channel tool implementation
