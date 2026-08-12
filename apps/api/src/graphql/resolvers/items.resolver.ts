import { parseDateTime } from "@modular/utils";
import { BadRequestException, Optional, UseGuards } from "@nestjs/common";
import {
  Args,
  Context,
  Info,
  Mutation,
  Parent,
  Query,
  ResolveField,
  Resolver,
  Int,
} from "@nestjs/graphql";
import type DataLoader from "dataloader";
import type { GraphQLResolveInfo } from "graphql";
import { Loader } from "nestjs-dataloader";

import { PermissionsAll } from "../../common/decorators/permissions.decorator";
import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import { AuthenticatedUser } from "../../modules/auth/auth.service";
import {
  itemReadModelPublishedAt,
  itemReadModelToMetaGraph,
  itemReadModelToProcessedGraph,
  itemReadModelToProcessedPreviewGraph,
  itemReadModelToRawGraph,
  itemReadModelToRawPreviewGraph,
} from "../../modules/items/item-read-model.utils";
import { ItemsRssTranslationService } from "../../modules/items/items-rss-translation.service";
import { ItemsService } from "../../modules/items/items.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import {
  ItemsQueryArgs,
  CreateItemInput,
  UpdateItemInput,
  ItemsFacetsArgs,
  ItemsOrderBy,
  ItemsRankingMode,
  TranslateRssItemsInput
} from "../dto/item.input";
import type { GqlRequest } from "../graphql.types";
import { ItemMetaLoader } from "../loaders/item-meta.loader";
import {
  ItemReadModelLoader,
  ItemReadModelProcessedLoader,
  ItemReadModelProcessedPreviewLoader,
  ItemReadModelRawLoader,
  ItemReadModelRawPreviewLoader,
} from "../loaders/item-read-model.loader";
import type { ProcessedItemPreviewDoc } from "../loaders/processed-item-preview.loader";
import { ProcessedItemPreviewLoader } from "../loaders/processed-item-preview.loader";
import type { ProcessedItemDoc } from "../loaders/processed-item.loader";
import { ProcessedItemLoader, ProcessedItemScalarLoader } from "../loaders/processed-item.loader";
import type { RawItemPreviewDoc } from "../loaders/raw-item-preview.loader";
import { RawItemPreviewLoader } from "../loaders/raw-item-preview.loader";
import type { RawItemDoc } from "../loaders/raw-item.loader";
import { RawItemLoader } from "../loaders/raw-item.loader";
import {
  ItemModel,
  ItemConnection,
  ItemEdge,
  ItemMetaModel,
  RawItemModelGraph,
  ProcessedItemModelGraph,
  RawItemPreviewModelGraph,
  ProcessedItemPreviewModelGraph,
  ItemFacets,
  RssSourceOptionModel,
  RssTranslationProviderStatusModel,
  TranslateRssItemsPayloadModel
} from "../models/item.model";
import { PageInfo } from "../models/page-info.model";
import {
  SearchSuggestionModel,
  SearchSuggestionOrigin,
  SearchSuggestionType
} from "../models/search-suggestion.model";
import { normalizeProcessedResult } from "../utils/normalize-processed-result";
import { selectionContainsField } from "../utils/selection-contains-field";

interface ItemsCursorPayload {
  id: string;
  createdAt?: string;
  sortAt?: string;
  offset?: number;
}

function encodeCursor(value: ItemsCursorPayload) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function decodeCursor(cursor?: string | null): ItemsCursorPayload | undefined {
  if (!cursor) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf8");
    if (!decoded) {
      return undefined;
    }
    if (decoded.startsWith("{")) {
      const parsed = JSON.parse(decoded) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return undefined;
      }
      const payload = parsed as Record<string, unknown>;
      const id = typeof payload.id === "string" ? payload.id : undefined;
      if (!id) {
        return undefined;
      }
      return {
        id,
        createdAt: typeof payload.createdAt === "string" ? payload.createdAt : undefined,
        sortAt: typeof payload.sortAt === "string" ? payload.sortAt : undefined,
        offset:
          typeof payload.offset === "number" && Number.isFinite(payload.offset)
            ? Math.floor(payload.offset)
            : undefined
      };
    }

    return { id: decoded };
  } catch {
    return undefined;
  }
}

function normalizeIsoDateTimeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = parseDateTime(trimmed);
  return parsed ? parsed.toISOString() : null;
}

function queryRequestsTotalCount(info?: GraphQLResolveInfo): boolean {
  const rootSelections = info?.fieldNodes?.flatMap((node) => node.selectionSet?.selections ?? []) ?? [];
  return selectionContainsField(rootSelections, "totalCount", info?.fragments);
}

function queryRequestsProcessedResult(info?: GraphQLResolveInfo): boolean {
  const selections = info?.fieldNodes?.flatMap((node) => node.selectionSet?.selections ?? []) ?? [];
  return (
    selectionContainsField(selections, "result", info?.fragments) ||
    selectionContainsField(selections, "resultJson", info?.fragments)
  );
}

function resolvePublishedAtFromProcessedResult(result: unknown): string | null {
  const normalized = normalizeProcessedResult(result);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    return null;
  }
  const record = normalized as Record<string, unknown>;
  const candidate = record.published_at ?? record.publishedAt;
  return normalizeIsoDateTimeString(candidate);
}

function resolvePublishedAtFromRawPayload(payload?: Record<string, unknown>): string | null {
  if (!payload) {
    return null;
  }
  const candidate =
    (payload as { publishedAt?: unknown }).publishedAt ??
    (payload as { published_at?: unknown }).published_at;
  return normalizeIsoDateTimeString(candidate);
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pickFirstNonEmptyString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const candidate = normalizeNonEmptyString(obj[key]);
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized = value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry.trim();
      }
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const record = entry as Record<string, unknown>;
        const candidate =
          (typeof record.name === "string" && record.name.trim() ? record.name : null) ??
          (typeof record.label === "string" && record.label.trim() ? record.label : null) ??
          (typeof record.value === "string" && record.value.trim() ? record.value : null) ??
          (typeof record.topic === "string" && record.topic.trim() ? record.topic : null) ??
          null;
        return candidate ? candidate.trim() : "";
      }
      return "";
    })
    .filter((entry) => entry.length > 0);
  return Array.from(new Set(normalized));
}

function normalizeEntityNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized = value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry.trim();
      }
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        return typeof (entry as { name?: unknown }).name === "string"
          ? ((entry as { name?: string }).name ?? "").trim()
          : "";
      }
      return "";
    })
    .filter((entry) => entry.length > 0);
  return Array.from(new Set(normalized));
}

function normalizeFiniteNumber(value: unknown): number | null {
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

function pickFirstFiniteNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const candidate = normalizeFiniteNumber(obj[key]);
    if (candidate !== null) {
      return candidate;
    }
  }
  return null;
}

function normalizeContentType(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.replace(/[\s-]+/g, "_");
  if (
    normalized === "news_fact" ||
    normalized === "opinion" ||
    normalized === "analysis" ||
    normalized === "mixed"
  ) {
    return normalized;
  }

  if (
    normalized === "news" ||
    normalized === "fact" ||
    normalized === "facts" ||
    normalized === "report"
  ) {
    return "news_fact";
  }
  if (
    normalized === "editorial" ||
    normalized === "commentary" ||
    normalized === "op_ed" ||
    normalized === "column"
  ) {
    return "opinion";
  }
  if (
    normalized === "insight" ||
    normalized === "insights" ||
    normalized === "explainer"
  ) {
    return "analysis";
  }
  if (normalized === "hybrid") {
    return "mixed";
  }

  return null;
}

function normalizeSeriesPoints(
  value: unknown,
  options?: { limit?: number }
): { timestamp: string; value: number }[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const limit = Math.min(Math.max(options?.limit ?? 60, 1), 500);

  const points: { timestamp: string; value: number }[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const timestamp =
      normalizeNonEmptyString(record.timestamp) ??
      normalizeNonEmptyString(record.time) ??
      normalizeNonEmptyString(record.date);
    const pointValue = normalizeFiniteNumber(record.value);
    if (!timestamp || pointValue === null) {
      continue;
    }
    points.push({ timestamp, value: pointValue });
    if (points.length >= limit) {
      break;
    }
  }

  return points.length > 0 ? points : null;
}

