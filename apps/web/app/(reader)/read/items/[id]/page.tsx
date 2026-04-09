"use client";

import { ArrowLeftOutlined, BgColorsOutlined, FontSizeOutlined, ShareAltOutlined } from "@ant-design/icons";
import { gql, useMutation, useQuery } from "@apollo/client";
import { Alert, Button, Radio, Select, Skeleton, Space, Switch, Typography } from "antd";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { resolveArticlePublishedTime } from "@/components/article-published-time";
import { MarkdownViewer } from "@/components/markdown-viewer";
import { NewsImage } from "@/components/news-image";
import { resolveLocale } from "@/lib/i18n";
import {
  isChineseLanguage,
  resolveDisplayContent,
  resolveDisplaySummary,
  resolveDisplayTitle,
  resolveLanguageLabel
} from "@/lib/item-display";
import {
  isChineseTargetLanguage,
  RSS_TRANSLATION_STATUS_QUERY,
  RSS_TRANSLATION_TARGET_LANGUAGE_OPTIONS,
  TRANSLATE_RSS_ITEMS_MUTATION,
  type RssItemTranslation,
  type RssTranslationProvider,
  type RssTranslationStatusQuery,
  type RssTranslationStatusQueryVariables,
  type TranslateRssItemsMutation,
  type TranslateRssItemsMutationVariables
} from "@/lib/rss-translation";
import { safeHttpUrl } from "@/lib/url";

