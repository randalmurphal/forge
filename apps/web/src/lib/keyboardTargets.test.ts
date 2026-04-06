import { describe, expect, it } from "vitest";

import { isEditableKeyboardTarget, isEditableKeyboardTargetDescriptor } from "./keyboardTargets";

describe("isEditableKeyboardTargetDescriptor", () => {
  it("treats form controls as editable targets", () => {
    expect(isEditableKeyboardTargetDescriptor({ tagName: "input" })).toBe(true);
    expect(isEditableKeyboardTargetDescriptor({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditableKeyboardTargetDescriptor({ tagName: "select" })).toBe(true);
  });

  it("treats contenteditable targets and descendants as editable", () => {
    expect(isEditableKeyboardTargetDescriptor({ isContentEditable: true })).toBe(true);
    expect(isEditableKeyboardTargetDescriptor({ hasEditableAncestor: true })).toBe(true);
  });

  it("ignores non-editable elements", () => {
    expect(isEditableKeyboardTargetDescriptor({ tagName: "button" })).toBe(false);
    expect(isEditableKeyboardTargetDescriptor({})).toBe(false);
  });
});

describe("isEditableKeyboardTarget", () => {
  it("returns true for direct editable targets", () => {
    expect(
      isEditableKeyboardTarget({
        tagName: "INPUT",
        isContentEditable: false,
        closest: () => null,
      } as unknown as EventTarget),
    ).toBe(true);
  });

  it("returns true for descendants inside contenteditable regions", () => {
    expect(
      isEditableKeyboardTarget({
        tagName: "SPAN",
        isContentEditable: false,
        closest: (selector: string) => (selector.includes("[contenteditable]") ? {} : null),
      } as unknown as EventTarget),
    ).toBe(true);
  });

  it("returns false for non-editable targets and null", () => {
    expect(
      isEditableKeyboardTarget({
        tagName: "BUTTON",
        isContentEditable: false,
        closest: () => null,
      } as unknown as EventTarget),
    ).toBe(false);
    expect(isEditableKeyboardTarget(null)).toBe(false);
  });
});
