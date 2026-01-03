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
    qualityScore?: number;
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
  const hasPublished = Boolean(item.publishedAt);
  const displayPublished = item.publishedAt ?? item.createdAt;
  const displayIngested = item.ingestedAt ?? item.createdAt;
  const showIngested = Boolean(item.ingestedAt) && (!hasPublished || item.ingestedAt !== item.publishedAt);
  const topicTags = [...(item.topics ?? []), ...(item.tags ?? [])].slice(0, 3);
  const qualityScore =
    typeof item.qualityScore === "number" ? Math.round(item.qualityScore * 100) : null;
  const showFooter = Boolean(item.source || item.url || item.id);

  return (
    <Card
      hoverable
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
      styles={{ body: { flex: 1, display: "flex", flexDirection: "column" } }}
    >
      <Space direction="vertical" size="small" style={{ width: "100%", flex: 1 }}>
        <Space wrap>
          {item.sentiment ? (
            <Tag color={sentimentColor(item.sentiment)}>
              {t(`items.sentiment.${item.sentiment}`, { defaultValue: item.sentiment })}
            </Tag>
          ) : null}
          {qualityScore !== null ? <Tag color="blue">Quality {qualityScore}%</Tag> : null}
          {topicTags.map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
        </Space>
        <Space direction="vertical" size={0}>
          {hasPublished ? (
            <Text type="secondary" style={{ fontSize: "12px" }}>
              {publishedLabel}: {formatDateTime(displayPublished, locale, { dateStyle: "medium" })}
            </Text>
          ) : (
            <Text type="secondary" style={{ fontSize: "12px" }}>
              {ingestedLabel}: {formatDateTime(displayIngested, locale, { dateStyle: "medium" })}
            </Text>
          )}
          {showIngested ? (
            <Text type="secondary" style={{ fontSize: "12px" }}>
              {ingestedLabel}: {formatDateTime(displayIngested, locale, { dateStyle: "medium" })}
            </Text>
          ) : null}
        </Space>
        <Title level={5} ellipsis={{ rows: 2 }}>
          {item.title}
        </Title>
        {item.summary && (
          <Paragraph ellipsis={{ rows: 2 }} type="secondary">
            {item.summary}
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
            {item.url ? (
              <Typography.Link href={item.url} target="_blank" rel="noreferrer">
                Read original
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
