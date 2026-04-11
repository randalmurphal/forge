import {
  type ForgeEvent,
  type OrchestrationReadModel,
  type OrchestrationThreadActivity,
  type EventId,
} from "@forgetools/contracts";

type CommandOutputSource = "final" | "stream";

const MAX_TRANSPORT_OUTPUT_LINES = 100;
const MAX_TRANSPORT_SUBAGENT_ACTIVITIES = 100;

type CommandOutputResolution = {
  readonly toolCallId: string;
  readonly output: string;
  readonly source: CommandOutputSource;
  readonly omittedLineCount: number;
};

type CommandOutputSummary = {
  readonly available: true;
  readonly source: CommandOutputSource;
  readonly byteLength: number;
};

type SubagentActivityFeedResolution = {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly omittedActivityCount: number;
};

export function sanitizeReadModelForTransport(
  readModel: OrchestrationReadModel,
): OrchestrationReadModel {
  return {
    ...readModel,
    threads: readModel.threads.map((thread) => ({
      ...thread,
      activities: thread.activities.map(sanitizeThreadActivityForTransport),
    })),
  };
}

export function sanitizeForgeEventForTransport(event: ForgeEvent): ForgeEvent {
  if (event.type !== "thread.activity-appended") {
    return event;
  }

  return {
    ...event,
    payload: {
      ...event.payload,
      activity: sanitizeThreadActivityForTransport(event.payload.activity),
    },
  };
}

export function sanitizeThreadActivityForTransport(
  activity: OrchestrationThreadActivity,
): OrchestrationThreadActivity {
  const payload = asRecord(activity.payload);
  if (!payload) {
    return activity;
  }

  if (activity.kind === "tool.output.delta") {
    const sanitizedPayload = sanitizeCommandOutputDeltaPayload(payload);
    return sanitizedPayload === payload ? activity : { ...activity, payload: sanitizedPayload };
  }

  if (!isCommandLifecyclePayload(payload)) {
    return activity;
  }

  const sanitizedPayload = sanitizeCommandLifecyclePayload(payload);
  return sanitizedPayload === payload ? activity : { ...activity, payload: sanitizedPayload };
}

export function resolveCommandOutputForActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  input: {
    readonly activityId: EventId;
    readonly toolCallId?: string | null;
  },
): CommandOutputResolution | null {
  const resolvedToolCallId =
    input.toolCallId?.trim() || findToolCallIdForActivity(activities, input.activityId);
  if (!resolvedToolCallId) {
    return null;
  }

  let streamedOutput = "";
  let finalOutput: string | null = null;

  for (const activity of activities) {
    const payload = asRecord(activity.payload);
    if (!payload) {
      continue;
    }

    const activityToolCallId = extractToolCallId(payload);
    if (activityToolCallId !== resolvedToolCallId) {
      continue;
    }

    const finalCandidate = extractFinalCommandOutput(payload);
    if (finalCandidate) {
      finalOutput = finalCandidate;
    }

    if (activity.kind !== "tool.output.delta") {
      continue;
    }

    const streamKind = asTrimmedString(payload.streamKind);
    const delta = typeof payload.delta === "string" ? payload.delta : null;
    if (streamKind === "command_output" && delta && delta.length > 0) {
      streamedOutput = `${streamedOutput}${delta}`;
    }
  }

  if (finalOutput && finalOutput.length > 0) {
    return buildTailResolution({
      toolCallId: resolvedToolCallId,
      output: finalOutput,
      source: "final",
    });
  }

  if (streamedOutput.length > 0) {
    return buildTailResolution({
      toolCallId: resolvedToolCallId,
      output: streamedOutput,
      source: "stream",
    });
  }

  return null;
}

export function resolveSubagentActivityFeedForActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  input: {
    readonly childProviderThreadId: string;
  },
): SubagentActivityFeedResolution {
  const attributionHints = collectSubagentAttributionHints(activities);
  const relevantActivities = activities.flatMap((activity) => {
    const resolved = resolveRecordedSubagentActivity(
      activity,
      input.childProviderThreadId,
      attributionHints,
    );
    return resolved ? [resolved] : [];
  });
  const omittedActivityCount = Math.max(
    0,
    relevantActivities.length - MAX_TRANSPORT_SUBAGENT_ACTIVITIES,
  );
  const tailActivities =
    omittedActivityCount > 0
      ? relevantActivities.slice(-MAX_TRANSPORT_SUBAGENT_ACTIVITIES)
      : relevantActivities;

  return {
    activities: tailActivities.map(sanitizeThreadActivityForTransport),
    omittedActivityCount,
  };
}

function buildTailResolution(input: {
  readonly toolCallId: string;
  readonly output: string;
  readonly source: CommandOutputSource;
}): CommandOutputResolution {
  const lines = input.output.split("\n");
  const omittedLineCount = Math.max(0, lines.length - MAX_TRANSPORT_OUTPUT_LINES);
  return {
    toolCallId: input.toolCallId,
    output:
      omittedLineCount > 0 ? lines.slice(-MAX_TRANSPORT_OUTPUT_LINES).join("\n") : input.output,
    source: input.source,
    omittedLineCount,
  };
}

