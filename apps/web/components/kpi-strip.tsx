import type { ReactNode } from "react";

export type KpiTone = "default" | "bullish" | "bearish" | "warning" | "danger";

export interface KpiItem {
  key: string;
  label: ReactNode;
  value: ReactNode;
  suffix?: ReactNode;
  /** 数值下方的一行小字说明（可选） */
  hint?: ReactNode;
  tone?: KpiTone;
}

export interface KpiStripProps {
  items: KpiItem[];
  /** 为 true 时不带外层 content-card（放进已有卡片内部时使用） */
  bare?: boolean;
  className?: string;
}

const TONE_CLASS: Record<KpiTone, string> = {
  default: "text-[var(--foreground)]",
  bullish: "text-[var(--bullish)]",
  bearish: "text-[var(--bearish)]",
  warning: "text-[var(--accent)]",
  danger: "text-[var(--destructive)]",
};

/**
 * 指标条：一张卡、等宽数字、格子之间用发丝竖线分隔（README §3.5 / UI-9E 定下的 KPI 写法）。
 * 不用于带迷你图的指标（dashboard 的 MarketPulse 保持自己的实现）。
 */
export function KpiStrip({ items, bare = false, className }: KpiStripProps) {
  const outer = bare ? "" : "content-card p-4";
  return (
    <dl
      className={`m-0 grid grid-cols-2 gap-x-4 gap-y-4 md:grid-cols-[repeat(auto-fit,minmax(140px,1fr))] ${outer} ${className ?? ""}`.trim()}
    >
      {items.map((item, index) => (
        <div
          key={item.key}
          className={`flex min-w-0 flex-col gap-1 ${index > 0 ? "md:border-l md:border-[var(--border)] md:pl-4" : ""}`}
        >
          <dt className="kicker m-0 truncate">{item.label}</dt>
          <dd className={`m-0 font-mono text-2xl font-semibold tabular-nums leading-tight ${TONE_CLASS[item.tone ?? "default"]}`}>
            {item.value}
            {item.suffix ? (
              <span className="ml-1 text-sm font-normal text-muted-foreground">{item.suffix}</span>
            ) : null}
          </dd>
          {item.hint ? <span className="text-xs text-muted-foreground">{item.hint}</span> : null}
        </div>
      ))}
    </dl>
  );
}
