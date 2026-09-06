/**
 * Create Crawl Task 抽屉的纯选项守卫（FE-批5B：自 CreateCrawlTaskDrawer.tsx 拆出）。
 * 纯函数模块：无 React 运行时依赖、无 "use client"；输入为表单字符串，
 * 输出为判定结果（react-i18next 仅作 type-only 引用以精确复刻 t 的类型）。
 *
 * 职责：
 * - 阻断 crawl 阶段的 LLM 抽取配置（类型名与 params JSON 内的
 *   extractionStrategy / llmConfig 键，递归检测含环引用保护）；
 * - 格式化 proxy policy 问题清单为可展示文案。
 */

import type { TFunction } from "i18next";

import {
  getCrawlConfigPolicyIssueTranslationKey,
  type CrawlConfigPolicyIssue,
} from "@/lib/crawl-config-policy";

export type CreateDrawerTranslate = TFunction;

const normalizeOptionGuardKey = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

export const hasBlockedCrawlLlmType = (value?: string) => {
  if (!value) {
    return false;
  }
  const normalized = normalizeOptionGuardKey(value);
  if (!normalized.includes("llm")) {
    return false;
  }
  return (
    normalized.includes("strategy") ||
    normalized.includes("extraction") ||
    normalized.includes("llm")
  );
};

export const hasBlockedCrawlLlmParams = (rawText?: string) => {
  if (!rawText || !rawText.trim()) {
    return false;
  }
  try {
    const parsed = JSON.parse(rawText);
    const visited = new Set<unknown>();
    const walk = (value: unknown, prefix = ""): boolean => {
      if (!value || typeof value !== "object") {
        return false;
      }
      if (visited.has(value)) {
        return false;
      }
      visited.add(value);

      if (Array.isArray(value)) {
        return value.some((entry, index) =>
          walk(entry, prefix + "[" + index + "]"),
        );
      }

      for (const [key, entry] of Object.entries(
        value as Record<string, unknown>,
      )) {
        const normalizedKey = normalizeOptionGuardKey(key);
        const path = prefix ? prefix + "." + key : key;

        if (
          normalizedKey === "extractionstrategy" ||
          normalizedKey === "llmconfig"
        ) {
          return true;
        }

        if (
          normalizedKey === "type" &&
          typeof entry === "string" &&
          hasBlockedCrawlLlmType(entry) &&
          /strategy|extraction/i.test(path)
        ) {
          return true;
        }

        if (walk(entry, path)) {
          return true;
        }
      }

      return false;
    };

    return walk(parsed);
  } catch {
    return false;
  }
};

export const formatPolicyIssues = (
  issues: CrawlConfigPolicyIssue[],
  t: CreateDrawerTranslate,
) =>
  issues
    .map(
      (issue) =>
        `${issue.path}: ${t(getCrawlConfigPolicyIssueTranslationKey(issue.code), {
          defaultValue: issue.code,
        })}`,
    )
    .join(" ");

/** markdown 自定义 strategy 的 LLM 阻断 Alert 是否显示。 */
export const hasMarkdownStrategyLlmConfig = (options: {
  type?: string;
  params?: string;
}): boolean =>
  hasBlockedCrawlLlmType(options.type) ||
  hasBlockedCrawlLlmParams(options.params);