function resolveRecordedSubagentActivity(
  activity: OrchestrationThreadActivity,
  childProviderThreadId: string,
  attributionHints: {
    readonly byItemId: ReadonlyMap<
      string,
      {
        taskId?: string;
        childProviderThreadId: string;
        label?: string;
        agentType?: string;
        agentModel?: string;
      }
    >;
    readonly byProcessId: ReadonlyMap<
      string,
      {
        taskId?: string;
        childProviderThreadId: string;
        label?: string;
        agentType?: string;
        agentModel?: string;
      }
    >;
  },
): OrchestrationThreadActivity | null {
  if (
    activity.kind === "task.started" ||
    activity.kind === "task.completed" ||
    activity.kind === "tool.output.delta" ||
    activity.kind === "tool.terminal.interaction"
  ) {
    return null;
  }

  const payload = asRecord(activity.payload);
  const directChildAttr = normalizeChildThreadAttribution(
    asRecord(payload?.childThreadAttribution),
  );
  if (directChildAttr?.childProviderThreadId === childProviderThreadId) {
    return activity;
  }

  if (asTrimmedString(payload?.itemType) !== "command_execution") {
    return null;
  }

  const toolCallId = extractToolCallId(payload);
  const processId = extractProcessId(payload);
  // Some child command rows arrive without direct childThreadAttribution, but sibling activities
  // from the same tool call or process do carry it. Rehydrate that attribution here so the lazy
  // subagent activity feed can still recover the child's recorded actions without keeping the full
  // activity history in the browser.
  const correlatedChildAttr =
    (toolCallId ? attributionHints.byItemId.get(toolCallId) : undefined) ??
    (processId ? attributionHints.byProcessId.get(processId) : undefined);
  if (!correlatedChildAttr || correlatedChildAttr.childProviderThreadId !== childProviderThreadId) {
    return null;
  }

  return {
    ...activity,
    payload: {
      ...payload,
      childThreadAttribution: {
        ...(payload?.childThreadAttribution && typeof payload.childThreadAttribution === "object"
          ? (payload.childThreadAttribution as Record<string, unknown>)
          : {}),
        ...correlatedChildAttr,
      },
    },
  };
}

function collectSubagentAttributionHints(activities: ReadonlyArray<OrchestrationThreadActivity>): {
  readonly byItemId: ReadonlyMap<
    string,
    {
      taskId?: string;
      childProviderThreadId: string;
      label?: string;
      agentType?: string;
      agentModel?: string;
    }
  >;
  readonly byProcessId: ReadonlyMap<
    string,
    {
      taskId?: string;
      childProviderThreadId: string;
      label?: string;
      agentType?: string;
      agentModel?: string;
    }
  >;
} {
  const byItemId = new Map<
    string,
    {
      taskId?: string;
      childProviderThreadId: string;
      label?: string;
      agentType?: string;
      agentModel?: string;
    }
  >();
  const byProcessId = new Map<
    string,
    {
      taskId?: string;
      childProviderThreadId: string;
      label?: string;
      agentType?: string;
      agentModel?: string;
    }
  >();

  for (const activity of activities) {
    const payload = asRecord(activity.payload);
    const childAttr = normalizeChildThreadAttribution(asRecord(payload?.childThreadAttribution));
    if (!childAttr) {
      continue;
    }

    const toolCallId = extractToolCallId(payload);
    const processId = extractProcessId(payload);
    if (toolCallId && !byItemId.has(toolCallId)) {
      byItemId.set(toolCallId, childAttr);
    }
    if (processId && !byProcessId.has(processId)) {
      byProcessId.set(processId, childAttr);
    }
  }

  return { byItemId, byProcessId };
}

function normalizeChildThreadAttribution(value: Record<string, unknown> | null): {
  taskId?: string;
  childProviderThreadId: string;
  label?: string;
  agentType?: string;
  agentModel?: string;
} | null {
  const childProviderThreadId = asTrimmedString(value?.childProviderThreadId);
  if (!childProviderThreadId) {
    return null;
  }

  const taskId = asTrimmedString(value?.taskId) ?? undefined;
  const label = asTrimmedString(value?.label) ?? undefined;
  const agentType = asTrimmedString(value?.agentType) ?? undefined;
  const agentModel = asTrimmedString(value?.agentModel) ?? undefined;
  return {
    childProviderThreadId,
    ...(taskId ? { taskId } : {}),
    ...(label ? { label } : {}),
    ...(agentType ? { agentType } : {}),
    ...(agentModel ? { agentModel } : {}),
  };
}

function sanitizeCommandOutputDeltaPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const streamKind = asTrimmedString(payload.streamKind);
  const delta = typeof payload.delta === "string" ? payload.delta : null;
  if (streamKind !== "command_output" || !delta || delta.length === 0) {
    return payload;
  }

  const nextPayload: Record<string, unknown> = {
    ...payload,
    deltaLength: Buffer.byteLength(delta, "utf8"),
  };
  delete nextPayload.delta;
  return nextPayload;
}

function sanitizeCommandLifecyclePayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const finalOutput = extractFinalCommandOutput(payload);
  const existingSummary = readOutputSummary(payload);
  const outputSummary =
    existingSummary ??
    (finalOutput
      ? {
          available: true as const,
          source: "final" as const,
          byteLength: Buffer.byteLength(finalOutput, "utf8"),
        }
      : null);
  if (!outputSummary) {
    return payload;
  }

  const nextPayload: Record<string, unknown> = {
    ...payload,
    outputSummary,
  };

  const data = asRecord(payload.data);
  if (!data) {
    return nextPayload;
  }

  const nextData: Record<string, unknown> = { ...data };

  const result = asRecord(data.result);
  if (result) {
    const nextResult = { ...result };
    const inferredExitCode =
      readExplicitExitCode(nextResult) ??
      inferExitCodeFromOutputCandidate(asMaybeString(nextResult.output));
    if (inferredExitCode !== undefined && readExplicitExitCode(nextResult) === undefined) {
      nextResult.exitCode = inferredExitCode;
    }
    delete nextResult.output;
    delete nextResult.stdout;
    delete nextResult.stderr;
    nextData.result = nextResult;
  }

  const item = asRecord(data.item);
  if (item) {
    const nextItem: Record<string, unknown> = { ...item };
    delete nextItem.aggregatedOutput;

    const itemResult = asRecord(item.result);
    if (itemResult) {
      const nextItemResult = { ...itemResult };
      const inferredExitCode =
        readExplicitExitCode(nextItemResult) ??
        inferExitCodeFromOutputCandidate(asMaybeString(nextItemResult.output));
      if (inferredExitCode !== undefined && readExplicitExitCode(nextItemResult) === undefined) {
        nextItemResult.exitCode = inferredExitCode;
      }
      delete nextItemResult.output;
      nextItem.result = nextItemResult;
    }

    nextData.item = nextItem;
  }

  nextPayload.data = nextData;
  return nextPayload;
}

function isCommandLifecyclePayload(payload: Record<string, unknown>): boolean {
  return asTrimmedString(payload.itemType) === "command_execution";
}

function findToolCallIdForActivity(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  activityId: EventId,
): string | null {
  const activity = activities.find((candidate) => candidate.id === activityId);
  if (!activity) {
    return null;
  }
  return extractToolCallId(asRecord(activity.payload));
}

function extractToolCallId(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const candidates = [
    asTrimmedString(payload?.toolCallId),
    asTrimmedString(payload?.itemId),
    asTrimmedString(data?.toolUseId),
    asTrimmedString(data?.itemId),
    asTrimmedString(item?.id),
    asTrimmedString(item?.itemId),
    asTrimmedString(itemResult?.tool_use_id),
    asTrimmedString(itemResult?.toolUseId),
  ];
  return candidates.find((candidate) => candidate !== null) ?? null;
}

function extractProcessId(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const candidates = [
    asTrimmedString(payload?.processId),
    asTrimmedString(data?.processId),
    asTrimmedString(item?.processId),
  ];
  return candidates.find((candidate) => candidate !== null) ?? null;
}

function extractFinalCommandOutput(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  if (!data) {
    return null;
  }

  const result = asRecord(data.result);
  const item = asRecord(data.item);
  const itemResult = asRecord(item?.result);

  const candidates = [
    normalizeOutputValue(item?.aggregatedOutput),
    normalizeOutputValue(result?.output),
    joinOutputParts(normalizeOutputValue(result?.stdout), normalizeOutputValue(result?.stderr)),
    normalizeOutputValue(result?.stdout),
    normalizeOutputValue(itemResult?.output),
  ];

  return candidates.find((candidate) => candidate !== null) ?? null;
}

function normalizeOutputValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value.length > 0 ? value : null;
}

function joinOutputParts(stdout: string | null, stderr: string | null): string | null {
  if (!stdout && !stderr) {
    return null;
  }
  if (!stdout) {
    return stderr;
  }
  if (!stderr) {
    return stdout;
  }
  if (stdout.endsWith("\n") || stderr.startsWith("\n")) {
    return `${stdout}${stderr}`;
  }
  return `${stdout}\n${stderr}`;
}

function readOutputSummary(payload: Record<string, unknown>): CommandOutputSummary | null {
  const outputSummary = asRecord(payload.outputSummary);
  if (!outputSummary || outputSummary.available !== true) {
    return null;
  }

  const source =
    outputSummary.source === "final" || outputSummary.source === "stream"
      ? outputSummary.source
      : null;
  const byteLength = typeof outputSummary.byteLength === "number" ? outputSummary.byteLength : null;
  if (!source || byteLength === null || !Number.isFinite(byteLength) || byteLength < 0) {
    return null;
  }

  return {
    available: true,
    source,
    byteLength,
  };
}

function inferExitCodeFromOutputCandidate(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const match = /<exited with exit code (?<code>\d+)>\s*$/i.exec(value.trim());
  if (!match?.groups?.code) {
    return undefined;
  }
  const parsed = Number.parseInt(match.groups.code, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function readExplicitExitCode(payload: Record<string, unknown>): number | undefined {
  const candidates = [payload.exitCode, payload.exit_code];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isInteger(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asMaybeString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
