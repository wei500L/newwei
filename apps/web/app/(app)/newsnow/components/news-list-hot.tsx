"use client";

import { MoreOutlined } from "@ant-design/icons";
import { Button, Dropdown, type MenuProps } from "antd";
import { useEffect, useState } from "react";

import { useIsMobile } from "../hooks/use-is-mobile";
import type { NewsItem, NewsnowAnalyzedItem } from "../hooks/use-news-sources";
import type { CrossSourceItemMeta } from "../lib/newsnow-dnd";
import { buildItemAnalysisBadges } from "../lib/newsnow-hottest-analysis";
import { getNewsItemStableKey } from "../lib/newsnow-items";
import type { NewsnowDensityMode } from "../store/newsnow-store";

interface NewsListHotProps {
  items: NewsItem[];
  onOpenEvent?: (item: NewsItem) => void;
  onOpenItem?: (item: NewsItem) => void;
  onOpenOriginal?: (item: NewsItem) => void;
  freshItemIds?: string[];
  crossSourceMetaByItemId?: Record<string, CrossSourceItemMeta>;
  actionAvailabilityByItemId?: Record<string, { hasEvent: boolean; hasItem: boolean }>;
  analysisByItemId?: Record<string, NewsnowAnalyzedItem>;
  densityMode?: NewsnowDensityMode;
}

function getRankClass(index: number) {
  switch (index) {
    case 0:
      return "bg-gradient-to-b from-amber-400 to-orange-500 text-white shadow-sm ring-1 ring-orange-500/20";
    case 1:
      return "bg-gradient-to-b from-slate-300 to-slate-400 text-slate-800 shadow-sm ring-1 ring-slate-400/20";
    case 2:
      return "bg-gradient-to-b from-orange-300 to-orange-400 text-orange-900 shadow-sm ring-1 ring-orange-400/20";
    default:
      return "bg-[var(--secondary)] text-[var(--secondary-foreground)] border border-[var(--border)]";
  }
}

