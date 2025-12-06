import { HttpService } from "@nestjs/axios";
import { Inject, Injectable, InternalServerErrorException, Logger, OnModuleInit } from "@nestjs/common";
import { EconomicDataRunStatus, Prisma } from "@prisma/client";
import { lastValueFrom } from "rxjs";
import { Queue, type RepeatJob, type RepeatOptions } from "bullmq";
import type Redis from "ioredis";
import { AKSHARE_DATA_DEFINITIONS } from "./akshare.definitions";
import {
  AkshareDataItemConfig,
  AkshareDataItemDefinition,
  AkshareDataItemMetadata,
  AkshareJobPayload,
  AkshareParserConfig
} from "./akshare.types";
import { PrismaService } from "../config/prisma.service";
import { AKSHARE_QUEUE } from "./akshare.constants";
import { AkshareResponseModel } from "@modular/mongo";
import { EnvService } from "../config/config.service";
import { REDIS_CLIENT } from "../cache/cache.module";

interface FetchResult {
  definition: AkshareDataItemConfig;
  payload: unknown;
}

@Injectable()
export class AkshareService implements OnModuleInit {
  private readonly logger = new Logger(AkshareService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
    private readonly env: EnvService,
    @Inject(AKSHARE_QUEUE) private readonly queue: Queue<AkshareJobPayload>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis
  ) {}

