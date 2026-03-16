export enum NewsnowDataState {
  Ready = 'ready',
  Empty = 'empty',
}

export enum NewsnowHottestAnalysisEmptyReason {
  NoHottestSourcesConfigured = 'no_hottest_sources_configured',
  AllSourcesFailed = 'all_sources_failed',
  NoSourceItems = 'no_source_items',
  NoHotSignals = 'no_hot_signals',
  NoCandidates = 'no_candidates',
}

export enum NewsnowDomesticOpinionEmptyReason {
  NoRecentSnapshotsOrPipelineData = 'no_recent_snapshots_or_pipeline_data',
}

export enum NewsnowAnalysisAccessKind {
  Available = 'available',
  Forbidden = 'forbidden',
  Loading = 'loading',
  Unauthenticated = 'unauthenticated',
}

export interface NewsnowAnalysisAccessState {
  canQuery: boolean;
  kind: NewsnowAnalysisAccessKind;
}

type SessionStatus = 'authenticated' | 'loading' | 'unauthenticated';

export function getNewsnowAnalysisPermissions(
  session:
    | {
        permissions?: string[];
        user?: {
          permissions?: string[];
        };
      }
    | null
    | undefined,
): string[] {
  return session?.permissions ?? session?.user?.permissions ?? [];
}

export function canReadNewsnowAnalysis(permissions: readonly string[]): boolean {
  return permissions.includes('items.read');
}

export function getNewsnowAnalysisAccessState(
  status: SessionStatus,
  permissions: readonly string[],
): NewsnowAnalysisAccessState {
  if (status === 'loading') {
    return { canQuery: false, kind: NewsnowAnalysisAccessKind.Loading };
  }

  if (status !== 'authenticated') {
    return { canQuery: false, kind: NewsnowAnalysisAccessKind.Unauthenticated };
  }

  if (!canReadNewsnowAnalysis(permissions)) {
    return { canQuery: false, kind: NewsnowAnalysisAccessKind.Forbidden };
  }

  return { canQuery: true, kind: NewsnowAnalysisAccessKind.Available };
}

export function describeHottestAnalysisEmptyReason(
  reason: NewsnowHottestAnalysisEmptyReason | null | undefined,
): string {
  switch (reason) {
    case NewsnowHottestAnalysisEmptyReason.NoHottestSourcesConfigured:
      return '当前环境还没有配置可分析的 hottest 新闻源。';
    case NewsnowHottestAnalysisEmptyReason.AllSourcesFailed:
      return '本轮热榜源抓取全部失败，暂时无法产出热点候选。';
    case NewsnowHottestAnalysisEmptyReason.NoSourceItems:
      return '本轮热榜源成功返回了请求，但没有拿到可分析的热榜条目。';
    case NewsnowHottestAnalysisEmptyReason.NoHotSignals:
      return '热榜条目已抓取，但没有形成可聚类的热点信号。';
    case NewsnowHottestAnalysisEmptyReason.NoCandidates:
    default:
      return '当前热榜样本不足以形成稳定候选，请等待下一轮刷新。';
  }
}

export function describeDomesticOpinionEmptyReason(
  reason: NewsnowDomesticOpinionEmptyReason | null | undefined,
): string {
  switch (reason) {
    case NewsnowDomesticOpinionEmptyReason.NoRecentSnapshotsOrPipelineData:
    default:
      return '最近 24 小时还没有生成热榜快照，也没有补强所需的国内新闻管道样本。';
  }
}
