import {
  extractCountryCodeFromText,
  getCountryAlpha2,
  getCountryName,
  normalizeCountryCode,
  createLogger,
} from "@modular/utils";
import {
  ContentSubscriptionKind,
  ContentSubscriptionSource,
  Prisma,
  SituationMonitorMonitorKind,
} from "@prisma/client";
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { PrismaService } from "../config/prisma.service";
import { GeocodeBounds, GeocodingService } from "../geo/geocoding.service";
import { LiteLlmService } from "../news-pipeline/litellm.service";
import { NewsClassificationSettingsService } from "../news-pipeline/news-classification-settings.service";

import type {
  CreateSituationMonitorDto,
  SituationMonitorPreviewDto,
  UpdateSituationMonitorDto,
} from "./dto/situation-monitor-monitor.dto";
import type { SituationMonitorInsightsResponse } from "./situation-monitor.service";
import type {
  SituationMonitorMatchGeoStatus,
  SituationMonitorMatchReason,
  SituationMonitorMatchResult,
} from "./situation-monitor.types";
import type {
  OrefAlert,
  OrefHistoryEntry,
  SituationOrefAlertsResponse,
  SituationOrefHistoryResponse,
  SituationTelegramFeedResponse,
  TelegramSignalItem,
} from "./signals/situation-monitor-signals.types";

const LEGACY_MONITORS_USER_SETTING_KEY = "ui:situation-monitor:monitors:v1";
const MAX_MANUAL_MONITORS = 20;
const MAX_KEYWORDS = 30;
const MAX_APPROVED_TERMS = 36;
const MAX_APPROVED_SUGGESTIONS = 24;
const PREVIEW_CANDIDATE_LIMIT = 120;
const PREVIEW_SUGGESTION_LIMIT = 6;
const MATCH_EMBEDDING_BATCH_SIZE = 96;
const SEMANTIC_INCLUDE_THRESHOLD = 0.82;
const SEMANTIC_SHORTLIST_THRESHOLD = 0.68;
const RERANK_INCLUDE_THRESHOLD = 0.55;
const RERANK_SHORTLIST_LIMIT = 8;
const SYSTEM_SYNC_MONITOR_NAME = "Subscription Sync";
const SYSTEM_SYNC_MONITOR_COLOR = "#9254de";

interface MonitorLocation {
  name: string;
  lat: number;
  lng: number;
  bounds?: GeocodeBounds;
  countryCodeAlpha2?: string;
}

interface RejectedSuggestionState {
  topics: string[];
  entities: string[];
  lexicalTerms: string[];
}

