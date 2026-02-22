import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

export type NewsLegacyCategory =
  | "politics"
  | "tech"
  | "finance"
  | "gov"
  | "ai"
  | "intel";

export interface NewsClassificationTaxonomyNode {
  path: string;
  displayName: string;
  description: string;
  legacyCategory: NewsLegacyCategory;
  keywords: string[];
  synonyms: string[];
}

export interface NewsClassificationSettings {
  enabled: boolean;
  strictFail: boolean;
  enableLlm: boolean;
  enableEmbedding: boolean;
  enableRerank: boolean;
  llmModel: string | null;
  minConfidence: number;
  embeddingTopK: number;
  rerankTopN: number;
  cacheTtlSeconds: number;
  taxonomyVersion: string;
  taxonomy: NewsClassificationTaxonomyNode[];
}

export interface NewsClassificationSettingsInput {
  enabled?: boolean;
  strictFail?: boolean;
  enableLlm?: boolean;
  enableEmbedding?: boolean;
  enableRerank?: boolean;
  llmModel?: string | null;
  minConfidence?: number;
  embeddingTopK?: number;
  rerankTopN?: number;
  cacheTtlSeconds?: number;
  taxonomyVersion?: string | null;
  taxonomy?: NewsClassificationTaxonomyNode[];
}

const SETTINGS_CACHE_TTL_SECONDS = 60;
const CACHE_KEY_PREFIX = "newsClassification:settings:";
const SYSTEM_SETTING_KEY_PREFIX = "news_classification_settings:";

const MAX_TAXONOMY_NODES = 512;
const MAX_TAXONOMY_PATH_LENGTH = 160;
const MAX_TAXONOMY_TEXT_LENGTH = 500;
const MAX_LIST_SIZE = 50;
const MAX_LIST_ITEM_LENGTH = 80;
const MIN_TOP_K = 1;
const MAX_TOP_K = 100;
const MIN_TOP_N = 1;
const MAX_TOP_N = 30;
const MIN_CONFIDENCE = 0;
const MAX_CONFIDENCE = 1;
const MIN_CACHE_TTL_SECONDS = 0;
const MAX_CACHE_TTL_SECONDS = 3600;

const DEFAULT_TAXONOMY_VERSION = "news-taxonomy-v1";

