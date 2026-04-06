export interface EditableKeyboardTargetDescriptor {
  tagName?: string | null | undefined;
  isContentEditable?: boolean | null | undefined;
  hasEditableAncestor?: boolean | null | undefined;
}

const EDITABLE_TAG_NAMES = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const CONTENTEDITABLE_SELECTOR = "[contenteditable]:not([contenteditable='false'])";

export function isEditableKeyboardTargetDescriptor(
  input: EditableKeyboardTargetDescriptor,
): boolean {
  if (input.isContentEditable) {
    return true;
  }

  const normalizedTagName = input.tagName?.toUpperCase();
  return EDITABLE_TAG_NAMES.has(normalizedTagName ?? "") || Boolean(input.hasEditableAncestor);
}

export function isEditableKeyboardTarget(target: EventTarget | null | undefined): boolean {
  if (typeof target !== "object" || target === null) {
    return false;
  }

  const element = target as {
    tagName?: string;
    isContentEditable?: boolean;
    closest?: (selector: string) => unknown;
  };

  return isEditableKeyboardTargetDescriptor({
    tagName: element.tagName,
    isContentEditable: element.isContentEditable,
    hasEditableAncestor: element.closest?.(CONTENTEDITABLE_SELECTOR) != null,
  });
}