export interface StoredMonitorDto {
  id: string;
  kind: "manual" | "system_sync";
  name: string;
  enabled: boolean;
  color?: string;
  rawKeywords: string[];
  approvedTopics: string[];
  approvedEntities: string[];
  approvedLexicalTerms: string[];
  rejectedSuggestions: RejectedSuggestionState;
  location?: MonitorLocation;
  queryEmbeddingModel?: string;
  lastResolvedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PreviewSuggestion {
  value: string;
  normalizedValue: string;
  displayValue: string;
  reason: "lexical" | "semantic" | "rerank";
  score?: number;
  matchedTerms?: string[];
  taxonomyPath?: string | null;
  taxonomyDisplayName?: string | null;
}

export interface PreviewResponse {
  name: string;
  rawKeywords: string[];
  locationResolution: MonitorLocation | null;
  suggestedTopics: PreviewSuggestion[];
  suggestedEntities: PreviewSuggestion[];
  suggestedLexicalTerms: PreviewSuggestion[];
  modelInfo: {
    embeddingModel?: string;
    rerankModel?: string;
  };
}

interface NormalizedMonitorRecord {
  id: string;
  kind: "manual" | "system_sync";
  name: string;
  enabled: boolean;
  color?: string;
  rawKeywords: string[];
  approvedTopics: string[];
  approvedEntities: string[];
  approvedLexicalTerms: string[];
  rejectedSuggestions: RejectedSuggestionState;
  location?: MonitorLocation;
  queryEmbeddingModel?: string;
  queryEmbeddingVector?: number[];
  createdAt: string;
  updatedAt: string;
}

interface MonitorCandidate {
  itemKey: string;
  itemType:
    | "headline"
    | "alert"
    | "situation"
    | "telegram"
    | "oref_alert"
    | "oref_history";
  itemMetaId?: string;
  title: string;
  titleZh?: string;
  summary?: string;
  summaryZh?: string;
  link: string;
  source: string;
  timestamp: number;
  category?: string;
  topics: string[];
  entities: string[];
  location?: string;
  extraTexts: string[];
}

interface OwnershipEntry {
  ownerMonitorIds: string[];
  ownerMonitorNames: string[];
  manualMonitorOwned: boolean;
  systemSyncOwned: boolean;
}

type CatalogRow = {
  kind: ContentSubscriptionKind;
  normalizedValue: string;
  displayValue: string;
  count: number;
  lastSeenAt: Date;
  taxonomyPath: string | null;
  embeddingVector: Prisma.JsonValue | null;
};

@Injectable()
export class SituationMonitorMonitorsService {
  private readonly logger = createLogger({
    name: "situation-monitor-monitors",
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly liteLlm: LiteLlmService,
    private readonly geocoding: GeocodingService,
    private readonly classificationSettings: NewsClassificationSettingsService,
  ) {}

  async listMonitors(
    orgId: string,
    userId: string,
  ): Promise<StoredMonitorDto[]> {
    const rows = await this.loadMonitorRows(orgId, userId);
    return rows.map((row) => this.mapRow(row));
  }

  async previewMonitor(
    orgId: string,
    input: SituationMonitorPreviewDto,
  ): Promise<PreviewResponse> {
    const name = normalizeName(input.name);
    const rawKeywords = normalizeKeywordList(input.rawKeywords);
    const rejected = normalizeRejectedSuggestions(input);
    const taxonomyDisplayNames = await this.loadTaxonomyDisplayNames(orgId);
    const locationResolution = await this.resolveLocationInput(input.location);
    const queryText = this.buildQueryText({
      name,
      rawKeywords,
      approvedTopics: [],
      approvedEntities: [],
      approvedLexicalTerms: [],
      location: locationResolution ?? undefined,
    });

    const catalogRows = await this.prisma.contentSubscriptionCatalog.findMany({
      where: {
        orgId,
        count: { gte: 2 },
      },
      orderBy: [{ count: "desc" }, { lastSeenAt: "desc" }],
      take: PREVIEW_CANDIDATE_LIMIT,
    });

    const lexicalScores = new Map<string, number>();
    for (const row of catalogRows) {
      const lexicalScore = this.lexicalCatalogScore(
        row.displayValue,
        row.normalizedValue,
        name,
        rawKeywords,
      );
      if (lexicalScore > 0) {
        lexicalScores.set(
          this.subscriptionKey(row.kind, row.normalizedValue),
          lexicalScore,
        );
      }
    }

    const embeddingRanked = await this.rankCatalogRowsByEmbedding(
      orgId,
      queryText,
      catalogRows,
    );

    const mergedCandidates = new Map<
      string,
      { row: CatalogRow; score: number; reason: "lexical" | "semantic" }
    >();

    for (const row of catalogRows) {
      const key = this.subscriptionKey(row.kind, row.normalizedValue);
      const lexical = lexicalScores.get(key);
      if (lexical && lexical > 0) {
        mergedCandidates.set(key, { row, score: lexical, reason: "lexical" });
      }
    }

    for (const entry of embeddingRanked) {
      const key = this.subscriptionKey(
        entry.row.kind,
        entry.row.normalizedValue,
      );
      const existing = mergedCandidates.get(key);
      if (!existing || entry.score > existing.score) {
        mergedCandidates.set(key, {
          row: entry.row,
          score: entry.score,
          reason: "semantic",
        });
      }
    }

    const reranked = await this.tryRerankCatalogRows(
      orgId,
      queryText,
      Array.from(mergedCandidates.values())
        .sort((a, b) => b.score - a.score || b.row.count - a.row.count)
        .slice(0, 16)
        .map((entry) => ({ row: entry.row, score: entry.score })),
    );

    const rerankScoreByKey = new Map(
      reranked.map((entry) => [
        this.subscriptionKey(entry.row.kind, entry.row.normalizedValue),
        entry.score,
      ]),
    );

    const candidates = Array.from(mergedCandidates.values())
      .map((entry) => {
        const key = this.subscriptionKey(
          entry.row.kind,
          entry.row.normalizedValue,
        );
        const rerankScore = rerankScoreByKey.get(key);
        return {
          ...entry,
          score:
            rerankScore !== undefined
              ? 0.65 * rerankScore + 0.35 * entry.score
              : entry.score,
          reason:
            rerankScore !== undefined ? ("rerank" as const) : entry.reason,
        };
      })
      .sort((a, b) => b.score - a.score || b.row.count - a.row.count);

    const suggestedTopics = candidates
      .filter((entry) => entry.row.kind === ContentSubscriptionKind.topic)
      .filter(
        (entry) =>
          !rejected.topics.includes(entry.row.normalizedValue) &&
          !rawKeywords.some(
            (keyword) => normalizeTerm(keyword) === entry.row.normalizedValue,
          ),
      )
      .slice(0, PREVIEW_SUGGESTION_LIMIT)
      .map((entry) => ({
        value: entry.row.displayValue,
        normalizedValue: entry.row.normalizedValue,
        displayValue: entry.row.displayValue,
        reason: entry.reason,
        score: roundScore(entry.score),
        matchedTerms: this.collectPreviewMatchedTerms(
          entry.row.displayValue,
          entry.row.normalizedValue,
          name,
          rawKeywords,
        ),
        taxonomyPath: entry.row.taxonomyPath,
        taxonomyDisplayName: this.taxonomyDisplayName(
          entry.row.taxonomyPath,
          taxonomyDisplayNames,
        ),
      }));

    const suggestedEntities = candidates
      .filter((entry) => entry.row.kind === ContentSubscriptionKind.entity)
      .filter(
        (entry) =>
          !rejected.entities.includes(entry.row.normalizedValue) &&
          !rawKeywords.some(
            (keyword) => normalizeTerm(keyword) === entry.row.normalizedValue,
          ),
      )
      .slice(0, PREVIEW_SUGGESTION_LIMIT)
      .map((entry) => ({
        value: entry.row.displayValue,
        normalizedValue: entry.row.normalizedValue,
        displayValue: entry.row.displayValue,
        reason: entry.reason,
        score: roundScore(entry.score),
        matchedTerms: this.collectPreviewMatchedTerms(
          entry.row.displayValue,
          entry.row.normalizedValue,
          name,
          rawKeywords,
        ),
        taxonomyPath: entry.row.taxonomyPath,
        taxonomyDisplayName: this.taxonomyDisplayName(
          entry.row.taxonomyPath,
          taxonomyDisplayNames,
        ),
      }));

    const suggestedLexicalTerms = this.buildLexicalPreviewSuggestions({
      rawKeywords,
      topicSuggestions: suggestedTopics,
      entitySuggestions: suggestedEntities,
      rejectedLexicalTerms: rejected.lexicalTerms,
    });
    const rerankModel = await this.liteLlm.getRerankModel();

    return {
      name,
      rawKeywords,
      locationResolution: locationResolution ?? null,
      suggestedTopics,
      suggestedEntities,
      suggestedLexicalTerms,
      modelInfo: {
        ...(embeddingRanked.model
          ? { embeddingModel: embeddingRanked.model }
          : {}),
        ...(rerankModel ? { rerankModel } : {}),
      },
    };
  }

  async createMonitor(
    orgId: string,
    userId: string,
    input: CreateSituationMonitorDto,
  ): Promise<StoredMonitorDto> {
    await this.ensureLegacyMigration(orgId, userId);
    const existingManualCount = await this.prisma.situationMonitorMonitor.count(
      {
        where: { orgId, userId, kind: SituationMonitorMonitorKind.manual },
      },
    );
    if (existingManualCount >= MAX_MANUAL_MONITORS) {
      throw new BadRequestException("Manual monitor limit reached");
    }

    const payload = await this.buildPersistedMonitorPayload(
      orgId,
      input,
      "manual",
    );
    const created = await this.prisma.situationMonitorMonitor.create({
      data: {
        orgId,
        userId,
        kind: SituationMonitorMonitorKind.manual,
        ...payload,
      },
    });
    await this.reconcileContentSubscriptionSync(orgId, userId);
    return this.mapRow(created);
  }

  async updateMonitor(
    orgId: string,
    userId: string,
    id: string,
    patch: UpdateSituationMonitorDto,
  ): Promise<StoredMonitorDto> {
    await this.ensureLegacyMigration(orgId, userId);
    const existing = await this.prisma.situationMonitorMonitor.findFirst({
      where: { orgId, userId, id },
    });
    if (!existing) {
      throw new NotFoundException("Monitor not found");
    }
    if (
      existing.kind === SituationMonitorMonitorKind.system_sync &&
      (patch.name !== undefined ||
        patch.rawKeywords !== undefined ||
        patch.approvedTopics !== undefined ||
        patch.approvedEntities !== undefined ||
        patch.approvedLexicalTerms !== undefined ||
        patch.rejectedTopics !== undefined ||
        patch.rejectedEntities !== undefined ||
        patch.rejectedLexicalTerms !== undefined ||
        patch.location !== undefined)
    ) {
      throw new BadRequestException("System sync monitor is read only");
    }

    const payload = await this.buildPersistedMonitorPayload(
      orgId,
      {
        name: patch.name ?? existing.name,
        rawKeywords:
          patch.rawKeywords ??
          parseStringArray(existing.rawKeywords, MAX_KEYWORDS),
        approvedTopics:
          patch.approvedTopics ??
          parseStringArray(existing.approvedTopics, MAX_APPROVED_SUGGESTIONS),
        approvedEntities:
          patch.approvedEntities ??
          parseStringArray(existing.approvedEntities, MAX_APPROVED_SUGGESTIONS),
        approvedLexicalTerms:
          patch.approvedLexicalTerms ??
          parseStringArray(existing.approvedLexicalTerms, MAX_APPROVED_TERMS),
        rejectedTopics:
          patch.rejectedTopics ??
          parseRejectedSuggestions(existing.rejectedSuggestions).topics,
        rejectedEntities:
          patch.rejectedEntities ??
          parseRejectedSuggestions(existing.rejectedSuggestions).entities,
        rejectedLexicalTerms:
          patch.rejectedLexicalTerms ??
          parseRejectedSuggestions(existing.rejectedSuggestions).lexicalTerms,
        color:
          patch.color === undefined
            ? (existing.color ?? undefined)
            : (patch.color ?? undefined),
        location:
          patch.location === undefined
            ? this.locationToInput(existing)
            : (patch.location ?? undefined),
        enabled: patch.enabled ?? existing.enabled,
      },
      existing.kind === SituationMonitorMonitorKind.system_sync
        ? "system_sync"
        : "manual",
    );

    const updated = await this.prisma.situationMonitorMonitor.update({
      where: { id: existing.id },
      data: {
        ...payload,
        enabled: patch.enabled ?? payload.enabled,
      },
    });
    await this.reconcileContentSubscriptionSync(orgId, userId);
    return this.mapRow(updated);
  }

  async deleteMonitor(
    orgId: string,
    userId: string,
    id: string,
  ): Promise<void> {
    await this.ensureLegacyMigration(orgId, userId);
    const existing = await this.prisma.situationMonitorMonitor.findFirst({
      where: { orgId, userId, id },
    });
    if (!existing) {
      return;
    }
    if (existing.kind === SituationMonitorMonitorKind.system_sync) {
      throw new BadRequestException("System sync monitor cannot be deleted");
    }
    await this.prisma.situationMonitorMonitor.delete({ where: { id } });
    await this.reconcileContentSubscriptionSync(orgId, userId);
  }

  async augmentInsights(
    orgId: string,
    userId: string,
    response: SituationMonitorInsightsResponse,
  ): Promise<SituationMonitorInsightsResponse> {
    const candidates: MonitorCandidate[] = [];
    for (const [category, entries] of Object.entries(
      response.headlines ?? {},
    )) {
      for (const entry of entries) {
        candidates.push({
          itemKey: this.itemKey(entry.itemMetaId, entry.link, entry.title),
          itemType: "headline",
          itemMetaId: entry.itemMetaId,
          title: entry.title,
          titleZh: entry.titleZh,
          summary: entry.summary,
          summaryZh: entry.summaryZh,
          link: entry.link,
          source: entry.source,
          timestamp: entry.timestamp,
          category,
          topics: entry.topics ?? [],
          entities: entry.entities ?? [],
          location: entry.location,
          extraTexts: entry.keyPoints ?? [],
        });
      }
    }
    for (const entry of response.alerts ?? []) {
      candidates.push({
        itemKey: this.itemKey(entry.itemMetaId, entry.link, entry.title),
        itemType: "alert",
        itemMetaId: entry.itemMetaId,
        title: entry.title,
        titleZh: entry.titleZh,
        summary: entry.summary,
        summaryZh: entry.summaryZh,
        link: entry.link,
        source: entry.source,
        timestamp: entry.timestamp,
        category: `alert:${entry.category}`,
        topics: entry.topics ?? [],
        entities: entry.entities ?? [],
        location: entry.location,
        extraTexts: entry.keyPoints ?? [],
      });
    }
    for (const panel of response.situations ?? []) {
      for (const entry of panel.headlines ?? []) {
        candidates.push({
          itemKey: this.itemKey(undefined, entry.link, entry.title),
          itemType: "situation",
          title: entry.title,
          titleZh: entry.titleZh,
          link: entry.link,
          source: entry.source,
          timestamp: entry.timestamp,
          category: `situation:${panel.id}`,
          topics: [],
          entities: [],
          extraTexts: [panel.title, panel.subtitle],
        });
      }
    }
    return {
      ...response,
      monitorMatches: await this.matchCandidates(orgId, userId, candidates),
    };
  }

  async augmentTelegramFeed(
    orgId: string,
    userId: string,
    response: SituationTelegramFeedResponse,
  ): Promise<SituationTelegramFeedResponse> {
    const candidates = (response.items ?? []).map((item) =>
      this.telegramCandidate(item),
    );
    return {
      ...response,
      monitorMatches: await this.matchCandidates(orgId, userId, candidates),
    };
  }

  async augmentOrefAlerts(
    orgId: string,
    userId: string,
    response: SituationOrefAlertsResponse,
  ): Promise<SituationOrefAlertsResponse> {
    const candidates = (response.alerts ?? []).map((alert) =>
      this.orefAlertCandidate(alert, "oref_alert"),
    );
    return {
      ...response,
      monitorMatches: await this.matchCandidates(orgId, userId, candidates),
    };
  }

  async augmentOrefHistory(
    orgId: string,
    userId: string,
    response: SituationOrefHistoryResponse,
  ): Promise<SituationOrefHistoryResponse> {
    const candidates: MonitorCandidate[] = [];
    for (const entry of response.history ?? []) {
      for (const alert of entry.alerts ?? []) {
        candidates.push(this.orefHistoryCandidate(alert, entry));
      }
    }
    return {
      ...response,
      monitorMatches: await this.matchCandidates(orgId, userId, candidates),
    };
  }

  async reconcileContentSubscriptionSync(
    orgId: string,
    userId: string,
  ): Promise<void> {
    await this.ensureLegacyMigration(orgId, userId);
    await this.reconcileManualMonitorSubscriptions(orgId, userId);
    await this.syncSystemMonitorFromSubscriptions(orgId, userId);
  }

  async buildSubscriptionOwnershipMap(
    orgId: string,
    userId: string,
  ): Promise<Map<string, OwnershipEntry>> {
    const rows = await this.loadMonitorRows(orgId, userId);
    const ownership = new Map<string, OwnershipEntry>();

    for (const row of rows) {
      const topics = parseStringArray(
        row.approvedTopics,
        MAX_APPROVED_SUGGESTIONS,
      );
      const entities = parseStringArray(
        row.approvedEntities,
        MAX_APPROVED_SUGGESTIONS,
      );
      for (const topic of topics) {
        const key = this.subscriptionKey(
          ContentSubscriptionKind.topic,
          normalizeTerm(topic),
        );
        upsertOwnershipEntry(ownership, key, row.id, row.name, row.kind);
      }
      for (const entity of entities) {
        const key = this.subscriptionKey(
          ContentSubscriptionKind.entity,
          normalizeTerm(entity),
        );
        upsertOwnershipEntry(ownership, key, row.id, row.name, row.kind);
      }
    }

    return ownership;
  }

  private async matchCandidates(
    orgId: string,
    userId: string,
    candidates: MonitorCandidate[],
  ): Promise<SituationMonitorMatchResult[]> {
    if (candidates.length === 0) {
      return [];
    }

    const monitors = (await this.loadMonitorRows(orgId, userId))
      .map((row) => this.normalizeMonitorRow(row))
      .filter((row) => row.enabled);
    if (monitors.length === 0) {
      return [];
    }

    const candidateEmbeddings = await this.embedCandidateBatch(
      orgId,
      monitors,
      candidates,
    );
    const results: SituationMonitorMatchResult[] = [];

    for (const monitor of monitors) {
      const explicitScores = candidates.map((candidate) =>
        this.computeExplicitCandidateSignals(monitor, candidate),
      );

      const semanticCandidates = candidates
        .map((candidate, index) => {
          const vector = candidateEmbeddings.get(candidate.itemKey);
          if (
            !vector ||
            !monitor.queryEmbeddingVector ||
            vector.length !== monitor.queryEmbeddingVector.length
          ) {
            return null;
          }
          return {
            index,
            score: dot(monitor.queryEmbeddingVector, vector),
          };
        })
        .filter((entry): entry is { index: number; score: number } =>
          Boolean(entry),
        )
        .sort((a, b) => b.score - a.score)
        .filter((entry) => entry.score >= SEMANTIC_SHORTLIST_THRESHOLD)
        .slice(0, RERANK_SHORTLIST_LIMIT);

      const rerankScores = await this.tryRerankCandidates(
        orgId,
        monitor,
        semanticCandidates.map((entry) => candidates[entry.index]!),
      );

      for (const [index, candidate] of candidates.entries()) {
        const explicit = explicitScores[index]!;
        if (explicit.geoStatus === "conflict") {
          continue;
        }

        const semanticScore =
          semanticCandidates.find((entry) => entry.index === index)?.score ??
          null;
        const rerankScore = rerankScores.get(candidate.itemKey) ?? null;
        const include =
          explicit.reasons.length > 0 ||
          (rerankScore !== null && rerankScore >= RERANK_INCLUDE_THRESHOLD) ||
          (rerankScore === null &&
            semanticScore !== null &&
            semanticScore >= SEMANTIC_INCLUDE_THRESHOLD);

        if (!include) {
          continue;
        }

        const reasons: SituationMonitorMatchReason[] = [...explicit.reasons];
        if (semanticScore !== null) {
          reasons.push({
            code: "semantic",
            label: "Semantic recall",
            score: roundScore(semanticScore),
          });
        }
        if (rerankScore !== null) {
          reasons.push({
            code: "rerank",
            label: "Rerank accepted",
            score: roundScore(rerankScore),
          });
        }
        if (
          explicit.geoStatus === "matched" ||
          explicit.geoStatus === "country_match"
        ) {
          reasons.push({
            code: "geo",
            label:
              explicit.geoStatus === "matched"
                ? "Location matched"
                : "Country matched",
          });
        }

        const finalScore = clamp01(
          explicit.baseScore +
            (semanticScore !== null ? semanticScore * 0.15 : 0) +
            (rerankScore !== null ? rerankScore * 0.2 : 0),
        );

        results.push({
          itemKey: candidate.itemKey,
          itemType: candidate.itemType,
          ...(candidate.itemMetaId ? { itemMetaId: candidate.itemMetaId } : {}),
          monitorId: monitor.id,
          monitorKind: monitor.kind,
          monitorName: monitor.name,
          ...(monitor.color ? { monitorColor: monitor.color } : {}),
          score: roundScore(finalScore),
          geoStatus: explicit.geoStatus,
          matchedTerms: Array.from(new Set(explicit.matchedTerms)).slice(0, 8),
          reasons,
          ...(candidate.link ? { link: candidate.link } : { link: "" }),
          ...(candidate.title ? { title: candidate.title } : { title: "" }),
          ...(candidate.titleZh ? { titleZh: candidate.titleZh } : {}),
          ...(candidate.summary ? { summary: candidate.summary } : {}),
          ...(candidate.summaryZh ? { summaryZh: candidate.summaryZh } : {}),
          ...(candidate.category ? { category: candidate.category } : {}),
          source: candidate.source,
          timestamp: candidate.timestamp,
        });
      }
    }

    return results.sort(
      (a, b) =>
        b.timestamp - a.timestamp ||
        b.score - a.score ||
        a.monitorName.localeCompare(b.monitorName),
    );
  }

  private async tryRerankCandidates(
    orgId: string,
    monitor: NormalizedMonitorRecord,
    candidates: MonitorCandidate[],
  ): Promise<Map<string, number>> {
    if (candidates.length === 0) {
      return new Map();
    }
    try {
      const response = await this.liteLlm.rerank({
        orgId,
        query: this.buildQueryText(monitor),
        documents: candidates.map((candidate) =>
          this.candidateEmbeddingText(candidate),
        ),
        topN: candidates.length,
        metadata: {
          feature: "situation_monitor_monitors",
          source: "situation-monitor-monitors",
          stage: "monitor-rerank",
        },
      });
      const scored = (response.results ?? [])
        .map((entry) => {
          const candidate = candidates[entry.index];
          if (
            !candidate ||
            typeof entry.score !== "number" ||
            !Number.isFinite(entry.score)
          ) {
            return null;
          }
          return { itemKey: candidate.itemKey, score: entry.score };
        })
        .filter((entry): entry is { itemKey: string; score: number } =>
          Boolean(entry),
        );
      if (scored.length === 0) {
        return new Map();
      }
      const min = Math.min(...scored.map((entry) => entry.score));
      const max = Math.max(...scored.map((entry) => entry.score));
      return new Map(
        scored.map((entry) => [
          entry.itemKey,
          max === min ? 1 : (entry.score - min) / (max - min),
        ]),
      );
    } catch (error) {
      this.logger.warn(
        { err: error, orgId, monitorId: monitor.id },
        "Failed to rerank monitor candidates",
      );
      return new Map();
    }
  }

  private async embedCandidateBatch(
    orgId: string,
    monitors: NormalizedMonitorRecord[],
    candidates: MonitorCandidate[],
  ): Promise<Map<string, number[]>> {
    if (
      monitors.every((monitor) => !monitor.queryEmbeddingVector) ||
      candidates.length === 0
    ) {
      return new Map();
    }

    const results = new Map<string, number[]>();
    for (const chunk of chunkArray(candidates, MATCH_EMBEDDING_BATCH_SIZE)) {
      try {
        const response = await this.liteLlm.embedding({
          orgId,
          input: chunk.map((candidate) =>
            this.candidateEmbeddingText(candidate),
          ),
          metadata: {
            feature: "situation_monitor_monitors",
            source: "situation-monitor-monitors",
            stage: "candidate-embedding",
          },
        });
        for (const [index, candidate] of chunk.entries()) {
          const vector = response.data?.find(
            (entry) => entry.index === index,
          )?.embedding;
          if (!Array.isArray(vector) || vector.length === 0) {
            continue;
          }
          results.set(candidate.itemKey, normalizeVector(vector));
        }
      } catch (error) {
        this.logger.warn(
          { err: error, orgId },
          "Failed to embed monitor candidates",
        );
        return new Map();
      }
    }

    return results;
  }

  private computeExplicitCandidateSignals(
    monitor: NormalizedMonitorRecord,
    candidate: MonitorCandidate,
  ): {
    reasons: SituationMonitorMatchReason[];
    matchedTerms: string[];
    geoStatus: SituationMonitorMatchGeoStatus;
    baseScore: number;
  } {
    const haystack = buildHaystack(candidate);
    const matchedTerms: string[] = [];
    const reasons: SituationMonitorMatchReason[] = [];

    const keywordHits = collectLexicalHits(
      monitor.rawKeywords.concat(monitor.approvedLexicalTerms),
      haystack,
    );
    if (keywordHits.length > 0) {
      matchedTerms.push(...keywordHits);
      reasons.push({
        code: "keyword",
        label: "Keyword matched",
        matchedValues: keywordHits,
      });
    }

    const topicHits = collectSetHits(monitor.approvedTopics, [
      ...candidate.topics,
      ...candidate.extraTexts,
    ]);
    if (topicHits.length > 0) {
      matchedTerms.push(...topicHits);
      reasons.push({
        code: "topic",
        label: "Topic matched",
        matchedValues: topicHits,
      });
    }

    const entityHits = collectSetHits(monitor.approvedEntities, [
      ...candidate.entities,
      candidate.title,
      candidate.summary ?? "",
      ...candidate.extraTexts,
    ]);
    if (entityHits.length > 0) {
      matchedTerms.push(...entityHits);
      reasons.push({
        code: "entity",
        label: "Entity matched",
        matchedValues: entityHits,
      });
    }

    const geoStatus = this.resolveGeoStatus(monitor, candidate, haystack);
    let baseScore = 0;
    if (keywordHits.length > 0) {
      baseScore += 0.42;
    }
    if (topicHits.length > 0) {
      baseScore += 0.18;
    }
    if (entityHits.length > 0) {
      baseScore += 0.18;
    }
    if (geoStatus === "matched") {
      baseScore += 0.08;
    }
    if (geoStatus === "country_match") {
      baseScore += 0.04;
    }

    return {
      reasons,
      matchedTerms,
      geoStatus,
      baseScore: clamp01(baseScore),
    };
  }

  private resolveGeoStatus(
    monitor: NormalizedMonitorRecord,
    candidate: MonitorCandidate,
    haystack: string,
  ): SituationMonitorMatchGeoStatus {
    if (!monitor.location) {
      return "not_configured";
    }

    const normalizedLocationName = normalizeTerm(monitor.location.name);
    if (normalizedLocationName && haystack.includes(normalizedLocationName)) {
      return "matched";
    }

    const candidateCountry = extractCountryCodeFromText(
      [
        candidate.location ?? "",
        candidate.title,
        candidate.summary ?? "",
        ...candidate.extraTexts,
        ...candidate.topics,
        ...candidate.entities,
      ].join(" "),
    );

    if (
      candidateCountry &&
      monitor.location.countryCodeAlpha2 &&
      candidateCountry !== monitor.location.countryCodeAlpha2
    ) {
      return "conflict";
    }
    if (
      candidateCountry &&
      monitor.location.countryCodeAlpha2 &&
      candidateCountry === monitor.location.countryCodeAlpha2
    ) {
      return "country_match";
    }
    return "unresolved";
  }

  private async reconcileManualMonitorSubscriptions(
    orgId: string,
    userId: string,
  ): Promise<void> {
    const rows = await this.prisma.situationMonitorMonitor.findMany({
      where: { orgId, userId, kind: SituationMonitorMonitorKind.manual },
      orderBy: [{ createdAt: "desc" }],
    });

    const desired = new Map<
      string,
      {
        kind: ContentSubscriptionKind;
        normalizedValue: string;
        displayValue: string;
      }
    >();
    for (const row of rows) {
      for (const topic of parseStringArray(
        row.approvedTopics,
        MAX_APPROVED_SUGGESTIONS,
      )) {
        const normalizedValue = normalizeTerm(topic);
        if (!normalizedValue) {
          continue;
        }
        desired.set(
          this.subscriptionKey(ContentSubscriptionKind.topic, normalizedValue),
          {
            kind: ContentSubscriptionKind.topic,
            normalizedValue,
            displayValue: normalizeDisplayValue(topic),
          },
        );
      }
      for (const entity of parseStringArray(
        row.approvedEntities,
        MAX_APPROVED_SUGGESTIONS,
      )) {
        const normalizedValue = normalizeTerm(entity);
        if (!normalizedValue) {
          continue;
        }
        desired.set(
          this.subscriptionKey(ContentSubscriptionKind.entity, normalizedValue),
          {
            kind: ContentSubscriptionKind.entity,
            normalizedValue,
            displayValue: normalizeDisplayValue(entity),
          },
        );
      }
    }

    const existing = await this.prisma.userContentSubscription.findMany({
      where: { orgId, userId },
    });

    for (const entry of desired.values()) {
      const row = existing.find(
        (candidate) =>
          candidate.kind === entry.kind &&
          candidate.normalizedValue === entry.normalizedValue,
      );
      if (row) {
        continue;
      }
      await this.prisma.userContentSubscription.create({
        data: {
          orgId,
          userId,
          kind: entry.kind,
          normalizedValue: entry.normalizedValue,
          displayValue: entry.displayValue,
          source: ContentSubscriptionSource.manual,
          metadata: toPrismaJsonValue({
            managedBySituationMonitor: true,
          }),
        },
      });
    }

    const managedRows = existing.filter(
      (row) => parseRecord(row.metadata)?.managedBySituationMonitor === true,
    );
    if (managedRows.length > 0) {
      const deleteIds = managedRows
        .filter(
          (row) =>
            !desired.has(this.subscriptionKey(row.kind, row.normalizedValue)),
        )
        .map((row) => row.id);
      if (deleteIds.length > 0) {
        await this.prisma.userContentSubscription.deleteMany({
          where: { orgId, userId, id: { in: deleteIds } },
        });
      }
    }
  }

  private async syncSystemMonitorFromSubscriptions(
    orgId: string,
    userId: string,
  ): Promise<void> {
    const [subscriptions, manualRows, existing] = await Promise.all([
      this.prisma.userContentSubscription.findMany({
        where: { orgId, userId },
        orderBy: [{ updatedAt: "desc" }],
      }),
      this.prisma.situationMonitorMonitor.findMany({
        where: { orgId, userId, kind: SituationMonitorMonitorKind.manual },
      }),
      this.prisma.situationMonitorMonitor.findFirst({
        where: { orgId, userId, kind: SituationMonitorMonitorKind.system_sync },
      }),
    ]);

    const manualOwned = new Set<string>();
    for (const row of manualRows) {
      for (const topic of parseStringArray(
        row.approvedTopics,
        MAX_APPROVED_SUGGESTIONS,
      )) {
        const normalized = normalizeTerm(topic);
        if (normalized) {
          manualOwned.add(
            this.subscriptionKey(ContentSubscriptionKind.topic, normalized),
          );
        }
      }
      for (const entity of parseStringArray(
        row.approvedEntities,
        MAX_APPROVED_SUGGESTIONS,
      )) {
        const normalized = normalizeTerm(entity);
        if (normalized) {
          manualOwned.add(
            this.subscriptionKey(ContentSubscriptionKind.entity, normalized),
          );
        }
      }
    }

    const orphanTopics = subscriptions
      .filter((row) => row.kind === ContentSubscriptionKind.topic)
      .filter(
        (row) =>
          !manualOwned.has(this.subscriptionKey(row.kind, row.normalizedValue)),
      )
      .map((row) => row.displayValue);
    const orphanEntities = subscriptions
      .filter((row) => row.kind === ContentSubscriptionKind.entity)
      .filter(
        (row) =>
          !manualOwned.has(this.subscriptionKey(row.kind, row.normalizedValue)),
      )
      .map((row) => row.displayValue);

    const approvedTopics = normalizeStringList(
      orphanTopics,
      MAX_APPROVED_SUGGESTIONS,
    );
    const approvedEntities = normalizeStringList(
      orphanEntities,
      MAX_APPROVED_SUGGESTIONS,
    );
    const approvedLexicalTerms = normalizeStringList(
      orphanTopics.concat(orphanEntities),
      MAX_APPROVED_TERMS,
    );
    const embeddingPayload = await this.buildQueryEmbedding(
      orgId,
      this.buildQueryText({
        name: SYSTEM_SYNC_MONITOR_NAME,
        rawKeywords: [],
        approvedTopics,
        approvedEntities,
        approvedLexicalTerms,
      }),
    );

    const data = {
      name: SYSTEM_SYNC_MONITOR_NAME,
      enabled: true,
      color: SYSTEM_SYNC_MONITOR_COLOR,
      rawKeywords: toPrismaJsonValue([]),
      approvedTopics: toPrismaJsonValue(approvedTopics),
      approvedEntities: toPrismaJsonValue(approvedEntities),
      approvedLexicalTerms: toPrismaJsonValue(approvedLexicalTerms),
      rejectedSuggestions: toPrismaJsonValue({
        topics: [],
        entities: [],
        lexicalTerms: [],
      }),
      locationName: null,
      locationLat: null,
      locationLng: null,
      locationBounds: Prisma.JsonNull,
      locationCountryCode: null,
      queryEmbeddingModel: embeddingPayload.model,
      queryEmbeddingVector: embeddingPayload.vector
        ? toPrismaJsonValue(embeddingPayload.vector)
        : Prisma.JsonNull,
      lastResolvedAt: new Date(),
    };

    if (existing) {
      await this.prisma.situationMonitorMonitor.update({
        where: { id: existing.id },
        data,
      });
      return;
    }

    await this.prisma.situationMonitorMonitor.create({
      data: {
        orgId,
        userId,
        kind: SituationMonitorMonitorKind.system_sync,
        ...data,
      },
    });
  }

  private async ensureLegacyMigration(
    orgId: string,
    userId: string,
  ): Promise<void> {
    const existingCount = await this.prisma.situationMonitorMonitor.count({
      where: { orgId, userId },
    });
    if (existingCount > 0) {
      return;
    }

    const legacy = await this.prisma.userSetting.findUnique({
      where: {
        orgId_userId_key: {
          orgId,
          userId,
          key: LEGACY_MONITORS_USER_SETTING_KEY,
        },
      },
    });

    const entries = Array.isArray(legacy?.value) ? legacy?.value : [];
    for (const entry of entries.slice(0, MAX_MANUAL_MONITORS)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const name = normalizeName(record.name);
      const rawKeywords = normalizeKeywordList(
        Array.isArray(record.keywords) ? (record.keywords as string[]) : [],
      );
      if (!name || rawKeywords.length === 0) {
        continue;
      }
      const location = normalizeLegacyLocation(record.location);
      const embeddingPayload = await this.buildQueryEmbedding(
        orgId,
        this.buildQueryText({
          name,
          rawKeywords,
          approvedTopics: [],
          approvedEntities: [],
          approvedLexicalTerms: rawKeywords,
          location,
        }),
      );
      await this.prisma.situationMonitorMonitor.create({
        data: {
          orgId,
          userId,
          kind: SituationMonitorMonitorKind.manual,
          name,
          enabled: record.enabled !== false,
          color: normalizeColor(record.color),
          rawKeywords: toPrismaJsonValue(rawKeywords),
          approvedTopics: toPrismaJsonValue([]),
          approvedEntities: toPrismaJsonValue([]),
          approvedLexicalTerms: toPrismaJsonValue(rawKeywords),
          rejectedSuggestions: toPrismaJsonValue({
            topics: [],
            entities: [],
            lexicalTerms: [],
          }),
          locationName: location?.name ?? null,
          locationLat: location?.lat ?? null,
          locationLng: location?.lng ?? null,
          locationBounds: location?.bounds
            ? toPrismaJsonValue(location.bounds)
            : Prisma.JsonNull,
          locationCountryCode: location?.countryCodeAlpha2 ?? null,
          queryEmbeddingModel: embeddingPayload.model,
          queryEmbeddingVector: embeddingPayload.vector
            ? toPrismaJsonValue(embeddingPayload.vector)
            : Prisma.JsonNull,
          lastResolvedAt: new Date(),
          createdAt:
            typeof record.createdAt === "number"
              ? new Date(record.createdAt)
              : new Date(),
        },
      });
    }

    await this.syncSystemMonitorFromSubscriptions(orgId, userId);
  }

  private async loadMonitorRows(orgId: string, userId: string) {
    await this.ensureLegacyMigration(orgId, userId);
    return this.prisma.situationMonitorMonitor.findMany({
      where: { orgId, userId },
      orderBy: [{ kind: "asc" }, { createdAt: "desc" }],
    });
  }

  private normalizeMonitorRow(
    row: Prisma.SituationMonitorMonitorGetPayload<Record<string, never>>,
  ): NormalizedMonitorRecord {
    return {
      id: row.id,
      kind:
        row.kind === SituationMonitorMonitorKind.system_sync
          ? "system_sync"
          : "manual",
      name: normalizeName(row.name),
      enabled: row.enabled,
      color: normalizeColor(row.color),
      rawKeywords: parseStringArray(row.rawKeywords, MAX_KEYWORDS),
      approvedTopics: parseStringArray(
        row.approvedTopics,
        MAX_APPROVED_SUGGESTIONS,
      ),
      approvedEntities: parseStringArray(
        row.approvedEntities,
        MAX_APPROVED_SUGGESTIONS,
      ),
      approvedLexicalTerms: parseStringArray(
        row.approvedLexicalTerms,
        MAX_APPROVED_TERMS,
      ),
      rejectedSuggestions: parseRejectedSuggestions(row.rejectedSuggestions),
      location: parseLocation(row),
      queryEmbeddingModel: normalizeOptionalString(row.queryEmbeddingModel),
      queryEmbeddingVector:
        parseNumberArray(row.queryEmbeddingVector) ?? undefined,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private mapRow(
    row: Prisma.SituationMonitorMonitorGetPayload<Record<string, never>>,
  ): StoredMonitorDto {
    const normalized = this.normalizeMonitorRow(row);
    return {
      ...normalized,
      ...(normalized.color ? { color: normalized.color } : {}),
      ...(normalized.location ? { location: normalized.location } : {}),
      ...(normalized.queryEmbeddingModel
        ? { queryEmbeddingModel: normalized.queryEmbeddingModel }
        : {}),
      ...(row.lastResolvedAt
        ? { lastResolvedAt: row.lastResolvedAt.toISOString() }
        : {}),
    };
  }

  private async buildPersistedMonitorPayload(
    orgId: string,
    input: {
      name: string;
      rawKeywords: string[];
      approvedTopics?: string[];
      approvedEntities?: string[];
      approvedLexicalTerms?: string[];
      rejectedTopics?: string[];
      rejectedEntities?: string[];
      rejectedLexicalTerms?: string[];
      color?: string;
      location?: {
        name: string;
        lat?: number;
        lng?: number;
        countryCodeAlpha2?: string;
      };
      enabled?: boolean;
    },
    kind: "manual" | "system_sync",
  ) {
    const name = normalizeName(input.name);
    const rawKeywords = normalizeKeywordList(input.rawKeywords);
    const approvedTopics = normalizeStringList(
      input.approvedTopics ?? [],
      MAX_APPROVED_SUGGESTIONS,
    );
    const approvedEntities = normalizeStringList(
      input.approvedEntities ?? [],
      MAX_APPROVED_SUGGESTIONS,
    );
    const approvedLexicalTerms = normalizeStringList(
      input.approvedLexicalTerms ?? rawKeywords,
      MAX_APPROVED_TERMS,
    );
    const rejectedSuggestions = normalizeRejectedSuggestions({
      rejectedTopics: input.rejectedTopics,
      rejectedEntities: input.rejectedEntities,
      rejectedLexicalTerms: input.rejectedLexicalTerms,
    });
    const color = normalizeColor(input.color);
    const location = await this.resolveLocationInput(input.location);

    if (!name) {
      throw new BadRequestException("Monitor name is required");
    }
    if (kind === "manual" && rawKeywords.length === 0) {
      throw new BadRequestException("At least one keyword is required");
    }

    const embeddingPayload = await this.buildQueryEmbedding(
      orgId,
      this.buildQueryText({
        name,
        rawKeywords,
        approvedTopics,
        approvedEntities,
        approvedLexicalTerms,
        location: location ?? undefined,
      }),
    );

    return {
      name,
      enabled: input.enabled ?? true,
      color: color ?? null,
      rawKeywords: toPrismaJsonValue(rawKeywords),
      approvedTopics: toPrismaJsonValue(approvedTopics),
      approvedEntities: toPrismaJsonValue(approvedEntities),
      approvedLexicalTerms: toPrismaJsonValue(approvedLexicalTerms),
      rejectedSuggestions: toPrismaJsonValue(rejectedSuggestions),
      locationName: location?.name ?? null,
      locationLat: location?.lat ?? null,
      locationLng: location?.lng ?? null,
      locationBounds: location?.bounds
        ? toPrismaJsonValue(location.bounds)
        : Prisma.JsonNull,
      locationCountryCode: location?.countryCodeAlpha2 ?? null,
      queryEmbeddingModel: embeddingPayload.model,
      queryEmbeddingVector: embeddingPayload.vector
        ? toPrismaJsonValue(embeddingPayload.vector)
        : Prisma.JsonNull,
      lastResolvedAt: new Date(),
    };
  }

  private async buildQueryEmbedding(
    orgId: string,
    queryText: string,
  ): Promise<{ model: string | null; vector: number[] | null }> {
    if (!queryText.trim()) {
      return { model: null, vector: null };
    }
    try {
      const response = await this.liteLlm.embedding({
        orgId,
        input: queryText,
        metadata: {
          feature: "situation_monitor_monitors",
          source: "situation-monitor-monitors",
          stage: "monitor-query-embedding",
        },
      });
      const vector = response.data?.[0]?.embedding;
      return {
        model: normalizeOptionalString(response.model) ?? null,
        vector:
          Array.isArray(vector) && vector.length > 0
            ? normalizeVector(vector)
            : null,
      };
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to build monitor query embedding",
      );
      return { model: null, vector: null };
    }
  }

  private buildQueryText(input: {
    name: string;
    rawKeywords: string[];
    approvedTopics: string[];
    approvedEntities: string[];
    approvedLexicalTerms: string[];
    location?: MonitorLocation;
  }) {
    return [
      `name=${input.name}`,
      input.rawKeywords.length > 0
        ? `keywords=${input.rawKeywords.join(", ")}`
        : "",
      input.approvedTopics.length > 0
        ? `topics=${input.approvedTopics.join(", ")}`
        : "",
      input.approvedEntities.length > 0
        ? `entities=${input.approvedEntities.join(", ")}`
        : "",
      input.approvedLexicalTerms.length > 0
        ? `lexical=${input.approvedLexicalTerms.join(", ")}`
        : "",
      input.location?.name ? `location=${input.location.name}` : "",
      input.location?.countryCodeAlpha2
        ? `country=${getCountryName(input.location.countryCodeAlpha2) ?? input.location.countryCodeAlpha2}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async loadTaxonomyDisplayNames(
    orgId: string,
  ): Promise<Map<string, string>> {
    try {
      const settings = await this.classificationSettings.getSettings(orgId);
      return new Map(
        (settings.taxonomy ?? [])
          .filter((node) => node.path.trim().length > 0)
          .map((node) => [node.path, node.displayName]),
      );
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to load taxonomy display names for monitor preview",
      );
      return new Map();
    }
  }

  private taxonomyDisplayName(
    taxonomyPath: string | null,
    taxonomyDisplayNames: Map<string, string>,
  ): string | null {
    if (!taxonomyPath) {
      return null;
    }
    return taxonomyDisplayNames.get(taxonomyPath) ?? taxonomyPath;
  }

  private collectPreviewMatchedTerms(
    displayValue: string,
    normalizedValue: string,
    name: string,
    rawKeywords: string[],
  ): string[] {
    const haystack = `${normalizeTerm(displayValue)} ${normalizedValue}`;
    const matched = new Map<string, string>();
    const terms = [name, ...rawKeywords]
      .map((entry) => normalizeDisplayValue(entry))
      .filter(Boolean);

    for (const term of terms) {
      const normalizedTerm = normalizeTerm(term);
      if (
        normalizedTerm &&
        (haystack.includes(normalizedTerm) ||
          normalizedTerm.includes(normalizedValue))
      ) {
        matched.set(normalizedTerm, term);
        continue;
      }

      for (const token of normalizedTerm.split(
        /[^a-z0-9\u00c0-\u024f\u4e00-\u9fff]+/i,
      )) {
        if (token.length < 3 || !haystack.includes(token)) {
          continue;
        }
        matched.set(token, term);
        break;
      }

      if (matched.size >= 4) {
        break;
      }
    }

    return Array.from(matched.values()).slice(0, 4);
  }

  private async resolveLocationInput(
    input?: {
      name: string;
      lat?: number;
      lng?: number;
      countryCodeAlpha2?: string;
    } | null,
  ): Promise<MonitorLocation | undefined> {
    if (!input) {
      return undefined;
    }
    const name = normalizeName(input.name);
    if (!name) {
      return undefined;
    }

    const countryCodeAlpha2 = normalizeCountryAlpha2(
      input.countryCodeAlpha2 ?? extractCountryCodeFromText(name) ?? undefined,
    );

    const geocoded = await this.geocoding.geocode(name, {
      ...(countryCodeAlpha2 ? { countryCodeAlpha2 } : {}),
    });

    const lat =
      typeof input.lat === "number" ? input.lat : (geocoded?.lat ?? Number.NaN);
    const lng =
      typeof input.lng === "number" ? input.lng : (geocoded?.lng ?? Number.NaN);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return undefined;
    }

    return {
      name,
      lat,
      lng,
      ...(geocoded?.bounds ? { bounds: geocoded.bounds } : {}),
      ...(geocoded?.countryCodeAlpha2 || countryCodeAlpha2
        ? {
            countryCodeAlpha2: geocoded?.countryCodeAlpha2 ?? countryCodeAlpha2,
          }
        : {}),
    };
  }

  private async rankCatalogRowsByEmbedding(
    orgId: string,
    queryText: string,
    rows: CatalogRow[],
  ): Promise<Array<{ row: CatalogRow; score: number }> & { model?: string }> {
    try {
      const response = await this.liteLlm.embedding({
        orgId,
        input: queryText,
        metadata: {
          feature: "situation_monitor_monitors",
          source: "situation-monitor-monitors",
          stage: "preview-query",
        },
      });
      const vector = response.data?.[0]?.embedding;
      const normalized = Array.isArray(vector) ? normalizeVector(vector) : [];
      if (normalized.length === 0) {
        return [] as Array<{ row: CatalogRow; score: number }> & {
          model?: string;
        };
      }
      const ranked = rows
        .map((row) => {
          const candidate = parseNumberArray(row.embeddingVector);
          if (!candidate || candidate.length !== normalized.length) {
            return null;
          }
          return { row, score: dot(normalized, candidate) };
        })
        .filter((entry): entry is { row: CatalogRow; score: number } =>
          Boolean(entry),
        )
        .sort((a, b) => b.score - a.score || b.row.count - a.row.count)
        .slice(0, 16) as Array<{ row: CatalogRow; score: number }> & {
        model?: string;
      };
      ranked.model = normalizeOptionalString(response.model) ?? undefined;
      return ranked;
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to rank preview catalog by embedding",
      );
      return [] as Array<{ row: CatalogRow; score: number }> & {
        model?: string;
      };
    }
  }

  private async tryRerankCatalogRows(
    orgId: string,
    queryText: string,
    rows: Array<{ row: CatalogRow; score: number }>,
  ) {
    if (rows.length === 0) {
      return [] as Array<{ row: CatalogRow; score: number }>;
    }
    try {
      const response = await this.liteLlm.rerank({
        orgId,
        query: queryText,
        documents: rows.map(({ row }) =>
          [
            `kind=${row.kind}`,
            `name=${row.displayValue}`,
            row.taxonomyPath ? `taxonomy=${row.taxonomyPath}` : "",
            `count=${row.count}`,
          ]
            .filter(Boolean)
            .join("\n"),
        ),
        topN: rows.length,
        metadata: {
          feature: "situation_monitor_monitors",
          source: "situation-monitor-monitors",
          stage: "preview-rerank",
        },
      });
      const scored = (response.results ?? [])
        .map((entry) => {
          const row = rows[entry.index];
          if (
            !row ||
            typeof entry.score !== "number" ||
            !Number.isFinite(entry.score)
          ) {
            return null;
          }
          return { row: row.row, score: entry.score };
        })
        .filter((entry): entry is { row: CatalogRow; score: number } =>
          Boolean(entry),
        );
      if (scored.length === 0) {
        return [];
      }
      const min = Math.min(...scored.map((entry) => entry.score));
      const max = Math.max(...scored.map((entry) => entry.score));
      return scored
        .map((entry) => ({
          row: entry.row,
          score: max === min ? 1 : (entry.score - min) / (max - min),
        }))
        .sort((a, b) => b.score - a.score || b.row.count - a.row.count);
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to rerank preview catalog rows",
      );
      return [];
    }
  }

  private lexicalCatalogScore(
    displayValue: string,
    normalizedValue: string,
    name: string,
    rawKeywords: string[],
  ) {
    const tokens = [name, ...rawKeywords]
      .map((entry) => normalizeTerm(entry))
      .filter(Boolean);
    if (tokens.length === 0) {
      return 0;
    }
    const haystack = `${normalizeTerm(displayValue)} ${normalizedValue}`;
    let score = 0;
    for (const token of tokens) {
      if (!token) {
        continue;
      }
      if (haystack.includes(token)) {
        score += token.length > 4 ? 0.35 : 0.2;
      }
    }
    return clamp01(score);
  }

  private buildLexicalPreviewSuggestions(options: {
    rawKeywords: string[];
    topicSuggestions: PreviewSuggestion[];
    entitySuggestions: PreviewSuggestion[];
    rejectedLexicalTerms: string[];
  }): PreviewSuggestion[] {
    const terms = new Map<string, PreviewSuggestion>();
    for (const keyword of options.rawKeywords) {
      const normalizedValue = normalizeTerm(keyword);
      if (!normalizedValue) {
        continue;
      }
      terms.set(normalizedValue, {
        value: keyword,
        normalizedValue,
        displayValue: normalizeDisplayValue(keyword),
        reason: "lexical",
        score: 1,
        matchedTerms: [normalizeDisplayValue(keyword)],
      });
    }
    for (const suggestion of options.topicSuggestions.concat(
      options.entitySuggestions,
    )) {
      if (terms.has(suggestion.normalizedValue)) {
        continue;
      }
      if (options.rejectedLexicalTerms.includes(suggestion.normalizedValue)) {
        continue;
      }
      terms.set(suggestion.normalizedValue, {
        value: suggestion.displayValue,
        normalizedValue: suggestion.normalizedValue,
        displayValue: suggestion.displayValue,
        reason: suggestion.reason,
        score: suggestion.score,
        matchedTerms: suggestion.matchedTerms,
        taxonomyPath: suggestion.taxonomyPath,
        taxonomyDisplayName: suggestion.taxonomyDisplayName,
      });
      if (terms.size >= PREVIEW_SUGGESTION_LIMIT + options.rawKeywords.length) {
        break;
      }
    }
    return Array.from(terms.values()).slice(
      0,
      PREVIEW_SUGGESTION_LIMIT + options.rawKeywords.length,
    );
  }

  private itemKey(itemMetaId?: string, link?: string, title?: string) {
    if (itemMetaId?.trim()) {
      return `id:${itemMetaId.trim()}`;
    }
    return `link:${(link ?? "").trim()}::${(title ?? "").trim()}`;
  }

  private candidateEmbeddingText(candidate: MonitorCandidate) {
    return [
      `title=${candidate.title}`,
      candidate.summary ? `summary=${candidate.summary}` : "",
      candidate.topics.length > 0
        ? `topics=${candidate.topics.join(", ")}`
        : "",
      candidate.entities.length > 0
        ? `entities=${candidate.entities.join(", ")}`
        : "",
      candidate.location ? `location=${candidate.location}` : "",
      candidate.extraTexts.length > 0
        ? `extra=${candidate.extraTexts.join(" | ")}`
        : "",
      `source=${candidate.source}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private telegramCandidate(item: TelegramSignalItem): MonitorCandidate {
    return {
      itemKey: `telegram:${item.id}`,
      itemType: "telegram",
      title: item.text.slice(0, 120) || item.channelTitle,
      summary: item.text,
      link: item.url,
      source: item.channelTitle,
      timestamp: Date.parse(item.ts) || Date.now(),
      category: item.topic,
      topics: item.topic ? [item.topic] : [],
      entities: [],
      extraTexts: item.tags ?? [],
    };
  }

  private orefAlertCandidate(
    alert: OrefAlert,
    itemType: "oref_alert" | "oref_history",
  ): MonitorCandidate {
    const areas = Array.isArray(alert.data) ? alert.data : [];
    return {
      itemKey: `oref:${alert.id}`,
      itemType,
      title: alert.title,
      summary: alert.desc,
      link: "",
      source: alert.cat || "oref",
      timestamp: Date.parse(alert.alertDate) || Date.now(),
      category: alert.cat,
      topics: [],
      entities: [],
      extraTexts: areas,
    };
  }

  private orefHistoryCandidate(
    alert: OrefAlert,
    entry: OrefHistoryEntry,
  ): MonitorCandidate {
    const candidate = this.orefAlertCandidate(alert, "oref_history");
    candidate.timestamp = Date.parse(entry.timestamp) || candidate.timestamp;
    candidate.itemKey = `oref-history:${entry.timestamp}:${alert.id}`;
    return candidate;
  }

  private subscriptionKey(
    kind: ContentSubscriptionKind,
    normalizedValue: string,
  ) {
    return `${kind}:${normalizedValue}`;
  }

  private locationToInput(
    row: Prisma.SituationMonitorMonitorGetPayload<Record<string, never>>,
  ) {
    if (
      !row.locationName ||
      typeof row.locationLat !== "number" ||
      typeof row.locationLng !== "number"
    ) {
      return undefined;
    }
    return {
      name: row.locationName,
      lat: row.locationLat,
      lng: row.locationLng,
      countryCodeAlpha2: row.locationCountryCode ?? undefined,
    };
  }
}

function normalizeName(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 64) : "";
}

function normalizeDisplayValue(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 128);
}

function normalizeTerm(value: string): string {
  return normalizeDisplayValue(value).toLowerCase();
}

function normalizeStringList(values: string[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of values) {
    const displayValue = normalizeDisplayValue(entry);
    const normalized = displayValue.toLowerCase();
    if (!displayValue || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(displayValue);
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}

function normalizeKeywordList(values: string[]): string[] {
  const split = values.flatMap((entry) =>
    typeof entry === "string" ? entry.split(",") : [],
  );
  return normalizeStringList(split, MAX_KEYWORDS);
}

function normalizeColor(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  if (
    /^#[0-9a-fA-F]{6}$/.test(normalized) ||
    /^#[0-9a-fA-F]{3}$/.test(normalized)
  ) {
    return normalized.toLowerCase();
  }
  return undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseStringArray(
  value: Prisma.JsonValue | null,
  limit: number,
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return normalizeStringList(
    value.filter((entry): entry is string => typeof entry === "string"),
    limit,
  );
}

function parseNumberArray(value: Prisma.JsonValue | null): number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const numbers = value
    .map((entry) =>
      typeof entry === "number" && Number.isFinite(entry) ? entry : Number.NaN,
    )
    .filter((entry) => Number.isFinite(entry));
  return numbers.length > 0 ? numbers : null;
}

function parseRecord(
  value: Prisma.JsonValue | null,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseRejectedSuggestions(
  value: Prisma.JsonValue | null,
): RejectedSuggestionState {
  const record = parseRecord(value);
  return {
    topics: normalizeStringList(
      Array.isArray(record?.topics)
        ? record.topics.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [],
      MAX_APPROVED_SUGGESTIONS,
    ).map((entry) => entry.toLowerCase()),
    entities: normalizeStringList(
      Array.isArray(record?.entities)
        ? record.entities.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [],
      MAX_APPROVED_SUGGESTIONS,
    ).map((entry) => entry.toLowerCase()),
    lexicalTerms: normalizeStringList(
      Array.isArray(record?.lexicalTerms)
        ? record.lexicalTerms.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [],
      MAX_APPROVED_TERMS,
    ).map((entry) => entry.toLowerCase()),
  };
}

function normalizeRejectedSuggestions(input: {
  rejectedTopics?: string[];
  rejectedEntities?: string[];
  rejectedLexicalTerms?: string[];
}): RejectedSuggestionState {
  return {
    topics: normalizeStringList(
      input.rejectedTopics ?? [],
      MAX_APPROVED_SUGGESTIONS,
    ).map((entry) => entry.toLowerCase()),
    entities: normalizeStringList(
      input.rejectedEntities ?? [],
      MAX_APPROVED_SUGGESTIONS,
    ).map((entry) => entry.toLowerCase()),
    lexicalTerms: normalizeStringList(
      input.rejectedLexicalTerms ?? [],
      MAX_APPROVED_TERMS,
    ).map((entry) => entry.toLowerCase()),
  };
}

function parseLocation(
  row: Prisma.SituationMonitorMonitorGetPayload<Record<string, never>>,
): MonitorLocation | undefined {
  if (
    !row.locationName ||
    typeof row.locationLat !== "number" ||
    typeof row.locationLng !== "number"
  ) {
    return undefined;
  }
  const bounds = parseBounds(row.locationBounds);
  return {
    name: row.locationName,
    lat: row.locationLat,
    lng: row.locationLng,
    ...(bounds ? { bounds } : {}),
    ...(normalizeCountryAlpha2(row.locationCountryCode)
      ? { countryCodeAlpha2: normalizeCountryAlpha2(row.locationCountryCode) }
      : {}),
  };
}

function parseBounds(
  value: Prisma.JsonValue | null,
): GeocodeBounds | undefined {
  const record = parseRecord(value);
  const minLat =
    typeof record?.minLat === "number" ? record.minLat : Number.NaN;
  const maxLat =
    typeof record?.maxLat === "number" ? record.maxLat : Number.NaN;
  const minLng =
    typeof record?.minLng === "number" ? record.minLng : Number.NaN;
  const maxLng =
    typeof record?.maxLng === "number" ? record.maxLng : Number.NaN;
  if (
    !Number.isFinite(minLat) ||
    !Number.isFinite(maxLat) ||
    !Number.isFinite(minLng) ||
    !Number.isFinite(maxLng)
  ) {
    return undefined;
  }
  return { minLat, maxLat, minLng, maxLng };
}

function normalizeCountryAlpha2(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalizedCountry = normalizeCountryCode(value);
  if (!normalizedCountry) {
    return undefined;
  }
  return getCountryAlpha2(normalizedCountry) ?? normalizedCountry;
}

function normalizeLegacyLocation(value: unknown): MonitorLocation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const name = normalizeName(record.name);
  const lat = typeof record.lat === "number" ? record.lat : Number.NaN;
  const lng = typeof record.lng === "number" ? record.lng : Number.NaN;
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return undefined;
  }
  return {
    name,
    lat,
    lng,
    ...(normalizeCountryAlpha2(name)
      ? { countryCodeAlpha2: normalizeCountryAlpha2(name) }
      : {}),
  };
}

function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(
    vector.reduce((sum, value) => sum + value * value, 0),
  );
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    return vector;
  }
  return vector.map((value) => value / magnitude);
}

function dot(left: number[], right: number[]): number {
  let total = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    total += left[index]! * right[index]!;
  }
  return total;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function buildHaystack(candidate: MonitorCandidate): string {
  return [
    candidate.title,
    candidate.titleZh ?? "",
    candidate.summary ?? "",
    candidate.summaryZh ?? "",
    candidate.source,
    candidate.location ?? "",
    candidate.category ?? "",
    ...candidate.topics,
    ...candidate.entities,
    ...candidate.extraTexts,
  ]
    .join(" ")
    .toLowerCase();
}

function collectLexicalHits(terms: string[], haystack: string): string[] {
  const normalizedTerms = normalizeStringList(terms, MAX_APPROVED_TERMS);
  const hits: string[] = [];
  for (const display of normalizedTerms) {
    const normalized = display.toLowerCase();
    const shortAscii = normalized.length <= 3 && /^[a-z0-9]+$/.test(normalized);
    const matched = shortAscii
      ? new RegExp(`\\b${escapeRegExp(normalized)}\\b`).test(haystack)
      : haystack.includes(normalized);
    if (!matched) {
      continue;
    }
    hits.push(display);
    if (hits.length >= 6) {
      break;
    }
  }
  return hits;
}

function collectSetHits(expected: string[], values: string[]): string[] {
  const haystack = values.map((entry) => normalizeTerm(entry)).filter(Boolean);
  const hits: string[] = [];
  for (const entry of normalizeStringList(expected, MAX_APPROVED_TERMS)) {
    const normalized = normalizeTerm(entry);
    if (!normalized) {
      continue;
    }
    if (
      haystack.some(
        (value) => value === normalized || value.includes(normalized),
      )
    ) {
      hits.push(entry);
      if (hits.length >= 6) {
        break;
      }
    }
  }
  return hits;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function upsertOwnershipEntry(
  map: Map<string, OwnershipEntry>,
  key: string,
  ownerMonitorId: string,
  ownerMonitorName: string,
  kind: SituationMonitorMonitorKind,
) {
  const current = map.get(key) ?? {
    ownerMonitorIds: [],
    ownerMonitorNames: [],
    manualMonitorOwned: false,
    systemSyncOwned: false,
  };
  if (!current.ownerMonitorIds.includes(ownerMonitorId)) {
    current.ownerMonitorIds.push(ownerMonitorId);
  }
  if (!current.ownerMonitorNames.includes(ownerMonitorName)) {
    current.ownerMonitorNames.push(ownerMonitorName);
  }
  if (kind === SituationMonitorMonitorKind.system_sync) {
    current.systemSyncOwned = true;
  } else {
    current.manualMonitorOwned = true;
  }
  map.set(key, current);
}
