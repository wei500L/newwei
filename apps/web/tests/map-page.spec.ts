import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const mapPagePath = path.resolve(__dirname, "../app/(app)/map/page.tsx");

describe("map page layout", () => {
  it("keeps the standalone map overlay label outside the map surface", () => {
    const sourceText = fs.readFileSync(mapPagePath, "utf8");

    expect(sourceText).toContain('className="flex flex-col gap-4 pb-6 sm:gap-6"');
    expect(sourceText).toContain(
      'className="glass-panel border border-[var(--border)] flex flex-col gap-4 overflow-hidden p-4 sm:p-5"',
    );
    expect(sourceText).toContain('className="text-sm text-slate-600 sm:text-base"');
    expect(sourceText).toContain('t("pages.map.overlay")');
    expect(sourceText).toContain(
      '<WarMap className="min-h-0 w-full" layoutVariant="standalone" />',
    );
    expect(sourceText).not.toContain("max-h-[56rem]");
    expect(sourceText).not.toContain("min-h-[30rem]");
    expect(sourceText).not.toContain('className="absolute top-4 left-4 z-10"');
  });
});
