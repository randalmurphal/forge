import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ThreadStatusPill } from "../Sidebar.logic";
import { ThreadStatusLabel } from "./SidebarThreadStatus";

const workingStatus: ThreadStatusPill = {
  kind: "working",
  label: "Working",
  colorClass: "text-[var(--success-foreground)]",
  dotClass: "bg-[var(--success)]",
  pulse: true,
  glowClass: null,
};

const awaitingInputStatus: ThreadStatusPill = {
  kind: "awaiting-input",
  label: "Awaiting Input",
  colorClass: "text-[var(--info-foreground)]",
  dotClass: "bg-[var(--info)]",
  pulse: true,
  glowClass: "glow-ring-blue",
};

describe("ThreadStatusLabel", () => {
  describe("variant='full' (default)", () => {
    it("renders both dot and visible label text", () => {
      const html = renderToStaticMarkup(<ThreadStatusLabel status={workingStatus} />);
      expect(html).toContain("rounded-full");
      expect(html).toContain("Working");
      expect(html).not.toContain("sr-only");
    });

    it("applies animate-pulse to the dot when pulse is true", () => {
      const html = renderToStaticMarkup(<ThreadStatusLabel status={workingStatus} />);
      expect(html).toContain("animate-pulse");
    });
  });

  describe("variant='dot-only'", () => {
    it("renders the dot without a visible label", () => {
      const html = renderToStaticMarkup(
        <ThreadStatusLabel status={awaitingInputStatus} variant="dot-only" />,
      );
      expect(html).toContain("rounded-full");
      expect(html).toContain("sr-only");
      expect(html).toContain("Awaiting Input");
    });

    it("applies animate-pulse when pulse is true", () => {
      const html = renderToStaticMarkup(
        <ThreadStatusLabel status={awaitingInputStatus} variant="dot-only" />,
      );
      expect(html).toContain("animate-pulse");
    });
  });

  describe("variant='label-only'", () => {
    it("renders the label text without a dot", () => {
      const html = renderToStaticMarkup(
        <ThreadStatusLabel status={awaitingInputStatus} variant="label-only" />,
      );
      expect(html).toContain("Awaiting Input");
      expect(html).not.toContain("rounded-full");
    });

    it("applies the status color class", () => {
      const html = renderToStaticMarkup(
        <ThreadStatusLabel status={awaitingInputStatus} variant="label-only" />,
      );
      expect(html).toContain("text-[var(--info-foreground)]");
    });
  });

  describe("compact mode", () => {
    it("renders compact dot regardless of variant prop", () => {
      const html = renderToStaticMarkup(
        <ThreadStatusLabel status={workingStatus} compact variant="label-only" />,
      );
      expect(html).toContain("size-[9px]");
      expect(html).toContain("sr-only");
      expect(html).not.toContain("font-medium");
    });
  });
});
