import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

describe("situation monitor scope recovery", () => {
  it("keeps frontend defaults aligned on all-items scope", () => {
    const syncSource = read("app/(app)/components/user-ui-settings-sync.tsx");
    const storeSource = read("store/situation-monitor-settings.ts");

    expect(syncSource).toContain('scope: "all",');
    expect(storeSource).toContain('scope: "all",');
  });

  it("offers a tagged-empty recovery action and uses API error extraction", () => {
    const contentSource = read("app/(app)/situation-monitor/situation-monitor-content.tsx");

    expect(contentSource).toContain('scopeOverride?: "tagged" | "all";');
    expect(contentSource).toContain("const requestedScope = options?.scopeOverride ?? scope;");
    expect(contentSource).toContain("scope: requestedScope,");
    expect(contentSource).toContain('message={t("situationMonitor.scopeRecovery.title"');
    expect(contentSource).toContain('setScope("all");');
    expect(contentSource).toContain('void load({ scopeOverride: "all" });');
    expect(contentSource).toContain("extractApiError(err).message ||");
  });
});
