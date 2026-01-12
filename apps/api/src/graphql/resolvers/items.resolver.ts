import { parseDateTime } from "@modular/utils";
import { BadRequestException, UseGuards } from "@nestjs/common";
import {
  Args,
  Context,
  Mutation,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from "@nestjs/graphql";
import type DataLoader from "dataloader";
import { Loader } from "nestjs-dataloader";

import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import { AuthenticatedUser } from "../../modules/auth/auth.service";
import { ItemsService } from "../../modules/items/items.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import {
  ItemsQueryArgs,
  CreateItemInput,
  UpdateItemInput,
  ItemsFacetsArgs,
  ItemsOrderBy
} from "../dto/item.input";
import type { GqlRequest } from "../graphql.types";
import { ItemMetaLoader } from "../loaders/item-meta.loader";
import type { ProcessedItemPreviewDoc } from "../loaders/processed-item-preview.loader";
import { ProcessedItemPreviewLoader } from "../loaders/processed-item-preview.loader";
import type { ProcessedItemDoc } from "../loaders/processed-item.loader";
import { ProcessedItemLoader } from "../loaders/processed-item.loader";
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
  ItemFacets
} from "../models/item.model";
import { PageInfo } from "../models/page-info.model";

interface ItemsCursorPayload {
  id: string;
  createdAt?: string;
  sortAt?: string;
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
        sortAt: typeof payload.sortAt === "string" ? payload.sortAt : undefined
      };
    }

    return { id: decoded };
  } catch {
    return undefined;
  }
}

function normalizeProcessedResult(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "string") {
        return normalizeProcessedResult(parsed);
      }
      return parsed;
    } catch {
      return null;
    }
  }
  return value;
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
  constructor(private readonly itemsService: ItemsService) {}

  @HasPermission("items.read")
  @Query(() => ItemConnection)
  async items(
    @Context("req") req: GqlRequest,
    @Args() args: ItemsQueryArgs
  ): Promise<ItemConnection> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new BadRequestException("Unauthenticated");
    }

    if (args.after && args.page) {
      throw new BadRequestException("Use either 'after' cursor or 'page' pagination, not both.");
    }

    const orderBy = args.orderBy === ItemsOrderBy.PUBLISHED_DESC ? "PUBLISHED_DESC" : "CREATED_DESC";

    if (typeof args.page === "number") {
      const { items, total, page, pageSize } = await this.itemsService.list(
        requester.orgId,
        args.page,
        args.first,
        args.search,
        args.filters,
        orderBy
      );

      const edges: ItemEdge[] = items.map((item) => ({
        cursor: encodeCursor(
          orderBy === "PUBLISHED_DESC"
            ? { id: item.id, sortAt: item.sortAt?.toISOString?.() }
            : { id: item.id, createdAt: item.createdAt.toISOString() }
        ),
        node: this.toItemModel(item)
      }));

      const pageInfo: PageInfo = {
        hasNextPage: page * pageSize < total,
        endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null
      };

      return {
        edges,
        pageInfo,
        totalCount: total
      };
    }

    const cursor = decodeCursor(args.after);
    const { items, hasNextPage, totalCount } = await this.itemsService.listWithCursor(
      requester.orgId,
      args.first,
      cursor,
      args.search,
      args.filters,
      orderBy
    );

    const edges: ItemEdge[] = items.map((item) => ({
      cursor: encodeCursor(
        orderBy === "PUBLISHED_DESC"
          ? { id: item.id, sortAt: item.sortAt?.toISOString?.() }
          : { id: item.id, createdAt: item.createdAt.toISOString() }
      ),
      node: this.toItemModel(item)
    }));

    const pageInfo: PageInfo = {
      hasNextPage,
      endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null
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
  @Query(() => ItemModel, { nullable: true })
  async item(@Context("req") req: GqlRequest, @Args("id") id: string): Promise<ItemModel | null> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new BadRequestException("Unauthenticated");
    }

    const data = await this.itemsService.get(requester.orgId, id);
    if (!data) {
      return null;
    }

    return this.toItemModel(data.itemMeta);
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
    @Loader(ItemMetaLoader) itemMetaLoader: DataLoader<string, ItemMetaModel | null>
  ) {
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
    @Loader(ProcessedItemPreviewLoader)
    processedLoader: DataLoader<string, ProcessedItemPreviewDoc | null>,
    @Loader(RawItemPreviewLoader) rawLoader: DataLoader<string, RawItemPreviewDoc | null>
  ): Promise<string | null> {
    const fromMeta = normalizeNonEmptyString(item.publishedAt);
    if (fromMeta) {
      return fromMeta;
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
    @Loader(RawItemPreviewLoader) rawLoader: DataLoader<string, RawItemPreviewDoc | null>
  ): Promise<RawItemPreviewModelGraph | null> {
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
    @Loader(ProcessedItemPreviewLoader)
    processedLoader: DataLoader<string, ProcessedItemPreviewDoc | null>
  ): Promise<ProcessedItemPreviewModelGraph | null> {
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
    const sentiment = pickFirstNonEmptyString(result, [
      "sentiment_label",
      "sentimentLabel",
      "sentiment"
    ]);
    const source = pickFirstNonEmptyString(result, ["source", "sourceName", "source_name"]);
    const publishedAt = normalizeIsoDateTimeString(result.published_at ?? result.publishedAt);
    const location =
      normalizeNonEmptyString(result.location) ?? normalizeNonEmptyString(result.region);
    const qualityScore = pickFirstFiniteNumber(result, ["quality_score", "qualityScore"]);
    const topics = normalizeStringList(result.topics);
    const entities = normalizeEntityNames(result.entities);

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
      publishedAt,
      summary,
      sentiment,
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
    @Loader(RawItemLoader) rawLoader: DataLoader<string, RawItemDoc | null>
  ): Promise<RawItemModelGraph | null> {
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
    @Loader(ProcessedItemLoader) processedLoader: DataLoader<string, ProcessedItemDoc | null>
  ): Promise<ProcessedItemModelGraph | null> {
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
  }): ItemModel {
    return {
      id: meta.id,
      metaId: meta.id,
      title: meta.name,
      status: meta.status,
      ingestedAt: meta.createdAt,
      publishedAt: meta.publishedAt ? meta.publishedAt.toISOString() : null,
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