const DEFAULT_TAXONOMY: NewsClassificationTaxonomyNode[] = [
  {
    path: "tech/ai/model-release",
    displayName: "AI Model Release",
    description:
      "Announcements, launches, benchmarks, pricing, or capability updates for AI/LLM models.",
    legacyCategory: "ai",
    keywords: ["model", "release", "llm", "gpt", "benchmark", "inference"],
    synonyms: ["model launch", "foundation model", "large language model"],
  },
  {
    path: "tech/ai/policy-governance",
    displayName: "AI Policy",
    description:
      "Regulatory or governance developments specifically focused on AI deployment and safety.",
    legacyCategory: "gov",
    keywords: ["ai act", "regulation", "safety", "governance", "compliance"],
    synonyms: ["ai regulation", "ai policy"],
  },
  {
    path: "tech/cyber/security-incident",
    displayName: "Cyber Incident",
    description:
      "Cybersecurity breaches, ransomware, malware campaigns, data leaks, and incident response.",
    legacyCategory: "intel",
    keywords: ["breach", "ransomware", "malware", "vulnerability", "exploit"],
    synonyms: ["cyber attack", "security incident", "data breach"],
  },
  {
    path: "tech/semiconductor/supply-chain",
    displayName: "Semiconductor Supply Chain",
    description:
      "Chip manufacturing capacity, export controls, fab expansion, and upstream/downstream impacts.",
    legacyCategory: "tech",
    keywords: ["semiconductor", "chip", "foundry", "fab", "export control"],
    synonyms: ["chip supply chain", "semiconductor policy"],
  },
  {
    path: "finance/markets/equities",
    displayName: "Equity Markets",
    description:
      "Stock market moves, earnings reactions, analyst actions, and equity volatility events.",
    legacyCategory: "finance",
    keywords: ["stock", "equity", "earnings", "nasdaq", "dow", "s&p"],
    synonyms: ["equity market", "stock market"],
  },
  {
    path: "finance/macro/monetary-policy",
    displayName: "Monetary Policy",
    description:
      "Central bank decisions, rate guidance, inflation indicators, and macro policy interpretation.",
    legacyCategory: "finance",
    keywords: ["fed", "fomc", "rate", "inflation", "cpi", "yield"],
    synonyms: ["interest rate policy", "central bank policy"],
  },
  {
    path: "finance/crypto/market-move",
    displayName: "Crypto Market Move",
    description:
      "Major cryptocurrency price shocks, market structure events, and policy-driven crypto repricing.",
    legacyCategory: "finance",
    keywords: ["bitcoin", "ethereum", "crypto", "token", "exchange"],
    synonyms: ["digital asset", "crypto market"],
  },
  {
    path: "gov/regulation/enforcement",
    displayName: "Regulatory Enforcement",
    description:
      "Government enforcement actions, investigations, penalties, and compliance mandates.",
    legacyCategory: "gov",
    keywords: ["sec", "doj", "investigation", "penalty", "enforcement"],
    synonyms: ["regulatory action", "compliance enforcement"],
  },
  {
    path: "politics/geopolitics/conflict",
    displayName: "Geopolitical Conflict",
    description:
      "Armed conflict developments, sanctions escalation, ceasefire talks, and regional tensions.",
    legacyCategory: "politics",
    keywords: ["conflict", "sanction", "ceasefire", "war", "airstrike"],
    synonyms: ["geopolitical tension", "regional conflict"],
  },
  {
    path: "politics/election/domestic",
    displayName: "Election Dynamics",
    description:
      "Election campaigns, polling shifts, coalition changes, and institutional political dynamics.",
    legacyCategory: "politics",
    keywords: ["election", "campaign", "parliament", "coalition", "vote"],
    synonyms: ["electoral politics", "political campaign"],
  },
  {
    path: "intel/defense/military-operation",
    displayName: "Military Operation",
    description:
      "Defense operations, force movement, weapon system deployment, and military intelligence signals.",
    legacyCategory: "intel",
    keywords: ["defense", "military", "drone", "missile", "operation"],
    synonyms: ["military activity", "defense intelligence"],
  },
  {
    path: "intel/osint/analysis",
    displayName: "OSINT Signal",
    description:
      "Open-source intelligence findings and analytical assessments with security implications.",
    legacyCategory: "intel",
    keywords: ["osint", "intelligence", "analysis", "satellite", "tracking"],
    synonyms: ["open-source intelligence", "intel assessment"],
  },
];

const LEGACY_CATEGORIES = new Set<NewsLegacyCategory>([
  "politics",
  "tech",
  "finance",
  "gov",
  "ai",
  "intel",
]);

