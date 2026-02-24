"use client";

import { useIsMobile } from "../hooks/use-is-mobile";
import type { NewsItem } from "../hooks/use-news-sources";
import { useRelativeTime } from "../hooks/use-relative-time";

interface NewsListTimelineProps {
  items: NewsItem[];
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

export function NewsListTimeline({ items }: NewsListTimelineProps) {
  const { getRelativeTime } = useRelativeTime();
  const isMobile = useIsMobile();

  return (
    <ol className="ml-1.5 flex flex-col border-l border-zinc-700/65">
      {items.map((item) => {
        const href = isMobile ? item.mobileUrl || item.url : item.url;
        const displayTime = getRelativeTime(item.pubDate || item.extra?.date);

        return (
          <li
            key={`${item.id}-${item.pubDate || item.extra?.date || ""}`}
            className="relative ml-3 border-b border-white/6 pb-2 pt-1.5 last:border-b-0"
          >
            <span className="absolute -left-[15px] top-[10px] h-2 w-2 rounded-full bg-zinc-500/90 shadow-[0_0_0_2px_rgba(8,11,17,0.95)]" />
            <div className="mb-0.5 flex items-center gap-1.5 text-[11px] leading-4 text-zinc-400">
              <span>{displayTime}</span>
              <span className="truncate">
                <ExtraInfo item={item} />
              </span>
            </div>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              title={item.extra?.hover}
              className="block overflow-hidden rounded-md px-1 py-0.5 text-[14px] leading-[1.4] text-zinc-100 transition-colors hover:bg-white/10 hover:text-white visited:text-zinc-500 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]"
            >
              {item.title}
            </a>
          </li>
        );
      })}
    </ol>
  );
}
