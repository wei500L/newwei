import { buildComparableUrlVariants } from '@modular/mongo';
import { Injectable } from '@nestjs/common';

import { UserNewsBehaviorService } from '../user-news-behavior/user-news-behavior.service';
import {
  UserSettingsService,
  createDefaultNewsnowUiSettings,
} from '../user-settings/user-settings.service';

import { NewsAggregatorRegistryService } from './news-aggregator-registry.service';
import { NewsAggregatorService } from './news-aggregator.service';
import { type NewsItem } from './news-aggregator.types';
import { NewsnowHottestAnalysisService } from './newsnow-hottest-analysis.service';
import { buildSignalKey } from './newsnow-hottest-analysis.utils';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const MAX_ITEMS_PER_SOURCE = 8;

interface RecommendedSourceMetadata {
  name?: string;
  title?: string;
  home?: string;
}

export interface NewsnowRecommendedItem {
  id: string;
  sourceId: string;
  sourceName: string;
  title: string;
  url: string;
  mobileUrl: string | null;
  pubDate: number | string | null;
  topics: string[];
  entities: string[];
  matchedItemId?: string;
  matchedEventId?: string;
  reasonLabel: string;
  score: number;
  scoreBreakdown: {
    content: number;
    collaborative: number;
    source: number;
    hotness: number;
    final: number;
  };
}

export interface NewsnowRecommendedResponse {
  scope: 'hottest';
  generatedAt: string;
  degraded: boolean;
  items: NewsnowRecommendedItem[];
}

interface RecommendedCandidate {
  id: string;
  sourceId: string;
  sourceName: string;
  title: string;
  url: string;
  mobileUrl: string | null;
  pubDate: number | string | null;
  domain: string | null;
  topics: string[];
  entities: string[];
  matchedItemId: string | null;
  matchedEventId: string | null;
  contentScore: number;
  collaborativeScore: number;
  sourceScore: number;
  hotnessScore: number;
  finalScore: number;
  reasonLabel: string;
}

@Injectable()
export class NewsnowRecommendedService {
  constructor(
    private readonly registry: NewsAggregatorRegistryService,
    private readonly aggregator: NewsAggregatorService,
    private readonly hottestAnalysis: NewsnowHottestAnalysisService,
    private readonly behavior: UserNewsBehaviorService,
    private readonly userSettings: UserSettingsService,
  ) {}

