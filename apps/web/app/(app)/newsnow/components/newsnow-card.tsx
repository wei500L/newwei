"use client";

import {
  DragOutlined,
  ReloadOutlined,
  StarFilled,
  StarOutlined,
} from "@ant-design/icons";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button, Skeleton, Tooltip, message } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import { useRelativeTime } from "../hooks/use-relative-time";
import {
  useNewsSource,
  useResolveNewsUrl,
  type NewsItem,
  type Source,
} from "../hooks/use-news-sources";
import { useNewsnowStore } from "../store/newsnow-store";
import { NewsListHot } from "./news-list-hot";
import { NewsListTimeline } from "./news-list-timeline";

interface NewsnowCardProps {
  id: string;
  source: Source;
}

const colorMap: Record<string, string> = {
  slate: "bg-slate-400",
  blue: "bg-blue-400",
  red: "bg-red-400",
  green: "bg-green-400",
  orange: "bg-orange-400",
  gray: "bg-zinc-400",
  indigo: "bg-indigo-400",
  emerald: "bg-emerald-400",
  teal: "bg-teal-400",
  yellow: "bg-amber-400",
};

const cardShellMap: Record<string, string> = {
  slate: "border-slate-300/30 bg-[#0f1520]",
  blue: "border-blue-300/28 bg-[#0b1424]",
  red: "border-red-300/28 bg-[#1a1018]",
  green: "border-green-300/28 bg-[#0d1a19]",
  orange: "border-orange-300/28 bg-[#1b1510]",
  gray: "border-zinc-300/28 bg-[#111824]",
  indigo: "border-indigo-300/28 bg-[#10152b]",
  emerald: "border-emerald-300/28 bg-[#0c1d19]",
  teal: "border-teal-300/28 bg-[#0b1c22]",
  yellow: "border-amber-300/28 bg-[#191810]",
};

const cardGlowMap: Record<string, string> = {
  slate: "shadow-[0_20px_44px_-34px_rgba(148,163,184,0.54)]",
  blue: "shadow-[0_20px_44px_-34px_rgba(59,130,246,0.56)]",
  red: "shadow-[0_20px_44px_-34px_rgba(244,63,94,0.54)]",
  green: "shadow-[0_20px_44px_-34px_rgba(16,185,129,0.54)]",
  orange: "shadow-[0_20px_44px_-34px_rgba(249,115,22,0.54)]",
  gray: "shadow-[0_20px_44px_-34px_rgba(161,161,170,0.5)]",
  indigo: "shadow-[0_20px_44px_-34px_rgba(99,102,241,0.56)]",
  emerald: "shadow-[0_20px_44px_-34px_rgba(16,185,129,0.56)]",
  teal: "shadow-[0_20px_44px_-34px_rgba(20,184,166,0.56)]",
  yellow: "shadow-[0_20px_44px_-34px_rgba(245,158,11,0.5)]",
};

const accentMap: Record<string, string> = {
  slate: "text-slate-300",
  blue: "text-blue-300",
  red: "text-red-300",
  green: "text-green-300",
  orange: "text-orange-300",
  gray: "text-gray-300",
  indigo: "text-indigo-300",
  emerald: "text-emerald-300",
  teal: "text-teal-300",
  yellow: "text-yellow-300",
};

const secretRequiredSourceIds = new Set(["weibo", "producthunt"]);

