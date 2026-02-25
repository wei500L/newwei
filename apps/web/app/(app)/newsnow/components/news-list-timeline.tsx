"use client";

import { MoreOutlined } from "@ant-design/icons";
import { Button, Dropdown, type MenuProps } from "antd";

import { useIsMobile } from "../hooks/use-is-mobile";
import type { NewsItem } from "../hooks/use-news-sources";
import type { CrossSourceItemMeta } from "../lib/newsnow-dnd";
import { useRelativeTime } from "../hooks/use-relative-time";
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
    <ol className="ml-1.5 flex flex-col border-l border-zinc-700/65">
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
            className="group relative ml-3 border-b border-white/6 pb-2 pt-1.5 last:border-b-0"
          >
            <span className="absolute -left-[15px] top-[10px] h-2 w-2 rounded-full bg-zinc-500/90 shadow-[0_0_0_2px_rgba(8,11,17,0.95)]" />
            <div className="mb-0.5 flex items-center justify-between gap-1.5 text-[11px] leading-4 text-zinc-400">
              <div className="flex min-w-0 items-center gap-1.5">
                <span>{displayTime}</span>
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
                    className="text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
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
              className={`block overflow-hidden rounded-md px-1 py-0.5 text-zinc-100 transition-colors hover:bg-white/10 hover:text-white visited:text-zinc-500 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] ${
                isComfortable
                  ? "text-[14px] leading-[1.45]"
                  : "text-[13px] leading-[1.35]"
              } ${
                isFresh ? "animate-[pulse_1.8s_ease-in-out_1] ring-1 ring-sky-300/45" : ""
              }`}
              onClick={() => {
                onOpenOriginal?.(item);
              }}
            >
              {item.title}
            </a>
            <div className="mt-0.5 flex items-center gap-1 px-1 text-[10px] text-zinc-400">
              {isFresh ? (
                <span className="rounded bg-sky-400/20 px-1 py-0.5 text-sky-200">
                  NEW
                </span>
              ) : null}
              {dedupeMeta ? (
                <span className="rounded bg-amber-400/20 px-1 py-0.5 text-amber-200">
                  同题 {dedupeMeta.groupSize} 源
                </span>
              ) : null}
            </div>
            {!isMobile ? (
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-zinc-400 opacity-0 transition-opacity duration-150 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto">
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="transition-colors hover:text-zinc-200"
                  onClick={() => {
                    onOpenOriginal?.(item);
                  }}
                >
                  原文
                </a>
                {availability.hasEvent ? (
                  <button
                    type="button"
                    className="transition-colors hover:text-zinc-200"
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
                    className="transition-colors hover:text-zinc-200"
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
