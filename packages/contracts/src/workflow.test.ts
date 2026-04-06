import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  AgentOutputConfig,
  DEFAULT_AGENT_OUTPUT_CONFIG,
  DeliberationConfig,
  ForgeProjectConfig,
  PromptTemplate,
  WorkflowDefinition,
  WorkflowPhase,
  defaultSandboxMode,
} from "./workflow";

const decodeAgentOutputConfig = Schema.decodeUnknownEffect(AgentOutputConfig);
const decodeDeliberationConfig = Schema.decodeUnknownEffect(DeliberationConfig);
const decodeWorkflowPhase = Schema.decodeUnknownEffect(WorkflowPhase);
const decodeWorkflowDefinition = Schema.decodeUnknownEffect(WorkflowDefinition);
const decodeForgeProjectConfig = Schema.decodeUnknownEffect(ForgeProjectConfig);
const decodePromptTemplate = Schema.decodeUnknownEffect(PromptTemplate);

it.effect("decodes agent output config discriminated union members", () =>
  Effect.gen(function* () {
    const schemaOutput = yield* decodeAgentOutputConfig({
      type: "schema",
      schema: {
        summary: "string",
        score: "number",
      },
    });
    const channelOutput = yield* decodeAgentOutputConfig({ type: "channel" });
    const conversationOutput = yield* decodeAgentOutputConfig({ type: "conversation" });

    assert.deepStrictEqual(schemaOutput, {
      type: "schema",
      schema: {
        summary: "string",
        score: "number",
      },
    });
    assert.deepStrictEqual(channelOutput, { type: "channel" });
    assert.deepStrictEqual(conversationOutput, DEFAULT_AGENT_OUTPUT_CONFIG);
  }),
);

it.effect("decodes workflow phases with gate defaults and default conversation output", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeWorkflowPhase({
      id: " phase-1 ",
      name: " Implement ",
      type: "single-agent",
      agent: {
        prompt: " Write code ",
      },
      sandboxMode: "workspace-write",
      inputFrom: {
        PREVIOUS_OUTPUT: " plan.output ",
      },
      gate: {
        after: "quality-checks",
        qualityChecks: [
          {
            check: " typecheck ",
            required: true,
          },
        ],
        onFail: "retry",
      },
      codexMode: "default",
    });

    assert.strictEqual(parsed.id, "phase-1");
    assert.strictEqual(parsed.name, "Implement");
    assert.deepStrictEqual(parsed.agent?.output, DEFAULT_AGENT_OUTPUT_CONFIG);
    assert.deepStrictEqual(parsed.inputFrom, {
      PREVIOUS_OUTPUT: "plan.output",
    });
    assert.strictEqual(parsed.gate.maxRetries, 3);
    assert.deepStrictEqual(parsed.gate.qualityChecks, [
      {
        check: "typecheck",
        required: true,
      },
    ]);
  }),
);

it.effect("decodes deliberation configs with validated default maxTurns", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeDeliberationConfig({
      participants: [
        {
          role: " advocate ",
          agent: {
            prompt: "Argue for the change",
          },
        },
        {
          role: " scrutinizer ",
          agent: {
            prompt: "Look for flaws",
          },
        },
      ],
    });

    assert.deepStrictEqual(parsed, {
      participants: [
        {
          role: "advocate",
          agent: {
            prompt: "Argue for the change",
            output: DEFAULT_AGENT_OUTPUT_CONFIG,
          },
        },
        {
          role: "scrutinizer",
          agent: {
            prompt: "Look for flaws",
            output: DEFAULT_AGENT_OUTPUT_CONFIG,
          },
        },
      ],
      maxTurns: 20,
    });
  }),
);

it.effect("decodes workflow definitions with description defaults", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeWorkflowDefinition({
      id: "workflow-1",
      name: " Full Build ",
      phases: [
        {
          id: "phase-1",
          name: "Plan",
          type: "single-agent",
          agent: {
            prompt: "Plan the change",
            output: {
              type: "schema",
              schema: {
                summary: "string",
              },
            },
          },
          gate: {
            after: "done",
            onFail: "stop",
          },
        },
      ],
      builtIn: false,
      onCompletion: {
        autoCommit: true,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.name, "Full Build");
    assert.strictEqual(parsed.description, "");
    assert.strictEqual(parsed.projectId, null);
    assert.strictEqual(parsed.phases.length, 1);
    assert.strictEqual(parsed.onCompletion?.autoCommit, true);
  }),
);

it.effect("rejects empty workflow phase arrays", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeWorkflowDefinition({
        id: "workflow-1",
        name: "Workflow",
        phases: [],
        builtIn: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("decodes forge project config defaults for quality checks", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeForgeProjectConfig({
      qualityChecks: {
        test: {
          command: " bun run test ",
        },
      },
      bootstrap: {
        command: " bun install ",
      },
      defaultModel: {
        provider: "codex",
        model: " gpt-5.4 ",
      },
    });

    assert.deepStrictEqual(parsed.qualityChecks, {
      test: {
        command: "bun run test",
        timeout: 300000,
        required: true,
      },
    });
    assert.deepStrictEqual(parsed.bootstrap, {
      command: "bun install",
      timeout: 300000,
    });
    assert.deepStrictEqual(parsed.defaultModel, {
      provider: "codex",
      model: "gpt-5.4",
    });
  }),
);

it.effect("decodes prompt templates with optional initial messages", () =>
  Effect.gen(function* () {
    const parsed = yield* decodePromptTemplate({
      name: " implement ",
      description: "Implements the requested change",
      system: "You are a software engineer.\n\n{{DESCRIPTION}}",
      initial: "Start by reading the code.",
    });

    assert.deepStrictEqual(parsed, {
      name: "implement",
      description: "Implements the requested change",
      system: "You are a software engineer.\n\n{{DESCRIPTION}}",
      initial: "Start by reading the code.",
    });
  }),
);

it("resolves default sandbox modes by phase type", () => {
  assert.strictEqual(defaultSandboxMode("single-agent"), "workspace-write");
  assert.strictEqual(defaultSandboxMode("multi-agent"), "read-only");
  assert.strictEqual(defaultSandboxMode("automated"), "workspace-write");
  assert.strictEqual(defaultSandboxMode("human"), "workspace-write");
});
