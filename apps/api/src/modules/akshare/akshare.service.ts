import { AkshareResponseModel } from "@modular/mongo";
import { CommonTimeZone, ensureTraceId, getCurrentTraceId, parseDateTime, toISODateString } from "@modular/utils";
import { HttpService } from "@nestjs/axios";
import { Inject, Injectable, InternalServerErrorException, Logger, OnModuleInit } from "@nestjs/common";
import { EconomicDataFrequency, EconomicDataRunStatus, Prisma } from "@prisma/client";
import { Queue, type RepeatableJob, type RepeatOptions } from "bullmq";
import type Redis from "ioredis";
import { randomUUID } from "node:crypto";
import { lastValueFrom } from "rxjs";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { REDIS_CLIENT } from "../cache/cache.tokens";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";

import { AkshareParserService } from "./akshare-parser.service";
import { AKSHARE_QUEUE } from "./akshare.constants";
import { AKSHARE_DATA_DEFINITIONS } from "./akshare.definitions";
import {
  AkshareDataItemConfig,
  AkshareDataItemDefinition,
  AkshareDataItemMetadata,
  AkshareJobPayload,
  AkshareParserConfig,
  AksharePayloadFilterConfig,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  PaginatedResult,
  PaginationInput,
  PaginationMeta
} from "./akshare.types";
import type { ParsedDataPoint } from "./parsers";

interface FetchResult {
  definition: AkshareDataItemConfig;
  payload: unknown;
}

interface UpsertDataPointRow {
  recordedAt: Date;
  value: Prisma.Decimal;
  unit: string | null;
  dataType: string;
  sourceField: string;
  metaJson: string | null;
  estimatedBytes: number;
}

