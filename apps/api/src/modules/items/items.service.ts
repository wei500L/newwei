import { RawItemModel, ProcessedItemModel } from "@modular/mongo";
import type { MongoConnection } from "@modular/mongo";
import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { MONGO_CONNECTION } from "../config/mongo.provider";
import { PrismaService } from "../config/prisma.service";
import {
  NormalizedNewsPayload,
  NormalizedNewsPayloadSchema
} from "../news-pipeline/news-pipeline.schema";
import { QueueService } from "../queue/queue.service";

import { CreateItemDto } from "./dto/create-item.dto";
import { UpdateItemDto } from "./dto/update-item.dto";


const MAX_CURSOR_PAGE_SIZE = 50;
const FULLTEXT_MIN_TOKEN_LENGTH = 3;
const MAX_TOPIC_GROUPS = 50;
const MAX_TOPIC_ITEMS = 8;
const DEFAULT_TOPIC_WINDOW_DAYS = 30;
const MAX_EVENT_GROUPS = 50;
const MAX_EVENT_ITEMS = 8;
const DEFAULT_EVENT_WINDOW_DAYS = 30;
const DEFAULT_EVENT_MIN_GROUP_SIZE = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

type SearchStrategy =
  | { type: "none" }
  | { type: "fulltext"; query: string }
  | { type: "prefix"; term: string };

