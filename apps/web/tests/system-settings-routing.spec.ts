import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

describe("system settings routing", () => {
  it("preserves search params when redirecting the legacy system settings route", () => {
    const source = read("app/(app)/settings/system/page.tsx");

    expect(source).toContain("searchParams?: Promise<SystemSettingsPageSearchParams>");
    expect(source).toContain("const next = new URLSearchParams()");
    expect(source).toContain("next.append(key, entry)");
    expect(source).toContain(
      'redirect(nextQuery ? `/admin/system?${nextQuery}` : "/admin/system")',
    );
  });
});
