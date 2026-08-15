import { ProcessedItemModel, type MongoConnection } from "@modular/mongo";
import { Inject, Injectable } from "@nestjs/common";
import { type PipelineStage } from "mongoose";

import { PipelineStageStatus } from "../../common/pipeline-status";
import { CacheService } from "../cache/cache.service";
import { MONGO_CONNECTION } from "../config/mongo.provider";

import {
  DAY_MS,
  DEFAULT_EVENT_MIN_GROUP_SIZE,
  DEFAULT_EVENT_WINDOW_DAYS,
  DEFAULT_TOPIC_WINDOW_DAYS,
  EVENT_GROUPS_CACHE_TTL_SECONDS,
  MAX_EVENT_GROUPS,
  MAX_EVENT_ITEMS,
  MAX_TOPIC_GROUPS,
  MAX_TOPIC_ITEMS,
  TOPIC_GROUPS_CACHE_TTL_SECONDS,
  type CachedEventGroup,
  type CachedTopicGroup,
  type EventGroup,
  type TopicGroup,
} from "./items.shared";

@Injectable()
export class ItemsGroupingService {
  constructor(
    private readonly cache: CacheService,
    @Inject(MONGO_CONNECTION) private readonly _mongo: MongoConnection,
  ) {
    void this._mongo;
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

    const cacheKey = `items:topic-groups:${orgId}:${normalizedLimit}:${normalizedItems}:${windowDays}`;
    const cached = await this.cache.get<CachedTopicGroup[]>(cacheKey);
    if (cached && Array.isArray(cached)) {
      if (cached.length === 0) {
        return [];
      }
      const parsed = cached
        .map((group) => {
          const latestAt = new Date(group.latestAt);
          if (!Number.isFinite(latestAt.valueOf())) {
            return null;
          }
          return {
            topic: group.topic,
            count: group.count,
            latestAt,
            items: group.items.map((item) => ({
              ...item,
              createdAt: new Date(item.createdAt)
            }))
          };
        })
        .filter((group): group is TopicGroup => Boolean(group));
      if (parsed.length > 0) {
        return parsed;
      }
    }

    const pipeline: PipelineStage[] = [
      {
        $match: {
          orgId,
          status: 'completed',
          'result.topics.0': { $exists: true }
        }
      },
      {
        $project: {
          itemMetaId: 1,
          createdAt: 1,
          ingestedAt: 1,
          sortAt: 1,
          result: 1
        }
      },
      {
        $addFields: {
          ingestedAt: {
            $ifNull: ["$ingestedAt", "$createdAt"]
          },
          sortAt: {
            $ifNull: [
              "$sortAt",
              {
                $convert: {
                  input: "$result.published_at",
                  to: "date",
                  onError: { $ifNull: ["$ingestedAt", "$createdAt"] },
                  onNull: { $ifNull: ["$ingestedAt", "$createdAt"] }
                }
              }
            ]
          }
        }
      },
      {
        $match: {
          sortAt: { $gte: since }
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
        $sort: { sortAt: -1 }
      },
      {
        $group: {
          _id: '$result.topics',
          count: { $sum: 1 },
          latestAt: { $first: '$sortAt' },
          items: {
            $push: {
              processedId: '$_id',
              itemMetaId: '$itemMetaId',
              title: '$result.title',
              summary: '$result.summary',
              source: '$result.source',
              publishedAt: '$result.published_at',
              createdAt: '$ingestedAt'
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
      items: {
        processedId: { toString: () => string };
        itemMetaId: string;
        title?: string | null;
        summary?: string | null;
        source?: string | null;
        publishedAt?: string | null;
        createdAt: Date;
      }[];
    }>(pipeline);

    const mapped = groups.map((group) => ({
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

    const cachePayload: CachedTopicGroup[] = mapped.map((group) => ({
      topic: group.topic,
      count: group.count,
      latestAt: group.latestAt.toISOString(),
      items: group.items.map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString()
      }))
    }));
    await this.cache.set(cacheKey, cachePayload, TOPIC_GROUPS_CACHE_TTL_SECONDS);

    return mapped;
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

    const cacheKey = `items:event-groups:${orgId}:${normalizedLimit}:${normalizedItems}:${windowDays}:${minGroupSize}`;
    const cached = await this.cache.get<CachedEventGroup[]>(cacheKey);
    if (cached && Array.isArray(cached)) {
      if (cached.length === 0) {
        return [];
      }
      const parsed = cached
        .map((group) => {
          const latestAt = new Date(group.latestAt);
          if (!Number.isFinite(latestAt.valueOf())) {
            return null;
          }
          return {
            ...group,
            latestAt,
            items: group.items.map((item) => ({
              ...item,
              createdAt: new Date(item.createdAt)
            }))
          };
        })
        .filter((group): group is EventGroup => Boolean(group));
      if (parsed.length > 0) {
        return parsed;
      }
    }

    const pipeline: PipelineStage[] = [
      {
        $match: {
          orgId,
          status: PipelineStageStatus.Completed,
        }
      },
      {
        $project: {
          itemMetaId: 1,
          createdAt: 1,
          ingestedAt: 1,
          sortAt: 1,
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
          },
          ingestedAt: {
            $ifNull: ["$ingestedAt", "$createdAt"]
          },
          sortAt: {
            $ifNull: [
              "$sortAt",
              {
                $convert: {
                  input: "$result.published_at",
                  to: "date",
                  onError: { $ifNull: ["$ingestedAt", "$createdAt"] },
                  onNull: { $ifNull: ["$ingestedAt", "$createdAt"] }
                }
              }
            ]
          }
        }
      },
      {
        $match: {
          sortAt: { $gte: since }
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
        $sort: { sortAt: -1 }
      },
      {
        $group: {
          _id: "$groupId",
          count: { $sum: 1 },
          latestAt: { $first: "$sortAt" },
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
              createdAt: "$ingestedAt"
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
      entities?: ({ name?: string | null } | null)[] | null;
      items: {
        processedId: { toString: () => string };
        itemMetaId: string;
        title?: string | null;
        summary?: string | null;
        source?: string | null;
        publishedAt?: string | null;
        createdAt: Date;
      }[];
    }>(pipeline);

    const mapped = groups.map((group) => {
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

    const cachePayload: CachedEventGroup[] = mapped.map((group) => ({
      ...group,
      latestAt: group.latestAt.toISOString(),
      items: group.items.map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString()
      }))
    }));
    await this.cache.set(cacheKey, cachePayload, EVENT_GROUPS_CACHE_TTL_SECONDS);

    return mapped;
  }
}
