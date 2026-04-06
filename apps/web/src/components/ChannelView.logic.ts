import type {
  Channel,
  ChannelMessage,
  ChannelStatus,
  ProviderKind,
  ThreadId,
} from "@forgetools/contracts";
import { isEditableKeyboardTarget } from "../lib/keyboardTargets";
import type { ChannelDeliberationState } from "../stores/channelStore";
import type { Thread } from "../types";

const PARTICIPANT_TONES = ["sky", "amber", "emerald", "rose"] as const;

export type ChannelParticipantTone = (typeof PARTICIPANT_TONES)[number] | "human" | "system";

export interface ChannelViewParticipant {
  id: string;
  label: string;
  roleLabel: string | null;
  threadId: ThreadId | null;
  providerLabel: string | null;
  tone: ChannelParticipantTone;
}

export interface ChannelViewMessage {
  id: ChannelMessage["id"];
  sequence: number;
  content: string;
  participantId: string;
  speakerLabel: string;
  roleLabel: string | null;
  threadId: ThreadId | null;
  tone: ChannelParticipantTone;
  fromType: ChannelMessage["fromType"];
}

export interface ChannelTranscriptPane {
  threadId: ThreadId;
  title: string;
  roleLabel: string | null;
  providerLabel: string | null;
  tone: ChannelParticipantTone;
  messages: ReadonlyArray<Thread["messages"][number]>;
}

export interface ChannelViewModel {
  participants: ChannelViewParticipant[];
  messages: ChannelViewMessage[];
  transcriptPanes: ChannelTranscriptPane[];
  turnCount: number;
  headline: string;
}

type ChannelThreadSummary = Pick<Thread, "id" | "title" | "role" | "messages" | "session">;

export function formatChannelRoleLabel(role: string | null | undefined): string | null {
  if (!role) {
    return null;
  }

  return role
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((segment) => segment[0]?.toUpperCase() + segment.slice(1))
    .join(" ");
}

export function formatChannelProviderLabel(
  provider: ProviderKind | null | undefined,
): string | null {
  if (provider === "claudeAgent") {
    return "Claude";
  }
  if (provider === "codex") {
    return "Codex";
  }
  return null;
}

function participantKeyFromMessage(message: Pick<ChannelMessage, "fromType" | "fromId">): string {
  return `${message.fromType}:${message.fromId}`;
}

function isThreadIdLike(
  value: ChannelMessage["fromId"] | Thread["id"] | null | undefined,
  childThreadsById: Map<string, ChannelThreadSummary>,
): value is ThreadId {
  return typeof value === "string" && childThreadsById.has(value);
}

function resolveParticipantTone(
  messageType: ChannelMessage["fromType"],
  participantIndex: number,
): ChannelParticipantTone {
  if (messageType === "human") {
    return "human";
  }
  if (messageType === "system") {
    return "system";
  }
  return PARTICIPANT_TONES[participantIndex % PARTICIPANT_TONES.length] ?? "sky";
}

