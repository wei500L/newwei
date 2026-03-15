import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

describe("system settings routing", () => {
  it("redirects the legacy settings root to the workspace root", () => {
    const source = read("app/(app)/settings/page.tsx");

    expect(source).toContain('redirect("/admin/settings")');
  });

  it("redirects the legacy system settings route to the workspace root", () => {
    const source = read("app/(app)/settings/system/page.tsx");

    expect(source).toContain('redirect("/admin/settings")');
    expect(source).not.toContain("/admin/system");
  });

  it("redirects the legacy admin system route to the workspace root", () => {
    const source = read("app/(app)/admin/system/page.tsx");

    expect(source).toContain('redirect("/admin/settings")');
  });

  it("redirects the legacy admin storage route to the ingestion storage panel", () => {
    const source = read("app/(app)/admin/storage/page.tsx");

    expect(source).toContain('redirect("/admin/settings/ingestion?panel=storage")');
  });
});
