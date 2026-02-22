import { createLogger } from "@modular/utils";
import { BadRequestException, Injectable } from "@nestjs/common";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

import {
  getDefaultNewsEventSourcePolicy,
  normalizeSourceCategoryAuthority,
  normalizeSourcePolicy,
  type NewsEventSourceCategoryAuthorityRule,
  type NewsEventSourcePolicy,
} from "./news-event-source-classifier";

export interface NewsEventSourcePolicyInput {
  authoritativeDomains: string[];
  authoritativeLabels: string[];
  blogDomains: string[];
  blogLabels: string[];
  categoryAuthority?: NewsEventSourceCategoryAuthorityRule[];
}

export interface NewsEventSourcePolicyDelta {
  authoritativeDomainsAdd: string[];
  authoritativeDomainsRemove: string[];
  authoritativeLabelsAdd: string[];
  authoritativeLabelsRemove: string[];
  blogDomainsAdd: string[];
  blogDomainsRemove: string[];
  blogLabelsAdd: string[];
  blogLabelsRemove: string[];
}

export interface NewsEventSourcePolicyPreset
  extends NewsEventSourcePolicyInput {
  updatedAt: string | null;
  syncWarnings: string[];
}

export interface NewsEventSourcePolicyRevisionDiff {
  baseRevision: number;
  targetRevision: number;
  authoritativeDomainsAdd: string[];
  authoritativeDomainsRemove: string[];
  authoritativeLabelsAdd: string[];
  authoritativeLabelsRemove: string[];
  blogDomainsAdd: string[];
  blogDomainsRemove: string[];
  blogLabelsAdd: string[];
  blogLabelsRemove: string[];
}

export type NewsEventSourcePolicyRevisionOperation =
  | "update"
  | "rollback"
  | "reset";

export interface NewsEventSourcePolicyRevision {
  revision: number;
  operation: NewsEventSourcePolicyRevisionOperation;
  actorId: string | null;
  createdAt: string;
  note: string | null;
  delta: NewsEventSourcePolicyDelta;
}

export interface NewsEventSourcePolicyConflict {
  domainConflicts: string[];
  labelConflicts: string[];
  hasConflicts: boolean;
}

interface NewsEventSourcePolicyStateV2 {
  version: 2;
  activeRevision: number;
  updatedAt: string;
  delta: NewsEventSourcePolicyDelta;
  revisions: NewsEventSourcePolicyRevision[];
}

export interface NewsEventSourcePolicyDetails extends NewsEventSourcePolicy {
  activeRevision: number;
  updatedAt: string | null;
  overrides: NewsEventSourcePolicyDelta;
  warnings: NewsEventSourcePolicyConflict;
  revisions: NewsEventSourcePolicyRevision[];
  syncWarnings: string[];
}

export interface NewsEventSourcePolicySyncStatus {
  degraded: boolean;
  policyCacheStale: boolean;
  presetCacheStale: boolean;
  warningCodes: string[];
}

export interface NewsEventSourcePolicyUpdateOptions {
  note?: string | null;
  expectedRevision?: number | null;
  expectedUpdatedAt?: string | null;
}

export interface NewsEventSourcePolicyHistoryOptions {
  limit?: number;
}

const SETTINGS_CACHE_TTL_SECONDS = 60;
const CACHE_KEY_PREFIX = "newsEvents:sourcePolicy:";
const SYSTEM_SETTING_KEY_PREFIX = "news_event_source_policy:";
const CATEGORY_AUTHORITY_CACHE_KEY_PREFIX =
  "newsEvents:sourcePolicyCategoryAuthority:";
const CATEGORY_AUTHORITY_SYSTEM_SETTING_KEY_PREFIX =
  "news_event_source_policy_category_authority:";
const PRESET_CACHE_TTL_SECONDS = 30;
const PRESET_CACHE_KEY_PREFIX = "newsEvents:sourcePolicyPreset:";
const PRESET_SYSTEM_SETTING_KEY_PREFIX = "news_event_source_policy_preset:";
const PRESET_CATEGORY_AUTHORITY_CACHE_KEY_PREFIX =
  "newsEvents:sourcePolicyPresetCategoryAuthority:";
const PRESET_CATEGORY_AUTHORITY_SYSTEM_SETTING_KEY_PREFIX =
  "news_event_source_policy_preset_category_authority:";
const HISTORY_LIMIT_DEFAULT = 20;
const HISTORY_LIMIT_MIN = 1;
const HISTORY_LIMIT_MAX = 100;
const REVISIONS_RETAIN_COUNT = 60;
const NOTE_MAX_LENGTH = 500;
const SYNC_WARNING_CACHE_WRITE_FAILED = "CACHE_WRITE_FAILED";
const SYNC_WARNING_POLICY_CACHE_STALE = "POLICY_CACHE_STALE";
const SYNC_WARNING_PRESET_CACHE_STALE = "PRESET_CACHE_STALE";
const SYNC_WARNING_POLICY_CACHE_MISS = "POLICY_CACHE_MISS";
const SYNC_WARNING_PRESET_CACHE_MISS = "PRESET_CACHE_MISS";
const SYNC_WARNING_POLICY_CACHE_READ_FAILED = "POLICY_CACHE_READ_FAILED";
const SYNC_WARNING_PRESET_CACHE_READ_FAILED = "PRESET_CACHE_READ_FAILED";
const SYNC_WARNING_POLICY_DB_READ_FAILED = "POLICY_DB_READ_FAILED";
const SYNC_WARNING_PRESET_DB_READ_FAILED = "PRESET_DB_READ_FAILED";

const EMPTY_DELTA: NewsEventSourcePolicyDelta = {
  authoritativeDomainsAdd: [],
  authoritativeDomainsRemove: [],
  authoritativeLabelsAdd: [],
  authoritativeLabelsRemove: [],
  blogDomainsAdd: [],
  blogDomainsRemove: [],
  blogLabelsAdd: [],
  blogLabelsRemove: [],
};

