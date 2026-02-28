"use client";

import { MoreOutlined } from "@ant-design/icons";
import { Button, Dropdown, type MenuProps } from "antd";

import { useIsMobile } from "../hooks/use-is-mobile";
import type { NewsItem } from "../hooks/use-news-sources";
import { useRelativeTime } from "../hooks/use-relative-time";
import type { CrossSourceItemMeta } from "../lib/newsnow-dnd";
import type { NewsnowDensityMode } from "../store/newsnow-store";

interface NewsListTimelineProps {
  items: NewsItem[];
  onOpenEvent?: (item: NewsItem) => void;
  onOpenItem?: (item: NewsItem) => void;
  onOpenOriginal?: (item: NewsItem) => void;
  freshItemIds?: string[];
  crossSourceMetaByItemId?: Record<string, CrossSourceItemMeta>;
  actionAvailabilityByItemId?: Record<string, { hasEvent: boolean; hasItem: boolean }>;
  densityMode?: NewsnowDensityMode;
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

function toItemKey(item: NewsItem): string {
  return String(item.id);
}

export function NewsListTimeline({
  items,
  onOpenEvent,
  onOpenItem,
  onOpenOriginal,
  freshItemIds,
  crossSourceMetaByItemId,
  actionAvailabilityByItemId,
  densityMode = "compact",
}: NewsListTimelineProps) {
  const { getRelativeTime } = useRelativeTime();
  const isMobile = useIsMobile();
  const freshSet = new Set(freshItemIds ?? []);
  const isComfortable = densityMode === "comfortable";

  return (
    <ol className="ml-2 flex flex-col border-l border-[var(--border)]">
      {items.map((item) => {
        const href = isMobile ? item.mobileUrl || item.url : item.url;
        const displayTime = getRelativeTime(item.pubDate || item.extra?.date);
        const itemKey = toItemKey(item);
        const dedupeMeta = crossSourceMetaByItemId?.[itemKey];
        const isFresh = freshSet.has(itemKey);
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
            key={`${item.id}-${item.pubDate || item.extra?.date || ""}`}
            className="group relative ml-3.5 border-b border-[var(--border)] pb-2.5 pt-2 last:border-b-0"
          >
            <span className="absolute -left-[18px] top-[12px] h-[7px] w-[7px] rounded-full bg-[var(--primary)] ring-[3px] ring-[var(--background)] shadow-sm" />
            <div className="mb-1 flex items-center justify-between gap-1.5 text-[11px] leading-4 text-[var(--secondary-foreground)] opacity-80">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="font-medium">{displayTime}</span>
                <span className="truncate">
                  <ExtraInfo item={item} />
                </span>
              </div>
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
                    className="text-[var(--secondary-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
                    aria-label="更多操作"
                  />
                </Dropdown>
              ) : null}
            </div>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              title={item.extra?.hover}
              className={`block overflow-hidden rounded-xl px-2 py-1.5 text-[var(--foreground)] font-medium transition-colors duration-150 hover:bg-[var(--secondary)]/60 visited:text-[var(--secondary-foreground)] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] ${
                isComfortable
                  ? "text-[14px] leading-[1.45]"
                  : "text-[13px] leading-[1.4]"
              } ${
                isFresh ? "animate-[pulse_1.8s_ease-in-out_1] bg-sky-500/5 ring-1 ring-sky-500/20" : ""
              }`}
              onClick={() => {
                onOpenOriginal?.(item);
              }}
            >
              {item.title}
            </a>
            <div className="mt-1 flex items-center gap-1.5 px-2 text-[10px]">
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
            </div>
            {!isMobile ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-[11px] text-[var(--secondary-foreground)] opacity-0 transition-opacity duration-150 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto">
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