import { buildReaderAiInsights } from "./reader-ai-insights";

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
        eventId
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
  const [translationEnabled, setTranslationEnabled] = useState(false);
  const [translationProvider, setTranslationProvider] =
    useState<RssTranslationProvider>("deeplx");
  const [targetLanguage, setTargetLanguage] = useState("zh-CN");
  const [showOriginalContent, setShowOriginalContent] = useState(false);
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [translatedItem, setTranslatedItem] = useState<RssItemTranslation | null>(null);
  const translationRequestSeqRef = useRef(0);

  const { data, loading, error } = useQuery(READER_ITEM_QUERY, {
    variables: { id },
    fetchPolicy: "network-only"
  });
  const { data: translationStatusData } = useQuery<
    RssTranslationStatusQuery,
    RssTranslationStatusQueryVariables
  >(RSS_TRANSLATION_STATUS_QUERY, {
    variables: { targetLanguage },
    fetchPolicy: "cache-and-network"
  });
  const [translateRssItems, { loading: translationLoading }] = useMutation<
    TranslateRssItemsMutation,
    TranslateRssItemsMutationVariables
  >(TRANSLATE_RSS_ITEMS_MUTATION);

  const item = data?.item;
  const providerStatuses = translationStatusData?.rssTranslationStatus ?? [];
  const selectedProviderStatus = providerStatuses.find(
    (status) => status.provider === translationProvider
  );
  const translationProviderAvailable = Boolean(selectedProviderStatus?.available);
  const translationTargetSupported = Boolean(
    selectedProviderStatus?.targetLanguageSupported ?? true
  );
  const translationReady = Boolean(
    translationEnabled && translationProviderAvailable && translationTargetSupported
  );

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
  const thumbnailUrl = safeHttpUrl(rawPayload?.thumbnail);
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
  const baseDisplayTitle = resolveDisplayTitle({
    processedTitle: processedResult?.title,
    itemTitle: item?.title,
    source,
    originalUrl
  });
  const baseArticleContent = resolveDisplayContent({
    cleanedMarkdown
  });
  const translatedTitle = toNonEmptyString(translatedItem?.title);
  const translatedSummary = toNonEmptyString(translatedItem?.summary);
  const translatedArticleContent = toNonEmptyString(translatedItem?.cleanedMarkdown);
  const translatedKeyPoints = Array.isArray(translatedItem?.keyPoints)
    ? translatedItem.keyPoints.filter(
        (point): point is string => typeof point === "string" && point.trim().length > 0
      )
    : [];
  const displayTitle =
    translationReady && !showOriginalContent && translatedTitle
      ? translatedTitle
      : baseDisplayTitle;
  const resolvedSummary =
    translationReady && !showOriginalContent && translatedSummary
      ? translatedSummary
      : summary;
  const resolvedKeyPoints =
    translationReady && !showOriginalContent && translatedKeyPoints.length > 0
      ? translatedKeyPoints
      : keyPoints;
  const articleContent =
    translationReady && !showOriginalContent && translatedArticleContent
      ? translatedArticleContent
      : baseArticleContent;
  const languageLabel = resolveLanguageLabel(processedResult?.language);
  const hasNonChineseContent = Boolean(languageLabel && !isChineseLanguage(languageLabel));
  const hasContent = Boolean(articleContent);
  const publishedTime = resolveArticlePublishedTime({
    publishedAt: item?.publishedAt ?? null,
    locale,
    formatOptions: { dateStyle: "long" },
    unknownText: t("items.time.publishedUnknown", { defaultValue: "Published time unknown" })
  });

  const currentTheme = themeClasses[theme];
  const aiInsights = useMemo(
    () => buildReaderAiInsights(processedResult),
    [processedResult]
  );

  useEffect(() => {
    if (translationProvider === "deeplx" && !isChineseTargetLanguage(targetLanguage)) {
      setTargetLanguage("zh-CN");
    }
  }, [targetLanguage, translationProvider]);

  useEffect(() => {
    translationRequestSeqRef.current += 1;
    setTranslationError(null);
    setTranslatedItem(null);
    setShowOriginalContent(false);
  }, [id, translationEnabled, translationProvider, targetLanguage]);

  useEffect(() => {
    if (!item?.id || !translationEnabled || !translationReady) {
      return;
    }

    const requestSeq = translationRequestSeqRef.current + 1;
    translationRequestSeqRef.current = requestSeq;
    setTranslationError(null);

    translateRssItems({
      variables: {
        input: {
          itemIds: [item.id],
          provider: translationProvider,
          targetLanguage,
          fields: ["title", "summary", "key_points", "cleaned_markdown"]
        }
      }
    })
      .then((response) => {
        if (translationRequestSeqRef.current !== requestSeq) {
          return;
        }
        const next = response.data?.translateRssItems.translations?.[0] ?? null;
        setTranslatedItem(next);
      })
      .catch((err) => {
        if (translationRequestSeqRef.current !== requestSeq) {
          return;
        }
        const message = err instanceof Error ? err.message : "Translation failed";
        setTranslationError(message);
      });
  }, [
    id,
    item?.id,
    targetLanguage,
    translationEnabled,
    translationProvider,
    translationReady,
    translateRssItems
  ]);

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
        <div className="mb-6 rounded-lg border border-gray-200/70 bg-white/70 p-4 dark:border-gray-700 dark:bg-black/40">
          <Space direction="vertical" size="small" style={{ width: "100%" }}>
            <Space wrap>
              <Typography.Text strong>
                {t("reader.translation.title", { defaultValue: "Translation" })}
              </Typography.Text>
              <Space>
                <Typography.Text>
                  {t("reader.translation.enable", { defaultValue: "Enable" })}
                </Typography.Text>
                <Switch
                  checked={translationEnabled}
                  onChange={(checked) => setTranslationEnabled(checked)}
                />
              </Space>
              <Radio.Group
                value={translationProvider}
                onChange={(event) =>
                  setTranslationProvider(event.target.value as RssTranslationProvider)
                }
                optionType="button"
                buttonStyle="solid"
                disabled={!translationEnabled}
              >
                <Radio.Button value="deeplx">
                  {t('items.detail.translation.provider.deeplx', {
                    defaultValue: 'DeepLX API'
                  })}
                </Radio.Button>
                <Radio.Button value="llm">
                  {t('items.detail.translation.provider.llm', {
                    defaultValue: 'LLM'
                  })}
                </Radio.Button>
              </Radio.Group>
              <Select
                style={{ minWidth: 160 }}
                value={targetLanguage}
                onChange={(value) => setTargetLanguage(value)}
                disabled={!translationEnabled || translationProvider === "deeplx"}
                options={RSS_TRANSLATION_TARGET_LANGUAGE_OPTIONS}
              />
              {translationEnabled ? (
                <Space>
                  <Typography.Text>
                    {t("reader.translation.showOriginal", {
                      defaultValue: "Show original"
                    })}
                  </Typography.Text>
                  <Switch
                    checked={showOriginalContent}
                    onChange={(checked) => setShowOriginalContent(checked)}
                  />
                </Space>
              ) : null}
            </Space>

            {translationEnabled && selectedProviderStatus && !translationProviderAvailable ? (
              <Alert
                type="warning"
                showIcon
                message={t("reader.translation.unavailable", {
                  defaultValue: "Selected translation source is unavailable."
                })}
                description={selectedProviderStatus.message ?? t("common.notAvailable")}
              />
            ) : null}

            {translationEnabled &&
            selectedProviderStatus &&
            translationProviderAvailable &&
            !translationTargetSupported ? (
              <Alert
                type="warning"
                showIcon
                message={t("reader.translation.targetUnsupported", {
                  defaultValue: "Target language is not supported by selected source."
                })}
                description={selectedProviderStatus.message ?? t("common.notAvailable")}
              />
            ) : null}

            {translationEnabled && translationLoading ? (
              <Typography.Text type="secondary">
                {t("reader.translation.loading", {
                  defaultValue: "Translating article content..."
                })}
              </Typography.Text>
            ) : null}

            {translationEnabled && translationError ? (
              <Alert
                type="error"
                showIcon
                message={t("reader.translation.failed", {
                  defaultValue: "Translation failed."
                })}
                description={translationError}
              />
            ) : null}
          </Space>
        </div>

        {/* Header */}
        <header className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold leading-tight mb-4">{displayTitle}</h1>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-500">
            {source ? <span>{source}</span> : null}
            <span>
              {t("items.time.published", { defaultValue: "Published" })}: {publishedTime.primaryText}
            </span>
            {publishedTime.relativeText ? <span>{publishedTime.relativeText}</span> : null}
            {hasNonChineseContent ? (
              <span>
                {t("reader.languageNotice", {
                  defaultValue: "Original language: {{language}}",
                  language: languageLabel
                })}
              </span>
            ) : null}
          </div>
        </header>

        <div className="mb-8">
          <NewsImage
            src={thumbnailUrl}
            alt={displayTitle}
            aspectRatio="cinema"
            fallback="gradient"
            fallbackText={source ?? displayTitle}
            className="w-full rounded-xl"
            imgClassName="rounded-xl"
          />
          {source ? (
            <p className="mt-2 text-xs text-gray-500">
              {t("reader.coverCaption", {
                defaultValue: "Cover image from {{source}}",
                source
              })}
            </p>
          ) : null}
        </div>

        {/* Summary */}
        {resolvedSummary && (
          <div className="bg-slate-100/70 dark:bg-slate-800/40 rounded-lg p-4 mb-6">
            <h3 className="text-sm font-semibold mb-2">
              {t("reader.summary", { defaultValue: "Summary" })}
            </h3>
            <Typography.Paragraph style={{ marginBottom: 0 }}>
              {resolvedSummary}
            </Typography.Paragraph>
          </div>
        )}

        {/* AI Insights */}
        {aiInsights.hasData ? (
          <section className="mb-6 rounded-xl border border-violet-200/60 bg-violet-50/70 p-4 dark:border-violet-400/30 dark:bg-violet-950/20">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-violet-900 dark:text-violet-200">
                {t("reader.aiInsights.title", { defaultValue: "AI 解读" })}
              </h3>
              <div className="flex flex-wrap items-center gap-1">
                {aiInsights.sentimentLabel ? (
                  <span className="rounded bg-white/70 px-1.5 py-0.5 text-[11px] text-violet-800 dark:bg-violet-900/40 dark:text-violet-100">
                    {t("reader.aiInsights.sentiment", { defaultValue: "情感" })}:{" "}
                    {aiInsights.sentimentLabel}
                  </span>
                ) : null}
                {typeof aiInsights.qualityScore === "number" ? (
                  <span className="rounded bg-white/70 px-1.5 py-0.5 text-[11px] text-violet-800 dark:bg-violet-900/40 dark:text-violet-100">
                    {t("reader.aiInsights.quality", { defaultValue: "质量" })}:{" "}
                    {Math.round(aiInsights.qualityScore * 100)}%
                  </span>
                ) : null}
                {item?.processed?.eventId ? (
                  <Link
                    href={`/events/${item.processed.eventId}`}
                    className="rounded bg-white/80 px-1.5 py-0.5 text-[11px] text-violet-700 underline-offset-2 hover:underline dark:bg-violet-900/40 dark:text-violet-100"
                  >
                    {t("reader.aiInsights.event", { defaultValue: "查看关联事件" })}
                  </Link>
                ) : null}
              </div>
            </div>

            {aiInsights.timeline.length > 0 ? (
              <div className="mt-3">
                <p className="mb-1 text-xs font-medium text-violet-700 dark:text-violet-300">
                  {t("reader.aiInsights.timeline", { defaultValue: "事件脉络" })}
                </p>
                <ol className="space-y-1">
                  {aiInsights.timeline.map((point, index) => (
                    <li
                      key={`${point.label}-${point.detail}-${index}`}
                      className="rounded bg-white/70 px-2 py-1 text-xs text-violet-900 dark:bg-violet-900/30 dark:text-violet-100"
                    >
                      <span className="font-medium">{point.label}：</span>
                      {point.detail}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}

            {aiInsights.controversies.length > 0 ? (
              <div className="mt-3 rounded border border-rose-300/50 bg-rose-50/85 p-2 dark:border-rose-400/30 dark:bg-rose-950/25">
                <p className="mb-1 text-xs font-medium text-rose-700 dark:text-rose-300">
                  {t("reader.aiInsights.controversy", { defaultValue: "争议信号" })}
                </p>
                <ul className="space-y-1">
                  {aiInsights.controversies.map((signal, index) => (
                    <li key={`${signal}-${index}`} className="text-xs text-rose-800 dark:text-rose-100">
                      • {signal}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {aiInsights.actors.length > 0 ? (
              <div className="mt-3">
                <p className="mb-1 text-xs font-medium text-violet-700 dark:text-violet-300">
                  {t("reader.aiInsights.actors", { defaultValue: "关键主体" })}
                </p>
                <div className="flex flex-wrap gap-1">
                  {aiInsights.actors.map((actor) => (
                    <span
                      key={`${actor.name}-${actor.type}`}
                      className="rounded bg-white/70 px-1.5 py-0.5 text-[11px] text-violet-800 dark:bg-violet-900/40 dark:text-violet-100"
                    >
                      {actor.name} · {actor.type}
                      {typeof actor.confidence === "number"
                        ? ` (${Math.round(actor.confidence * 100)}%)`
                        : ""}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            {aiInsights.relations.length > 0 ? (
              <div className="mt-3">
                <p className="mb-1 text-xs font-medium text-violet-700 dark:text-violet-300">
                  {t("reader.aiInsights.relations", { defaultValue: "关系图谱" })}
                </p>
                <div className="space-y-1">
                  {aiInsights.relations.map((relation, index) => (
                    <div
                      key={`${relation.subject}-${relation.predicate}-${relation.object}-${index}`}
                      className="rounded bg-white/70 px-2 py-1 text-xs text-violet-900 dark:bg-violet-900/30 dark:text-violet-100"
                    >
                      {relation.subject} → {relation.predicate} → {relation.object}
                      {typeof relation.confidence === "number"
                        ? ` (${Math.round(relation.confidence * 100)}%)`
                        : ""}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        {/* Key Points */}
        {resolvedKeyPoints.length > 0 && (
          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 mb-6">
            <h3 className="text-sm font-semibold text-blue-900 dark:text-blue-300 mb-2">
              {t("reader.keyPoints", { defaultValue: "Key Points" })}
            </h3>
            <ul className="space-y-1">
              {resolvedKeyPoints.map((point: string, index: number) => (
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
