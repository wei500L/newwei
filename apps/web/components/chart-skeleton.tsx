"use client";

import { Skeleton } from "antd";
import type { CSSProperties } from "react";

export interface ChartSkeletonProps {
  height?: number | string;
  className?: string;
}

const resolveSkeletonVariant = (height: number | string | undefined) => {
  if (typeof height !== "number") {
    return { variant: "paragraph" as const, rows: 6 };
  }

  if (height <= 80) {
    return { variant: "input" as const, inputHeight: Math.max(12, Math.round(height * 0.28)) };
  }

  if (height <= 140) {
    return { variant: "paragraph" as const, rows: 2 };
  }

  if (height <= 240) {
    return { variant: "paragraph" as const, rows: 4 };
  }

  return { variant: "paragraph" as const, rows: 6 };
};

export function ChartSkeleton({ height = 360, className }: ChartSkeletonProps) {
  const style: CSSProperties = { height };
  const resolved = resolveSkeletonVariant(height);

  return (
    <div className={`flex w-full items-center ${className ?? ""}`} style={style}>
      <div className="w-full">
        {resolved.variant === "input" ? (
          <Skeleton.Input active size="small" style={{ width: "100%", height: resolved.inputHeight }} />
        ) : (
          <Skeleton active paragraph={{ rows: resolved.rows }} className="w-full" />
        )}
      </div>
    </div>
  );
}

