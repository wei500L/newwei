import {
  ItemReadModelModel,
  ProcessedItemModel,
  RawItemModel,
  type ItemReadModel,
  type MongoConnection,
} from "@modular/mongo";
import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PipelineStageStatus } from "../../common/pipeline-status";
import { MONGO_CONNECTION } from "../config/mongo.provider";
import { PrismaService } from "../config/prisma.service";
import { UserNewsBehaviorService } from "../user-news-behavior/user-news-behavior.service";

import { ItemsReadModelService } from "./items-read-model.service";
import {
  buildBaseWhere,
  buildReadModelBaseMatch,
  buildReadModelMatchFromItemMetaWhere,
  parseSearchPayload,
  resolveRankingMode,
} from "./items-search.helpers";
import { ItemsSearchService } from "./items-search.service";
import {
  ITEM_READ_MODEL_META_ROW_PROJECTION,
  MAX_CURSOR_PAGE_SIZE,
  PERSONALIZED_CANDIDATE_MAX,
  PERSONALIZED_CANDIDATE_MIN,
  PERSONALIZED_CANDIDATE_MULTIPLIER,
  type ItemCandidateFeatures,
  type ItemFilters,
  type ItemListRow,
  type ItemPersonalizationProfile,
  type ItemsCursorPayload,
  type ItemsOrderBy,
  type ItemsRankingMode,
  type PersonalizedCandidateCursor,
  type PersonalizedCandidateRow,
  type RankedItem,
} from "./items.shared";

