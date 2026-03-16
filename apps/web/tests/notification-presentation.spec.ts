import fs from "node:fs";
import path from "node:path";

import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import { NotificationType } from "../graphql/generated";
import {
  formatNotificationPresentation,
  formatNotificationStreamError,
  resolveNotificationLink,
} from "../lib/notifications";

const webRoot = path.resolve(__dirname, "..");

const readLocale = (name: "en" | "zh") =>
  JSON.parse(
    fs.readFileSync(path.resolve(webRoot, `lib/locales/${name}.json`), "utf8"),
  ) as Record<string, unknown>;

const getDeepValue = (
  value: Record<string, unknown>,
  pathKey: string,
): unknown =>
  pathKey.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    return (current as Record<string, unknown>)[segment];
  }, value);

const interpolate = (template: string, options?: Record<string, unknown>) =>
  template.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (_match, key) => {
    const value = options?.[key];
    return value === undefined || value === null ? "" : String(value);
  });

const createTranslator = (translations: Record<string, unknown>) =>
  ((key: string, options?: Record<string, unknown>) => {
    const raw = getDeepValue(translations, key);
    if (typeof raw === "string") {
      return interpolate(raw, options);
    }
    if (typeof options?.defaultValue === "string") {
      return interpolate(options.defaultValue, options);
    }
    return key;
  }) as TFunction;

