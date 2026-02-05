"use client";

import { BookOutlined, ClockCircleOutlined, InfoCircleOutlined, ShareAltOutlined } from "@ant-design/icons";
import { Button, Card, Popover, Space, Tag, Tooltip, Typography } from "antd";
import { useRouter } from "next/navigation";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { SentimentBadge } from "@/components/sentiment-badge";
import { formatDateTime, formatRelativeTime, resolveLocale } from "@/lib/i18n";
import { formatRatioAsPercent } from "@/lib/metrics-format";
import { safeHttpUrl } from "@/lib/url";

const { Text, Title, Paragraph } = Typography;

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
  };
}

// Estimate reading time based on summary length
function estimateReadingTime(summary?: string): number {
  if (!summary) return 1;
  const wordsPerMinute = 200;
  const wordCount = summary.split(/\s+/).length;
  return Math.max(1, Math.ceil(wordCount / wordsPerMinute));
}

export function NewsCard({ item }: NewsCardProps) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const locale = resolveLocale(i18n.language);

  const openLabel = t("items.detail.openItem", { defaultValue: "Open item" });
  const readOriginalLabel = t("items.detail.readOriginal", { defaultValue: "Read original" });
  const readModeLabel = t("items.readMode", { defaultValue: "Read mode" });
  const shareLabel = t("common.share", { defaultValue: "Share" });
  const readingTimeLabel = t("items.readingTime", { defaultValue: "min read" });

  const topicTags = Array.from(new Set(item.topics ?? []))
    .map((label) => label.trim())
    .filter((label) => label.length > 0)
    .map((label) => ({
      label,
      color: "blue" as const
    }));
  const entityTags = Array.from(new Set(item.entities ?? []))
    .map((label) => label.trim())
    .filter((label) => label.length > 0)
    .map((label) => ({
      label,
      color: "purple" as const
    }));
  const allTags = [...topicTags, ...entityTags];
  const displayTags = allTags.slice(0, 5);
  const extraTagCount = Math.max(allTags.length - displayTags.length, 0);

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
  const expandLabel = t("common.expand", { defaultValue: "Show more" });
  const collapseLabel = t("common.collapse", { defaultValue: "Show less" });
  const thumbnailUrl = safeHttpUrl(item.thumbnail);
  const originalUrl = safeHttpUrl(item.url);
  const locationText = item.location?.trim() ?? "";
  const readingTime = estimateReadingTime(summaryText);

  const handleSearch = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    router.push(`/search?q=${encodeURIComponent(trimmed)}`);
  };

  const handleActivate = (event: KeyboardEvent<HTMLElement>, action: () => void) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      action();
    }
  };

  const handleOpenItem = () => {
    router.push(`/items/${item.id}`);
  };

  const handleOpenReadMode = () => {
    router.push(`/read/items/${item.id}`);
  };

  const handleOpenEvent = () => {
    if (item.eventId) {
      router.push(`/events/${item.eventId}`);
    }
  };

  // Technical metrics popover content
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
      {item.duplicateOf && (
        <div className="text-gray-400 text-[10px]">
          {t("items.duplicate.of", { defaultValue: "Duplicate of" })}: {item.duplicateOf}
        </div>
      )}
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
      {llmSummary && (
        <div className="border-t pt-2 mt-1 text-[10px] text-gray-400">
          {llmSummary}
        </div>
      )}
    </div>
  );

  return (
    <Card
      hoverable
      className="glass-card"
      style={{ height: "100%", display: "flex", flexDirection: "column" }}
      styles={{
        body: {
          flex: 1,
          display: "flex",
          flexDirection: "column",
          padding: "16px"
        }
      }}
    >
      {/* Header: Sentiment + Source + Time + Metrics Popover */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <SentimentBadge sentiment={item.sentiment} />
          {item.source && (
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
              {item.source}
            </span>
          )}
          <span className="text-xs text-gray-300 dark:text-gray-600">•</span>
          <span className="text-xs text-gray-400">
            {item.publishedAt
              ? formatRelativeTime(item.publishedAt, locale)
              : t("common.justNow", { defaultValue: "Just now" })}
          </span>
        </div>
        <Popover content={metricsContent} trigger="hover" placement="bottomRight">
          <Button type="text" size="small" icon={<InfoCircleOutlined className="text-gray-400" />} />
        </Popover>
      </div>

      {/* Thumbnail (if exists) */}
      {thumbnailUrl && (
        <div className="mb-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={thumbnailUrl}
            alt={item.title}
            className="w-full h-32 object-cover rounded-lg"
            loading="lazy"
            decoding="async"
          />
        </div>
      )}

      {/* Title */}
      <Title
        level={5}
        ellipsis={{ rows: 2 }}
        style={{ margin: 0, lineHeight: 1.4, marginBottom: 8 }}
        className="cursor-pointer hover:text-blue-500 transition-colors"
        role="button"
        tabIndex={0}
        onClick={handleOpenItem}
        onKeyDown={(event) => handleActivate(event, handleOpenItem)}
      >
        {item.title}
      </Title>

      {/* Summary */}
      {summaryText && (
        <Paragraph
          type="secondary"
          ellipsis={{
            rows: 3,
            expandable: "collapsible",
            symbol: (expanded) => (expanded ? collapseLabel : expandLabel)
          }}
          className="text-sm mb-3 text-gray-600 dark:text-gray-300"
          style={{ lineHeight: 1.6 }}
        >
          {summaryText}
        </Paragraph>
      )}

      {/* Tags */}
      <div className="flex flex-wrap gap-1 mb-3">
        {locationText && (
          <Tag
            color="cyan"
            className="text-xs cursor-pointer"
            onClick={() => handleSearch(locationText)}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => handleActivate(event, () => handleSearch(locationText))}
          >
            {locationText}
          </Tag>
        )}
        {displayTags.map((tag) => (
          <Tag
            key={`${tag.color}-${tag.label}`}
            color={tag.color}
            className="text-xs cursor-pointer"
            onClick={() => handleSearch(tag.label)}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => handleActivate(event, () => handleSearch(tag.label))}
          >
            {tag.label}
          </Tag>
        ))}
        {extraTagCount > 0 && (
          <Tag className="text-xs">+{extraTagCount}</Tag>
        )}
      </div>

      {/* Event Badge */}
      {item.eventId && (
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
      )}

      {/* Footer: Reading Time + Actions */}
      <div className="mt-auto pt-3 border-t border-gray-100 dark:border-gray-800 flex items-center justify-between">
        <div className="flex items-center gap-1 text-xs text-gray-400">
          <ClockCircleOutlined />
          <span>
            {readingTime} {readingTimeLabel}
          </span>
        </div>

        <Space size="small">
          <Tooltip title={readModeLabel}>
            <Button
              type="text"
              size="small"
              icon={<BookOutlined />}
              onClick={handleOpenReadMode}
            />
          </Tooltip>
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
          {originalUrl && (
            <Button
              type="link"
              size="small"
              href={originalUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {readOriginalLabel}
            </Button>
          )}
           <Button
             type="primary"
             size="small"
             onClick={handleOpenItem}
           >
             {openLabel}
           </Button>
         </Space>
      </div>
    </Card>
  );
}
