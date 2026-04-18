import type {
  SituationMonitorMatchGeoStatus,
  SituationMonitorMatchReasonCode,
  SituationMonitorMatchResult,
} from '../types/situation-monitor-monitors';

export function buildMonitorMatchKey(
  itemMetaId?: string,
  link?: string,
  title?: string,
) {
  if (typeof itemMetaId === 'string' && itemMetaId.trim()) {
    return `id:${itemMetaId.trim()}`;
  }
  return `link:${(link ?? '').trim()}::${(title ?? '').trim()}`;
}

export function collectMonitorMatchesForKeys(
  monitorMatchesByKey: Map<string, SituationMonitorMatchResult[]>,
  keys: string[],
) {
  const deduped = new Map<string, SituationMonitorMatchResult>();
  for (const key of keys) {
    const entries = monitorMatchesByKey.get(key) ?? [];
    for (const entry of entries) {
      const existing = deduped.get(entry.monitorId);
      if (!existing || entry.score > existing.score) {
        deduped.set(entry.monitorId, entry);
      }
    }
  }

  return Array.from(deduped.values()).sort(
    (a, b) => b.score - a.score || a.monitorName.localeCompare(b.monitorName),
  );
}

export function getDefaultMonitorReasonLabel(
  code: SituationMonitorMatchReasonCode | 'lexical',
) {
  switch (code) {
    case 'keyword':
      return 'Keyword matched';
    case 'topic':
      return 'Topic matched';
    case 'entity':
      return 'Entity matched';
    case 'source':
      return 'Source matched';
    case 'semantic':
      return 'Semantic recall';
    case 'rerank':
      return 'Rerank accepted';
    case 'geo':
      return 'Geo matched';
    case 'lexical':
      return 'Lexical';
    default:
      return code;
  }
}

export function getDefaultMonitorGeoStatusLabel(status: SituationMonitorMatchGeoStatus) {
  switch (status) {
    case 'not_configured':
      return 'No geo filter';
    case 'matched':
      return 'Location matched';
    case 'country_match':
      return 'Country matched';
    case 'conflict':
      return 'Location conflict';
    case 'unresolved':
      return 'Geo unresolved';
    default:
      return status;
  }
}
