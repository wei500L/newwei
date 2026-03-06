import type {
  NewsnowAnalyzedItem,
  NewsnowEventCandidate,
} from '../hooks/use-news-sources';

export interface NewsnowAnalysisBadge {
  key: string;
  label: string;
  tone: 'sky' | 'emerald' | 'amber' | 'violet' | 'slate';
}

function truncate(value: string, limit: number): string {
  const normalized = value.trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function buildItemAnalysisBadges(
  analysis?: NewsnowAnalyzedItem | null,
): NewsnowAnalysisBadge[] {
  if (!analysis) {
    return [];
  }

  const badges: NewsnowAnalysisBadge[] = [];
  const theme = analysis.theme ?? analysis.candidateLabel;
  if (theme) {
    badges.push({
      key: 'theme',
      label: truncate(theme, 18),
      tone: 'violet',
    });
  }
  if (analysis.sourceCount > 1) {
    badges.push({
      key: 'cross-source',
      label: `跨源 ${analysis.sourceCount}`,
      tone: 'amber',
    });
  }
  if (analysis.isNew) {
    badges.push({ key: 'new', label: '新热', tone: 'emerald' });
  } else if (analysis.isRising) {
    badges.push({ key: 'rising', label: '升温', tone: 'sky' });
  }
  if (analysis.bridgeStatus === 'existing') {
    badges.push({ key: 'existing', label: '已深读', tone: 'sky' });
  } else if (analysis.bridgeStatus === 'queued') {
    badges.push({ key: 'queued', label: '分析中', tone: 'emerald' });
  } else if (analysis.bridgeEligible) {
    badges.push({ key: 'eligible', label: '可深读', tone: 'slate' });
  }
  return badges.slice(0, 4);
}

export function selectTopHottestCandidates(
  candidates: NewsnowEventCandidate[],
  limit = 6,
): NewsnowEventCandidate[] {
  return [...candidates]
    .sort((left, right) => {
      if (right.candidateScore !== left.candidateScore) {
        return right.candidateScore - left.candidateScore;
      }
      if (right.sourceCount !== left.sourceCount) {
        return right.sourceCount - left.sourceCount;
      }
      return right.itemCount - left.itemCount;
    })
    .slice(0, limit);
}
