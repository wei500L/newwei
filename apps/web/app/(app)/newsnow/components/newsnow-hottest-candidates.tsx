"use client";

import { Skeleton } from 'antd';

import { ChartEmptyState } from '@/components/chart-empty-state';
import { classifyRequestError } from '@/lib/request-error';

import type {
  NewsnowDomesticOpinionIndexResponse,
  NewsnowHottestAnalysisResponse,
} from '../hooks/use-news-sources';
import {
  NewsnowAnalysisAccessKind,
  type NewsnowAnalysisAccessState,
  NewsnowDataState,
  describeDomesticOpinionEmptyReason,
  describeHottestAnalysisEmptyReason,
} from '../lib/newsnow-analysis-access';
import {
  buildDomesticOpinionSparklinePath,
  shouldShowDomesticOpinionPanel,
} from '../lib/newsnow-domestic-opinion';
import { selectTopHottestCandidates } from '../lib/newsnow-hottest-analysis';

interface NewsnowHottestCandidatesProps {
  analysis?: NewsnowHottestAnalysisResponse;
  accessState: NewsnowAnalysisAccessState;
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  domesticOpinion?: NewsnowDomesticOpinionIndexResponse;
  isDomesticOpinionLoading?: boolean;
  isDomesticOpinionError?: boolean;
  domesticOpinionError?: unknown;
}

