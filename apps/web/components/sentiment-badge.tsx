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
  className
}: SentimentBadgeProps) {
  const { t } = useTranslation();

  if (!sentiment) return null;

  const normalized = sentiment.toLowerCase().trim();

  let color: string;
  let label: string;
  let glowColor: string;

  switch (normalized) {
    case "positive":
      color = "success";
      label = t("items.sentiment.positive", { defaultValue: "Positive" });
      glowColor = "rgba(34, 197, 94, 0.2)";
      break;
    case "negative":
      color = "error";
      label = t("items.sentiment.negative", { defaultValue: "Negative" });
      glowColor = "rgba(239, 68, 68, 0.2)";
      break;
    case "neutral":
    default:
      color = "default";
      label = t("items.sentiment.neutral", { defaultValue: "Neutral" });
      glowColor = "rgba(100, 100, 100, 0.2)";
  }

  const trendIcon = showTrend
    ? trendDirection === "up"
      ? "↑"
      : trendDirection === "down"
        ? "↓"
        : "→"
    : null;

  return (
    <Tooltip
      title={t("items.sentiment.tooltip", {
        defaultValue: "Sentiment inferred by AI model analysis"
      })}
    >
      <Tag
        color={color}
        bordered={false}
        className={`m-0 capitalize text-[10px] px-2 py-0.5 font-semibold ${className}`}
        style={{ boxShadow: `0 0 8px ${glowColor}` }}
      >
        {trendIcon} {label}
      </Tag>
    </Tooltip>
  );
}
