"use client";

import { BookOutlined, ClockCircleOutlined, InfoCircleOutlined, ShareAltOutlined } from "@ant-design/icons";
import { Button, Card, Popover, Space, Tag, Tooltip, Typography } from "antd";
import { useRouter } from "next/navigation";
import { useEffect, useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { ArticlePublishedTime } from "@/components/article-published-time";
import { NewsImage } from "@/components/news-image";
import { SentimentBadge } from "@/components/sentiment-badge";
import { resolveLocale } from "@/lib/i18n";
import { formatRatioAsPercent } from "@/lib/metrics-format";
import { safeHttpUrl } from "@/lib/url";
import { trackUserNewsBehavior } from "@/lib/user-news-behavior";

const { Title, Paragraph } = Typography;
const VIEW_EXPOSURE_THRESHOLD = 0.4;
const VIEW_EXPOSURE_DWELL_MS = 1200;

export type NewsCardVariant = "default" | "reader";
export type NewsCardDensity = "compact" | "comfortable";

export interface NewsCardProps {
  item: {
    id: string;
    title: string;
    createdAt: string;
    publishedAt?: string;
    ingestedAt?: string;
    summary?: string;
    thumbnail?: string;
    sentiment?: string;
    source?: string;
    location?: string;
    topics?: string[];
    tags?: string[];
    entities?: string[];
    qualityScore?: number;
    duplicateSimilarity?: number;
    duplicateOf?: string | null;
    llm?: {
      model?: string | null;
      promptVersion?: string | null;
      promptTokens?: number | null;
      completionTokens?: number | null;
      totalTokens?: number | null;
      costUsd?: number | null;
      latencyMs?: number | null;
    };
    url?: string;
    eventId?: string | null;
    rssHasTranslation?: boolean;
    rssTranslationState?: 'translated' | 'original';
  };
  variant?: NewsCardVariant;
  density?: NewsCardDensity;
}

function estimateReadingTime(summary?: string): number {
  if (!summary) {
    return 1;
  }
  const wordsPerMinute = 200;
  const wordCount = summary.split(/\s+/).length;
  return Math.max(1, Math.ceil(wordCount / wordsPerMinute));
}

export function NewsCard({ item, variant = "default", density = "compact" }: NewsCardProps) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const locale = resolveLocale(i18n.language);

  const isReaderVariant = variant === "reader";

  const openLabel = t("items.detail.openItem", { defaultValue: "Open item" });
  const readOriginalLabel = t("items.detail.readOriginal", { defaultValue: "Read original" });
  const readModeLabel = t("items.readMode", { defaultValue: "Read mode" });
  const shareLabel = t("common.share", { defaultValue: "Share" });
  const readingTimeLabel = t("items.readingTime", { defaultValue: "min read" });
  const translatedLabel = t("pages.rss.translation.translatedBadge", {
    defaultValue: "Translated"
  });
  const originalLabel = t("pages.rss.translation.originalBadge", {
    defaultValue: "Original"
  });

  const qualityScore = formatRatioAsPercent(item.qualityScore, locale);
  const duplicateScore = formatRatioAsPercent(item.duplicateSimilarity, locale);
  const duplicateLabel = item.duplicateOf
    ? t("items.duplicate.duplicate", { defaultValue: "Duplicate" })
    : t("items.duplicate.similarity", { defaultValue: "Similarity" });

  const llmBits: string[] = [];
  if (item.llm?.model) {
    llmBits.push(item.llm.model);
  }
  if (typeof item.llm?.latencyMs === "number") {
    llmBits.push(`${Math.round(item.llm.latencyMs)}ms`);
  }
  if (typeof item.llm?.costUsd === "number") {
    llmBits.push(`$${item.llm.costUsd.toFixed(4)}`);
  }
  const llmSummary = llmBits.length > 0 ? llmBits.join(" | ") : null;

  const summaryText = item.summary?.trim() ?? "";
  const isCompactDensity = density === "compact";
  const summaryRows = isCompactDensity ? 2 : 4;
  const expandLabel = t("common.expand", { defaultValue: "Show more" });
  const collapseLabel = t("common.collapse", { defaultValue: "Show less" });
  const summaryEllipsis = isCompactDensity
    ? { rows: summaryRows }
    : {
        rows: summaryRows,
        expandable: "collapsible" as const,
        symbol: (expanded: boolean) => (expanded ? collapseLabel : expandLabel)
      };
  const thumbnailUrl = safeHttpUrl(item.thumbnail);
  const originalUrl = safeHttpUrl(item.url);
  const readingTime = estimateReadingTime(summaryText);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const viewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasTrackedViewRef = useRef(false);

  const handleActivate = (event: KeyboardEvent<HTMLElement>, action: () => void) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      action();
    }
  };

  const handleOpenItem = () => {
    void trackUserNewsBehavior({
      type: "open_item",
      itemId: item.id,
      source: item.source,
      topics: item.topics,
      entities: item.entities,
      url: originalUrl ?? undefined
    });
    router.push(`/items/${item.id}`);
  };

  const handleOpenReadMode = () => {
    router.push(`/read/items/${item.id}`);
  };

  const handleOpenEvent = () => {
    if (item.eventId) {
      void trackUserNewsBehavior({
        type: "open_event",
        eventId: item.eventId,
        itemId: item.id,
        source: item.source,
        topics: item.topics,
        entities: item.entities,
        url: originalUrl ?? undefined
      });
      router.push(`/events/${item.eventId}`);
    }
  };

  const handleOpenPrimaryItem = () => {
    const primaryId = typeof item.duplicateOf === "string" ? item.duplicateOf.trim() : "";
    if (!primaryId) {
      return;
    }
    void trackUserNewsBehavior({
      type: "open_item",
      itemId: primaryId,
      source: item.source,
      topics: item.topics,
      entities: item.entities,
      url: originalUrl ?? undefined
    });
    router.push(`/items/${primaryId}`);
  };

  useEffect(() => {
    hasTrackedViewRef.current = false;
  }, [item.id]);

  useEffect(() => {
    const node = cardRef.current;
    if (!node) {
      return;
    }

    const emitView = () => {
      if (hasTrackedViewRef.current) {
        return;
      }
      hasTrackedViewRef.current = true;
      void trackUserNewsBehavior({
        type: "view",
        itemId: item.id,
        source: item.source,
        topics: item.topics,
        entities: item.entities,
        url: originalUrl ?? undefined
      });
    };

    const clearPendingTimer = () => {
      if (viewTimerRef.current) {
        clearTimeout(viewTimerRef.current);
        viewTimerRef.current = null;
      }
    };

    if (typeof window === "undefined" || typeof IntersectionObserver === "undefined") {
      emitView();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) {
          return;
        }
        if (entry.isIntersecting && entry.intersectionRatio >= VIEW_EXPOSURE_THRESHOLD) {
          if (!viewTimerRef.current && !hasTrackedViewRef.current) {
            viewTimerRef.current = setTimeout(() => {
              viewTimerRef.current = null;
              emitView();
            }, VIEW_EXPOSURE_DWELL_MS);
          }
          return;
        }
        clearPendingTimer();
      },
      { threshold: [0, VIEW_EXPOSURE_THRESHOLD, 0.8] }
    );

    observer.observe(node);

    return () => {
      clearPendingTimer();
      observer.disconnect();
    };
  }, [item.entities, item.id, item.source, item.topics, originalUrl]);

  const metricsContent = (
    <div className="flex flex-col gap-2 text-xs min-w-[220px]">
      <div className="font-semibold border-b pb-2 mb-1 text-gray-700 dark:text-gray-300">
        {t("items.metrics.title", { defaultValue: "Technical Metrics" })}
      </div>
      {qualityScore && (
        <div className="flex justify-between">
          <span className="text-gray-500">{t("items.columns.quality", { defaultValue: "Quality" })}:</span>
          <span className="font-medium">{qualityScore}</span>
        </div>
      )}
      {duplicateScore && (
        <div className="flex justify-between">
          <span className="text-gray-500">{duplicateLabel}:</span>
          <span className="font-medium">{duplicateScore}</span>
        </div>
      )}
      {item.duplicateOf ? (
        <div className="text-gray-400 text-[10px]">
          {t("items.duplicate.of", { defaultValue: "Duplicate of" })}: {item.duplicateOf}
        </div>
      ) : null}
      {item.duplicateOf ? (
        <Button
          type="link"
          size="small"
          className="self-start px-0"
          onClick={handleOpenPrimaryItem}
        >
          {t("items.duplicate.viewPrimary", { defaultValue: "查看主稿" })}
        </Button>
      ) : null}
      {item.llm?.model && (
        <div className="flex justify-between">
          <span className="text-gray-500">{t("items.metrics.model", { defaultValue: "Model" })}:</span>
          <span className="text-gray-600 dark:text-gray-400">{item.llm.model}</span>
        </div>
      )}
      {item.llm?.promptVersion && (
        <div className="flex justify-between">
          <span className="text-gray-500">{t("items.metrics.prompt", { defaultValue: "Prompt" })}:</span>
          <span className="text-gray-600 dark:text-gray-400">{item.llm.promptVersion}</span>
        </div>
      )}
      {llmSummary && <div className="border-t pt-2 mt-1 text-[10px] text-gray-400">{llmSummary}</div>}
    </div>
  );

  const imageBlock = (
    <NewsImage
      src={thumbnailUrl}
      alt={item.title}
      aspectRatio={isCompactDensity ? "fourThree" : "video"}
      fallback={isCompactDensity ? "initials" : "gradient"}
      fallbackText={item.source ?? item.title}
      showSkeleton
    />
  );

  const detailsBlock = (
    <>
      <Title
        level={isReaderVariant ? 4 : 5}
        ellipsis={{ rows: 2 }}
        style={{
          margin: 0,
          lineHeight: isReaderVariant ? 1.45 : 1.4,
          marginBottom: isReaderVariant ? 10 : 8
        }}
        className="cursor-pointer hover:text-blue-500 transition-colors"
        role="button"
        tabIndex={0}
        onClick={handleOpenItem}
        onKeyDown={(event) => handleActivate(event, handleOpenItem)}
      >
        {item.title}
      </Title>

      {summaryText ? (
        <Paragraph
          type="secondary"
          ellipsis={summaryEllipsis}
          className="text-sm mb-3 text-gray-600 dark:text-gray-300"
          style={{ lineHeight: 1.6 }}
        >
          {summaryText}
        </Paragraph>
      ) : null}

      {item.eventId ? (
        <div className="mb-3">
          <Tag
            color="geekblue"
            className="cursor-pointer"
            onClick={handleOpenEvent}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => handleActivate(event, handleOpenEvent)}
          >
            {t("items.partOfEvent", { defaultValue: "Part of event" })}
          </Tag>
        </div>
      ) : null}
    </>
  );

  const metaBlock = (
    <div className="flex items-start justify-between mb-3 gap-2">
      <div className="flex flex-col gap-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <SentimentBadge sentiment={item.sentiment} />
          {item.source ? (
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{item.source}</span>
          ) : null}
          {item.rssTranslationState ? (
            <Tooltip
              title={
                item.rssTranslationState === "translated"
                  ? t("pages.rss.translation.translatedHint", {
                      defaultValue: "Showing translated title and summary."
                    })
                  : item.rssHasTranslation
                    ? t("pages.rss.translation.originalWithTranslationHint", {
                        defaultValue: "Translation is available, but this card is showing original text."
                      })
                    : t("pages.rss.translation.originalHint", {
                        defaultValue: "No translated content was returned for this item, so it remains in the original language."
                      })
              }
            >
              <Tag color={item.rssTranslationState === "translated" ? "cyan" : "default"} className="m-0">
                {item.rssTranslationState === "translated" ? translatedLabel : originalLabel}
              </Tag>
            </Tooltip>
          ) : null}
        </div>
        <ArticlePublishedTime
          publishedAt={item.publishedAt ?? null}
          locale={locale}
          showLabel={false}
          primaryStrong={isReaderVariant}
          formatOptions={{ dateStyle: "medium", timeStyle: "short" }}
          primaryClassName={
            isReaderVariant ? "text-sm text-gray-600 dark:text-gray-300" : "text-xs text-gray-500 dark:text-gray-400"
          }
          secondaryClassName="text-[11px]"
          secondaryStyle={{ fontSize: 11 }}
        />
      </div>
      <Popover content={metricsContent} trigger={["hover", "click"]} placement="bottomRight">
        <Button type="text" size="small" icon={<InfoCircleOutlined className="text-gray-400" />} />
      </Popover>
    </div>
  );

  return (
    <div ref={cardRef} className="h-full">
      <Card
        hoverable
        className={isReaderVariant ? "glass-card items-feed-card-reader" : "glass-card"}
        style={{ height: "100%", display: "flex", flexDirection: "column" }}
        styles={{
          body: {
            flex: 1,
            display: "flex",
            flexDirection: "column",
            padding: isReaderVariant ? "18px" : "16px"
          }
        }}
      >
      {isCompactDensity ? (
        <div className="mb-3 flex items-start gap-3">
          <div className="w-24 shrink-0">{imageBlock}</div>
          <div className="min-w-0 flex-1">
            {metaBlock}
            {detailsBlock}
          </div>
        </div>
      ) : (
        <>
          <div className="mb-3">{imageBlock}</div>
          {metaBlock}
          {detailsBlock}
        </>
      )}

      <div className="mt-auto pt-3 border-t border-gray-100 dark:border-gray-800 flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1 text-xs text-gray-400">
          <ClockCircleOutlined />
          <span>
            {readingTime} {readingTimeLabel}
          </span>
        </div>

        <Space size="small" wrap>
          {isReaderVariant ? (
            <Button type="text" size="small" onClick={handleOpenReadMode}>
              {readModeLabel}
            </Button>
          ) : (
            <Tooltip title={readModeLabel}>
              <Button type="text" size="small" icon={<BookOutlined />} onClick={handleOpenReadMode} />
            </Tooltip>
          )}

          {!isReaderVariant ? (
            <Tooltip title={shareLabel}>
              <Button
                type="text"
                size="small"
                icon={<ShareAltOutlined />}
                onClick={() => {
                  if (navigator.share) {
                    navigator.share({
                      title: item.title,
                      url: window.location.origin + `/items/${item.id}`
                    });
                  }
                }}
              />
            </Tooltip>
          ) : null}

          {originalUrl ? (
            <Button
              type="link"
              size="small"
              href={originalUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => {
                void trackUserNewsBehavior({
                  type: "click",
                  itemId: item.id,
                  source: item.source,
                  topics: item.topics,
                  entities: item.entities,
                  url: originalUrl
                });
              }}
            >
              {readOriginalLabel}
            </Button>
          ) : null}

          <Button type="primary" size="small" onClick={handleOpenItem}>
            {openLabel}
          </Button>
        </Space>
      </div>
      </Card>
    </div>
  );
}
