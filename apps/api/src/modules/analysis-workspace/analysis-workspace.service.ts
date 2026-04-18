import { ItemReadModelModel, type ItemReadModel } from "@modular/mongo";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  AnalysisSubjectType,
  NewsEventStatus,
  Prisma,
  PrismaClient,
  SavedAnalysisSurface,
  SavedAnalysisVisibility,
} from ".prisma/client";
import { Readable } from "node:stream";

import { ArchiveService } from "../archive/archive.service";
import {
  type ArchiveDigestItem,
  ArchiveRegion,
  ArchiveWeight,
  type ArchiveVerticalCursorInput,
} from "../archive/archive.types";
import type { AuthenticatedUser } from "../auth/auth.service";
import { PrismaService } from "../config/prisma.service";
import type {
  ItemMetaRow,
  ItemsOrderBy,
  ItemsRankingMode,
} from "../items/items.service";
import { ItemsService } from "../items/items.service";
import type {
  NewsEventAuthorityProfile,
  NewsEventSourceClassification,
} from "../news-events/news-events.service";
import { NewsEventsService } from "../news-events/news-events.service";
import { NewsEventsSettingsService } from "../news-events/news-events-settings.service";

const MAX_EXPORT_ROWS = 5000;
const EVENT_DEDUPE_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;
const USER_SUMMARY_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
} satisfies Prisma.UserSelect;
const SAVED_VIEW_INCLUDE = {
  createdBy: {
    select: USER_SUMMARY_SELECT,
  },
  updatedBy: {
    select: USER_SUMMARY_SELECT,
  },
} satisfies Prisma.SavedAnalysisViewInclude;
const THREAD_INCLUDE = {
  createdBy: {
    select: USER_SUMMARY_SELECT,
  },
  updatedBy: {
    select: USER_SUMMARY_SELECT,
  },
  comments: {
    orderBy: [{ createdAt: "asc" }],
    include: {
      createdBy: {
        select: USER_SUMMARY_SELECT,
      },
    },
  },
} satisfies Prisma.AnalysisThreadInclude;

interface AnalysisActor {
  id: string;
  permissions: readonly string[];
}

export interface QueryStatePayload {
  queryString: string;
}

type SavedViewRecord = Prisma.SavedAnalysisViewGetPayload<{
  include: typeof SAVED_VIEW_INCLUDE;
}>;
type ThreadRecord = Prisma.AnalysisThreadGetPayload<{
  include: typeof THREAD_INCLUDE;
}>;
type CommentRecord = Prisma.AnalysisCommentGetPayload<{
  include: {
    createdBy: {
      select: typeof USER_SUMMARY_SELECT;
    };
  };
}>;
type AnalysisWorkspacePrismaClient = Pick<
  PrismaClient,
  "savedAnalysisView" | "analysisThread" | "analysisComment"
>;
type AnalysisWorkspaceTransactionClient = Prisma.TransactionClient &
  AnalysisWorkspacePrismaClient;

interface EnrichedEventRow {
  row: {
    id: string;
    status: NewsEventStatus;
    language: string | null;
    primaryTopic: string | null;
    primaryEntity: string | null;
    title: string | null;
    summary: string | null;
    startAt: Date;
    lastAt: Date;
    _count?: {
      items: number;
    };
  };
  heat: {
    breaking: boolean;
    heatScore: number;
  };
  authority: NewsEventAuthorityProfile;
}

