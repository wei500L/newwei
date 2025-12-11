import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../config/prisma.service";
import { QueueService } from "../queue/queue.service";
import { CreateItemDto } from "./dto/create-item.dto";
import { RawItemModel, ProcessedItemModel } from "@modular/mongo";
import { MONGO_CONNECTION } from "../config/mongo.provider";
import type { MongoConnection } from "@modular/mongo";
import { UpdateItemDto } from "./dto/update-item.dto";

const MAX_CURSOR_PAGE_SIZE = 50;

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
        payload: dto.payload,
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
          metadata: dto
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
    const where = this.buildListWhere(orgId, search);
    const [items, total] = await Promise.all([
      this.prisma.itemMeta.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }]
      }),
      this.prisma.itemMeta.count({ where })
    ]);

    return {
      items,
      total,
      page,
      pageSize
    };
  }

  async listWithCursor(orgId: string, first = 10, cursorId?: string, search?: string) {
    const where = this.buildListWhere(orgId, search);
    const take = Math.min(Math.max(first, 1), MAX_CURSOR_PAGE_SIZE);

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
      if (dto.payload) {
        const raw = await RawItemModel.create({
          itemMetaId: existing.id,
          payload: dto.payload,
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
          metadata: dto
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

  private buildListWhere(orgId: string, search?: string) {
    return {
      orgId,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { externalId: { contains: search, mode: "insensitive" } }
            ]
          }
        : {})
    };
  }
}
