/**
 * Crawl Task Detail 多 URL 策略模型（FE-批5A：自 task-detail.tsx 拆出）。
 * 纯函数模块：additionalUrls 与 multiUrlConfigs 窄化、覆盖项摘要格式化。
 */

import type { CrawlTaskConfig } from "./task-detail-config-core-model";
import { shortenScript } from "./task-detail-formatters";
import type { TaskDetailTranslate } from "./task-detail-types";

export function buildAdditionalUrls(config: CrawlTaskConfig): string[] {
  if (!config || !Array.isArray(config.additionalUrls)) {
    return [];
  }
  return config.additionalUrls
    .map((entry) => (typeof entry === "string" ? entry : null))
    .filter((entry): entry is string => Boolean(entry));
}

interface MultiUrlConfigView {
  name?: string;
  matcher?: {
    matchMode?: string;
    patterns?: string[];
  };
  urls?: string[];
  options?: Record<string, unknown>;
}

export function buildMultiUrlConfigs(
  config: CrawlTaskConfig,
): MultiUrlConfigView[] {
  if (!config || !Array.isArray(config.multiUrlConfigs)) {
    return [];
  }
  return config.multiUrlConfigs.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null,
  );
}

export function formatMultiUrlOverrides(
  options: Record<string, unknown> | undefined,
  t: TaskDetailTranslate,
): string | null {
  if (!options) {
    return null;
  }
  const entries = Object.entries(options).filter(
    ([, value]) => value !== undefined && value !== null,
  );
  if (!entries.length) {
    return null;
  }
  const preferredKeys = [
    "cacheMode",
    "waitUntil",
    "waitForTimeoutMs",
    "pageTimeoutMs",
    "delayBeforeReturnHtmlMs",
    "meanDelayMs",
    "maxDelayRangeMs",
    "semaphoreCount",
    "removeForms",
    "scanFullPage",
    "simulateUser",
    "overrideNavigator",
  ];
  const formatValue = (value: unknown) => {
    if (typeof value === "string") {
      return value.length > 80 ? shortenScript(value) : value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (Array.isArray(value)) {
      if (value.length <= 3) {
        return value.map((entry) => String(entry)).join(", ");
      }
      return `${value
        .slice(0, 3)
        .map((entry) => String(entry))
        .join(", ")}…`;
    }
    if (value && typeof value === "object") {
      const serialized = JSON.stringify(value);
      return serialized.length > 120
        ? `${serialized.slice(0, 117)}…`
        : serialized;
    }
    return String(value);
  };
  const prioritized = preferredKeys
    .filter((key) => key in options)
    .map((key) => `${key}=${formatValue(options[key])}`);
  const preferredKeySet = new Set(preferredKeys);
  const remainingCount = entries.filter(
    ([key]) => !preferredKeySet.has(key),
  ).length;
  if (remainingCount > 0) {
    prioritized.push(
      t("crawl.detail.multiUrl.additionalOverrides", {
        count: remainingCount,
      }),
    );
  }
  return prioritized.join(" • ");
}
