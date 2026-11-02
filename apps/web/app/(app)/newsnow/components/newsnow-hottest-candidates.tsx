"use client";

import { Skeleton } from 'antd';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { ChartEmptyState } from '@/components/chart-empty-state';
import { SectionHeader } from '@/components/section-header';
import { resolveLocale } from '@/lib/i18n';
import { classifyRequestError } from '@/lib/request-error';

import type {
  NewsnowDomesticOpinionIndexResponse,
  NewsnowHottestAnalysisResponse,
} from '../hooks/use-news-sources';
import {
  NewsnowAnalysisAccessKind,
  type NewsnowAnalysisAccessState,
  NewsnowDataState,
  NewsnowHottestAnalysisEmptyReason,
} from '../lib/newsnow-analysis-access';
import {
  buildDomesticOpinionSparklinePath,
  shouldShowDomesticOpinionPanel,
} from '../lib/newsnow-domestic-opinion';
import { selectTopHottestCandidates } from '../lib/newsnow-hottest-analysis';

import { NewsnowBoardContainer } from './newsnow-board-container';

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

function hottestReasonLabel(
  reason: NewsnowHottestAnalysisEmptyReason | null | undefined,
  t: TFunction,
): string {
  switch (reason) {
    case NewsnowHottestAnalysisEmptyReason.NoHottestSourcesConfigured:
      return t('newsnow.hottest.reason.noHottestSourcesConfigured');
    case NewsnowHottestAnalysisEmptyReason.AllSourcesFailed:
      return t('newsnow.hottest.reason.allSourcesFailed');
    case NewsnowHottestAnalysisEmptyReason.NoSourceItems:
      return t('newsnow.hottest.reason.noSourceItems');
    case NewsnowHottestAnalysisEmptyReason.NoHotSignals:
      return t('newsnow.hottest.reason.noHotSignals');
    case NewsnowHottestAnalysisEmptyReason.NoCandidates:
    default:
      return t('newsnow.hottest.reason.noCandidates');
  }
}

function formatHottestAnalysisEmptyDescription(
  analysis: NewsnowHottestAnalysisResponse | undefined,
  t: TFunction,
): string {
  const base = hottestReasonLabel(analysis?.emptyReason, t);
  const diagnostics = analysis?.diagnostics;

  if (!diagnostics) {
    return base;
  }

  return t('newsnow.hottest.diagnostics', {
    base,
    requested: diagnostics.sourcesRequested,
    ok: diagnostics.sourcesSucceeded,
    failed: diagnostics.sourcesFailed,
  });
}

