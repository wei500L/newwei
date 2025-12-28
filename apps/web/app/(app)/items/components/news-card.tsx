"use client";

import { Card, Space, Tag, Typography } from "antd";
import { useTranslation } from "react-i18next";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

const { Text, Title, Paragraph } = Typography;

export interface NewsCardProps {
  item: {
    id: string;
    title: string;
    createdAt: string;
    summary?: string;
    thumbnail?: string;
    sentiment?: string;
    source?: string;
  };
}

export function NewsCard({ item }: NewsCardProps) {
  const { t, i18n } = useTranslation();
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
          {item.sentiment && (
            <Tag color={sentimentColor(item.sentiment)}>
              {t(`items.sentiment.${item.sentiment}`, { defaultValue: item.sentiment })}
            </Tag>
          )}
          <Text type="secondary" style={{ fontSize: "12px" }}>
            {formatDateTime(item.createdAt, locale, { dateStyle: "medium" })}
          </Text>
        </Space>
        <Title level={5} ellipsis={{ rows: 2 }}>
          {item.title}
        </Title>
        {item.summary && (
          <Paragraph ellipsis={{ rows: 3 }} type="secondary">
            {item.summary}
          </Paragraph>
        )}
      </Space>
      {item.source && (
        <div style={{ marginTop: "auto", paddingTop: "12px" }}>
          <Text type="secondary" style={{ fontSize: "12px" }}>
            {item.source}
          </Text>
        </div>
      )}
    </Card>
  );
}
