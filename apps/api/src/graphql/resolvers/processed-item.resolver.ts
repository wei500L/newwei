import { ProcessedItemModel } from "@modular/mongo";
import { BadRequestException, ForbiddenException, UseGuards } from "@nestjs/common";
import { Args, Context, ID, Query, Resolver } from "@nestjs/graphql";
import { Types } from "mongoose";

import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import type { AuthenticatedUser } from "../../modules/auth/auth.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import type { GqlRequest } from "../graphql.types";
import { ProcessedItemModelGraph } from "../models/item.model";
import { normalizeProcessedResult } from "../utils/normalize-processed-result";

interface LeanProcessedItem {
  _id: { toString(): string };
  orgId: string;
  itemMetaId: string;
  status: string;
  error?: unknown;
  tags?: unknown;
  result?: unknown;
  duplicateOf?: unknown;
  duplicateSimilarity?: unknown;
  llm?: unknown;
  summaryEmbedding?: unknown;
  summaryEmbeddingModel?: unknown;
  createdAt: Date;
}

@Resolver(() => ProcessedItemModelGraph)
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class ProcessedItemResolver {
  @HasPermission("items.read")
  @Query(() => ProcessedItemModelGraph, { nullable: true })
  async processedItemById(
    @Context("req") req: GqlRequest,
    @Args("id", { type: () => ID }) id: string
  ): Promise<ProcessedItemModelGraph | null> {
    const user = this.requireUser(req);

    const normalizedId = typeof id === "string" ? id.trim() : "";
    if (!Types.ObjectId.isValid(normalizedId)) {
      throw new BadRequestException("Invalid processed item id");
    }

    const doc = (await ProcessedItemModel.findOne({ _id: normalizedId, orgId: user.orgId }).lean().exec()) as
      | LeanProcessedItem
      | null;
    if (!doc) {
      return null;
    }

    const normalizedResult = normalizeProcessedResult(doc.result);
    const resultJson =
      normalizedResult && typeof normalizedResult === "object" && !Array.isArray(normalizedResult)
        ? (normalizedResult as Record<string, unknown>)
        : null;

    const summaryEmbeddingDimensions = Array.isArray(doc.summaryEmbedding) ? doc.summaryEmbedding.length : null;
    const summaryEmbeddingModel = typeof doc.summaryEmbeddingModel === "string" ? doc.summaryEmbeddingModel : null;

    const tags = Array.isArray(doc.tags)
      ? doc.tags.filter((entry): entry is string => typeof entry === "string")
      : [];

    const errorRaw = doc.error;
    const error =
      errorRaw && typeof errorRaw === "object" && !Array.isArray(errorRaw)
        ? {
            message:
              typeof (errorRaw as { message?: unknown }).message === "string"
                ? String((errorRaw as { message?: unknown }).message)
                : "Unknown error",
            name:
              typeof (errorRaw as { name?: unknown }).name === "string"
                ? String((errorRaw as { name?: unknown }).name)
                : null
          }
        : null;

    const duplicateOf = doc.duplicateOf
      ? typeof (doc.duplicateOf as { toString?: unknown }).toString === "function"
        ? (doc.duplicateOf as { toString(): string }).toString()
        : String(doc.duplicateOf)
      : null;
    const duplicateSimilarity = typeof doc.duplicateSimilarity === "number" ? doc.duplicateSimilarity : null;

    return {
      id: doc._id.toString(),
      itemMetaId: doc.itemMetaId,
      status: doc.status,
      error,
      tags,
      result: normalizedResult === null ? undefined : JSON.stringify(normalizedResult),
      resultJson,
      duplicateOf,
      duplicateSimilarity,
      llm: (doc.llm as any) ?? null,
      summaryEmbeddingModel,
      summaryEmbeddingDimensions,
      createdAt: doc.createdAt
    };
  }

  private requireUser(req: GqlRequest): AuthenticatedUser {
    const user = req?.user as AuthenticatedUser | undefined;
    if (!user) {
      throw new ForbiddenException("Unauthenticated");
    }
    return user;
  }
}
