import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const mapPagePath = path.resolve(__dirname, "../app/(app)/map/page.tsx");

describe("map page layout", () => {
  it("keeps the standalone map overlay label outside the map surface", () => {
    const sourceText = fs.readFileSync(mapPagePath, "utf8");

    expect(sourceText).toContain(
      'className="glass-panel border border-[var(--border)] h-[600px] overflow-hidden flex flex-col"',
    );
    expect(sourceText).toContain('className="px-5 pt-4"');
    expect(sourceText).toContain('className="min-h-0 flex-1"');
    expect(sourceText).not.toContain('className="absolute top-4 left-4 z-10"');
  });
});
