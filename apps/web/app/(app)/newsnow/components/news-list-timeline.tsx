"use client";

import { Tooltip } from "antd";
import { NewsItem } from "../hooks/use-news-sources";
import { useRelativeTime } from "../hooks/use-relative-time";

interface NewsListTimelineProps {
  items: NewsItem[];
}

export function NewsListTimeline({ items }: NewsListTimelineProps) {
  const { getRelativeTime } = useRelativeTime();

  return (
    <ul className="space-y-1 py-1">
      {items.map((item) => (
        <li key={item.id} className="group flex items-start gap-4 rounded-md px-2 py-1.5 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800">
          <span className="mt-0.5 shrink-0 text-[11px] text-zinc-400 dark:text-zinc-500 w-12 text-right">
            {getRelativeTime(item.pubDate || item.extra?.date)}
          </span>
          <div className="flex-1 overflow-hidden">
            <Tooltip title={item.extra?.hover} placement="left" mouseEnterDelay={0.5}>
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block truncate text-sm text-zinc-800 transition-colors group-hover:text-blue-600 dark:text-zinc-200"
              >
                {item.title}
              </a>
            </Tooltip>
            {item.extra?.info && (
              <span className="mt-0.5 inline-block text-[11px] text-zinc-400 dark:text-zinc-500">
                {item.extra.info}
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
