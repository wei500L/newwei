'use client';

import { DislikeOutlined } from '@ant-design/icons';
import { Alert, Button, Skeleton, Tooltip } from 'antd';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ChartEmptyState } from '@/components/chart-empty-state';
import { RequestErrorBanner } from '@/components/request-error-banner';
import { SectionHeader } from '@/components/section-header';
import { formatTimestamp, resolveLocale, type SupportedLocale } from '@/lib/i18n';
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

function formatPublishedAt(
  value: number | string | null | undefined,
  locale: SupportedLocale,
) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return formatTimestamp(value, locale) || '刚刚';
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return formatTimestamp(parsed, locale);
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
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
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
        `${t("newsnow.recommended.breakdown.content")} ${scorePercent(item.scoreBreakdown.content)}`,
        `${t("newsnow.recommended.breakdown.collaborative")} ${scorePercent(item.scoreBreakdown.collaborative)}`,
        `${t("newsnow.recommended.breakdown.source")} ${scorePercent(item.scoreBreakdown.source)}`,
        `${t("newsnow.recommended.breakdown.hotness")} ${scorePercent(item.scoreBreakdown.hotness)}`,
      ].join(' · '),
    [item.scoreBreakdown, t],
  );

  return (
    <div
      ref={rootRef}
      className="content-card px-5 py-4"
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="kicker flex flex-wrap items-center gap-2">
            <span>{item.sourceName}</span>
            <span className="rounded-full bg-[var(--foreground)] px-2 py-1 font-mono text-[11px] tracking-[0.08em] tabular-nums text-[var(--background)]">
              {t("newsnow.recommended.recommendScore", {
                score: Math.round(item.score * 100),
              })}
            </span>
            <span className="rounded-full border border-[var(--border)] px-2 py-1 text-[11px] tracking-[0.08em] text-[var(--accent)]">
              {item.reasonLabel}
            </span>
          </div>

          <div className="mt-3">
            <button
              type="button"
              onClick={handleOpenOriginal}
              className="text-left text-lg font-semibold leading-8 text-[var(--foreground)] transition-colors hover:text-[var(--primary)]"
            >
              {item.title}
            </button>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--muted-foreground)]">
            <span>{formatPublishedAt(item.pubDate, locale)}</span>
            <span>{t("newsnow.recommended.sourceLabel", { source: item.sourceId })}</span>
            {item.topics.slice(0, 3).map((topic) => (
              <span
                key={topic}
                className="rounded-full border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--accent)]"
              >
                {topic}
              </span>
            ))}
            {item.entities.slice(0, 2).map((entity) => (
              <span
                key={entity}
                className="rounded-full border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--muted-foreground)]"
              >
                {entity}
              </span>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-stretch gap-2 md:max-w-[240px] lg:w-[240px]">
          <Tooltip title={scoreSummary}>
            <div className="rounded border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 font-mono text-xs tabular-nums text-[var(--muted-foreground)]">
              {t("newsnow.recommended.combinedScore", {
                score: Math.round(item.score * 100),
              })}
            </div>
          </Tooltip>
          <Button onClick={handleOpenOriginal}>
            {t("newsnow.actions.original")}
          </Button>
          <Button disabled={!item.matchedEventId} onClick={handleOpenEvent}>
            {t("newsnow.actions.event")}
          </Button>
          <Button disabled={!item.matchedItemId} onClick={handleOpenItem}>
            {t("newsnow.actions.item")}
          </Button>
          <Button icon={<DislikeOutlined />} onClick={handleNotInterested}>
            {t("newsnow.recommended.notInterested")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function NewsnowRecommendedFeed() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
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
        <div className="content-card px-5 py-5">
          <Skeleton active paragraph={{ rows: 8 }} />
        </div>
      </NewsnowBoardContainer>
    );
  }

  if (isError) {
    return (
      <NewsnowBoardContainer spacing="content">
        <RequestErrorBanner error={error} onRetry={() => void refetch()} />
      </NewsnowBoardContainer>
    );
  }

  return (
    <NewsnowBoardContainer spacing="content">
      <SectionHeader
        className="mb-5"
        kicker="NewsNow Recommended"
        title={t("newsnow.recommended.title")}
        extra={
          data?.generatedAt ? (
            <span className="text-xs text-[var(--muted-foreground)]">
              {t("newsnow.recommended.generatedAt", {
                time: formatPublishedAt(data.generatedAt, locale),
              })}
            </span>
          ) : null
        }
      />

      {data?.degraded ? (
        <Alert
          showIcon
          type="warning"
          className="mb-4"
          message={t("newsnow.recommended.degradedTitle")}
          description={t("newsnow.recommended.degradedDescription")}
        />
      ) : null}

      {items.length === 0 ? (
        <div className="content-card px-5 py-10">
          <ChartEmptyState
            description={t("newsnow.recommended.emptyDescription")}
          />
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
