import {
  AkshareResponseModel,
  EconomicProviderResponseModel,
} from "@modular/mongo";
import {
  ECONOMIC_DASHBOARD_REFRESH_PRESET_CONFIG,
  ensureTraceId,
  getCurrentTraceId,
  type EconomicDashboardRefreshPreset,
} from "@modular/utils";
import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import {
  EconomicDataFrequency,
  EconomicDataRunStatus,
  Prisma,
} from "@prisma/client";
import { Queue, type RepeatableJob, type RepeatOptions } from "bullmq";
import type Redis from "ioredis";
import { randomUUID } from "node:crypto";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { REDIS_CLIENT } from "../cache/cache.tokens";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { PrismaService } from "../config/prisma.service";

import { AKSHARE_QUEUE } from "./akshare.constants";
import { FINANCIAL_DATA_DEFINITIONS } from "./financial-data.definitions";
import {
  AkshareFinancialDataProviderConfig,
  FinancialDataDefinitionMetadata,
  FinancialDataItemConfig,
  FinancialDataItemDefinition,
  FinancialDataMainlineRole,
  FinancialDataProviderConfig,
  FinancialDataProviderKind,
  FinancialDataRequiredSecret,
  FinancialDataSnapshotMetadata,
  FinancialDataVisualizationMetadata,
} from "./financial-data.types";
import {
  AkshareDataItemMetadata,
  AkshareJobPayload,
  AkshareParserConfig,
  AksharePayloadFilterConfig,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  PaginatedResult,
  PaginationInput,
  PaginationMeta,
} from "./akshare.types";
import type { ParsedDataPoint } from "./parsers";
import {
  type FinancialDataProviderCleanup,
  FinancialDataProviderConfigurationError,
  FinancialDataProviderRegistry,
} from "./providers/financial-data-provider";

interface UpsertDataPointRow {
  recordedAt: Date;
  value: Prisma.Decimal;
  unit: string | null;
  dataType: string;
  sourceField: string;
  metaJson: string | null;
  estimatedBytes: number;
}

interface EconomicRefreshTriggerContext {
  actorId?: string | null;
  orgId?: string | null;
  ipAddress?: string | null;
}

