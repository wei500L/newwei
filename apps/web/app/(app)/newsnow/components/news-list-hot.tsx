"use client";

import { MoreOutlined } from "@ant-design/icons";
import { Button, Dropdown, type MenuProps } from "antd";
import { useEffect, useState } from "react";

import { useIsMobile } from "../hooks/use-is-mobile";
import type { NewsItem } from "../hooks/use-news-sources";
import type { CrossSourceItemMeta } from "../lib/newsnow-dnd";
import type { NewsnowDensityMode } from "../store/newsnow-store";

interface NewsListHotProps {
  items: NewsItem[];
  onOpenEvent?: (item: NewsItem) => void;
  onOpenItem?: (item: NewsItem) => void;
  onOpenOriginal?: (item: NewsItem) => void;
  freshItemIds?: string[];
  crossSourceMetaByItemId?: Record<string, CrossSourceItemMeta>;
  actionAvailabilityByItemId?: Record<string, { hasEvent: boolean; hasItem: boolean }>;
  densityMode?: NewsnowDensityMode;
}

function getRankClass(index: number) {
  switch (index) {
    case 0:
      return "bg-gradient-to-b from-yellow-400 to-amber-500 text-white";
    case 1:
      return "bg-gradient-to-b from-zinc-300 to-zinc-500 text-white";
    case 2:
      return "bg-gradient-to-b from-amber-500 to-orange-600 text-white";
    default:
      return "bg-zinc-700/60 text-zinc-200";
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
      className={`pointer-events-none absolute left-[34px] top-[3px] text-[10px] font-medium leading-none opacity-70 transition-opacity ${diff < 0 ? "text-emerald-400" : "text-rose-400"}`}
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

function toItemKey(item: NewsItem): string {
  return String(item.id);
}

export function NewsListHot({
  items,
  onOpenEvent,
  onOpenItem,
  onOpenOriginal,
  freshItemIds,
  crossSourceMetaByItemId,
  actionAvailabilityByItemId,
  densityMode = "compact",
}: NewsListHotProps) {
  const isMobile = useIsMobile();
  const freshSet = new Set(freshItemIds ?? []);
  const isComfortable = densityMode === "comfortable";

  return (
    <ol className="flex flex-col gap-1.5">
      {items.map((item, index) => {
        const href = isMobile ? item.mobileUrl || item.url : item.url;
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
            key={item.id}
            className="group relative border-b border-white/6 pb-[1px] last:border-b-0"
          >
            <div className="flex items-start gap-2">
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                title={item.extra?.hover}
                className={`relative grid min-h-[44px] flex-1 grid-cols-[24px_minmax(0,1fr)] items-start gap-2.5 rounded-md px-1.5 py-1.5 text-zinc-100 transition-colors hover:bg-white/10 hover:text-white visited:text-zinc-500 ${
                  isFresh ? "animate-[pulse_1.8s_ease-in-out_1] ring-1 ring-sky-300/45" : ""
                }`}
                onClick={() => {
                  onOpenOriginal?.(item);
                }}
              >
                <span
                  className={`mt-[1px] flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[12px] font-semibold leading-none shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] ${getRankClass(index)}`}
                >
                  {index + 1}
                </span>
                {typeof item.extra?.diff === "number" && item.extra.diff !== 0 ? (
                  <DiffBadge diff={item.extra.diff} />
                ) : null}
                <span className="min-w-0 leading-snug">
                  <span
                    className={`block overflow-hidden transition-colors group-hover:text-white [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] ${
                      isComfortable
                        ? "text-[14px] leading-[1.45]"
                        : "text-[13px] leading-[1.35]"
                    }`}
                  >
                    {item.title}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] leading-4 text-zinc-400">
                    <ExtraInfo item={item} />
                  </span>
                  <span className="mt-0.5 flex items-center gap-1 text-[10px] text-zinc-400">
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
                    className="mt-1 text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
                    aria-label="更多操作"
                  />
                </Dropdown>
              ) : null}
            </div>
            {!isMobile ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-1 pl-[34px] text-[11px] text-zinc-400 opacity-0 transition-opacity duration-150 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto">
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
