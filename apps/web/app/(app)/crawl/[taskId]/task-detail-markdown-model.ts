/**
 * Crawl Task Detail Markdown 生成策略模型（FE-批5A：自 task-detail.tsx 拆出）。
 * 纯函数模块：markdownOptions / markdownFilter / markdownStrategy /
 * cleanMarkdown 四组配置的解析与 i18n 摘要。
 */

import type { CrawlTaskConfig } from "./task-detail-config-core-model";
import type { TaskDetailTranslate } from "./task-detail-types";

function toOptionsRecord(
  config: CrawlTaskConfig,
  key: string,
): Record<string, unknown> | null {
  const value = config?.[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function buildMarkdownSummary(
  config: CrawlTaskConfig,
  t: TaskDetailTranslate,
): string {
  const markdownOptions = toOptionsRecord(config, "markdownOptions");
  if (!markdownOptions) {
    return t("crawl.detail.markdown.default");
  }
  const parts: string[] = [];
  if (typeof markdownOptions.contentSource === "string") {
    parts.push(
      t("crawl.detail.markdown.source", {
        source: markdownOptions.contentSource,
      }),
    );
  }
  if (typeof markdownOptions.ignoreLinks === "boolean") {
    parts.push(
      markdownOptions.ignoreLinks
        ? t("crawl.detail.markdown.ignoreLinks")
        : t("crawl.detail.markdown.keepLinks"),
    );
  }
  if (typeof markdownOptions.escapeHtml === "boolean") {
    parts.push(
      markdownOptions.escapeHtml
        ? t("crawl.detail.markdown.escapeHtml")
        : t("crawl.detail.markdown.renderHtml"),
    );
  }
  if (typeof markdownOptions.citations === "boolean") {
    parts.push(
      markdownOptions.citations
        ? t("crawl.detail.markdown.citationsEnabled")
        : t("crawl.detail.markdown.citationsDisabled"),
    );
  }
  if (typeof markdownOptions.bodyWidth === "number") {
    parts.push(
      t("crawl.detail.markdown.wrap", { width: markdownOptions.bodyWidth }),
    );
  }
  return parts.length
    ? parts.join(" • ")
    : t("crawl.detail.markdown.default");
}

export function buildMarkdownFilterSummary(
  config: CrawlTaskConfig,
  t: TaskDetailTranslate,
): string {
  const markdownFilter = toOptionsRecord(config, "markdownFilter");
  if (!markdownFilter || typeof markdownFilter.type !== "string") {
    return t("common.disabled");
  }
  const parts = [markdownFilter.type];
  if (markdownFilter.type === "bm25") {
    const queryValue =
      typeof markdownFilter.userQuery === "string"
        ? markdownFilter.userQuery
        : typeof markdownFilter.user_query === "string"
          ? (markdownFilter.user_query as string)
          : undefined;
    if (queryValue && queryValue.trim().length > 0) {
      parts.push(
        t("crawl.detail.markdownFilter.query", { query: queryValue }),
      );
    }
    const bm25ThresholdValue =
      typeof markdownFilter.bm25Threshold === "number"
        ? markdownFilter.bm25Threshold
        : typeof markdownFilter.bm25_threshold === "number"
          ? (markdownFilter.bm25_threshold as number)
          : undefined;
    if (typeof bm25ThresholdValue === "number") {
      parts.push(
        t("crawl.detail.markdownFilter.bm25Threshold", {
          value: bm25ThresholdValue,
        }),
      );
    }
    const languageValue =
      typeof markdownFilter.language === "string"
        ? markdownFilter.language
        : typeof markdownFilter.lang === "string"
          ? (markdownFilter.lang as string)
          : undefined;
    if (languageValue && languageValue.trim().length > 0) {
      parts.push(
        t("crawl.detail.markdownFilter.language", {
          language: languageValue,
        }),
      );
    }
    return parts.join(" • ");
  }
  if (typeof markdownFilter.threshold === "number") {
    parts.push(
      t("crawl.detail.markdownFilter.threshold", {
        value: markdownFilter.threshold,
      }),
    );
  }
  const thresholdTypeValue =
    typeof markdownFilter.thresholdType === "string"
      ? markdownFilter.thresholdType
      : typeof markdownFilter.threshold_type === "string"
        ? (markdownFilter.threshold_type as string)
        : undefined;
  if (thresholdTypeValue) {
    parts.push(
      t("crawl.detail.markdownFilter.mode", { mode: thresholdTypeValue }),
    );
  }
  const minWordValue =
    typeof markdownFilter.minWordThreshold === "number"
      ? markdownFilter.minWordThreshold
      : typeof markdownFilter.min_word_threshold === "number"
        ? (markdownFilter.min_word_threshold as number)
        : undefined;
  if (typeof minWordValue === "number") {
    parts.push(
      t("crawl.detail.markdownFilter.minWords", { count: minWordValue }),
    );
  }
  return parts.join(" • ");
}

export function buildMarkdownStrategySummary(
  config: CrawlTaskConfig,
  t: TaskDetailTranslate,
): string {
  const markdownStrategy = toOptionsRecord(config, "markdownStrategy");
  if (!markdownStrategy || typeof markdownStrategy.type !== "string") {
    return t("crawl.detail.markdownStrategy.default");
  }
  const type = markdownStrategy.type;
  const params =
    markdownStrategy.params && typeof markdownStrategy.params === "object"
      ? (markdownStrategy.params as Record<string, unknown>)
      : undefined;
  if (!params) {
    return type;
  }
  const json = JSON.stringify(params);
  const snippet = json.length > 80 ? `${json.slice(0, 80)}...` : json;
  return t("crawl.detail.markdownStrategy.withParams", { type, snippet });
}

export function buildCleanMarkdownSummary(
  config: CrawlTaskConfig,
  t: TaskDetailTranslate,
): string {
  const cleanMarkdownOptions = toOptionsRecord(config, "cleanMarkdown");
  if (!cleanMarkdownOptions) {
    return t("common.disabled");
  }
  const parts: string[] = [];
  if (
    typeof cleanMarkdownOptions.cssSelector === "string" &&
    cleanMarkdownOptions.cssSelector.trim().length
  ) {
    parts.push(
      t("crawl.detail.cleanMarkdown.scope", {
        selector: cleanMarkdownOptions.cssSelector,
      }),
    );
  }
  if (
    Array.isArray(cleanMarkdownOptions.targetElements) &&
    cleanMarkdownOptions.targetElements.length
  ) {
    parts.push(
      t("crawl.detail.cleanMarkdown.targets", {
        targets: cleanMarkdownOptions.targetElements.join(", "),
      }),
    );
  }
  if (
    Array.isArray(cleanMarkdownOptions.excludedTags) &&
    cleanMarkdownOptions.excludedTags.length
  ) {
    parts.push(
      t("crawl.detail.cleanMarkdown.excluded", {
        tags: cleanMarkdownOptions.excludedTags.join(", "),
      }),
    );
  }
  if (typeof cleanMarkdownOptions.wordCountThreshold === "number") {
    parts.push(
      t("crawl.detail.cleanMarkdown.minWords", {
        count: cleanMarkdownOptions.wordCountThreshold,
      }),
    );
  }
  if (typeof cleanMarkdownOptions.removeOverlayElements === "boolean") {
    parts.push(
      cleanMarkdownOptions.removeOverlayElements
        ? t("crawl.detail.cleanMarkdown.removeOverlays")
        : t("crawl.detail.cleanMarkdown.keepOverlays"),
    );
  }
  return parts.length ? parts.join(" • ") : t("common.enabled");
}