  async onModuleInit() {
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
      tags: definition.tags ?? []
    };
  }

  private parseMetadata(metadata: Prisma.JsonValue | null): AkshareDataItemMetadata {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return {};
    }
    const parsed = metadata as Record<string, any>;
    const method = parsed.method === "POST" ? "POST" : parsed.method === "GET" ? "GET" : undefined;
    const defaultParams =
      parsed.defaultParams && typeof parsed.defaultParams === "object" && !Array.isArray(parsed.defaultParams)
        ? (parsed.defaultParams as Record<string, string | number>)
        : parsed.defaultParams === null
          ? null
          : undefined;
    const parser = parsed.parser as AkshareParserConfig | undefined;
    const tags = Array.isArray(parsed.tags) ? parsed.tags.map((tag) => String(tag)) : undefined;

    return {
      method,
      defaultParams,
      parser,
      tags
    };
  }

  private mergeMetadata(existing: AkshareDataItemMetadata, seed: AkshareDataItemMetadata): AkshareDataItemMetadata {
    return {
      method: existing.method ?? seed.method ?? "GET",
      defaultParams:
        existing.defaultParams === null
          ? null
          : existing.defaultParams ?? (seed.defaultParams === null ? null : seed.defaultParams),
      parser: existing.parser ?? seed.parser,
      tags: existing.tags ?? seed.tags
    };
  }

  private normalizeMetadata(metadata: AkshareDataItemMetadata) {
    return {
      method: metadata.method ?? "GET",
      defaultParams: metadata.defaultParams ?? null,
      parser: metadata.parser ?? null,
      tags: metadata.tags ?? []
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
      valueType: item.valueType,
      defaultUnit: item.defaultUnit,
      defaultFrequency: item.defaultFrequency,
      parser: metadata.parser,
      tags: metadata.tags ?? []
    };
  }

  async ensureCatalog() {
    const categoryKeys = new Set<string>();
    for (const def of this.definitions) {
      def.categories.forEach((category) => categoryKeys.add(category));
    }

    const existingCategories = await this.prisma.economicCategory.findMany({
      where: { key: { in: Array.from(categoryKeys) } }
    });
    const existingCategoryMap = new Map(existingCategories.map((cat) => [cat.key, cat]));

    for (const categoryKey of categoryKeys) {
      if (!existingCategoryMap.has(categoryKey)) {
        const created = await this.prisma.economicCategory.create({
          data: {
            key: categoryKey,
            label: categoryKey
              .split("-")
              .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
              .join(" ")
          }
        });
        existingCategoryMap.set(categoryKey, created);
      }
    }

    for (const definition of this.definitions) {
      const seedMetadata = this.buildSeedMetadata(definition);
      const existingItem = await this.prisma.economicDataItem.findUnique({
        where: { slug: definition.slug },
        include: {
          categories: {
            include: { category: true }
          },
          fetchConfig: true
        }
      });

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
        await this.prisma.economicDataItem.create({
          data: {
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
            metadata: this.normalizeMetadata(seedMetadata),
            categories: {
              create: categories.map((category) => ({
                category: { connect: { id: category.id } }
              }))
            },
            fetchConfig: {
              create: {
                frequency: definition.defaultFrequency,
                repeatCron: null,
                isEnabled: true
              }
            }
          }
        });
        continue;
      }

      const existingMetadata = this.parseMetadata(existingItem.metadata);
      const mergedMetadata = this.mergeMetadata(existingMetadata, seedMetadata);

      const updates: Prisma.EconomicDataItemUpdateInput = {};
      if (!existingItem.groupLabel && definition.categories[0]) {
        updates.groupLabel = definition.categories[0];
      }
      if (!this.metadataEquals(existingMetadata, mergedMetadata)) {
        updates.metadata = this.normalizeMetadata(mergedMetadata);
      }

      if (Object.keys(updates).length > 0) {
        await this.prisma.economicDataItem.update({
          where: { id: existingItem.id },
          data: updates
        });
      }

      const existingCategoryKeys = new Set(existingItem.categories.map((entry) => entry.category.key));
      for (const category of categories) {
        if (!existingCategoryKeys.has(category.key)) {
          await this.prisma.economicDataItemCategory.create({
            data: {
              itemId: existingItem.id,
              categoryId: category.id
            }
          });
        }
      }

      if (!existingItem.fetchConfig) {
        await this.prisma.economicDataFetchConfig.create({
          data: {
            itemId: existingItem.id,
            frequency: existingItem.defaultFrequency ?? definition.defaultFrequency,
            repeatCron: null,
            isEnabled: true
          }
        });
      }
    }
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

  private buildRepeatOptions(frequency: Prisma.EconomicDataFrequency, cron?: string): RepeatOptions {
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

  private repeatMatches(job: RepeatJob, repeat: RepeatOptions) {
    if (repeat.every) {
      return job.every === repeat.every;
    }
    if (repeat.pattern) {
      return job.pattern === repeat.pattern;
    }
    return false;
  }

  async triggerDataFetch(slugs: string[], triggeredById?: string) {
    for (const slug of slugs) {
      await this.queue.add("manual-fetch", { dataItemId: slug, triggeredById }, { removeOnComplete: true });
    }
    return true;
  }

  async fetchAndPersist(slug: string, triggeredById?: string) {
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

      const parsedPoints = this.parsePayload(definition.parser, response.payload);
      for (const point of parsedPoints) {
        await this.prisma.economicDataPoint.upsert({
          where: {
            itemId_recordedAt_sourceField: {
              itemId: definition.itemId,
              recordedAt: point.recordedAt,
              sourceField: point.sourceField
            }
          },
          update: {
            value: new Prisma.Decimal(point.value),
            unit: point.unit,
            dataType: point.dataType
          },
          create: {
            itemId: definition.itemId,
            recordedAt: point.recordedAt,
            dataType: point.dataType,
            value: new Prisma.Decimal(point.value),
            unit: point.unit,
            sourceField: point.sourceField,
            sourceMeta: point.meta ?? null
          }
        });
      }

      await this.updateFetchStatusByItemId(definition.itemId, EconomicDataRunStatus.success);

      this.logger.log(`Stored ${parsedPoints.length} points for ${definition.slug}`);
      return parsedPoints.length;
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

  private async executeRequest(definition: AkshareDataItemConfig): Promise<FetchResult> {
    const config = this.env.akshareConfig;
    const url = definition.endpoint.startsWith("http")
      ? definition.endpoint
      : `${config.baseUrl.replace(/\/$/, "")}${definition.endpoint.startsWith("/") ? "" : "/"}${definition.endpoint}`;
    const method = definition.method ?? "GET";
    const params = definition.defaultParams ?? {};
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

  private parsePayload(parser: AkshareParserConfig, payload: any) {
    switch (parser.type) {
      case "latest":
        return this.parseLatestPayload(parser, payload);
      case "timeseries":
        return this.parseTimeseriesPayload(parser, payload);
      case "macro":
        return this.parseMacroPayload(parser, payload);
      case "yieldCurve":
        return this.parseYieldCurvePayload(parser, payload);
      default:
        return [];
    }
  }

  private parseLatestPayload(parser: Extract<AkshareParserConfig, { type: "latest" }>, payload: any) {
    const records = Array.isArray(payload) ? payload : [payload];
    const now = new Date();
    const dedupe = new Set<string>();
    return records.flatMap((record: Record<string, any>) =>
      parser.valueFields.flatMap((field) => {
        const timestamp = parser.timestampField && record[parser.timestampField] ? this.parseDate(record[parser.timestampField]) : now;
        const category = parser.categoryField ? record[parser.categoryField] : undefined;
        const sourceField = category ? `${category}:${field.field}` : field.field;
        const key = `${timestamp.getTime()}|${sourceField}`;
        if (dedupe.has(key)) {
          return [];
        }
        dedupe.add(key);
        return {
          recordedAt: timestamp,
          value: this.normalizeNumber(record[field.field]),
          unit: field.unit,
          dataType: field.dataType ?? "price",
          sourceField,
          meta: record
        };
      })
    );
  }

  private parseTimeseriesPayload(parser: Extract<AkshareParserConfig, { type: "timeseries" }>, payload: any[]) {
    const records = Array.isArray(payload) ? payload : [];
    const seen = new Set<string>();
    return records.flatMap((record) => {
      const timestampValue = record[parser.timestampField];
      const recordedAt = this.parseDate(timestampValue);
      return parser.valueFields
        .map((field) => {
          const category = parser.categoryField ? record[parser.categoryField] : undefined;
          const sourceField = category ? `${category}:${field.field}` : field.field;
          const dedupeKey = `${recordedAt.getTime()}|${sourceField}`;
          if (seen.has(dedupeKey)) {
            return undefined;
          }
          seen.add(dedupeKey);
          return {
            recordedAt,
            value: this.normalizeNumber(record[field.field]),
            unit: field.unit,
            dataType: field.dataType ?? "price",
            sourceField,
            meta: record
          };
        })
        .filter((point) => point.value !== null);
    });
  }

  private parseMacroPayload(parser: Extract<AkshareParserConfig, { type: "macro" }>, payload: any[]) {
    const records = Array.isArray(payload) ? payload : [];
    const seen = new Set<string>();
    return records.flatMap((record) => {
      const recordedAt = this.parseDate(record[parser.periodField]);
      return parser.valueFields
        .map((field) => {
          const category = parser.categoryField ? record[parser.categoryField] : undefined;
          const sourceField = category ? `${category}:${field.field}` : field.field;
          const dedupeKey = `${recordedAt.getTime()}|${sourceField}`;
          if (seen.has(dedupeKey)) {
            return undefined;
          }
          seen.add(dedupeKey);
          return {
            recordedAt,
            value: this.normalizeNumber(record[field.field]),
            unit: field.unit,
            dataType: field.dataType ?? "index",
            sourceField,
            meta: record
          };
        })
        .filter((point) => point.value !== null);
    });
  }

  private parseYieldCurvePayload(parser: Extract<AkshareParserConfig, { type: "yieldCurve" }>, payload: any[]) {
    const records = Array.isArray(payload) ? payload : [];
    return records.flatMap((record) => {
      const recordedAt = this.parseDate(record[parser.dateField]);
      return parser.seriesFields
        .map((field) => ({
          recordedAt,
          value: this.normalizeNumber(record[field.field]),
          unit: field.unit ?? "%",
          dataType: field.dataType ?? "yield",
          sourceField: field.field,
          meta: record
        }))
        .filter((point) => point.value !== null);
    });
  }

  private parseDate(value: unknown) {
    if (value instanceof Date) {
      return value;
    }
    if (typeof value === "number") {
      return new Date(value);
    }
    if (typeof value === "string") {
      const normalized = value
        .replace(/年/g, "-")
        .replace(/月/g, "-")
        .replace(/日/g, "")
        .replace(/--/g, "-");
      const parsed = new Date(normalized);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }
    return new Date();
  }

  private normalizeNumber(value: unknown): number | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed || trimmed === "--" || trimmed === "-" || trimmed === "NaN" || trimmed === "null") {
        return null;
      }
      const sanitized = trimmed.replace(/,/g, "").replace(/%/g, "");
      if (!sanitized) {
        return null;
      }
      const parsed = Number(sanitized);
      return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
  }

  private bucketTimestamp(date: Date, granularity: string) {
    const d = new Date(date);
    switch (granularity) {
      case "year":
        d.setMonth(0, 1);
        d.setHours(0, 0, 0, 0);
        break;
      case "quarter": {
        const quarterStartMonth = Math.floor(d.getMonth() / 3) * 3;
        d.setMonth(quarterStartMonth, 1);
        d.setHours(0, 0, 0, 0);
        break;
      }
      case "month":
        d.setDate(1);
        d.setHours(0, 0, 0, 0);
        break;
      case "week": {
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        d.setDate(diff);
        d.setHours(0, 0, 0, 0);
        break;
      }
      case "day":
      default:
        d.setHours(0, 0, 0, 0);
    }
    return d.toISOString();
  }

  async getDataByCategory(categoryKey: string, start: Date, end: Date, granularity?: string) {
    const points = await this.prisma.economicDataPoint.findMany({
      where: {
        recordedAt: {
          gte: start,
          lte: end
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
      },
      include: {
        item: true
      },
      orderBy: { recordedAt: "asc" }
    });
    if (!granularity) {
      return points;
    }
    const bucketed = new Map<string, { timestamp: Date; valueSum: number; count: number; sample: typeof points[number] }>();
    for (const point of points) {
      const bucketKey = this.bucketTimestamp(point.recordedAt, granularity);
      const existing = bucketed.get(bucketKey);
      if (existing) {
        existing.valueSum += Number(point.value);
        existing.count += 1;
      } else {
        bucketed.set(bucketKey, {
          timestamp: new Date(bucketKey),
          valueSum: Number(point.value),
          count: 1,
          sample: point
        });
      }
    }
    return Array.from(bucketed.values())
      .map((entry) => {
        const aggregated = entry.sample;
        return {
          ...aggregated,
          recordedAt: entry.timestamp,
          value: new Prisma.Decimal(entry.valueSum / entry.count)
        };
      })
      .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
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

  async updateFetchConfig(itemSlug: string, input: { frequency?: Prisma.EconomicDataFrequency; repeatCron?: string | null; isEnabled?: boolean }) {
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
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === "string") {
      return error;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
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