function formatDomesticOpinionEmptyDescription(
  domesticOpinion: NewsnowDomesticOpinionIndexResponse | undefined,
  t: TFunction,
): string {
  const base = t('newsnow.hottest.reason.domesticNoData');
  const requestedHours = domesticOpinion?.diagnostics.requestedHours ?? 24;

  return t('newsnow.hottest.domesticDiagnostics', { base, hours: requestedHours });
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
  const { t } = useTranslation();
  return (
    <NewsnowBoardContainer spacing="section" className="block">
      <div className="content-card px-4 py-4 md:px-5">
        <SectionHeader
          className="mb-3"
          kicker={t('newsnow.hottest.kicker')}
          title={t('newsnow.hottest.title')}
          extra={
            <span className="text-xs text-[var(--muted-foreground)]">
              {t('newsnow.hottest.enhanced')}
            </span>
          }
        />
        <ChartEmptyState
          title={title}
          description={description}
          variant={variant}
          className="min-h-[220px]"
        />
      </div>
    </NewsnowBoardContainer>
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
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
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
    <section className="mb-4 content-card px-4 py-4 md:px-5">
      <div>
        <SectionHeader
          kicker={t('newsnow.hottest.domesticKicker')}
          title={t('newsnow.hottest.domesticTitle')}
          extra={
            <span className="text-xs text-[var(--muted-foreground)]">
              {t('newsnow.hottest.domesticBasis')}
            </span>
          }
        />
        <div className="mt-1 text-xs text-[var(--muted-foreground)]">
          {t('newsnow.hottest.methodologyPrefix')}{' '}
          <span className="font-mono text-[11px] text-[var(--muted-foreground)]">embedding</span> /{' '}
          <span className="font-mono text-[11px] text-[var(--muted-foreground)]">rerank</span>
          {t('newsnow.hottest.methodologySuffix')}
        </div>
      </div>

      {isLoading ? (
        <div className="mt-4 rounded bg-[var(--surface-muted)] p-4">
          <Skeleton active paragraph={{ rows: 3 }} title={{ width: '45%' }} />
        </div>
      ) : isError ? (
        <div className="mt-4 rounded bg-[var(--surface-muted)] p-4 text-sm text-[var(--destructive)]">
          {t('newsnow.hottest.domesticError')}
        </div>
      ) : !hasContent ? (
        <div className="mt-4 rounded bg-[var(--surface-muted)] p-4 text-sm text-[var(--muted-foreground)]">
          {formatDomesticOpinionEmptyDescription(domesticOpinion, t)}
        </div>
      ) : latest ? (
        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
          <div className="rounded bg-[var(--surface-muted)] p-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="font-mono text-[40px] font-semibold leading-none tabular-nums text-[var(--foreground)]">
                  {formatPercent(latest.indexValue)}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {t('newsnow.hottest.latestBucket', {
                    time: new Date(latest.bucketStart).toLocaleString(locale, {
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    }),
                  })}
                </div>
              </div>
              <div className="min-w-[220px] rounded bg-[var(--surface-muted)] px-3 py-2">
                <svg
                  aria-label={t('newsnow.hottest.domesticTrendAria')}
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
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {t('newsnow.hottest.hotlistCandidatePipeline', {
                    newsnow: latestNewsnow?.candidateCount ?? latest.candidateCount,
                    pipeline: latestPipeline?.articleCount ?? 0,
                  })}
                </div>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 text-xs text-muted-foreground md:grid-cols-4">
              <div className="rounded bg-[var(--surface-muted)] px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.2em] opacity-60">Attention</div>
                <div className="mt-1 font-mono text-base font-semibold tabular-nums text-[var(--foreground)]">
                  {formatPercent(latest.attentionScore)}
                </div>
              </div>
              <div className="rounded bg-[var(--surface-muted)] px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.2em] opacity-60">Breadth</div>
                <div className="mt-1 font-mono text-base font-semibold tabular-nums text-[var(--foreground)]">
                  {formatPercent(latest.breadthScore)}
                </div>
              </div>
              <div className="rounded bg-[var(--surface-muted)] px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.2em] opacity-60">Freshness</div>
                <div className="mt-1 font-mono text-base font-semibold tabular-nums text-[var(--foreground)]">
                  {formatPercent(latest.freshnessScore)}
                </div>
              </div>
              <div className="rounded bg-[var(--surface-muted)] px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.2em] opacity-60">Pressure</div>
                <div className="mt-1 font-mono text-base font-semibold tabular-nums text-[var(--foreground)]">
                  {formatPercent(latest.sentimentPressure)}
                </div>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 text-xs text-muted-foreground md:grid-cols-3">
              <div className="rounded bg-[var(--surface-muted)] px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.2em] opacity-60">Hotlist</div>
                <div className="mt-1 font-mono text-base font-semibold tabular-nums text-[var(--foreground)]">
                  {formatPercent(latestNewsnow?.indexValue ?? 0)}
                </div>
                <div className="mt-1 text-[11px] opacity-75">
                  {t('newsnow.hottest.hotlistCandidates', {
                    count: latestNewsnow?.candidateCount ?? 0,
                  })}
                </div>
              </div>
              <div className="rounded bg-[var(--surface-muted)] px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.2em] opacity-60">Pipeline</div>
                <div className="mt-1 font-mono text-base font-semibold tabular-nums text-[var(--foreground)]">
                  {formatPercent(latestPipeline?.indexValue ?? 0)}
                </div>
                <div className="mt-1 text-[11px] opacity-75">
                  {t('newsnow.hottest.pipelineSamplesSources', {
                    samples: latestPipeline?.articleCount ?? 0,
                    sources: latestPipeline?.sourceCount ?? 0,
                  })}
                </div>
              </div>
              <div className="rounded bg-[var(--surface-muted)] px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.2em] opacity-60">Pipeline Pressure</div>
                <div className="mt-1 font-mono text-base font-semibold tabular-nums text-[var(--foreground)]">
                  {formatPercent(latestPipeline?.sentimentPressure ?? 0)}
                </div>
                <div className="mt-1 text-[11px] opacity-75">{t('newsnow.hottest.pipelinePressure')}</div>
              </div>
            </div>
          </div>

          <div className="rounded bg-[var(--surface-muted)] p-4">
            <div>
              <div className="text-xs font-medium text-muted-foreground">
                {t('newsnow.hottest.topKeywords')}
              </div>
              <div className="mt-3 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                {t('newsnow.hottest.hotlistKeywords')}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {newsnowKeywords.slice(0, 6).map((keyword) => (
                  <span
                    key={keyword.keyword}
                    className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-[11px] text-[var(--accent)]"
                  >
                    {keyword.keyword} {keyword.weight.toFixed(2)}
                  </span>
                ))}
                {newsnowKeywords.length === 0 ? (
                  <span className="text-xs text-muted-foreground">
                    {t('newsnow.hottest.noHotlistKeywords')}
                  </span>
                ) : null}
              </div>

              <div className="mt-4 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                {t('newsnow.hottest.pipelineKeywordsLabel')}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {pipelineKeywords.slice(0, 6).map((keyword) => (
                  <span
                    key={`pipeline-${keyword.keyword}`}
                    className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-[11px] text-[var(--muted-foreground)]"
                  >
                    {keyword.keyword} {keyword.weight.toFixed(2)}
                  </span>
                ))}
                {pipelineKeywords.length === 0 ? (
                  <span className="text-xs text-muted-foreground">
                    {t('newsnow.hottest.noPipelineKeywords')}
                  </span>
                ) : null}
              </div>
            </div>

            <div className="mt-5">
              <div className="text-xs font-medium text-muted-foreground">
                {t('newsnow.hottest.topCandidates')}
              </div>
              <div className="mt-3 space-y-2">
                {(domesticOpinion?.topCandidates ?? []).slice(0, 4).map((candidate) => (
                  <div
                    key={candidate.label}
                    className="rounded bg-[var(--surface-muted)] px-3 py-2"
                  >
                    <div className="text-sm font-medium text-[var(--foreground)]">
                      {candidate.label}
                    </div>
                    <div className="mt-1 font-mono text-[11px] tabular-nums text-muted-foreground">
                      {t('newsnow.hottest.scoreSources', {
                        score: formatPercent(candidate.candidateScore),
                        sources: candidate.sourceCount,
                      })}
                    </div>
                  </div>
                ))}
                {(domesticOpinion?.topCandidates ?? []).length === 0 ? (
                  <span className="text-xs text-muted-foreground">
                    {t('newsnow.hottest.noTopCandidates')}
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
  const { t } = useTranslation();
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
        title={t('newsnow.hottest.authTitle')}
        description={t('newsnow.hottest.authDescription')}
        variant="empty"
      />
    );
  }

  if (showPermissionState) {
    return (
      <ProtectedStateCard
        title={t('newsnow.hottest.permissionTitle')}
        description={t('newsnow.hottest.permissionDescription')}
        variant="permission"
      />
    );
  }

  if (!showLoading && !isError && topCandidates.length === 0 && !hasDomesticPanel) {
    return null;
  }

  return (
    <NewsnowBoardContainer spacing="section" className="block">
      <div className="content-card px-4 py-4 md:px-5">
        <DomesticOpinionPanel
          domesticOpinion={domesticOpinion}
          isLoading={
            accessState.kind === NewsnowAnalysisAccessKind.Loading ||
            isDomesticOpinionLoading
          }
          isError={isDomesticOpinionError}
        />
        <SectionHeader
          className="mb-3"
          kicker={t('newsnow.hottest.kicker')}
          title={t('newsnow.hottest.title')}
          extra={
            <span className="text-xs text-[var(--muted-foreground)]">
              {t('newsnow.hottest.subtitle')}
            </span>
          }
        />

        {showLoading ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="rounded bg-[var(--surface-muted)] p-4">
                <Skeleton active paragraph={{ rows: 4 }} title={{ width: '60%' }} />
              </div>
            ))}
          </div>
        ) : isError ? (
          <div className="rounded bg-[var(--surface-muted)] p-4 text-sm text-[var(--destructive)]">
            {t('newsnow.hottest.analysisError')}
          </div>
        ) : topCandidates.length === 0 ? (
          <ChartEmptyState
            title={
              analysis?.dataState === NewsnowDataState.Empty
                ? t('newsnow.hottest.emptyNoData')
                : t('newsnow.hottest.emptyDefault')
            }
            description={formatHottestAnalysisEmptyDescription(analysis, t)}
            variant="empty"
            className="min-h-[220px]"
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {topCandidates.map((candidate) => (
              <article
                key={candidate.candidateId}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4"
              >
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--muted-foreground)]">
                  <span className="rounded-full border border-[var(--border)] bg-[var(--surface-muted)] px-2 py-0.5 font-mono tabular-nums">
                    {t('newsnow.hottest.score', { score: formatPercent(candidate.candidateScore) })}
                  </span>
                  <span className="rounded-full border border-[var(--border)] bg-[var(--surface-muted)] px-2 py-0.5 font-mono tabular-nums">
                    {t('newsnow.hottest.sources', { count: candidate.sourceCount })}
                  </span>
                  <span className="rounded-full border border-[var(--border)] bg-[var(--surface-muted)] px-2 py-0.5 font-mono tabular-nums">
                    {t('newsnow.hottest.freshness', { score: formatPercent(candidate.freshnessScore) })}
                  </span>
                </div>
                <h3 className="mt-3 text-sm font-semibold leading-6 text-[var(--foreground)]">
                  {candidate.label}
                </h3>
                {candidate.summary ? (
                  <p className="mt-2 line-clamp-3 text-xs leading-5 text-[var(--muted-foreground)]">
                    {candidate.summary}
                  </p>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
                  {candidate.themes.slice(0, 3).map((theme) => (
                    <span
                      key={theme}
                      className="rounded-full border border-[var(--border)] bg-[var(--surface-muted)] px-2 py-0.5 text-[var(--muted-foreground)]"
                    >
                      {theme}
                    </span>
                  ))}
                  {candidate.entities.slice(0, 3).map((entity) => (
                    <span
                      key={entity}
                      className="rounded-full border border-[var(--border)] bg-[var(--surface-muted)] px-2 py-0.5 text-[var(--secondary-foreground)]"
                    >
                      {entity}
                    </span>
                  ))}
                </div>
                <div className="mt-3 font-mono text-[11px] tabular-nums text-[var(--muted-foreground)]">
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
    </NewsnowBoardContainer>
  );
}
