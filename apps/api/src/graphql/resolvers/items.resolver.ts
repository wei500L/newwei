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
import { ItemsQueryArgs, CreateItemInput, UpdateItemInput } from "../dto/item.input";
import type { GqlRequest } from "../graphql.types";
import { ItemMetaLoader } from "../loaders/item-meta.loader";
import { ProcessedItemLoader } from "../loaders/processed-item.loader";
import { RawItemLoader } from "../loaders/raw-item.loader";
import { ItemModel, ItemConnection, ItemEdge, ItemMetaModel, RawItemModelGraph, ProcessedItemModelGraph } from "../models/item.model";
import { PageInfo } from "../models/page-info.model";

function encodeCursor(value: string) {
  return Buffer.from(value, "utf8").toString("base64");
}

function decodeCursor(cursor?: string | null) {
  return cursor ? Buffer.from(cursor, "base64").toString("utf8") : undefined;
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

    const cursorId = decodeCursor(args.after);
    const { items, hasNextPage, totalCount } = await this.itemsService.listWithCursor(
      requester.orgId,
      args.first,
      cursorId,
      args.search
    );

    const edges: ItemEdge[] = items.map((item) => ({
      cursor: encodeCursor(item.id),
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

  @ResolveField(() => RawItemModelGraph, { nullable: true })
  async raw(
    @Parent() item: ItemModel,
    @Loader(RawItemLoader) rawLoader: DataLoader<string, RawItemModelGraph | null>
  ) {
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
    @Loader(ProcessedItemLoader) processedLoader: DataLoader<string, ProcessedItemModelGraph | null>
  ) {
    const processed = await processedLoader.load(item.metaId);
    if (!processed) {
      return null;
    }
    return {
      ...processed,
      result: processed.result ? JSON.stringify(processed.result) : undefined
    };
  }

  private toItemModel(meta: {
    id: string;
    name: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
    orgId: string;
  }): ItemModel {
    return {
      id: meta.id,
      metaId: meta.id,
      title: meta.name,
      status: meta.status,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      orgId: meta.orgId,
      meta: undefined as unknown as ItemMetaModel,
      raw: undefined,
      processed: undefined
    };
  }
}