  async getRecommendedFeed(input: {
    orgId: string;
    userId: string;
    limit?: number;
    forceRefresh?: boolean;
  }): Promise<NewsnowRecommendedResponse> {
    const metadata = this.registry.getMetadata();
    const hottestSourceIds = (metadata.columns?.hottest?.sources ?? []).slice(
      0,
      120,
    );
    if (hottestSourceIds.length === 0) {
      return {
        scope: 'hottest',
        generatedAt: new Date().toISOString(),
        degraded: true,
        items: [],
      };
    }

    const limit = Math.max(
      1,
      Math.min(MAX_LIMIT, Math.floor(input.limit ?? DEFAULT_LIMIT)),
    );
    const [profile, collaborative, settingsResponse, analysisResult, batch] =
      await Promise.all([
        this.behavior.getProfile(input.orgId, input.userId),
        this.behavior.getCollaborativeProfile(input.orgId, input.userId),
        this.userSettings.getNewsnowUiSettings(input.orgId, input.userId),
        this.loadHottestAnalysis(
          input.orgId,
          input.userId,
          input.forceRefresh === true,
        ),
        this.aggregator.fetchBatch(
          hottestSourceIds,
          input.forceRefresh === true,
        ),
      ]);

    const settings =
      settingsResponse?.settings ?? createDefaultNewsnowUiSettings();
    const analysisBySource = analysisResult.analysis?.bySource ?? {};
    const maxContent = this.buildDimensionMaxima(profile);
    const maxCollaborative = this.buildDimensionMaxima(collaborative);

    const candidates: RecommendedCandidate[] = [];
    const sourceResults = new Map(
      batch.results.map((result) => [result.id, result] as const),
    );

    for (const sourceId of hottestSourceIds) {
      const source = metadata.sources[sourceId];
      const response = sourceResults.get(sourceId);
      if (!source || !response) {
        continue;
      }
      const items = Array.isArray(response.items)
        ? response.items.slice(0, MAX_ITEMS_PER_SOURCE)
        : [];
      items.forEach((item, index) => {
        const candidate = this.buildCandidate({
          sourceId,
          sourceName: source.name ?? sourceId,
          sourceMeta: source,
          item,
          itemIndex: index,
          itemCount: items.length,
          analysisBySource: analysisBySource[sourceId] ?? {},
          profile,
          collaborative,
          settings,
          maxContent,
          maxCollaborative,
        });
        if (candidate) {
          candidates.push(candidate);
        }
      });
    }

    const deduped = this.dedupeCandidates(candidates)
      .sort((left, right) => {
        if (right.finalScore !== left.finalScore) {
          return right.finalScore - left.finalScore;
        }
        if (right.hotnessScore !== left.hotnessScore) {
          return right.hotnessScore - left.hotnessScore;
        }
        return left.id.localeCompare(right.id);
      })
      .slice(0, limit)
      .map((candidate) => ({
        id: candidate.id,
        sourceId: candidate.sourceId,
        sourceName: candidate.sourceName,
        title: candidate.title,
        url: candidate.url,
        mobileUrl: candidate.mobileUrl,
        pubDate: candidate.pubDate,
        topics: candidate.topics,
        entities: candidate.entities,
        ...(candidate.matchedItemId
          ? { matchedItemId: candidate.matchedItemId }
          : {}),
        ...(candidate.matchedEventId
          ? { matchedEventId: candidate.matchedEventId }
          : {}),
        reasonLabel: candidate.reasonLabel,
        score: candidate.finalScore,
        scoreBreakdown: {
          content: candidate.contentScore,
          collaborative: candidate.collaborativeScore,
          source: candidate.sourceScore,
          hotness: candidate.hotnessScore,
          final: candidate.finalScore,
        },
      }));

    return {
      scope: 'hottest',
      generatedAt: new Date().toISOString(),
      degraded:
        analysisResult.degraded ||
        collaborative.degraded ||
        batch.errors.length > 0,
      items: deduped,
    };
  }

  private async loadHottestAnalysis(
    orgId: string,
    userId: string,
    forceRefresh: boolean,
  ) {
    try {
      return {
        degraded: false,
        analysis: await this.hottestAnalysis.getHottestAnalysis({
          orgId,
          userId,
          forceRefresh,
          allowAutoBridge: false,
        }),
      };
    } catch {
      return {
        degraded: true,
        analysis: null,
      };
    }
  }

