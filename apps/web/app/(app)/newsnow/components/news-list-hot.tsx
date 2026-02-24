"use client";

import { useEffect, useState } from "react";

import { useIsMobile } from "../hooks/use-is-mobile";
import type { NewsItem } from "../hooks/use-news-sources";

interface NewsListHotProps {
  items: NewsItem[];
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

export function NewsListHot({ items }: NewsListHotProps) {
  const isMobile = useIsMobile();

  return (
    <ol className="flex flex-col gap-1.5">
      {items.map((item, index) => {
        const href = isMobile ? item.mobileUrl || item.url : item.url;
        return (
          <li
            key={item.id}
            className="relative border-b border-white/6 pb-[1px] last:border-b-0"
          >
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              title={item.extra?.hover}
              className="group relative grid min-h-[44px] grid-cols-[24px_minmax(0,1fr)] items-start gap-2.5 rounded-md px-1.5 py-1.5 text-zinc-100 transition-colors hover:bg-white/10 hover:text-white visited:text-zinc-500"
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
                <span className="block overflow-hidden text-[14px] leading-[1.4] transition-colors group-hover:text-white [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
                  {item.title}
                </span>
                <span className="mt-0.5 block truncate text-[11px] leading-4 text-zinc-400">
                  <ExtraInfo item={item} />
                </span>
              </span>
            </a>
          </li>
        );
      })}
    </ol>
  );
}
