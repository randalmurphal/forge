import {
  type InteractiveRequest,
  type InteractiveRequestId,
  type McpElicitationRequestResolution,
} from "@forgetools/contracts";
import { memo, useEffect, useState } from "react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { cn } from "~/lib/utils";

interface McpElicitationRequest extends InteractiveRequest {
  type: "mcp-elicitation";
  payload: Extract<InteractiveRequest["payload"], { type: "mcp-elicitation" }>;
}

export type ComposerPendingMcpElicitationRequest = McpElicitationRequest;
type McpFormQuestion = NonNullable<
  Extract<InteractiveRequest["payload"], { type: "mcp-elicitation"; mode: "form" }>["questions"]
>[number];

interface ComposerPendingMcpElicitationPanelProps {
  request: McpElicitationRequest;
  pendingCount: number;
  isResponding: boolean;
  onRespond: (
    requestId: InteractiveRequestId,
    resolution: McpElicitationRequestResolution,
  ) => Promise<void>;
}

export const ComposerPendingMcpElicitationPanel = memo(function ComposerPendingMcpElicitationPanel({
  request,
  pendingCount,
  isResponding,
  onRespond,
}: ComposerPendingMcpElicitationPanelProps) {
  const [formAnswers, setFormAnswers] = useState<Record<string, string | string[]>>({});
  const [rawContent, setRawContent] = useState("");

  useEffect(() => {
    setFormAnswers({});
    setRawContent("");
  }, [request.id]);

  const formQuestions: readonly McpFormQuestion[] =
    request.payload.mode === "form" ? (request.payload.questions ?? []) : [];
  const hasQuestions = formQuestions.length > 0;

  const submitResolution = async (action: "accept" | "decline" | "cancel") => {
    const content =
      action === "accept"
        ? hasQuestions
          ? { answers: formAnswers }
          : parseMcpContent(rawContent)
        : null;
    await onRespond(request.id, {
      action,
      content,
      meta: request.payload.meta ?? null,
    });
  };

  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="uppercase text-sm tracking-[0.2em]">MCP ELICITATION</span>
        <span className="text-sm font-medium">{request.payload.serverName}</span>
        {pendingCount > 1 ? (
          <span className="text-xs text-muted-foreground">1/{pendingCount}</span>
        ) : null}
      </div>
      <p className="mt-1.5 text-sm text-foreground/90">{request.payload.message}</p>

      {request.payload.mode === "url" ? (
        <div className="mt-3 rounded-xl border border-border/70 bg-background/50 p-3">
          <a
            href={request.payload.url}
            target="_blank"
            rel="noreferrer"
            className="break-all text-sm text-primary underline-offset-4 hover:underline"
          >
            {request.payload.url}
          </a>
        </div>
      ) : hasQuestions ? (
        <div className="mt-4 space-y-3">
          {formQuestions.map((question) => (
            <McpQuestionCard
              key={question.id}
              question={question}
              value={formAnswers[question.id]}
              disabled={isResponding}
              onChange={(nextValue) =>
                setFormAnswers((current) => ({ ...current, [question.id]: nextValue }))
              }
            />
          ))}
        </div>
      ) : (
        <div className="mt-4">
          <div className="mb-2 text-sm font-medium">Response content</div>
          <Textarea
            value={rawContent}
            disabled={isResponding}
            onChange={(event) => setRawContent(event.target.value)}
            placeholder="Enter JSON or plain text content to send back to the MCP server."
            className="min-h-28"
          />
        </div>
      )}

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={isResponding}
          onClick={() => void submitResolution("cancel")}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={isResponding}
          onClick={() => void submitResolution("decline")}
        >
          Decline
        </Button>
        <Button
          type="button"
          size="sm"
          variant="default"
          disabled={isResponding}
          onClick={() => void submitResolution("accept")}
        >
          Accept
        </Button>
      </div>
    </div>
  );
});

interface McpQuestionCardProps {
  question: McpFormQuestion;
  value: string | string[] | undefined;
  disabled: boolean;
  onChange: (value: string | string[]) => void;
}

function McpQuestionCard({ question, value, disabled, onChange }: McpQuestionCardProps) {
  const selectedValues = Array.isArray(value) ? value : value ? [value] : [];

  return (
    <div className="rounded-xl border border-border/70 bg-background/50 p-3">
      <div className="text-[11px] font-semibold tracking-widest text-muted-foreground/50 uppercase">
        {question.header}
      </div>
      <div className="mt-1 text-sm text-foreground/90">{question.question}</div>
      <div className="mt-3 space-y-1.5">
        {question.options.map((option) => {
          const isSelected = selectedValues.includes(option.label);
          return (
            <button
              key={`${question.id}:${option.label}`}
              type="button"
              disabled={disabled}
              onClick={() => {
                if (question.multiSelect) {
                  onChange(
                    isSelected
                      ? selectedValues.filter((entry) => entry !== option.label)
                      : [...selectedValues, option.label],
                  );
                } else {
                  onChange(option.label);
                }
              }}
              className={cn(
                "flex w-full items-start gap-3 rounded-lg border px-3 py-2 text-left transition-colors duration-150",
                isSelected
                  ? "border-primary/35 bg-primary/8 text-foreground"
                  : "border-transparent bg-muted/20 text-foreground/80 hover:border-border/40 hover:bg-muted/40",
                disabled && "opacity-50 cursor-not-allowed",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded border text-[10px] font-semibold",
                  isSelected
                    ? "border-primary/45 bg-primary/15 text-primary"
                    : "border-border/70 bg-background text-muted-foreground/60",
                )}
              >
                {question.multiSelect ? (isSelected ? "✓" : "") : isSelected ? "•" : ""}
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-sm font-medium">{option.label}</span>
                <span className="ml-2 text-xs text-muted-foreground/50">{option.description}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function parseMcpContent(rawContent: string): unknown {
  const trimmed = rawContent.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return rawContent;
  }
}
