"use client";

import { Alert, Button, Empty, Typography } from "antd";
import type { ReactNode } from "react";

import { useChartTheme } from "@/hooks/use-chart-theme";
import {
  CHART_BORDER_FALLBACK,
  CHART_FILL_FALLBACK,
  CHART_STATE_ACCENT_FALLBACK,
  CHART_STATE_TITLE,
  CHART_TEXT_FALLBACK,
} from "@/lib/status-tokens";

export type ChartEmptyStateVariant =
  | "empty"
  | "delayed"
  | "backfilling"
  | "offline"
  | "permission"
  | "error";
export type ChartEmptyStatePresentation = "center" | "banner";

interface ChartEmptyStateProps {
  title?: string;
  description: ReactNode;
  variant?: ChartEmptyStateVariant;
  presentation?: ChartEmptyStatePresentation;
  actionLabel?: string;
  actionLoading?: boolean;
  onAction?: () => void;
  action?: ReactNode;
  className?: string;
}

export function ChartEmptyState({
  title,
  description,
  variant = "empty",
  presentation = "center",
  actionLabel,
  actionLoading = false,
  onAction,
  action,
  className,
}: ChartEmptyStateProps) {
  const { colors } = useChartTheme();
  const stroke = colors?.border ?? CHART_BORDER_FALLBACK;
  const fill = colors?.secondary ?? CHART_FILL_FALLBACK;
  const accent = (() => {
    switch (variant) {
      case "error":
        return CHART_STATE_ACCENT_FALLBACK.error;
      case "permission":
        return colors?.accent ?? CHART_STATE_ACCENT_FALLBACK.permission;
      case "delayed":
        return CHART_STATE_ACCENT_FALLBACK.delayed;
      case "offline":
        return CHART_STATE_ACCENT_FALLBACK.offline;
      case "backfilling":
        return colors?.primary ?? CHART_STATE_ACCENT_FALLBACK.backfilling;
      case "empty":
      default:
        return colors?.accent ?? CHART_STATE_ACCENT_FALLBACK.empty;
    }
  })();
  const textColor = colors?.foreground ?? CHART_TEXT_FALLBACK;
  const titleColor = CHART_STATE_TITLE[variant];
  const actionNode =
    action ??
    (onAction && actionLabel ? (
      <Button size="small" type="primary" loading={actionLoading} onClick={onAction}>
        {actionLabel}
      </Button>
    ) : null);

  if (presentation === "banner") {
    const alertType =
      variant === "error"
        ? "error"
        : variant === "permission"
          ? "warning"
        : variant === "delayed" || variant === "offline"
          ? "warning"
          : variant === "backfilling"
            ? "info"
            : "info";
    return (
      <Alert
        className={className}
        type={alertType}
        showIcon
        message={title}
        description={description}
        action={actionNode}
      />
    );
  }

  return (
    <div className={`flex h-full w-full items-center justify-center p-4 ${className ?? ""}`}>
      <Empty
        styles={{ image: { height: "clamp(56px, 25%, 120px)" } }}
        image={
          <svg
            viewBox="0 0 120 80"
            fill="none"
            className="h-full w-full"
            preserveAspectRatio="xMidYMid meet"
            aria-hidden="true"
          >
            <rect
              x="10"
              y="12"
              width="100"
              height="56"
              rx="10"
              fill={fill}
              stroke={stroke}
              strokeWidth="1.5"
            />
            <path
              d="M22 30H98M22 44H98M22 58H70"
              stroke={stroke}
              strokeWidth="1.2"
              strokeDasharray="4 4"
            />
            <circle cx="84" cy="44" r="6" fill={accent} opacity="0.7" />
          </svg>
        }
        description={
          <div className="flex flex-col items-center gap-1">
            {title ? (
              <Typography.Text strong style={{ color: titleColor }}>
                {title}
              </Typography.Text>
            ) : null}
            <div className="text-xs text-center leading-relaxed" style={{ color: textColor }}>
              {description}
            </div>
            {actionNode ? <div className="pt-1">{actionNode}</div> : null}
          </div>
        }
      />
    </div>
  );
}
