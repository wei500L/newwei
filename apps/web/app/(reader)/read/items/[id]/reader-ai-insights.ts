export interface ReaderAiActor {
  name: string;
  type: string;
  confidence?: number;
}

export interface ReaderAiRelation {
  subject: string;
  predicate: string;
  object: string;
  confidence?: number;
  evidence?: string;
}

export interface ReaderAiTimelinePoint {
  label: string;
  detail: string;
}

export interface ReaderAiInsights {
  actors: ReaderAiActor[];
  relations: ReaderAiRelation[];
  timeline: ReaderAiTimelinePoint[];
  controversies: string[];
  sentimentLabel?: string;
  qualityScore?: number;
  hasData: boolean;
}

const POSITIVE_HINTS = [
  '增长',
  '回升',
  '改善',
  '上涨',
  '创新高',
  '突破',
  '利好',
  '超预期',
  '盈利',
  '增持',
  '上调',
  '达成'
];

const NEGATIVE_HINTS = [
  '下滑',
  '下降',
  '亏损',
  '裁员',
  '下调',
  '争议',
  '质疑',
  '调查',
  '风险',
  '冲突',
  '违约',
  '担忧',
  '诉讼'
];

const TIMELINE_DATE_PATTERN =
  /(\d{4}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}月\d{1,2}日|\d{1,2}:\d{2})/;

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function pickStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => toNonEmptyString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function extractActors(result: Record<string, unknown>): ReaderAiActor[] {
  const raw = result.entities;
  if (!Array.isArray(raw)) {
    return [];
  }

  const actors = raw
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const name = toNonEmptyString(record.name);
      if (!name) {
        return null;
      }
      const type = toNonEmptyString(record.type) ?? 'other';
      const confidence = toFiniteNumber(record.confidence);
      return {
        name,
        type,
        ...(confidence !== null ? { confidence } : {})
      } satisfies ReaderAiActor;
    })
    .filter((entry): entry is ReaderAiActor => Boolean(entry));

  const unique = new Map<string, ReaderAiActor>();
  for (const actor of actors) {
    const key = `${actor.name}::${actor.type}`.toLowerCase();
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, actor);
      continue;
    }
    const existingConfidence = existing.confidence ?? 0;
    const nextConfidence = actor.confidence ?? 0;
    if (nextConfidence > existingConfidence) {
      unique.set(key, actor);
    }
  }

  return Array.from(unique.values())
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .slice(0, 8);
}

function extractRelations(result: Record<string, unknown>): ReaderAiRelation[] {
  const raw = result.kg_relations;
  if (!Array.isArray(raw)) {
    return [];
  }

  const relations = raw
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const subject =
        record.subject && typeof record.subject === 'object'
          ? toNonEmptyString((record.subject as Record<string, unknown>).name)
          : null;
      const object =
        record.object && typeof record.object === 'object'
          ? toNonEmptyString((record.object as Record<string, unknown>).name)
          : null;
      const predicate = toNonEmptyString(record.predicate);
      if (!subject || !object || !predicate) {
        return null;
      }
      const confidence = toFiniteNumber(record.confidence);
      const evidence = toNonEmptyString(record.evidence);
      return {
        subject,
        predicate,
        object,
        ...(confidence !== null ? { confidence } : {}),
        ...(evidence ? { evidence } : {})
      } satisfies ReaderAiRelation;
    })
    .filter((entry): entry is ReaderAiRelation => Boolean(entry));

  return relations
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .slice(0, 6);
}

function extractTimeline(result: Record<string, unknown>): ReaderAiTimelinePoint[] {
  const points: ReaderAiTimelinePoint[] = [];

  const publishedAt = toNonEmptyString(result.published_at) ?? toNonEmptyString(result.publishedAt);
  if (publishedAt) {
    points.push({ label: '发布时间', detail: publishedAt });
  }

  const keyPoints = pickStringList(result.key_points);
  keyPoints.forEach((point, index) => {
    const dateMatch = point.match(TIMELINE_DATE_PATTERN)?.[0];
    points.push({
      label: dateMatch ? `时间节点 ${dateMatch}` : `关键进展 ${index + 1}`,
      detail: point
    });
  });

  const unique = new Map<string, ReaderAiTimelinePoint>();
  for (const point of points) {
    const key = `${point.label}::${point.detail}`;
    if (!unique.has(key)) {
      unique.set(key, point);
    }
  }

  return Array.from(unique.values()).slice(0, 6);
}

function hasAnyHint(content: string[], hints: string[]): boolean {
  return content.some((line) => hints.some((hint) => line.includes(hint)));
}

function extractControversies(result: Record<string, unknown>, relations: ReaderAiRelation[]): string[] {
  const summary = toNonEmptyString(result.summary) ?? '';
  const keyPoints = pickStringList(result.key_points);
  const sentimentLabel = toNonEmptyString(result.sentiment_label) ?? toNonEmptyString(result.sentiment) ?? '';
  const signals = [summary, ...keyPoints].map((line) => line.toLowerCase());

  const controversies: string[] = [];

  const hasPositive = hasAnyHint(signals, POSITIVE_HINTS);
  const hasNegative = hasAnyHint(signals, NEGATIVE_HINTS);

  if (hasPositive && hasNegative) {
    controversies.push('同一报道中同时出现正向与负向信号，建议结合原文核对上下文。');
  }

  if (sentimentLabel === 'neutral' && (hasPositive || hasNegative)) {
    controversies.push('情感标签为中性，但正文存在倾向性描述，建议谨慎判断。');
  }

  if (relations.some((relation) => (relation.confidence ?? 1) < 0.65)) {
    controversies.push('部分关系置信度偏低，图谱关系可作为线索，不宜直接下结论。');
  }

  return controversies.slice(0, 3);
}

export function buildReaderAiInsights(result: unknown): ReaderAiInsights {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return {
      actors: [],
      relations: [],
      timeline: [],
      controversies: [],
      hasData: false
    };
  }

  const record = result as Record<string, unknown>;
  const actors = extractActors(record);
  const relations = extractRelations(record);
  const timeline = extractTimeline(record);
  const controversies = extractControversies(record, relations);
  const sentimentLabel = toNonEmptyString(record.sentiment_label) ?? toNonEmptyString(record.sentiment) ?? undefined;
  const qualityScoreValue = toFiniteNumber(record.quality_score);
  const qualityScore = qualityScoreValue !== null ? qualityScoreValue : undefined;

  const hasData =
    actors.length > 0 ||
    relations.length > 0 ||
    timeline.length > 0 ||
    controversies.length > 0 ||
    Boolean(sentimentLabel) ||
    typeof qualityScore === 'number';

  return {
    actors,
    relations,
    timeline,
    controversies,
    ...(sentimentLabel ? { sentimentLabel } : {}),
    ...(typeof qualityScore === 'number' ? { qualityScore } : {}),
    hasData
  };
}
