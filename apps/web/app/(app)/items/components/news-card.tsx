"use client";

import { InfoCircleOutlined } from "@ant-design/icons";
import { Button, Card, Space, Tag, Tooltip, Typography } from "antd";
import { useRouter } from "next/navigation";
import { useState } from "react";
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
  const [summaryExpanded, setSummaryExpanded] = useState(false);

  const publishedLabel = t("items.time.published", { defaultValue: "Published" });
  const ingestedLabel = t("items.time.ingested", { defaultValue: "Ingested" });
  const openLabel = t("items.detail.openItem", { defaultValue: "Open item" });
  const qualityLabel = t("items.columns.quality", { defaultValue: "Quality" });
  const readOriginalLabel = t("items.detail.readOriginal", { defaultValue: "Read original" });
  const hasPublished = Boolean(item.publishedAt);
  const displayPublished = item.publishedAt ?? item.createdAt;
  const displayIngested = item.ingestedAt ?? item.createdAt;
  const showIngested =
    Boolean(item.ingestedAt) && hasPublished && item.ingestedAt !== item.publishedAt;
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
  const showFooter = Boolean(item.url || item.id || llmSummary);
  const summaryText = item.summary?.trim();
  const canExpandSummary = Boolean(summaryText && summaryText.length > 300);
  const displaySummary =
    summaryText && !summaryExpanded && canExpandSummary
      ? `${summaryText.slice(0, 300).trimEnd()}…`
      : summaryText;
  const expandLabel = t("common.expand", { defaultValue: "Show more" });
  const collapseLabel = t("common.collapse", { defaultValue: "Show less" });

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
        <Space size={[8, 0]} wrap align="center">
          <Text type="secondary" style={{ fontSize: "12px" }}>
            {(hasPublished ? publishedLabel : ingestedLabel)}:{" "}
            {formatDateTime(hasPublished ? displayPublished : displayIngested, locale, {
              dateStyle: "medium",
              timeStyle: "short",
              timeZoneName: "short"
            })}
          </Text>
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
          {item.source ? (
            <Text type="secondary" style={{ fontSize: "12px" }}>
              {item.source}
            </Text>
          ) : null}
        </Space>
        <Title level={4} ellipsis={{ rows: 2 }} style={{ margin: 0 }}>
          {item.title}
        </Title>
        {displaySummary && (
          <div>
            <Paragraph
              ellipsis={summaryExpanded ? false : { rows: 3 }}
              type="secondary"
              style={{ lineHeight: 1.75, marginBottom: 0 }}
            >
              {displaySummary}
            </Paragraph>
            {canExpandSummary ? (
              <Button
                type="link"
                size="small"
                className="px-0"
                onClick={() => setSummaryExpanded((expanded) => !expanded)}
              >
                {summaryExpanded ? collapseLabel : expandLabel}
              </Button>
            ) : null}
          </div>
        )}
      </Space>
      {showFooter && (
        <div style={{ marginTop: "auto", paddingTop: "12px" }}>
          <Space size="small" wrap>
            {llmSummary ? (
              <Tooltip
                title={
                  <div className="text-xs">
                    {item.llm?.model ? <div>Model: {item.llm.model}</div> : null}
                    {item.llm?.promptVersion ? (
                      <div>Prompt: {item.llm.promptVersion}</div>
                    ) : null}
                    {typeof item.llm?.totalTokens === "number" ? (
                      <div>Tokens: {Math.round(item.llm.totalTokens)}</div>
                    ) : null}
                    {typeof item.llm?.latencyMs === "number" ? (
                      <div>Latency: {Math.round(item.llm.latencyMs)} ms</div>
                    ) : null}
                    {typeof item.llm?.costUsd === "number" ? (
                      <div>Cost: ${item.llm.costUsd.toFixed(4)}</div>
                    ) : null}
                  </div>
                }
              >
                <Space size={4}>
                  <InfoCircleOutlined className="text-slate-400" />
                  <Text type="secondary" style={{ fontSize: "12px" }}>
                    LLM: {llmSummary}
                  </Text>
                </Space>
              </Tooltip>
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
