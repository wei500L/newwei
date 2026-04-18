import { Injectable } from "@nestjs/common";

import { CacheService } from "../cache/cache.service";

import type { UserNewsBehaviorEventType } from "./dto/record-user-news-behavior.dto";
import {
  buildUserNewsBehaviorDayKey,
  buildUserNewsBehaviorHashKey,
  buildUserNewsBehaviorProfileCacheKey,
  USER_NEWS_BEHAVIOR_BANDS,
  USER_NEWS_BEHAVIOR_DIMENSIONS,
  USER_NEWS_BEHAVIOR_HASH_KINDS,
  USER_NEWS_BEHAVIOR_RETENTION_SECONDS,
  USER_NEWS_BEHAVIOR_PROFILE_CACHE_TTL_SECONDS,
  USER_NEWS_BEHAVIOR_V2_RETENTION_SECONDS,
  USER_NEWS_BEHAVIOR_V2_WINDOW_DAYS,
} from "./user-news-behavior.constants";

const POSITIVE_EVENT_WEIGHT_MAP: Partial<Record<UserNewsBehaviorEventType, number>> = {
  view: 1,
  click: 2,
  open_event: 3,
  open_item: 3,
  bookmark: 4,
  share: 4,
  engaged_read: 2,
  deep_read: 3,
  completed_read: 4,
};

const NEGATIVE_EVENT_WEIGHT_MAP: Partial<Record<UserNewsBehaviorEventType, number>> = {
  not_interested: 4,
  unsubscribe: 5,
};

const MAX_TERM_LENGTH = 96;
const MAX_ID_LENGTH = 128;
const MAX_TERMS_PER_DIMENSION = 8;
const LEGACY_FALLBACK_SCALE = 0.18;
const LEGACY_FALLBACK_ACTION_THRESHOLD = 2;

type UserNewsBehaviorScoreRecord = Record<string, number>;

type UserNewsBehaviorScoreDimensions = {
  [K in (typeof USER_NEWS_BEHAVIOR_DIMENSIONS)[number]]: UserNewsBehaviorScoreRecord;
};

export interface UserNewsBehaviorProfile {
  actions: UserNewsBehaviorScoreRecord;
  sources: UserNewsBehaviorScoreRecord;
  topics: UserNewsBehaviorScoreRecord;
  entities: UserNewsBehaviorScoreRecord;
  items: UserNewsBehaviorScoreRecord;
  events: UserNewsBehaviorScoreRecord;
  domains: UserNewsBehaviorScoreRecord;
  positive: UserNewsBehaviorScoreDimensions;
  negative: UserNewsBehaviorScoreDimensions;
  net: UserNewsBehaviorScoreDimensions;
  bands: {
    key: string;
    weight: number;
    positive: UserNewsBehaviorScoreDimensions;
    negative: UserNewsBehaviorScoreDimensions;
    net: UserNewsBehaviorScoreDimensions;
  }[];
  meta: {
    legacyFallbackUsed: boolean;
  };
}

@Injectable()
export class UserNewsBehaviorService {
  constructor(private readonly cache: CacheService) {}