  private buildCandidate(input: {
    sourceId: string;
    sourceName: string;
    sourceMeta?: RecommendedSourceMetadata | null;
    item: NewsItem;
    itemIndex: number;
    itemCount: number;
    analysisBySource: Record<
      string,
      {
        topics: string[];
        entities: string[];
        candidateScore: number;
        freshnessScore: number;
        matchedItemId?: string;
        matchedEventId?: string;
        isRising: boolean;
        isNew: boolean;
      }
    >;
    profile: Awaited<ReturnType<UserNewsBehaviorService['getProfile']>>;
    collaborative: Awaited<
      ReturnType<UserNewsBehaviorService['getCollaborativeProfile']>
    >;
    settings: ReturnType<typeof createDefaultNewsnowUiSettings>;
    maxContent: Record<
      'items' | 'events' | 'topics' | 'entities' | 'domains',
      number
    >;
    maxCollaborative: Record<
      'items' | 'events' | 'topics' | 'entities' | 'domains',
      number
    >;
  }): RecommendedCandidate | null {
    const title =
      typeof input.item.title === 'string' ? input.item.title.trim() : '';
    const url = typeof input.item.url === 'string' ? input.item.url.trim() : '';
    if (!title || !url) {
      return null;
    }

    const signalKey = buildSignalKey({
      sourceId: input.sourceId,
      title,
      url,
    });
    const analysisItemKey =
      typeof input.item.id === 'string' || typeof input.item.id === 'number'
        ? String(input.item.id)
        : '';
    const analyzed = analysisItemKey
      ? input.analysisBySource[analysisItemKey]
      : undefined;
    const domain = this.normalizeDomain(url);
    const topics = this.normalizeBehaviorTerms(analyzed?.topics ?? []);
    const entities = this.normalizeBehaviorTerms(analyzed?.entities ?? []);
    const matchedItemId = analyzed?.matchedItemId ?? null;
    const matchedEventId = analyzed?.matchedEventId ?? null;
    if (
      this.isBlockedByNegativeFeedback({
        sourceId: input.sourceId,
        sourceName: input.sourceName,
        sourceMeta: input.sourceMeta,
        matchedItemId,
        matchedEventId,
        topics,
        entities,
        domain,
        negative: input.profile.negative,
      })
    ) {
      return null;
    }

    const contentScore = this.computePreferenceScore({
      matchedItemId,
      matchedEventId,
      topics,
      entities,
      domain,
      record: input.profile,
      maxima: input.maxContent,
    });
    const collaborativeScore = this.computePreferenceScore({
      matchedItemId,
      matchedEventId,
      topics,
      entities,
      domain,
      record: input.collaborative,
      maxima: input.maxCollaborative,
    });
    const sourceScore = this.computeSourceScore(
      input.sourceId,
      input.settings.focusSources,
      input.settings.sourceAffinity,
    );
    const hotnessScore = this.computeHotnessScore(
      analyzed?.candidateScore,
      analyzed?.freshnessScore,
      input.itemIndex,
      input.itemCount,
    );
    const finalScore = Number(
      (
        contentScore * 0.4 +
        collaborativeScore * 0.3 +
        sourceScore * 0.15 +
        hotnessScore * 0.15
      ).toFixed(4),
    );

    return {
      id: `${input.sourceId}:${signalKey}`,
      sourceId: input.sourceId,
      sourceName: input.sourceName,
      title,
      url,
      mobileUrl:
        typeof input.item.mobileUrl === 'string' &&
        input.item.mobileUrl.trim().length > 0
          ? input.item.mobileUrl.trim()
          : null,
      pubDate:
        typeof input.item.pubDate === 'number' ||
        typeof input.item.pubDate === 'string'
          ? input.item.pubDate
          : null,
      domain,
      topics,
      entities,
      matchedItemId,
      matchedEventId,
      contentScore,
      collaborativeScore,
      sourceScore,
      hotnessScore,
      finalScore,
      reasonLabel: this.resolveReasonLabel({
        contentScore,
        collaborativeScore,
        sourceScore,
        hotnessScore,
        focusSources: input.settings.focusSources,
        sourceId: input.sourceId,
        isNew: analyzed?.isNew ?? false,
        isRising: analyzed?.isRising ?? false,
        matchedItemId,
        matchedEventId,
      }),
    };
  }

  private isBlockedByNegativeFeedback(input: {
    sourceId: string;
    sourceName: string;
    sourceMeta?: RecommendedSourceMetadata | null;
    matchedItemId: string | null;
    matchedEventId: string | null;
    topics: string[];
    entities: string[];
    domain: string | null;
    negative: Awaited<
      ReturnType<UserNewsBehaviorService['getProfile']>
    >['negative'];
  }) {
    if (
      this.hasAnyPositiveScore(
        this.buildSourceBehaviorAliases(input.sourceId, {
          ...input.sourceMeta,
          name: input.sourceMeta?.name ?? input.sourceName,
        }),
        input.negative.sources,
      )
    ) {
      return true;
    }
    if (this.hasPositiveScore(input.negative.items, input.matchedItemId)) {
      return true;
    }
    if (this.hasPositiveScore(input.negative.events, input.matchedEventId)) {
      return true;
    }
    if (this.hasPositiveScore(input.negative.domains, input.domain)) {
      return true;
    }
    if (this.hasAnyPositiveScore(input.topics, input.negative.topics)) {
      return true;
    }
    return this.hasAnyPositiveScore(input.entities, input.negative.entities);
  }

  private hasAnyPositiveScore(keys: string[], record: Record<string, number>) {
    return keys.some((key) => this.hasPositiveScore(record, key));
  }

  private hasPositiveScore(
    record: Record<string, number>,
    key: string | null | undefined,
  ) {
    if (!key) {
      return false;
    }
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
  }