const DEFAULT_POLICY_PRESET: NewsEventSourcePolicyInput = {
  authoritativeDomains: [
    "reuters.com",
    "bloomberg.com",
    "apnews.com",
    "ft.com",
    "wsj.com",
    "nytimes.com",
    "washingtonpost.com",
    "economist.com",
    "cnbc.com",
    "nikkei.com",
    "scmp.com",
    "federalreserve.gov",
    "ecb.europa.eu",
    "imf.org",
    "worldbank.org",
  ],
  authoritativeLabels: [
    "Reuters",
    "Bloomberg",
    "Associated Press",
    "Financial Times",
    "Wall Street Journal",
    "New York Times",
    "Washington Post",
    "The Economist",
    "CNBC",
    "Nikkei",
    "South China Morning Post",
    "Federal Reserve",
    "European Central Bank",
    "IMF",
    "World Bank",
  ],
  blogDomains: [
    "substack.com",
    "medium.com",
    "wordpress.com",
    "blogspot.com",
    "youtube.com",
    "x.com",
    "reddit.com",
    "tiktok.com",
    "telegram.me",
    "telegra.ph",
    "mirror.xyz",
    "notion.site",
  ],
  blogLabels: [
    "newsletter",
    "blog",
    "creator",
    "influencer",
    "self media",
    "op ed",
    "commentary",
    "personal blog",
    "podcast",
    "livestream",
  ],
};

