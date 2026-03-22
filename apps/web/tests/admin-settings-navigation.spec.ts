import { describe, expect, it } from "vitest";

import {
  buildAdminSettingsPanelSelectionHref,
  buildAdminSettingsHref,
  getAdminSettingsPageDescriptionKey,
  getAdminSettingsPanelDescriptionKey,
  getVisibleAdminSettingsPages,
  getVisibleAdminSettingsPanels,
  resolveAdminSettingsPageIdFromPathname,
  resolveVisibleAdminSettingsPanelId,
} from "../app/(app)/admin/settings/settings-navigation";

describe("admin settings navigation", () => {
  it("builds canonical workspace links with panel and query params", () => {
    expect(
      buildAdminSettingsHref({
        page: "ingestion",
        panel: "news-source-runtime-secrets",
        query: { sourceId: "cnn", configuredOnly: true, ignored: false },
      }),
    ).toBe(
      "/admin/settings/ingestion?panel=news-source-runtime-secrets&sourceId=cnn&configuredOnly=true",
    );
  });

  it("limits review-only users to the knowledge page and review panel", () => {
    const pages = getVisibleAdminSettingsPages(["knowledgegraph.review"]);

    expect(pages.map((page) => page.id)).toEqual(["knowledge"]);
    expect(
      getVisibleAdminSettingsPanels("knowledge", ["knowledgegraph.review"]).map(
        (panel) => panel.id,
      ),
    ).toEqual(["knowledge-graph-review"]);
  });

  it("resolves the active workspace page from pathname", () => {
    expect(resolveAdminSettingsPageIdFromPathname("/admin/settings")).toBeNull();
    expect(resolveAdminSettingsPageIdFromPathname("/admin/settings/news")).toBe(
      "news",
    );
  });

  it("resolves panel selection only when the target panel is visible", () => {
    const visiblePanels = getVisibleAdminSettingsPanels("knowledge", [
      "knowledgegraph.review",
    ]);

    expect(
      resolveVisibleAdminSettingsPanelId(
        "knowledge-graph-review",
        visiblePanels,
      ),
    ).toBe("knowledge-graph-review");
    expect(
      resolveVisibleAdminSettingsPanelId("knowledge-graph", visiblePanels),
    ).toBeNull();
    expect(resolveVisibleAdminSettingsPanelId("unknown", visiblePanels)).toBeNull();
  });

  it("preserves contextual query params when selecting a panel", () => {
    expect(
      buildAdminSettingsPanelSelectionHref(
        "/admin/settings/ingestion",
        "sourceId=cnn&configuredOnly=1",
        "news-source-runtime-secrets",
      ),
    ).toBe(
      "/admin/settings/ingestion?sourceId=cnn&configuredOnly=1&panel=news-source-runtime-secrets",
    );
  });

  it("exposes the multi-tenant scheduler panel on the ingestion workspace page", () => {
    expect(
      getVisibleAdminSettingsPanels("ingestion", ["settings.manage"]).map(
        (panel) => panel.id,
      ),
    ).toContain("multi-tenant-schedulers");
  });

  it("exposes stable description keys for pages and panels", () => {
    expect(getAdminSettingsPageDescriptionKey("security")).toBe(
      "adminSettings.pages.security.description",
    );
    expect(getAdminSettingsPanelDescriptionKey("crawl-client")).toBe(
      "adminSettings.panels.crawl-client.description",
    );
  });
});
