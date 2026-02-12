import { describe, expect, it } from "vitest";

import {
  CRAWL_TASK_TEMPLATE_DESCRIPTORS,
  buildCrawlTaskTemplateValues,
  buildNewsSourceCloudflarePresetValues,
  buildNewsSourceReutersCfPresetValues,
  resolveCrawlTaskTemplateKey
} from "../lib/crawl-presets";

describe("crawl presets", () => {
  it("exposes all expected task template descriptors", () => {
    const keys = CRAWL_TASK_TEMPLATE_DESCRIPTORS.map((entry) => entry.key);
    expect(keys).toEqual(["general", "news", "reuters_cf", "forum", "social"]);
  });

  it("resolves known template keys and rejects unknown values", () => {
    expect(resolveCrawlTaskTemplateKey("reuters_cf")).toBe("reuters_cf");
    expect(resolveCrawlTaskTemplateKey("unknown")).toBeNull();
    expect(resolveCrawlTaskTemplateKey(undefined)).toBeNull();
  });

  it("builds Reuters+Cloudflare task preset with hardened anti-bot options", () => {
    const values = buildCrawlTaskTemplateValues("reuters_cf", { canWriteItems: true });

    expect(values.ingestToItems).toBe(true);
    expect(values.headless).toBe(false);
    expect(values.enableUndetectedBrowser).toBe(true);
    expect(values.enableStealthMode).toBe(true);
    expect(values.antiBotMode).toBe("enabled");
    expect(values.waitForSelector).toBe("article");
    expect(values.pageTimeoutMs).toBe(120000);
    expect(values.cleanMarkdown?.cssSelector).toContain("article");
  });

  it("keeps general task preset conservative", () => {
    const values = buildCrawlTaskTemplateValues("general", { canWriteItems: true });

    expect(values.ingestToItems).toBe(false);
    expect(values.antiBotMode).toBe("auto");
    expect(values.scanFullPage).toBe(false);
    expect(values.userAgentMode).toBe("random");
    expect(values.enableStealthMode).toBe(true);
    expect(values.simulateUser).toBe(true);
    expect(values.overrideNavigator).toBe(true);
    expect(values.qualityProfile).toBe("quality_first");
  });

  it("builds news source cloudflare preset", () => {
    const values = buildNewsSourceCloudflarePresetValues();

    expect(values).toEqual({
      crawlHeadlessMode: "headed",
      crawlUndetectedMode: "enable",
      crawlStealthMode: "enable",
      crawlAntiBotMode: "enable"
    });
  });

  it("builds news source Reuters+CF preset", () => {
    const values = buildNewsSourceReutersCfPresetValues();

    expect(values.crawlHeadlessMode).toBe("headed");
    expect(values.crawlUndetectedMode).toBe("enable");
    expect(values.crawlStealthMode).toBe("enable");
    expect(values.crawlAntiBotMode).toBe("enable");
    expect(values.crawlQualityProfile).toBe("quality_first");
    expect(values.crawlPageTypeHint).toBe("detail");
    expect(values.crawlMarkdownContentSource).toBe("cleaned_html");
  });
});
