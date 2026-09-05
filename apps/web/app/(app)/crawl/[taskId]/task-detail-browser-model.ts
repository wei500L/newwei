/**
 * Crawl Task Detail 浏览器形态模型（FE-批5A：自 task-detail.tsx 拆出）。
 * 纯函数模块：headers/cookies/托管浏览器目录/UA/UA 生成器/locale/
 * 时区/地理位置的窄化与摘要。
 */

import type { CrawlTaskConfig } from "./task-detail-config-core-model";
import type { TaskDetailTranslate } from "./task-detail-types";

function toTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

export function buildBrowserHeaders(config: CrawlTaskConfig): string[] {
  if (!Array.isArray(config?.browserHeaders)) {
    return [];
  }
  return (config?.browserHeaders as { name?: string; value?: string }[])
    .map((header) => {
      const name = typeof header?.name === "string" ? header.name : "";
      const value = typeof header?.value === "string" ? header.value : "";
      if (!name || !value) {
        return null;
      }
      return `${name}: ${value}`;
    })
    .filter((entry): entry is string => Boolean(entry));
}

export function buildBrowserCookies(config: CrawlTaskConfig): string[] {
  if (!Array.isArray(config?.browserCookies)) {
    return [];
  }
  return (
    config?.browserCookies as {
      name?: string;
      value?: string;
      domain?: string;
      path?: string;
    }[]
  )
    .map((cookie) => {
      const name = typeof cookie?.name === "string" ? cookie.name : "";
      const value = typeof cookie?.value === "string" ? cookie.value : "";
      const domain = typeof cookie?.domain === "string" ? cookie.domain : "";
      const path = typeof cookie?.path === "string" ? cookie.path : "";
      if (!name || !value || !domain) {
        return null;
      }
      const target = path ? `${domain}${path}` : domain;
      return `${name}=${value} @ ${target}`;
    })
    .filter((entry): entry is string => Boolean(entry));
}

export function resolveManagedBrowserProfile(config: CrawlTaskConfig): string | null {
  if (!config || typeof config.userDataDir !== "string") {
    return null;
  }
  return toTrimmedString(config.userDataDir);
}

export function resolveUserAgentValue(config: CrawlTaskConfig): string | null {
  if (!config || typeof config.userAgent !== "string") {
    return null;
  }
  return toTrimmedString(config.userAgent);
}

export function buildUserAgentGeneratorSummary(
  config: CrawlTaskConfig,
  t: TaskDetailTranslate,
): string | null {
  const raw = config?.userAgentGenerator;
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const generator = raw as Record<string, unknown>;
  const parts: string[] = [];
  const platform =
    typeof generator.platform === "string" ? generator.platform : null;
  if (platform) {
    parts.push(
      t("crawl.detail.userAgentGenerator.platform", { value: platform }),
    );
  }
  const browser =
    typeof generator.browser === "string" ? generator.browser : null;
  if (browser) {
    parts.push(
      t("crawl.detail.userAgentGenerator.browser", { value: browser }),
    );
  }
  const deviceType =
    typeof generator.deviceType === "string" ? generator.deviceType : null;
  if (deviceType) {
    parts.push(
      t("crawl.detail.userAgentGenerator.device", { value: deviceType }),
    );
  }
  const locale =
    typeof generator.locale === "string" ? generator.locale : null;
  if (locale) {
    parts.push(
      t("crawl.detail.userAgentGenerator.locale", { value: locale }),
    );
  }
  return parts.length ? parts.join(" • ") : null;
}

export function resolveBrowserLocale(config: CrawlTaskConfig): string | null {
  if (!config || typeof config.locale !== "string") {
    return null;
  }
  return toTrimmedString(config.locale);
}

export function resolveTimezonePreference(config: CrawlTaskConfig): string | null {
  if (!config || typeof config.timezoneId !== "string") {
    return null;
  }
  return toTrimmedString(config.timezoneId);
}

export function buildGeolocationSummary(
  config: CrawlTaskConfig,
): string | null {
  const raw = config?.geolocation;
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const geo = raw as Record<string, unknown>;
  const lat = typeof geo.latitude === "number" ? geo.latitude : null;
  const lon = typeof geo.longitude === "number" ? geo.longitude : null;
  if (lat == null || lon == null) {
    return null;
  }
  const accuracy = typeof geo.accuracy === "number" ? geo.accuracy : null;
  const location = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  return accuracy != null
    ? `${location} (±${Math.round(accuracy)}m)`
    : location;
}