  async record(input: {
    orgId: string;
    userId: string;
    type: UserNewsBehaviorEventType;
    itemId?: string;
    eventId?: string;
    source?: string;
    topics?: string[];
    entities?: string[];
    url?: string;
  }) {
    const positiveWeight = POSITIVE_EVENT_WEIGHT_MAP[input.type] ?? 0;
    const negativeWeight = NEGATIVE_EVENT_WEIGHT_MAP[input.type] ?? 0;
    const itemId = this.normalizeId(input.itemId);
    const eventId = this.normalizeId(input.eventId);
    const domain = this.normalizeUrlDomain(input.url);
    const source = this.normalizeSourceSignal(input.source, domain);
    const topics = this.normalizeTerms(input.topics);
    const entities = this.normalizeTerms(input.entities);
    const today = this.formatDayKey(new Date());
    const dailyKey = buildUserNewsBehaviorDayKey({
      orgId: input.orgId,
      userId: input.userId,
      dayKey: today,
    });

    const ops: Promise<unknown>[] = [];

    if (positiveWeight > 0) {
      ops.push(
        this.cache.hincrby(
          dailyKey,
          this.buildBehaviorFieldKey("p", "actions", input.type),
          1,
        ),
      );
      if (source) {
        ops.push(
          this.cache.hincrby(
            dailyKey,
            this.buildBehaviorFieldKey("p", "sources", source),
            positiveWeight,
          ),
        );
      }
      if (itemId) {
        ops.push(
          this.cache.hincrby(
            dailyKey,
            this.buildBehaviorFieldKey("p", "items", itemId),
            positiveWeight,
          ),
        );
      }
      if (eventId) {
        ops.push(
          this.cache.hincrby(
            dailyKey,
            this.buildBehaviorFieldKey("p", "events", eventId),
            positiveWeight,
          ),
        );
      }
      if (domain) {
        ops.push(
          this.cache.hincrby(
            dailyKey,
            this.buildBehaviorFieldKey("p", "domains", domain),
            positiveWeight,
          ),
        );
      }
      for (const term of topics) {
        ops.push(
          this.cache.hincrby(
            dailyKey,
            this.buildBehaviorFieldKey("p", "topics", term),
            positiveWeight,
          ),
        );
      }
      for (const term of entities) {
        ops.push(
          this.cache.hincrby(
            dailyKey,
            this.buildBehaviorFieldKey("p", "entities", term),
            positiveWeight,
          ),
        );
      }
    }

    if (negativeWeight > 0) {
      ops.push(
        this.cache.hincrby(
          dailyKey,
          this.buildBehaviorFieldKey("n", "actions", input.type),
          1,
        ),
      );

      if (input.type === "not_interested") {
        if (itemId) {
          ops.push(
            this.cache.hincrby(
              dailyKey,
              this.buildBehaviorFieldKey("n", "items", itemId),
              negativeWeight,
            ),
          );
        } else if (eventId) {
          ops.push(
            this.cache.hincrby(
              dailyKey,
              this.buildBehaviorFieldKey("n", "events", eventId),
              negativeWeight,
            ),
          );
        } else if (source) {
          ops.push(
            this.cache.hincrby(
              dailyKey,
              this.buildBehaviorFieldKey("n", "sources", source),
              negativeWeight,
            ),
          );
        } else if (topics[0]) {
          ops.push(
            this.cache.hincrby(
              dailyKey,
              this.buildBehaviorFieldKey("n", "topics", topics[0]),
              negativeWeight,
            ),
          );
        } else if (entities[0]) {
          ops.push(
            this.cache.hincrby(
              dailyKey,
              this.buildBehaviorFieldKey("n", "entities", entities[0]),
              negativeWeight,
            ),
          );
        }
      }

      if (input.type === "unsubscribe") {
        if (topics[0]) {
          ops.push(
            this.cache.hincrby(
              dailyKey,
              this.buildBehaviorFieldKey("n", "topics", topics[0]),
              negativeWeight,
            ),
          );
        }
        if (entities[0]) {
          ops.push(
            this.cache.hincrby(
              dailyKey,
              this.buildBehaviorFieldKey("n", "entities", entities[0]),
              negativeWeight,
            ),
          );
        }
      }
    }

    await Promise.all(ops);
    await Promise.all([
      this.cache.expire(dailyKey, USER_NEWS_BEHAVIOR_V2_RETENTION_SECONDS),
      this.cache.del(this.buildProfileCacheKey(input.orgId, input.userId)),
    ]);

    return { recorded: true };
  }

  async getProfile(orgId: string, userId: string): Promise<UserNewsBehaviorProfile> {
    const cacheKey = this.buildProfileCacheKey(orgId, userId);
    const cached = await this.cache.get<UserNewsBehaviorProfile>(cacheKey);
    if (cached) {
      return cached;
    }

    const profile = await this.computeResolvedProfile(orgId, userId);
    await this.cache.set(cacheKey, profile, USER_NEWS_BEHAVIOR_PROFILE_CACHE_TTL_SECONDS);
    return profile;
  }

  async clearProfile(orgId: string, userId: string): Promise<{ cleared: true }> {
    const legacyKeys = USER_NEWS_BEHAVIOR_HASH_KINDS.map((kind) =>
      buildUserNewsBehaviorHashKey({ orgId, userId, kind }),
    );
    const v2Keys = this.buildRecentDayKeys(orgId, userId);
    await this.cache.delMany([
      ...legacyKeys,
      ...v2Keys,
      this.buildProfileCacheKey(orgId, userId),
    ]);
    return { cleared: true };
  }

  async getPersonalizationProfile(orgId: string, userId: string) {
    const profile = await this.getProfile(orgId, userId);
    return {
      positive: profile.positive,
      negative: profile.negative,
      net: profile.net,
      meta: profile.meta,
    };
  }