@Injectable()
export class NewsEventSourcePolicyService {
  private readonly logger = createLogger({ name: "news-event-source-policy" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async getPolicy(orgId: string): Promise<NewsEventSourcePolicy> {
    const state = await this.getState(orgId);
    const effective = this.toEffectivePolicy(state.delta);
    const categoryAuthority = await this.getCategoryAuthority(orgId);
    return categoryAuthority.length > 0
      ? { ...effective, categoryAuthority }
      : effective;
  }

  async getPolicyDetails(
    orgId: string,
    options?: NewsEventSourcePolicyHistoryOptions,
  ): Promise<NewsEventSourcePolicyDetails> {
    const state = await this.getState(orgId);
    const categoryAuthority = await this.getCategoryAuthority(orgId);
    return this.toPolicyDetails(state, options, undefined, categoryAuthority);
  }

  async getSyncStatus(orgId: string): Promise<NewsEventSourcePolicySyncStatus> {
    const warningCodes = new Set<string>();
    let policyCacheReadFailed = false;
    let presetCacheReadFailed = false;

    let dbState: NewsEventSourcePolicyStateV2;
    try {
      dbState = await this.loadState(orgId);
    } catch (error) {
      dbState = this.getFallbackState();
      warningCodes.add(SYNC_WARNING_POLICY_DB_READ_FAILED);
      this.logger.warn(
        {
          err: error,
          orgId,
          warningCode: SYNC_WARNING_POLICY_DB_READ_FAILED,
        },
        "Failed to read source policy state from database while checking sync status",
      );
    }

    let dbPreset: NewsEventSourcePolicyPreset;
    try {
      dbPreset = await this.loadPreset(orgId);
    } catch (error) {
      dbPreset = {
        ...this.getFallbackPreset(),
        updatedAt: null,
        syncWarnings: [],
      };
      warningCodes.add(SYNC_WARNING_PRESET_DB_READ_FAILED);
      this.logger.warn(
        {
          err: error,
          orgId,
          warningCode: SYNC_WARNING_PRESET_DB_READ_FAILED,
        },
        "Failed to read source policy preset from database while checking sync status",
      );
    }

    let cachedState: unknown = null;
    try {
      cachedState = await this.cache.get<unknown>(this.cacheKey(orgId));
    } catch (error) {
      policyCacheReadFailed = true;
      warningCodes.add(SYNC_WARNING_POLICY_CACHE_READ_FAILED);
      this.logger.warn(
        {
          err: error,
          orgId,
          warningCode: SYNC_WARNING_POLICY_CACHE_READ_FAILED,
        },
        "Failed to read source policy state cache while checking sync status",
      );
    }
    const normalizedCachedState = this.parseStateFromCache(cachedState);

    let cachedPreset: NewsEventSourcePolicyPreset | null = null;
    try {
      cachedPreset = await this.cache.get<NewsEventSourcePolicyPreset>(
        this.presetCacheKey(orgId),
      );
    } catch (error) {
      presetCacheReadFailed = true;
      warningCodes.add(SYNC_WARNING_PRESET_CACHE_READ_FAILED);
      this.logger.warn(
        {
          err: error,
          orgId,
          warningCode: SYNC_WARNING_PRESET_CACHE_READ_FAILED,
        },
        "Failed to read source policy preset cache while checking sync status",
      );
    }

    const policyDbUpdatedAt = this.normalizeExpectedUpdatedAt(
      dbState.updatedAt,
    );
    const policyCacheUpdatedAt = this.normalizeExpectedUpdatedAt(
      normalizedCachedState?.updatedAt ?? null,
    );
    const policyCacheMiss =
      !policyCacheReadFailed &&
      normalizedCachedState === null &&
      dbState.activeRevision > 0 &&
      policyDbUpdatedAt !== null;
    const policyCacheStale =
      policyCacheUpdatedAt !== null &&
      policyDbUpdatedAt !== null &&
      policyCacheUpdatedAt !== policyDbUpdatedAt;
    if (policyCacheMiss) {
      warningCodes.add(SYNC_WARNING_POLICY_CACHE_MISS);
    }
    if (policyCacheStale) {
      warningCodes.add(SYNC_WARNING_POLICY_CACHE_STALE);
    }

    const presetDbUpdatedAt = this.normalizeExpectedUpdatedAt(
      dbPreset.updatedAt,
    );
    const presetCacheUpdatedAt = this.normalizeExpectedUpdatedAt(
      cachedPreset?.updatedAt,
    );
    const presetCacheMiss =
      !presetCacheReadFailed &&
      cachedPreset === null &&
      presetDbUpdatedAt !== null;
    const presetCacheStale =
      presetCacheUpdatedAt !== null &&
      presetDbUpdatedAt !== null &&
      presetCacheUpdatedAt !== presetDbUpdatedAt;
    if (presetCacheMiss) {
      warningCodes.add(SYNC_WARNING_PRESET_CACHE_MISS);
    }
    if (presetCacheStale) {
      warningCodes.add(SYNC_WARNING_PRESET_CACHE_STALE);
    }

    return {
      degraded: warningCodes.size > 0,
      policyCacheStale,
      presetCacheStale,
      warningCodes: Array.from(warningCodes).sort(),
    };
  }

  async updatePolicy(
    orgId: string,
    actorId: string,
    input: NewsEventSourcePolicyInput,
    options?: NewsEventSourcePolicyUpdateOptions,
  ): Promise<NewsEventSourcePolicyDetails> {
    const hasCategoryAuthority = Object.prototype.hasOwnProperty.call(
      input ?? {},
      "categoryAuthority",
    );
    const normalizedInput = normalizeSourcePolicy(
      input,
      this.getFallbackPolicy(),
    );
    const normalizedCategoryAuthority = normalizeSourceCategoryAuthority(
      input.categoryAuthority,
    );
    const nextDelta = this.toDeltaFromEffectivePolicy(normalizedInput);

    const prevState = await this.getState(orgId);
    const shouldCheckExpectedRevision = Object.prototype.hasOwnProperty.call(
      options ?? {},
      "expectedRevision",
    );
    if (shouldCheckExpectedRevision) {
      const expectedRevision = this.normalizeExpectedRevision(
        options?.expectedRevision,
      );
      if (
        expectedRevision !== null &&
        expectedRevision !== prevState.activeRevision
      ) {
        throw new BadRequestException(
          `Stale source policy revision: expected ${expectedRevision}, current ${prevState.activeRevision}`,
        );
      }
    }

    const nextRevisionNumber = prevState.activeRevision + 1;
    const revision: NewsEventSourcePolicyRevision = {
      revision: nextRevisionNumber,
      operation: "update",
      actorId,
      createdAt: new Date().toISOString(),
      note: this.normalizeNote(options?.note),
      delta: nextDelta,
    };

    const nextState: NewsEventSourcePolicyStateV2 = {
      version: 2,
      activeRevision: nextRevisionNumber,
      updatedAt: revision.createdAt,
      delta: nextDelta,
      revisions: this.appendRevision(prevState.revisions, revision),
    };

    let syncWarnings = await this.persistState(
      orgId,
      actorId,
      nextState,
      "news_event_source_policy_update",
    );
    if (hasCategoryAuthority) {
      const categoryWarnings = await this.persistCategoryAuthority(
        orgId,
        actorId,
        normalizedCategoryAuthority,
        false,
      );
      syncWarnings = [...syncWarnings, ...categoryWarnings];
    }
    const categoryAuthority = hasCategoryAuthority
      ? normalizedCategoryAuthority
      : await this.getCategoryAuthority(orgId);
    return this.toPolicyDetails(
      nextState,
      undefined,
      syncWarnings,
      categoryAuthority,
    );
  }

  async rollbackPolicy(
    orgId: string,
    actorId: string,
    targetRevision: number,
    options?: NewsEventSourcePolicyUpdateOptions,
  ): Promise<NewsEventSourcePolicyDetails> {
    const prevState = await this.getState(orgId);
    const shouldCheckExpectedRevision = Object.prototype.hasOwnProperty.call(
      options ?? {},
      "expectedRevision",
    );
    if (shouldCheckExpectedRevision) {
      const expectedRevision = this.normalizeExpectedRevision(
        options?.expectedRevision,
      );
      if (
        expectedRevision !== null &&
        expectedRevision !== prevState.activeRevision
      ) {
        throw new BadRequestException(
          `Stale source policy revision: expected ${expectedRevision}, current ${prevState.activeRevision}`,
        );
      }
    }
    const revisionToRestore = prevState.revisions.find(
      (entry) => entry.revision === targetRevision,
    );
    if (!revisionToRestore) {
      throw new BadRequestException(`Revision ${targetRevision} not found`);
    }

    const nextRevisionNumber = prevState.activeRevision + 1;
    const nowIso = new Date().toISOString();
    const note =
      this.normalizeNote(options?.note) ?? `rollback->${targetRevision}`;

    const revision: NewsEventSourcePolicyRevision = {
      revision: nextRevisionNumber,
      operation: "rollback",
      actorId,
      createdAt: nowIso,
      note,
      delta: this.normalizeDelta(revisionToRestore.delta),
    };

    const nextState: NewsEventSourcePolicyStateV2 = {
      version: 2,
      activeRevision: nextRevisionNumber,
      updatedAt: nowIso,
      delta: revision.delta,
      revisions: this.appendRevision(prevState.revisions, revision),
    };

    const syncWarnings = await this.persistState(
      orgId,
      actorId,
      nextState,
      "news_event_source_policy_rollback",
    );
    const categoryAuthority = await this.getCategoryAuthority(orgId);
    return this.toPolicyDetails(
      nextState,
      undefined,
      syncWarnings,
      categoryAuthority,
    );
  }

  async resetPolicy(
    orgId: string,
    actorId: string,
    options?: NewsEventSourcePolicyUpdateOptions,
  ): Promise<NewsEventSourcePolicyDetails> {
    const prevState = await this.getState(orgId);
    const shouldCheckExpectedRevision = Object.prototype.hasOwnProperty.call(
      options ?? {},
      "expectedRevision",
    );
    if (shouldCheckExpectedRevision) {
      const expectedRevision = this.normalizeExpectedRevision(
        options?.expectedRevision,
      );
      if (
        expectedRevision !== null &&
        expectedRevision !== prevState.activeRevision
      ) {
        throw new BadRequestException(
          `Stale source policy revision: expected ${expectedRevision}, current ${prevState.activeRevision}`,
        );
      }
    }
    const nextRevisionNumber = prevState.activeRevision + 1;
    const nowIso = new Date().toISOString();

    const revision: NewsEventSourcePolicyRevision = {
      revision: nextRevisionNumber,
      operation: "reset",
      actorId,
      createdAt: nowIso,
      note: this.normalizeNote(options?.note),
      delta: this.cloneDelta(EMPTY_DELTA),
    };

    const nextState: NewsEventSourcePolicyStateV2 = {
      version: 2,
      activeRevision: nextRevisionNumber,
      updatedAt: nowIso,
      delta: this.cloneDelta(EMPTY_DELTA),
      revisions: this.appendRevision(prevState.revisions, revision),
    };

    const syncWarnings = await this.persistState(
      orgId,
      actorId,
      nextState,
      "news_event_source_policy_reset",
    );
    const categoryAuthority = await this.getCategoryAuthority(orgId);
    return this.toPolicyDetails(
      nextState,
      undefined,
      syncWarnings,
      categoryAuthority,
    );
  }

  async getPolicyPreset(orgId: string): Promise<NewsEventSourcePolicyPreset> {
    const cacheKey = this.presetCacheKey(orgId);

    let cached: NewsEventSourcePolicyPreset | null = null;
    try {
      cached = await this.cache.get<NewsEventSourcePolicyPreset>(cacheKey);
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to read news event source policy preset from cache; falling back to database",
      );
    }
    if (cached) {
      const categoryAuthority = await this.getPresetCategoryAuthority(orgId);
      return {
        ...normalizeSourcePolicy(cached, this.getFallbackPreset()),
        ...(categoryAuthority.length > 0 ? { categoryAuthority } : {}),
        updatedAt:
          typeof cached.updatedAt === "string" &&
          cached.updatedAt.trim().length > 0
            ? cached.updatedAt
            : null,
        syncWarnings: [],
      };
    }

    let preset: NewsEventSourcePolicyPreset;
    try {
      preset = await this.loadPreset(orgId);
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to load news event source policy preset from database; using defaults",
      );
      preset = {
        ...this.getFallbackPreset(),
        updatedAt: null,
        syncWarnings: [],
      };
    }

    try {
      await this.cache.set(cacheKey, preset, PRESET_CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to write news event source policy preset to cache",
      );
    }
    const categoryAuthority = await this.getPresetCategoryAuthority(orgId);
    return {
      ...preset,
      ...(categoryAuthority.length > 0 ? { categoryAuthority } : {}),
    };
  }