  private buildSourceBehaviorAliases(
    sourceId: string,
    sourceMeta?: RecommendedSourceMetadata | null,
  ) {
    const aliases: string[] = [];
    const seen = new Set<string>();
    const push = (value?: string | null) => {
      const normalized = this.normalizeBehaviorTerm(value);
      if (!normalized || seen.has(normalized)) {
        return;
      }
      seen.add(normalized);
      aliases.push(normalized);
    };

    push(sourceId);
    const baseSourceId = sourceId.split('-')[0] ?? sourceId;
    if (baseSourceId !== sourceId) {
      push(baseSourceId);
    }
    push(sourceMeta?.name);
    push(sourceMeta?.title);
    push(this.extractDomainFromUrl(sourceMeta?.home));
    return aliases;
  }

  private buildDimensionMaxima(
    record:
      | Pick<
          Awaited<ReturnType<UserNewsBehaviorService['getProfile']>>,
          'items' | 'events' | 'topics' | 'entities' | 'domains'
        >
      | Pick<
          Awaited<
            ReturnType<UserNewsBehaviorService['getCollaborativeProfile']>
          >,
          'items' | 'events' | 'topics' | 'entities' | 'domains'
        >,
  ) {
    return {
      items: this.maxRecordValue(record.items),
      events: this.maxRecordValue(record.events),
      topics: this.maxRecordValue(record.topics),
      entities: this.maxRecordValue(record.entities),
      domains: this.maxRecordValue(record.domains),
    };
  }

  private maxRecordValue(record: Record<string, number>) {
    const values = Object.values(record ?? {});
    return values.length > 0 ? Math.max(0, ...values) : 0;
  }

  private computePreferenceScore(input: {
    matchedItemId: string | null;
    matchedEventId: string | null;
    topics: string[];
    entities: string[];
    domain: string | null;
    record: {
      items: Record<string, number>;
      events: Record<string, number>;
      topics: Record<string, number>;
      entities: Record<string, number>;
      domains: Record<string, number>;
    };
    maxima: Record<
      'items' | 'events' | 'topics' | 'entities' | 'domains',
      number
    >;
  }) {
    const itemScore = this.normalizeTermScore(
      input.matchedItemId,
      input.record.items,
      input.maxima.items,
    );
    const eventScore = this.normalizeTermScore(
      input.matchedEventId,
      input.record.events,
      input.maxima.events,
    );
    const topicScore = this.averageNormalizedTerms(
      input.topics,
      input.record.topics,
      input.maxima.topics,
      4,
    );
    const entityScore = this.averageNormalizedTerms(
      input.entities,
      input.record.entities,
      input.maxima.entities,
      4,
    );
    const domainScore = this.normalizeTermScore(
      input.domain,
      input.record.domains,
      input.maxima.domains,
    );
    return Number(
      (
        itemScore * 0.32 +
        eventScore * 0.24 +
        topicScore * 0.18 +
        entityScore * 0.16 +
        domainScore * 0.1
      ).toFixed(4),
    );
  }

  private normalizeTermScore(
    key: string | null,
    record: Record<string, number>,
    maxValue: number,
  ) {
    if (!key || maxValue <= 0) {
      return 0;
    }
    const value = record[key];
    if (typeof value !== 'number' || value <= 0) {
      return 0;
    }
    return Number(Math.min(1, value / maxValue).toFixed(4));
  }

  private averageNormalizedTerms(
    terms: string[],
    record: Record<string, number>,
    maxValue: number,
    limit: number,
  ) {
    if (!Array.isArray(terms) || terms.length === 0 || maxValue <= 0) {
      return 0;
    }
    let score = 0;
    let count = 0;
    const seen = new Set<string>();
    for (const term of terms) {
      if (!term || seen.has(term)) {
        continue;
      }
      seen.add(term);
      score += this.normalizeTermScore(term, record, maxValue);
      count += 1;
      if (count >= limit) {
        break;
      }
    }
    if (count === 0) {
      return 0;
    }
    return Number((score / count).toFixed(4));
  }