describe("notification presentation", () => {
  const enTranslator = createTranslator(readLocale("en"));
  const zhTranslator = createTranslator(readLocale("zh"));

  it("formats semantic crawl completion copy in zh-CN", () => {
    const copy = formatNotificationPresentation(
      {
        type: NotificationType.CrawlCompleted,
        title: "Crawl completed: legacy",
        body: "legacy body",
        data: {
          presentation: {
            kind: "crawl_completed",
            params: {
              taskLabel: "重点站点抓取",
              inserted: 12,
              skipped: 3,
              retryableFailures: 1,
            },
          },
        },
      },
      "zh-CN",
      zhTranslator,
    );

    expect(copy.title).toBe("采集完成：重点站点抓取");
    expect(copy.body).toBe("本次新增 12 条，跳过 3 条，可重试失败 1 次。");
    expect(copy.toastText).toBe("采集完成：重点站点抓取");
  });

  it("formats semantic alert copy in en-US", () => {
    const copy = formatNotificationPresentation(
      {
        type: NotificationType.AlertTriggered,
        title: "Alert triggered: legacy",
        body: "legacy body",
        data: {
          presentation: {
            kind: "alert_triggered",
            params: {
              ruleName: "GDP surprise",
              metricValue: 7.25,
              changePercent: 3.5,
              context: {
                itemName: "China GDP",
                sourceName: "National Bureau of Statistics",
              },
            },
          },
        },
      },
      "en-US",
      enTranslator,
    );

    expect(copy.title).toBe("Alert triggered: GDP surprise");
    expect(copy.body).toBe(
      "Triggered alert condition: current value 7.25, change 3.5%, context China GDP · National Bureau of Statistics.",
    );
  });

  it("preserves the original trigger condition in semantic alert copy", () => {
    const copy = formatNotificationPresentation(
      {
        type: NotificationType.AlertTriggered,
        title: "Alert triggered: legacy",
        body: "Value 12 is >= 10",
        data: {
          presentation: {
            kind: "alert_triggered",
            technicalDetail: "Value 12 is >= 10",
            params: {
              ruleName: "Threshold breach",
              metricValue: 12,
              changePercent: 20,
              context: {
                itemName: "CPI",
              },
            },
          },
        },
      },
      "en-US",
      enTranslator,
    );

    expect(copy.title).toBe("Alert triggered: Threshold breach");
    expect(copy.body).toBe(
      "Value 12 is >= 10 Triggered alert condition: current value 12, change 20%, context CPI.",
    );
  });

  it("uses classification quality summaries from semantic params", () => {
    const copy = formatNotificationPresentation(
      {
        type: NotificationType.System,
        title: "Classification quality threshold exceeded",
        body: "legacy body",
        data: {
          presentation: {
            kind: "classification_quality_threshold_exceeded",
            technicalDetail:
              "Latency alerts: llm p95=1200ms > 1000ms | Category gate alerts: reject_rate=35% > 20%",
            params: {
              window: "24h",
              latencySummary: "llm p95=1200ms > 1000ms",
              gateSummary: "reject_rate=35% > 20%",
            },
          },
        },
      },
      "en-US",
      enTranslator,
    );

    expect(copy.title).toBe("Classification quality threshold exceeded");
    expect(copy.body).toBe(
      "Latency: llm p95=1200ms > 1000ms | Category gates: reject_rate=35% > 20%",
    );
  });

  it("localizes built-in analysis labels for semantic copy", () => {
    const copy = formatNotificationPresentation(
      {
        type: NotificationType.AnalysisCompleted,
        title: "Analysis completed: legacy",
        body: "legacy body",
        data: {
          presentation: {
            kind: "analysis_completed",
            params: {
              analysisType: "correlation",
              summary: "已生成相关性摘要",
            },
          },
        },
      },
      "zh-CN",
      zhTranslator,
    );

    expect(copy.title).toBe("分析完成：相关性分析");
    expect(copy.body).toBe("已生成相关性摘要");
  });

  it("falls back to legacy title and body when no presentation payload exists", () => {
    const copy = formatNotificationPresentation(
      {
        type: NotificationType.System,
        title: "Legacy title",
        body: "Legacy body",
        data: {
          sourceId: "source-1",
        },
      },
      "zh-CN",
      zhTranslator,
    );

    expect(copy).toEqual({
      title: "Legacy title",
      body: "Legacy body",
      toastText: "Legacy title",
    });
  });

  it("maps stable socket error codes to localized messages", () => {
    expect(
      formatNotificationStreamError(
        { code: "TOO_MANY_CONNECTIONS", message: "Too many connections" },
        zhTranslator,
        "socket",
      ),
    ).toBe("通知连接数已达上限，请稍后再试。");

    expect(
      formatNotificationStreamError(
        { code: "UNAUTHORIZED", message: "Unauthorized" },
        enTranslator,
        "connect",
      ),
    ).toBe("Notification connection expired. Please sign in again.");
  });

  it("uses generic localized fallback for unknown connection errors", () => {
    expect(
      formatNotificationStreamError(
        { message: "websocket error" },
        zhTranslator,
        "connect",
      ),
    ).toBe("暂时无法连接通知服务，请稍后再试。");
  });

  it("maps network failures to localized connection messages", () => {
    expect(
      formatNotificationStreamError(
        { message: "Failed to fetch" },
        zhTranslator,
        "connect",
      ),
    ).toBe("当前无法连接通知服务，请检查网络后重试。");
  });

  it("resolves links from semantic presentation params", () => {
    const link = resolveNotificationLink(
      {
        presentation: {
          kind: "analysis_completed",
          params: {
            analysisId: "analysis-123",
          },
        },
      },
      zhTranslator,
    );

    expect(link).toEqual({
      href: "/dashboard?panel=analysis&analysisId=analysis-123",
      label: "查看分析",
    });
  });

  it("hides alert deep links when the viewer lacks alerts.read", () => {
    const link = resolveNotificationLink(
      {
        alertEventId: "evt-123",
      },
      enTranslator,
      { canReadAlerts: false },
    );

    expect(link).toBeNull();
  });

  it("preserves alert deep links for viewers with alerts.read", () => {
    const link = resolveNotificationLink(
      {
        alertEventId: "evt-123",
      },
      enTranslator,
      { canReadAlerts: true },
    );

    expect(link).toEqual({
      href: "/alerts?eventId=evt-123",
      label: "Open alert",
    });
  });
});
