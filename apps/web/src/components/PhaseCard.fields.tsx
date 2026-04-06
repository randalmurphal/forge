import type { ModelSelection, ServerProvider } from "@forgetools/contracts";
import type { UnifiedSettings } from "@forgetools/contracts/settings";
import { getCustomModelOptionsByProvider } from "../modelSelection";
import { resolveModelSelectionForEditor, resolvePromptEditorValue } from "./WorkflowEditor.logic";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

export function FieldLabel(props: { children: string }) {
  return (
    <label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
      {props.children}
    </label>
  );
}

export function PromptField(props: {
  label: string;
  prompt: string;
  promptOptions: readonly string[];
  disabled?: boolean;
  onChange: (prompt: string) => void;
}) {
  const promptValue = resolvePromptEditorValue(props.prompt, props.promptOptions);
  const showCustomPrompt = promptValue === "__custom__";

  return (
    <div className="space-y-2">
      <FieldLabel>{props.label}</FieldLabel>
      <Select
        value={promptValue}
        onValueChange={(value) => {
          if (!value) {
            return;
          }
          if (value === "__custom__") {
            if (props.promptOptions.includes(props.prompt)) {
              props.onChange("");
            }
            return;
          }
          props.onChange(value);
        }}
        disabled={props.disabled ?? false}
      >
        <SelectTrigger>
          <SelectValue placeholder="Select a prompt template" />
        </SelectTrigger>
        <SelectPopup>
          <SelectGroup>
            <SelectGroupLabel>Templates</SelectGroupLabel>
            {props.promptOptions.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectGroup>
          <SelectSeparator />
          <SelectItem value="__custom__">Custom prompt</SelectItem>
        </SelectPopup>
      </Select>
      {showCustomPrompt ? (
        <Input
          value={props.prompt}
          onChange={(event) => props.onChange(event.target.value)}
          placeholder="Prompt template id or inline custom prompt"
          disabled={props.disabled ?? false}
        />
      ) : null}
    </div>
  );
}

export function ModelField(props: {
  label: string;
  modelSelection: ModelSelection | undefined;
  fallbackModelSelection: ModelSelection;
  settings: UnifiedSettings;
  providers: readonly ServerProvider[];
  disabled?: boolean;
  onChange: (selection: ModelSelection | undefined) => void;
}) {
  const resolvedSelection = resolveModelSelectionForEditor(
    props.modelSelection,
    props.fallbackModelSelection,
  );
  const usingAuto = props.modelSelection === undefined;
  const modelOptionsByProvider = getCustomModelOptionsByProvider(
    props.settings,
    props.providers,
    resolvedSelection.provider,
    resolvedSelection.model,
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <FieldLabel>{props.label}</FieldLabel>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant={usingAuto ? "secondary" : "outline"}
            disabled={props.disabled ?? false}
            onClick={() => props.onChange(undefined)}
          >
            Auto
          </Button>
          <Button
            type="button"
            size="xs"
            variant={usingAuto ? "outline" : "secondary"}
            disabled={props.disabled ?? false}
            onClick={() => props.onChange(resolvedSelection)}
          >
            Override
          </Button>
        </div>
      </div>
      {usingAuto ? (
        <div className="rounded-xl border border-dashed border-border/80 bg-background/70 px-3 py-2 text-sm text-muted-foreground">
          Uses the session model by default.
        </div>
      ) : (
        <ProviderModelPicker
          provider={resolvedSelection.provider}
          model={resolvedSelection.model}
          lockedProvider={null}
          providers={props.providers}
          modelOptionsByProvider={modelOptionsByProvider}
          disabled={props.disabled ?? false}
          triggerVariant="outline"
          triggerClassName="w-full max-w-none justify-between px-3 text-foreground"
          onProviderModelChange={(provider, model) => props.onChange({ provider, model })}
        />
      )}
    </div>
  );
}
