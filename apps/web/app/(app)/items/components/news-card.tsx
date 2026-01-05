"use client";

import { Button, Card, Space, Tag, Typography } from "antd";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

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
  };
}

export function NewsCard({ item }: NewsCardProps) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const locale = resolveLocale(i18n.language);

  const sentimentColor = (sentiment?: string) => {
    switch (sentiment?.toLowerCase()) {
      case "positive":
        return "green";
      case "negative":
        return "red";
      case "neutral":
      default:
        return "default";
    }
  };

  const publishedLabel = t("items.time.published", { defaultValue: "Published" });
  const ingestedLabel = t("items.time.ingested", { defaultValue: "Ingested" });
  const openLabel = t("items.detail.openItem", { defaultValue: "Open item" });
  const qualityLabel = t("items.columns.quality", { defaultValue: "Quality" });
  const readOriginalLabel = t("items.detail.readOriginal", { defaultValue: "Read original" });
  const hasPublished = Boolean(item.publishedAt);
  const displayPublished = item.publishedAt ?? item.createdAt;
  const displayIngested = item.ingestedAt ?? item.createdAt;
  const showIngested = Boolean(item.ingestedAt) && (!hasPublished || item.ingestedAt !== item.publishedAt);
  const topicTags = [...(item.topics ?? []), ...(item.tags ?? [])].map((label) => ({
    label,
    color: "default" as const
  }));
  const entityTags = (item.entities ?? []).map((label) => ({
    label,
    color: "purple" as const
  }));
  const allTags = [...topicTags, ...entityTags];
  const displayTags = allTags.slice(0, 5);
  const extraTagCount = Math.max(allTags.length - displayTags.length, 0);
  const qualityScore =
    typeof item.qualityScore === "number" ? Math.round(item.qualityScore * 100) : null;
  const duplicateScore =
    typeof item.duplicateSimilarity === "number"
      ? Math.round(item.duplicateSimilarity * 100)
      : null;
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
  const showFooter = Boolean(item.source || item.url || item.id || llmSummary);
  const summaryText = item.summary?.trim();
  const trimmedSummary =
    summaryText && summaryText.length > 300
      ? `${summaryText.slice(0, 300)}…`
      : summaryText;

  return (
    <Card
      hoverable
      className="glass-card"
      cover={
        item.thumbnail ? (
          <img
            alt={item.title}
            src={item.thumbnail}
            style={{ height: 160, objectFit: "cover" }}
          />
        ) : null
      }
      style={{ height: "100%", display: "flex", flexDirection: "column" }}
      styles={{
        body: {
          flex: 1,
          display: "flex",
          flexDirection: "column",
          padding: "20px"
        }
      }}
    >
      <Space direction="vertical" size="middle" style={{ width: "100%", flex: 1 }}>
        <Space wrap>
          {item.sentiment ? (
            <Tag color={sentimentColor(item.sentiment)}>
              {t(`items.sentiment.${item.sentiment}`, { defaultValue: item.sentiment })}
            </Tag>
          ) : null}
          {qualityScore !== null ? <Tag color="blue">{qualityLabel} {qualityScore}%</Tag> : null}
          {duplicateScore !== null ? (
            <Tag color="gold">
              {duplicateLabel} {duplicateScore}%
            </Tag>
          ) : null}
          {displayTags.map((tag) => (
            <Tag key={`${tag.color}-${tag.label}`} color={tag.color} className="text-xs">
              {tag.label}
            </Tag>
          ))}
          {extraTagCount > 0 ? (
            <Tag className="text-xs">+{extraTagCount}</Tag>
          ) : null}
        </Space>
        <Space direction="vertical" size={0}>
          {hasPublished ? (
            <Text type="secondary" style={{ fontSize: "12px" }}>
              {publishedLabel}:{" "}
              {formatDateTime(displayPublished, locale, {
                dateStyle: "medium",
                timeStyle: "short",
                timeZoneName: "short"
              })}
            </Text>
          ) : (
            <Text type="secondary" style={{ fontSize: "12px" }}>
              {ingestedLabel}:{" "}
              {formatDateTime(displayIngested, locale, {
                dateStyle: "medium",
                timeStyle: "short",
                timeZoneName: "short"
              })}
            </Text>
          )}
          {showIngested ? (
            <Text type="secondary" style={{ fontSize: "12px" }}>
              {ingestedLabel}:{" "}
              {formatDateTime(displayIngested, locale, {
                dateStyle: "medium",
                timeStyle: "short",
                timeZoneName: "short"
              })}
            </Text>
          ) : null}
        </Space>
        <Title level={4} ellipsis={{ rows: 2 }}>
          {item.title}
        </Title>
        {trimmedSummary && (
          <Paragraph
            ellipsis={{ rows: 3 }}
            type="secondary"
            style={{ lineHeight: 1.75, marginBottom: 0 }}
          >
            {trimmedSummary}
          </Paragraph>
        )}
      </Space>
      {showFooter && (
        <div style={{ marginTop: "auto", paddingTop: "12px" }}>
          <Space size="small" wrap>
            {item.source ? (
              <Text type="secondary" style={{ fontSize: "12px" }}>
                {item.source}
              </Text>
            ) : null}
            {llmSummary ? (
              <Text type="secondary" style={{ fontSize: "12px" }}>
                {llmSummary}
              </Text>
            ) : null}
            {item.url ? (
              <Typography.Link href={item.url} target="_blank" rel="noreferrer">
                {readOriginalLabel}
              </Typography.Link>
            ) : null}
            {item.id ? (
              <Button
                type="link"
                size="small"
                onClick={() => router.push(`/items/${item.id}`)}
                className="px-0"
              >
                {openLabel}
              </Button>
            ) : null}
          </Space>
        </div>
      )}
    </Card>
  );
}