@Resolver(() => ItemModel)
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class ItemsResolver {
  constructor(
    private readonly itemsService: ItemsService,
    @Optional() private readonly rssTranslationService?: ItemsRssTranslationService
  ) {}

  @HasPermission("items.read")
  @Query(() => ItemConnection)
  async items(
    @Context("req") req: GqlRequest,
    @Args() args: ItemsQueryArgs,
    @Info() info: GraphQLResolveInfo,
  ): Promise<ItemConnection> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new BadRequestException("Unauthenticated");
    }

    if (args.after && args.page) {
      throw new BadRequestException("Use either 'after' cursor or 'page' pagination, not both.");
    }

    const orderBy =
      args.orderBy === ItemsOrderBy.PUBLISHED_DESC
        ? "PUBLISHED_DESC"
        : args.orderBy === ItemsOrderBy.PERSONALIZED
          ? "PERSONALIZED"
          : "CREATED_DESC";
    const normalizedSearch = typeof args.search === "string" ? args.search.trim() : "";
    const rankingMode =
      args.rankingMode ??
      (normalizedSearch.length > 0 ? ItemsRankingMode.RELEVANCE : ItemsRankingMode.RECENCY);

    if (typeof args.page === "number") {
      const { items, total, page, pageSize } = await this.itemsService.list(
        requester.orgId,
        args.page,
        args.first,
        args.search,
        args.filters,
        orderBy,
        rankingMode,
        requester.id
      );

      const edges: ItemEdge[] = items.map((item, index) => ({
        cursor: encodeCursor(
          rankingMode === ItemsRankingMode.RELEVANCE || orderBy === "PERSONALIZED"
            ? { id: item.id, offset: (page - 1) * pageSize + index }
            : orderBy === "PUBLISHED_DESC"
            ? { id: item.id, sortAt: item.sortAt?.toISOString?.() }
            : { id: item.id, createdAt: item.createdAt.toISOString() }
        ),
        node: this.toItemModel(item)
      }));

      const pageInfo: PageInfo = {
        hasNextPage: page * pageSize < total,
        endCursor: edges.at(-1)?.cursor ?? null
      };

      return {
        edges,
        pageInfo,
        totalCount: total
      };
    }

    const cursor = decodeCursor(args.after);
    const includeTotalCount = queryRequestsTotalCount(info);
    const { items, hasNextPage, totalCount } = await this.itemsService.listWithCursor(
      requester.orgId,
      args.first,
      cursor,
      args.search,
      args.filters,
      orderBy,
      rankingMode,
      requester.id,
      includeTotalCount
    );

    const edges: ItemEdge[] = items.map((item) => {
      // `rankOffset` is only attached when rankingMode is RELEVANCE.
      const rankOffset = (item as { rankOffset?: unknown }).rankOffset;
      return {
        cursor: encodeCursor(
          rankingMode === ItemsRankingMode.RELEVANCE || orderBy === "PERSONALIZED"
            ? {
                id: item.id,
                offset:
                  typeof rankOffset === "number" && Number.isFinite(rankOffset)
                    ? Math.floor(rankOffset)
                    : undefined
              }
            : orderBy === "PUBLISHED_DESC"
            ? { id: item.id, sortAt: item.sortAt?.toISOString?.() }
            : { id: item.id, createdAt: item.createdAt.toISOString() }
        ),
        node: this.toItemModel(item)
      };
    });

    const pageInfo: PageInfo = {
      hasNextPage,
      endCursor: edges.at(-1)?.cursor ?? null
    };

    return {
      edges,
      pageInfo,
      totalCount
    };
  }

  @HasPermission("items.read")
  @Query(() => ItemFacets)
  async itemFacets(
    @Context("req") req: GqlRequest,
    @Args() args: ItemsFacetsArgs
  ): Promise<ItemFacets> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new BadRequestException("Unauthenticated");
    }

    return this.itemsService.getFacets(requester.orgId, args.search, args.filters);
  }

  @HasPermission("items.read")
  @Query(() => [RssSourceOptionModel])
  async rssSources(
    @Context("req") req: GqlRequest,
    @Args("windowDays", { nullable: true, type: () => Int }) windowDays?: number,
    @Args("onlyWithItems", { nullable: true, type: () => Boolean }) onlyWithItems?: boolean
  ): Promise<RssSourceOptionModel[]> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new BadRequestException("Unauthenticated");
    }

    return this.itemsService.listRssSourcesForReading(requester.orgId, {
      windowDays,
      onlyWithItems
    });
  }

  @HasPermission("items.read")
  @Query(() => [RssTranslationProviderStatusModel])
  async rssTranslationStatus(
    @Context("req") req: GqlRequest,
    @Args("targetLanguage", { nullable: true, type: () => String }) targetLanguage?: string
  ): Promise<RssTranslationProviderStatusModel[]> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new BadRequestException("Unauthenticated");
    }
    if (!this.rssTranslationService) {
      return [];
    }
    const statuses = await this.rssTranslationService.getProviderStatuses(targetLanguage);
    return statuses.map((status) => ({
      provider: status.provider,
      available: status.available,
      message: status.message,
      targetLanguageSupported: status.targetLanguageSupported
    }));
  }

  @HasPermission("items.read")
  @Mutation(() => TranslateRssItemsPayloadModel)
  async translateRssItems(
    @Context("req") req: GqlRequest,
    @Args("input") input: TranslateRssItemsInput
  ): Promise<TranslateRssItemsPayloadModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new BadRequestException("Unauthenticated");
    }
    if (!this.rssTranslationService) {
      throw new BadRequestException("RSS translation service is unavailable");
    }

    const translated = await this.rssTranslationService.translate(requester.orgId, input);
    return {
      provider: translated.provider,
      targetLanguage: translated.targetLanguage,
      translations: translated.translations.map((entry) => ({
        itemId: entry.itemId,
        title: entry.title,
        summary: entry.summary,
        keyPoints: entry.keyPoints,
        cleanedMarkdown: entry.cleanedMarkdown
      }))
    };
  }

  @HasPermission("items.read")
  @Query(() => [SearchSuggestionModel])
  async searchSuggestions(
    @Context("req") req: GqlRequest,
    @Args("prefix") prefix: string,
    @Args("limit", { nullable: true, type: () => Number }) limit?: number
  ): Promise<SearchSuggestionModel[]> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new BadRequestException("Unauthenticated");
    }

    const results = await this.itemsService.searchSuggestions(requester.orgId, prefix, limit);
    return results.map((r) => ({
      type: SearchSuggestionType[r.type],
      value: r.value,
      origin: SearchSuggestionOrigin[r.origin]
    }));
  }

  @HasPermission("items.read")
  @Query(() => ItemModel, { nullable: true })
  async item(@Context("req") req: GqlRequest, @Args("id") id: string): Promise<ItemModel | null> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new BadRequestException("Unauthenticated");
    }

    // item(id) is nullable in the schema and the UI has a dedicated not-found empty
    // state: return null on miss instead of throwing NotFound (which would surface as
    // a GraphQL error and emit error telemetry for an ordinary/expected condition).
    const meta = await this.itemsService.getItemMetaOrNull(requester.orgId, id);
    return meta ? this.toItemModel(meta) : null;
  }

  @HasPermission("items.write")
  @Mutation(() => ItemModel)
  async createItem(
    @Context("req") req: GqlRequest,
    @Args("input") input: CreateItemInput
  ): Promise<ItemModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new BadRequestException("Unauthenticated");
    }

    let parsedPayload: Record<string, unknown>;
    try {
      parsedPayload = JSON.parse(input.payload);
    } catch {
      throw new BadRequestException("payload must be valid JSON");
    }

    const created = await this.itemsService.create(requester.orgId, requester.id, {
      externalId: input.externalId,
      name: input.title,
      status: input.status,
      payload: parsedPayload
    });

    return this.toItemModel(created);
  }

  @PermissionsAll("crawl.read", "items.write")
  @Mutation(() => ItemModel)
  async createItemFromCrawlResult(
    @Context("req") req: GqlRequest,
    @Args("resultId") resultId: string
  ): Promise<ItemModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new BadRequestException("Unauthenticated");
    }

    const normalized = typeof resultId === "string" ? resultId.trim() : "";
    if (!normalized) {
      throw new BadRequestException("resultId is required");
    }

    const itemMeta = await this.itemsService.createFromCrawlResult(
      requester.orgId,
      requester.id,
      normalized
    );

    return this.toItemModel(itemMeta);
  }

  @HasPermission("items.write")
  @Mutation(() => ItemModel)
  async updateItem(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateItemInput
  ): Promise<ItemModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new BadRequestException("Unauthenticated");
    }

    const parsedPayload = input.payload
      ? (() => {
          try {
            return JSON.parse(input.payload!);
          } catch {
            throw new BadRequestException("payload must be valid JSON");
          }
        })()
      : undefined;

    const updated = await this.itemsService.update(requester.orgId, requester.id, {
      id: input.id,
      name: input.title,
      status: input.status,
      payload: parsedPayload
    });

    return this.toItemModel(updated);
  }

  @ResolveField(() => ItemMetaModel)
  async meta(
    @Parent() item: ItemModel,
    @Loader(ItemReadModelLoader) itemReadModelLoader: DataLoader<string, any>,
    @Loader(ItemMetaLoader) itemMetaLoader: DataLoader<string, ItemMetaModel | null>
  ) {
    const readModel = await itemReadModelLoader.load(item.metaId);
    if (readModel) {
      return itemReadModelToMetaGraph(readModel);
    }
    const meta = await itemMetaLoader.load(item.metaId);
    if (!meta) {
      throw new BadRequestException("Item metadata not found");
    }
    return {
      id: meta.id,
      externalId: meta.externalId,
      name: meta.name,
      status: meta.status,
      mongoRef: meta.mongoRef,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt
    };
  }

  @ResolveField(() => String, { nullable: true })
  async publishedAt(
    @Parent() item: ItemModel,
    @Loader(ItemReadModelLoader)
    itemReadModelLoader: DataLoader<string, any>,
    @Loader(ProcessedItemPreviewLoader)
    processedLoader: DataLoader<string, ProcessedItemPreviewDoc | null>,
    @Loader(RawItemPreviewLoader) rawLoader: DataLoader<string, RawItemPreviewDoc | null>
  ): Promise<string | null> {
    const fromMeta = normalizeNonEmptyString(item.publishedAt);
    if (fromMeta) {
      return fromMeta;
    }

    const readModel = await itemReadModelLoader.load(item.metaId);
    if (readModel) {
      const fromReadModel = itemReadModelPublishedAt(readModel);
      if (fromReadModel) {
        return fromReadModel;
      }
    }

    const processed = await processedLoader.load(item.metaId);
    const publishedFromProcessed = processed
      ? resolvePublishedAtFromProcessedResult(processed.result)
      : null;
    if (publishedFromProcessed) {
      return publishedFromProcessed;
    }

    const raw = await rawLoader.load(item.metaId);
    return raw ? resolvePublishedAtFromRawPayload(raw.payload) : null;
  }

  @ResolveField(() => RawItemPreviewModelGraph, { nullable: true })
  async rawPreview(
    @Parent() item: ItemModel,
    @Loader(ItemReadModelRawPreviewLoader) itemReadModelLoader: DataLoader<string, any>,
    @Loader(RawItemPreviewLoader) rawLoader: DataLoader<string, RawItemPreviewDoc | null>
  ): Promise<RawItemPreviewModelGraph | null> {
    const readModel = await itemReadModelLoader.load(item.metaId);
    if (readModel) {
      // The read-model document may exist without a raw snapshot (hydration
      // runs before the pipeline produces one). Fall back to the Mongo loader
      // in that case instead of returning null for a field that has data.
      const fromReadModel = itemReadModelToRawPreviewGraph(readModel);
      if (fromReadModel) {
        return fromReadModel;
      }
    }
    const raw = await rawLoader.load(item.metaId);
    if (!raw) {
      return null;
    }

    const payload =
      raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
        ? raw.payload
        : {};
    const metadataValue = (payload as { metadata?: unknown }).metadata;
    const metadata =
      metadataValue && typeof metadataValue === "object" && !Array.isArray(metadataValue)
        ? (metadataValue as Record<string, unknown>)
        : {};

    const merged = { ...payload, ...metadata };

    return {
      url: pickFirstNonEmptyString(merged, ["url", "link", "sourceUrl"]),
      sourceName: pickFirstNonEmptyString(merged, [
        "sourceName",
        "source_name",
        "source",
        "publisher",
        "siteName",
        "site_name"
      ]),
      thumbnail: pickFirstNonEmptyString(merged, [
        "thumbnail",
        "thumbnailUrl",
        "image",
        "imageUrl",
        "image_url"
      ]),
      summary: pickFirstNonEmptyString(merged, ["summary", "abstract", "description"]),
      sentiment: pickFirstNonEmptyString(merged, ["sentiment_label", "sentimentLabel", "sentiment"]),
      region: pickFirstNonEmptyString(merged, ["region", "country", "area"]),
      location: pickFirstNonEmptyString(merged, ["location"]),
      ticker: pickFirstNonEmptyString(merged, ["ticker", "symbol"]),
      price: pickFirstFiniteNumber(merged, ["price"]),
      changePercent: pickFirstFiniteNumber(merged, ["changePercent", "change_percent", "change"]),
      history: normalizeSeriesPoints((merged as { history?: unknown }).history)
    };
  }

  @ResolveField(() => ProcessedItemPreviewModelGraph, { nullable: true })
  async processedPreview(
    @Parent() item: ItemModel,
    @Loader(ItemReadModelProcessedPreviewLoader)
    itemReadModelLoader: DataLoader<string, any>,
    @Loader(ProcessedItemPreviewLoader)
    processedLoader: DataLoader<string, ProcessedItemPreviewDoc | null>
  ): Promise<ProcessedItemPreviewModelGraph | null> {
    const readModel = await itemReadModelLoader.load(item.metaId);
    if (readModel) {
      // Fall back to the Mongo loader when the read model exists but has no
      // processed snapshot (see rawPreview for the same rationale).
      const fromReadModel = itemReadModelToProcessedPreviewGraph(readModel);
      if (fromReadModel) {
        return fromReadModel;
      }
    }
    const processed = await processedLoader.load(item.metaId);
    if (!processed) {
      return null;
    }

    const normalizedResult = normalizeProcessedResult(processed.result);
    const result =
      normalizedResult && typeof normalizedResult === "object" && !Array.isArray(normalizedResult)
        ? (normalizedResult as Record<string, unknown>)
        : {};

    const summary = pickFirstNonEmptyString(result, ["summary", "abstract"]);
    const title = pickFirstNonEmptyString(result, ["title", "headline", "title_zh", "titleZh"]);
    const sentiment = pickFirstNonEmptyString(result, [
      "sentiment_label",
      "sentimentLabel",
      "sentiment"
    ]);
    const source = pickFirstNonEmptyString(result, ["source", "sourceName", "source_name"]);
    const language = pickFirstNonEmptyString(result, ["language", "lang"]);
    const publishedAt = normalizeIsoDateTimeString(result.published_at ?? result.publishedAt);
    const location =
      normalizeNonEmptyString(result.location) ?? normalizeNonEmptyString(result.region);
    const qualityScore = pickFirstFiniteNumber(result, ["quality_score", "qualityScore"]);
    const topics = normalizeStringList(result.topics);
    const entities = normalizeEntityNames(result.entities);
    const contentType = normalizeContentType(result.content_type ?? result.contentType);

    return {
      id: processed.id,
      itemMetaId: processed.itemMetaId,
      status: processed.status,
      tags: processed.tags ?? [],
      duplicateOf: processed.duplicateOf ?? null,
      duplicateSimilarity:
        typeof processed.duplicateSimilarity === "number" ? processed.duplicateSimilarity : null,
      llm: processed.llm ?? null,
      source,
      title,
      language,
      publishedAt,
      summary,
      sentiment,
      contentType,
      topics,
      entities,
      qualityScore,
      location,
      createdAt: processed.createdAt
    };
  }

  @ResolveField(() => RawItemModelGraph, { nullable: true })
  async raw(
    @Parent() item: ItemModel,
    @Loader(ItemReadModelRawLoader) itemReadModelLoader: DataLoader<string, any>,
    @Loader(RawItemLoader) rawLoader: DataLoader<string, RawItemDoc | null>
  ): Promise<RawItemModelGraph | null> {
    const readModel = await itemReadModelLoader.load(item.metaId);
    if (readModel) {
      const fromReadModel = itemReadModelToRawGraph(readModel);
      if (fromReadModel) {
        return fromReadModel;
      }
    }
    const raw = await rawLoader.load(item.metaId);
    if (!raw) {
      return null;
    }
    return {
      ...raw,
      payload: JSON.stringify(raw.payload)
    };
  }

  @ResolveField(() => ProcessedItemModelGraph, { nullable: true })
  async processed(
    @Parent() item: ItemModel,
    @Info() info: GraphQLResolveInfo,
    @Loader(ItemReadModelProcessedLoader) fullItemReadModelLoader: DataLoader<string, any>,
    @Loader(ItemReadModelProcessedPreviewLoader)
    scalarItemReadModelLoader: DataLoader<string, any>,
    @Loader(ProcessedItemLoader) fullProcessedLoader: DataLoader<string, ProcessedItemDoc | null>,
    @Loader(ProcessedItemScalarLoader)
    scalarProcessedLoader: DataLoader<string, ProcessedItemDoc | null>
  ): Promise<ProcessedItemModelGraph | null> {
    const includeResult = queryRequestsProcessedResult(info);
    const itemReadModelLoader = includeResult ? fullItemReadModelLoader : scalarItemReadModelLoader;
    const readModel = await itemReadModelLoader.load(item.metaId);
    if (readModel) {
      const fromReadModel = itemReadModelToProcessedGraph(readModel);
      if (fromReadModel) {
        return fromReadModel;
      }
    }
    const processedLoader = includeResult ? fullProcessedLoader : scalarProcessedLoader;
    const processed = await processedLoader.load(item.metaId);
    if (!processed) {
      return null;
    }
    const normalizedResult = normalizeProcessedResult(processed.result);
    const resultJson =
      normalizedResult && typeof normalizedResult === "object" && !Array.isArray(normalizedResult)
        ? (normalizedResult as Record<string, unknown>)
        : null;
    return {
      ...processed,
      result: normalizedResult === null ? undefined : JSON.stringify(normalizedResult),
      resultJson
    };
  }

  private toItemModel(meta: {
    id: string;
    name: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
    orgId: string;
    publishedAt?: Date | null;
    relevanceScore?: number | null;
    searchHighlights?: Record<string, string[]> | null;
  }): ItemModel {
    const searchHighlights =
      meta.searchHighlights && typeof meta.searchHighlights === "object"
        ? Object.entries(meta.searchHighlights)
            .filter(([, snippets]) => Array.isArray(snippets) && snippets.length > 0)
            .map(([field, snippets]) => ({ field, snippets }))
        : null;
    return {
      id: meta.id,
      metaId: meta.id,
      title: meta.name,
      status: meta.status,
      ingestedAt: meta.createdAt,
      publishedAt: meta.publishedAt ? meta.publishedAt.toISOString() : null,
      relevanceScore:
        typeof meta.relevanceScore === "number" && Number.isFinite(meta.relevanceScore)
          ? meta.relevanceScore
          : null,
      searchHighlights,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      orgId: meta.orgId,
      meta: undefined as unknown as ItemMetaModel,
      raw: undefined,
      processed: undefined,
      rawPreview: undefined,
      processedPreview: undefined
    };
  }
}