function buildParticipantSeedList(input: {
  messages: readonly ChannelMessage[];
  deliberationState: ChannelDeliberationState | null | undefined;
  childThreadsById: Map<string, ChannelThreadSummary>;
}): Array<{
  key: string;
  fromType: ChannelMessage["fromType"];
  fromId: ChannelMessage["fromId"];
  role: string | null;
  threadId: ThreadId | null;
  providerLabel: string | null;
  label: string;
}> {
  const seeds: Array<{
    key: string;
    fromType: ChannelMessage["fromType"];
    fromId: ChannelMessage["fromId"];
    role: string | null;
    threadId: ThreadId | null;
    providerLabel: string | null;
    label: string;
  }> = [];
  const seen = new Set<string>();

  const pushSeed = (seed: {
    key: string;
    fromType: ChannelMessage["fromType"];
    fromId: ChannelMessage["fromId"];
    role: string | null;
    threadId: ThreadId | null;
    providerLabel: string | null;
    label: string;
  }) => {
    if (seen.has(seed.key)) {
      return;
    }
    seen.add(seed.key);
    seeds.push(seed);
  };

  for (const participant of input.deliberationState?.participants ?? []) {
    const childThread = isThreadIdLike(participant.id, input.childThreadsById)
      ? input.childThreadsById.get(participant.id)
      : undefined;
    const roleLabel = formatChannelRoleLabel(participant.role ?? childThread?.role ?? null);
    pushSeed({
      key: `${participant.type}:${participant.id}`,
      fromType: participant.type,
      fromId: participant.id,
      role: participant.role ?? childThread?.role ?? null,
      threadId: childThread?.id ?? null,
      providerLabel: formatChannelProviderLabel(childThread?.session?.provider ?? null),
      label:
        roleLabel ??
        childThread?.title ??
        (participant.type === "human"
          ? "You"
          : participant.type === "system"
            ? "System"
            : participant.id),
    });
  }

  for (const message of input.messages) {
    const childThread = isThreadIdLike(message.fromId, input.childThreadsById)
      ? input.childThreadsById.get(message.fromId)
      : undefined;
    const roleLabel = formatChannelRoleLabel(message.fromRole ?? childThread?.role ?? null);
    pushSeed({
      key: participantKeyFromMessage(message),
      fromType: message.fromType,
      fromId: message.fromId,
      role: message.fromRole ?? childThread?.role ?? null,
      threadId: childThread?.id ?? null,
      providerLabel: formatChannelProviderLabel(childThread?.session?.provider ?? null),
      label:
        roleLabel ??
        childThread?.title ??
        (message.fromType === "human"
          ? "You"
          : message.fromType === "system"
            ? "System"
            : message.fromId),
    });
  }

  for (const childThread of input.childThreadsById.values()) {
    const roleLabel = formatChannelRoleLabel(childThread.role ?? null);
    pushSeed({
      key: `agent:${childThread.id}`,
      fromType: "agent",
      fromId: childThread.id,
      role: childThread.role ?? null,
      threadId: childThread.id,
      providerLabel: formatChannelProviderLabel(childThread.session?.provider ?? null),
      label: roleLabel ?? childThread.title,
    });
  }

  return seeds;
}

function participantTypeRank(type: ChannelMessage["fromType"]): number {
  switch (type) {
    case "agent":
      return 0;
    case "human":
      return 1;
    case "system":
      return 2;
  }
}

function compareParticipantSeeds(
  left: {
    fromType: ChannelMessage["fromType"];
    fromId: ChannelMessage["fromId"];
    role: string | null;
    threadId: ThreadId | null;
    label: string;
  },
  right: {
    fromType: ChannelMessage["fromType"];
    fromId: ChannelMessage["fromId"];
    role: string | null;
    threadId: ThreadId | null;
    label: string;
  },
  childThreadOrderById: Map<ThreadId, number>,
): number {
  const leftThreadOrder =
    left.threadId === null ? Number.POSITIVE_INFINITY : childThreadOrderById.get(left.threadId);
  const rightThreadOrder =
    right.threadId === null ? Number.POSITIVE_INFINITY : childThreadOrderById.get(right.threadId);
  const resolvedLeftThreadOrder = leftThreadOrder ?? Number.POSITIVE_INFINITY;
  const resolvedRightThreadOrder = rightThreadOrder ?? Number.POSITIVE_INFINITY;
  if (resolvedLeftThreadOrder !== resolvedRightThreadOrder) {
    return resolvedLeftThreadOrder - resolvedRightThreadOrder;
  }

  const typeRankDifference =
    participantTypeRank(left.fromType) - participantTypeRank(right.fromType);
  if (typeRankDifference !== 0) {
    return typeRankDifference;
  }

  const leftRole = formatChannelRoleLabel(left.role) ?? left.label;
  const rightRole = formatChannelRoleLabel(right.role) ?? right.label;
  const roleComparison = leftRole.localeCompare(rightRole, undefined, { sensitivity: "base" });
  if (roleComparison !== 0) {
    return roleComparison;
  }

  return left.fromId.localeCompare(right.fromId);
}

function resolveHeadline(
  participants: readonly ChannelViewParticipant[],
  fallback: string,
): string {
  const agentParticipants = participants.filter((participant) => participant.threadId !== null);
  const first = agentParticipants[0];
  const second = agentParticipants[1];
  if (first && second) {
    return `${first.label} vs ${second.label}`;
  }
  if (first) {
    return first.label;
  }
  return fallback;
}

