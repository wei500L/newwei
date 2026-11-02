"use client";

import { Tag, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

interface SentimentBadgeProps {
  sentiment?: string | null;
  showTrend?: boolean;
  trendDirection?: "up" | "down" | "stable";
  className?: string;
}

export function SentimentBadge({
  sentiment,
  showTrend,
  trendDirection,
  className,
}: SentimentBadgeProps) {
  const { t } = useTranslation();

  if (!sentiment) return null;

  const normalized = sentiment.toLowerCase().trim();

  let color: string;
  let label: string;

  switch (normalized) {
    case "positive":
      color = "success";
      label = t("items.sentiment.positive");
      break;
    case "negative":
      color = "error";
      label = t("items.sentiment.negative");
      break;
    case "neutral":
    default:
      color = "default";
      label = t("items.sentiment.neutral");
  }

  const trendIcon = showTrend
    ? trendDirection === "up"
      ? "↑"
      : trendDirection === "down"
        ? "↓"
        : "→"
    : null;

  return (
    <Tooltip title={t("items.sentiment.tooltip")}>
      <Tag
        color={color}
        bordered={false}
        className={`m-0 capitalize text-xs px-2 py-0.5 font-semibold ${className}`}
      >
        {trendIcon} {label}
      </Tag>
    </Tooltip>
  );
}
