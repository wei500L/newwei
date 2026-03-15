import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

describe("admin logs routing", () => {
  it("serves the unified logs workspace from /admin/logs", () => {
    const source = read("app/(app)/admin/logs/page.tsx");

    expect(source).toContain('redirect("/login")');
    expect(source).toContain("return <AdminLogsContent />;");
  });

  it("redirects legacy error page to the unified logs workspace", () => {
    const source = read("app/(app)/admin/errors/page.tsx");

    expect(source).toContain('redirect(buildAdminLogsHref({ tab: "errors" }))');
  });

  it("redirects legacy audit page to the unified logs workspace", () => {
    const source = read("app/(app)/admin/audit-logs/page.tsx");

    expect(source).toContain('redirect(buildAdminLogsHref({ tab: "audit" }))');
  });

  it("removes legacy standalone error and audit content components", () => {
    expect(fs.existsSync(path.resolve(webRoot, "app/(app)/admin/errors/errors-content.tsx"))).toBe(false);
    expect(fs.existsSync(path.resolve(webRoot, "app/(app)/admin/audit-logs/audit-logs-content.tsx"))).toBe(false);
  });
});