interface ItemMetaRow {
  id: string;
  orgId: string;
  externalId: string;
  name: string;
  status: string;
  mongoRef: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

interface TopicGroupItem {
  processedId: string;
  itemMetaId: string;
  title?: string | null;
  summary?: string | null;
  source?: string | null;
  publishedAt?: string | null;
  createdAt: Date;
}

interface TopicGroup {
  topic: string;
  count: number;
  latestAt: Date;
  items: TopicGroupItem[];
}

interface EventGroupItem {
  processedId: string;
  itemMetaId: string;
  title?: string | null;
  summary?: string | null;
  source?: string | null;
  publishedAt?: string | null;
  createdAt: Date;
}

interface EventGroup {
  eventId: string;
  count: number;
  latestAt: Date;
  title?: string | null;
  summary?: string | null;
  source?: string | null;
  publishedAt?: string | null;
  topics: string[];
  entities: string[];
  items: EventGroupItem[];
}

@Injectable()
export class ItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    @Inject(MONGO_CONNECTION) private readonly _mongo: MongoConnection
  ) {
    void this._mongo; // Ensure Mongo connection provider is instantiated.
  }

  async create(orgId: string, userId: string, dto: CreateItemDto) {
    const payload = this.parsePayload(dto.payload);

    const created = await this.prisma.$transaction(async (tx) => {
      const itemMeta = await tx.itemMeta.create({
        data: {
          orgId,
          externalId: dto.externalId,
          name: dto.name,
          status: dto.status ?? "pending",
          mongoRef: ""
        }
      });

      const rawItem = await RawItemModel.create({
        itemMetaId: itemMeta.id,
        payload,
        source: "api"
      });

      await tx.itemMeta.update({
        where: { id: itemMeta.id },
        data: { mongoRef: rawItem.id }
      });

      return { itemMeta, rawItem };
    });

    void writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId: userId,
          resource: "item",
          action: "create",
          metadata: { ...dto, payload }
        }
      },
      { orgId, actorId: userId, resource: "item", action: "create" }
    ).catch(() => undefined);

    await this.queueService.enqueueItem(orgId, created.itemMeta.id, created.rawItem.id);

    return {
      ...created.itemMeta,
      rawItemId: created.rawItem.id
    };
  }

  async list(orgId: string, page = 1, pageSize = 10, search?: string) {
    const take = Math.max(pageSize, 1);
    const skip = (page - 1) * take;
    const strategy = this.resolveSearchStrategy(search);

    if (strategy.type === "fulltext") {
      const { items, total } = await this.listWithFullText(orgId, strategy.query, skip, take);
      return {
        items,
        total,
        page,
        pageSize: take
      };
    }

    const baseWhere = this.buildBaseWhere(orgId);
    const where =
      strategy.type === "prefix" ? this.buildPrefixWhere(baseWhere, strategy.term) : baseWhere;

    const [items, total] = await Promise.all([
      this.prisma.itemMeta.findMany({
        where,
        skip,
        take,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }]
      }),
      this.prisma.itemMeta.count({ where })
    ]);

    return {
      items,
      total,
      page,
      pageSize: take
    };
  }

  async listWithCursor(orgId: string, first = 10, cursorId?: string, search?: string) {
    const take = Math.min(Math.max(first, 1), MAX_CURSOR_PAGE_SIZE);

    const strategy = this.resolveSearchStrategy(search);

    if (strategy.type === "fulltext") {
      return this.listWithCursorFullText(orgId, take, cursorId, strategy.query);
    }

    const baseWhere = this.buildBaseWhere(orgId);
    const where =
      strategy.type === "prefix" ? this.buildPrefixWhere(baseWhere, strategy.term) : baseWhere;

    const items = await this.prisma.itemMeta.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: take + 1,
      ...(cursorId
        ? {
            skip: 1,
            cursor: { id: cursorId }
          }
        : {})
    });

    const hasNextPage = items.length > take;
    const totalCount = await this.prisma.itemMeta.count({ where });

    return {
      items: items.slice(0, take),
      hasNextPage,
      totalCount
    };
  }

  async get(orgId: string, id: string) {
    const itemMeta = await this.prisma.itemMeta.findFirst({
      where: { id, orgId }
    });
    if (!itemMeta) {
      throw new NotFoundException("Item not found");
    }

    const rawItem = itemMeta.mongoRef ? await RawItemModel.findById(itemMeta.mongoRef).lean() : null;
    const processed = await ProcessedItemModel.findOne({ itemMetaId: itemMeta.id })
      .sort({ createdAt: -1 })
      .lean();

    return {
      itemMeta,
      rawItem,
      processed
    };
  }

  async update(orgId: string, userId: string, dto: UpdateItemDto) {
    const existing = await this.prisma.itemMeta.findFirst({
      where: { id: dto.id, orgId }
    });

    if (!existing) {
      throw new NotFoundException("Item not found");
    }

    const normalizedPayload = dto.payload ? this.parsePayload(dto.payload) : undefined;
    let enqueueRef: string | null = null;

    const updated = await this.prisma.$transaction(async (tx) => {
      const updatedMeta = await tx.itemMeta.update({
        where: { id: existing.id },
        data: {
          name: dto.name ?? existing.name,
          status: dto.status ?? existing.status
        }
      });

      let newRawRef = existing.mongoRef;
      if (normalizedPayload) {
        const raw = await RawItemModel.create({
          itemMetaId: existing.id,
          payload: normalizedPayload,
          source: "graphql"
        });
        newRawRef = raw.id;
        await tx.itemMeta.update({
          where: { id: existing.id },
          data: { mongoRef: raw.id }
        });
        enqueueRef = raw.id;
      }

      return {
        ...updatedMeta,
        mongoRef: newRawRef
      };
    });

    if (enqueueRef) {
      await this.queueService.enqueueItem(orgId, existing.id, enqueueRef);
    }

    void writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId: userId,
          resource: "item",
          action: "update",
          metadata: normalizedPayload ? { ...dto, payload: normalizedPayload } : dto
        }
      },
      { orgId, actorId: userId, resource: "item", action: "update" }
    ).catch(() => undefined);

    return updated;
  }

  async listTopicGroups(
    orgId: string,
    options?: { limit?: number; itemsPerGroup?: number; windowDays?: number }
  ): Promise<TopicGroup[]> {
    const normalizedLimit = Math.min(
      Math.max(options?.limit ?? 12, 1),
      MAX_TOPIC_GROUPS
    );
    const normalizedItems = Math.min(
      Math.max(options?.itemsPerGroup ?? 5, 1),
      MAX_TOPIC_ITEMS
    );
    const windowDays = Math.min(
      Math.max(options?.windowDays ?? DEFAULT_TOPIC_WINDOW_DAYS, 1),
      DEFAULT_TOPIC_WINDOW_DAYS * 6
    );
    const since = new Date(Date.now() - windowDays * DAY_MS);

    const pipeline = [
      {
        $match: {
          orgId,
          status: 'completed',
          createdAt: { $gte: since },
          'result.topics.0': { $exists: true }
        }
      },
      {
        $project: {
          itemMetaId: 1,
          createdAt: 1,
          result: 1
        }
      },
      {
        $unwind: '$result.topics'
      },
      {
        $match: {
          'result.topics': { $nin: [null, ''] }
        }
      },
      {
        $sort: { createdAt: -1 }
      },
      {
        $group: {
          _id: '$result.topics',
          count: { $sum: 1 },
          latestAt: { $first: '$createdAt' },
          items: {
            $push: {
              processedId: '$_id',
              itemMetaId: '$itemMetaId',
              title: '$result.title',
              summary: '$result.summary',
              source: '$result.source',
              publishedAt: '$result.published_at',
              createdAt: '$createdAt'
            }
          }
        }
      },
      {
        $project: {
          _id: 1,
          count: 1,
          latestAt: 1,
          items: { $slice: ['$items', normalizedItems] }
        }
      },
      {
        $sort: { latestAt: -1, count: -1 }
      },
      {
        $limit: normalizedLimit
      }
    ];

    const groups = await ProcessedItemModel.aggregate<{
      _id: string;
      count: number;
      latestAt: Date;
      items: Array<{
        processedId: { toString: () => string };
        itemMetaId: string;
        title?: string | null;
        summary?: string | null;
        source?: string | null;
        publishedAt?: string | null;
        createdAt: Date;
      }>;
    }>(pipeline);

    return groups.map((group) => ({
      topic: group._id,
      count: group.count,
      latestAt: group.latestAt,
      items: group.items.map((item) => ({
        processedId: item.processedId.toString(),
        itemMetaId: item.itemMetaId,
        title: item.title ?? undefined,
        summary: item.summary ?? undefined,
        source: item.source ?? undefined,
        publishedAt: item.publishedAt ?? undefined,
        createdAt: item.createdAt
      }))
    }));
  }

  async listEventGroups(
    orgId: string,
    options?: { limit?: number; itemsPerGroup?: number; windowDays?: number; minGroupSize?: number }
  ): Promise<EventGroup[]> {
    const normalizedLimit = Math.min(
      Math.max(options?.limit ?? 12, 1),
      MAX_EVENT_GROUPS
    );
    const normalizedItems = Math.min(
      Math.max(options?.itemsPerGroup ?? 5, 1),
      MAX_EVENT_ITEMS
    );
    const windowDays = Math.min(
      Math.max(options?.windowDays ?? DEFAULT_EVENT_WINDOW_DAYS, 1),
      DEFAULT_EVENT_WINDOW_DAYS * 6
    );
    const minGroupSize = Math.min(
      Math.max(options?.minGroupSize ?? DEFAULT_EVENT_MIN_GROUP_SIZE, 1),
      50
    );
    const since = new Date(Date.now() - windowDays * DAY_MS);

    const pipeline = [
      {
        $match: {
          orgId,
          status: "completed",
          createdAt: { $gte: since }
        }
      },
      {
        $project: {
          itemMetaId: 1,
          createdAt: 1,
          duplicateOf: 1,
          result: 1
        }
      },
      {
        $addFields: {
          primaryTopic: {
            $arrayElemAt: [{ $ifNull: ["$result.topics", []] }, 0]
          },
          primaryEntity: {
            $arrayElemAt: [
              {
                $map: {
                  input: {
                    $filter: {
                      input: { $ifNull: ["$result.entities", []] },
                      as: "entity",
                      cond: {
                        $and: [
                          { $ne: ["$$entity.name", null] },
                          { $ne: ["$$entity.name", ""] }
                        ]
                      }
                    }
                  },
                  as: "entity",
                  in: "$$entity.name"
                }
              },
              0
            ]
          }
        }
      },
      {
        $addFields: {
          entityKey: {
            $cond: [
              {
                $and: [
                  { $ne: ["$primaryEntity", null] },
                  { $ne: ["$primaryEntity", ""] }
                ]
              },
              { $concat: ["entity:", "$primaryEntity"] },
              null
            ]
          },
          topicKey: {
            $cond: [
              {
                $and: [
                  { $ne: ["$primaryTopic", null] },
                  { $ne: ["$primaryTopic", ""] }
                ]
              },
              { $concat: ["topic:", "$primaryTopic"] },
              null
            ]
          }
        }
      },
      {
        $addFields: {
          groupId: {
            $ifNull: [
              "$duplicateOf",
              {
                $ifNull: ["$entityKey", { $ifNull: ["$topicKey", "$_id"] }]
              }
            ]
          }
        }
      },
      {
        $sort: { createdAt: -1 }
      },
      {
        $group: {
          _id: "$groupId",
          count: { $sum: 1 },
          latestAt: { $first: "$createdAt" },
          title: { $first: "$result.title" },
          summary: { $first: "$result.summary" },
          source: { $first: "$result.source" },
          publishedAt: { $first: "$result.published_at" },
          topics: { $first: "$result.topics" },
          entities: { $first: "$result.entities" },
          items: {
            $push: {
              processedId: "$_id",
              itemMetaId: "$itemMetaId",
              title: "$result.title",
              summary: "$result.summary",
              source: "$result.source",
              publishedAt: "$result.published_at",
              createdAt: "$createdAt"
            }
          }
        }
      },
      {
        $match: {
          count: { $gte: minGroupSize }
        }
      },
      {
        $project: {
          _id: 1,
          count: 1,
          latestAt: 1,
          title: 1,
          summary: 1,
          source: 1,
          publishedAt: 1,
          topics: 1,
          entities: 1,
          items: { $slice: ["$items", normalizedItems] }
        }
      },
      {
        $sort: { latestAt: -1, count: -1 }
      },
      {
        $limit: normalizedLimit
      }
    ];

    const groups = await ProcessedItemModel.aggregate<{
      _id: { toString: () => string };
      count: number;
      latestAt: Date;
      title?: string | null;
      summary?: string | null;
      source?: string | null;
      publishedAt?: string | null;
      topics?: string[] | null;
      entities?: Array<{ name?: string | null } | null> | null;
      items: Array<{
        processedId: { toString: () => string };
        itemMetaId: string;
        title?: string | null;
        summary?: string | null;
        source?: string | null;
        publishedAt?: string | null;
        createdAt: Date;
      }>;
    }>(pipeline);

    return groups.map((group) => {
      const topics = Array.isArray(group.topics)
        ? group.topics.filter((topic): topic is string => Boolean(topic))
        : [];
      const rawEntities = Array.isArray(group.entities) ? group.entities : [];
      const entityNames = Array.from(
        new Set(
          rawEntities
            .map((entity) =>
              entity && typeof entity.name === "string" ? entity.name : null
            )
            .filter((name): name is string => Boolean(name))
        )
      );

      return {
        eventId: group._id.toString(),
        count: group.count,
        latestAt: group.latestAt,
        title: group.title ?? undefined,
        summary: group.summary ?? undefined,
        source: group.source ?? undefined,
        publishedAt: group.publishedAt ?? undefined,
        topics,
        entities: entityNames,
        items: group.items.map((item) => ({
          processedId: item.processedId.toString(),
          itemMetaId: item.itemMetaId,
          title: item.title ?? undefined,
          summary: item.summary ?? undefined,
          source: item.source ?? undefined,
          publishedAt: item.publishedAt ?? undefined,
          createdAt: item.createdAt
        }))
      };
    });
  }

  private resolveSearchStrategy(search?: string): SearchStrategy {
    const normalized = search?.trim();
    if (!normalized) {
      return { type: "none" };
    }

    const fullTextQuery = this.buildFullTextQuery(normalized);
    if (fullTextQuery) {
      return { type: "fulltext", query: fullTextQuery };
    }

    return { type: "prefix", term: normalized };
  }

  private buildFullTextQuery(search: string): string | null {
    const tokens = search
      .split(/\s+/)
      .map((token) => token.replace(/[+-><()~"*@]+/g, ""))
      .filter((token) => token.length >= FULLTEXT_MIN_TOKEN_LENGTH);

    if (tokens.length === 0) {
      return null;
    }

    return tokens.map((token) => `${token}*`).join(" ");
  }

  private buildBaseWhere(orgId: string) {
    return { orgId, status: { not: "duplicate" } };
  }

  private buildPrefixWhere(baseWhere: { orgId: string; status: { not: string } }, term: string) {
    return {
      ...baseWhere,
      OR: [
        { name: { startsWith: term } },
        { externalId: { startsWith: term } }
      ]
    };
  }

  private async listWithFullText(orgId: string, query: string, skip: number, take: number) {
    const items = await this.prisma.$queryRaw<ItemMetaRow[]>`
      SELECT \`id\`, \`orgId\`, \`externalId\`, \`name\`, \`status\`, \`mongoRef\`, \`version\`, \`createdAt\`, \`updatedAt\`
      FROM \`ItemMeta\`
      WHERE \`orgId\` = ${orgId}
        AND \`status\` <> 'duplicate'
        AND MATCH(\`name\`, \`externalId\`) AGAINST (${query} IN BOOLEAN MODE)
      ORDER BY \`createdAt\` DESC, \`id\` DESC
      LIMIT ${take} OFFSET ${skip}
    `;

    const totalResult = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count
      FROM \`ItemMeta\`
      WHERE \`orgId\` = ${orgId}
        AND \`status\` <> 'duplicate'
        AND MATCH(\`name\`, \`externalId\`) AGAINST (${query} IN BOOLEAN MODE)
    `;

    const total = Number(totalResult[0]?.count ?? 0);

    return { items, total };
  }

  private async listWithCursorFullText(
    orgId: string,
    take: number,
    cursorId: string | undefined,
    query: string
  ) {
    const cursor = cursorId
      ? await this.prisma.itemMeta.findFirst({
          where: { id: cursorId, orgId },
          select: { id: true, createdAt: true }
        })
      : null;

    if (cursorId && !cursor) {
      throw new NotFoundException("Cursor not found");
    }

    const cursorClause = cursor
      ? Prisma.sql`AND (\`createdAt\` < ${cursor.createdAt} OR (\`createdAt\` = ${cursor.createdAt} AND \`id\` < ${cursor.id}))`
      : Prisma.sql``;

    const items = await this.prisma.$queryRaw<ItemMetaRow[]>`
      SELECT \`id\`, \`orgId\`, \`externalId\`, \`name\`, \`status\`, \`mongoRef\`, \`version\`, \`createdAt\`, \`updatedAt\`
      FROM \`ItemMeta\`
      WHERE \`orgId\` = ${orgId}
        AND \`status\` <> 'duplicate'
        AND MATCH(\`name\`, \`externalId\`) AGAINST (${query} IN BOOLEAN MODE)
        ${cursorClause}
      ORDER BY \`createdAt\` DESC, \`id\` DESC
      LIMIT ${take + 1}
    `;

    const totalCountResult = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count
      FROM \`ItemMeta\`
      WHERE \`orgId\` = ${orgId}
        AND \`status\` <> 'duplicate'
        AND MATCH(\`name\`, \`externalId\`) AGAINST (${query} IN BOOLEAN MODE)
    `;

    const totalCount = Number(totalCountResult[0]?.count ?? 0);

    return {
      items: items.slice(0, take),
      hasNextPage: items.length > take,
      totalCount
    };
  }

  private parsePayload(payload: Record<string, unknown>): NormalizedNewsPayload {
    const parsed = NormalizedNewsPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      const [firstError] = parsed.error.errors;
      const message = firstError?.message ?? "payload is invalid";
      throw new BadRequestException(`Invalid payload: ${message}`);
    }
    return parsed.data;
  }
}