  private normalizeBehaviorTerms(values: string[]) {
    if (!Array.isArray(values)) {
      return [];
    }
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      const normalized = this.normalizeBehaviorTerm(value);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      out.push(normalized);
    }
    return out;
  }

  private computeSourceScore(
    sourceId: string,
    focusSources: string[],
    sourceAffinity: Record<string, { score: number }>,
  ) {
    const affinityRaw = sourceAffinity[sourceId]?.score ?? 0;
    const affinity = Number(
      Math.max(0, Math.min(1, affinityRaw / 100)).toFixed(4),
    );
    const focusBonus = focusSources.includes(sourceId) ? 0.25 : 0;
    return Number(Math.min(1, affinity * 0.75 + focusBonus).toFixed(4));
  }

  private computeHotnessScore(
    candidateScore: number | undefined,
    freshnessScore: number | undefined,
    itemIndex: number,
    itemCount: number,
  ) {
    if (
      typeof candidateScore === 'number' &&
      Number.isFinite(candidateScore) &&
      typeof freshnessScore === 'number' &&
      Number.isFinite(freshnessScore)
    ) {
      return Number(
        Math.min(1, candidateScore * 0.7 + freshnessScore * 0.3).toFixed(4),
      );
    }
    const denominator = Math.max(1, itemCount);
    return Number(Math.max(0.1, 1 - itemIndex / denominator).toFixed(4));
  }

  private resolveReasonLabel(input: {
    contentScore: number;
    collaborativeScore: number;
    sourceScore: number;
    hotnessScore: number;
    focusSources: string[];
    sourceId: string;
    isNew: boolean;
    isRising: boolean;
    matchedItemId: string | null;
    matchedEventId: string | null;
  }) {
    const breakdown: [string, number][] = [
      ['content', input.contentScore] as [string, number],
      ['collaborative', input.collaborativeScore] as [string, number],
      ['source', input.sourceScore] as [string, number],
      ['hotness', input.hotnessScore] as [string, number],
    ];
    breakdown.sort((left, right) => right[1] - left[1]);
    const dominant = breakdown[0]?.[0];

    if (dominant === 'collaborative' && input.collaborativeScore > 0) {
      return '相似用户也在关注';
    }
    if (dominant === 'content' && input.contentScore > 0) {
      if (input.matchedEventId) {
        return '匹配近期事件偏好';
      }
      if (input.matchedItemId) {
        return '匹配近期阅读偏好';
      }
      return '匹配近期主题偏好';
    }
    if (dominant === 'source' && input.sourceScore > 0) {
      return input.focusSources.includes(input.sourceId)
        ? '来自你关注的来源'
        : '来源偏好较高';
    }
    if (input.isRising) {
      return '热点正在上升';
    }
    if (input.isNew) {
      return '新进入热点候选';
    }
    return '当前热度较高';
  }

  private dedupeCandidates(candidates: RecommendedCandidate[]) {
    const bestByKey = new Map<string, RecommendedCandidate>();
    for (const candidate of candidates) {
      const dedupeKey = this.buildDedupeKey(candidate);
      const existing = bestByKey.get(dedupeKey);
      if (!existing || candidate.finalScore > existing.finalScore) {
        bestByKey.set(dedupeKey, candidate);
      }
    }
    return Array.from(bestByKey.values());
  }

  private buildDedupeKey(candidate: RecommendedCandidate) {
    const comparable = buildComparableUrlVariants(candidate.url)?.full;
    if (comparable) {
      return `url:${comparable.toLowerCase()}`;
    }
    if (candidate.matchedEventId) {
      return `event:${candidate.matchedEventId}`;
    }
    if (candidate.matchedItemId) {
      return `item:${candidate.matchedItemId}`;
    }
    return `${candidate.sourceId}:${candidate.id}`;
  }

  private normalizeDomain(url: string): string | null {
    try {
      return new URL(url).hostname
        .trim()
        .toLowerCase()
        .replace(/^www\./, '');
    } catch {
      return null;
    }
  }

  private extractDomainFromUrl(value?: string | null) {
    if (typeof value !== 'string') {
      return null;
    }
    const raw = value.trim();
    if (!raw) {
      return null;
    }
    const parse = (candidate: string) => {
      try {
        return new URL(candidate).hostname
          .trim()
          .toLowerCase()
          .replace(/^www\./, '');
      } catch {
        return null;
      }
    };
    return parse(raw) ?? parse(`https://${raw}`);
  }

  private normalizeBehaviorTerm(value?: string | null) {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = value
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .slice(0, 96);
    return normalized.length > 0 ? normalized : null;
  }
}