@Injectable()
export class NewsClassificationSettingsService {
  private readonly logger = createLogger({ name: "news-classification-settings" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async getSettings(orgId: string): Promise<NewsClassificationSettings> {
    const cacheKey = this.cacheKey(orgId);

    try {
      const cached = await this.cache.get<NewsClassificationSettings>(cacheKey);
      if (cached) {
        return this.normalizeSettings(cached);
      }
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to read news classification settings from cache; falling back to database",
      );
    }

    let settings: NewsClassificationSettings;
    try {
      settings = await this.loadSettings(orgId);
    } catch (error) {
      settings = this.getFallbackSettings();
      this.logger.warn(
        { err: error, orgId },
        "Failed to load news classification settings from database; using defaults",
      );
    }

    try {
      await this.cache.set(cacheKey, settings, SETTINGS_CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to write news classification settings to cache",
      );
    }

    return settings;
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: NewsClassificationSettingsInput,
  ): Promise<NewsClassificationSettings> {
    const current = await this.getSettings(orgId);
    const normalized = this.normalizeSettings(input, current);
    const key = this.systemSettingKey(orgId);

    await this.prisma.systemSetting.upsert({
      where: { key },
      update: {
        value: toPrismaJsonValue(normalized),
        updatedById: actorId,
        description: `News classification settings (org=${orgId})`,
      },
      create: {
        key,
        value: toPrismaJsonValue(normalized),
        updatedById: actorId,
        description: `News classification settings (org=${orgId})`,
      },
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "news_classification_settings_update",
          metadata: toPrismaJsonValue({
            enabled: normalized.enabled,
            strictFail: normalized.strictFail,
            enableLlm: normalized.enableLlm,
            enableEmbedding: normalized.enableEmbedding,
            enableRerank: normalized.enableRerank,
            taxonomyVersion: normalized.taxonomyVersion,
            taxonomySize: normalized.taxonomy.length,
            minConfidence: normalized.minConfidence,
            embeddingTopK: normalized.embeddingTopK,
            rerankTopN: normalized.rerankTopN,
          }),
        },
      },
      {
        orgId,
        actorId,
        resource: "system_settings",
        action: "news_classification_settings_update",
      },
    );

    await this.cache.set(this.cacheKey(orgId), normalized, SETTINGS_CACHE_TTL_SECONDS);
    return normalized;
  }

  async invalidateCache(orgId: string) {
    await this.cache.del(this.cacheKey(orgId));
  }

  private async loadSettings(orgId: string): Promise<NewsClassificationSettings> {
    const fallback = this.getFallbackSettings();
    const record = await this.prisma.systemSetting.findUnique({
      where: { key: this.systemSettingKey(orgId) },
    });
    const raw = record?.value as Partial<NewsClassificationSettingsInput> | undefined;
    return this.normalizeSettings(raw ?? {}, fallback);
  }

  private getFallbackSettings(): NewsClassificationSettings {
    return {
      enabled: true,
      strictFail: true,
      enableLlm: true,
      enableEmbedding: true,
      enableRerank: true,
      llmModel: null,
      minConfidence: 0.35,
      embeddingTopK: 12,
      rerankTopN: 6,
      cacheTtlSeconds: 60,
      taxonomyVersion: DEFAULT_TAXONOMY_VERSION,
      taxonomy: [...DEFAULT_TAXONOMY],
    };
  }

  private normalizeSettings(
    value: Partial<NewsClassificationSettingsInput>,
    fallback?: NewsClassificationSettings,
  ): NewsClassificationSettings {
    const defaults = fallback ?? this.getFallbackSettings();

    return {
      enabled: this.asBoolean(value.enabled, defaults.enabled),
      strictFail: this.asBoolean(value.strictFail, defaults.strictFail),
      enableLlm: this.asBoolean(value.enableLlm, defaults.enableLlm),
      enableEmbedding: this.asBoolean(value.enableEmbedding, defaults.enableEmbedding),
      enableRerank: this.asBoolean(value.enableRerank, defaults.enableRerank),
      llmModel: this.cleanNullableString(value.llmModel, 120, defaults.llmModel),
      minConfidence: this.clampFloat(
        value.minConfidence,
        MIN_CONFIDENCE,
        MAX_CONFIDENCE,
        defaults.minConfidence,
      ),
      embeddingTopK: this.clampInt(value.embeddingTopK, MIN_TOP_K, MAX_TOP_K, defaults.embeddingTopK),
      rerankTopN: this.clampInt(value.rerankTopN, MIN_TOP_N, MAX_TOP_N, defaults.rerankTopN),
      cacheTtlSeconds: this.clampInt(
        value.cacheTtlSeconds,
        MIN_CACHE_TTL_SECONDS,
        MAX_CACHE_TTL_SECONDS,
        defaults.cacheTtlSeconds,
      ),
      taxonomyVersion:
        this.cleanString(value.taxonomyVersion, 64) ?? defaults.taxonomyVersion,
      taxonomy: this.normalizeTaxonomy(value.taxonomy, defaults.taxonomy),
    };
  }

