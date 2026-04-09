import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const mapPagePath = path.resolve(__dirname, "../app/(app)/map/page.tsx");

describe("map page layout", () => {
  it("keeps the standalone map overlay label outside the map surface", () => {
    const sourceText = fs.readFileSync(mapPagePath, "utf8");

    expect(sourceText).toContain(
      "min-h-[calc(100dvh-var(--top-nav-height,4rem)-var(--ticker-height,0px)-2rem)]",
    );
    expect(sourceText).toContain(
      "md:min-h-[calc(100dvh-var(--top-nav-height,4rem)-var(--ticker-height,0px)-3rem)]",
    );
    expect(sourceText).toContain("min-h-[30rem]");
    expect(sourceText).toContain("max-h-[56rem]");
    expect(sourceText).toContain("flex-1");
    expect(sourceText).toContain('className="px-5 pt-4"');
    expect(sourceText).toContain('className="min-h-0 flex flex-1"');
    expect(sourceText).toContain(
      '<WarMap className="flex-1" layoutVariant="standalone" />',
    );
    expect(sourceText).not.toContain('className="absolute top-4 left-4 z-10"');
  });
});
