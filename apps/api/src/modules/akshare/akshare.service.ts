import { HttpService } from "@nestjs/axios";
import { Inject, Injectable, InternalServerErrorException, Logger, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { lastValueFrom } from "rxjs";
import { Queue } from "bullmq";
import { AKSHARE_DATA_DEFINITIONS } from "./akshare.definitions";
import { AkshareDataItemDefinition, AkshareJobPayload, AkshareParserConfig } from "./akshare.types";
import { PrismaService } from "../config/prisma.service";
import { AKSHARE_QUEUE } from "./akshare.constants";
import { AkshareResponseModel } from "@modular/mongo";
import { EnvService } from "../config/config.service";

interface FetchResult {
  definition: AkshareDataItemDefinition;
  payload: unknown;
}

@Injectable()
export class AkshareService implements OnModuleInit {
  private readonly logger = new Logger(AkshareService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
    private readonly env: EnvService,
    @Inject(AKSHARE_QUEUE) private readonly queue: Queue<AkshareJobPayload>
  ) {}

  async onModuleInit() {
    await this.ensureCatalog();
    await this.ensureRepeatableJobs();
  }

  get definitions() {
    return AKSHARE_DATA_DEFINITIONS;
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
      const item = await this.prisma.economicDataItem.upsert({
        where: { slug: definition.slug },
        update: {
          displayName: definition.displayName,
          groupLabel: definition.categories[0],
          description: definition.description,
          sourceFunction: definition.sourceFunction,
          sourceEndpoint: definition.endpoint,
          sourceDocUrl: definition.docUrl,
          valueType: definition.valueType,
          defaultUnit: definition.defaultUnit,
          defaultFrequency: definition.defaultFrequency,
          metadata: {
            method: definition.method ?? "GET",
            defaultParams: definition.defaultParams ?? null
          }
        },
        create: {
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
          metadata: {
            method: definition.method ?? "GET",
            defaultParams: definition.defaultParams ?? null
          }
        }
      });

      await this.prisma.economicDataItemCategory.deleteMany({ where: { itemId: item.id } });
      for (const categoryKey of definition.categories) {
        const category = existingCategoryMap.get(categoryKey);
        if (!category) {
          this.logger.warn(`Missing category ${categoryKey} for ${definition.slug}`);
          continue;
        }
        await this.prisma.economicDataItemCategory.create({
          data: {
            itemId: item.id,
            categoryId: category.id
          }
        });
      }

      await this.prisma.economicDataFetchConfig.upsert({
        where: { itemId: item.id },
        update: {},
        create: {
          itemId: item.id,
          frequency: definition.defaultFrequency,
          repeatCron: null,
          isEnabled: true
        }
      });
    }
  }

  async ensureRepeatableJobs() {
    const configs = await this.prisma.economicDataFetchConfig.findMany({
      include: { item: true }
    });
    await this.queue.drain(true);
    for (const config of configs) {
      if (!config.isEnabled) {
        continue;
      }
      await this.queue.add(
        `fetch:${config.itemId}`,
        { dataItemId: config.item.slug },
        {
          removeOnComplete: true,
          removeOnFail: false,
          repeat: this.buildRepeatOptions(config.frequency, config.repeatCron)
        }
      );
    }
  }

  private buildRepeatOptions(frequency: Prisma.EconomicDataFrequency, cron?: string) {
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

  async triggerDataFetch(slugs: string[], triggeredById?: string) {
    for (const slug of slugs) {
      await this.queue.add("manual-fetch", { dataItemId: slug, triggeredById }, { removeOnComplete: true });
    }
    return true;
  }

  async fetchAndPersist(slug: string, triggeredById?: string) {
    const definition = this.definitions.find((entry) => entry.slug === slug);
    if (!definition) {
      throw new InternalServerErrorException(`Unknown Akshare definition: ${slug}`);
    }
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
    const dbItem = await this.prisma.economicDataItem.findUnique({ where: { slug: definition.slug } });
    if (!dbItem) {
      throw new InternalServerErrorException(`Missing catalog entry for ${definition.slug}`);
    }

    for (const point of parsedPoints) {
      await this.prisma.economicDataPoint.upsert({
        where: {
          itemId_recordedAt_sourceField: {
            itemId: dbItem.id,
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
          itemId: dbItem.id,
          recordedAt: point.recordedAt,
          dataType: point.dataType,
          value: new Prisma.Decimal(point.value),
          unit: point.unit,
          sourceField: point.sourceField,
          sourceMeta: point.meta ?? null
        }
      });
    }

    await this.prisma.economicDataFetchConfig.update({
      where: { itemId: dbItem.id },
      data: {
        lastRunAt: new Date(),
        lastStatus: "success",
        lastError: null,
        updatedAt: new Date()
      }
    });

    this.logger.log(`Stored ${parsedPoints.length} points for ${definition.slug}`);
    return parsedPoints.length;
  }

  private async executeRequest(definition: AkshareDataItemDefinition): Promise<FetchResult> {
    const config = this.env.akshareConfig;
    const url = definition.endpoint.startsWith("http")
      ? definition.endpoint
      : `${config.baseUrl.replace(/\/$/, "")}${definition.endpoint.startsWith("/") ? "" : "/"}${definition.endpoint}`;
    const method = definition.method ?? "GET";
    const params = definition.defaultParams ?? {};
    const observable = this.http.request({
      method,
      url,
      params: method === "GET" ? params : undefined,
      data: method === "POST" ? params : undefined,
      timeout: config.timeoutMs
    });
    const response = await lastValueFrom(observable);
    return { definition, payload: response.data };
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

  async getDataByCategory(categoryKey: string, start: Date, end: Date) {
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
    return points;
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
}