  private normalizeTaxonomy(
    value: unknown,
    fallback: NewsClassificationTaxonomyNode[],
  ): NewsClassificationTaxonomyNode[] {
    if (!Array.isArray(value) || value.length === 0) {
      return [...fallback];
    }

    const dedup = new Map<string, NewsClassificationTaxonomyNode>();
    for (const entry of value) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const path = this.normalizePath(record.path);
      if (!path) {
        continue;
      }
      const legacyCategory = this.normalizeLegacyCategory(record.legacyCategory);
      if (!legacyCategory) {
        continue;
      }
      const displayName = this.cleanString(record.displayName, MAX_TAXONOMY_TEXT_LENGTH) ?? path;
      const description = this.cleanString(record.description, MAX_TAXONOMY_TEXT_LENGTH) ?? "";
      const keywords = this.normalizeStringList(record.keywords);
      const synonyms = this.normalizeStringList(record.synonyms);

      dedup.set(path, {
        path,
        displayName,
        description,
        legacyCategory,
        keywords,
        synonyms,
      });

      if (dedup.size >= MAX_TAXONOMY_NODES) {
        break;
      }
    }

    if (dedup.size === 0) {
      return [...fallback];
    }

    return Array.from(dedup.values()).sort((a, b) => a.path.localeCompare(b.path));
  }

  private normalizePath(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
      return null;
    }
    const normalized = trimmed
      .replace(/\\/g, "/")
      .replace(/\s+/g, "-")
      .replace(/\/+/g, "/")
      .replace(/^\/+|\/+$/g, "");
    if (!normalized || normalized.length > MAX_TAXONOMY_PATH_LENGTH) {
      return null;
    }
    return normalized;
  }

  private normalizeLegacyCategory(value: unknown): NewsLegacyCategory | null {
    if (typeof value !== "string") {
      return null;
    }
    const normalized = value.trim().toLowerCase();
    if (!normalized || !LEGACY_CATEGORIES.has(normalized as NewsLegacyCategory)) {
      return null;
    }
    return normalized as NewsLegacyCategory;
  }

  private normalizeStringList(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const dedup = new Set<string>();
    for (const entry of value) {
      const cleaned = this.cleanString(entry, MAX_LIST_ITEM_LENGTH);
      if (!cleaned) {
        continue;
      }
      dedup.add(cleaned);
      if (dedup.size >= MAX_LIST_SIZE) {
        break;
      }
    }
    return Array.from(dedup);
  }

  private asBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
  }

  private cleanString(value: unknown, maxLength: number): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
  }

  private cleanNullableString(
    value: unknown,
    maxLength: number,
    fallback: string | null,
  ): string | null {
    if (value === null) {
      return null;
    }
    const cleaned = this.cleanString(value, maxLength);
    if (cleaned === null && value !== null && value !== undefined) {
      return fallback;
    }
    return cleaned ?? fallback;
  }

  private toNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private clampInt(value: unknown, min: number, max: number, fallback: number) {
    const numeric = this.toNumber(value);
    if (numeric === null || Number.isNaN(numeric)) {
      return fallback;
    }
    const rounded = Math.round(numeric);
    if (rounded < min) {
      return min;
    }
    if (rounded > max) {
      return max;
    }
    return rounded;
  }

  private clampFloat(value: unknown, min: number, max: number, fallback: number) {
    const numeric = this.toNumber(value);
    if (numeric === null || Number.isNaN(numeric)) {
      return fallback;
    }
    if (numeric < min) {
      return min;
    }
    if (numeric > max) {
      return max;
    }
    return numeric;
  }

  private systemSettingKey(orgId: string) {
    return `${SYSTEM_SETTING_KEY_PREFIX}${orgId}`;
  }

  private cacheKey(orgId: string) {
    return `${CACHE_KEY_PREFIX}${orgId}`;
  }
}
