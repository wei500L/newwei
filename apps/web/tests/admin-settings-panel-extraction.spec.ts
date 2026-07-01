import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");
const exists = (relativePath: string) =>
  fs.existsSync(path.resolve(webRoot, relativePath));

describe("admin settings shared panel extraction", () => {
  it("routes shared workspace panels through dedicated component modules", () => {
    const source = read(
      "components/settings/workspace-shared-settings-panels.ts",
    );

    expect(source).toContain("akshare-gateway-settings-panel");
    expect(source).toContain("audit-log-retention-panel");
    expect(source).toContain("auth-cache-settings-panel");
    expect(source).toContain("crawl-client-settings-panel");
    expect(source).toContain("news-prompt-settings-panel");
    expect(source).toContain("rate-limit-settings-panel");
    expect(source).toContain("storage-settings-content");
    expect(source).toContain("AkshareGatewaySettingsPanel");
    expect(source).not.toContain("app/(app)/admin/storage/storage-content");
    expect(source).not.toContain("@/app/(app)");
  });

  it("removes legacy page-level settings implementations once shared modules exist", () => {
    expect(
      exists("app/(app)/settings/system/system-settings-content.tsx"),
    ).toBe(false);
    expect(exists("app/(app)/settings/settings-content.tsx")).toBe(false);
    expect(exists("app/(app)/admin/storage/storage-content.tsx")).toBe(false);
  });

  it("keeps admin workspace shells pointed at shared content modules instead of page-level implementations", () => {
    const adminSectionSource = read(
      "app/(app)/admin/settings/[section]/page.tsx",
    );
    const accessComponentSource = read(
      "components/settings/access-settings-content.tsx",
    );
    const storageComponentSource = read(
      "components/settings/storage-settings-content.tsx",
    );

    expect(adminSectionSource).toContain(
      "@/components/settings/access-settings-content",
    );
    expect(adminSectionSource).toContain(
      "params: Promise<AdminSettingsSectionPageParams>",
    );
    expect(adminSectionSource).toContain("const { section } = await params");
    expect(adminSectionSource).not.toContain(
      "@/app/(app)/settings/settings-content",
    );
    expect(accessComponentSource).toContain("@/lib/admin-settings-panel-links");
    expect(accessComponentSource).not.toContain("@/app/(app)");
    expect(storageComponentSource).not.toContain("@/app/(app)");
  });

  it("surfaces separate preflight and post-clean quality thresholds", () => {
    const panelSource = read(
      "components/settings/news-extraction-settings-panel.tsx",
    );
    const graphqlSource = read("graphql/settings.graphql");

    expect(panelSource).toContain('name={["preflightGate", "minQualityScore"]}');
    expect(panelSource).toContain(
      "settings.newsExtraction.fields.minPreflightQualityScore",
    );
    expect(panelSource).toContain(
      "settings.newsExtraction.fields.minCleanedQualityScore",
    );
    expect(graphqlSource).toMatch(
      /preflightGate\s*\{[\s\S]*minWordCount[\s\S]*minQualityScore[\s\S]*rejectBotChallenge/,
    );
  });
});