function DiffBadge({ diff }: { diff: number }) {
  const [shown, setShown] = useState(true);

  useEffect(() => {
    setShown(true);
    const timer = window.setTimeout(() => {
      setShown(false);
    }, 5000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [diff]);

  if (!shown) {
    return null;
  }

  return (
    <span
      className={`pointer-events-none absolute left-[34px] top-[3px] text-[10px] font-bold leading-none opacity-80 transition-opacity ${diff < 0 ? "text-[var(--bullish)]" : "text-[var(--destructive)]"}`}
    >
      {diff > 0 ? `+${diff}` : diff}
    </span>
  );
}

function ExtraInfo({ item }: { item: NewsItem }) {
  if (item.extra?.info) {
    return <span>{item.extra.info}</span>;
  }

  if (!item.extra?.icon) {
    return null;
  }

  if (typeof item.extra.icon === "string") {
    return (
      <img
        src={item.extra.icon}
        alt=""
        referrerPolicy="no-referrer"
        onError={(event) => {
          event.currentTarget.style.display = "none";
        }}
        className="inline h-3.5 max-w-[48px] align-middle"
      />
    );
  }

  return (
    <img
      src={item.extra.icon.url}
      alt=""
      referrerPolicy="no-referrer"
      onError={(event) => {
        event.currentTarget.style.display = "none";
      }}
      style={{ transform: `scale(${item.extra.icon.scale})` }}
      className="inline h-3.5 max-w-[48px] align-middle"
    />
  );
}

export function NewsListHot({
  items,
  onOpenEvent,
  onOpenItem,
  onOpenOriginal,
  freshItemIds,
  crossSourceMetaByItemId,
  actionAvailabilityByItemId,
  analysisByItemId,
  densityMode = "compact",
}: NewsListHotProps) {
  const isMobile = useIsMobile();
  const freshSet = new Set(freshItemIds ?? []);
  const isComfortable = densityMode === "comfortable";

  return (
    <ol className="flex flex-col gap-2.5">
      {items.map((item, index) => {
        const href = isMobile ? item.mobileUrl || item.url : item.url;
        const itemKey = getNewsItemStableKey(item, index);
        const dedupeMeta = crossSourceMetaByItemId?.[itemKey];
        const isFresh = freshSet.has(itemKey);
        const analysisBadges = buildItemAnalysisBadges(analysisByItemId?.[itemKey]);
        const availability = actionAvailabilityByItemId?.[itemKey] ?? {
          hasEvent: false,
          hasItem: false,
        };
        const actionMenuItems: MenuProps["items"] = [
          { key: "original", label: "原文" },
          ...(availability.hasEvent ? [{ key: "event", label: "事件" }] : []),
          ...(availability.hasItem ? [{ key: "item", label: "深读" }] : []),
        ];

        const openOriginalFromMenu = () => {
          onOpenOriginal?.(item);
          if (typeof window !== "undefined") {
            window.open(href, "_blank", "noopener,noreferrer");
          }
        };
        return (
          <li
            key={itemKey}
            className="group relative border-b border-[var(--border)] pb-1.5 last:border-b-0"
          >
            <div className="flex items-start gap-2">
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                title={item.extra?.hover}
                className={`relative grid min-h-[52px] flex-1 grid-cols-[24px_minmax(0,1fr)] items-start gap-3 rounded-xl px-2 py-2 text-[var(--foreground)] transition-colors duration-150 hover:bg-[var(--secondary)]/60 visited:text-[var(--secondary-foreground)] ${
                  isFresh ? "animate-[pulse_1.8s_ease-in-out_1] bg-sky-500/5 ring-1 ring-sky-500/20" : ""
                }`}
                onClick={() => {
                  onOpenOriginal?.(item);
                }}
              >
                <span
                  className={`mt-[1px] flex h-6 w-6 shrink-0 items-center justify-center rounded-[8px] text-[12px] font-bold leading-none ${getRankClass(index)}`}
                >
                  {index + 1}
                </span>
                {typeof item.extra?.diff === "number" && item.extra.diff !== 0 ? (
                  <DiffBadge diff={item.extra.diff} />
                ) : null}
                <span className="min-w-0 leading-snug">
                  <span
                    className={`block overflow-hidden transition-colors group-hover:text-[var(--primary)] font-medium [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] ${
                      isComfortable
                        ? "text-sm leading-[1.45]"
                        : "text-[13px] leading-[1.4]"
                    }`}
                  >
                    {item.title}
                  </span>
                  <span className="mt-1 block truncate text-[11px] leading-4 text-[var(--secondary-foreground)] opacity-80">
                    <ExtraInfo item={item} />
                  </span>
                  <span className="mt-1 flex items-center gap-1.5 text-[10px]">
                    {isFresh ? (
                      <span className="rounded-[4px] bg-sky-500/10 border border-sky-500/20 px-1.5 py-0.5 font-bold text-sky-600 dark:text-sky-400">
                        NEW
                      </span>
                    ) : null}
                    {dedupeMeta ? (
                      <span className="rounded-[4px] bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 font-semibold text-amber-600 dark:text-amber-400">
                        同题 {dedupeMeta.groupSize} 源
                      </span>
                    ) : null}
                    {analysisBadges.map((badge) => {
                      const className =
                        badge.tone === "emerald"
                          ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                          : badge.tone === "amber"
                            ? "border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-300"
                            : badge.tone === "violet"
                              ? "border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-300"
                              : badge.tone === "sky"
                                ? "border-sky-500/20 bg-sky-500/10 text-sky-600 dark:text-sky-300"
                                : "border-white/10 bg-white/5 text-[var(--secondary-foreground)]";
                      return (
                        <span
                          key={badge.key}
                          className={`rounded-[4px] border px-1.5 py-0.5 font-medium ${className}`}
                        >
                          {badge.label}
                        </span>
                      );
                    })}
                  </span>
                </span>
              </a>
              {isMobile ? (
                <Dropdown
                  menu={{
                    items: actionMenuItems,
                    onClick: ({ key }) => {
                      if (key === "original") {
                        openOriginalFromMenu();
                        return;
                      }
                      if (key === "event") {
                        onOpenEvent?.(item);
                        return;
                      }
                      if (key === "item") {
                        onOpenItem?.(item);
                      }
                    },
                  }}
                  trigger={["click"]}
                >
                  <Button
                    type="text"
                    size="small"
                    icon={<MoreOutlined />}
                    className="mt-1 text-[var(--secondary-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
                    aria-label="更多操作"
                  />
                </Dropdown>
              ) : null}
            </div>
            {!isMobile ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-1.5 pl-[36px] text-[11px] text-[var(--secondary-foreground)] opacity-0 transition-opacity duration-150 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto">
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium transition-colors hover:text-[var(--primary)]"
                  onClick={() => {
                    onOpenOriginal?.(item);
                  }}
                >
                  原文
                </a>
                {availability.hasEvent ? (
                  <button
                    type="button"
                    className="font-medium transition-colors hover:text-[var(--primary)]"
                    onClick={() => {
                      onOpenEvent?.(item);
                    }}
                  >
                    事件
                  </button>
                ) : null}
                {availability.hasItem ? (
                  <button
                    type="button"
                    className="font-medium transition-colors hover:text-[var(--primary)]"
                    onClick={() => {
                      onOpenItem?.(item);
                    }}
                  >
                    深读
                  </button>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
