import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const mapPagePath = path.resolve(__dirname, "../app/(app)/map/page.tsx");

describe("map page layout", () => {
  it("keeps the standalone map overlay label outside the map surface", () => {
    const sourceText = fs.readFileSync(mapPagePath, "utf8");

    expect(sourceText).toContain('className="flex min-h-full flex-col gap-6"');
    expect(sourceText).toContain("h-[clamp(30rem,calc(100dvh-12rem),56rem)]");
    expect(sourceText).toContain("min-h-[30rem]");
    expect(sourceText).toContain('className="px-5 pt-4"');
    expect(sourceText).toContain('className="min-h-0 flex-1"');
    expect(sourceText).not.toContain('className="absolute top-4 left-4 z-10"');
  });
});
