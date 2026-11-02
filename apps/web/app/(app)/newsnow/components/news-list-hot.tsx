"use client";

import { MoreOutlined } from "@ant-design/icons";
import { Button, Dropdown, type MenuProps } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

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
  if (index < 3) {
    return "bg-[var(--foreground)] text-[var(--background)]";
  }
  return "text-[var(--muted-foreground)]";
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
  const { t } = useTranslation();
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
          { key: "original", label: t("newsnow.actions.original") },
          ...(availability.hasEvent
            ? [{ key: "event", label: t("newsnow.actions.event") }]
            : []),
          ...(availability.hasItem
            ? [{ key: "item", label: t("newsnow.actions.item") }]
            : []),
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
                className={`relative grid min-h-[52px] flex-1 grid-cols-[24px_minmax(0,1fr)] items-start gap-3 rounded px-2 py-2 text-[var(--foreground)] transition-colors duration-150 hover:bg-[var(--secondary)]/60 visited:text-[var(--secondary-foreground)] ${
                  isFresh ? "animate-[pulse_1.8s_ease-in-out_1] bg-[var(--secondary)] ring-1 ring-[var(--accent)]" : ""
                }`}
                onClick={() => {
                  onOpenOriginal?.(item);
                }}
              >
                <span
                  className={`mt-[1px] flex h-6 w-6 shrink-0 items-center justify-center rounded-sm font-mono text-xs font-bold tabular-nums leading-none ${getRankClass(index)}`}
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
                  <span className="mt-1 block truncate text-xs leading-4 text-[var(--secondary-foreground)] opacity-80">
                    <ExtraInfo item={item} />
                  </span>
                  <span className="mt-1 flex items-center gap-1.5 text-[10px]">
                    {isFresh ? (
                      <span className="rounded-sm border border-[var(--border)] px-1.5 py-0.5 font-bold text-[var(--accent)]">
                        NEW
                      </span>
                    ) : null}
                    {dedupeMeta ? (
                      <span className="rounded-sm border border-[var(--border)] px-1.5 py-0.5 font-semibold text-[var(--muted-foreground)]">
                        {t("newsnow.actions.duplicate", { count: dedupeMeta.groupSize })}
                      </span>
                    ) : null}
                    {analysisBadges.map((badge) => {
                      const className =
                        badge.tone === "emerald"
                          ? "border-[var(--border)] text-[var(--accent)]"
                          : badge.tone === "amber"
                            ? "border-[var(--border)] text-[var(--accent)]"
                            : badge.tone === "violet"
                              ? "border-[var(--border)] text-[var(--muted-foreground)]"
                              : badge.tone === "sky"
                                ? "border-[var(--border)] text-[var(--accent)]"
                                : "border-[var(--border)] bg-[var(--secondary)] text-[var(--secondary-foreground)]";
                      return (
                        <span
                          key={badge.key}
                          className={`rounded-sm border px-1.5 py-0.5 font-medium ${className}`}
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
                    aria-label={t("newsnow.actions.more")}
                  />
                </Dropdown>
              ) : null}
            </div>
            {!isMobile ? (
              <div className="absolute right-2 top-1/2 flex -translate-y-1/2 flex-wrap items-center gap-x-3 gap-y-1 rounded bg-[var(--surface)] px-2 py-1 text-xs text-[var(--secondary-foreground)] opacity-0 transition-opacity duration-150 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto">
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium transition-colors hover:text-[var(--primary)]"
                  onClick={() => {
                    onOpenOriginal?.(item);
                  }}
                >
                  {t("newsnow.actions.original")}
                </a>
                {availability.hasEvent ? (
                  <button
                    type="button"
                    className="font-medium transition-colors hover:text-[var(--primary)]"
                    onClick={() => {
                      onOpenEvent?.(item);
                    }}
                  >
                    {t("newsnow.actions.event")}
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
                    {t("newsnow.actions.item")}
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