  async updatePolicyPreset(
    orgId: string,
    actorId: string,
    input: NewsEventSourcePolicyInput,
    options?: NewsEventSourcePolicyUpdateOptions,
  ): Promise<NewsEventSourcePolicyPreset> {
    const hasCategoryAuthority = Object.prototype.hasOwnProperty.call(
      input ?? {},
      "categoryAuthority",
    );
    const shouldCheckExpectedUpdatedAt = Object.prototype.hasOwnProperty.call(
      options ?? {},
      "expectedUpdatedAt",
    );
    if (shouldCheckExpectedUpdatedAt) {
      const expectedUpdatedAt = this.normalizeExpectedUpdatedAt(
        options?.expectedUpdatedAt,
      );
      const current = await this.loadPreset(orgId).catch(() => ({
        ...this.getFallbackPreset(),
        updatedAt: null,
        syncWarnings: [],
      }));
      const currentUpdatedAt =
        typeof current.updatedAt === "string" &&
        current.updatedAt.trim().length > 0
          ? current.updatedAt
          : null;
      if (expectedUpdatedAt !== currentUpdatedAt) {
        throw new BadRequestException(
          `Stale source policy preset timestamp: expected ${expectedUpdatedAt}, current ${currentUpdatedAt ?? "null"}`,
        );
      }
    }

    const normalized = normalizeSourcePolicy(input, this.getFallbackPreset());
    const normalizedCategoryAuthority = normalizeSourceCategoryAuthority(
      input.categoryAuthority,
    );
    const settingKey = this.presetSystemSettingKey(orgId);
    const persistedSetting = await this.prisma.systemSetting.upsert({
      where: { key: settingKey },
      update: {
        value: toPrismaJsonValue(normalized),
        updatedById: actorId,
        description: `News event source policy presets (org=${orgId})`,
      },
      create: {
        key: settingKey,
        value: toPrismaJsonValue(normalized),
        updatedById: actorId,
        description: `News event source policy presets (org=${orgId})`,
      },
      select: {
        updatedAt: true,
      },
    });
    const updatedAt = persistedSetting.updatedAt.toISOString();
    const preset: NewsEventSourcePolicyPreset = {
      ...normalized,
      updatedAt,
      syncWarnings: [],
    };

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "news_event_source_policy_preset_update",
          metadata: toPrismaJsonValue({
            updatedAt,
            note: this.normalizeNote(options?.note),
            preset: normalized,
          }),
        },
      },
      {
        orgId,
        actorId,
        resource: "system_settings",
        action: "news_event_source_policy_preset_update",
      },
    );

    try {
      await this.cache.set(
        this.presetCacheKey(orgId),
        preset,
        PRESET_CACHE_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          orgId,
          actorId,
          action: "news_event_source_policy_preset_update",
          warningCode: SYNC_WARNING_CACHE_WRITE_FAILED,
        },
        "Failed to write source policy preset cache after persisting database state",
      );
      preset.syncWarnings = [SYNC_WARNING_CACHE_WRITE_FAILED];
    }
    if (hasCategoryAuthority) {
      const warnings = await this.persistCategoryAuthority(
        orgId,
        actorId,
        normalizedCategoryAuthority,
        true,
      );
      if (warnings.length > 0) {
        preset.syncWarnings = Array.from(
          new Set([...(preset.syncWarnings ?? []), ...warnings]),
        );
      }
    }
    const categoryAuthority = hasCategoryAuthority
      ? normalizedCategoryAuthority
      : await this.getPresetCategoryAuthority(orgId);
    if (categoryAuthority.length > 0) {
      preset.categoryAuthority = categoryAuthority;
    }
    return preset;
  }

  async getRevisionDiff(
    orgId: string,
    baseRevision: number,
    targetRevision: number,
  ): Promise<NewsEventSourcePolicyRevisionDiff> {
    const state = await this.getState(orgId);
    const normalizedBase = this.clampInt(
      baseRevision,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const normalizedTarget = this.clampInt(
      targetRevision,
      1,
      Number.MAX_SAFE_INTEGER,
    );

    const base = state.revisions.find(
      (entry) => entry.revision === normalizedBase,
    );
    const target = state.revisions.find(
      (entry) => entry.revision === normalizedTarget,
    );
    if (!base) {
      throw new BadRequestException(`Revision ${normalizedBase} not found`);
    }
    if (!target) {
      throw new BadRequestException(`Revision ${normalizedTarget} not found`);
    }

    const basePolicy = this.toEffectivePolicy(base.delta);
    const targetPolicy = this.toEffectivePolicy(target.delta);

    return {
      baseRevision: normalizedBase,
      targetRevision: normalizedTarget,
      authoritativeDomainsAdd: this.diffAdd(
        basePolicy.authoritativeDomains,
        targetPolicy.authoritativeDomains,
      ),
      authoritativeDomainsRemove: this.diffAdd(
        targetPolicy.authoritativeDomains,
        basePolicy.authoritativeDomains,
      ),
      authoritativeLabelsAdd: this.diffAdd(
        basePolicy.authoritativeLabels,
        targetPolicy.authoritativeLabels,
      ),
      authoritativeLabelsRemove: this.diffAdd(
        targetPolicy.authoritativeLabels,
        basePolicy.authoritativeLabels,
      ),
      blogDomainsAdd: this.diffAdd(
        basePolicy.blogDomains,
        targetPolicy.blogDomains,
      ),
      blogDomainsRemove: this.diffAdd(
        targetPolicy.blogDomains,
        basePolicy.blogDomains,
      ),
      blogLabelsAdd: this.diffAdd(
        basePolicy.blogLabels,
        targetPolicy.blogLabels,
      ),
      blogLabelsRemove: this.diffAdd(
        targetPolicy.blogLabels,
        basePolicy.blogLabels,
      ),
    };
  }

  async invalidateCache(orgId: string) {
    await this.cache.del(this.cacheKey(orgId));
  }

  async invalidatePresetCache(orgId: string) {
    await this.cache.del(this.presetCacheKey(orgId));
  }

  private async getState(orgId: string): Promise<NewsEventSourcePolicyStateV2> {
    const cacheKey = this.cacheKey(orgId);

    let cached: unknown = null;
    try {
      cached = await this.cache.get<unknown>(cacheKey);
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to read news event source policy state from cache; falling back to database",
      );
    }

    const cachedState = this.parseStateFromCache(cached);
    if (cachedState) {
      return cachedState;
    }

    let state: NewsEventSourcePolicyStateV2;
    try {
      state = await this.loadState(orgId);
    } catch (error) {
      state = this.getFallbackState();
      this.logger.warn(
        { err: error, orgId },
        "Failed to load news event source policy state from database; using defaults",
      );
    }

    try {
      await this.cache.set(cacheKey, state, SETTINGS_CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to write news event source policy state to cache",
      );
    }

    return state;
  }

  private async loadState(
    orgId: string,
  ): Promise<NewsEventSourcePolicyStateV2> {
    const record = await this.prisma.systemSetting.findUnique({
      where: { key: this.systemSettingKey(orgId) },
      select: {
        value: true,
        updatedAt: true,
        updatedById: true,
      },
    });

    if (!record?.value) {
      return this.getFallbackState();
    }

    const parsed = this.parseStateFromRecordValue(
      record.value,
      record.updatedAt,
      record.updatedById ?? null,
    );
    return this.normalizeState(parsed);
  }

  private async loadPreset(
    orgId: string,
  ): Promise<NewsEventSourcePolicyPreset> {
    const record = await this.prisma.systemSetting.findUnique({
      where: { key: this.presetSystemSettingKey(orgId) },
      select: {
        value: true,
        updatedAt: true,
      },
    });
    if (!record?.value) {
      return {
        ...this.getFallbackPreset(),
        updatedAt: null,
        syncWarnings: [],
      };
    }

    if (!this.looksLikeLegacyPolicy(record.value)) {
      return {
        ...this.getFallbackPreset(),
        updatedAt: record.updatedAt.toISOString(),
        syncWarnings: [],
      };
    }

    const normalized = normalizeSourcePolicy(
      record.value,
      this.getFallbackPreset(),
    );
    return {
      ...normalized,
      updatedAt: record.updatedAt.toISOString(),
      syncWarnings: [],
    };
  }

  private parseStateFromRecordValue(
    rawValue: unknown,
    recordUpdatedAt: Date,
    recordActorId: string | null,
  ): NewsEventSourcePolicyStateV2 {
    if (this.isStateV2(rawValue)) {
      return rawValue;
    }

    if (this.looksLikeLegacyPolicy(rawValue)) {
      const normalizedLegacy = normalizeSourcePolicy(
        rawValue,
        this.getFallbackPolicy(),
      );
      const delta = this.toDeltaFromEffectivePolicy(normalizedLegacy);
      const createdAt = recordUpdatedAt.toISOString();
      return {
        version: 2,
        activeRevision: 1,
        updatedAt: createdAt,
        delta,
        revisions: [
          {
            revision: 1,
            operation: "update",
            actorId: recordActorId,
            createdAt,
            note: "migrated-from-legacy",
            delta,
          },
        ],
      };
    }

    return this.getFallbackState();
  }

  private parseStateFromCache(rawValue: unknown): NewsEventSourcePolicyStateV2 | null {
    if (!this.isStateV2(rawValue)) {
      return null;
    }
    return this.normalizeState(rawValue);
  }

  private toPolicyDetails(
    state: NewsEventSourcePolicyStateV2,
    options?: NewsEventSourcePolicyHistoryOptions,
    syncWarnings?: string[],
    categoryAuthority?: NewsEventSourceCategoryAuthorityRule[],
  ): NewsEventSourcePolicyDetails {
    const effective = this.toEffectivePolicy(state.delta);
    const warnings = this.buildConflictWarnings(effective);
    const historyLimit = this.clampHistoryLimit(options?.limit);
    const revisions = state.revisions
      .slice()
      .sort((a, b) => b.revision - a.revision)
      .slice(0, historyLimit);

    const normalizedCategoryAuthority = normalizeSourceCategoryAuthority(
      categoryAuthority,
    );
    return {
      ...effective,
      ...(normalizedCategoryAuthority.length > 0
        ? { categoryAuthority: normalizedCategoryAuthority }
        : {}),
      activeRevision: state.activeRevision,
      updatedAt: state.updatedAt ?? null,
      overrides: this.cloneDelta(state.delta),
      warnings,
      revisions,
      syncWarnings: Array.isArray(syncWarnings) ? [...syncWarnings] : [],
    };
  }

  private toEffectivePolicy(
    delta: NewsEventSourcePolicyDelta,
  ): NewsEventSourcePolicy {
    const defaults = this.getFallbackPolicy();

    return {
      authoritativeDomains: this.applyDeltaList(
        defaults.authoritativeDomains,
        delta.authoritativeDomainsAdd,
        delta.authoritativeDomainsRemove,
      ),
      authoritativeLabels: this.applyDeltaList(
        defaults.authoritativeLabels,
        delta.authoritativeLabelsAdd,
        delta.authoritativeLabelsRemove,
      ),
      blogDomains: this.applyDeltaList(
        defaults.blogDomains,
        delta.blogDomainsAdd,
        delta.blogDomainsRemove,
      ),
      blogLabels: this.applyDeltaList(
        defaults.blogLabels,
        delta.blogLabelsAdd,
        delta.blogLabelsRemove,
      ),
    };
  }

  private applyDeltaList(
    base: string[],
    adds: string[],
    removes: string[],
  ): string[] {
    const next = new Set<string>(base);
    for (const entry of adds) {
      if (entry) {
        next.add(entry);
      }
    }
    for (const entry of removes) {
      if (entry) {
        next.delete(entry);
      }
    }
    return Array.from(next);
  }

  private toDeltaFromEffectivePolicy(
    policy: NewsEventSourcePolicy,
  ): NewsEventSourcePolicyDelta {
    const defaults = this.getFallbackPolicy();
    return {
      authoritativeDomainsAdd: this.diffAdd(
        defaults.authoritativeDomains,
        policy.authoritativeDomains,
      ),
      authoritativeDomainsRemove: this.diffAdd(
        policy.authoritativeDomains,
        defaults.authoritativeDomains,
      ),
      authoritativeLabelsAdd: this.diffAdd(
        defaults.authoritativeLabels,
        policy.authoritativeLabels,
      ),
      authoritativeLabelsRemove: this.diffAdd(
        policy.authoritativeLabels,
        defaults.authoritativeLabels,
      ),
      blogDomainsAdd: this.diffAdd(defaults.blogDomains, policy.blogDomains),
      blogDomainsRemove: this.diffAdd(policy.blogDomains, defaults.blogDomains),
      blogLabelsAdd: this.diffAdd(defaults.blogLabels, policy.blogLabels),
      blogLabelsRemove: this.diffAdd(policy.blogLabels, defaults.blogLabels),
    };
  }

  private diffAdd(base: string[], target: string[]): string[] {
    const baseSet = new Set(base);
    const result: string[] = [];
    for (const entry of target) {
      if (!baseSet.has(entry)) {
        result.push(entry);
      }
    }
    return result;
  }

  private buildConflictWarnings(
    policy: NewsEventSourcePolicy,
  ): NewsEventSourcePolicyConflict {
    const authoritativeDomainSet = new Set(policy.authoritativeDomains);
    const authoritativeLabelSet = new Set(policy.authoritativeLabels);

    const domainConflicts: string[] = [];
    for (const entry of policy.blogDomains) {
      if (authoritativeDomainSet.has(entry)) {
        domainConflicts.push(entry);
      }
    }

    const labelConflicts: string[] = [];
    for (const entry of policy.blogLabels) {
      if (authoritativeLabelSet.has(entry)) {
        labelConflicts.push(entry);
      }
    }

    return {
      domainConflicts,
      labelConflicts,
      hasConflicts: domainConflicts.length > 0 || labelConflicts.length > 0,
    };
  }

  private clampHistoryLimit(value: unknown): number {
    const numeric =
      typeof value === "number" && Number.isFinite(value)
        ? Math.round(value)
        : HISTORY_LIMIT_DEFAULT;
    return Math.max(HISTORY_LIMIT_MIN, Math.min(HISTORY_LIMIT_MAX, numeric));
  }

  private clampInt(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Math.round(value)));
  }

  private normalizeState(
    raw: NewsEventSourcePolicyStateV2,
  ): NewsEventSourcePolicyStateV2 {
    const normalizedDelta = this.normalizeDelta(raw.delta);
    const activeRevision =
      typeof raw.activeRevision === "number" &&
      Number.isFinite(raw.activeRevision)
        ? Math.max(0, Math.round(raw.activeRevision))
        : 0;

    const revisions = Array.isArray(raw.revisions)
      ? raw.revisions
          .map((entry) => this.normalizeRevision(entry))
          .filter((entry): entry is NewsEventSourcePolicyRevision =>
            Boolean(entry),
          )
          .sort((a, b) => a.revision - b.revision)
          .slice(-REVISIONS_RETAIN_COUNT)
      : [];

    const normalizedActiveRevision =
      revisions.length > 0
        ? Math.max(activeRevision, revisions[revisions.length - 1]!.revision)
        : activeRevision;

    return {
      version: 2,
      activeRevision: normalizedActiveRevision,
      updatedAt:
        typeof raw.updatedAt === "string" && raw.updatedAt.trim().length > 0
          ? raw.updatedAt
          : (revisions[revisions.length - 1]?.createdAt ??
            new Date().toISOString()),
      delta: normalizedDelta,
      revisions,
    };
  }

  private normalizeRevision(
    raw: unknown,
  ): NewsEventSourcePolicyRevision | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return null;
    }

    const record = raw as Record<string, unknown>;
    const revision =
      typeof record.revision === "number" && Number.isFinite(record.revision)
        ? Math.max(1, Math.round(record.revision))
        : 0;
    if (!revision) {
      return null;
    }

    const operation =
      record.operation === "rollback" ||
      record.operation === "reset" ||
      record.operation === "update"
        ? record.operation
        : "update";

    return {
      revision,
      operation,
      actorId:
        typeof record.actorId === "string" && record.actorId.trim().length > 0
          ? record.actorId.trim()
          : null,
      createdAt:
        typeof record.createdAt === "string" &&
        record.createdAt.trim().length > 0
          ? record.createdAt
          : new Date().toISOString(),
      note: this.normalizeNote(record.note),
      delta: this.normalizeDelta(record.delta),
    };
  }

  private normalizeDelta(raw: unknown): NewsEventSourcePolicyDelta {
    const record =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};

    return {
      authoritativeDomainsAdd: this.normalizeStringArray(
        record.authoritativeDomainsAdd,
      ),
      authoritativeDomainsRemove: this.normalizeStringArray(
        record.authoritativeDomainsRemove,
      ),
      authoritativeLabelsAdd: this.normalizeStringArray(
        record.authoritativeLabelsAdd,
      ),
      authoritativeLabelsRemove: this.normalizeStringArray(
        record.authoritativeLabelsRemove,
      ),
      blogDomainsAdd: this.normalizeStringArray(record.blogDomainsAdd),
      blogDomainsRemove: this.normalizeStringArray(record.blogDomainsRemove),
      blogLabelsAdd: this.normalizeStringArray(record.blogLabelsAdd),
      blogLabelsRemove: this.normalizeStringArray(record.blogLabelsRemove),
    };
  }

  private normalizeStringArray(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
      return [];
    }

    const deduped = new Set<string>();
    for (const entry of raw) {
      if (typeof entry !== "string") {
        continue;
      }
      const normalized = entry.trim();
      if (!normalized) {
        continue;
      }
      deduped.add(normalized);
      if (deduped.size >= 1000) {
        break;
      }
    }

    return Array.from(deduped);
  }

  private appendRevision(
    revisions: NewsEventSourcePolicyRevision[],
    revision: NewsEventSourcePolicyRevision,
  ): NewsEventSourcePolicyRevision[] {
    const next = revisions.slice();
    next.push(revision);
    return next
      .sort((a, b) => a.revision - b.revision)
      .slice(-REVISIONS_RETAIN_COUNT);
  }

  private cloneDelta(
    delta: NewsEventSourcePolicyDelta,
  ): NewsEventSourcePolicyDelta {
    return {
      authoritativeDomainsAdd: [...delta.authoritativeDomainsAdd],
      authoritativeDomainsRemove: [...delta.authoritativeDomainsRemove],
      authoritativeLabelsAdd: [...delta.authoritativeLabelsAdd],
      authoritativeLabelsRemove: [...delta.authoritativeLabelsRemove],
      blogDomainsAdd: [...delta.blogDomainsAdd],
      blogDomainsRemove: [...delta.blogDomainsRemove],
      blogLabelsAdd: [...delta.blogLabelsAdd],
      blogLabelsRemove: [...delta.blogLabelsRemove],
    };
  }

  private normalizeNote(raw: unknown): string | null {
    if (typeof raw !== "string") {
      return null;
    }
    const normalized = raw.trim();
    if (!normalized) {
      return null;
    }
    return normalized.slice(0, NOTE_MAX_LENGTH);
  }

  private normalizeExpectedRevision(raw: unknown): number | null {
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return null;
    }
    return Math.max(0, Math.round(raw));
  }

  private normalizeExpectedUpdatedAt(raw: unknown): string | null {
    if (raw == null) {
      return null;
    }
    if (typeof raw !== "string") {
      return null;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    const ms = new Date(trimmed).getTime();
    if (!Number.isFinite(ms)) {
      return null;
    }
    return new Date(ms).toISOString();
  }

  private getFallbackPolicy(): NewsEventSourcePolicy {
    return getDefaultNewsEventSourcePolicy();
  }

  private getFallbackPreset(): NewsEventSourcePolicyInput {
    return {
      authoritativeDomains: [...DEFAULT_POLICY_PRESET.authoritativeDomains],
      authoritativeLabels: [...DEFAULT_POLICY_PRESET.authoritativeLabels],
      blogDomains: [...DEFAULT_POLICY_PRESET.blogDomains],
      blogLabels: [...DEFAULT_POLICY_PRESET.blogLabels],
    };
  }

  private getFallbackState(): NewsEventSourcePolicyStateV2 {
    return {
      version: 2,
      activeRevision: 0,
      updatedAt: new Date(0).toISOString(),
      delta: this.cloneDelta(EMPTY_DELTA),
      revisions: [],
    };
  }

  private async persistState(
    orgId: string,
    actorId: string,
    state: NewsEventSourcePolicyStateV2,
    auditAction: string,
  ): Promise<string[]> {
    const key = this.systemSettingKey(orgId);

    await this.prisma.systemSetting.upsert({
      where: { key },
      update: {
        value: toPrismaJsonValue(state),
        updatedById: actorId,
        description: `News event source policy (org=${orgId})`,
      },
      create: {
        key,
        value: toPrismaJsonValue(state),
        updatedById: actorId,
        description: `News event source policy (org=${orgId})`,
      },
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: auditAction,
          metadata: toPrismaJsonValue({
            activeRevision: state.activeRevision,
            updatedAt: state.updatedAt,
            delta: state.delta,
          }),
        },
      },
      { orgId, actorId, resource: "system_settings", action: auditAction },
    );

    try {
      await this.cache.set(
        this.cacheKey(orgId),
        state,
        SETTINGS_CACHE_TTL_SECONDS,
      );
      return [];
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          orgId,
          actorId,
          action: auditAction,
          warningCode: SYNC_WARNING_CACHE_WRITE_FAILED,
        },
        "Failed to write source policy cache after persisting database state",
      );
      return [SYNC_WARNING_CACHE_WRITE_FAILED];
    }
  }

  private async getCategoryAuthority(
    orgId: string,
  ): Promise<NewsEventSourceCategoryAuthorityRule[]> {
    const cacheKey = this.categoryAuthorityCacheKey(orgId);
    try {
      const cached =
        await this.cache.get<NewsEventSourceCategoryAuthorityRule[]>(cacheKey);
      if (Array.isArray(cached)) {
        return normalizeSourceCategoryAuthority(cached);
      }
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to read source policy category authority from cache; falling back to database",
      );
    }

    const loaded = await this.loadCategoryAuthority(orgId, false);
    try {
      await this.cache.set(cacheKey, loaded, SETTINGS_CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to write source policy category authority to cache",
      );
    }
    return loaded;
  }

  private async getPresetCategoryAuthority(
    orgId: string,
  ): Promise<NewsEventSourceCategoryAuthorityRule[]> {
    const cacheKey = this.presetCategoryAuthorityCacheKey(orgId);
    try {
      const cached =
        await this.cache.get<NewsEventSourceCategoryAuthorityRule[]>(cacheKey);
      if (Array.isArray(cached)) {
        return normalizeSourceCategoryAuthority(cached);
      }
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to read source policy preset category authority from cache; falling back to database",
      );
    }

    const loaded = await this.loadCategoryAuthority(orgId, true);
    try {
      await this.cache.set(cacheKey, loaded, PRESET_CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to write source policy preset category authority to cache",
      );
    }
    return loaded;
  }

  private async loadCategoryAuthority(
    orgId: string,
    preset: boolean,
  ): Promise<NewsEventSourceCategoryAuthorityRule[]> {
    const record = await this.prisma.systemSetting.findUnique({
      where: {
        key: preset
          ? this.presetCategoryAuthoritySystemSettingKey(orgId)
          : this.categoryAuthoritySystemSettingKey(orgId),
      },
      select: { value: true },
    });
    return normalizeSourceCategoryAuthority(record?.value);
  }

  private async persistCategoryAuthority(
    orgId: string,
    actorId: string,
    rules: NewsEventSourceCategoryAuthorityRule[],
    preset: boolean,
  ): Promise<string[]> {
    const normalized = normalizeSourceCategoryAuthority(rules);
    const key = preset
      ? this.presetCategoryAuthoritySystemSettingKey(orgId)
      : this.categoryAuthoritySystemSettingKey(orgId);
    const cacheKey = preset
      ? this.presetCategoryAuthorityCacheKey(orgId)
      : this.categoryAuthorityCacheKey(orgId);
    const ttl = preset ? PRESET_CACHE_TTL_SECONDS : SETTINGS_CACHE_TTL_SECONDS;
    const descriptionPrefix = preset
      ? "News event source policy preset category authority"
      : "News event source policy category authority";

    await this.prisma.systemSetting.upsert({
      where: { key },
      update: {
        value: toPrismaJsonValue(normalized),
        updatedById: actorId,
        description: `${descriptionPrefix} (org=${orgId})`,
      },
      create: {
        key,
        value: toPrismaJsonValue(normalized),
        updatedById: actorId,
        description: `${descriptionPrefix} (org=${orgId})`,
      },
    });

    try {
      await this.cache.set(cacheKey, normalized, ttl);
      return [];
    } catch (error) {
      this.logger.warn(
        { err: error, orgId, actorId },
        "Failed to write source policy category authority cache after persisting database state",
      );
      return [SYNC_WARNING_CACHE_WRITE_FAILED];
    }
  }

  private looksLikeLegacyPolicy(
    raw: unknown,
  ): raw is Partial<NewsEventSourcePolicyInput> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return false;
    }
    const record = raw as Record<string, unknown>;
    return (
      "authoritativeDomains" in record ||
      "authoritativeLabels" in record ||
      "blogDomains" in record ||
      "blogLabels" in record
    );
  }

  private isStateV2(raw: unknown): raw is NewsEventSourcePolicyStateV2 {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return false;
    }
    const record = raw as Record<string, unknown>;
    return record.version === 2 && "delta" in record;
  }

  private systemSettingKey(orgId: string) {
    return `${SYSTEM_SETTING_KEY_PREFIX}${orgId}`;
  }

  private categoryAuthoritySystemSettingKey(orgId: string) {
    return `${CATEGORY_AUTHORITY_SYSTEM_SETTING_KEY_PREFIX}${orgId}`;
  }

  private presetSystemSettingKey(orgId: string) {
    return `${PRESET_SYSTEM_SETTING_KEY_PREFIX}${orgId}`;
  }

  private presetCategoryAuthoritySystemSettingKey(orgId: string) {
    return `${PRESET_CATEGORY_AUTHORITY_SYSTEM_SETTING_KEY_PREFIX}${orgId}`;
  }

  private cacheKey(orgId: string) {
    return `${CACHE_KEY_PREFIX}${orgId}`;
  }

  private categoryAuthorityCacheKey(orgId: string) {
    return `${CATEGORY_AUTHORITY_CACHE_KEY_PREFIX}${orgId}`;
  }

  private presetCacheKey(orgId: string) {
    return `${PRESET_CACHE_KEY_PREFIX}${orgId}`;
  }

  private presetCategoryAuthorityCacheKey(orgId: string) {
    return `${PRESET_CATEGORY_AUTHORITY_CACHE_KEY_PREFIX}${orgId}`;
  }
}