export interface EconomicRefreshPresetStatusSummary {
  preset: EconomicDashboardRefreshPreset;
  categoryKey: string;
  totalItems: number;
  enabledItems: number;
  lastRunAt: Date | null;
  lastStatus: EconomicDataRunStatus | null;
  lastError: string | null;
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
    "bitcoin_spot_price",
    "sp500_index",
    "platinum_spot_sge",
    "palladium_spot_sge",
    "us_unemployment_rate",
    "us_core_pce",
    "us_non_farm_payrolls",
    "china_international_tourism_fx",
    "crypto_js_spot",
  ]);
  private readonly forceDefaultParamsSyncSlugs = new Set<string>([
    "macro_fx_sentiment",
    "market_sentiment_usdx",
    "bitcoin_spot_price",
    "usd_cny_spot",
    "eur_cny_spot",
    "sp500_index",
    "china_treasury_yield_curve",
  ]);
  // Existing catalogs may still point sp500_index at legacy Akshare metadata.
  // Force a source sync so persisted records follow the Yahoo Finance-backed
  // yfinance provider registered in the mainline definitions.
  private readonly forceSourceSyncSlugs = new Set<string>(["sp500_index"]);
  private readonly forceFilterSyncSlugs = new Set<string>([
    "bitcoin_spot_price",
    "usd_cny_spot",
    "eur_cny_spot",
    "china_treasury_yield_curve",
    "sp500_index",
  ]);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AKSHARE_QUEUE) private readonly queue: Queue<AkshareJobPayload>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Optional()
    private readonly providerRegistry?: FinancialDataProviderRegistry,
  ) {}

  async onModuleInit() {
    await this.ensureCatalog();
    await this.ensureRepeatableJobs();
  }

  get definitions() {
    return FINANCIAL_DATA_DEFINITIONS;
  }

  private buildSeedMetadata(
    definition: FinancialDataItemDefinition,
  ): AkshareDataItemMetadata {
    if (definition.providerConfig.kind !== "akshare") {
      return {
        method: "GET",
        defaultParams: null,
        parser: undefined,
        tags: definition.tags ?? [],
        filter: null,
      };
    }

    return {
      method: definition.providerConfig.method ?? "GET",
      defaultParams: definition.providerConfig.defaultParams ?? null,
      parser: definition.providerConfig.parser,
      tags: definition.tags ?? [],
      filter: definition.providerConfig.filter ?? null,
    };
  }

  private buildDefinitionCustomMetadata(
    definition: FinancialDataItemDefinition,
  ): FinancialDataDefinitionMetadata {
    return {
      providerKind: definition.providerConfig.kind,
      providerConfig: definition.providerConfig,
      requiresSecret: definition.requiresSecret,
      defaultEnabled: definition.defaultEnabled ?? true,
      mainlineRole: definition.mainlineRole ?? "canonical",
      snapshot: definition.snapshot,
      dataViz: definition.dataViz,
    };
  }

  private parseFilter(
    filter: unknown,
  ): AksharePayloadFilterConfig | null | undefined {
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
    const parsedMode =
      mode === "all" || mode === "best" || mode === "first" ? mode : undefined;
    const preferNonZeroField =
      typeof raw.preferNonZeroField === "string"
        ? raw.preferNonZeroField
        : undefined;
    const rankBy = typeof raw.rankBy === "string" ? raw.rankBy : undefined;
    const rankOrder =
      raw.rankOrder === "asc" || raw.rankOrder === "desc"
        ? raw.rankOrder
        : undefined;

    return {
      field,
      equals,
      mode: parsedMode,
      preferNonZeroField,
      rankBy,
      rankOrder,
    };
  }

  private parseMetadata(
    metadata: Prisma.JsonValue | null,
  ): AkshareDataItemMetadata {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return {};
    }
    const parsed = metadata as Record<string, unknown>;
    const method =
      parsed.method === "POST"
        ? "POST"
        : parsed.method === "GET"
          ? "GET"
          : undefined;
    const defaultParams =
      parsed.defaultParams &&
      typeof parsed.defaultParams === "object" &&
      !Array.isArray(parsed.defaultParams)
        ? (parsed.defaultParams as Record<string, string | number>)
        : parsed.defaultParams === null
          ? null
          : undefined;
    const parser = parsed.parser as AkshareParserConfig | undefined;
    const filter = this.parseFilter(parsed.filter);
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.map((tag) => String(tag))
      : undefined;

    return {
      method,
      defaultParams,
      parser,
      tags,
      filter,
    };
  }

  private extractCustomMetadata(
    metadata: Prisma.JsonValue | null,
  ): Record<string, unknown> {
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

  private normalizeCustomMetadata(
    metadata: FinancialDataDefinitionMetadata,
  ): Record<string, unknown> {
    return {
      providerKind: metadata.providerKind,
      providerConfig: metadata.providerConfig,
      requiresSecret: metadata.requiresSecret ?? null,
      defaultEnabled: metadata.defaultEnabled ?? true,
      mainlineRole: metadata.mainlineRole ?? "canonical",
      snapshot: metadata.snapshot ?? null,
      dataViz: metadata.dataViz ?? null,
    };
  }

  private sortJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((entry) => this.sortJsonValue(entry));
    }
    if (value && typeof value === "object") {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = this.sortJsonValue(
            (value as Record<string, unknown>)[key],
          );
          return acc;
        }, {});
    }
    return value;
  }

  private metadataPayloadEquals(a: unknown, b: unknown): boolean {
    return (
      JSON.stringify(this.sortJsonValue(a)) ===
      JSON.stringify(this.sortJsonValue(b))
    );
  }

  private hasValidParser(parser: AkshareParserConfig | undefined): boolean {
    return Boolean(
      parser &&
        typeof (parser as { type?: unknown }).type === "string" &&
        (parser as { type?: string }).type,
    );
  }

  private sanitizeExistingMetadata(
    metadata: AkshareDataItemMetadata,
  ): AkshareDataItemMetadata {
    if (!this.hasValidParser(metadata.parser)) {
      // Treat partial/invalid parser configs (e.g. missing `type`) as absent so we can fall back to the seed parser.
      return { ...metadata, parser: undefined };
    }
    return metadata;
  }

  private mergeMetadata(
    existing: AkshareDataItemMetadata,
    seed: AkshareDataItemMetadata,
  ): AkshareDataItemMetadata {
    return {
      method: existing.method ?? seed.method ?? "GET",
      defaultParams:
        existing.defaultParams === null
          ? null
          : (existing.defaultParams ??
            (seed.defaultParams === null ? null : seed.defaultParams)),
      parser: existing.parser ?? seed.parser,
      tags: existing.tags ?? seed.tags,
      filter:
        existing.filter === null ? null : (existing.filter ?? seed.filter),
    };
  }

  private normalizeMetadata(metadata: AkshareDataItemMetadata) {
    return {
      method: metadata.method ?? "GET",
      defaultParams: metadata.defaultParams ?? null,
      parser: metadata.parser ?? null,
      tags: metadata.tags ?? [],
      filter: metadata.filter ?? null,
    };
  }

  private metadataEquals(
    a: AkshareDataItemMetadata,
    b: AkshareDataItemMetadata,
  ) {
    return (
      JSON.stringify(this.normalizeMetadata(a)) ===
      JSON.stringify(this.normalizeMetadata(b))
    );
  }

  private parseProviderKind(value: unknown): FinancialDataProviderKind {
    return value === "finnhub" ||
      value === "fred" ||
      value === "akshare" ||
      value === "yfinance"
      ? value
      : "akshare";
  }

  private parseRequiredSecret(
    value: unknown,
  ): FinancialDataRequiredSecret | undefined {
    return value === "finnhubApiKey" || value === "fredApiKey"
      ? value
      : undefined;
  }

  private parseMainlineRole(value: unknown): FinancialDataMainlineRole {
    return value === "fallback" ||
      value === "derived" ||
      value === "internal" ||
      value === "canonical"
      ? value
      : "canonical";
  }

  private parseSnapshotMetadata(
    value: unknown,
  ): FinancialDataSnapshotMetadata | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const snapshot = value as Record<string, unknown>;
    if (snapshot.group !== "markets" && snapshot.group !== "fed") {
      return undefined;
    }
    if (typeof snapshot.bucket !== "string" || !snapshot.bucket.trim()) {
      return undefined;
    }
    return snapshot as unknown as FinancialDataSnapshotMetadata;
  }

  private parseDataVizMetadata(
    value: unknown,
  ): FinancialDataVisualizationMetadata | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const dataViz = value as Record<string, unknown>;
    return {
      preferredSourceFields: Array.isArray(dataViz.preferredSourceFields)
        ? dataViz.preferredSourceFields.map((entry) => String(entry))
        : undefined,
      percentSourceFields: Array.isArray(dataViz.percentSourceFields)
        ? dataViz.percentSourceFields.map((entry) => String(entry))
        : undefined,
    };
  }

  private buildLegacyAkshareProviderConfigFromItem(
    item: {
      slug: string;
      sourceFunction: string;
      sourceEndpoint: string;
      sourceDocUrl: string | null;
    },
    metadata: AkshareDataItemMetadata,
  ): AkshareFinancialDataProviderConfig {
    if (!metadata.parser) {
      throw new InternalServerErrorException(
        `Akshare parser not configured for ${item.slug}`,
      );
    }

    return {
      kind: "akshare",
      functionName: item.sourceFunction,
      endpoint: item.sourceEndpoint,
      docUrl: item.sourceDocUrl ?? "",
      method: metadata.method ?? "GET",
      defaultParams: metadata.defaultParams ?? undefined,
      filter: metadata.filter ?? undefined,
      parser: metadata.parser,
    };
  }

  private parseProviderConfig(
    item: {
      slug: string;
      sourceFunction: string;
      sourceEndpoint: string;
      sourceDocUrl: string | null;
    },
    metadata: AkshareDataItemMetadata,
    customMetadata: Record<string, unknown>,
    providerKind: FinancialDataProviderKind,
  ): FinancialDataProviderConfig {
    const raw = customMetadata.providerConfig;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const providerConfig = raw as Record<string, unknown>;
      if (providerConfig.kind === providerKind) {
        return providerConfig as unknown as FinancialDataProviderConfig;
      }
    }

    if (providerKind === "akshare") {
      return this.buildLegacyAkshareProviderConfigFromItem(item, metadata);
    }

    throw new InternalServerErrorException(
      `Provider config missing for ${item.slug}`,
    );
  }

  private parseDefinitionMetadataFromRecord(item: {
    slug: string;
    sourceFunction: string;
    sourceEndpoint: string;
    sourceDocUrl: string | null;
    metadata: Prisma.JsonValue | null;
  }) {
    const metadata = this.parseMetadata(item.metadata);
    const customMetadata = this.extractCustomMetadata(item.metadata);
    const providerKind = this.parseProviderKind(customMetadata.providerKind);
    const providerConfig = this.parseProviderConfig(
      item,
      metadata,
      customMetadata,
      providerKind,
    );
    const requiresSecret = this.parseRequiredSecret(
      customMetadata.requiresSecret,
    );
    const defaultEnabled =
      typeof customMetadata.defaultEnabled === "boolean"
        ? customMetadata.defaultEnabled
        : true;
    const mainlineRole = this.parseMainlineRole(customMetadata.mainlineRole);
    const snapshot = this.parseSnapshotMetadata(customMetadata.snapshot);
    const dataViz = this.parseDataVizMetadata(customMetadata.dataViz);
    const tags = Array.isArray(metadata.tags) ? metadata.tags : [];

    return {
      providerKind,
      providerConfig,
      requiresSecret,
      defaultEnabled,
      mainlineRole,
      snapshot,
      dataViz,
      tags,
    };
  }

  private async loadDefinitionFromDatabase(
    slug: string,
  ): Promise<FinancialDataItemConfig> {
    const item = await this.prisma.economicDataItem.findUnique({
      where: { slug },
      include: {
        categories: {
          include: { category: true },
        },
      },
    });
    if (!item) {
      throw new InternalServerErrorException(`Data item ${slug} not found`);
    }

    const definitionMetadata = this.parseDefinitionMetadataFromRecord(item);

    return {
      itemId: item.id,
      slug: item.slug,
      displayName: item.displayName,
      description: item.description,
      categories: item.categories.map((entry) => entry.category.key),
      sourceFunction: item.sourceFunction,
      endpoint: item.sourceEndpoint,
      docUrl: item.sourceDocUrl,
      valueType: item.valueType,
      defaultUnit: item.defaultUnit,
      defaultFrequency: item.defaultFrequency,
      providerKind: definitionMetadata.providerKind,
      providerConfig: definitionMetadata.providerConfig,
      requiresSecret: definitionMetadata.requiresSecret,
      defaultEnabled: definitionMetadata.defaultEnabled,
      mainlineRole: definitionMetadata.mainlineRole,
      snapshot: definitionMetadata.snapshot,
      dataViz: definitionMetadata.dataViz,
      tags: definitionMetadata.tags,
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
      where: { key: { in: Array.from(categoryKeys) } },
    });
    const existingCategoryMap = new Map(
      existingCategories.map((cat) => [cat.key, cat]),
    );

    // Phase 3: Batch create missing categories
    const missingCategoryKeys = Array.from(categoryKeys).filter(
      (key) => !existingCategoryMap.has(key),
    );
    if (missingCategoryKeys.length > 0) {
      await this.prisma.economicCategory.createMany({
        data: missingCategoryKeys.map((key) => ({
          key,
          label: key
            .split("-")
            .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
            .join(" "),
        })),
        skipDuplicates: true,
      });
      // Reload categories to get IDs for newly created ones
      const allCategories = await this.prisma.economicCategory.findMany({
        where: { key: { in: Array.from(categoryKeys) } },
      });
      for (const cat of allCategories) {
        existingCategoryMap.set(cat.key, cat);
      }
    }
    this.logger.log(
      `ensureCatalog: Categories synced in ${Date.now() - startTime}ms`,
    );

    // Phase 4: Batch load all existing data items (T1 - replaces N+1 findUnique calls)
    const slugs = this.definitions.map((d) => d.slug);
    const existingItems = await this.prisma.economicDataItem.findMany({
      where: { slug: { in: slugs } },
      include: {
        categories: {
          include: { category: true },
        },
        fetchConfig: true,
      },
    });
    const existingItemMap = new Map(
      existingItems.map((item) => [item.slug, item]),
    );
    this.logger.log(
      `ensureCatalog: Loaded ${existingItems.length} existing items in ${Date.now() - startTime}ms`,
    );

    // Phase 5: Collect items for batch operations
    const newItemsData: {
      definition: FinancialDataItemDefinition;
      seedMetadata: AkshareDataItemMetadata;
      seedCustomMetadata: FinancialDataDefinitionMetadata;
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
      isEnabled: boolean;
    }[] = [];

    // Phase 6: Process definitions and collect batch operations
    for (const definition of this.definitions) {
      const seedMetadata = this.buildSeedMetadata(definition);
      const seedCustomMetadata = this.buildDefinitionCustomMetadata(definition);
      const existingItem = existingItemMap.get(definition.slug);

      const categories = definition.categories
        .map((categoryKey) => {
          const category = existingCategoryMap.get(categoryKey);
          if (!category) {
            this.logger.warn(
              `Missing category ${categoryKey} for ${definition.slug}`,
            );
            return null;
          }
          return category;
        })
        .filter((category): category is NonNullable<typeof category> =>
          Boolean(category),
        );

      if (!existingItem) {
        // Collect for batch create (T2)
        newItemsData.push({
          definition,
          seedMetadata,
          seedCustomMetadata,
          categories,
        });
        continue;
      }

      // Collect updates (T3)
      const isMockSeed =
        existingItem.sourceFunction === "mock" &&
        existingItem.sourceEndpoint === "mock";
      const existingMetadata = this.sanitizeExistingMetadata(
        this.parseMetadata(existingItem.metadata),
      );
      const existingCustomMetadata = this.extractCustomMetadata(
        existingItem.metadata,
      );
      const mergedMetadata = this.mergeMetadata(existingMetadata, seedMetadata);
      const mergedMetadataWithOverrides =
        this.forceParserSyncSlugs.has(definition.slug) || isMockSeed
          ? { ...mergedMetadata, parser: seedMetadata.parser }
          : mergedMetadata;
      const mergedMetadataWithOverridesFilter =
        this.forceFilterSyncSlugs.has(definition.slug) || isMockSeed
          ? {
              ...mergedMetadataWithOverrides,
              filter: seedMetadata.filter ?? null,
            }
          : mergedMetadataWithOverrides;
      const mergedMetadataWithOverrides2 =
        this.forceDefaultParamsSyncSlugs.has(definition.slug) || isMockSeed
          ? {
              ...mergedMetadataWithOverridesFilter,
              defaultParams: seedMetadata.defaultParams ?? null,
            }
          : mergedMetadataWithOverridesFilter;

      const updates: Prisma.EconomicDataItemUpdateInput = {};
      const matchesSeedFunction =
        existingItem.sourceFunction === definition.sourceFunction;
      const existingProviderKind = this.parseProviderKind(
        existingCustomMetadata.providerKind,
      );
      const shouldSyncSource =
        matchesSeedFunction ||
        isMockSeed ||
        this.forceSourceSyncSlugs.has(definition.slug) ||
        existingProviderKind !== definition.providerConfig.kind;
      if (!existingItem.groupLabel && definition.categories[0]) {
        updates.groupLabel = definition.categories[0];
      }
      if (
        shouldSyncSource &&
        existingItem.sourceFunction !== definition.sourceFunction
      ) {
        updates.sourceFunction = definition.sourceFunction;
      }
      if (
        shouldSyncSource &&
        existingItem.sourceEndpoint !== definition.endpoint
      ) {
        updates.sourceEndpoint = definition.endpoint;
      }
      if (shouldSyncSource && existingItem.sourceDocUrl !== definition.docUrl) {
        updates.sourceDocUrl = definition.docUrl;
      }
      if (shouldSyncSource && existingItem.valueType !== definition.valueType) {
        updates.valueType = definition.valueType;
      }
      if (
        shouldSyncSource &&
        existingItem.defaultUnit !== definition.defaultUnit
      ) {
        updates.defaultUnit = definition.defaultUnit;
      }
      if (
        shouldSyncSource &&
        existingItem.defaultFrequency !== definition.defaultFrequency
      ) {
        updates.defaultFrequency = definition.defaultFrequency;
      }
      if (!existingItem.description && definition.description) {
        updates.description = definition.description;
      }
      const nextMetadataPayload = {
        ...existingCustomMetadata,
        ...this.normalizeCustomMetadata(seedCustomMetadata),
        ...this.normalizeMetadata(mergedMetadataWithOverrides2),
      };
      if (
        !this.metadataPayloadEquals(existingItem.metadata, nextMetadataPayload)
      ) {
        updates.metadata = toPrismaJsonValue(nextMetadataPayload);
      }

      if (Object.keys(updates).length > 0) {
        itemUpdates.push({ id: existingItem.id, data: updates });
      }

      // Collect missing category relations (T4)
      const existingCategoryKeys = new Set(
        existingItem.categories.map((entry) => entry.category.key),
      );
      for (const category of categories) {
        if (!existingCategoryKeys.has(category.key)) {
          newCategoryRelations.push({
            itemId: existingItem.id,
            categoryId: category.id,
          });
        }
      }

      // Collect missing fetch configs (T5)
      if (!existingItem.fetchConfig) {
        newFetchConfigs.push({
          itemId: existingItem.id,
          frequency:
            existingItem.defaultFrequency ?? definition.defaultFrequency,
          isEnabled: definition.defaultEnabled ?? true,
        });
      }
    }

    // Phase 7: Execute batch create for new items (T2)
    if (newItemsData.length > 0) {
      // createMany doesn't support nested creates, so we need to create items first
      // then create relations separately
      await this.prisma.economicDataItem.createMany({
        data: newItemsData.map(
          ({ definition, seedMetadata, seedCustomMetadata }) => ({
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
            metadata: toPrismaJsonValue({
              ...this.normalizeCustomMetadata(seedCustomMetadata),
              ...this.normalizeMetadata(seedMetadata),
            }),
          }),
        ),
        skipDuplicates: true,
      });

      // Fetch newly created items to get their IDs
      const newSlugs = newItemsData.map((d) => d.definition.slug);
      const createdItems = await this.prisma.economicDataItem.findMany({
        where: { slug: { in: newSlugs } },
      });
      const createdItemMap = new Map(
        createdItems.map((item) => [item.slug, item]),
      );

      // Collect category relations and fetch configs for new items
      for (const { definition, categories } of newItemsData) {
        const createdItem = createdItemMap.get(definition.slug);
        if (!createdItem) continue;

        for (const category of categories) {
          newCategoryRelations.push({
            itemId: createdItem.id,
            categoryId: category.id,
          });
        }

        newFetchConfigs.push({
          itemId: createdItem.id,
          frequency: definition.defaultFrequency,
          isEnabled: definition.defaultEnabled ?? true,
        });
      }
      this.logger.log(
        `ensureCatalog: Created ${newItemsData.length} new items in ${Date.now() - startTime}ms`,
      );
    }

    // Phase 8: Execute batch updates (T3)
    if (itemUpdates.length > 0) {
      await this.prisma.$transaction(
        itemUpdates.map(({ id, data }) =>
          this.prisma.economicDataItem.update({
            where: { id },
            data,
          }),
        ),
      );
      this.logger.log(
        `ensureCatalog: Updated ${itemUpdates.length} items in ${Date.now() - startTime}ms`,
      );
    }

    // Phase 9: Batch create category relations (T4)
    if (newCategoryRelations.length > 0) {
      await this.prisma.economicDataItemCategory.createMany({
        data: newCategoryRelations,
        skipDuplicates: true,
      });
      this.logger.log(
        `ensureCatalog: Created ${newCategoryRelations.length} category relations in ${Date.now() - startTime}ms`,
      );
    }

    // Phase 10: Batch create fetch configs (T5)
    if (newFetchConfigs.length > 0) {
      await this.prisma.economicDataFetchConfig.createMany({
        data: newFetchConfigs.map(({ itemId, frequency, isEnabled }) => ({
          itemId,
          frequency,
          repeatCron: null,
          isEnabled,
        })),
        skipDuplicates: true,
      });
      this.logger.log(
        `ensureCatalog: Created ${newFetchConfigs.length} fetch configs in ${Date.now() - startTime}ms`,
      );
    }

    // Phase 11: Performance summary (T6)
    const totalTime = Date.now() - startTime;
    this.logger.log(
      `ensureCatalog: Completed in ${totalTime}ms - ` +
        `${this.definitions.length} definitions, ` +
        `${existingItems.length} existing, ` +
        `${newItemsData.length} created, ` +
        `${itemUpdates.length} updated`,
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
        this.logger.log(
          "Skipping ensureRepeatableJobs: lock already held by another instance",
        );
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
        this.logger.warn(
          { error },
          "Failed to release Akshare repeatable jobs lock",
        );
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

  private resolveProviderUnavailableError(definition: {
    requiresSecret?: FinancialDataRequiredSecret;
  }): string {
    return definition.requiresSecret
      ? `missing_api_key:${definition.requiresSecret}`
      : "provider_disabled";
  }

  private async markFetchConfigUnavailable(
    itemId: string,
    errorCode: string,
  ): Promise<void> {
    await this.prisma.economicDataFetchConfig.update({
      where: { itemId },
      data: {
        lastRunAt: new Date(),
        lastStatus: EconomicDataRunStatus.failed,
        lastError: errorCode,
        updatedAt: new Date(),
      },
    });
  }

  private async syncRepeatableJobs() {
    const configs = await this.prisma.economicDataFetchConfig.findMany({
      include: { item: true },
    });
    const existingJobs = await this.queue.getRepeatableJobs();
    const providerAvailabilityCache = new Map<
      FinancialDataProviderKind,
      boolean
    >();

    const resolveAvailability = async (
      item: (typeof configs)[number]["item"],
    ) => {
      const definitionMetadata = this.parseDefinitionMetadataFromRecord(item);
      if (!this.providerRegistry) {
        return { available: true, definitionMetadata };
      }

      const cached = providerAvailabilityCache.get(
        definitionMetadata.providerKind,
      );
      if (cached !== undefined) {
        return { available: cached, definitionMetadata };
      }

      const available = await this.providerRegistry
        .get(definitionMetadata.providerKind)
        .isConfigured();
      providerAvailabilityCache.set(definitionMetadata.providerKind, available);
      return { available, definitionMetadata };
    };

    const configByJobName = new Map(
      configs.map((config) => [this.buildJobName(config.itemId), config]),
    );
    for (const job of existingJobs) {
      const config = configByJobName.get(job.name ?? "");
      const availability = config
        ? await resolveAvailability(config.item)
        : null;
      if (!config || !config.isEnabled || !availability?.available) {
        await this.queue.removeRepeatableByKey(job.key);
        if (config && availability && !availability.available) {
          await this.markFetchConfigUnavailable(
            config.itemId,
            this.resolveProviderUnavailableError(
              availability.definitionMetadata,
            ),
          );
        }
      }
    }

    const existingByName = new Map(
      existingJobs.map((job) => [job.name ?? "", job]),
    );
    for (const config of configs) {
      if (!config.isEnabled) {
        continue;
      }
      const availability = await resolveAvailability(config.item);
      if (!availability.available) {
        await this.markFetchConfigUnavailable(
          config.itemId,
          this.resolveProviderUnavailableError(availability.definitionMetadata),
        );
        continue;
      }
      const jobName = this.buildJobName(config.itemId);
      const repeat = this.buildRepeatOptions(
        config.frequency,
        config.repeatCron,
      );
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
          repeat,
        },
      );
    }
  }

  private buildRepeatOptions(
    frequency: EconomicDataFrequency,
    cron?: string | null,
  ): RepeatOptions {
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
      const jobEvery =
        typeof job.every === "string" ? Number(job.every) : undefined;
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
        { removeOnComplete: true },
      );
    }
    return true;
  }

  async triggerDataFetchForPreset(
    preset: EconomicDashboardRefreshPreset,
    triggerContext?: EconomicRefreshTriggerContext,
  ) {
    const presetConfig = ECONOMIC_DASHBOARD_REFRESH_PRESET_CONFIG[preset];
    if (!presetConfig) {
      throw new BadRequestException(
        `Unsupported economic refresh preset: ${preset}`,
      );
    }

    const configs = await this.prisma.economicDataFetchConfig.findMany({
      where: {
        isEnabled: true,
        item: {
          isActive: true,
          categories: {
            some: {
              category: {
                key: presetConfig.categoryKey,
              },
            },
          },
        },
      },
      select: {
        item: {
          select: {
            slug: true,
          },
        },
      },
    });

    const slugs = Array.from(
      new Set(
        configs
          .map((config) => config.item.slug.trim())
          .filter((slug) => slug.length > 0),
      ),
    );

    if (slugs.length === 0) {
      throw new BadRequestException(
        `No enabled economic data items are configured for refresh preset '${preset}'.`,
      );
    }

    await this.triggerDataFetch(slugs, triggerContext?.actorId ?? undefined);

    if (triggerContext?.orgId) {
      await writeAuditLogBestEffort(
        this.prisma,
        {
          data: {
            orgId: triggerContext.orgId,
            actorId: triggerContext.actorId ?? null,
            resource: "economic_data",
            action: "manual_refresh_trigger",
            ipAddress: triggerContext.ipAddress ?? null,
            metadata: toPrismaJsonValue({
              preset,
              categoryKey: presetConfig.categoryKey,
              slugCount: slugs.length,
              slugs,
            }),
          },
        },
        {
          orgId: triggerContext.orgId,
          actorId: triggerContext.actorId ?? null,
          preset,
          categoryKey: presetConfig.categoryKey,
        },
      );
    }

    return true;
  }

  async getRefreshPresetStatus(
    preset: EconomicDashboardRefreshPreset,
  ): Promise<EconomicRefreshPresetStatusSummary> {
    const presetConfig = ECONOMIC_DASHBOARD_REFRESH_PRESET_CONFIG[preset];
    if (!presetConfig) {
      throw new BadRequestException(
        `Unsupported economic refresh preset: ${preset}`,
      );
    }

    const configs = await this.prisma.economicDataFetchConfig.findMany({
      where: {
        item: {
          categories: {
            some: {
              category: {
                key: presetConfig.categoryKey,
              },
            },
          },
        },
      },
      select: {
        isEnabled: true,
        lastRunAt: true,
        lastStatus: true,
        lastError: true,
        item: {
          select: {
            isActive: true,
          },
        },
      },
    });

    const enabledConfigs = configs.filter(
      (config) => config.isEnabled && config.item.isActive,
    );
    const latestConfig = enabledConfigs.reduce<
      (typeof enabledConfigs)[number] | null
    >((currentLatest, candidate) => {
      if (!candidate.lastRunAt) {
        return currentLatest;
      }
      if (!currentLatest?.lastRunAt) {
        return candidate;
      }
      return candidate.lastRunAt > currentLatest.lastRunAt
        ? candidate
        : currentLatest;
    }, null);

    return {
      preset,
      categoryKey: presetConfig.categoryKey,
      totalItems: configs.length,
      enabledItems: enabledConfigs.length,
      lastRunAt: latestConfig?.lastRunAt ?? null,
      lastStatus: latestConfig?.lastStatus ?? null,
      lastError: latestConfig?.lastError ?? null,
    };
  }

  async fetchAndPersist(slug: string) {
    let itemId: string | undefined;
    let definition: FinancialDataItemConfig | undefined;
    try {
      definition = await this.loadDefinitionFromDatabase(slug);
      itemId = definition.itemId;
      if (!this.providerRegistry) {
        throw new InternalServerErrorException(
          "Financial data provider registry not initialized",
        );
      }

      const provider = this.providerRegistry.get(definition.providerKind);
      const response = await provider.fetch(definition);
      await this.archiveProviderResponse(definition, response);
      const deletedCount = await this.applyProviderCleanup(
        definition.itemId,
        response.cleanup,
      );
      const storedCount = await this.bulkUpsertDataPoints(
        definition.itemId,
        response.points,
      );

      await this.updateFetchStatusByItemId(
        definition.itemId,
        EconomicDataRunStatus.success,
      );

      const cleanupSuffix =
        deletedCount > 0 ? ` after deleting ${deletedCount} stale points` : "";
      this.logger.log(
        `Stored ${storedCount} points for ${definition.slug}${cleanupSuffix}`,
      );
      return storedCount;
    } catch (error) {
      try {
        if (definition) {
          await this.archiveProviderFailure(definition, error);
        }
        if (itemId) {
          if (error instanceof FinancialDataProviderConfigurationError) {
            await this.markFetchConfigUnavailable(
              itemId,
              error.message || error.code,
            );
            this.logger.warn(`Skipped ${slug}: ${error.message || error.code}`);
            return 0;
          }
          await this.updateFetchStatusByItemId(
            itemId,
            EconomicDataRunStatus.failed,
            error,
          );
        } else {
          await this.recordFetchFailure(slug, error);
        }
      } catch (persistError) {
        this.logger.error(
          { slug, error: persistError },
          "Failed to record Akshare fetch failure status",
        );
      }
      if (error instanceof FinancialDataProviderConfigurationError) {
        return 0;
      }
      throw error;
    }
  }

  private buildFailureRequestParams(
    definition: FinancialDataItemConfig,
  ): Record<string, unknown> {
    const providerConfig = definition.providerConfig;
    switch (providerConfig.kind) {
      case "akshare":
        return providerConfig.defaultParams ?? {};
      case "finnhub":
        return { symbol: providerConfig.symbol };
      case "fred":
        return {
          series_id: providerConfig.seriesId,
          metric: providerConfig.metric,
          limit: providerConfig.lookback ?? undefined,
        };
      case "yfinance":
        return {
          symbol: providerConfig.symbol,
          interval: providerConfig.interval,
          period1: providerConfig.period1,
          period2: providerConfig.period2 ?? "now",
          includePrePost: providerConfig.includePrePost ?? false,
          events: providerConfig.events ?? "div,splits",
        };
      default:
        return {};
    }
  }

  private buildFailurePayload(error: unknown): Record<string, unknown> {
    if (error instanceof FinancialDataProviderConfigurationError) {
      return {
        name: error.name,
        code: error.code,
        message: error.message,
      };
    }
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
      };
    }
    return {
      message: this.formatError(error),
    };
  }

  private async archiveProviderFailure(
    definition: FinancialDataItemConfig,
    error: unknown,
  ): Promise<void> {
    await EconomicProviderResponseModel.create({
      dataItemId: definition.slug,
      providerKind: definition.providerKind,
      providerIdentity: this.resolveProviderIdentity(definition.providerConfig),
      endpoint: definition.endpoint,
      method: "GET",
      requestParams: this.buildFailureRequestParams(definition),
      payload: this.buildFailurePayload(error),
      status:
        error instanceof FinancialDataProviderConfigurationError
          ? "skipped"
          : "failed",
      fetchedAt: new Date(),
    });
  }

  private resolveProviderIdentity(config: FinancialDataProviderConfig): string {
    switch (config.kind) {
      case "akshare":
        return config.functionName;
      case "finnhub":
        return config.symbol;
      case "fred":
        return config.seriesId;
      case "yfinance":
        return config.symbol;
      default:
        return "unknown";
    }
  }

  private async archiveProviderResponse(
    definition: FinancialDataItemConfig,
    response: {
      payload: unknown;
      requestParams?: Record<string, unknown>;
      method?: string;
    },
  ): Promise<void> {
    const method = response.method ?? "GET";
    const requestParams = response.requestParams ?? {};

    await EconomicProviderResponseModel.create({
      dataItemId: definition.slug,
      providerKind: definition.providerKind,
      providerIdentity: this.resolveProviderIdentity(definition.providerConfig),
      endpoint: definition.endpoint,
      method,
      requestParams,
      payload: response.payload,
      status: "success",
      fetchedAt: new Date(),
    });

    if (definition.providerKind === "akshare") {
      await AkshareResponseModel.create({
        dataItemId: definition.slug,
        endpoint: definition.endpoint,
        method,
        requestParams,
        payload: response.payload,
        fetchedAt: new Date(),
      });
    }
  }

  private async bulkUpsertDataPoints(
    itemId: string,
    points: ParsedDataPoint[],
  ) {
    const deduped = new Map<string, ParsedDataPoint>();
    for (const point of points) {
      if (point.value === null || point.value === undefined) {
        continue;
      }
      if (typeof point.value === "number" && !Number.isFinite(point.value)) {
        continue;
      }
      const recordedAt =
        point.recordedAt instanceof Date
          ? point.recordedAt
          : new Date(point.recordedAt);
      const key = `${recordedAt.getTime()}|${point.sourceField}`;
      deduped.set(key, {
        ...point,
        recordedAt,
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
      const wouldExceedBytes =
        chunk.length > 0 &&
        chunkBytes + row.estimatedBytes > this.dataPointBatchMaxBytes;
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

  private async applyProviderCleanup(
    itemId: string,
    cleanup?: FinancialDataProviderCleanup,
  ): Promise<number> {
    const uniqueRecordedAts = new Map<number, Date>();
    for (const recordedAt of cleanup?.deleteRecordedAts ?? []) {
      if (!(recordedAt instanceof Date) || Number.isNaN(recordedAt.getTime())) {
        continue;
      }
      uniqueRecordedAts.set(recordedAt.getTime(), recordedAt);
    }

    if (uniqueRecordedAts.size === 0) {
      return 0;
    }

    const result = await this.prisma.economicDataPoint.deleteMany({
      where: {
        itemId,
        recordedAt: {
          in: Array.from(uniqueRecordedAts.values()),
        },
      },
    });

    return result.count;
  }

  private toUpsertDataPointRow(
    itemId: string,
    point: ParsedDataPoint,
  ): UpsertDataPointRow | null {
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
          }`,
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
      metaJson,
    });

    return {
      recordedAt: point.recordedAt,
      dataType: point.dataType,
      value,
      unit,
      sourceField: point.sourceField,
      metaJson,
      estimatedBytes,
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
    const recordedAt =
      input.recordedAt instanceof Date
        ? input.recordedAt.toISOString()
        : String(input.recordedAt);
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
    const topMessage =
      typeof anyError.message === "string" ? anyError.message : "";
    const metaMessage =
      typeof anyError.meta?.message === "string" ? anyError.meta.message : "";
    const message = `${topMessage} ${metaMessage}`.toLowerCase();
    if (
      message.includes("max_allowed_packet") ||
      (message.includes("packet") && message.includes("too"))
    ) {
      return true;
    }

    const metaCode = anyError.meta?.code;
    const errno = anyError.errno ?? anyError.code;
    return String(metaCode) === "1153" || String(errno) === "1153";
  }

  private async executeUpsertDataPointChunk(
    itemId: string,
    rows: UpsertDataPointRow[],
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    try {
      await this.prisma.$executeRaw(
        this.buildUpsertDataPointsQuery(itemId, rows),
      );
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

  private buildUpsertDataPointsQuery(
    itemId: string,
    rows: UpsertDataPointRow[],
  ) {
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

  private defaultFrequencyToGranularity(
    frequency: EconomicDataFrequency | null | undefined,
  ): string {
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

  async getCategoryBaseGranularity(
    categoryKey: string,
  ): Promise<string | null> {
    const items = await this.prisma.economicDataItem.findMany({
      where: {
        categories: {
          some: {
            category: {
              key: categoryKey,
            },
          },
        },
      },
      select: {
        defaultFrequency: true,
      },
    });

    if (!items.length) {
      return null;
    }

    const granularities = items.map((item) =>
      this.defaultFrequencyToGranularity(item.defaultFrequency),
    );
    return granularities.reduce(
      (coarsest, next) => this.coarsestGranularity(coarsest, next),
      granularities[0]!,
    );
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

  private decodeCursor(
    cursor: string,
  ): { recordedAt: Date; id: string } | null {
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

  private alignRangeToGranularityUtc(
    start: Date,
    end: Date,
    granularity: string,
  ) {
    if (granularity === "realtime") {
      return { start, end };
    }

    const normalizedStart = new Date(this.bucketTimestamp(start, granularity));
    const normalizedEndBucketStart = new Date(
      this.bucketTimestamp(end, granularity),
    );
    const nextBucketStart = this.addGranularityInterval(
      normalizedEndBucketStart,
      granularity,
    );
    const normalizedEnd = new Date(nextBucketStart.getTime() - 1);
    return { start: normalizedStart, end: normalizedEnd };
  }

  async getDataByCategory(
    categoryKey: string,
    start: Date,
    end: Date,
    granularity?: string,
    pagination?: PaginationInput,
    options?: { skipGranularityValidation?: boolean },
  ) {
    if (granularity && !options?.skipGranularityValidation) {
      const baseGranularity =
        await this.getCategoryBaseGranularity(categoryKey);
      if (
        baseGranularity &&
        this.granularityRank(granularity) <
          this.granularityRank(baseGranularity)
      ) {
        throw new BadRequestException(
          `Requested granularity '${granularity}' is finer than this category's base frequency ('${baseGranularity}').`,
        );
      }
    }

    const range = granularity
      ? this.alignRangeToGranularityUtc(start, end, granularity)
      : { start, end };
    const limit = pagination
      ? Math.min(pagination.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT)
      : null;

    // Build where clause with optional cursor
    const whereClause: Prisma.EconomicDataPointWhereInput = {
      recordedAt: {
        gte: range.start,
        lte: range.end,
      },
      item: {
        categories: {
          some: {
            category: {
              key: categoryKey,
            },
          },
        },
      },
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
                id: { gt: decoded.id },
              },
            ],
          },
        ];
      }
    }

    const points = await this.prisma.economicDataPoint.findMany({
      where: whereClause,
      include: {
        item: true,
      },
      orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
      take: granularity || limit === null ? undefined : limit + 1, // Fetch one extra to determine hasMore
    });

    if (granularity) {
      // Apply bucketing for granularity.
      // Important: bucket per-series (itemId + sourceField) to avoid mixing different indicators
      // that share the same category.
      const bucketed = new Map<
        string,
        {
          timestamp: Date;
          valueSum: number;
          count: number;
          sample: (typeof points)[number];
        }
      >();
      for (const point of points) {
        const bucketKey = this.bucketTimestamp(point.recordedAt, granularity);
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
            sample: point,
          });
        }
      }
      const bucketedResults = Array.from(bucketed.values())
        .map((entry) => {
          const aggregated = entry.sample;
          return {
            ...aggregated,
            recordedAt: entry.timestamp,
            value: new Prisma.Decimal(entry.valueSum / entry.count),
          };
        })
        .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());

      if (pagination) {
        return {
          data: bucketedResults,
          pagination: {
            hasMore: false,
            totalCount: bucketedResults.length,
          },
        } as PaginatedResult<(typeof bucketedResults)[number]>;
      }

      return bucketedResults;
    }

    if (!pagination) {
      return points;
    }

    const pageLimit = limit ?? DEFAULT_PAGE_LIMIT;
    const hasMore = points.length > pageLimit;
    const resultPoints = hasMore ? points.slice(0, pageLimit) : points;
    const lastPoint = resultPoints.at(-1);
    const paginationMeta: PaginationMeta = {
      hasMore,
      nextCursor:
        hasMore && lastPoint
          ? this.encodeCursor(lastPoint.recordedAt, lastPoint.id)
          : undefined,
    };

    return {
      data: resultPoints,
      pagination: paginationMeta,
    } as PaginatedResult<(typeof resultPoints)[number]>;
  }

  async listFetchConfigs() {
    return this.prisma.economicDataFetchConfig.findMany({
      include: {
        item: {
          include: {
            categories: {
              include: { category: true },
            },
          },
        },
      },
      orderBy: { updatedAt: "desc" },
    });
  }

  async updateFetchConfig(
    itemSlug: string,
    input: {
      frequency?: EconomicDataFrequency;
      repeatCron?: string | null;
      isEnabled?: boolean;
    },
  ) {
    const item = await this.prisma.economicDataItem.findUnique({
      where: { slug: itemSlug },
    });
    if (!item) {
      throw new InternalServerErrorException(`Data item ${itemSlug} not found`);
    }
    const updated = await this.prisma.economicDataFetchConfig.update({
      where: { itemId: item.id },
      data: {
        frequency: input.frequency ?? undefined,
        repeatCron:
          input.repeatCron === undefined ? undefined : input.repeatCron,
        isEnabled: input.isEnabled ?? undefined,
      },
      include: { item: true },
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

  private async updateFetchStatusByItemId(
    itemId: string,
    status: EconomicDataRunStatus,
    error?: unknown,
  ) {
    await this.prisma.economicDataFetchConfig.update({
      where: { itemId },
      data: {
        lastRunAt: new Date(),
        lastStatus: status,
        lastError: error ? this.formatError(error) : null,
        updatedAt: new Date(),
      },
    });
  }

  async recordFetchFailure(slug: string, error: unknown) {
    try {
      const item = await this.prisma.economicDataItem.findUnique({
        where: { slug },
      });
      if (!item) {
        this.logger.error(
          `Failed to update fetch status for ${slug}: item not found`,
        );
        return;
      }
      await this.updateFetchStatusByItemId(
        item.id,
        EconomicDataRunStatus.failed,
        error,
      );
    } catch (updateError) {
      this.logger.error(
        { slug, error: updateError },
        "Failed to persist Akshare fetch failure status",
      );
    }
  }
}
