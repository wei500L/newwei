"use client";

import { InfoCircleOutlined } from "@ant-design/icons";
import { Button, Card, Space, Tag, Tooltip, Typography } from "antd";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";

import { formatDateTime, resolveLocale } from "@/lib/i18n";
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
  };
}

export function NewsCard({ item }: NewsCardProps) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const locale = resolveLocale(i18n.language);

  const publishedLabel = t("items.time.published", { defaultValue: "Published" });
  const ingestedLabel = t("items.time.ingested", { defaultValue: "Ingested" });
  const openLabel = t("items.detail.openItem", { defaultValue: "Open item" });
  const qualityLabel = t("items.columns.quality", { defaultValue: "Quality" });
  const readOriginalLabel = t("items.detail.readOriginal", { defaultValue: "Read original" });
  const displayIngested = item.ingestedAt ?? item.createdAt;
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
  const showFooter = Boolean(item.url || item.id || llmSummary);
  const summaryText = item.summary?.trim() ?? "";
  const expandLabel = t("common.expand", { defaultValue: "Show more" });
  const collapseLabel = t("common.collapse", { defaultValue: "Show less" });
  const thumbnailUrl = safeHttpUrl(item.thumbnail);
  const originalUrl = safeHttpUrl(item.url);
  const locationText = item.location?.trim() ?? "";
  const handleSearch = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    router.push(`/search?q=${encodeURIComponent(trimmed)}`);
  };

  return (
    <Card
      hoverable
      className="glass-card"
      cover={
        thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- External thumbnails are user-provided; keep client-side fetch (avoid next/image SSRF/config).
          <img
            alt={item.title}
            src={thumbnailUrl}
            loading="lazy"
            decoding="async"
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
          {qualityScore ? (
            <Tooltip
              title={
                <div className="text-xs">
                  <div>
                    {t("items.metrics.quality.tooltip", {
                      defaultValue: "Quality score from LLM cleaning stage (0–1, shown as %)."
                    })}
                  </div>
                  {item.llm?.model ? <div>Model: {item.llm.model}</div> : null}
                  {item.llm?.promptVersion ? <div>Prompt: {item.llm.promptVersion}</div> : null}
                </div>
              }
            >
              <Tag color="blue">{qualityLabel} {qualityScore}</Tag>
            </Tooltip>
          ) : null}
          {duplicateScore ? (
            <Tooltip
              title={
                <div className="text-xs">
                  <div>
                    {t("items.metrics.duplicate.tooltip", {
                      defaultValue: "Duplicate similarity from dedup stage (0–1, shown as %)."
                    })}
                  </div>
                  {item.duplicateOf ? <div>Duplicate of: {item.duplicateOf}</div> : null}
                </div>
              }
            >
              <Tag color="gold">
                {duplicateLabel} {duplicateScore}
              </Tag>
            </Tooltip>
          ) : null}
          {locationText ? (
            <Tag
              color="cyan"
              className="text-xs cursor-pointer"
              role="button"
              tabIndex={0}
              onClick={() => handleSearch(locationText)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  handleSearch(locationText);
                }
              }}
            >
              {locationText}
            </Tag>
          ) : null}
          {displayTags.map((tag) => (
            <Tag
              key={`${tag.color}-${tag.label}`}
              color={tag.color}
              className="text-xs cursor-pointer"
              role="button"
              tabIndex={0}
              onClick={() => handleSearch(tag.label)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  handleSearch(tag.label);
                }
              }}
            >
              {tag.label}
            </Tag>
          ))}
          {extraTagCount > 0 ? (
            <Tag className="text-xs">+{extraTagCount}</Tag>
          ) : null}
        </Space>
        <Space size={[8, 0]} wrap align="center">
          <Text type="secondary" style={{ fontSize: "12px" }}>
            {publishedLabel}:{" "}
            {item.publishedAt
              ? formatDateTime(item.publishedAt, locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZoneName: "short"
                })
              : t("common.notAvailable")}
          </Text>
          <Text type="secondary" style={{ fontSize: "12px" }}>
            {ingestedLabel}:{" "}
            {formatDateTime(displayIngested, locale, {
              dateStyle: "medium",
              timeStyle: "short",
              timeZoneName: "short"
            })}
          </Text>
          {item.source ? (
            <Text type="secondary" style={{ fontSize: "12px" }}>
              {item.source}
            </Text>
          ) : null}
        </Space>
        <Title level={4} ellipsis={{ rows: 2 }} style={{ margin: 0 }}>
          {item.title}
        </Title>
        {summaryText && (
          <div>
            <Paragraph
              ellipsis={{
                rows: 3,
                expandable: "collapsible",
                symbol: (expanded) => (expanded ? collapseLabel : expandLabel)
              }}
              type="secondary"
              style={{ lineHeight: 1.75, marginBottom: 0 }}
            >
              {summaryText}
            </Paragraph>
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
            {originalUrl ? (
              <Typography.Link href={originalUrl} target="_blank" rel="noopener noreferrer">
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
