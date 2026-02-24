"use client";

import { Tooltip } from "antd";
import { NewsItem } from "../hooks/use-news-sources";

interface NewsListHotProps {
  items: NewsItem[];
}

export function NewsListHot({ items }: NewsListHotProps) {
  const getRankColor = (index: number) => {
    switch (index) {
      case 0:
        return "bg-yellow-500 text-white";
      case 1:
        return "bg-zinc-400 text-white";
      case 2:
        return "bg-amber-600 text-white";
      default:
        return "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400";
    }
  };

  return (
    <ul className="space-y-1 py-1">
      {items.map((item, index) => (
        <li key={item.id} className="group flex items-start gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800">
          <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-xs font-bold ${getRankColor(index)}`}>
            {index + 1}
          </span>
          <div className="flex-1 overflow-hidden">
            <Tooltip title={item.extra?.hover} placement="left" mouseEnterDelay={0.5}>
              <a
                href={item.mobileUrl || item.url}
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
          {item.extra?.icon && (
            <div className="shrink-0 pt-0.5">
              {typeof item.extra.icon === "string" ? (
                <img
                  src={item.extra.icon}
                  alt=""
                  referrerPolicy="no-referrer"
                  onError={(event) => {
                    event.currentTarget.style.display = "none";
                  }}
                  className="h-4 w-4 rounded-sm object-contain"
                />
              ) : (
                <img
                  src={item.extra.icon.url}
                  alt=""
                  style={{ transform: `scale(${item.extra.icon.scale})` }}
                  referrerPolicy="no-referrer"
                  onError={(event) => {
                    event.currentTarget.style.display = "none";
                  }}
                  className="h-4 w-4 rounded-sm object-contain"
                />
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