@Injectable()
export class ItemsListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly userNewsBehavior: UserNewsBehaviorService,
    private readonly readModel: ItemsReadModelService,
    private readonly search: ItemsSearchService,
    @Inject(MONGO_CONNECTION) private readonly _mongo: MongoConnection,
  ) {
    void this._mongo;
  }

  async list(
    orgId: string,
    page = 1,
    pageSize = 10,
    search?: string,
    filters?: ItemFilters,
    orderBy: ItemsOrderBy = "CREATED_DESC",
    rankingMode: ItemsRankingMode = "RECENCY",
    userId?: string,
    options?: { maxPageSize?: number },
  ) {
    const normalizedPageSize = Number.isFinite(pageSize) ? Math.floor(pageSize) : 10;
    // Batch consumers (CSV export) need a larger page; the interactive
    // controller path keeps the cursor-page cap of 50.
    const cap = Math.max(
      1,
      Math.min(
        Math.trunc(options?.maxPageSize ?? MAX_CURSOR_PAGE_SIZE),
        50_000,
      ),
    );
    const take = Math.min(Math.max(normalizedPageSize, 1), cap);
    const normalizedPage = Number.isFinite(page) ? Math.floor(page) : 1;
    const safePage = Math.max(normalizedPage, 1);
    const skip = (safePage - 1) * take;
    const { search: normalizedSearch, filters: legacyFilters } = parseSearchPayload(search);
    const effectiveFilters = filters ?? legacyFilters;
    const scopedIds = await this.search.resolveScopedIds(orgId, normalizedSearch, effectiveFilters);
    const effectiveRankingMode = resolveRankingMode(rankingMode, normalizedSearch);
    if (scopedIds && scopedIds.length === 0) {
      return {
        items: [],
        total: 0,
        page: safePage,
        pageSize: take
      };
    }

    const baseWhere = buildBaseWhere(orgId);
    const where = scopedIds ? { ...baseWhere, id: { in: scopedIds } } : baseWhere;

    if (effectiveRankingMode === "RELEVANCE" && normalizedSearch && scopedIds) {
      return this.search.listByRelevanceWithPage({
        orgId,
        search: normalizedSearch,
        scopedIds,
        page: safePage,
        pageSize: take
      });
    }

    if (orderBy === "PERSONALIZED" && userId) {
      return this.listPersonalizedWithPage({
        orgId,
        userId,
        where,
        page: safePage,
        pageSize: take,
      });
    }

    const effectiveOrderBy = orderBy === "PERSONALIZED" ? "CREATED_DESC" : orderBy;

    if (this.readModel.isReadModelEnabled()) {
      const match = scopedIds
        ? {
            $and: [buildReadModelBaseMatch(orgId), { itemMetaId: { $in: scopedIds } }],
          }
        : buildReadModelBaseMatch(orgId);
      const sort: Record<string, 1 | -1> =
        effectiveOrderBy === "PUBLISHED_DESC"
          ? { sortAt: -1, itemMetaId: -1 }
          : { createdAt: -1, itemMetaId: -1 };
      const [docs, total] = await Promise.all([
        ItemReadModelModel.find(match, ITEM_READ_MODEL_META_ROW_PROJECTION)
          .sort(sort)
          .skip(skip)
          .limit(take)
          .lean(),
        ItemReadModelModel.countDocuments(match),
      ]);

      return {
        items: (docs as ItemReadModel[]).map((doc) => this.readModel.itemMetaRowFromReadModel(doc)),
        total,
        page: safePage,
        pageSize: take,
      };
    }

    const orderField = effectiveOrderBy === "PUBLISHED_DESC" ? "sortAt" : "createdAt";
    const orderByClause: Prisma.ItemMetaOrderByWithRelationInput[] =
      orderField === "sortAt"
        ? [{ sortAt: "desc" }, { id: "desc" }]
        : [{ createdAt: "desc" }, { id: "desc" }];

    const [items, total] = await Promise.all([
      this.prisma.itemMeta.findMany({
        where,
        skip,
        take,
        orderBy: orderByClause
      }),
      this.prisma.itemMeta.count({ where })
    ]);

    return {
      items,
      total,
      page: safePage,
      pageSize: take
    };
  }

  async listWithCursor(
    orgId: string,
    first = 10,
    cursor?: ItemsCursorPayload,
    search?: string,
    filters?: ItemFilters,
    orderBy: ItemsOrderBy = "CREATED_DESC",
    rankingMode: ItemsRankingMode = "RECENCY",
    userId?: string,
    includeTotalCount = true,
  ) {
    const take = Math.min(Math.max(first, 1), MAX_CURSOR_PAGE_SIZE);
    const { search: normalizedSearch, filters: legacyFilters } = parseSearchPayload(search);
    const effectiveFilters = filters ?? legacyFilters;
    const scopedIds = await this.search.resolveScopedIds(orgId, normalizedSearch, effectiveFilters);
    const effectiveRankingMode = resolveRankingMode(rankingMode, normalizedSearch);
    if (scopedIds && scopedIds.length === 0) {
      return {
        items: [],
        hasNextPage: false,
        totalCount: 0
      };
    }

    if (effectiveRankingMode === "RELEVANCE" && normalizedSearch && scopedIds) {
      return this.search.listByRelevanceWithCursor({
        orgId,
        search: normalizedSearch,
        scopedIds,
        first: take,
        cursor
      });
    }

    const baseWhere = buildBaseWhere(orgId);
    const whereBase = scopedIds ? { ...baseWhere, id: { in: scopedIds } } : baseWhere;

    if (orderBy === "PERSONALIZED" && userId) {
      return this.listPersonalizedWithCursor({
        orgId,
        userId,
        where: whereBase,
        first: take,
        cursor,
      });
    }

    const effectiveOrderBy = orderBy === "PERSONALIZED" ? "CREATED_DESC" : orderBy;

    if (this.readModel.isReadModelEnabled()) {
      const cursorId = cursor?.id;
      if (scopedIds) {
        const scopedSet = new Set(scopedIds);
        if (cursorId && !scopedSet.has(cursorId)) {
          return {
            items: [],
            hasNextPage: false,
            totalCount: includeTotalCount ? scopedIds.length : 0,
          };
        }
      }

      const orderField = effectiveOrderBy === "PUBLISHED_DESC" ? "sortAt" : "createdAt";
      let cursorTimestamp: Date | null = null;
      if (cursorId) {
        const timestampString = orderField === "sortAt" ? cursor?.sortAt : cursor?.createdAt;
        if (timestampString) {
          const parsed = new Date(timestampString);
          if (Number.isFinite(parsed.valueOf())) {
            cursorTimestamp = parsed;
          }
        }

        if (!cursorTimestamp) {
          const cursorRow = (await ItemReadModelModel.findOne(
            { orgId, itemMetaId: cursorId },
            { createdAt: 1, sortAt: 1 },
          ).lean()) as { createdAt?: Date; sortAt?: Date } | null;
          if (!cursorRow) {
            return {
              items: [],
              hasNextPage: false,
              totalCount: includeTotalCount ? scopedIds?.length ?? 0 : 0,
            };
          }
          cursorTimestamp = orderField === "sortAt" ? cursorRow.sortAt ?? null : cursorRow.createdAt ?? null;
        }
      }

      const baseMatch = scopedIds
        ? {
            $and: [buildReadModelBaseMatch(orgId), { itemMetaId: { $in: scopedIds } }],
          }
        : buildReadModelBaseMatch(orgId);
      const paginationMatch =
        cursorTimestamp && cursorId
          ? orderField === "sortAt"
            ? {
                $or: [
                  { sortAt: { $lt: cursorTimestamp } },
                  { sortAt: cursorTimestamp, itemMetaId: { $lt: cursorId } },
                ],
              }
            : {
                $or: [
                  { createdAt: { $lt: cursorTimestamp } },
                  { createdAt: cursorTimestamp, itemMetaId: { $lt: cursorId } },
                ],
              }
          : null;
      const match = paginationMatch ? { $and: [baseMatch, paginationMatch] } : baseMatch;
      const sort: Record<string, 1 | -1> =
        orderField === "sortAt"
          ? { sortAt: -1, itemMetaId: -1 }
          : { createdAt: -1, itemMetaId: -1 };

      const docs = (await ItemReadModelModel.find(match, ITEM_READ_MODEL_META_ROW_PROJECTION)
        .sort(sort)
        .limit(take + 1)
        .lean()) as ItemReadModel[];
      const hasNextPage = docs.length > take;
      const totalCount = includeTotalCount ? await ItemReadModelModel.countDocuments(baseMatch) : 0;

      return {
        items: docs.slice(0, take).map((doc) => this.readModel.itemMetaRowFromReadModel(doc)),
        hasNextPage,
        totalCount,
      };
    }

    const cursorId = cursor?.id;
    if (scopedIds) {
      const scopedSet = new Set(scopedIds);
      if (cursorId && !scopedSet.has(cursorId)) {
        return {
          items: [],
          hasNextPage: false,
          totalCount: scopedIds.length
        };
      }
    }

    const orderField = effectiveOrderBy === "PUBLISHED_DESC" ? "sortAt" : "createdAt";

    let cursorTimestamp: Date | null = null;
    if (cursorId) {
      const timestampString = orderField === "sortAt" ? cursor?.sortAt : cursor?.createdAt;
      if (timestampString) {
        const parsed = new Date(timestampString);
        if (Number.isFinite(parsed.valueOf())) {
          cursorTimestamp = parsed;
        }
      }

      if (!cursorTimestamp) {
        const cursorRow = await this.prisma.itemMeta.findFirst({
          where: { id: cursorId, orgId },
          select: { createdAt: true, sortAt: true }
        });
        if (!cursorRow) {
          return {
            items: [],
            hasNextPage: false,
            totalCount: scopedIds?.length ?? 0
          };
        }
        cursorTimestamp = orderField === "sortAt" ? cursorRow.sortAt : cursorRow.createdAt;
      }
    }

    const paginationWhere =
      cursorTimestamp && cursorId
        ? orderField === "sortAt"
          ? {
              OR: [
                { sortAt: { lt: cursorTimestamp } },
                { sortAt: cursorTimestamp, id: { lt: cursorId } }
              ]
            }
          : {
              OR: [
                { createdAt: { lt: cursorTimestamp } },
                { createdAt: cursorTimestamp, id: { lt: cursorId } }
              ]
            }
        : undefined;

    const where = paginationWhere ? { AND: [whereBase, paginationWhere] } : whereBase;

    const orderByClause: Prisma.ItemMetaOrderByWithRelationInput[] =
      orderField === "sortAt"
        ? [{ sortAt: "desc" }, { id: "desc" }]
        : [{ createdAt: "desc" }, { id: "desc" }];

    const items = await this.prisma.itemMeta.findMany({
      where,
      orderBy: orderByClause,
      take: take + 1
    });

    const hasNextPage = items.length > take;
    const totalCount = await this.prisma.itemMeta.count({ where: whereBase });

    return {
      items: items.slice(0, take),
      hasNextPage,
      totalCount
    };
  }

  private async listPersonalizedWithPage(input: {
    orgId: string;
    userId: string;
    where: Prisma.ItemMetaWhereInput;
    page: number;
    pageSize: number;
  }) {
    const offset = Math.max(0, (input.page - 1) * input.pageSize);
    const { total, ranked } = await this.getPersonalizedRanking({
      orgId: input.orgId,
      userId: input.userId,
      where: input.where,
      requiredCount: offset + input.pageSize,
    });
    if (total <= 0 || ranked.length <= offset) {
      return {
        items: [],
        total,
        page: input.page,
        pageSize: input.pageSize,
      };
    }

    const picked = ranked.slice(offset, offset + input.pageSize);
    const rowById = await this.readModel.fetchItemMetaRowsByIds(
      input.orgId,
      picked.map((entry) => entry.id),
    );

    const items: ItemListRow[] = [];
    for (const entry of picked) {
      const row = rowById.get(entry.id);
      if (!row) {
        continue;
      }
      items.push({
        ...row,
        rankOffset: entry.rankOffset,
      });
    }

    return {
      items,
      total,
      page: input.page,
      pageSize: input.pageSize,
    };
  }

  private async listPersonalizedWithCursor(input: {
    orgId: string;
    userId: string;
    where: Prisma.ItemMetaWhereInput;
    first: number;
    cursor?: ItemsCursorPayload;
  }) {
    let offset =
      typeof input.cursor?.offset === "number" &&
      Number.isFinite(input.cursor.offset) &&
      input.cursor.offset >= 0
        ? Math.floor(input.cursor.offset) + 1
        : 0;
    const { total, ranked } = await this.getPersonalizedRanking({
      orgId: input.orgId,
      userId: input.userId,
      where: input.where,
      requiredCount: offset + input.first + 1,
    });

    if (
      offset <= 0 &&
      input.cursor?.id &&
      typeof input.cursor.id === "string" &&
      input.cursor.id.trim().length > 0
    ) {
      const cursorIndex = ranked.findIndex((entry) => entry.id === input.cursor?.id);
      if (cursorIndex >= 0) {
        offset = cursorIndex + 1;
      }
    }

    if (total <= 0 || ranked.length <= offset) {
      return {
        items: [],
        hasNextPage: false,
        totalCount: total,
      };
    }

    const window = ranked.slice(offset, offset + input.first + 1);
    const hasNextPage = window.length > input.first || offset + input.first < total;
    const picked = hasNextPage ? window.slice(0, input.first) : window;

    const rowById = await this.readModel.fetchItemMetaRowsByIds(
      input.orgId,
      picked.map((entry) => entry.id),
    );

    const items: ItemListRow[] = [];
    for (const entry of picked) {
      const row = rowById.get(entry.id);
      if (!row) {
        continue;
      }
      items.push({
        ...row,
        rankOffset: entry.rankOffset,
      });
    }

    return {
      items,
      hasNextPage,
      totalCount: total,
    };
  }

  private async getPersonalizedRanking(input: {
    orgId: string;
    userId: string;
    where: Prisma.ItemMetaWhereInput;
    requiredCount: number;
  }): Promise<{ total: number; ranked: RankedItem[] }> {
    const rawTotal = this.readModel.isReadModelEnabled()
      ? await ItemReadModelModel.countDocuments(
          buildReadModelMatchFromItemMetaWhere(input.orgId, input.where),
        )
      : await this.prisma.itemMeta.count({ where: input.where });
    if (rawTotal <= 0) {
      return { total: 0, ranked: [] };
    }
    const total = Math.min(rawTotal, PERSONALIZED_CANDIDATE_MAX);
    const targetCount = Math.min(Math.max(input.requiredCount, 1), total);

    const candidateTake = Math.min(
      PERSONALIZED_CANDIDATE_MAX,
      Math.max(
        PERSONALIZED_CANDIDATE_MIN,
        Math.floor(input.requiredCount * PERSONALIZED_CANDIDATE_MULTIPLIER),
      ),
    );
    const profile = await this.loadItemPersonalizationProfile(input.orgId, input.userId);
    const candidates = await this.collectPersonalizedCandidates({
      orgId: input.orgId,
      where: input.where,
      total,
      targetCount,
      initialCandidateTake: candidateTake,
    });
    const ranked = await this.rankPersonalizedCandidates({
      orgId: input.orgId,
      candidates,
      profile,
    });

    return { total, ranked };
  }

  private async collectPersonalizedCandidates(input: {
    orgId: string;
    where: Prisma.ItemMetaWhereInput;
    total: number;
    targetCount: number;
    initialCandidateTake: number;
  }): Promise<PersonalizedCandidateRow[]> {
    if (input.total <= 0 || input.targetCount <= 0) {
      return [];
    }

    const collected: PersonalizedCandidateRow[] = [];
    const seenIds = new Set<string>();
    let cursor: PersonalizedCandidateCursor | null = null;
    let exhausted = false;
    let candidateTake = Math.min(input.initialCandidateTake, input.total);
    let fetchedWindowSize = 0;

    while (!exhausted && collected.length < input.targetCount && fetchedWindowSize < input.total) {
      const targetWindowSize = Math.min(candidateTake, input.total);
      const deltaTake = targetWindowSize - fetchedWindowSize;
      if (deltaTake <= 0) {
        break;
      }

      const batch = await this.fetchPersonalizedCandidateBatch({
        orgId: input.orgId,
        where: input.where,
        take: deltaTake,
        cursor,
      });

      fetchedWindowSize += batch.rawCount;
      if (batch.nextCursor) {
        cursor = batch.nextCursor;
      }
      exhausted = batch.exhausted;

      for (const candidate of batch.candidates) {
        if (seenIds.has(candidate.id)) {
          continue;
        }
        seenIds.add(candidate.id);
        collected.push(candidate);
      }

      if (collected.length >= input.targetCount || exhausted || targetWindowSize >= input.total) {
        break;
      }

      candidateTake = Math.min(PERSONALIZED_CANDIDATE_MAX, targetWindowSize * 2);
    }

    return collected;
  }

  private async fetchPersonalizedCandidateBatch(input: {
    orgId: string;
    where: Prisma.ItemMetaWhereInput;
    take: number;
    cursor: PersonalizedCandidateCursor | null;
  }): Promise<{
    candidates: PersonalizedCandidateRow[];
    nextCursor: PersonalizedCandidateCursor | null;
    rawCount: number;
    exhausted: boolean;
  }> {
    if (input.take <= 0) {
      return {
        candidates: [],
        nextCursor: null,
        rawCount: 0,
        exhausted: true,
      };
    }

    const rawCandidates = this.readModel.isReadModelEnabled()
      ? ((await ItemReadModelModel.find(
          input.cursor
            ? {
                $and: [
                  buildReadModelMatchFromItemMetaWhere(input.orgId, input.where),
                  {
                    $or: [
                      { sortAt: { $lt: input.cursor.sortAt } },
                      { sortAt: input.cursor.sortAt, itemMetaId: { $lt: input.cursor.id } },
                    ],
                  },
                ],
              }
            : buildReadModelMatchFromItemMetaWhere(input.orgId, input.where),
          {
            itemMetaId: 1,
            createdAt: 1,
            sortAt: 1,
          },
        )
          .sort({ sortAt: -1, itemMetaId: -1 })
          .limit(input.take)
          .lean()) as { itemMetaId?: string; createdAt?: Date; sortAt?: Date }[])
      : await this.prisma.itemMeta.findMany({
          where: input.cursor
            ? {
                AND: [
                  input.where,
                  {
                    OR: [
                      { sortAt: { lt: input.cursor.sortAt } },
                      { sortAt: input.cursor.sortAt, id: { lt: input.cursor.id } },
                    ],
                  },
                ],
              }
            : input.where,
          select: {
            id: true,
            createdAt: true,
            sortAt: true,
          },
          orderBy: [{ sortAt: "desc" }, { id: "desc" }],
          take: input.take,
        });

    const normalizedCandidates = rawCandidates
      .map((candidate) => this.normalizePersonalizedCandidate(candidate))
      .filter((candidate): candidate is PersonalizedCandidateRow => Boolean(candidate));
    const nextCursor =
      rawCandidates.length < input.take
        ? null
        : this.resolvePersonalizedCandidateCursor(rawCandidates);

    return {
      candidates: normalizedCandidates,
      nextCursor,
      rawCount: rawCandidates.length,
      exhausted: rawCandidates.length < input.take || !nextCursor,
    };
  }

  private normalizePersonalizedCandidate(candidate: {
    id?: string;
    itemMetaId?: string;
    createdAt?: Date;
    sortAt?: Date;
  }): PersonalizedCandidateRow | null {
    const id =
      typeof candidate.id === "string"
        ? candidate.id.trim()
        : typeof candidate.itemMetaId === "string"
          ? candidate.itemMetaId.trim()
          : "";
    const createdAt = candidate.createdAt instanceof Date ? candidate.createdAt : null;
    if (!id || !createdAt) {
      return null;
    }
    const sortAt = candidate.sortAt instanceof Date ? candidate.sortAt : createdAt;
    return {
      id,
      createdAt,
      sortAt,
    };
  }

  private resolvePersonalizedCandidateCursor(
    candidates: { id?: string; itemMetaId?: string; createdAt?: Date; sortAt?: Date }[],
  ): PersonalizedCandidateCursor | null {
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index];
      if (!candidate) {
        continue;
      }
      const normalized = this.normalizePersonalizedCandidate(candidate);
      if (!normalized) {
        continue;
      }
      return {
        id: normalized.id,
        sortAt: normalized.sortAt,
      };
    }
    return null;
  }

  private async rankPersonalizedCandidates(input: {
    orgId: string;
    candidates: PersonalizedCandidateRow[];
    profile: ItemPersonalizationProfile;
  }): Promise<RankedItem[]> {
    const profileEnabled =
      Object.keys(input.profile.positive.sources).length > 0 ||
      Object.keys(input.profile.positive.topics).length > 0 ||
      Object.keys(input.profile.positive.entities).length > 0 ||
      Object.keys(input.profile.positive.items).length > 0 ||
      Object.keys(input.profile.positive.events).length > 0 ||
      Object.keys(input.profile.positive.domains).length > 0 ||
      Object.keys(input.profile.negative.sources).length > 0 ||
      Object.keys(input.profile.negative.topics).length > 0 ||
      Object.keys(input.profile.negative.entities).length > 0 ||
      Object.keys(input.profile.negative.items).length > 0 ||
      Object.keys(input.profile.negative.events).length > 0 ||
      Object.keys(input.profile.negative.domains).length > 0;
    if (input.candidates.length === 0) {
      return [];
    }

    const candidateIds = input.candidates.map((candidate) => candidate.id);
    const featuresById = await this.loadCandidateFeatures(input.orgId, candidateIds);
    const sortAtById = new Map(
      input.candidates.map((candidate) => [candidate.id, candidate.sortAt.getTime()] as const),
    );
    const nowMs = Date.now();

    const ranked = input.candidates
      .map((candidate) => {
        const feature = featuresById.get(candidate.id);
        const ageHours = Math.max(0, (nowMs - candidate.sortAt.getTime()) / (1000 * 60 * 60));
        const recencyScore = 1 / (1 + ageHours / 36);
        if (!profileEnabled) {
          return {
            id: candidate.id,
            score: recencyScore,
          };
        }

        const positiveSourceScore = this.resolveSourcePreferenceScore(
          feature,
          input.profile.positive.sources,
        );
        const negativeSourceScore = this.resolveSourcePreferenceScore(
          feature,
          input.profile.negative.sources,
        );
        const positiveTopicScore = this.sumPreferenceScore(
          feature?.topics ?? [],
          input.profile.positive.topics,
          6,
        );
        const negativeTopicScore = this.sumPreferenceScore(
          feature?.topics ?? [],
          input.profile.negative.topics,
          6,
        );
        const positiveEntityScore = this.sumPreferenceScore(
          feature?.entities ?? [],
          input.profile.positive.entities,
          6,
        );
        const negativeEntityScore = this.sumPreferenceScore(
          feature?.entities ?? [],
          input.profile.negative.entities,
          6,
        );
        const itemPreferenceId = this.normalizeBehaviorId(candidate.id);
        const positiveItemScore = itemPreferenceId
          ? (input.profile.positive.items[itemPreferenceId] ?? 0)
          : 0;
        const negativeItemScore = itemPreferenceId
          ? (input.profile.negative.items[itemPreferenceId] ?? 0)
          : 0;
        const positiveEventScore = this.sumPreferenceScore(
          feature?.eventIds ?? [],
          input.profile.positive.events,
          4,
        );
        const negativeEventScore = this.sumPreferenceScore(
          feature?.eventIds ?? [],
          input.profile.negative.events,
          4,
        );
        const positiveDomainScore = feature?.domain
          ? (input.profile.positive.domains[feature.domain] ?? 0)
          : 0;
        const negativeDomainScore = feature?.domain
          ? (input.profile.negative.domains[feature.domain] ?? 0)
          : 0;
        const positiveRaw =
          positiveSourceScore * 1.15 +
          positiveTopicScore +
          positiveEntityScore * 0.9 +
          positiveItemScore * 1.45 +
          positiveEventScore * 1.2 +
          positiveDomainScore * 0.75;
        const negativeRaw =
          negativeSourceScore * 1.15 +
          negativeTopicScore +
          negativeEntityScore * 0.9 +
          negativeItemScore * 1.45 +
          negativeEventScore * 1.2 +
          negativeDomainScore * 0.75;
        const behaviorScore =
          Math.log1p(Math.max(0, positiveRaw)) -
          Math.log1p(Math.max(0, negativeRaw * 1.15));
        return {
          id: candidate.id,
          score: behaviorScore * 0.78 + recencyScore * 0.22,
        };
      })
      .sort((a, b) => {
        if (Math.abs(b.score - a.score) > 0.0001) {
          return b.score - a.score;
        }
        const leftSort = sortAtById.get(a.id) ?? 0;
        const rightSort = sortAtById.get(b.id) ?? 0;
        if (rightSort !== leftSort) {
          return rightSort - leftSort;
        }
        return a.id.localeCompare(b.id);
      });

    return ranked.map((entry, index) => ({
      id: entry.id,
      score: entry.score,
      rankOffset: index,
    }));
  }

  private async loadCandidateFeatures(orgId: string, itemMetaIds: string[]) {
    if (itemMetaIds.length === 0) {
      return new Map<string, ItemCandidateFeatures>();
    }

    if (this.readModel.isReadModelEnabled()) {
      const docsById = await this.readModel.loadItemReadModelsByIds(orgId, itemMetaIds);
      const out = new Map<string, ItemCandidateFeatures>();
      const processedItemIdsForEvents = new Set<string>();
      const processedItemIdByMetaId = new Map<string, string>();

      for (const itemMetaId of itemMetaIds) {
        const doc = docsById.get(itemMetaId);
        if (!doc) {
          continue;
        }
        const processedItemId =
          doc.processed?.id && typeof doc.processed.id === "string" ? doc.processed.id.trim() : "";
        if (processedItemId) {
          processedItemIdsForEvents.add(processedItemId);
          processedItemIdByMetaId.set(itemMetaId, processedItemId);
        }
        out.set(itemMetaId, {
          source: this.normalizePreferenceKey(doc.sourceId ?? doc.sourceName ?? null),
          domain: this.normalizePreferenceKey(doc.domain ?? null),
          topics: (doc.topicKeys ?? []).slice(0, 10),
          entities: (doc.entityKeys ?? []).slice(0, 10),
          eventIds: [],
        });
      }

      if (processedItemIdsForEvents.size > 0) {
        const eventRows = await this.prisma.newsEventItem.findMany({
          where: {
            orgId,
            processedItemId: { in: Array.from(processedItemIdsForEvents) },
          },
          select: { processedItemId: true, eventId: true },
          orderBy: { createdAt: "desc" },
        });
        const eventIdsByProcessedItemId = new Map<string, string[]>();
        for (const row of eventRows) {
          const processedItemId = this.normalizeBehaviorId(row.processedItemId);
          const eventId = this.normalizeBehaviorId(row.eventId);
          if (!processedItemId || !eventId) {
            continue;
          }
          const bucket = eventIdsByProcessedItemId.get(processedItemId) ?? [];
          if (!bucket.includes(eventId)) {
            bucket.push(eventId);
          }
          if (bucket.length > 8) {
            bucket.length = 8;
          }
          eventIdsByProcessedItemId.set(processedItemId, bucket);
        }
        for (const [itemMetaId, processedItemId] of processedItemIdByMetaId.entries()) {
          const feature = out.get(itemMetaId);
          if (!feature) {
            continue;
          }
          feature.eventIds = eventIdsByProcessedItemId.get(processedItemId) ?? [];
        }
      }

      return out;
    }

    const [docs, rawDocs] = await Promise.all([
      ProcessedItemModel.aggregate<{
        _id: string;
        itemMetaId?: string;
        sourceId?: string | null;
        source?: string | null;
        result?: unknown;
        processedItemIds?: string[];
      }>([
        {
          $match: {
            orgId,
            status: PipelineStageStatus.Completed,
            itemMetaId: { $in: itemMetaIds },
          },
        },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: "$itemMetaId",
            itemMetaId: { $first: "$itemMetaId" },
            sourceId: { $first: "$sourceId" },
            source: { $first: "$source" },
            result: { $first: "$result" },
            processedItemIds: { $push: { $toString: "$_id" } },
          },
        },
        {
          $project: {
            _id: 1,
            itemMetaId: 1,
            sourceId: 1,
            source: 1,
            result: 1,
            processedItemIds: { $slice: ["$processedItemIds", 12] },
          },
        },
      ]),
      RawItemModel.aggregate<{
        _id: string;
        itemMetaId?: string;
        url?: string | null;
      }>([
        {
          $match: {
            itemMetaId: { $in: itemMetaIds },
          },
        },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: "$itemMetaId",
            itemMetaId: { $first: "$itemMetaId" },
            url: { $first: "$payload.url" },
          },
        },
      ]),
    ]);

    const out = new Map<string, ItemCandidateFeatures>();
    const processedItemIdsByMetaId = new Map<string, string[]>();
    const processedItemIdsForEvents = new Set<string>();

    for (const doc of docs) {
      const itemMetaId =
        typeof doc.itemMetaId === "string" && doc.itemMetaId.trim().length > 0
          ? doc.itemMetaId.trim()
          : typeof doc._id === "string" && doc._id.trim().length > 0
            ? doc._id.trim()
            : "";
      if (!itemMetaId) {
        continue;
      }
      const result =
        doc.result && typeof doc.result === "object" && !Array.isArray(doc.result)
          ? (doc.result as Record<string, unknown>)
          : {};
      const sourceCandidate =
        typeof doc.sourceId === "string" && doc.sourceId.trim().length > 0
          ? doc.sourceId
          : typeof doc.source === "string" && doc.source.trim().length > 0
          ? doc.source
          : typeof result.source === "string"
            ? result.source
            : undefined;
      const processedItemIds = Array.from(
        new Set(
          (Array.isArray(doc.processedItemIds) ? doc.processedItemIds : [])
            .map((value) => this.normalizeBehaviorId(value))
            .filter((value): value is string => Boolean(value)),
        ),
      ).slice(0, 12);
      if (processedItemIds.length > 0) {
        processedItemIdsByMetaId.set(itemMetaId, processedItemIds);
        for (const processedItemId of processedItemIds) {
          processedItemIdsForEvents.add(processedItemId);
        }
      }
      out.set(itemMetaId, {
        source: this.normalizePreferenceKey(sourceCandidate),
        domain: null,
        topics: this.normalizePreferenceTerms(result.topics),
        entities: this.normalizePreferenceTerms(result.entities),
        eventIds: [],
      });
    }

    for (const rawDoc of rawDocs) {
      const itemMetaId =
        typeof rawDoc.itemMetaId === "string" && rawDoc.itemMetaId.trim().length > 0
          ? rawDoc.itemMetaId.trim()
          : typeof rawDoc._id === "string" && rawDoc._id.trim().length > 0
            ? rawDoc._id.trim()
            : "";
      if (!itemMetaId) {
        continue;
      }
      const domain = this.normalizePreferenceDomain(rawDoc.url ?? undefined);
      if (!domain) {
        continue;
      }
      const existing = out.get(itemMetaId);
      if (existing) {
        if (!existing.domain) {
          existing.domain = domain;
        }
        continue;
      }
      out.set(itemMetaId, {
        source: null,
        domain,
        topics: [],
        entities: [],
        eventIds: [],
      });
    }

    if (processedItemIdsForEvents.size > 0) {
      const eventRows = await this.prisma.newsEventItem.findMany({
        where: {
          orgId,
          processedItemId: { in: Array.from(processedItemIdsForEvents) },
        },
        select: { processedItemId: true, eventId: true },
        orderBy: { createdAt: "desc" },
      });

      const eventIdsByProcessedItemId = new Map<string, string[]>();
      for (const row of eventRows) {
        const processedItemId = this.normalizeBehaviorId(row.processedItemId);
        const eventId = this.normalizeBehaviorId(row.eventId);
        if (!processedItemId || !eventId) {
          continue;
        }
        const bucket = eventIdsByProcessedItemId.get(processedItemId) ?? [];
        if (!bucket.includes(eventId)) {
          bucket.push(eventId);
        }
        if (bucket.length > 8) {
          bucket.length = 8;
        }
        eventIdsByProcessedItemId.set(processedItemId, bucket);
      }

      for (const [itemMetaId, processedItemIds] of processedItemIdsByMetaId.entries()) {
        const eventIdSet = new Set<string>();
        for (const processedItemId of processedItemIds) {
          const eventIds = eventIdsByProcessedItemId.get(processedItemId) ?? [];
          for (const eventId of eventIds) {
            eventIdSet.add(eventId);
            if (eventIdSet.size >= 8) {
              break;
            }
          }
          if (eventIdSet.size >= 8) {
            break;
          }
        }
        const feature =
          out.get(itemMetaId) ??
          ({
            source: null,
            domain: null,
            topics: [],
            entities: [],
            eventIds: [],
          } as ItemCandidateFeatures);
        feature.eventIds = Array.from(eventIdSet);
        out.set(itemMetaId, feature);
      }
    }

    return out;
  }

  private async loadItemPersonalizationProfile(
    orgId: string,
    userId: string,
  ): Promise<ItemPersonalizationProfile> {
    const profile = await this.userNewsBehavior.getPersonalizationProfile(
      orgId,
      userId,
    );
    return {
      positive: {
        sources: this.parseBehaviorScores(profile.positive.sources),
        topics: this.parseBehaviorScores(profile.positive.topics),
        entities: this.parseBehaviorScores(profile.positive.entities),
        items: this.parseBehaviorScores(profile.positive.items, (value) =>
          this.normalizeBehaviorId(value),
        ),
        events: this.parseBehaviorScores(profile.positive.events, (value) =>
          this.normalizeBehaviorId(value),
        ),
        domains: this.parseBehaviorScores(profile.positive.domains),
      },
      negative: {
        sources: this.parseBehaviorScores(profile.negative.sources),
        topics: this.parseBehaviorScores(profile.negative.topics),
        entities: this.parseBehaviorScores(profile.negative.entities),
        items: this.parseBehaviorScores(profile.negative.items, (value) =>
          this.normalizeBehaviorId(value),
        ),
        events: this.parseBehaviorScores(profile.negative.events, (value) =>
          this.normalizeBehaviorId(value),
        ),
        domains: this.parseBehaviorScores(profile.negative.domains),
      },
    };
  }

  private parseBehaviorScores(
    raw: Record<string, string | number>,
    normalizeKey: (value?: string) => string | null = (value) =>
      this.normalizePreferenceKey(value),
  ): Record<string, number> {
    const entries = Object.entries(raw ?? {})
      .map(([term, value]) => {
        const normalized = normalizeKey(term);
        if (!normalized) {
          return null;
        }
        const score = Number(value);
        if (!Number.isFinite(score) || score <= 0) {
          return null;
        }
        return [normalized, score] as const;
      })
      .filter((entry): entry is readonly [string, number] => Boolean(entry))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 400);
    return Object.fromEntries(entries);
  }

  private normalizePreferenceTerms(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const terms: string[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
      let raw: string | undefined;
      if (typeof entry === "string") {
        raw = entry;
      } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const record = entry as Record<string, unknown>;
        raw =
          typeof record.name === "string"
            ? record.name
            : typeof record.label === "string"
              ? record.label
              : typeof record.value === "string"
                ? record.value
                : undefined;
      }
      const normalized = this.normalizePreferenceKey(raw);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      terms.push(normalized);
      if (terms.length >= 10) {
        break;
      }
    }
    return terms;
  }

  private normalizePreferenceKey(value?: string | null): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const normalized = value
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .slice(0, 96);
    return normalized.length > 0 ? normalized : null;
  }

  private normalizeBehaviorId(value?: string | null): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const normalized = value.trim().slice(0, 128);
    return normalized.length > 0 ? normalized : null;
  }

  private normalizePreferenceDomain(value?: string | null): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const raw = value.trim();
    if (!raw) {
      return null;
    }
    const parseCandidate = (candidate: string): string | null => {
      try {
        const parsed = new URL(candidate);
        const hostname = parsed.hostname.trim().toLowerCase().replace(/^www\./, "");
        return this.normalizePreferenceKey(hostname);
      } catch {
        return null;
      }
    };

    return parseCandidate(raw) ?? parseCandidate(`https://${raw}`);
  }

  private sumPreferenceScore(
    terms: string[],
    profile: Record<string, number>,
    limit: number,
  ): number {
    if (!terms.length) {
      return 0;
    }
    let score = 0;
    let consumed = 0;
    const seen = new Set<string>();
    for (const term of terms) {
      if (seen.has(term)) {
        continue;
      }
      seen.add(term);
      const value = profile[term];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        score += value;
      }
      consumed += 1;
      if (consumed >= limit) {
        break;
      }
    }
    return score;
  }

  private resolveSourcePreferenceScore(
    feature: ItemCandidateFeatures | undefined,
    profile: Record<string, number>,
  ): number {
    let score = 0;
    if (feature?.source) {
      const sourceScore = profile[feature.source];
      if (
        typeof sourceScore === "number" &&
        Number.isFinite(sourceScore) &&
        sourceScore > score
      ) {
        score = sourceScore;
      }
    }
    if (feature?.domain) {
      const domainScore = profile[feature.domain];
      if (
        typeof domainScore === "number" &&
        Number.isFinite(domainScore) &&
        domainScore > score
      ) {
        score = domainScore;
      }
    }
    return score;
  }
}