function formatPercent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}`;
}

function formatHottestAnalysisEmptyDescription(
  analysis?: NewsnowHottestAnalysisResponse,
): string {
  const base = describeHottestAnalysisEmptyReason(analysis?.emptyReason);
  const diagnostics = analysis?.diagnostics;

  if (!diagnostics) {
    return base;
  }

  return `${base} 本轮请求 ${diagnostics.sourcesRequested} 个源，成功 ${diagnostics.sourcesSucceeded} 个，失败 ${diagnostics.sourcesFailed} 个。`;
}

function formatDomesticOpinionEmptyDescription(
  domesticOpinion?: NewsnowDomesticOpinionIndexResponse,
): string {
  const base = describeDomesticOpinionEmptyReason(domesticOpinion?.emptyReason);
  const requestedHours = domesticOpinion?.diagnostics.requestedHours ?? 24;

  return `${base} 当前查询窗口为最近 ${requestedHours} 小时。`;
}

function ProtectedStateCard({
  title,
  description,
  variant,
}: {
  title: string;
  description: string;
  variant: 'empty' | 'permission';
}) {
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
          <div className="text-xs text-[var(--secondary-foreground)]">热点分析增强</div>
        </div>
        <ChartEmptyState
          title={title}
          description={description}
          variant={variant}
          className="min-h-[220px]"
        />
      </div>
    </section>
  );
}

function DomesticOpinionPanel({
  domesticOpinion,
  isLoading,
  isError,
}: {
  domesticOpinion?: NewsnowDomesticOpinionIndexResponse;
  isLoading: boolean;
  isError: boolean;
}) {
  const latest = domesticOpinion?.latest ?? null;
  const trend = domesticOpinion?.trend ?? [];
  const hasResponse = domesticOpinion !== undefined;
  const hasContent = Boolean(latest) || trend.length > 0;
  const latestBreakdown = domesticOpinion?.breakdown?.latest ?? null;
  const latestNewsnow = latestBreakdown?.newsnow ?? null;
  const latestPipeline = latestBreakdown?.pipeline ?? null;
  const newsnowKeywords =
    domesticOpinion?.breakdown?.topKeywords.newsnow ?? domesticOpinion?.topKeywords ?? [];
  const pipelineKeywords = domesticOpinion?.breakdown?.topKeywords.pipeline ?? [];
  const sparklinePath = buildDomesticOpinionSparklinePath(
    trend.map((point) => point.indexValue),
    220,
    60,
  );

  if (!isLoading && !isError && !hasContent && !hasResponse) {
    return null;
  }

  return (
    <section className="mb-4 rounded-[26px] border border-white/10 bg-[linear-gradient(135deg,rgba(14,28,46,0.92),rgba(18,46,42,0.78))] px-4 py-4 shadow-[0_22px_52px_-34px_rgba(15,23,42,0.72)] md:px-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-emerald-200/70">
            Domestic Pulse
          </p>
          <h2 className="mt-1 text-lg font-semibold text-[var(--foreground)]">国内舆情指数</h2>
          <div className="mt-1 text-xs text-[var(--secondary-foreground)]/72">
            当前口径基于现有热榜与新闻管道规则算法，未使用{' '}
            <span className="font-mono text-[11px] text-emerald-100/80">embedding</span> /{' '}
            <span className="font-mono text-[11px] text-emerald-100/80">rerank</span>
          </div>
        </div>
        <div className="text-xs text-emerald-100/70">热榜底座 + 新闻管道补强</div>
      </div>

      {isLoading ? (
        <div className="mt-4 rounded-2xl border border-white/10 bg-black/10 p-4">
          <Skeleton active paragraph={{ rows: 3 }} title={{ width: '45%' }} />
        </div>
      ) : isError ? (
        <div className="mt-4 rounded-2xl border border-rose-400/20 bg-rose-500/5 p-4 text-sm text-rose-200">
          国内舆情指数暂时不可用，热点候选仍会继续刷新。
        </div>
      ) : !hasContent ? (
        <div className="mt-4 rounded-2xl border border-amber-300/20 bg-amber-500/10 p-4 text-sm text-amber-50/90">
          {formatDomesticOpinionEmptyDescription(domesticOpinion)}
        </div>
      ) : latest ? (
        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
          <div className="rounded-2xl border border-white/10 bg-black/10 p-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="text-[40px] font-semibold leading-none text-[var(--foreground)]">
                  {formatPercent(latest.indexValue)}
                </div>
                <div className="mt-2 text-xs text-[var(--secondary-foreground)]/85">
                  最近桶位 {new Date(latest.bucketStart).toLocaleString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </div>
              </div>
              <div className="min-w-[220px] rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2">
                <svg
                  aria-label="国内舆情指数趋势"
                  viewBox="0 0 220 60"
                  className="h-[72px] w-full overflow-visible"
                >
                  <defs>
                    <linearGradient id="domesticOpinionStroke" x1="0%" x2="100%" y1="0%" y2="0%">
                      <stop offset="0%" stopColor="rgba(52,211,153,0.45)" />
                      <stop offset="100%" stopColor="rgba(56,189,248,0.95)" />
                    </linearGradient>
                  </defs>
                  <path
                    d={sparklinePath || 'M 0 30 L 220 30'}
                    fill="none"
                    stroke="url(#domesticOpinionStroke)"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <div className="mt-1 text-[11px] text-[var(--secondary-foreground)]/75">
                  热榜候选 {latestNewsnow?.candidateCount ?? latest.candidateCount} · 管道样本{' '}
                  {latestPipeline?.articleCount ?? 0}
                </div>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 text-xs text-[var(--secondary-foreground)]/85 md:grid-cols-4">
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2">
                <div className="text-[10px] uppercase tracking-[0.2em] opacity-60">Attention</div>
                <div className="mt-1 text-base font-semibold text-[var(--foreground)]">
                  {formatPercent(latest.attentionScore)}
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2">
                <div className="text-[10px] uppercase tracking-[0.2em] opacity-60">Breadth</div>
                <div className="mt-1 text-base font-semibold text-[var(--foreground)]">
                  {formatPercent(latest.breadthScore)}
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2">
                <div className="text-[10px] uppercase tracking-[0.2em] opacity-60">Freshness</div>
                <div className="mt-1 text-base font-semibold text-[var(--foreground)]">
                  {formatPercent(latest.freshnessScore)}
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2">
                <div className="text-[10px] uppercase tracking-[0.2em] opacity-60">Pressure</div>
                <div className="mt-1 text-base font-semibold text-[var(--foreground)]">
                  {formatPercent(latest.sentimentPressure)}
                </div>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 text-xs text-[var(--secondary-foreground)]/85 md:grid-cols-3">
              <div className="rounded-2xl border border-sky-400/15 bg-sky-500/5 px-3 py-2">
                <div className="text-[10px] uppercase tracking-[0.2em] opacity-60">Hotlist</div>
                <div className="mt-1 text-base font-semibold text-[var(--foreground)]">
                  {formatPercent(latestNewsnow?.indexValue ?? 0)}
                </div>
                <div className="mt-1 text-[11px] opacity-75">
                  候选 {latestNewsnow?.candidateCount ?? 0}
                </div>
              </div>
              <div className="rounded-2xl border border-emerald-400/15 bg-emerald-500/5 px-3 py-2">
                <div className="text-[10px] uppercase tracking-[0.2em] opacity-60">Pipeline</div>
                <div className="mt-1 text-base font-semibold text-[var(--foreground)]">
                  {formatPercent(latestPipeline?.indexValue ?? 0)}
                </div>
                <div className="mt-1 text-[11px] opacity-75">
                  样本 {latestPipeline?.articleCount ?? 0} · 来源 {latestPipeline?.sourceCount ?? 0}
                </div>
              </div>
              <div className="rounded-2xl border border-amber-400/15 bg-amber-500/5 px-3 py-2">
                <div className="text-[10px] uppercase tracking-[0.2em] opacity-60">Pipeline Pressure</div>
                <div className="mt-1 text-base font-semibold text-[var(--foreground)]">
                  {formatPercent(latestPipeline?.sentimentPressure ?? 0)}
                </div>
                <div className="mt-1 text-[11px] opacity-75">新闻管道负面压力</div>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/10 p-4">
            <div>
              <div className="text-xs font-medium text-[var(--secondary-foreground)]/80">
                高频关键词
              </div>
              <div className="mt-3 text-[11px] uppercase tracking-[0.2em] text-[var(--secondary-foreground)]/60">
                热榜关键词
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {newsnowKeywords.slice(0, 6).map((keyword) => (
                  <span
                    key={keyword.keyword}
                    className="rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] text-emerald-100"
                  >
                    {keyword.keyword} {keyword.weight.toFixed(2)}
                  </span>
                ))}
                {newsnowKeywords.length === 0 ? (
                  <span className="text-xs text-[var(--secondary-foreground)]/70">
                    暂无热榜关键词
                  </span>
                ) : null}
              </div>

              <div className="mt-4 text-[11px] uppercase tracking-[0.2em] text-[var(--secondary-foreground)]/60">
                管道关键词
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {pipelineKeywords.slice(0, 6).map((keyword) => (
                  <span
                    key={`pipeline-${keyword.keyword}`}
                    className="rounded-full border border-sky-400/20 bg-sky-500/10 px-2.5 py-1 text-[11px] text-sky-100"
                  >
                    {keyword.keyword} {keyword.weight.toFixed(2)}
                  </span>
                ))}
                {pipelineKeywords.length === 0 ? (
                  <span className="text-xs text-[var(--secondary-foreground)]/70">
                    暂无管道关键词
                  </span>
                ) : null}
              </div>
            </div>

            <div className="mt-5">
              <div className="text-xs font-medium text-[var(--secondary-foreground)]/80">
                主导候选（热榜）
              </div>
              <div className="mt-3 space-y-2">
                {(domesticOpinion?.topCandidates ?? []).slice(0, 4).map((candidate) => (
                  <div
                    key={candidate.label}
                    className="rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2"
                  >
                    <div className="text-sm font-medium text-[var(--foreground)]">
                      {candidate.label}
                    </div>
                    <div className="mt-1 text-[11px] text-[var(--secondary-foreground)]/75">
                      评分 {formatPercent(candidate.candidateScore)} · 跨源 {candidate.sourceCount}
                    </div>
                  </div>
                ))}
                {(domesticOpinion?.topCandidates ?? []).length === 0 ? (
                  <span className="text-xs text-[var(--secondary-foreground)]/70">
                    暂无主导候选
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function NewsnowHottestCandidates({
  analysis,
  accessState,
  isLoading = false,
  isError = false,
  error,
  domesticOpinion,
  isDomesticOpinionLoading = false,
  isDomesticOpinionError = false,
  domesticOpinionError,
}: NewsnowHottestCandidatesProps) {
  const topCandidates = selectTopHottestCandidates(analysis?.candidates ?? [], 6);
  const analysisErrorKind = error ? classifyRequestError(error).kind : null;
  const domesticOpinionErrorKind = domesticOpinionError
    ? classifyRequestError(domesticOpinionError).kind
    : null;
  const showLoading =
    accessState.kind === NewsnowAnalysisAccessKind.Loading || isLoading;
  const showAuthState =
    accessState.kind === NewsnowAnalysisAccessKind.Unauthenticated ||
    analysisErrorKind === 'auth' ||
    domesticOpinionErrorKind === 'auth';
  const showPermissionState =
    accessState.kind === NewsnowAnalysisAccessKind.Forbidden ||
    analysisErrorKind === 'permission' ||
    domesticOpinionErrorKind === 'permission';
  const hasDomesticPanel = shouldShowDomesticOpinionPanel({
    domesticOpinion,
    isLoading:
      accessState.kind === NewsnowAnalysisAccessKind.Loading ||
      isDomesticOpinionLoading,
    isError: isDomesticOpinionError,
  });

  if (showAuthState) {
    return (
      <ProtectedStateCard
        title="登录后查看热点分析增强"
        description="国内舆情指数和跨源热点候选需要登录后才能加载。未登录时仍可浏览原始热榜列表。"
        variant="empty"
      />
    );
  }

  if (showPermissionState) {
    return (
      <ProtectedStateCard
        title="需要 items.read 权限"
        description="国内舆情指数和热点候选属于增强分析能力。当前账号没有 items.read 权限，因此只展示原始热榜。"
        variant="permission"
      />
    );
  }

  if (!showLoading && !isError && topCandidates.length === 0 && !hasDomesticPanel) {
    return null;
  }

  return (
    <section className="mx-auto w-full max-w-[1760px] px-4 pt-4 md:px-6 xl:px-8">
      <div className="glass-panel rounded-[26px] border border-white/10 px-4 py-4 shadow-[0_20px_48px_-32px_rgba(15,23,42,0.65)] md:px-5">
        <DomesticOpinionPanel
          domesticOpinion={domesticOpinion}
          isLoading={
            accessState.kind === NewsnowAnalysisAccessKind.Loading ||
            isDomesticOpinionLoading
          }
          isError={isDomesticOpinionError}
        />
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--secondary-foreground)]/70">
              Hottest Analysis
            </p>
            <h2 className="mt-1 text-lg font-semibold text-[var(--foreground)]">热点候选</h2>
          </div>
          <div className="text-xs text-[var(--secondary-foreground)]">跨源聚类 / 热度 / 新鲜度</div>
        </div>

        {showLoading ? (
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
          <ChartEmptyState
            title={
              analysis?.dataState === NewsnowDataState.Empty
                ? '当前没有可展示的热点候选'
                : '暂无候选热点'
            }
            description={formatHottestAnalysisEmptyDescription(analysis)}
            variant="empty"
            className="min-h-[220px]"
          />
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
