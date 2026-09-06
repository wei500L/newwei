/**
 * Crawl Task Detail 运行时参数模型（FE-批5A：自 task-detail.tsx 拆出）。
 * 纯函数模块：JS 步骤/等待条件/超时与延迟/信号量/会话与存储态摘要。
 */

import type { CrawlTaskConfig } from "./task-detail-config-core-model";
import { shortenScript } from "./task-detail-formatters";
import type { TaskDetailTranslate } from "./task-detail-types";

export function buildDynamicJsSteps(config: CrawlTaskConfig): string[] {
  if (!config) {
    return [];
  }
  if (Array.isArray(config.jsCode)) {
    return (config.jsCode as string[]).filter(
      (entry) => typeof entry === "string",
    );
  }
  if (typeof config.jsCode === "string") {
    const trimmed = config.jsCode.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}

export function buildWaitCondition(config: CrawlTaskConfig): string | null {
  if (!config) {
    return null;
  }
  if (
    typeof config.waitForScript === "string" &&
    config.waitForScript.trim().length
  ) {
    return `js:${config.waitForScript.trim()}`;
  }
  if (
    typeof config.waitForSelector === "string" &&
    config.waitForSelector.trim().length
  ) {
    return config.waitForSelector.trim();
  }
  return null;
}

export function resolveWaitUntilValue(config: CrawlTaskConfig): string | null {
  if (!config || typeof config.waitUntil !== "string") {
    return null;
  }
  const normalized = config.waitUntil.trim().toLowerCase();
  if (
    normalized === "domcontentloaded" ||
    normalized === "load" ||
    normalized === "networkidle" ||
    normalized === "commit"
  ) {
    return normalized;
  }
  return null;
}

export function buildWaitUntilSummary(
  waitUntilValue: string | null,
  t: TaskDetailTranslate,
): string | null {
  if (!waitUntilValue) {
    return null;
  }
  if (waitUntilValue === "domcontentloaded") {
    return t("crawl.dynamic.waitUntilOptions.domcontentloaded");
  }
  if (waitUntilValue === "networkidle") {
    return t("crawl.dynamic.waitUntilOptions.networkidle");
  }
  if (waitUntilValue === "commit") {
    return t("crawl.dynamic.waitUntilOptions.commit");
  }
  return t("crawl.dynamic.waitUntilOptions.load");
}

function toOptionalNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

interface CrawlRuntimeParams {
  waitTimeoutMs: number | null;
  pageTimeoutMs: number | null;
  delayBeforeReturnHtmlMs: number | null;
  meanDelayMs: number | null;
  maxDelayRangeMs: number | null;
  semaphoreCount: number | null;
  removeFormsEnabled: boolean | null;
}

export function buildRuntimeParams(config: CrawlTaskConfig): CrawlRuntimeParams {
  return {
    waitTimeoutMs: toOptionalNumber(config?.waitForTimeoutMs),
    pageTimeoutMs: toOptionalNumber(config?.pageTimeoutMs),
    delayBeforeReturnHtmlMs: toOptionalNumber(config?.delayBeforeReturnHtmlMs),
    meanDelayMs: toOptionalNumber(config?.meanDelayMs),
    maxDelayRangeMs: toOptionalNumber(config?.maxDelayRangeMs),
    semaphoreCount: toOptionalNumber(config?.semaphoreCount),
    removeFormsEnabled:
      typeof config?.removeForms === "boolean" ? config.removeForms : null,
  };
}

export function resolveSessionIdentifier(config: CrawlTaskConfig): string | null {
  if (!config) {
    return null;
  }
  return toTrimmedOrNull(config.sessionId);
}

export function buildStorageStatePreview(config: CrawlTaskConfig): string | null {
  if (!config) {
    return null;
  }
  const raw = toTrimmedOrNull(config.storageState);
  return raw ? shortenScript(raw) : null;
}

function toTrimmedOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}