@Injectable()
export class AkshareService implements OnModuleInit {
  private readonly logger = new Logger(AkshareService.name);
  private readonly dataPointBatchSize = 1000;
  private readonly dataPointBatchMaxBytes = 2_000_000;
  private readonly forceParserSyncSlugs = new Set<string>([
    "global_epu_index",
    "china_fx_gold_reserves",
    "macro_fx_sentiment",
    "bitcoin_spot_price"
  ]);
  private readonly forceDefaultParamsSyncSlugs = new Set<string>([
    "macro_fx_sentiment",
    "market_sentiment_usdx",
    "bitcoin_spot_price",
    "usd_cny_spot",
    "eur_cny_spot"
  ]);
  private readonly forceFilterSyncSlugs = new Set<string>([
    "bitcoin_spot_price",
    "usd_cny_spot",
    "eur_cny_spot"
  ]);

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
    private readonly env: EnvService,
    private readonly parserService: AkshareParserService,
    @Inject(AKSHARE_QUEUE) private readonly queue: Queue<AkshareJobPayload>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis
  ) {}

  async onModuleInit() {
    if (!this.env.akshareConfig.enabled) {
      this.logger.log("Akshare disabled via AKSHARE_ENABLED=false; skipping catalog sync and repeatable jobs");
      await this.disableAkshareJobs();
      return;
    }

    await this.ensureCatalog();
    await this.ensureRepeatableJobs();
  }

  get definitions() {
    return AKSHARE_DATA_DEFINITIONS;
  }

  private buildSeedMetadata(definition: AkshareDataItemDefinition): AkshareDataItemMetadata {
    return {
      method: definition.method ?? "GET",
      defaultParams: definition.defaultParams ?? null,
      parser: definition.parser,
      tags: definition.tags ?? [],
      filter: definition.filter ?? null
    };
  }

  private parseFilter(filter: unknown): AksharePayloadFilterConfig | null | undefined {
    if (filter === null) {
      return null;
    }
    if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
      return undefined;
    }

    const raw = filter as Record<string, unknown>;
    const field = raw.field;
    const equals = raw.equals;
    if (typeof field !== "string" || !field.trim()) {
      return undefined;
    }
    if (typeof equals !== "string" || !equals.trim()) {
      return undefined;
    }

    const mode = raw.mode;
    const parsedMode = mode === "all" || mode === "best" || mode === "first" ? mode : undefined;
    const preferNonZeroField = typeof raw.preferNonZeroField === "string" ? raw.preferNonZeroField : undefined;
    const rankBy = typeof raw.rankBy === "string" ? raw.rankBy : undefined;
    const rankOrder = raw.rankOrder === "asc" || raw.rankOrder === "desc" ? raw.rankOrder : undefined;

    return {
      field,
      equals,
      mode: parsedMode,
      preferNonZeroField,
      rankBy,
      rankOrder
    };
  }

  private parseMetadata(metadata: Prisma.JsonValue | null): AkshareDataItemMetadata {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return {};
    }
    const parsed = metadata as Record<string, unknown>;
    const method = parsed.method === "POST" ? "POST" : parsed.method === "GET" ? "GET" : undefined;
    const defaultParams =
      parsed.defaultParams && typeof parsed.defaultParams === "object" && !Array.isArray(parsed.defaultParams)
        ? (parsed.defaultParams as Record<string, string | number>)
        : parsed.defaultParams === null
          ? null
          : undefined;
    const parser = parsed.parser as AkshareParserConfig | undefined;
    const filter = this.parseFilter(parsed.filter);
    const tags = Array.isArray(parsed.tags) ? parsed.tags.map((tag) => String(tag)) : undefined;

    return {
      method,
      defaultParams,
      parser,
      tags,
      filter
    };
  }

  private extractCustomMetadata(metadata: Prisma.JsonValue | null): Record<string, unknown> {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return {};
    }

    const parsed = metadata as Record<string, unknown>;
    const custom: Record<string, unknown> = { ...parsed };
    delete custom.method;
    delete custom.defaultParams;
    delete custom.parser;
    delete custom.tags;
    delete custom.filter;
    return custom;
  }

  private hasValidParser(parser: AkshareParserConfig | undefined): boolean {
    return Boolean(
      parser &&
      typeof (parser as { type?: unknown }).type === "string" &&
      (parser as { type?: string }).type
    );
  }

  private sanitizeExistingMetadata(metadata: AkshareDataItemMetadata): AkshareDataItemMetadata {
    if (!this.hasValidParser(metadata.parser)) {
      // Treat partial/invalid parser configs (e.g. missing `type`) as absent so we can fall back to the seed parser.
      return { ...metadata, parser: undefined };
    }
    return metadata;
  }

  private mergeMetadata(existing: AkshareDataItemMetadata, seed: AkshareDataItemMetadata): AkshareDataItemMetadata {
    return {
      method: existing.method ?? seed.method ?? "GET",
      defaultParams:
        existing.defaultParams === null
          ? null
          : existing.defaultParams ?? (seed.defaultParams === null ? null : seed.defaultParams),
      parser: existing.parser ?? seed.parser,
      tags: existing.tags ?? seed.tags,
      filter: existing.filter === null ? null : existing.filter ?? seed.filter
    };
  }

  private normalizeMetadata(metadata: AkshareDataItemMetadata) {
    return {
      method: metadata.method ?? "GET",
      defaultParams: metadata.defaultParams ?? null,
      parser: metadata.parser ?? null,
      tags: metadata.tags ?? [],
      filter: metadata.filter ?? null
    };
  }

  private metadataEquals(a: AkshareDataItemMetadata, b: AkshareDataItemMetadata) {
    return JSON.stringify(this.normalizeMetadata(a)) === JSON.stringify(this.normalizeMetadata(b));
  }

  private async loadDefinitionFromDatabase(slug: string): Promise<AkshareDataItemConfig> {
    const item = await this.prisma.economicDataItem.findUnique({
      where: { slug },
      include: {
        categories: {
          include: { category: true }
        }
      }
    });
    if (!item) {
      throw new InternalServerErrorException(`Data item ${slug} not found`);
    }

    const metadata = this.parseMetadata(item.metadata);
    if (!metadata.parser) {
      throw new InternalServerErrorException(`Akshare parser not configured for ${slug}`);
    }

    return {
      itemId: item.id,
      slug: item.slug,
      displayName: item.displayName,
      description: item.description,
      categories: item.categories.map((entry) => entry.category.key),
      sourceFunction: item.sourceFunction,
      endpoint: item.sourceEndpoint,
      docUrl: item.sourceDocUrl,
      method: metadata.method ?? "GET",
      defaultParams: metadata.defaultParams ?? null,
      filter: metadata.filter ?? null,
      valueType: item.valueType,
      defaultUnit: item.defaultUnit,
      defaultFrequency: item.defaultFrequency,
      parser: metadata.parser,
      tags: metadata.tags ?? []
    };
  }

  async ensureCatalog() {
    const startTime = Date.now();
    this.logger.log("ensureCatalog: Starting catalog synchronization");

    // Phase 1: Collect all category keys from definitions
    const categoryKeys = new Set<string>();
    for (const def of this.definitions) {
      def.categories.forEach((category) => categoryKeys.add(category));
    }

    // Phase 2: Batch load existing categories
    const existingCategories = await this.prisma.economicCategory.findMany({
      where: { key: { in: Array.from(categoryKeys) } }
    });
    const existingCategoryMap = new Map(existingCategories.map((cat) => [cat.key, cat]));

    // Phase 3: Batch create missing categories
    const missingCategoryKeys = Array.from(categoryKeys).filter((key) => !existingCategoryMap.has(key));
    if (missingCategoryKeys.length > 0) {
      await this.prisma.economicCategory.createMany({
        data: missingCategoryKeys.map((key) => ({
          key,
          label: key
            .split("-")
            .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
            .join(" ")
        })),
        skipDuplicates: true
      });
      // Reload categories to get IDs for newly created ones
      const allCategories = await this.prisma.economicCategory.findMany({
        where: { key: { in: Array.from(categoryKeys) } }
      });
      for (const cat of allCategories) {
        existingCategoryMap.set(cat.key, cat);
      }
    }
    this.logger.log(`ensureCatalog: Categories synced in ${Date.now() - startTime}ms`);

    // Phase 4: Batch load all existing data items (T1 - replaces N+1 findUnique calls)
    const slugs = this.definitions.map((d) => d.slug);
    const existingItems = await this.prisma.economicDataItem.findMany({
      where: { slug: { in: slugs } },
      include: {
        categories: {
          include: { category: true }
        },
        fetchConfig: true
      }
    });
    const existingItemMap = new Map(existingItems.map((item) => [item.slug, item]));
    this.logger.log(`ensureCatalog: Loaded ${existingItems.length} existing items in ${Date.now() - startTime}ms`);

    // Phase 5: Collect items for batch operations
    const newItemsData: {
      definition: AkshareDataItemDefinition;
      seedMetadata: AkshareDataItemMetadata;
      categories: { id: string; key: string }[];
    }[] = [];
    const itemUpdates: {
      id: string;
      data: Prisma.EconomicDataItemUpdateInput;
    }[] = [];
    const newCategoryRelations: {
      itemId: string;
      categoryId: string;
    }[] = [];
    const newFetchConfigs: {
      itemId: string;
      frequency: EconomicDataFrequency;
    }[] = [];

    // Phase 6: Process definitions and collect batch operations
    for (const definition of this.definitions) {
      const seedMetadata = this.buildSeedMetadata(definition);
      const existingItem = existingItemMap.get(definition.slug);

      const categories = definition.categories
        .map((categoryKey) => {
          const category = existingCategoryMap.get(categoryKey);
          if (!category) {
            this.logger.warn(`Missing category ${categoryKey} for ${definition.slug}`);
            return null;
          }
          return category;
        })
        .filter((category): category is NonNullable<typeof category> => Boolean(category));

      if (!existingItem) {
        // Collect for batch create (T2)
        newItemsData.push({ definition, seedMetadata, categories });
        continue;
      }

      // Collect updates (T3)
      const isMockSeed = existingItem.sourceFunction === "mock" && existingItem.sourceEndpoint === "mock";
      const existingMetadata = this.sanitizeExistingMetadata(this.parseMetadata(existingItem.metadata));
      const mergedMetadata = this.mergeMetadata(existingMetadata, seedMetadata);
      const mergedMetadataWithOverrides =
        this.forceParserSyncSlugs.has(definition.slug) || isMockSeed
          ? { ...mergedMetadata, parser: seedMetadata.parser }
          : mergedMetadata;
      const mergedMetadataWithOverridesFilter =
        this.forceFilterSyncSlugs.has(definition.slug) || isMockSeed
          ? { ...mergedMetadataWithOverrides, filter: seedMetadata.filter ?? null }
          : mergedMetadataWithOverrides;
      const mergedMetadataWithOverrides2 =
        this.forceDefaultParamsSyncSlugs.has(definition.slug) || isMockSeed
          ? { ...mergedMetadataWithOverridesFilter, defaultParams: seedMetadata.defaultParams ?? null }
          : mergedMetadataWithOverridesFilter;

      const updates: Prisma.EconomicDataItemUpdateInput = {};
      const matchesSeedFunction = existingItem.sourceFunction === definition.sourceFunction;
      const shouldSyncSource = matchesSeedFunction || isMockSeed;
      if (!existingItem.groupLabel && definition.categories[0]) {
        updates.groupLabel = definition.categories[0];
      }
      if (shouldSyncSource && existingItem.sourceFunction !== definition.sourceFunction) {
        updates.sourceFunction = definition.sourceFunction;
      }
      if (shouldSyncSource && existingItem.sourceEndpoint !== definition.endpoint) {
        updates.sourceEndpoint = definition.endpoint;
      }
      if (shouldSyncSource && existingItem.sourceDocUrl !== definition.docUrl) {
        updates.sourceDocUrl = definition.docUrl;
      }
      if (shouldSyncSource && existingItem.valueType !== definition.valueType) {
        updates.valueType = definition.valueType;
      }
      if (shouldSyncSource && existingItem.defaultUnit !== definition.defaultUnit) {
        updates.defaultUnit = definition.defaultUnit;
      }
      if (shouldSyncSource && existingItem.defaultFrequency !== definition.defaultFrequency) {
        updates.defaultFrequency = definition.defaultFrequency;
      }
      if (!existingItem.description && definition.description) {
        updates.description = definition.description;
      }
      if (!this.metadataEquals(existingMetadata, mergedMetadataWithOverrides2)) {
        const customMetadata = this.extractCustomMetadata(existingItem.metadata);
        updates.metadata = toPrismaJsonValue({
          ...customMetadata,
          ...this.normalizeMetadata(mergedMetadataWithOverrides2)
        });
      }

      if (Object.keys(updates).length > 0) {
        itemUpdates.push({ id: existingItem.id, data: updates });
      }

      // Collect missing category relations (T4)
      const existingCategoryKeys = new Set(existingItem.categories.map((entry) => entry.category.key));
      for (const category of categories) {
        if (!existingCategoryKeys.has(category.key)) {
          newCategoryRelations.push({
            itemId: existingItem.id,
            categoryId: category.id
          });
        }
      }

      // Collect missing fetch configs (T5)
      if (!existingItem.fetchConfig) {
        newFetchConfigs.push({
          itemId: existingItem.id,
          frequency: existingItem.defaultFrequency ?? definition.defaultFrequency
        });
      }
    }

    // Phase 7: Execute batch create for new items (T2)
    if (newItemsData.length > 0) {
      // createMany doesn't support nested creates, so we need to create items first
      // then create relations separately
      await this.prisma.economicDataItem.createMany({
        data: newItemsData.map(({ definition, seedMetadata }) => ({
          slug: definition.slug,
          displayName: definition.displayName,
          groupLabel: definition.categories[0],
          description: definition.description,
          sourceFunction: definition.sourceFunction,
          sourceEndpoint: definition.endpoint,
          sourceDocUrl: definition.docUrl,
          valueType: definition.valueType,
          defaultUnit: definition.defaultUnit,
          defaultFrequency: definition.defaultFrequency,
          metadata: toPrismaJsonValue(this.normalizeMetadata(seedMetadata))
        })),
        skipDuplicates: true
      });

      // Fetch newly created items to get their IDs
      const newSlugs = newItemsData.map((d) => d.definition.slug);
      const createdItems = await this.prisma.economicDataItem.findMany({
        where: { slug: { in: newSlugs } }
      });
      const createdItemMap = new Map(createdItems.map((item) => [item.slug, item]));

      // Collect category relations and fetch configs for new items
      for (const { definition, categories } of newItemsData) {
        const createdItem = createdItemMap.get(definition.slug);
        if (!createdItem) continue;

        for (const category of categories) {
          newCategoryRelations.push({
            itemId: createdItem.id,
            categoryId: category.id
          });
        }

        newFetchConfigs.push({
          itemId: createdItem.id,
          frequency: definition.defaultFrequency
        });
      }
      this.logger.log(`ensureCatalog: Created ${newItemsData.length} new items in ${Date.now() - startTime}ms`);
    }

    // Phase 8: Execute batch updates (T3)
    if (itemUpdates.length > 0) {
      await this.prisma.$transaction(
        itemUpdates.map(({ id, data }) =>
          this.prisma.economicDataItem.update({
            where: { id },
            data
          })
        )
      );
      this.logger.log(`ensureCatalog: Updated ${itemUpdates.length} items in ${Date.now() - startTime}ms`);
    }

    // Phase 9: Batch create category relations (T4)
    if (newCategoryRelations.length > 0) {
      await this.prisma.economicDataItemCategory.createMany({
        data: newCategoryRelations,
        skipDuplicates: true
      });
      this.logger.log(`ensureCatalog: Created ${newCategoryRelations.length} category relations in ${Date.now() - startTime}ms`);
    }

    // Phase 10: Batch create fetch configs (T5)
    if (newFetchConfigs.length > 0) {
      await this.prisma.economicDataFetchConfig.createMany({
        data: newFetchConfigs.map(({ itemId, frequency }) => ({
          itemId,
          frequency,
          repeatCron: null,
          isEnabled: true
        })),
        skipDuplicates: true
      });
      this.logger.log(`ensureCatalog: Created ${newFetchConfigs.length} fetch configs in ${Date.now() - startTime}ms`);
    }

    // Phase 11: Performance summary (T6)
    const totalTime = Date.now() - startTime;
    this.logger.log(
      `ensureCatalog: Completed in ${totalTime}ms - ` +
      `${this.definitions.length} definitions, ` +
      `${existingItems.length} existing, ` +
      `${newItemsData.length} created, ` +
      `${itemUpdates.length} updated`
    );
  }

  async ensureRepeatableJobs() {
    const lockKey = "akshare:repeatable-jobs:lock";
    const lockTtlMs = 60_000;
    const lockId = `${process.pid}:${Date.now()}`;
    const retryDelayMs = 250;
    const maxWaitMs = 5_000;

    let acquired = false;
    const start = Date.now();
    while (!acquired) {
      const lock = await this.redis.set(lockKey, lockId, "PX", lockTtlMs, "NX");
      if (lock) {
        acquired = true;
        break;
      }
      if (Date.now() - start >= maxWaitMs) {
        this.logger.log("Skipping ensureRepeatableJobs: lock already held by another instance");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }

    try {
      await this.syncRepeatableJobs();
    } finally {
      const releaseScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        end
        return 0
      `;
      try {
        await this.redis.eval(releaseScript, 1, lockKey, lockId);
      } catch (error) {
        this.logger.warn({ error }, "Failed to release Akshare repeatable jobs lock");
      }
    }
  }

  private async disableAkshareJobs(): Promise<void> {
    const repeatableJobs = await this.queue.getRepeatableJobs();
    for (const job of repeatableJobs) {
      await this.queue.removeRepeatableByKey(job.key);
    }

    await this.queue.drain(true);
  }

  private async syncRepeatableJobs() {
    const configs = await this.prisma.economicDataFetchConfig.findMany({
      include: { item: true }
    });
    const existingJobs = await this.queue.getRepeatableJobs();
    const configByJobName = new Map(
      configs.map((config) => [this.buildJobName(config.itemId), config])
    );
    for (const job of existingJobs) {
      const config = configByJobName.get(job.name ?? "");
      if (!config || !config.isEnabled) {
        await this.queue.removeRepeatableByKey(job.key);
      }
    }

    const existingByName = new Map(existingJobs.map((job) => [job.name ?? "", job]));
    for (const config of configs) {
      if (!config.isEnabled) {
        continue;
      }
      const jobName = this.buildJobName(config.itemId);
      const repeat = this.buildRepeatOptions(config.frequency, config.repeatCron);
      const existing = existingByName.get(jobName);
      if (existing && this.repeatMatches(existing, repeat)) {
        continue;
      }
      if (existing) {
        await this.queue.removeRepeatableByKey(existing.key);
      }
      await this.queue.add(
        jobName,
        { dataItemId: config.item.slug },
        {
          removeOnComplete: true,
          removeOnFail: false,
          repeat
        }
      );
    }
  }

  private buildRepeatOptions(frequency: EconomicDataFrequency, cron?: string | null): RepeatOptions {
    if (cron) {
      return { pattern: cron };
    }
    switch (frequency) {
      case "realtime":
        return { every: 30_000 };
      case "hourly":
        return { every: 60 * 60 * 1000 };
      case "daily":
        return { every: 24 * 60 * 60 * 1000 };
      case "weekly":
        return { every: 7 * 24 * 60 * 60 * 1000 };
      case "monthly":
        return { pattern: "0 0 1 * *" };
      default:
        return { every: 24 * 60 * 60 * 1000 };
    }
  }

  private buildJobName(itemId: string) {
    return `fetch:${itemId}`;
  }

  private repeatMatches(job: RepeatableJob, repeat: RepeatOptions) {
    if (repeat.every) {
      const jobEvery = typeof job.every === "string" ? Number(job.every) : undefined;
      return Number.isFinite(jobEvery) && jobEvery === repeat.every;
    }
    if (repeat.pattern) {
      return job.pattern === repeat.pattern;
    }
    return false;
  }

  async triggerDataFetch(slugs: string[], triggeredById?: string) {
    const traceId = ensureTraceId(getCurrentTraceId());
    for (const slug of slugs) {
      await this.queue.add(
        "manual-fetch",
        { dataItemId: slug, triggeredById, traceId },
        { removeOnComplete: true }
      );
    }
    return true;
  }

  async fetchAndPersist(slug: string) {
    let itemId: string | undefined;
    try {
      const definition = await this.loadDefinitionFromDatabase(slug);
      itemId = definition.itemId;
      const response = await this.executeRequest(definition);
      await AkshareResponseModel.create({
        dataItemId: definition.slug,
        endpoint: definition.endpoint,
        method: definition.method ?? "GET",
        requestParams: definition.defaultParams ?? {},
        payload: response.payload,
        fetchedAt: new Date()
      });

      const filteredPayload = this.applyPayloadFilter(response.payload, definition.filter);
      const parsedPoints = this.parserService.parsePayload(definition.parser, filteredPayload, { slug: definition.slug });
      const storedCount = await this.bulkUpsertDataPoints(definition.itemId, parsedPoints);

      await this.updateFetchStatusByItemId(definition.itemId, EconomicDataRunStatus.success);

      this.logger.log(`Stored ${storedCount} points for ${definition.slug}`);
      return storedCount;
    } catch (error) {
      try {
        if (itemId) {
          await this.updateFetchStatusByItemId(itemId, EconomicDataRunStatus.failed, error);
        } else {
          await this.recordFetchFailure(slug, error);
        }
      } catch (persistError) {
        this.logger.error(
          { slug, error: persistError },
          "Failed to record Akshare fetch failure status"
        );
      }
      throw error;
    }
  }

  private toRecordArray(payload: unknown): Record<string, unknown>[] {
    if (Array.isArray(payload)) {
      return payload.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item)
      );
    }
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      return [payload as Record<string, unknown>];
    }
    return [];
  }

  private normalizeNumeric(value: unknown): number | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed || trimmed === "--" || trimmed === "-" || trimmed.toLowerCase() === "nan" || trimmed.toLowerCase() === "null") {
        return null;
      }
      const sanitized = trimmed.replace(/,/g, "");
      const parsed = Number(sanitized);
      return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
  }

  private selectBestRecord(records: Record<string, unknown>[], filter: AksharePayloadFilterConfig) {
    const preferField = filter.preferNonZeroField;
    const rankBy = filter.rankBy;
    const rankOrder = filter.rankOrder ?? "desc";

    let best = records[0];
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const row of records) {
      const preferredValue = preferField ? this.normalizeNumeric(row[preferField]) : null;
      const hasPreferred = preferField ? Boolean(preferredValue && preferredValue > 0) : true;

      const rankValue = rankBy ? this.normalizeNumeric(row[rankBy]) ?? 0 : 0;
      const normalizedRank = rankOrder === "asc" ? -rankValue : rankValue;

      const score = (hasPreferred ? 1 : 0) * 1_000_000_000_000 + normalizedRank;
      if (score > bestScore) {
        best = row;
        bestScore = score;
      }
    }

    return best;
  }

  private applyPayloadFilter(payload: unknown, filter: AksharePayloadFilterConfig | null | undefined): unknown {
    if (!filter) {
      return payload;
    }

    const records = this.toRecordArray(payload);
    if (records.length === 0) {
      throw new InternalServerErrorException(`Payload filter expects record array (field=${filter.field})`);
    }

    const expected = filter.equals;
    const matches = records.filter((row) => String(row[filter.field] ?? "").trim() === expected);
    if (matches.length === 0) {
      throw new InternalServerErrorException(`Expected record not found: ${filter.field}=${expected}`);
    }

    const mode = filter.mode ?? "first";
    if (mode === "all") {
      return matches;
    }
    if (mode === "best") {
      return this.selectBestRecord(matches, filter);
    }
    return matches[0];
  }

  private async bulkUpsertDataPoints(itemId: string, points: ParsedDataPoint[]) {
    const deduped = new Map<string, ParsedDataPoint>();
    for (const point of points) {
      if (point.value === null || point.value === undefined) {
        continue;
      }
      if (typeof point.value === "number" && !Number.isFinite(point.value)) {
        continue;
      }
      const recordedAt = point.recordedAt instanceof Date ? point.recordedAt : new Date(point.recordedAt);
      const key = `${recordedAt.getTime()}|${point.sourceField}`;
      deduped.set(key, {
        ...point,
        recordedAt
      });
    }

    if (deduped.size === 0) {
      return 0;
    }

    const sortedPoints = Array.from(deduped.values()).sort((a, b) => {
      const diff = a.recordedAt.getTime() - b.recordedAt.getTime();
      if (diff !== 0) {
        return diff;
      }
      return a.sourceField.localeCompare(b.sourceField);
    });

    const rows = sortedPoints
      .map((point) => this.toUpsertDataPointRow(itemId, point))
      .filter((row): row is UpsertDataPointRow => Boolean(row));

    let chunk: UpsertDataPointRow[] = [];
    let chunkBytes = 0;
    for (const row of rows) {
      const wouldExceedRows = chunk.length >= this.dataPointBatchSize;
      const wouldExceedBytes = chunk.length > 0 && chunkBytes + row.estimatedBytes > this.dataPointBatchMaxBytes;
      if (wouldExceedRows || wouldExceedBytes) {
        await this.executeUpsertDataPointChunk(itemId, chunk);
        chunk = [];
        chunkBytes = 0;
      }
      chunk.push(row);
      chunkBytes += row.estimatedBytes;
    }
    if (chunk.length > 0) {
      await this.executeUpsertDataPointChunk(itemId, chunk);
    }

    return deduped.size;
  }

  private toUpsertDataPointRow(itemId: string, point: ParsedDataPoint): UpsertDataPointRow | null {
    if (point.value === null || point.value === undefined) {
      return null;
    }
    if (typeof point.value === "number" && !Number.isFinite(point.value)) {
      return null;
    }

    let metaJson: string | null = null;
    if (point.meta !== undefined) {
      try {
        metaJson = JSON.stringify(point.meta);
      } catch (error) {
        this.logger.warn(
          `Failed to serialize Akshare data point metadata (itemId=${itemId}, sourceField=${point.sourceField}): ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        metaJson = null;
      }
    }

    const unit = point.unit ?? null;
    const value = new Prisma.Decimal(point.value);
    const estimatedBytes = this.estimateUpsertDataPointRowBytes({
      itemId,
      recordedAt: point.recordedAt,
      dataType: point.dataType,
      value,
      unit,
      sourceField: point.sourceField,
      metaJson
    });

    return {
      recordedAt: point.recordedAt,
      dataType: point.dataType,
      value,
      unit,
      sourceField: point.sourceField,
      metaJson,
      estimatedBytes
    };
  }

  private estimateUpsertDataPointRowBytes(input: {
    itemId: string;
    recordedAt: Date;
    dataType: string;
    value: Prisma.Decimal;
    unit: string | null;
    sourceField: string;
    metaJson: string | null;
  }) {
    const recordedAt = input.recordedAt instanceof Date ? input.recordedAt.toISOString() : String(input.recordedAt);
    const value = input.value.toString();
    const fixedOverhead = 96;
    return (
      fixedOverhead +
      Buffer.byteLength(input.itemId, "utf8") +
      Buffer.byteLength(recordedAt, "utf8") +
      Buffer.byteLength(input.dataType, "utf8") +
      Buffer.byteLength(value, "utf8") +
      Buffer.byteLength(input.sourceField, "utf8") +
      (input.unit ? Buffer.byteLength(input.unit, "utf8") : 0) +
      (input.metaJson ? Buffer.byteLength(input.metaJson, "utf8") : 0)
    );
  }

  private isPacketTooLargeError(error: unknown) {
    if (!error || typeof error !== "object") {
      return false;
    }

    const anyError = error as {
      message?: unknown;
      meta?: { message?: unknown; code?: unknown };
      errno?: unknown;
      code?: unknown;
    };
    const topMessage = typeof anyError.message === "string" ? anyError.message : "";
    const metaMessage = typeof anyError.meta?.message === "string" ? anyError.meta.message : "";
    const message = `${topMessage} ${metaMessage}`.toLowerCase();
    if (message.includes("max_allowed_packet") || message.includes("packet") && message.includes("too")) {
      return true;
    }

    const metaCode = anyError.meta?.code;
    const errno = anyError.errno ?? anyError.code;
    return String(metaCode) === "1153" || String(errno) === "1153";
  }

  private async executeUpsertDataPointChunk(itemId: string, rows: UpsertDataPointRow[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    try {
      await this.prisma.$executeRaw(this.buildUpsertDataPointsQuery(itemId, rows));
    } catch (error) {
      if (this.isPacketTooLargeError(error) && rows.length > 1) {
        const mid = Math.ceil(rows.length / 2);
        await this.executeUpsertDataPointChunk(itemId, rows.slice(0, mid));
        await this.executeUpsertDataPointChunk(itemId, rows.slice(mid));
        return;
      }
      throw error;
    }
  }

  private buildUpsertDataPointsQuery(itemId: string, rows: UpsertDataPointRow[]) {
    const values = rows.map((row) => {
      return Prisma.sql`(${randomUUID()}, ${itemId}, ${row.recordedAt}, ${row.dataType}, ${row.value}, ${row.unit}, ${row.sourceField}, ${row.metaJson})`;
    });

    return Prisma.sql`
      INSERT INTO \`EconomicDataPoint\` (\`id\`, \`itemId\`, \`recordedAt\`, \`dataType\`, \`value\`, \`unit\`, \`sourceField\`, \`sourceMeta\`)
      VALUES ${Prisma.join(values)}
      ON DUPLICATE KEY UPDATE
        \`value\` = VALUES(\`value\`),
        \`unit\` = VALUES(\`unit\`),
        \`dataType\` = VALUES(\`dataType\`),
        \`sourceMeta\` = VALUES(\`sourceMeta\`)
    `;
  }

  private async executeRequest(definition: AkshareDataItemConfig): Promise<FetchResult> {
    const config = this.env.akshareConfig;
    const url = definition.endpoint.startsWith("http")
      ? definition.endpoint
      : `${config.baseUrl.replace(/\/$/, "")}${definition.endpoint.startsWith("/") ? "" : "/"}${definition.endpoint}`;
    const method = definition.method ?? "GET";
    const params = definition.defaultParams ? this.resolveParams(definition.defaultParams) : {};
    const request = async () => {
      const observable = this.http.request({
        method,
        url,
        params: method === "GET" ? params : undefined,
        data: method === "POST" ? params : undefined,
        timeout: config.timeoutMs
      });
      const response = await lastValueFrom(observable);
      return response.data;
    };

    const payload = await this.retry(request, config.maxRetries);
    return { definition, payload };
  }

  private resolveParams(params: Record<string, string | number>) {
    const resolved: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(params)) {
      resolved[key] = typeof value === "string" ? this.resolveParamTemplate(value) : value;
    }
    return resolved;
  }

  private resolveParamTemplate(value: string) {
    return value.replace(/\$\{TODAY_YYYYMMDD([+-]\d+)?\}/g, (_match, deltaRaw) => {
      const deltaDays = typeof deltaRaw === "string" ? Number(deltaRaw) : 0;
      if (!Number.isFinite(deltaDays)) {
        return this.getShanghaiDateYYYYMMDD(0);
      }
      return this.getShanghaiDateYYYYMMDD(deltaDays);
    });
  }

  private getShanghaiDateYYYYMMDD(deltaDays: number) {
    const now = new Date();
    const todayShanghai = toISODateString(now, CommonTimeZone.AsiaShanghai);
    const midnightShanghai =
      parseDateTime(`${todayShanghai} 00:00:00`, { timeZone: CommonTimeZone.AsiaShanghai }) ?? now;
    const shifted = new Date(midnightShanghai.getTime() + deltaDays * 24 * 60 * 60 * 1000);
    return toISODateString(shifted, CommonTimeZone.AsiaShanghai).replace(/-/g, "");
  }

  private async retry<T>(fn: () => Promise<T>, attempts: number) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt === attempts) {
          break;
        }
        const delayMs = Math.min(2000 * attempt, 10_000);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }

  private granularityRank(granularity: string): number {
    switch (granularity) {
      case "realtime":
        return 0;
      case "minute":
        return 1;
      case "hour":
        return 2;
      case "day":
        return 3;
      case "week":
        return 4;
      case "month":
        return 5;
      case "quarter":
        return 6;
      case "year":
        return 7;
      default:
        return 99;
    }
  }

  private defaultFrequencyToGranularity(frequency: EconomicDataFrequency | null | undefined): string {
    switch (frequency) {
      case EconomicDataFrequency.realtime:
        return "realtime";
      case EconomicDataFrequency.hourly:
        return "hour";
      case EconomicDataFrequency.weekly:
        return "week";
      case EconomicDataFrequency.monthly:
        return "month";
      case EconomicDataFrequency.daily:
      default:
        return "day";
    }
  }

  private coarsestGranularity(a: string, b: string): string {
    return this.granularityRank(a) >= this.granularityRank(b) ? a : b;
  }

  private bucketTimestamp(date: Date, granularity: string) {
    const d = new Date(date);
    switch (granularity) {
      case "realtime":
        break;
      case "minute":
        d.setUTCSeconds(0, 0);
        break;
      case "hour":
        d.setUTCMinutes(0, 0, 0);
        break;
      case "year":
        d.setUTCMonth(0, 1);
        d.setUTCHours(0, 0, 0, 0);
        break;
      case "quarter": {
        const quarterStartMonth = Math.floor(d.getUTCMonth() / 3) * 3;
        d.setUTCMonth(quarterStartMonth, 1);
        d.setUTCHours(0, 0, 0, 0);
        break;
      }
      case "month":
        d.setUTCDate(1);
        d.setUTCHours(0, 0, 0, 0);
        break;
      case "week": {
        const day = d.getUTCDay();
        const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
        d.setUTCDate(diff);
        d.setUTCHours(0, 0, 0, 0);
        break;
      }
      case "day":
      default:
        d.setUTCHours(0, 0, 0, 0);
    }
    return d.toISOString();
  }

  private encodeCursor(recordedAt: Date, id: string): string {
    const payload = `${recordedAt.toISOString()}|${id}`;
    return Buffer.from(payload, "utf8").toString("base64url");
  }

  private decodeCursor(cursor: string): { recordedAt: Date; id: string } | null {
    try {
      const payload = Buffer.from(cursor, "base64url").toString("utf8");
      const separatorIndex = payload.indexOf("|");
      if (separatorIndex === -1) {
        return null;
      }
      const recordedAtStr = payload.slice(0, separatorIndex);
      const id = payload.slice(separatorIndex + 1);
      const recordedAt = new Date(recordedAtStr);
      if (Number.isNaN(recordedAt.getTime()) || !id) {
        return null;
      }
      return { recordedAt, id };
    } catch {
      return null;
    }
  }

  private addGranularityInterval(start: Date, granularity: string): Date {
    const base = new Date(start);
    switch (granularity) {
      case "minute":
        return new Date(base.getTime() + 60_000);
      case "hour":
        return new Date(base.getTime() + 60 * 60_000);
      case "day":
        return new Date(base.getTime() + 24 * 60 * 60_000);
      case "week":
        return new Date(base.getTime() + 7 * 24 * 60 * 60_000);
      case "month":
        base.setUTCMonth(base.getUTCMonth() + 1);
        return base;
      case "quarter":
        base.setUTCMonth(base.getUTCMonth() + 3);
        return base;
      case "year":
        base.setUTCFullYear(base.getUTCFullYear() + 1);
        return base;
      default:
        return base;
    }
  }

  private alignRangeToGranularityUtc(start: Date, end: Date, granularity: string) {
    if (granularity === "realtime") {
      return { start, end };
    }

    const normalizedStart = new Date(this.bucketTimestamp(start, granularity));
    const normalizedEndBucketStart = new Date(this.bucketTimestamp(end, granularity));
    const nextBucketStart = this.addGranularityInterval(normalizedEndBucketStart, granularity);
    const normalizedEnd = new Date(nextBucketStart.getTime() - 1);
    return { start: normalizedStart, end: normalizedEnd };
  }

  async getDataByCategory(categoryKey: string, start: Date, end: Date, granularity?: string, pagination?: PaginationInput) {
    const range = granularity ? this.alignRangeToGranularityUtc(start, end, granularity) : { start, end };
    const limit = Math.min(pagination?.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);

    // Build where clause with optional cursor
    const whereClause: Prisma.EconomicDataPointWhereInput = {
      recordedAt: {
        gte: range.start,
        lte: range.end
      },
      item: {
        categories: {
          some: {
            category: {
              key: categoryKey
            }
          }
        }
      }
    };

    // Apply cursor-based pagination if cursor provided
    // Note: when granularity bucketing is requested we fetch the full window so the
    // aggregated buckets represent the entire range; cursor pagination is therefore ignored.
    if (pagination?.cursor && !granularity) {
      const decoded = this.decodeCursor(pagination.cursor);
      if (decoded) {
        whereClause.AND = [
          {
            OR: [
              { recordedAt: { gt: decoded.recordedAt } },
              {
                recordedAt: { equals: decoded.recordedAt },
                id: { gt: decoded.id }
              }
            ]
          }
        ];
      }
    }

    const points = await this.prisma.economicDataPoint.findMany({
      where: whereClause,
      include: {
        item: true
      },
      orderBy: [
        { recordedAt: "asc" },
        { id: "asc" }
      ],
      take: granularity ? undefined : limit + 1 // Fetch one extra to determine hasMore
    });

    if (granularity) {
      // Apply bucketing for granularity.
      // Important: bucket per-series (itemId + sourceField) to avoid mixing different indicators
      // that share the same category.
      const bucketed = new Map<
        string,
        { timestamp: Date; valueSum: number; count: number; sample: typeof points[number] }
      >();
      for (const point of points) {
        const effectiveGranularity = this.coarsestGranularity(
          granularity,
          this.defaultFrequencyToGranularity(point.item?.defaultFrequency)
        );
        const bucketKey = this.bucketTimestamp(point.recordedAt, effectiveGranularity);
        const seriesKey = `${point.itemId}::${point.sourceField ?? ""}::${bucketKey}`;
        const existing = bucketed.get(seriesKey);
        if (existing) {
          existing.valueSum += Number(point.value);
          existing.count += 1;
        } else {
          bucketed.set(seriesKey, {
            timestamp: new Date(bucketKey),
            valueSum: Number(point.value),
            count: 1,
            sample: point
          });
        }
      }
      const bucketedResults = Array.from(bucketed.values())
        .map((entry) => {
          const aggregated = entry.sample;
          return {
            ...aggregated,
            recordedAt: entry.timestamp,
            value: new Prisma.Decimal(entry.valueSum / entry.count)
          };
        })
        .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());

      if (pagination) {
        return {
          data: bucketedResults,
          pagination: {
            hasMore: false,
            totalCount: bucketedResults.length
          }
        } as PaginatedResult<typeof bucketedResults[number]>;
      }

      return bucketedResults;
    }

    // Determine if there are more results
    const hasMore = points.length > limit;
    const resultPoints = hasMore ? points.slice(0, limit) : points;
    const lastPoint = resultPoints.at(-1);

    // Build pagination meta
    const paginationMeta: PaginationMeta = {
      hasMore,
      nextCursor: hasMore && lastPoint
        ? this.encodeCursor(lastPoint.recordedAt, lastPoint.id)
        : undefined
    };

    // Return paginated result if pagination was requested, otherwise return legacy format
    if (pagination) {
      return { data: resultPoints, pagination: paginationMeta } as PaginatedResult<typeof resultPoints[number]>;
    }
    return resultPoints;
  }

  async listFetchConfigs() {
    return this.prisma.economicDataFetchConfig.findMany({
      include: {
        item: {
          include: {
            categories: {
              include: { category: true }
            }
          }
        }
      },
      orderBy: { updatedAt: "desc" }
    });
  }

  async updateFetchConfig(
    itemSlug: string,
    input: { frequency?: EconomicDataFrequency; repeatCron?: string | null; isEnabled?: boolean }
  ) {
    const item = await this.prisma.economicDataItem.findUnique({ where: { slug: itemSlug } });
    if (!item) {
      throw new InternalServerErrorException(`Data item ${itemSlug} not found`);
    }
    const updated = await this.prisma.economicDataFetchConfig.update({
      where: { itemId: item.id },
      data: {
        frequency: input.frequency ?? undefined,
        repeatCron: input.repeatCron === undefined ? undefined : input.repeatCron,
        isEnabled: input.isEnabled ?? undefined
      },
      include: { item: true }
    });
    await this.ensureRepeatableJobs();
    return updated;
  }

  private formatError(error: unknown) {
    const maxLength = 191;
    const truncate = (message: string) => {
      if (message.length <= maxLength) {
        return message;
      }
      return `${message.slice(0, Math.max(0, maxLength - 3))}...`;
    };

    if (error instanceof Error) {
      return truncate(error.message);
    }
    if (typeof error === "string") {
      return truncate(error);
    }
    try {
      return truncate(JSON.stringify(error));
    } catch {
      return truncate(String(error));
    }
  }

  private async updateFetchStatusByItemId(itemId: string, status: EconomicDataRunStatus, error?: unknown) {
    await this.prisma.economicDataFetchConfig.update({
      where: { itemId },
      data: {
        lastRunAt: new Date(),
        lastStatus: status,
        lastError: error ? this.formatError(error) : null,
        updatedAt: new Date()
      }
    });
  }

  async recordFetchFailure(slug: string, error: unknown) {
    try {
      const item = await this.prisma.economicDataItem.findUnique({ where: { slug } });
      if (!item) {
        this.logger.error(`Failed to update fetch status for ${slug}: item not found`);
        return;
      }
      await this.updateFetchStatusByItemId(item.id, EconomicDataRunStatus.failed, error);
    } catch (updateError) {
      this.logger.error(
        { slug, error: updateError },
        "Failed to persist Akshare fetch failure status"
      );
    }
  }
}