@Injectable()
export class AnalysisWorkspaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly itemsService: ItemsService,
    private readonly newsEvents: NewsEventsService,
    private readonly newsEventSettings: NewsEventsSettingsService,
    private readonly archiveService: ArchiveService,
  ) {}

  private get analysisPrisma(): AnalysisWorkspacePrismaClient {
    return this.prisma as unknown as AnalysisWorkspacePrismaClient;
  }

  async listViews(
    orgId: string,
    user: AnalysisActor,
    options?: {
      scope?: string;
      surface?: SavedAnalysisSurface;
    },
  ) {
    const scope =
      options?.scope === "mine" || options?.scope === "shared"
        ? options.scope
        : "all";

    const rows = await this.analysisPrisma.savedAnalysisView.findMany({
      where: {
        orgId,
        ...(options?.surface ? { surface: options.surface } : {}),
        ...(scope === "mine"
          ? { createdById: user.id }
          : scope === "shared"
            ? {
                visibility: SavedAnalysisVisibility.org_shared,
                NOT: { createdById: user.id },
              }
            : {
                OR: [
                  { createdById: user.id },
                  { visibility: SavedAnalysisVisibility.org_shared },
                ],
              }),
      },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      include: SAVED_VIEW_INCLUDE,
    });

    return rows.map((row: SavedViewRecord) =>
      this.withSavedViewPermissions(
        this.toSavedViewResponse(row),
        user,
        row.createdById,
      ),
    );
  }

  async getView(orgId: string, user: AnalysisActor, id: string) {
    const row = await this.analysisPrisma.savedAnalysisView.findFirst({
      where: { orgId, id },
      include: SAVED_VIEW_INCLUDE,
    });
    if (!row || !this.canReadSavedView(row, user.id)) {
      throw new NotFoundException("Saved analysis view not found");
    }
    return this.withSavedViewPermissions(
      this.toSavedViewResponse(row),
      user,
      row.createdById,
    );
  }

  async createView(
    orgId: string,
    user: AnalysisActor,
    input: {
      title: string;
      description?: string;
      surface: SavedAnalysisSurface;
      routePath: string;
      queryString?: string;
      visibility?: SavedAnalysisVisibility;
    },
  ) {
    const title = this.normalizeRequiredText(input.title, 120, "title");
    const description = this.normalizeOptionalText(
      input.description,
      1000,
      "description",
    );
    const routePath = this.normalizeRoutePath(input.routePath);
    const queryState = this.buildQueryState(input.queryString);
    const row = await this.analysisPrisma.savedAnalysisView.create({
      data: {
        orgId,
        createdById: user.id,
        updatedById: user.id,
        title,
        description,
        surface: input.surface,
        routePath,
        queryState,
        visibility: input.visibility ?? SavedAnalysisVisibility.private,
      },
      include: SAVED_VIEW_INCLUDE,
    });
    return this.withSavedViewPermissions(
      this.toSavedViewResponse(row),
      user,
      row.createdById,
    );
  }

  async updateView(
    orgId: string,
    user: AnalysisActor,
    id: string,
    input: {
      title?: string;
      description?: string;
      routePath?: string;
      queryString?: string;
      visibility?: SavedAnalysisVisibility;
    },
  ) {
    const existing = await this.analysisPrisma.savedAnalysisView.findFirst({
      where: { orgId, id },
      include: SAVED_VIEW_INCLUDE,
    });
    if (!existing || !this.canReadSavedView(existing, user.id)) {
      throw new NotFoundException("Saved analysis view not found");
    }
    this.assertCanManageOwnedResource(user, existing.createdById);

    const data: Record<string, unknown> = {
      updatedById: user.id,
    };
    if (input.title !== undefined) {
      data.title = this.normalizeRequiredText(input.title, 120, "title");
    }
    if (input.description !== undefined) {
      data.description = this.normalizeOptionalText(
        input.description,
        1000,
        "description",
      );
    }
    if (input.routePath !== undefined) {
      data.routePath = this.normalizeRoutePath(input.routePath);
    }
    if (input.queryString !== undefined) {
      data.queryState = this.buildQueryState(input.queryString);
    }
    if (input.visibility !== undefined) {
      data.visibility = input.visibility;
    }

    const row = await this.analysisPrisma.savedAnalysisView.update({
      where: { id: existing.id },
      data,
      include: SAVED_VIEW_INCLUDE,
    });
    return this.withSavedViewPermissions(
      this.toSavedViewResponse(row),
      user,
      row.createdById,
    );
  }

  async deleteView(orgId: string, user: AnalysisActor, id: string) {
    const existing = await this.analysisPrisma.savedAnalysisView.findFirst({
      where: { orgId, id },
      select: { id: true, createdById: true },
    });
    if (!existing) {
      throw new NotFoundException("Saved analysis view not found");
    }
    this.assertCanManageOwnedResource(user, existing.createdById);

    await this.prisma.$transaction(async (prismaTx) => {
      const tx = prismaTx as AnalysisWorkspaceTransactionClient;
      const thread = await tx.analysisThread.findFirst({
        where: {
          orgId,
          subjectType: AnalysisSubjectType.saved_view,
          subjectId: id,
        },
        select: { id: true },
      });
      if (thread) {
        await tx.analysisComment.deleteMany({
          where: { threadId: thread.id, orgId },
        });
        await tx.analysisThread.delete({ where: { id: thread.id } });
      }
      await tx.savedAnalysisView.delete({ where: { id } });
    });

    return { ok: true };
  }

  async getThread(
    orgId: string,
    userId: string,
    subjectType: AnalysisSubjectType,
    subjectId: string,
  ) {
    await this.assertSubjectReadable(orgId, userId, subjectType, subjectId);
    const row = await this.analysisPrisma.analysisThread.findFirst({
      where: { orgId, subjectType, subjectId },
      include: this.threadInclude(),
    });
    return row ? this.toThreadResponse(row) : null;
  }

  async upsertThread(
    orgId: string,
    user: AnalysisActor,
    subjectType: AnalysisSubjectType,
    subjectId: string,
    noteMarkdown?: string,
  ) {
    await this.assertSubjectWritable(orgId, user.id, subjectType, subjectId);
    const normalizedNote = this.normalizeOptionalText(
      noteMarkdown,
      20000,
      "noteMarkdown",
    );

    let existing = await this.analysisPrisma.analysisThread.findFirst({
      where: { orgId, subjectType, subjectId },
      include: this.threadInclude(),
    });

    if (!existing) {
      if (!normalizedNote) {
        return null;
      }
      try {
        existing = await this.analysisPrisma.analysisThread.create({
          data: {
            orgId,
            createdById: user.id,
            updatedById: user.id,
            subjectType,
            subjectId,
            noteMarkdown: normalizedNote,
          },
          include: this.threadInclude(),
        });
        return this.toThreadResponse(existing);
      } catch (error) {
        if (!this.isUniqueConstraintViolation(error)) {
          throw error;
        }
        existing = await this.analysisPrisma.analysisThread.findFirst({
          where: { orgId, subjectType, subjectId },
          include: this.threadInclude(),
        });
        if (!existing) {
          throw this.toUnexpectedThreadCreationError(error);
        }
      }
    }

    const row = await this.analysisPrisma.analysisThread.update({
      where: { id: existing.id },
      data: {
        updatedById: user.id,
        noteMarkdown: normalizedNote,
      },
      include: this.threadInclude(),
    });
    return this.toThreadResponse(row);
  }

  async createComment(
    orgId: string,
    user: AnalysisActor,
    subjectType: AnalysisSubjectType,
    subjectId: string,
    bodyMarkdown: string,
  ) {
    await this.assertSubjectWritable(orgId, user.id, subjectType, subjectId);
    const body = this.normalizeRequiredText(bodyMarkdown, 5000, "bodyMarkdown");

    let thread = await this.analysisPrisma.analysisThread.findFirst({
      where: { orgId, subjectType, subjectId },
      select: { id: true },
    });
    let createdThread = false;
    if (!thread) {
      try {
        thread = await this.analysisPrisma.analysisThread.create({
          data: {
            orgId,
            createdById: user.id,
            updatedById: user.id,
            subjectType,
            subjectId,
            noteMarkdown: null,
          },
          select: { id: true },
        });
        createdThread = true;
      } catch (error) {
        if (!this.isUniqueConstraintViolation(error)) {
          throw error;
        }
        thread = await this.analysisPrisma.analysisThread.findFirst({
          where: { orgId, subjectType, subjectId },
          select: { id: true },
        });
        if (!thread) {
          throw this.toUnexpectedThreadCreationError(error);
        }
      }
    }

    if (!createdThread) {
      await this.analysisPrisma.analysisThread.update({
        where: { id: thread.id },
        data: { updatedById: user.id },
      });
    }

    const comment = await this.analysisPrisma.analysisComment.create({
      data: {
        orgId,
        threadId: thread.id,
        createdById: user.id,
        bodyMarkdown: body,
      },
      include: {
        createdBy: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
          },
        },
      },
    });

    return this.toCommentResponse(comment);
  }

  async updateComment(
    orgId: string,
    user: AnalysisActor,
    commentId: string,
    bodyMarkdown: string,
  ) {
    const existing = await this.analysisPrisma.analysisComment.findFirst({
      where: { id: commentId, orgId },
      include: {
        thread: {
          select: {
            id: true,
            subjectType: true,
            subjectId: true,
          },
        },
      },
    });
    if (!existing) {
      throw new NotFoundException("Analysis comment not found");
    }
    this.assertCanManageComment(user, existing.createdById);
    await this.assertSubjectReadable(
      orgId,
      user.id,
      existing.thread.subjectType,
      existing.thread.subjectId,
    );

    const row = await this.analysisPrisma.analysisComment.update({
      where: { id: existing.id },
      data: {
        bodyMarkdown: this.normalizeRequiredText(
          bodyMarkdown,
          5000,
          "bodyMarkdown",
        ),
      },
      include: {
        createdBy: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
          },
        },
      },
    });
    return this.toCommentResponse(row);
  }

  async deleteComment(orgId: string, user: AnalysisActor, commentId: string) {
    const existing = await this.analysisPrisma.analysisComment.findFirst({
      where: { id: commentId, orgId },
      select: { id: true, createdById: true },
    });
    if (!existing) {
      throw new NotFoundException("Analysis comment not found");
    }
    this.assertCanManageComment(user, existing.createdById);
    await this.analysisPrisma.analysisComment.delete({
      where: { id: existing.id },
    });
    return { ok: true };
  }

  async exportSearchCsvStream(
    user: AuthenticatedUser,
    queryString?: string,
  ): Promise<{ stream: Readable; rowCount: number }> {
    const params = new URLSearchParams(this.normalizeQueryString(queryString));
    const mode = (params.get("mode") ?? "items").trim().toLowerCase();
    if (mode === "headlines") {
      const rows = await this.buildArchiveSearchRows(user.orgId, params);
      return this.buildCsvStream(
        [
          "processedArticleId",
          "title",
          "summary",
          "countryLabel",
          "region",
          "vertical",
          "weight",
          "publishedAt",
          "sourceLabel",
          "eventId",
          "matchOrigin",
          "relevanceScore",
          "sourceUrl",
        ],
        rows,
      );
    }

    const rows = await this.buildItemsExportRows(user, params);
    return this.buildCsvStream(
      [
        "id",
        "title",
        "source",
        "domain",
        "publishedAt",
        "language",
        "region",
        "sentiment",
        "contentType",
        "eventId",
        "eventTitle",
        "url",
      ],
      rows,
    );
  }

  async exportItemsCsvStream(
    user: AuthenticatedUser,
    queryString?: string,
  ): Promise<{ stream: Readable; rowCount: number }> {
    const rows = await this.buildItemsExportRows(
      user,
      new URLSearchParams(this.normalizeQueryString(queryString)),
    );
    return this.buildCsvStream(
      [
        "id",
        "title",
        "source",
        "domain",
        "publishedAt",
        "language",
        "region",
        "sentiment",
        "contentType",
        "eventId",
        "eventTitle",
        "url",
      ],
      rows,
    );
  }

  async exportEventsCsvStream(
    user: AuthenticatedUser,
    queryString?: string,
  ): Promise<{ stream: Readable; rowCount: number }> {
    const params = new URLSearchParams(this.normalizeQueryString(queryString));
    const rows = await this.buildEventsExportRows(user.orgId, params);
    return this.buildCsvStream(
      [
        "id",
        "title",
        "status",
        "primaryTopic",
        "primaryEntity",
        "startAt",
        "lastAt",
        "heatScore",
        "credibilityScore",
        "itemCount",
        "authoritativeSourceCount",
        "uniqueSourceCount",
      ],
      rows,
    );
  }

  private threadInclude(): typeof THREAD_INCLUDE {
    return THREAD_INCLUDE;
  }

  private toSavedViewResponse(row: SavedViewRecord) {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      surface: row.surface,
      routePath: row.routePath,
      queryState: this.readQueryState(row.queryState),
      visibility: row.visibility,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      createdBy: this.toUserSummary(row.createdBy),
      updatedBy: this.toUserSummary(row.updatedBy),
      canEdit: false,
    };
  }

  private withSavedViewPermissions(
    row: ReturnType<AnalysisWorkspaceService["toSavedViewResponse"]>,
    user: AnalysisActor,
    createdById: string,
  ) {
    return {
      ...row,
      canEdit: this.canManageOwnedResource(user, createdById),
    };
  }

  private toThreadResponse(row: ThreadRecord) {
    return {
      id: row.id,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      noteMarkdown: row.noteMarkdown,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      createdBy: this.toUserSummary(row.createdBy),
      updatedBy: this.toUserSummary(row.updatedBy),
      comments: row.comments.map((comment: ThreadRecord["comments"][number]) =>
        this.toCommentResponse(comment),
      ),
    };
  }

  private toCommentResponse(comment: CommentRecord) {
    return {
      id: comment.id,
      createdById: comment.createdById,
      bodyMarkdown: comment.bodyMarkdown,
      createdAt: comment.createdAt.toISOString(),
      updatedAt: comment.updatedAt.toISOString(),
      createdBy: this.toUserSummary(comment.createdBy),
    };
  }

  private toUserSummary(user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    avatarUrl: string | null;
  }) {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarUrl: user.avatarUrl,
    };
  }

  private canReadSavedView(
    row: { createdById: string; visibility: SavedAnalysisVisibility },
    userId: string,
  ) {
    return (
      row.createdById === userId ||
      row.visibility === SavedAnalysisVisibility.org_shared
    );
  }

  private canManageOwnedResource(user: AnalysisActor, ownerId: string) {
    return user.id === ownerId || user.permissions.includes("users.write");
  }

  private isUniqueConstraintViolation(error: unknown) {
    return error instanceof Error && "code" in error && error.code === "P2002";
  }

  private toUnexpectedThreadCreationError(error: unknown) {
    return error instanceof Error
      ? error
      : new Error("Analysis thread creation failed unexpectedly");
  }

  private assertCanManageOwnedResource(user: AnalysisActor, ownerId: string) {
    if (!this.canManageOwnedResource(user, ownerId)) {
      throw new ForbiddenException(
        "You do not have permission to edit this resource",
      );
    }
  }

  private assertCanManageComment(user: AnalysisActor, ownerId: string) {
    if (user.id === ownerId || user.permissions.includes("users.write")) {
      return;
    }
    throw new ForbiddenException(
      "You do not have permission to edit this comment",
    );
  }

  private async assertSubjectReadable(
    orgId: string,
    userId: string,
    subjectType: AnalysisSubjectType,
    subjectId: string,
  ) {
    if (subjectType === AnalysisSubjectType.saved_view) {
      const view = await this.analysisPrisma.savedAnalysisView.findFirst({
        where: { orgId, id: subjectId },
        select: { id: true, createdById: true, visibility: true },
      });
      if (!view || !this.canReadSavedView(view, userId)) {
        throw new NotFoundException("Analysis subject not found");
      }
      return;
    }

    if (subjectType === AnalysisSubjectType.item) {
      const item = await this.prisma.itemMeta.findFirst({
        where: { orgId, id: subjectId },
        select: { id: true },
      });
      if (!item) {
        throw new NotFoundException("Analysis subject not found");
      }
      return;
    }

    const event = await this.prisma.newsEvent.findFirst({
      where: { orgId, id: subjectId },
      select: { id: true },
    });
    if (!event) {
      throw new NotFoundException("Analysis subject not found");
    }
  }

  private async assertSubjectWritable(
    orgId: string,
    userId: string,
    subjectType: AnalysisSubjectType,
    subjectId: string,
  ) {
    await this.assertSubjectReadable(orgId, userId, subjectType, subjectId);
  }

  private normalizeRequiredText(
    value: string,
    maxLength: number,
    field: string,
  ): string {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new BadRequestException(`${field} is required`);
    }
    if (trimmed.length > maxLength) {
      throw new BadRequestException(`${field} is too long`);
    }
    return trimmed;
  }

  private normalizeOptionalText(
    value: string | null | undefined,
    maxLength: number,
    field: string,
  ): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (trimmed.length > maxLength) {
      throw new BadRequestException(`${field} is too long`);
    }
    return trimmed;
  }

  private normalizeRoutePath(routePath: string) {
    const trimmed = routePath.trim();
    if (!trimmed.startsWith("/")) {
      throw new BadRequestException("routePath must start with /");
    }
    if (!["/search", "/items", "/events"].includes(trimmed)) {
      throw new BadRequestException("routePath is not supported");
    }
    return trimmed;
  }

  private buildQueryState(queryString?: string): QueryStatePayload {
    return {
      queryString: this.normalizeQueryString(queryString),
    };
  }

  private readQueryState(value: unknown): QueryStatePayload {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { queryString: "" };
    }
    const raw = (value as { queryString?: unknown }).queryString;
    return {
      queryString:
        typeof raw === "string" ? this.normalizeQueryString(raw) : "",
    };
  }

  private normalizeQueryString(queryString?: string | null): string {
    if (typeof queryString !== "string") {
      return "";
    }
    const trimmed = queryString.trim().replace(/^\?+/, "");
    if (!trimmed) {
      return "";
    }
    const params = new URLSearchParams(trimmed);
    params.delete("savedView");
    params.delete("page");
    params.delete("pageSize");
    return params.toString();
  }

  private async buildItemsExportRows(
    user: AuthenticatedUser,
    params: URLSearchParams,
  ): Promise<string[][]> {
    const search = this.normalizeOptionalParam(params.get("q"));
    const orderBy = this.parseItemsOrderBy(params);
    const rankingMode = this.parseItemsRankingMode(params, search);
    const filters = this.parseItemsFilters(params);

    const result: Awaited<ReturnType<ItemsService["list"]>> =
      await this.itemsService.list(
        user.orgId,
        1,
        MAX_EXPORT_ROWS,
        search ?? undefined,
        filters,
        orderBy,
        rankingMode,
        user.id,
      );

    const itemIds = result.items.map((item: ItemMetaRow) => item.id);
    const readModels = (await ItemReadModelModel.find({
      orgId: user.orgId,
      itemMetaId: { $in: itemIds },
    }).lean()) as ItemReadModel[];
    const readModelById = new Map<string, ItemReadModel>();
    for (const doc of readModels) {
      if (!doc.itemMetaId || readModelById.has(doc.itemMetaId)) {
        continue;
      }
      readModelById.set(doc.itemMetaId, doc);
    }

    const processedIds = readModels
      .map((doc) => doc.processed?.id)
      .filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      );
    const eventRows = processedIds.length
      ? await this.prisma.newsEventItem.findMany({
          where: {
            orgId: user.orgId,
            processedItemId: { in: processedIds },
          },
          orderBy: [{ createdAt: "desc" }],
          include: {
            event: {
              select: {
                id: true,
                title: true,
              },
            },
          },
        })
      : [];
    const eventByProcessedId = new Map<
      string,
      { id: string; title: string | null }
    >();
    for (const row of eventRows) {
      const processedItemId =
        typeof row.processedItemId === "string" ? row.processedItemId : null;
      if (!processedItemId || eventByProcessedId.has(processedItemId)) {
        continue;
      }
      eventByProcessedId.set(processedItemId, {
        id: row.event.id,
        title: row.event.title,
      });
    }

    return result.items.map((item: ItemMetaRow) => {
      const readModel = readModelById.get(item.id);
      const linkedEvent = readModel?.processed?.id
        ? eventByProcessedId.get(readModel.processed.id)
        : undefined;
      return [
        item.id,
        readModel?.title ?? item.name,
        readModel?.sourceName ?? "",
        readModel?.domain ?? "",
        this.toIsoString(readModel?.publishedAt ?? item.publishedAt ?? null),
        readModel?.language ?? "",
        readModel?.region ?? "",
        readModel?.sentiment ?? "",
        readModel?.contentType ?? "",
        linkedEvent?.id ?? "",
        linkedEvent?.title ?? "",
        readModel?.url ?? "",
      ];
    });
  }

  private async buildArchiveSearchRows(
    orgId: string,
    params: URLSearchParams,
  ): Promise<string[][]> {
    const collected: ArchiveDigestItem[] = [];
    const seen = new Set<string>();
    let cursors: ArchiveVerticalCursorInput[] | undefined;

    while (collected.length < MAX_EXPORT_ROWS) {
      const digest = await this.archiveService.getDigest(orgId, {
        anchorDate: this.parseArchiveDate(params.get("archiveDate")),
        region: this.parseArchiveRegion(params.get("archiveRegion")),
        ...(this.parseArchiveSearch(params)
          ? { search: this.parseArchiveSearch(params) ?? undefined }
          : {}),
        weights: this.parseArchiveWeights(params.get("archiveWeights")),
        pageSize: 100,
        cursors,
      });

      for (const group of digest.groups) {
        for (const item of group.items) {
          if (seen.has(item.processedArticleId)) {
            continue;
          }
          seen.add(item.processedArticleId);
          collected.push(item);
          if (collected.length >= MAX_EXPORT_ROWS) {
            break;
          }
        }
        if (collected.length >= MAX_EXPORT_ROWS) {
          break;
        }
      }

      const nextCursors = digest.groups
        .filter((group) => group.pageInfo.hasMore && group.pageInfo.nextCursor)
        .map((group) => ({
          vertical: group.vertical,
          cursor: group.pageInfo.nextCursor ?? undefined,
        }));
      if (nextCursors.length === 0) {
        break;
      }
      cursors = nextCursors;
    }

    return collected.map((item) => [
      item.processedArticleId,
      item.title ?? "",
      item.summary ?? "",
      item.countryLabel ?? "",
      item.region,
      item.vertical,
      String(item.weight),
      this.toIsoString(item.publishedAt),
      item.sourceLabel ?? "",
      item.eventId ?? "",
      item.matchOrigin ?? "",
      typeof item.relevanceScore === "number"
        ? String(item.relevanceScore)
        : "",
      item.sourceUrl ?? "",
    ]);
  }

  private async buildEventsExportRows(
    orgId: string,
    params: URLSearchParams,
  ): Promise<string[][]> {
    const windowDays = this.parsePositiveInt(params.get("window"), 30, 365);
    const status = this.parseEventsStatus(params.get("status"));
    const entity = this.normalizeOptionalParam(params.get("entity"));
    const sortBy = this.parseEventsSortBy(params.get("sort"));
    const requestedSourceType = this.parseEventsSourceType(
      params.get("sourceType"),
    );
    const minHeatScore = this.parseNonNegativeFloat(params.get("minHeat"));
    const minCredibilityScore = this.parseNonNegativeFloat(
      params.get("minCredibility"),
    );
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const rows = await this.prisma.newsEvent.findMany({
      where: {
        orgId,
        ...(status ? { status } : {}),
        ...(entity ? { primaryEntity: { contains: entity } } : {}),
        lastAt: { gte: since },
      },
      orderBy: [{ lastAt: "desc" }, { startAt: "desc" }],
      take: MAX_EXPORT_ROWS,
      include: {
        _count: {
          select: {
            items: true,
          },
        },
      },
    });

    const eventIds = rows.map((row: EnrichedEventRow["row"]) => row.id);
    const [heatMap, authorityMap] = await Promise.all([
      this.newsEvents.getEventHeatMap(orgId, eventIds),
      this.newsEvents.getEventAuthorityMap(orgId, eventIds, { windowDays }),
    ]);

    let sourceType = requestedSourceType;
    let authoritativeSourcesThreshold: number | null = null;
    try {
      const settings = await this.newsEventSettings.getSettings(orgId);
      if (settings.forceAuthoritativeMode) {
        sourceType = "authoritative";
        authoritativeSourcesThreshold = Math.max(
          1,
          Math.min(10, settings.forceMinAuthoritativeSources),
        );
      }
    } catch {
      // Ignore settings read failures for export.
    }

    let enriched: EnrichedEventRow[] = rows.map(
      (row: EnrichedEventRow["row"]) => ({
        row,
        heat: heatMap.get(row.id) ?? { breaking: false, heatScore: 0 },
        authority: authorityMap.get(row.id) ?? {
          sourceType: "unknown",
          credibilityScore: 0,
          uniqueSourceCount: 0,
          authoritativeSourceCount: 0,
          blogSourceCount: 0,
          corroborated: false,
        },
      }),
    );

    if (sourceType !== "all") {
      enriched = enriched.filter(
        (entry) => entry.authority.sourceType === sourceType,
      );
    }
    if (minHeatScore !== null) {
      enriched = enriched.filter(
        (entry) => entry.heat.heatScore >= minHeatScore,
      );
    }
    if (minCredibilityScore !== null) {
      enriched = enriched.filter(
        (entry) => entry.authority.credibilityScore >= minCredibilityScore,
      );
    }
    if (authoritativeSourcesThreshold !== null) {
      enriched = enriched.filter(
        (entry) =>
          entry.authority.authoritativeSourceCount >=
          authoritativeSourcesThreshold,
      );
    }

    enriched = this.sortEnrichedEvents(enriched, sortBy);
    enriched = this.dedupeEnrichedEvents(enriched).slice(0, MAX_EXPORT_ROWS);

    return enriched.map((entry) => [
      entry.row.id,
      this.resolveEventTitle(entry.row),
      entry.row.status,
      entry.row.primaryTopic ?? "",
      entry.row.primaryEntity ?? "",
      this.toIsoString(entry.row.startAt),
      this.toIsoString(entry.row.lastAt),
      String(entry.heat.heatScore ?? 0),
      String(entry.authority.credibilityScore ?? 0),
      String(entry.row._count?.items ?? 0),
      String(entry.authority.authoritativeSourceCount ?? 0),
      String(entry.authority.uniqueSourceCount ?? 0),
    ]);
  }

  private parseItemsFilters(params: URLSearchParams) {
    const regions = this.getAllTrimmed(params, "region");
    const topics = this.getAllTrimmed(params, "topic");
    const sentiments = this.getAllTrimmed(params, "sentiment");
    const contentTypes = this.getAllTrimmed(params, "contentType");
    const from = this.parseDate(params.get("from"));
    const to = this.parseDate(params.get("to"));
    const dedup = (params.get("dedup") ?? "").trim().toLowerCase();

    return {
      ...(regions.length > 0 ? { regions } : {}),
      ...(topics.length > 0 ? { topics } : {}),
      ...(sentiments.length > 0 ? { sentiments } : {}),
      ...(contentTypes.length > 0 ? { contentTypes } : {}),
      ...(dedup === "hide" || dedup === "1" || dedup === "true"
        ? { excludeDuplicates: true }
        : {}),
      ...(from || to
        ? {
            dateRange: {
              ...(from ? { start: from } : {}),
              ...(to ? { end: to } : {}),
            },
          }
        : {}),
    };
  }

  private parseItemsOrderBy(params: URLSearchParams): ItemsOrderBy {
    const order = (params.get("order") ?? "").trim().toLowerCase();
    if (order === "published") {
      return "PUBLISHED_DESC";
    }
    if (order === "personalized") {
      return "PERSONALIZED";
    }
    return "CREATED_DESC";
  }

  private parseItemsRankingMode(
    params: URLSearchParams,
    search: string | null,
  ): ItemsRankingMode {
    const ranking = (params.get("ranking") ?? "").trim().toLowerCase();
    if (!search) {
      return "RECENCY";
    }
    return ranking === "recency" ? "RECENCY" : "RELEVANCE";
  }

  private parseArchiveDate(raw: string | null): Date {
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (!trimmed) {
      return new Date();
    }
    const parsed = new Date(`${trimmed}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) ? parsed : new Date();
  }

  private parseArchiveRegion(raw: string | null): ArchiveRegion {
    const trimmed = typeof raw === "string" ? raw.trim().toUpperCase() : "";
    switch (trimmed) {
      case "MIDDLE_EAST":
        return ArchiveRegion.MIDDLE_EAST;
      case "AMERICAS":
        return ArchiveRegion.AMERICAS;
      case "EUROPE":
        return ArchiveRegion.EUROPE;
      case "AFRICA":
        return ArchiveRegion.AFRICA;
      case "OTHER":
        return ArchiveRegion.OTHER;
      case "APAC":
      default:
        return ArchiveRegion.APAC;
    }
  }

  private parseArchiveWeights(raw: string | null): ArchiveWeight[] {
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (!trimmed) {
      return [
        ArchiveWeight.FIVE,
        ArchiveWeight.FOUR,
        ArchiveWeight.THREE,
        ArchiveWeight.TWO,
        ArchiveWeight.ONE,
      ];
    }
    const mapped = trimmed
      .split(",")
      .map((value) => Number.parseInt(value.trim(), 10))
      .flatMap((value) => {
        switch (value) {
          case 5:
            return [ArchiveWeight.FIVE];
          case 4:
            return [ArchiveWeight.FOUR];
          case 3:
            return [ArchiveWeight.THREE];
          case 2:
            return [ArchiveWeight.TWO];
          case 1:
            return [ArchiveWeight.ONE];
          default:
            return [];
        }
      });
    return mapped.length > 0
      ? mapped
      : [
          ArchiveWeight.FIVE,
          ArchiveWeight.FOUR,
          ArchiveWeight.THREE,
          ArchiveWeight.TWO,
          ArchiveWeight.ONE,
        ];
  }

  private parseArchiveSearch(params: URLSearchParams): string | null {
    const query = this.normalizeOptionalParam(params.get("q"));
    if (!query || query.length < 2) {
      return null;
    }
    return query;
  }

  private parseEventsStatus(raw: string | null): NewsEventStatus | undefined {
    const trimmed = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (trimmed === "active") {
      return NewsEventStatus.active;
    }
    if (trimmed === "archived") {
      return NewsEventStatus.archived;
    }
    return undefined;
  }

  private parseEventsSourceType(
    raw: string | null,
  ): NewsEventSourceClassification | "all" {
    const trimmed = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (
      trimmed === "authoritative" ||
      trimmed === "mixed" ||
      trimmed === "blog" ||
      trimmed === "unknown"
    ) {
      return trimmed;
    }
    return "all";
  }

  private parseEventsSortBy(
    raw: string | null,
  ): "latest" | "heat" | "credibility" {
    const trimmed = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (trimmed === "heat" || trimmed === "credibility") {
      return trimmed;
    }
    return "latest";
  }

  private sortEnrichedEvents(
    rows: EnrichedEventRow[],
    sortBy: "latest" | "heat" | "credibility",
  ) {
    const sorted = rows.slice();
    sorted.sort((left, right) => {
      const heatDelta = right.heat.heatScore - left.heat.heatScore;
      const credibilityDelta =
        right.authority.credibilityScore - left.authority.credibilityScore;
      const lastAtDelta =
        this.safeTimeMs(right.row.lastAt) - this.safeTimeMs(left.row.lastAt);
      if (sortBy === "heat") {
        return heatDelta || credibilityDelta || lastAtDelta;
      }
      if (sortBy === "credibility") {
        return credibilityDelta || heatDelta || lastAtDelta;
      }
      return lastAtDelta || heatDelta || credibilityDelta;
    });
    return sorted;
  }

  private dedupeEnrichedEvents(rows: EnrichedEventRow[]) {
    const kept: Array<{
      entry: EnrichedEventRow;
      tokens: Set<string>;
      startMs: number;
      lastMs: number;
    }> = [];
    for (const entry of rows) {
      const tokens = this.buildEventTokenSet(entry.row);
      const startMs = this.safeTimeMs(entry.row.startAt);
      const lastMs = this.safeTimeMs(entry.row.lastAt);
      let duplicate = false;

      for (const existing of kept) {
        const closeByTime =
          (Number.isFinite(startMs) &&
            Number.isFinite(existing.startMs) &&
            Math.abs(startMs - existing.startMs) <= EVENT_DEDUPE_WINDOW_MS) ||
          (Number.isFinite(lastMs) &&
            Number.isFinite(existing.lastMs) &&
            Math.abs(lastMs - existing.lastMs) <= EVENT_DEDUPE_WINDOW_MS);
        if (!closeByTime) {
          continue;
        }
        if (this.jaccard(tokens, existing.tokens) >= 0.74) {
          duplicate = true;
          break;
        }
      }

      if (!duplicate) {
        kept.push({ entry, tokens, startMs, lastMs });
      }
    }

    return kept.map((record) => record.entry);
  }

  private buildEventTokenSet(row: {
    primaryEntity: string | null;
    primaryTopic: string | null;
    title: string | null;
  }) {
    const normalized = [row.primaryEntity, row.primaryTopic, row.title]
      .filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      )
      .join(" ")
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
      .trim();
    if (!normalized) {
      return new Set<string>();
    }
    return new Set(
      normalized
        .split(/\s+/)
        .filter((token) => token.length >= 3 || /[\u4e00-\u9fff]/.test(token))
        .slice(0, 24),
    );
  }

  private jaccard(left: Set<string>, right: Set<string>) {
    if (left.size === 0 || right.size === 0) {
      return 0;
    }
    const [small, large] =
      left.size <= right.size ? [left, right] : [right, left];
    let intersection = 0;
    for (const token of small) {
      if (large.has(token)) {
        intersection += 1;
      }
    }
    const union = left.size + right.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  private safeTimeMs(value: Date | string | null | undefined) {
    if (value instanceof Date) {
      return value.getTime();
    }
    if (typeof value === "string") {
      const parsed = new Date(value).getTime();
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  private resolveEventTitle(row: {
    id: string;
    title: string | null;
    summary: string | null;
    primaryTopic: string | null;
    primaryEntity: string | null;
  }) {
    const title = this.normalizeOptionalParam(row.title);
    if (title) {
      return title;
    }
    const summary = this.normalizeOptionalParam(row.summary);
    if (summary) {
      return summary;
    }
    const topic = this.normalizeOptionalParam(row.primaryTopic);
    if (topic) {
      return topic;
    }
    const entity = this.normalizeOptionalParam(row.primaryEntity);
    if (entity) {
      return entity;
    }
    return row.id;
  }

  private getAllTrimmed(params: URLSearchParams, key: string) {
    return params
      .getAll(key)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }

  private parseDate(raw: string | null) {
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (!trimmed) {
      return undefined;
    }
    const parsed = new Date(trimmed);
    return Number.isFinite(parsed.getTime()) ? parsed : undefined;
  }

  private parsePositiveInt(raw: string | null, fallback: number, max: number) {
    const parsed = Number.parseInt(typeof raw === "string" ? raw : "", 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return fallback;
    }
    return Math.min(parsed, max);
  }

  private parseNonNegativeFloat(raw: string | null) {
    const parsed = Number.parseFloat(typeof raw === "string" ? raw : "");
    if (!Number.isFinite(parsed) || parsed < 0) {
      return null;
    }
    return parsed;
  }

  private normalizeOptionalParam(raw: string | null | undefined) {
    if (typeof raw !== "string") {
      return null;
    }
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private toIsoString(value: Date | null | undefined) {
    if (!(value instanceof Date)) {
      return "";
    }
    return Number.isFinite(value.getTime()) ? value.toISOString() : "";
  }

  private buildCsvStream(header: string[], rows: string[][]) {
    const csv = [header, ...rows]
      .map((row) => row.map((value) => this.escapeCsvValue(value)).join(","))
      .join("\n");
    return {
      stream: Readable.from([csv]),
      rowCount: rows.length,
    };
  }

  private escapeCsvValue(value: unknown): string {
    const text = value === null || value === undefined ? "" : String(value);
    if (typeof value === "string") {
      const trimmedStart = text.replace(/^\s+/, "");
      if (
        /^[=+\-@]/.test(trimmedStart) &&
        !/^-?\d+(\.\d+)?$/.test(trimmedStart)
      ) {
        return this.escapeCsvValue(`'${text}`);
      }
    }
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }
}
