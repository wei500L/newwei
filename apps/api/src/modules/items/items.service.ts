import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../config/prisma.service";
import { QueueService } from "../queue/queue.service";
import { CreateItemDto } from "./dto/create-item.dto";
import { RawItemModel, ProcessedItemModel } from "@modular/mongo";
import { MONGO_CONNECTION } from "../config/mongo.provider";
import type { MongoConnection } from "@modular/mongo";
import { UpdateItemDto } from "./dto/update-item.dto";
import {
  NormalizedNewsPayload,
  NormalizedNewsPayloadSchema
} from "../news-pipeline/news-pipeline.schema";

const MAX_CURSOR_PAGE_SIZE = 50;
const FULLTEXT_MIN_TOKEN_LENGTH = 3;

type SearchStrategy =
  | { type: "none" }
  | { type: "fulltext"; query: string }
  | { type: "prefix"; term: string };

type ItemMetaRow = {
  id: string;
  orgId: string;
  externalId: string;
  name: string;
  status: string;
  mongoRef: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

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

      await tx.auditLog.create({
        data: {
          orgId,
          actorId: userId,
          resource: "item",
          action: "create",
          metadata: { ...dto, payload }
        }
      });

      return { itemMeta, rawItem };
    });

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

    const where =
      strategy.type === "prefix" ? this.buildPrefixWhere(orgId, strategy.term) : { orgId };

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

    const where =
      strategy.type === "prefix" ? this.buildPrefixWhere(orgId, strategy.term) : { orgId };

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

      await tx.auditLog.create({
        data: {
          orgId,
          actorId: userId,
          resource: "item",
          action: "update",
          metadata: normalizedPayload ? { ...dto, payload: normalizedPayload } : dto
        }
      });

      return {
        ...updatedMeta,
        mongoRef: newRawRef
      };
    });

    if (enqueueRef) {
      await this.queueService.enqueueItem(orgId, existing.id, enqueueRef);
    }

    return updated;
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

  private buildPrefixWhere(orgId: string, term: string) {
    return {
      orgId,
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
        AND MATCH(\`name\`, \`externalId\`) AGAINST (${query} IN BOOLEAN MODE)
      ORDER BY \`createdAt\` DESC, \`id\` DESC
      LIMIT ${take} OFFSET ${skip}
    `;

    const totalResult = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count
      FROM \`ItemMeta\`
      WHERE \`orgId\` = ${orgId}
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
        AND MATCH(\`name\`, \`externalId\`) AGAINST (${query} IN BOOLEAN MODE)
        ${cursorClause}
      ORDER BY \`createdAt\` DESC, \`id\` DESC
      LIMIT ${take + 1}
    `;

    const totalCountResult = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count
      FROM \`ItemMeta\`
      WHERE \`orgId\` = ${orgId}
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
