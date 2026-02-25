import { Injectable } from "@nestjs/common";

import { CacheService } from "../cache/cache.service";

import type { UserNewsBehaviorEventType } from "./dto/record-user-news-behavior.dto";
import {
  buildUserNewsBehaviorHashKey,
  USER_NEWS_BEHAVIOR_HASH_KINDS,
  USER_NEWS_BEHAVIOR_RETENTION_SECONDS,
} from "./user-news-behavior.constants";

const EVENT_WEIGHT_MAP: Record<UserNewsBehaviorEventType, number> = {
  view: 1,
  click: 2,
  open_event: 3,
  open_item: 3,
  bookmark: 4,
};

const MAX_TERM_LENGTH = 96;
const MAX_ID_LENGTH = 128;
const MAX_TERMS_PER_DIMENSION = 8;

export interface UserNewsBehaviorProfile {
  actions: Record<string, number>;
  sources: Record<string, number>;
  topics: Record<string, number>;
  entities: Record<string, number>;
  items: Record<string, number>;
  events: Record<string, number>;
  domains: Record<string, number>;
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
    const actionWeight = EVENT_WEIGHT_MAP[input.type] ?? 1;
    const itemId = this.normalizeId(input.itemId);
    const eventId = this.normalizeId(input.eventId);
    const domain = this.normalizeUrlDomain(input.url);
    const source = this.normalizeSourceSignal(input.source, domain);
    const topics = this.normalizeTerms(input.topics);
    const entities = this.normalizeTerms(input.entities);

    const actionsKey = buildUserNewsBehaviorHashKey({
      orgId: input.orgId,
      userId: input.userId,
      kind: "actions",
    });
    const sourcesKey = buildUserNewsBehaviorHashKey({
      orgId: input.orgId,
      userId: input.userId,
      kind: "sources",
    });
    const topicsKey = buildUserNewsBehaviorHashKey({
      orgId: input.orgId,
      userId: input.userId,
      kind: "topics",
    });
    const entitiesKey = buildUserNewsBehaviorHashKey({
      orgId: input.orgId,
      userId: input.userId,
      kind: "entities",
    });
    const itemsKey = buildUserNewsBehaviorHashKey({
      orgId: input.orgId,
      userId: input.userId,
      kind: "items",
    });
    const eventsKey = buildUserNewsBehaviorHashKey({
      orgId: input.orgId,
      userId: input.userId,
      kind: "events",
    });
    const domainsKey = buildUserNewsBehaviorHashKey({
      orgId: input.orgId,
      userId: input.userId,
      kind: "domains",
    });

    const ops: Promise<unknown>[] = [];
    ops.push(this.cache.hincrby(actionsKey, input.type, 1));

    if (source) {
      ops.push(this.cache.hincrby(sourcesKey, source, actionWeight));
    }
    if (itemId) {
      ops.push(this.cache.hincrby(itemsKey, itemId, actionWeight));
    }
    if (eventId) {
      ops.push(this.cache.hincrby(eventsKey, eventId, actionWeight));
    }
    if (domain) {
      ops.push(this.cache.hincrby(domainsKey, domain, actionWeight));
    }
    for (const term of topics) {
      ops.push(this.cache.hincrby(topicsKey, term, actionWeight));
    }
    for (const term of entities) {
      ops.push(this.cache.hincrby(entitiesKey, term, actionWeight));
    }

    await Promise.all(ops);

    await Promise.all([
      this.cache.expire(actionsKey, USER_NEWS_BEHAVIOR_RETENTION_SECONDS),
      this.cache.expire(sourcesKey, USER_NEWS_BEHAVIOR_RETENTION_SECONDS),
      this.cache.expire(topicsKey, USER_NEWS_BEHAVIOR_RETENTION_SECONDS),
      this.cache.expire(entitiesKey, USER_NEWS_BEHAVIOR_RETENTION_SECONDS),
      this.cache.expire(itemsKey, USER_NEWS_BEHAVIOR_RETENTION_SECONDS),
      this.cache.expire(eventsKey, USER_NEWS_BEHAVIOR_RETENTION_SECONDS),
      this.cache.expire(domainsKey, USER_NEWS_BEHAVIOR_RETENTION_SECONDS),
    ]);

    return { recorded: true };
  }

  async getProfile(orgId: string, userId: string): Promise<UserNewsBehaviorProfile> {
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

    return {
      actions: this.parseScoreRecord(actionRaw),
      sources: this.parseScoreRecord(sourceRaw),
      topics: this.parseScoreRecord(topicRaw),
      entities: this.parseScoreRecord(entityRaw),
      items: this.parseScoreRecord(itemRaw, (value) => this.normalizeId(value)),
      events: this.parseScoreRecord(eventRaw, (value) => this.normalizeId(value)),
      domains: this.parseScoreRecord(domainRaw),
    };
  }

  async clearProfile(orgId: string, userId: string): Promise<{ cleared: true }> {
    const keys = USER_NEWS_BEHAVIOR_HASH_KINDS.map((kind) =>
      buildUserNewsBehaviorHashKey({ orgId, userId, kind }),
    );
    await this.cache.delMany(keys);
    return { cleared: true };
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