export function buildChannelViewModel(input: {
  channel: Channel | null;
  messages: readonly ChannelMessage[];
  deliberationState: ChannelDeliberationState | null | undefined;
  thread: Pick<Thread, "title"> | null | undefined;
  childThreads: readonly ChannelThreadSummary[];
}): ChannelViewModel {
  const childThreadsById = new Map(
    input.childThreads.map((thread) => [thread.id, thread] as const),
  );
  const childThreadOrderById = new Map(
    input.childThreads.map((thread, index) => [thread.id, index] as const),
  );
  const participantSeeds = buildParticipantSeedList({
    messages: input.messages,
    deliberationState: input.deliberationState,
    childThreadsById,
  }).toSorted((left, right) => compareParticipantSeeds(left, right, childThreadOrderById));

  const participants = participantSeeds.map((seed, index) => ({
    id: seed.key,
    label: seed.label,
    roleLabel: formatChannelRoleLabel(seed.role),
    threadId: seed.threadId,
    providerLabel: seed.providerLabel,
    tone: resolveParticipantTone(seed.fromType, index),
  }));
  const participantsById = new Map(
    participants.map((participant) => [participant.id, participant] as const),
  );

  const messages = input.messages.map((message) => {
    const participantId = participantKeyFromMessage(message);
    const participant = participantsById.get(participantId);
    return {
      id: message.id,
      sequence: message.sequence,
      content: message.content,
      participantId,
      speakerLabel:
        participant?.label ??
        (message.fromType === "human"
          ? "You"
          : message.fromType === "system"
            ? "System"
            : message.fromId),
      roleLabel: participant?.roleLabel ?? formatChannelRoleLabel(message.fromRole ?? null),
      threadId: participant?.threadId ?? null,
      tone: participant?.tone ?? resolveParticipantTone(message.fromType, 0),
      fromType: message.fromType,
    };
  });

  const transcriptPanes = participants
    .filter((participant) => participant.threadId !== null)
    .slice(0, 2)
    .flatMap((participant) => {
      const thread = participant.threadId ? childThreadsById.get(participant.threadId) : undefined;
      if (!thread || !participant.threadId) {
        return [];
      }
      return [
        {
          threadId: participant.threadId,
          title: thread.title,
          roleLabel: participant.roleLabel,
          providerLabel: participant.providerLabel,
          tone: participant.tone,
          messages: thread.messages,
        } satisfies ChannelTranscriptPane,
      ];
    });

  return {
    participants,
    messages,
    transcriptPanes,
    turnCount:
      input.deliberationState?.turnCount ??
      input.messages.filter((message) => message.fromType !== "system").length,
    headline: resolveHeadline(
      participants,
      input.thread?.title ?? input.channel?.type ?? "Channel",
    ),
  };
}

function isBareKeypress(
  event: {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
    defaultPrevented?: boolean;
    target?: EventTarget | null;
  },
  key: string,
): boolean {
  return (
    !event.defaultPrevented &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === key &&
    !isEditableKeyboardTarget(event.target)
  );
}

export function shouldToggleChannelSplitView(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
  target?: EventTarget | null;
}): boolean {
  return isBareKeypress(event, "d");
}

export function canToggleChannelSplitView(
  transcriptPanes: ReadonlyArray<ChannelTranscriptPane>,
): boolean {
  return transcriptPanes.length === 2;
}

export function shouldFocusChannelIntervention(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
  target?: EventTarget | null;
}): boolean {
  return isBareKeypress(event, "c");
}

export function canInterveneInChannel(
  channel: Pick<Channel, "status"> | null | undefined,
): channel is Pick<Channel, "status"> & { status: Extract<ChannelStatus, "open"> } {
  return channel?.status === "open";
}

export function isChannelContainerThread(
  thread:
    | Pick<Thread, "parentThreadId" | "workflowId" | "patternId" | "childThreadIds">
    | null
    | undefined,
): boolean {
  if (!thread) {
    return false;
  }

  return (
    thread.parentThreadId == null &&
    thread.workflowId == null &&
    thread.patternId != null &&
    (thread.childThreadIds?.length ?? 0) > 0
  );
}
