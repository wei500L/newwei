"use client";

import { Empty } from "antd";

import { useChartTheme } from "@/hooks/use-chart-theme";

interface ChartEmptyStateProps {
  description: string;
  className?: string;
}

export function ChartEmptyState({ description, className }: ChartEmptyStateProps) {
  const { colors } = useChartTheme();
  const stroke = colors?.border ?? "rgba(148, 163, 184, 0.4)";
  const fill = colors?.secondary ?? "rgba(148, 163, 184, 0.08)";
  const accent = colors?.accent ?? "rgba(56, 189, 248, 0.6)";
  const textColor = colors?.foreground ?? "#94a3b8";

  return (
    <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
      <Empty
        imageStyle={{ height: 80 }}
        image={
          <svg width="120" height="80" viewBox="0 0 120 80" fill="none">
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
        description={<span className="text-xs" style={{ color: textColor }}>{description}</span>}
      />
    </div>
  );
}
