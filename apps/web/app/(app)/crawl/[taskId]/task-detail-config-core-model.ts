/**
 * Crawl Task Detail 核心配置模型（FE-批5A：自 task-detail.tsx 拆出）。
 * 纯函数模块：无 React、无 "use client"；输入为已解析的 config JSON
 * （Record<string, unknown> | null），输出语义化 view model。真实动态
 * JSON 的窄化集中在本模块与同级 model，展示层不重复解析。
 */

import {
  findUnsupportedProxyIssues,
  type CrawlConfigPolicyIssue,
} from "@/lib/crawl-config-policy";
import { classifyHeadedIssue } from "@/lib/crawl-runtime";

import type { TaskDetailTranslate } from "./task-detail-types";

export type CrawlTaskConfig = Record<string, unknown> | null;

export function parseTaskConfig(configJson?: string | null): CrawlTaskConfig {
  if (!configJson) {
    return null;
  }
  try {
    return JSON.parse(configJson) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function findTaskProxyIssues(config: CrawlTaskConfig): CrawlConfigPolicyIssue[] {
  return findUnsupportedProxyIssues(config, "task.config");
}

export function resolvePipelineJobId(config: CrawlTaskConfig): string | null {
  if (!config) {
    return null;
  }
  const value = config.pipelineJobId;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function isHeadedTaskConfig(config: CrawlTaskConfig): boolean {
  return config?.headless === false;
}

export function classifyTaskLastErrorHeadedIssue(lastError?: string | null) {
  return classifyHeadedIssue(lastError ?? undefined);
}

export interface VirtualScrollSummary {
  containerSelector: string;
  scrollCount: number | null;
  waitAfterScrollMs: number | null;
  scrollBy: string | "page_height" | null;
}

export function buildVirtualScrollSummary(
  config: CrawlTaskConfig,
): VirtualScrollSummary | null {
  if (
    !config ||
    typeof config.virtualScroll !== "object" ||
    !config.virtualScroll
  ) {
    return null;
  }
  const value = config.virtualScroll as Record<string, unknown>;
  const containerSelector =
    typeof value.containerSelector === "string" &&
    value.containerSelector.trim().length > 0
      ? value.containerSelector.trim()
      : "body";
  const scrollCount =
    typeof value.scrollCount === "number" &&
    Number.isFinite(value.scrollCount)
      ? value.scrollCount
      : null;
  const waitAfterScrollMs =
    typeof value.waitAfterScrollMs === "number" &&
    Number.isFinite(value.waitAfterScrollMs)
      ? value.waitAfterScrollMs
      : null;
  const scrollByRaw = value.scrollBy;
  const scrollBy =
    typeof scrollByRaw === "number"
      ? scrollByRaw
      : typeof scrollByRaw === "string"
        ? scrollByRaw === "viewport"
          ? "page_height"
          : scrollByRaw
        : null;
  return {
    containerSelector,
    scrollCount,
    waitAfterScrollMs,
    scrollBy,
  };
}

export function resolveQualityProfileValue(config: CrawlTaskConfig): string | null {
  if (!config || typeof config.qualityProfile !== "string") {
    return null;
  }
  const normalized = config.qualityProfile.trim().toLowerCase();
  if (
    normalized === "quality_first" ||
    normalized === "balanced" ||
    normalized === "speed_first"
  ) {
    return normalized;
  }
  return null;
}

export function resolvePageTypeHintValue(config: CrawlTaskConfig): string | null {
  if (!config || typeof config.pageTypeHint !== "string") {
    return null;
  }
  const normalized = config.pageTypeHint.trim().toLowerCase();
  if (
    normalized === "auto" ||
    normalized === "list" ||
    normalized === "detail"
  ) {
    return normalized;
  }
  return null;
}

export function resolveAutoExpandDetailsValue(
  config: CrawlTaskConfig,
): boolean | null {
  return typeof config?.autoExpandDetails === "boolean"
    ? config.autoExpandDetails
    : null;
}

/** qualityProfile 值 → i18n label（策略 Tag 与展开字段段共用）。 */
export function qualityProfileLabel(
  value: string | null,
  t: TaskDetailTranslate,
): string | null {
  if (!value) {
    return null;
  }
  if (value === "quality_first") {
    return t("crawl.settings.qualityProfileOptions.qualityFirst");
  }
  if (value === "speed_first") {
    return t("crawl.settings.qualityProfileOptions.speedFirst");
  }
  return t("crawl.settings.qualityProfileOptions.balanced");
}

/** pageTypeHint 值 → i18n label（策略 Tag 与展开字段段共用）。 */
export function pageTypeHintLabel(
  value: string | null,
  t: TaskDetailTranslate,
): string | null {
  if (!value) {
    return null;
  }
  if (value === "list") {
    return t("crawl.settings.pageTypeHintOptions.list");
  }
  if (value === "detail") {
    return t("crawl.settings.pageTypeHintOptions.detail");
  }
  return t("crawl.settings.pageTypeHintOptions.auto");
}

/** 代理路由摘要：legacy proxyConfig/proxyUrl 标记为不支持，否则直连。 */
export function buildProxySummary(
  config: CrawlTaskConfig,
  t: TaskDetailTranslate,
): string {
  if (!config) {
    return t("crawl.detail.proxy.direct");
  }
  const proxyUrl =
    typeof config.proxyUrl === "string" && config.proxyUrl.length > 0
      ? config.proxyUrl
      : null;
  const proxyConfig = config.proxyConfig as
    | { server?: string; username?: string; password?: string }
    | undefined;
  if (proxyConfig?.server) {
    return t("crawl.detail.proxy.unsupportedLegacy", {
      value: proxyConfig.server,
    });
  }
  if (proxyUrl) {
    return t("crawl.detail.proxy.unsupportedLegacy", {
      value: proxyUrl,
    });
  }
  return t("crawl.detail.proxy.direct");
}

/** 策略信号 view model：策略 Tag 卡片与展开字段段的共享单一派生。 */
export interface StrategyViewModel {
  scanFullPage: boolean;
  virtualScroll: VirtualScrollSummary | null;
  qualityProfileValue: string | null;
  pageTypeHintValue: string | null;
  autoExpandDetails: boolean | null;
}

export function buildStrategyViewModel(config: CrawlTaskConfig): StrategyViewModel {
  return {
    scanFullPage: Boolean(config?.scanFullPage),
    virtualScroll: buildVirtualScrollSummary(config),
    qualityProfileValue: resolveQualityProfileValue(config),
    pageTypeHintValue: resolvePageTypeHintValue(config),
    autoExpandDetails: resolveAutoExpandDetailsValue(config),
  };
}
