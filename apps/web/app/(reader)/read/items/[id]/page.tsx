"use client";

import { gql, useQuery } from "@apollo/client";
import { ArrowLeftOutlined, BgColorsOutlined, FontSizeOutlined, ShareAltOutlined } from "@ant-design/icons";
import { Button, Skeleton, Space, Typography } from "antd";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { MarkdownViewer } from "@/components/markdown-viewer";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import {
  isChineseLanguage,
  resolveDisplayContent,
  resolveDisplaySummary,
  resolveDisplayTitle,
  resolveLanguageLabel
} from "@/lib/item-display";
import { safeHttpUrl } from "@/lib/url";

const READER_ITEM_QUERY = gql`
  query ReaderItem($id: String!) {
    item(id: $id) {
      id
      title
      publishedAt
      raw {
        payload
      }
      processed {
        resultJson
        result
      }
    }
  }
`;

type FontFamily = "sans" | "serif" | "mono";
type FontSize = "small" | "medium" | "large";
type Theme = "light" | "sepia" | "dark";

const fontFamilyClasses: Record<FontFamily, string> = {
  sans: "font-sans",
  serif: "font-serif",
  mono: "font-mono"
};

const fontSizeClasses: Record<FontSize, string> = {
  small: "text-base",
  medium: "text-lg",
  large: "text-xl"
};

const themeClasses: Record<Theme, { bg: string; text: string }> = {
  light: { bg: "bg-[#fafafa]", text: "text-gray-900" },
  sepia: { bg: "bg-[#f4ecd8]", text: "text-[#5b4636]" },
  dark: { bg: "bg-[#1a1a1a]", text: "text-gray-200" }
};

