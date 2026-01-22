"use client";

import { Alert, Button, Empty, Typography } from "antd";
import type { ReactNode } from "react";

import { useChartTheme } from "@/hooks/use-chart-theme";

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
  onAction,
  action,
  className,
}: ChartEmptyStateProps) {
  const { colors } = useChartTheme();
  const stroke = colors?.border ?? "rgba(148, 163, 184, 0.4)";
  const fill = colors?.secondary ?? "rgba(148, 163, 184, 0.08)";
  const accent = (() => {
    switch (variant) {
      case "error":
        return "rgba(220, 38, 38, 0.55)";
      case "permission":
        return colors?.accent ?? "rgba(217, 119, 6, 0.6)";
      case "delayed":
        return "rgba(245, 158, 11, 0.6)";
      case "offline":
        return "rgba(100, 116, 139, 0.6)";
      case "backfilling":
        return colors?.primary ?? "rgba(56, 189, 248, 0.6)";
      case "empty":
      default:
        return colors?.accent ?? "rgba(56, 189, 248, 0.6)";
    }
  })();
  const textColor = colors?.foreground ?? "#94a3b8";
  const titleColor =
    variant === "error"
      ? "#dc2626"
      : variant === "permission"
        ? "#b45309"
      : variant === "delayed"
        ? "#d97706"
        : variant === "offline"
          ? "#475569"
        : "#0f172a";
  const actionNode =
    action ??
    (onAction && actionLabel ? (
      <Button size="small" type="primary" onClick={onAction}>
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