export function NewsnowCard({ id, source }: NewsnowCardProps) {
  const router = useRouter();
  const { data, isLoading, isError, isFetching, refresh } = useNewsSource(
    id,
    source.interval,
  );
  const resolveNewsUrl = useResolveNewsUrl();
  const { focusSources, toggleFocus } = useNewsnowStore();
  const { getRelativeTime } = useRelativeTime();
  const isFocused = focusSources.includes(id);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [iconLoadError, setIconLoadError] = useState(false);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.5 : 1,
  };

  const colorClass = colorMap[source.color] || "bg-blue-400";
  const cardShellClass =
    cardShellMap[source.color] || "border-blue-300/28 bg-[#0b1424]";
  const cardGlowClass =
    cardGlowMap[source.color] ||
    "shadow-[0_20px_44px_-34px_rgba(59,130,246,0.54)]";
  const accentClass = accentMap[source.color] || "text-blue-300";
  const sourceBaseId = useMemo(() => id.split("-")[0] ?? id, [id]);
  const iconUrl = `/icons/${sourceBaseId}.png`;
  const needsRuntimeSecret = secretRequiredSourceIds.has(sourceBaseId);

  const openOriginal = useCallback((item: NewsItem) => {
    if (typeof window === "undefined") {
      return;
    }
    const href = item.mobileUrl || item.url;
    window.open(href, "_blank", "noopener,noreferrer");
  }, []);

  const handleOpenEvent = useCallback(
    async (item: NewsItem) => {
      try {
        const resolved = await resolveNewsUrl(item.url);
        if (resolved.matched && resolved.eventId) {
          router.push(`/events/${resolved.eventId}`);
          return;
        }
        if (resolved.matched && resolved.itemId) {
          message.info("未匹配到事件，已打开深读");
          router.push(`/read/items/${resolved.itemId}`);
          return;
        }
      } catch {
        message.warning("解析失败，已打开原文");
        openOriginal(item);
        return;
      }

      message.info("暂未匹配到事件，已打开原文");
      openOriginal(item);
    },
    [openOriginal, resolveNewsUrl, router],
  );

  const handleOpenItem = useCallback(
    async (item: NewsItem) => {
      try {
        const resolved = await resolveNewsUrl(item.url);
        if (resolved.matched && resolved.itemId) {
          router.push(`/read/items/${resolved.itemId}`);
          return;
        }
        if (resolved.matched && resolved.eventId) {
          message.info("未匹配到深读，已打开事件");
          router.push(`/events/${resolved.eventId}`);
          return;
        }
      } catch {
        message.warning("解析失败，已打开原文");
        openOriginal(item);
        return;
      }

      message.info("暂未匹配到深读，已打开原文");
      openOriginal(item);
    },
    [openOriginal, resolveNewsUrl, router],
  );

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await refresh();
    } catch {
      // Error is surfaced by React Query state.
    } finally {
      setIsRefreshing(false);
    }
  };

  const updatedText = data?.updatedTime
    ? `${getRelativeTime(data.updatedTime)}更新`
    : isError
      ? "获取失败"
      : "加载中...";

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={`flex h-[500px] flex-col overflow-hidden rounded-2xl border ring-1 ring-inset ring-white/6 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] transition-all duration-200 hover:-translate-y-0.5 hover:ring-white/12 ${cardShellClass} ${cardGlowClass}`}
    >
      <div className={`h-0.5 w-full ${colorClass}`} />
      <div className="pointer-events-none h-2.5 w-full bg-gradient-to-b from-white/8 to-transparent" />
      <div className="flex items-start justify-between px-3 pb-2 pt-2">
        <div className="flex min-w-0 items-center gap-2">
          <a
            href={source.home}
            title={source.desc}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/20 bg-black/45 text-xs font-semibold text-zinc-200"
          >
            {iconLoadError ? (
              <span>{source.name.slice(0, 1)}</span>
            ) : (
              <img
                src={iconUrl}
                alt={source.name}
                className="h-full w-full object-cover"
                referrerPolicy="no-referrer"
                onError={() => setIconLoadError(true)}
              />
            )}
          </a>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h3 className="truncate text-[15px] font-semibold tracking-[0.01em] text-zinc-100">
                {source.name}
              </h3>
              {source.title ? (
                <span className="truncate rounded bg-black/35 px-1.5 py-0.5 text-[10px] text-zinc-300/95">
                  {source.title}
                </span>
              ) : null}
            </div>
            <p className="truncate text-[11px] text-zinc-300/80">
              {updatedText}
            </p>
          </div>
        </div>
        <div
          className={`ml-2 flex shrink-0 items-center gap-0.5 ${accentClass}`}
        >
          <Tooltip title="刷新">
            <Button
              type="text"
              size="small"
              loading={isFetching || isRefreshing}
              icon={<ReloadOutlined />}
              onClick={() => {
                void handleRefresh();
              }}
              className="text-zinc-300 hover:bg-white/10 hover:text-current"
            />
          </Tooltip>
          <Tooltip title={isFocused ? "取消关注" : "关注"}>
            <Button
              type="text"
              size="small"
              icon={
                isFocused ? (
                  <StarFilled className="text-yellow-500" />
                ) : (
                  <StarOutlined />
                )
              }
              onClick={() => toggleFocus(id)}
              className="text-zinc-300 hover:bg-white/10 hover:text-yellow-500"
            />
          </Tooltip>
          <Tooltip title="拖动排序">
            <button
              type="button"
              {...attributes}
              {...listeners}
              aria-label="拖动重新排序"
              className="inline-flex h-7 w-7 cursor-grab items-center justify-center rounded text-zinc-300 transition-colors hover:bg-white/10 hover:text-zinc-100 active:cursor-grabbing"
            >
              <DragOutlined />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="mx-2 mb-2 flex-1 overflow-y-auto rounded-xl border border-white/8 bg-[linear-gradient(180deg,#090d14_0%,#070a11_100%)] px-2 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_10px_18px_-16px_rgba(0,0,0,0.9)] [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        {isLoading ? (
          <div className="space-y-3 p-2">
            <Skeleton active paragraph={{ rows: 8 }} />
          </div>
        ) : isError ? (
          <div className="flex h-full flex-col items-center justify-center space-y-2 p-4 text-center">
            <p className="text-sm text-zinc-300">获取失败</p>
            {needsRuntimeSecret ? (
              <a
                href="/settings/system?tab=newsSourceRuntimeSecrets"
                className="text-xs text-blue-300 underline-offset-2 hover:underline"
              >
                去系统设置 &gt; 新闻源密钥
              </a>
            ) : null}
            <Button
              size="small"
              onClick={() => {
                void handleRefresh();
              }}
            >
              重试
            </Button>
          </div>
        ) : data && data.items.length > 0 ? (
          source.type === "hottest" ? (
            <NewsListHot
              items={data.items}
              onOpenEvent={handleOpenEvent}
              onOpenItem={handleOpenItem}
            />
          ) : (
            <NewsListTimeline
              items={data.items}
              onOpenEvent={handleOpenEvent}
              onOpenItem={handleOpenItem}
            />
          )
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
            <p className="text-xs text-zinc-300">暂无数据</p>
            {needsRuntimeSecret ? (
              <a
                href="/settings/system?tab=newsSourceRuntimeSecrets"
                className="text-xs text-blue-300 underline-offset-2 hover:underline"
              >
                该源可能需要先配置密钥
              </a>
            ) : null}
          </div>
        )}
      </div>
    </article>
  );
}
