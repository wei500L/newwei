import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

import {
  getDefaultNewsEventSourcePolicy,
  normalizeSourcePolicy,
  type NewsEventSourcePolicy,
} from "./news-event-source-classifier";

export interface NewsEventSourcePolicyInput {
  authoritativeDomains: string[];
  authoritativeLabels: string[];
  blogDomains: string[];
  blogLabels: string[];
}

const SETTINGS_CACHE_TTL_SECONDS = 60;
const CACHE_KEY_PREFIX = "newsEvents:sourcePolicy:";
const SYSTEM_SETTING_KEY_PREFIX = "news_event_source_policy:";

@Injectable()
export class NewsEventSourcePolicyService {
  private readonly logger = createLogger({ name: "news-event-source-policy" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async getPolicy(orgId: string): Promise<NewsEventSourcePolicy> {
    const cacheKey = this.cacheKey(orgId);

    let cached: NewsEventSourcePolicy | null = null;
    try {
      cached = await this.cache.get<NewsEventSourcePolicy>(cacheKey);
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to read news event source policy from cache; falling back to database",
      );
    }

    if (cached) {
      return normalizeSourcePolicy(cached, this.getFallbackPolicy());
    }

    let policy: NewsEventSourcePolicy;
    try {
      policy = await this.loadPolicy(orgId);
    } catch (error) {
      policy = this.getFallbackPolicy();
      this.logger.warn(
        { err: error, orgId },
        "Failed to load news event source policy from database; using defaults",
      );
    }

    try {
      await this.cache.set(cacheKey, policy, SETTINGS_CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to write news event source policy to cache",
      );
    }

    return policy;
  }

  async updatePolicy(
    orgId: string,
    actorId: string,
    input: NewsEventSourcePolicyInput,
  ): Promise<NewsEventSourcePolicy> {
    const normalized = normalizeSourcePolicy(input, this.getFallbackPolicy());
    const key = this.systemSettingKey(orgId);

    await this.prisma.systemSetting.upsert({
      where: { key },
      update: {
        value: toPrismaJsonValue(normalized),
        updatedById: actorId,
        description: `News event source policy (org=${orgId})`,
      },
      create: {
        key,
        value: toPrismaJsonValue(normalized),
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
          action: "news_event_source_policy_update",
          metadata: toPrismaJsonValue(normalized),
        },
      },
      {
        orgId,
        actorId,
        resource: "system_settings",
        action: "news_event_source_policy_update",
      },
    );

    await this.cache.set(
      this.cacheKey(orgId),
      normalized,
      SETTINGS_CACHE_TTL_SECONDS,
    );
    return normalized;
  }

  async invalidateCache(orgId: string) {
    await this.cache.del(this.cacheKey(orgId));
  }

  private async loadPolicy(orgId: string): Promise<NewsEventSourcePolicy> {
    const fallback = this.getFallbackPolicy();
    const record = await this.prisma.systemSetting.findUnique({
      where: { key: this.systemSettingKey(orgId) },
    });
    const raw = record?.value as
      | Partial<NewsEventSourcePolicyInput>
      | undefined;
    return normalizeSourcePolicy(raw ?? {}, fallback);
  }

  private getFallbackPolicy(): NewsEventSourcePolicy {
    return getDefaultNewsEventSourcePolicy();
  }

  private systemSettingKey(orgId: string) {
    return `${SYSTEM_SETTING_KEY_PREFIX}${orgId}`;
  }

  private cacheKey(orgId: string) {
    return `${CACHE_KEY_PREFIX}${orgId}`;
  }
}