const parseJson = <T,>(value: unknown): T | null => {
  if (value === null || value === undefined) {
    return null;
  }
  try {
    let parsed: unknown = value;
    for (let depth = 0; depth < 3; depth += 1) {
      if (typeof parsed !== "string") {
        break;
      }
      parsed = JSON.parse(parsed);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as T;
  } catch {
    return null;
  }
};

const toNonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export default function ReaderPage() {
  const { id } = useParams<{ id: string }>();
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);

  const [fontFamily, setFontFamily] = useState<FontFamily>("sans");
  const [fontSize, setFontSize] = useState<FontSize>("medium");
  const [theme, setTheme] = useState<Theme>("light");
  const [showToolbar, setShowToolbar] = useState(false);

  const { data, loading, error } = useQuery(READER_ITEM_QUERY, {
    variables: { id },
    fetchPolicy: "network-only"
  });

  const item = data?.item;

  const processedResult = useMemo(
    () =>
      parseJson<Record<string, unknown>>(item?.processed?.resultJson) ??
      parseJson<Record<string, unknown>>(item?.processed?.result),
    [item?.processed?.result, item?.processed?.resultJson]
  );
  const rawPayload = useMemo(
    () => parseJson<Record<string, unknown>>(item?.raw?.payload),
    [item?.raw?.payload]
  );

  const originalUrl = safeHttpUrl(rawPayload?.url);
  const source =
    toNonEmptyString(processedResult?.source) ??
    toNonEmptyString(rawPayload?.sourceName) ??
    toNonEmptyString(rawPayload?.source) ??
    undefined;
  const cleanedMarkdown =
    typeof processedResult?.cleaned_markdown === "string" ? processedResult.cleaned_markdown : undefined;
  const keyPoints = Array.isArray(processedResult?.key_points)
    ? processedResult.key_points.filter(
        (point: unknown): point is string => typeof point === "string" && point.trim().length > 0
      )
    : [];
  const summary = resolveDisplaySummary({
    processedSummary: processedResult?.summary,
    rawSummary: rawPayload?.summary
  });
  const displayTitle = resolveDisplayTitle({
    processedTitle: processedResult?.title,
    itemTitle: item?.title,
    source,
    originalUrl
  });
  const articleContent = resolveDisplayContent({
    cleanedMarkdown
  });
  const languageLabel = resolveLanguageLabel(processedResult?.language);
  const hasNonChineseContent = Boolean(languageLabel && !isChineseLanguage(languageLabel));
  const hasContent = Boolean(articleContent);

  const currentTheme = themeClasses[theme];

  if (loading) {
    return (
      <div className="min-h-screen bg-[#fafafa]">
        <div className="max-w-3xl mx-auto px-6 py-10">
          <Skeleton active paragraph={{ rows: 10 }} />
        </div>
      </div>
    );
  }

  if (error || !item) {
    return (
      <div className={`min-h-screen ${currentTheme.bg} ${currentTheme.text}`}>
        <div className="max-w-3xl mx-auto px-6 py-10 text-center">
          <Typography.Title level={4}>
            {t("reader.error.title", { defaultValue: "Failed to load article" })}
          </Typography.Title>
          <Typography.Text type="secondary">
            {error?.message || t("reader.error.notFound", { defaultValue: "Article not found" })}
          </Typography.Text>
          <div className="mt-4">
            <Link href="/items">
              <Button icon={<ArrowLeftOutlined />}>
                {t("common.back", { defaultValue: "Back" })}
              </Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`min-h-screen ${currentTheme.bg} ${currentTheme.text} transition-colors duration-300`}>
      {/* Floating Toolbar */}
      <header className="sticky top-0 z-50 border-b border-gray-200/50 dark:border-gray-800/50 bg-white/80 dark:bg-black/80 backdrop-blur-md">
        <div className="max-w-3xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link
            href="/items"
            className="text-sm text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors flex items-center gap-1"
          >
            <ArrowLeftOutlined /> {t("reader.back", { defaultValue: "Back" })}
          </Link>

          <div className="flex items-center gap-1">
            <Button
              type="text"
              size="small"
              icon={<FontSizeOutlined />}
              onClick={() => setShowToolbar(!showToolbar)}
            />
            <Button
              type="text"
              size="small"
              icon={<BgColorsOutlined />}
              onClick={() => {
                const themes: Theme[] = ["light", "sepia", "dark"];
                const nextIndex = (themes.indexOf(theme) + 1) % themes.length;
                setTheme(themes[nextIndex] ?? "light");
              }}
            />
            <Button type="text" size="small" icon={<ShareAltOutlined />} />
          </div>
        </div>

        {/* Expanded Toolbar */}
        {showToolbar && (
          <div className="border-t border-gray-200/50 dark:border-gray-800/50 bg-white/60 dark:bg-black/60">
            <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-6">
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">{t("reader.font", { defaultValue: "Font" })}</span>
                <div className="flex rounded-lg bg-gray-100 dark:bg-gray-800 p-0.5">
                  {(["sans", "serif", "mono"] as FontFamily[]).map((f) => (
                    <button
                      key={f}
                      onClick={() => setFontFamily(f)}
                      className={`px-3 py-1 text-xs rounded-md transition-colors ${
                        fontFamily === f
                          ? "bg-white dark:bg-gray-700 shadow-sm"
                          : "text-gray-500 hover:text-gray-700"
                      }`}
                    >
                      {f.charAt(0).toUpperCase() + f.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">{t("reader.size", { defaultValue: "Size" })}</span>
                <div className="flex rounded-lg bg-gray-100 dark:bg-gray-800 p-0.5">
                  {(["small", "medium", "large"] as FontSize[]).map((s) => (
                    <button
                      key={s}
                      onClick={() => setFontSize(s)}
                      className={`px-3 py-1 text-xs rounded-md transition-colors ${
                        fontSize === s
                          ? "bg-white dark:bg-gray-700 shadow-sm"
                          : "text-gray-500 hover:text-gray-700"
                      }`}
                    >
                      {s.charAt(0).toUpperCase() + s.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </header>

      {/* Progress Bar */}
      <div className="fixed top-0 left-0 right-0 h-0.5 bg-gray-200 dark:bg-gray-800 z-[60]">
        <div className="h-full bg-blue-500 w-0" id="reading-progress" />
      </div>

      {/* Article Content */}
      <article
        className={`max-w-3xl mx-auto px-6 py-10 ${fontFamilyClasses[fontFamily]} ${fontSizeClasses[fontSize]}`}
      >
        {/* Header */}
        <header className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold leading-tight mb-4">{displayTitle}</h1>

          <div className="flex items-center gap-4 text-sm text-gray-500">
            {source && (
              <>
                <span>{source}</span>
                <span>•</span>
              </>
            )}
            {item.publishedAt && (
              <span>
                {formatDateTime(item.publishedAt, locale, {
                  dateStyle: "long",
                  timeStyle: undefined
                })}
              </span>
            )}
            {hasNonChineseContent && (
              <>
                <span>•</span>
                <span>
                  {t("reader.languageNotice", {
                    defaultValue: "Original language: {{language}}",
                    language: languageLabel
                  })}
                </span>
              </>
            )}
          </div>
        </header>

        {/* Summary */}
        {summary && (
          <div className="bg-slate-100/70 dark:bg-slate-800/40 rounded-lg p-4 mb-6">
            <h3 className="text-sm font-semibold mb-2">
              {t("reader.summary", { defaultValue: "Summary" })}
            </h3>
            <Typography.Paragraph style={{ marginBottom: 0 }}>{summary}</Typography.Paragraph>
          </div>
        )}

        {/* Key Points */}
        {keyPoints.length > 0 && (
          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 mb-6">
            <h3 className="text-sm font-semibold text-blue-900 dark:text-blue-300 mb-2">
              {t("reader.keyPoints", { defaultValue: "Key Points" })}
            </h3>
            <ul className="space-y-1">
              {keyPoints.map((point: string, index: number) => (
                <li key={index} className="text-sm text-blue-800 dark:text-blue-200 flex gap-2">
                  <span className="text-blue-400">•</span>
                  {point}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Main Content */}
        {hasContent ? (
          <div className="prose dark:prose-invert max-w-none leading-relaxed">
            <MarkdownViewer markdown={articleContent!} />
          </div>
        ) : (
          <div className="text-center py-10">
            <Typography.Text type="secondary">
              {t("reader.noContent", { defaultValue: "No readable content available" })}
            </Typography.Text>
            {originalUrl && (
              <div className="mt-4">
                <a
                  href={originalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-500 hover:underline"
                >
                  {t("reader.viewOriginal", { defaultValue: "View original article" })}
                </a>
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <footer className="mt-12 pt-8 border-t border-gray-200 dark:border-gray-800">
          <Space>
            <Link href={`/items/${id}`}>
              <Button type="default">
                {t("reader.viewDetails", { defaultValue: "View Details" })}
              </Button>
            </Link>
            {originalUrl && (
              <a
                href={originalUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button>{t("reader.originalSource", { defaultValue: "Original Source" })}</Button>
              </a>
            )}
          </Space>
        </footer>
      </article>
    </div>
  );
}