  private parseScoreRecord(
    record: Record<string, string>,
    normalizeKey: (value?: string) => string | null = (value) =>
      this.normalizeTerm(value),
  ): Record<string, number> {
    const normalized = Object.entries(record ?? {})
      .map(([key, rawValue]) => {
        const term = normalizeKey(key);
        if (!term) {
          return null;
        }
        const parsed = Number(rawValue);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return null;
        }
        return [term, parsed] as const;
      })
      .filter((entry): entry is readonly [string, number] => Boolean(entry))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 300);

    return Object.fromEntries(normalized);
  }

  private async computeResolvedProfile(
    orgId: string,
    userId: string,
  ): Promise<UserNewsBehaviorProfile> {
    const dayKeys = this.buildRecentDayKeys(orgId, userId);
    const rawDays = await Promise.all(dayKeys.map((key) => this.cache.hgetall(key)));
    const positive = this.createEmptyScoreDimensions();
    const negative = this.createEmptyScoreDimensions();
    const bandProfiles = USER_NEWS_BEHAVIOR_BANDS.map((band) => ({
      key: band.key,
      weight: band.weight,
      positive: this.createEmptyScoreDimensions(),
      negative: this.createEmptyScoreDimensions(),
    }));

    let positiveActionRawTotal = 0;

    rawDays.forEach((raw, dayOffset) => {
      const bandIndex = this.resolveBandIndex(dayOffset);
      if (bandIndex < 0) {
        return;
      }
      const bandProfile = bandProfiles[bandIndex];
      if (!bandProfile) {
        return;
      }
      const positiveRaw = this.createEmptyScoreDimensions();
      const negativeRaw = this.createEmptyScoreDimensions();

      for (const [field, rawValue] of Object.entries(raw ?? {})) {
        const parsed = this.parseBehaviorFieldKey(field);
        if (!parsed) {
          continue;
        }
        const score = Number(rawValue);
        if (!Number.isFinite(score) || score <= 0) {
          continue;
        }

        const target =
          parsed.polarity === "p"
            ? positiveRaw[parsed.dimension]
            : negativeRaw[parsed.dimension];
        target[parsed.term] = (target[parsed.term] ?? 0) + score;

        if (parsed.polarity === "p" && parsed.dimension === "actions") {
          positiveActionRawTotal += score;
        }
      }

      USER_NEWS_BEHAVIOR_DIMENSIONS.forEach((dimension) => {
        this.addBandScores(
          positive[dimension],
          bandProfile.positive[dimension],
          positiveRaw[dimension],
          bandProfile.weight,
          dimension,
        );
        this.addBandScores(
          negative[dimension],
          bandProfile.negative[dimension],
          negativeRaw[dimension],
          bandProfile.weight,
          dimension,
        );
      });
    });

    const fallback = await this.loadLegacyFallback(orgId, userId, positiveActionRawTotal);
    if (fallback) {
      USER_NEWS_BEHAVIOR_DIMENSIONS.forEach((dimension) => {
        this.mergeScores(positive[dimension], fallback[dimension]);
      });
    }

    const net = this.createEmptyScoreDimensions();
    USER_NEWS_BEHAVIOR_DIMENSIONS.forEach((dimension) => {
      net[dimension] = this.subtractScores(positive[dimension], negative[dimension]);
    });

    const profile: UserNewsBehaviorProfile = {
      actions: this.clampScores(net.actions),
      sources: this.clampScores(net.sources),
      topics: this.clampScores(net.topics),
      entities: this.clampScores(net.entities),
      items: this.clampScores(net.items),
      events: this.clampScores(net.events),
      domains: this.clampScores(net.domains),
      positive,
      negative,
      net,
      bands: bandProfiles.map((band) => ({
        key: band.key,
        weight: band.weight,
        positive: band.positive,
        negative: band.negative,
        net: {
          actions: this.subtractScores(band.positive.actions, band.negative.actions),
          sources: this.subtractScores(band.positive.sources, band.negative.sources),
          topics: this.subtractScores(band.positive.topics, band.negative.topics),
          entities: this.subtractScores(band.positive.entities, band.negative.entities),
          items: this.subtractScores(band.positive.items, band.negative.items),
          events: this.subtractScores(band.positive.events, band.negative.events),
          domains: this.subtractScores(band.positive.domains, band.negative.domains),
        },
      })),
      meta: {
        legacyFallbackUsed: Boolean(fallback),
      },
    };

    return profile;
  }

  private async loadLegacyFallback(
    orgId: string,
    userId: string,
    positiveActionRawTotal: number,
  ): Promise<UserNewsBehaviorScoreDimensions | null> {
    if (positiveActionRawTotal > LEGACY_FALLBACK_ACTION_THRESHOLD) {
      return null;
    }

    const [
      actionRaw,
      sourceRaw,
      topicRaw,
      entityRaw,
      itemRaw,
      eventRaw,
      domainRaw,
    ] = await Promise.all([
      this.cache.hgetall(
        buildUserNewsBehaviorHashKey({ orgId, userId, kind: "actions" }),
      ),
      this.cache.hgetall(
        buildUserNewsBehaviorHashKey({ orgId, userId, kind: "sources" }),
      ),
      this.cache.hgetall(
        buildUserNewsBehaviorHashKey({ orgId, userId, kind: "topics" }),
      ),
      this.cache.hgetall(
        buildUserNewsBehaviorHashKey({ orgId, userId, kind: "entities" }),
      ),
      this.cache.hgetall(
        buildUserNewsBehaviorHashKey({ orgId, userId, kind: "items" }),
      ),
      this.cache.hgetall(
        buildUserNewsBehaviorHashKey({ orgId, userId, kind: "events" }),
      ),
      this.cache.hgetall(
        buildUserNewsBehaviorHashKey({ orgId, userId, kind: "domains" }),
      ),
    ]);

    const fallback: UserNewsBehaviorScoreDimensions = {
      actions: this.scaleLegacyScores(this.parseScoreRecord(actionRaw)),
      sources: this.scaleLegacyScores(this.parseScoreRecord(sourceRaw)),
      topics: this.scaleLegacyScores(this.parseScoreRecord(topicRaw)),
      entities: this.scaleLegacyScores(this.parseScoreRecord(entityRaw)),
      items: this.scaleLegacyScores(
        this.parseScoreRecord(itemRaw, (value) => this.normalizeId(value)),
      ),
      events: this.scaleLegacyScores(
        this.parseScoreRecord(eventRaw, (value) => this.normalizeId(value)),
      ),
      domains: this.scaleLegacyScores(this.parseScoreRecord(domainRaw)),
    };

    const hasFallback = USER_NEWS_BEHAVIOR_DIMENSIONS.some(
      (dimension) => Object.keys(fallback[dimension]).length > 0,
    );
    return hasFallback ? fallback : null;
  }

  private scaleLegacyScores(record: UserNewsBehaviorScoreRecord): UserNewsBehaviorScoreRecord {
    const out: UserNewsBehaviorScoreRecord = {};
    for (const [term, value] of Object.entries(record ?? {})) {
      const scaled = Number((Math.log1p(value) * LEGACY_FALLBACK_SCALE).toFixed(4));
      if (scaled <= 0) {
        continue;
      }
      out[term] = scaled;
    }
    return out;
  }

  private createEmptyScoreDimensions(): UserNewsBehaviorScoreDimensions {
    return {
      actions: {},
      sources: {},
      topics: {},
      entities: {},
      items: {},
      events: {},
      domains: {},
    };
  }

  private addBandScores(
    aggregate: UserNewsBehaviorScoreRecord,
    bandTarget: UserNewsBehaviorScoreRecord,
    raw: UserNewsBehaviorScoreRecord,
    weight: number,
    dimension: keyof UserNewsBehaviorScoreDimensions,
  ) {
    const normalizeKey =
      dimension === "items" || dimension === "events"
        ? (value?: string) => this.normalizeId(value)
        : (value?: string) => this.normalizeTerm(value);

    for (const [term, rawValue] of Object.entries(raw ?? {})) {
      const normalizedTerm = normalizeKey(term);
      if (!normalizedTerm || rawValue <= 0) {
        continue;
      }
      const score = Number((Math.log1p(rawValue) * weight).toFixed(4));
      if (score <= 0) {
        continue;
      }
      bandTarget[normalizedTerm] = (bandTarget[normalizedTerm] ?? 0) + score;
      aggregate[normalizedTerm] = (aggregate[normalizedTerm] ?? 0) + score;
    }
  }

  private mergeScores(
    target: UserNewsBehaviorScoreRecord,
    incoming: UserNewsBehaviorScoreRecord,
  ) {
    for (const [term, value] of Object.entries(incoming ?? {})) {
      target[term] = (target[term] ?? 0) + value;
    }
  }

  private subtractScores(
    positive: UserNewsBehaviorScoreRecord,
    negative: UserNewsBehaviorScoreRecord,
  ): UserNewsBehaviorScoreRecord {
    const out: UserNewsBehaviorScoreRecord = {};
    const keys = new Set([
      ...Object.keys(positive ?? {}),
      ...Object.keys(negative ?? {}),
    ]);
    for (const key of keys) {
      const value = Number(
        (((positive?.[key] ?? 0) - (negative?.[key] ?? 0))).toFixed(4),
      );
      if (Math.abs(value) <= 0.0001) {
        continue;
      }
      out[key] = value;
    }
    return this.limitScoreRecord(out);
  }

  private clampScores(record: UserNewsBehaviorScoreRecord): UserNewsBehaviorScoreRecord {
    const out: UserNewsBehaviorScoreRecord = {};
    for (const [term, value] of Object.entries(record ?? {})) {
      const clamped = Number(Math.max(0, value).toFixed(4));
      if (clamped <= 0) {
        continue;
      }
      out[term] = clamped;
    }
    return this.limitScoreRecord(out);
  }

  private limitScoreRecord(record: UserNewsBehaviorScoreRecord): UserNewsBehaviorScoreRecord {
    return Object.fromEntries(
      Object.entries(record ?? {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 300),
    );
  }

  private buildRecentDayKeys(orgId: string, userId: string): string[] {
    const keys: string[] = [];
    const now = new Date();
    for (let dayOffset = 0; dayOffset < USER_NEWS_BEHAVIOR_V2_WINDOW_DAYS; dayOffset += 1) {
      const date = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - dayOffset,
      ));
      keys.push(
        buildUserNewsBehaviorDayKey({
          orgId,
          userId,
          dayKey: this.formatDayKey(date),
        }),
      );
    }
    return keys;
  }

  private formatDayKey(date: Date): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return `${year}${month}${day}`;
  }

  private resolveBandIndex(dayOffset: number): number {
    return USER_NEWS_BEHAVIOR_BANDS.findIndex(
      (band) =>
        dayOffset >= band.startDayOffset && dayOffset <= band.endDayOffset,
    );
  }

  private buildBehaviorFieldKey(
    polarity: "p" | "n",
    dimension: keyof UserNewsBehaviorScoreDimensions,
    term: string,
  ): string {
    return `${polarity}:${dimension}:${term}`;
  }

  private parseBehaviorFieldKey(field: string):
    | {
        polarity: "p" | "n";
        dimension: keyof UserNewsBehaviorScoreDimensions;
        term: string;
      }
    | null {
    const match = field.match(
      /^(p|n):(actions|sources|topics|entities|items|events|domains):(.+)$/,
    );
    if (!match) {
      return null;
    }
    const [, polarity, dimension, term] = match;
    if (!term) {
      return null;
    }
    return {
      polarity: polarity as "p" | "n",
      dimension: dimension as keyof UserNewsBehaviorScoreDimensions,
      term,
    };
  }

  private buildProfileCacheKey(orgId: string, userId: string) {
    return buildUserNewsBehaviorProfileCacheKey({ orgId, userId });
  }

  private normalizeTerms(values?: string[]): string[] {
    if (!Array.isArray(values)) {
      return [];
    }
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      const term = this.normalizeTerm(value);
      if (!term || seen.has(term)) {
        continue;
      }
      seen.add(term);
      out.push(term);
      if (out.length >= MAX_TERMS_PER_DIMENSION) {
        break;
      }
    }
    return out;
  }

  private normalizeId(value?: string): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim().slice(0, MAX_ID_LENGTH);
    return trimmed.length > 0 ? trimmed : null;
  }

  private normalizeUrlDomain(value?: string): string | null {
    if (typeof value !== "string" || !value.trim()) {
      return null;
    }
    try {
      const parsed = new URL(value);
      const hostname = parsed.hostname
        .trim()
        .toLowerCase()
        .replace(/^www\./, "");
      return this.normalizeTerm(hostname);
    } catch {
      return null;
    }
  }

  private normalizeSourceSignal(sourceValue?: string, domain?: string | null): string | null {
    const normalizedSource = this.normalizeTerm(sourceValue);
    if (normalizedSource && this.looksLikeStructuredSourceKey(normalizedSource)) {
      return normalizedSource;
    }
    if (domain) {
      return domain;
    }
    return normalizedSource;
  }

  private looksLikeStructuredSourceKey(value: string): boolean {
    if (!value || value.includes(" ")) {
      return false;
    }
    return /^[a-z0-9][a-z0-9._-]{1,63}$/.test(value);
  }

  private normalizeTerm(value?: string): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const compact = value
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .slice(0, MAX_TERM_LENGTH);
    return compact.length > 0 ? compact : null;
  }
}
