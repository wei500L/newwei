"use client";

import { Empty, Skeleton } from 'antd';

import type { NewsnowEventCandidate } from '../hooks/use-news-sources';
import { selectTopHottestCandidates } from '../lib/newsnow-hottest-analysis';

interface NewsnowHottestCandidatesProps {
  candidates?: NewsnowEventCandidate[];
  isLoading?: boolean;
  isError?: boolean;
}

function formatPercent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}`;
}

export function NewsnowHottestCandidates({
  candidates = [],
  isLoading = false,
  isError = false,
}: NewsnowHottestCandidatesProps) {
  const topCandidates = selectTopHottestCandidates(candidates, 6);

  if (!isLoading && !isError && topCandidates.length === 0) {
    return null;
  }

  return (
    <section className="mx-auto w-full max-w-[1760px] px-4 pt-4 md:px-6 xl:px-8">
      <div className="glass-panel rounded-[26px] border border-white/10 px-4 py-4 shadow-[0_20px_48px_-32px_rgba(15,23,42,0.65)] md:px-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--secondary-foreground)]/70">
              Hottest Analysis
            </p>
            <h2 className="mt-1 text-lg font-semibold text-[var(--foreground)]">热点候选</h2>
          </div>
          <div className="text-xs text-[var(--secondary-foreground)]">跨源聚类 / 热度 / 新鲜度</div>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="rounded-2xl border border-white/10 bg-black/10 p-4">
                <Skeleton active paragraph={{ rows: 4 }} title={{ width: '60%' }} />
              </div>
            ))}
          </div>
        ) : isError ? (
          <div className="rounded-2xl border border-rose-400/20 bg-rose-500/5 p-4 text-sm text-rose-200">
            热点分析暂时不可用，页面仍可继续浏览原始热榜。
          </div>
        ) : topCandidates.length === 0 ? (
          <Empty description="暂无候选热点" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {topCandidates.map((candidate) => (
              <article
                key={candidate.candidateId}
                className="rounded-2xl border border-white/10 bg-[linear-gradient(145deg,rgba(10,18,40,0.88),rgba(7,14,30,0.68))] p-4"
              >
                <div className="flex flex-wrap items-center gap-2 text-[10px] text-[var(--secondary-foreground)]/80">
                  <span className="rounded-full border border-sky-400/20 bg-sky-500/10 px-2 py-0.5 text-sky-300">
                    评分 {formatPercent(candidate.candidateScore)}
                  </span>
                  <span className="rounded-full border border-amber-400/20 bg-amber-500/10 px-2 py-0.5 text-amber-300">
                    跨源 {candidate.sourceCount}
                  </span>
                  <span className="rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2 py-0.5 text-emerald-300">
                    新鲜 {formatPercent(candidate.freshnessScore)}
                  </span>
                </div>
                <h3 className="mt-3 text-sm font-semibold leading-6 text-[var(--foreground)]">
                  {candidate.label}
                </h3>
                {candidate.summary ? (
                  <p className="mt-2 line-clamp-3 text-xs leading-5 text-[var(--secondary-foreground)]/90">
                    {candidate.summary}
                  </p>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-1.5 text-[10px]">
                  {candidate.themes.slice(0, 3).map((theme) => (
                    <span
                      key={theme}
                      className="rounded-full border border-violet-400/20 bg-violet-500/10 px-2 py-0.5 text-violet-200"
                    >
                      {theme}
                    </span>
                  ))}
                  {candidate.entities.slice(0, 3).map((entity) => (
                    <span
                      key={entity}
                      className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[var(--secondary-foreground)]"
                    >
                      {entity}
                    </span>
                  ))}
                </div>
                <div className="mt-3 text-[11px] text-[var(--secondary-foreground)]/80">
                  {candidate.itemRefs
                    .slice(0, 3)
                    .map((item) => `${item.sourceId} · ${item.title}`)
                    .join(' / ')}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
