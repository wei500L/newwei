import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

describe("admin search telemetry wiring", () => {
  it("adds an admin console quick link", () => {
    const source = read("app/(app)/admin/admin-content.tsx");

    expect(source).toContain('key: "searchTelemetry"');
    expect(source).toContain('href: "/admin/search-telemetry"');
  });

  it("fetches telemetry summary from the admin endpoint", () => {
    const source = read("app/(app)/admin/search-telemetry/search-telemetry-content.tsx");

    expect(source).toContain("admin/search-telemetry/summary");
    expect(source).toContain("Daily trend");
    expect(source).not.toContain("surface !== \"all\"");
    expect(source).toContain("Surface filtering is temporarily unavailable");
  });
});
