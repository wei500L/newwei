'use client';

import { DislikeOutlined } from '@ant-design/icons';
import { Alert, Button, Empty, Skeleton, Tooltip } from 'antd';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  getSessionHiddenBehaviorKeys,
  hideSessionBehaviorKey,
  subscribeSessionHiddenBehaviorKeys,
  trackUserNewsBehavior,
} from '@/lib/user-news-behavior';

import { buildNewsnowRecommendedNotInterestedPayload } from '../hooks/newsnow-recommended-feedback';
import {
  type NewsnowRecommendedItem,
  useNewsnowRecommended,
} from '../hooks/use-newsnow-recommended';

import { NewsnowBoardContainer } from './newsnow-board-container';

function formatPublishedAt(value?: number | string | null) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toLocaleString();
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleString();
    }
    return value;
  }
  return '刚刚';
}

function scorePercent(score: number) {
  return Math.round(Math.max(0, Math.min(1, score)) * 100);
}

function RecommendedFeedItem({ item }: { item: NewsnowRecommendedItem }) {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const trackedRef = useRef(false);

  useEffect(() => {
    trackedRef.current = false;
  }, [item.id]);

  useEffect(() => {
    const node = rootRef.current;
    if (!node) {
      return;
    }

    const emitView = () => {
      if (trackedRef.current) {
        return;
      }
      trackedRef.current = true;
      void trackUserNewsBehavior({
        type: 'view',
        source: item.sourceId,
        itemId: item.matchedItemId,
        eventId: item.matchedEventId,
        topics: item.topics,
        entities: item.entities,
        url: item.url,
      });
    };

    if (
      typeof window === 'undefined' ||
      typeof IntersectionObserver === 'undefined'
    ) {
      emitView();
      return;
    }

    let timer: number | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) {
          return;
        }
        if (entry.isIntersecting && entry.intersectionRatio >= 0.45) {
          if (timer === null) {
            timer = window.setTimeout(() => {
              timer = null;
              emitView();
            }, 600);
          }
          return;
        }
        if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
      },
      { threshold: [0, 0.45, 0.8] },
    );
    observer.observe(node);

    return () => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      observer.disconnect();
    };
  }, [
    item.entities,
    item.id,
    item.matchedEventId,
    item.matchedItemId,
    item.sourceId,
    item.topics,
    item.url,
  ]);

  const handleOpenOriginal = useCallback(() => {
    void trackUserNewsBehavior({
      type: 'click',
      source: item.sourceId,
      itemId: item.matchedItemId,
      eventId: item.matchedEventId,
      topics: item.topics,
      entities: item.entities,
      url: item.url,
    });
    if (typeof window !== 'undefined') {
      window.open(item.mobileUrl || item.url, '_blank', 'noopener,noreferrer');
    }
  }, [item]);

  const handleOpenEvent = useCallback(() => {
    if (!item.matchedEventId) {
      return;
    }
    void trackUserNewsBehavior({
      type: 'open_event',
      source: item.sourceId,
      eventId: item.matchedEventId,
      itemId: item.matchedItemId,
      topics: item.topics,
      entities: item.entities,
      url: item.url,
    });
    router.push(`/events/${item.matchedEventId}`);
  }, [item, router]);

  const handleOpenItem = useCallback(() => {
    if (!item.matchedItemId) {
      return;
    }
    void trackUserNewsBehavior({
      type: 'open_item',
      source: item.sourceId,
      itemId: item.matchedItemId,
      eventId: item.matchedEventId,
      topics: item.topics,
      entities: item.entities,
      url: item.url,
    });
    router.push(`/items/${item.matchedItemId}`);
  }, [item, router]);

  const handleNotInterested = useCallback(() => {
    hideSessionBehaviorKey('newsnowItems', item.id);
    void trackUserNewsBehavior(
      buildNewsnowRecommendedNotInterestedPayload(item),
    );
  }, [item]);

  const scoreSummary = useMemo(
    () =>
      [
        `内容 ${scorePercent(item.scoreBreakdown.content)}`,
        `协同 ${scorePercent(item.scoreBreakdown.collaborative)}`,
        `来源 ${scorePercent(item.scoreBreakdown.source)}`,
        `热度 ${scorePercent(item.scoreBreakdown.hotness)}`,
      ].join(' · '),
    [item.scoreBreakdown],
  );

  return (
    <div
      ref={rootRef}
      className="glass-panel rounded-[24px] border border-white/40 px-5 py-4 shadow-[0_18px_40px_-28px_rgba(15,23,42,0.72)] dark:border-white/10 dark:bg-white/[0.04]"
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-zinc-400">
            <span>{item.sourceName}</span>
            <span className="rounded-full bg-slate-900 px-2 py-1 text-[10px] tracking-[0.08em] text-white dark:bg-white dark:text-slate-950">
              推荐 {Math.round(item.score * 100)}
            </span>
            <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-1 text-[10px] tracking-[0.08em] text-emerald-700 dark:text-emerald-300">
              {item.reasonLabel}
            </span>
          </div>

          <div className="mt-3">
            <button
              type="button"
              onClick={handleOpenOriginal}
              className="text-left text-lg font-semibold leading-8 text-slate-900 transition-colors hover:text-[var(--primary)] dark:text-zinc-100"
            >
              {item.title}
            </button>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-zinc-400">
            <span>{formatPublishedAt(item.pubDate)}</span>
            <span>来源 {item.sourceId}</span>
            {item.topics.slice(0, 3).map((topic) => (
              <span
                key={topic}
                className="rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-1 text-[11px] text-sky-700 dark:text-sky-300"
              >
                {topic}
              </span>
            ))}
            {item.entities.slice(0, 2).map((entity) => (
              <span
                key={entity}
                className="rounded-full border border-violet-500/20 bg-violet-500/10 px-2 py-1 text-[11px] text-violet-700 dark:text-violet-300"
              >
                {entity}
              </span>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-stretch gap-2 md:max-w-[240px] lg:w-[240px]">
          <Tooltip title={scoreSummary}>
            <div className="rounded-[18px] border border-slate-200/70 bg-white/75 px-3 py-2 text-xs text-slate-600 shadow-[0_12px_24px_-28px_rgba(15,23,42,0.75)] dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-300">
              综合分 {Math.round(item.score * 100)}
            </div>
          </Tooltip>
          <Button onClick={handleOpenOriginal}>原文</Button>
          <Button disabled={!item.matchedEventId} onClick={handleOpenEvent}>
            事件
          </Button>
          <Button disabled={!item.matchedItemId} onClick={handleOpenItem}>
            深读
          </Button>
          <Button icon={<DislikeOutlined />} onClick={handleNotInterested}>
            不感兴趣
          </Button>
        </div>
      </div>
    </div>
  );
}

export function NewsnowRecommendedFeed() {
  const { data, isLoading, isError, error, refetch } = useNewsnowRecommended();
  const [hiddenItemIds, setHiddenItemIds] = useState<Set<string>>(
    () => new Set(getSessionHiddenBehaviorKeys('newsnowItems')),
  );

  useEffect(() => {
    return subscribeSessionHiddenBehaviorKeys('newsnowItems', (keys) => {
      setHiddenItemIds(new Set(keys));
    });
  }, []);

  const items = useMemo(
    () => (data?.items ?? []).filter((item) => !hiddenItemIds.has(item.id)),
    [data?.items, hiddenItemIds],
  );

  if (isLoading) {
    return (
      <NewsnowBoardContainer spacing="content">
        <div className="glass-panel rounded-[26px] border border-white/40 px-5 py-5 dark:border-white/10 dark:bg-white/[0.04]">
          <Skeleton active paragraph={{ rows: 8 }} />
        </div>
      </NewsnowBoardContainer>
    );
  }

  if (isError) {
    return (
      <NewsnowBoardContainer spacing="content">
        <Alert
          showIcon
          type="error"
          message="推荐流加载失败"
          description={error instanceof Error ? error.message : '请稍后重试。'}
          action={<Button onClick={() => void refetch()}>重试</Button>}
        />
      </NewsnowBoardContainer>
    );
  }

  return (
    <NewsnowBoardContainer spacing="content">
      <div className="mb-5 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500 dark:text-zinc-500">
            NewsNow Recommended
          </p>
          <h2 className="mt-1 text-2xl font-semibold tracking-[0.01em] text-slate-950 dark:text-zinc-100">
            跨源个性化文章流
          </h2>
        </div>
        <div className="text-xs text-slate-500 dark:text-zinc-400">
          {data?.generatedAt
            ? `生成于 ${formatPublishedAt(data.generatedAt)}`
            : null}
        </div>
      </div>

      {data?.degraded ? (
        <Alert
          showIcon
          type="warning"
          className="mb-4"
          message="推荐流已降级"
          description="当前部分排序信号不可用，结果已回退到可用偏好与热点信号。"
        />
      ) : null}

      {items.length === 0 ? (
        <div className="glass-panel rounded-[26px] border border-white/40 px-5 py-10 text-center dark:border-white/10 dark:bg-white/[0.04]">
          <Empty description="继续浏览热点与深读，推荐流会逐步变准。" />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {items.map((item) => (
            <RecommendedFeedItem key={item.id} item={item} />
          ))}
        </div>
      )}
    </NewsnowBoardContainer>
  );
}
