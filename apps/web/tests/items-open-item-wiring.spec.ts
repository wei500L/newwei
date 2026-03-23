import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

describe("items open item wiring", () => {
  it("keeps list view navigation wired to the item detail route", () => {
    const source = read("app/(app)/items/items-view.tsx");

    expect(source).toContain("onClick={() => router.push(`/items/${record.id}`)}");
    expect(source).toContain('rowKey="id"');
  });

  it("disables table virtualization for the list view action column", () => {
    const source = read("app/(app)/items/items-view.tsx");

    expect(source).toContain("scroll={listTableScroll}");
    expect(source).not.toContain("const listTableVirtualEnabled");
    expect(source).not.toContain("virtual={listTableVirtualEnabled}");
  });
});
