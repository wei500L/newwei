"use client";

import { ReloadOutlined, StarFilled, StarOutlined, DragOutlined } from "@ant-design/icons";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button, Skeleton, Tooltip } from "antd";
import { useState } from "react";

import { useRelativeTime } from "../hooks/use-relative-time";
import { useNewsSource, type Source } from "../hooks/use-news-sources";
import { useNewsnowStore } from "../store/newsnow-store";
import { NewsListHot } from "./news-list-hot";
import { NewsListTimeline } from "./news-list-timeline";

interface NewsnowCardProps {
  id: string;
  source: Source;
}

const colorMap: Record<string, string> = {
  slate: "bg-slate-500",
  blue: "bg-blue-500",
  red: "bg-red-500",
  green: "bg-green-500",
  orange: "bg-orange-500",
  gray: "bg-gray-500",
  indigo: "bg-indigo-500",
  emerald: "bg-emerald-500",
  teal: "bg-teal-500",
  yellow: "bg-yellow-500",
};

export function NewsnowCard({ id, source }: NewsnowCardProps) {
  const { data, isLoading, isError, isFetching, refresh } = useNewsSource(id, source.interval);
  const { focusSources, toggleFocus } = useNewsnowStore();
  const { getRelativeTime } = useRelativeTime();
  const isFocused = focusSources.includes(id);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.5 : 1,
  };

  const colorClass = colorMap[source.color] || "bg-blue-500";

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await refresh();
    } catch {
      // error handled by React Query
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex h-[500px] flex-col rounded-lg border bg-white shadow-sm transition-shadow hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div className={`h-1 w-full rounded-t-lg ${colorClass}`} />
      <div className="flex items-center justify-between border-b px-4 py-2 dark:border-zinc-800">
        <div className="flex items-center gap-2 overflow-hidden">
          <div {...attributes} {...listeners} aria-label="拖动重新排序" className="cursor-grab p-1 text-zinc-400 hover:text-zinc-600 active:cursor-grabbing">
            <DragOutlined />
          </div>
          <div className="overflow-hidden">
            <h3 className="truncate text-sm font-bold text-zinc-800 dark:text-zinc-200">{source.name}</h3>
            {source.title && (
              <p className="truncate text-[10px] text-zinc-400 dark:text-zinc-500">{source.title}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-zinc-400">
            {data?.updatedTime ? getRelativeTime(data.updatedTime) : ""}
          </span>
          <Tooltip title="刷新">
            <Button
              type="text"
              size="small"
              loading={isFetching || isRefreshing}
              icon={<ReloadOutlined />}
              onClick={() => { void handleRefresh(); }}
              className="text-zinc-400 hover:text-blue-500"
            />
          </Tooltip>
          <Tooltip title={isFocused ? "取消关注" : "关注"}>
            <Button
              type="text"
              size="small"
              icon={isFocused ? <StarFilled className="text-yellow-500" /> : <StarOutlined />}
              onClick={() => toggleFocus(id)}
              className="text-zinc-400 hover:text-yellow-500"
            />
          </Tooltip>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-1 scrollbar-thin scrollbar-thumb-zinc-200 dark:scrollbar-thumb-zinc-800">
        {isLoading ? (
          <div className="space-y-3 p-2">
            <Skeleton active paragraph={{ rows: 8 }} />
          </div>
        ) : isError ? (
          <div className="flex h-full flex-col items-center justify-center space-y-2 p-4 text-center">
            <p className="text-sm text-zinc-500">获取失败</p>
            <Button size="small" onClick={() => { void handleRefresh(); }}>
              重试
            </Button>
          </div>
        ) : data && data.items.length > 0 ? (
          source.type === "hottest" ? (
            <NewsListHot items={data.items} />
          ) : (
            <NewsListTimeline items={data.items} />
          )
        ) : (
          <div className="flex h-full items-center justify-center p-4 text-center">
            <p className="text-xs text-zinc-400">暂无数据</p>
          </div>
        )}
      </div>
    </div>
  );
}
