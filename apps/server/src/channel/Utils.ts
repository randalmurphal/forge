import type { ChannelMessage } from "@t3tools/contracts";

type TranscriptMessage = Pick<ChannelMessage, "fromType" | "fromId" | "fromRole" | "content">;

export function formatChannelTranscript(messages: ReadonlyArray<TranscriptMessage>): string {
  return messages
    .map((message) => {
      const speaker = message.fromRole ?? message.fromId ?? message.fromType;
      return [`[${speaker}]`, message.content].join("\n");
    })
    .join("\n\n");
}
