import { ProcessedItemModel } from "@modular/mongo";
import { Injectable } from "@nestjs/common";
import { AlertMetricProvider, type AlertRule } from "@prisma/client";

import type { MetricEvaluation, MetricProvider } from "./metric-provider";

function clampInt(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return min;
  }
  const normalized = Math.trunc(value);
  return Math.min(Math.max(normalized, min), max);
}

function clampFloat(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function toMetadata(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function buildSortAtWindowOr(start: Date, end: Date): Record<string, unknown>[] {
  const range = { $gte: start, $lt: end };
  return [
    { sortAt: range },
    { sortAt: { $exists: false }, ingestedAt: range },
    { sortAt: null, ingestedAt: range },
    { sortAt: { $exists: false }, ingestedAt: { $exists: false }, createdAt: range },
    { sortAt: null, ingestedAt: { $exists: false }, createdAt: range }
  ];
}


type SentimentWindowStats = {
  total: number;
  negative: number;
  positive: number;
  neutral: number;
  scoreSum: number;
};

@Injectable()
export class EntitySentimentMetricProvider implements MetricProvider {
  readonly type = AlertMetricProvider.entity_sentiment;

  supports(rule: Pick<AlertRule, "metricProvider">) {
    return rule.metricProvider === this.type;
  }

  async fetch(
    rule: Pick<AlertRule, "metricSlug" | "operator" | "changeWindowMin" | "metadata" | "metricProvider" | "orgId">
  ): Promise<MetricEvaluation> {
    const metadata = toMetadata(rule.metadata);
    const minEntityConfidence = clampFloat(
      typeof metadata?.minEntityConfidence === "number" ? metadata.minEntityConfidence : 0.5,
      0,
      1
    );
    const minDocsInWindow = clampInt(typeof metadata?.minDocsInWindow === "number" ? metadata.minDocsInWindow : 5, 1, 10_000);
    const baselineWindowMin = clampInt(
      typeof metadata?.baselineWindowMin === "number" ? metadata.baselineWindowMin : 7 * 24 * 60,
      60,
      365 * 24 * 60
    );
    const includeEvidenceItems = clampInt(
      typeof metadata?.includeEvidenceItems === "number" ? metadata.includeEvidenceItems : 5,
      0,
      20
    );
    const entityType = typeof metadata?.entityType === "string" ? metadata.entityType.trim() : "";

    const windowMinutes = clampInt(
      typeof rule.changeWindowMin === "number"
        ? rule.changeWindowMin
        : typeof metadata?.windowMinutes === "number"
          ? metadata.windowMinutes
          : 60,
      5,
      7 * 24 * 60
    );
    const now = Date.now();
    const windowEnd = new Date(now);
    const windowStart = new Date(now - windowMinutes * 60 * 1000);
    const baselineEnd = new Date(windowStart.getTime());
    const baselineStart = new Date(baselineEnd.getTime() - baselineWindowMin * 60 * 1000);

    const entityName = rule.metricSlug.trim();
    if (!entityName) {
      return { latest: null, previous: null, changePercent: null, context: { error: "entity_missing" } };
    }

    const [current, baseline] = await Promise.all([
      this.computeWindowStats(rule.orgId, entityName, entityType, minEntityConfidence, windowStart, windowEnd),
      this.computeWindowStats(rule.orgId, entityName, entityType, minEntityConfidence, baselineStart, baselineEnd)
    ]);

    if (current.total < minDocsInWindow || baseline.total < minDocsInWindow) {
      return {
        latest: null,
        previous: null,
        changePercent: null,
        context: {
          error: "insufficient_docs",
          entityName,
          entityType: entityType || null,
          minDocsInWindow,
          current,
          baseline
        }
      };
    }

    const currentNegRatio = current.total > 0 ? current.negative / current.total : 0;
    const baselineNegRatio = baseline.total > 0 ? baseline.negative / baseline.total : 0;
    const currentAvg = current.total > 0 ? current.scoreSum / current.total : 0;
    const baselineAvg = baseline.total > 0 ? baseline.scoreSum / baseline.total : 0;

    const se = Math.sqrt(Math.max(1e-12, (baselineNegRatio * (1 - baselineNegRatio)) / Math.max(1, current.total)));
    const z = se > 0 ? (currentNegRatio - baselineNegRatio) / se : 0;
    const evidence =
      includeEvidenceItems > 0 && current.negative > 0 && currentNegRatio > baselineNegRatio
        ? await this.fetchEvidence({
            orgId: rule.orgId,
            entityName,
            entityType,
            minEntityConfidence,
            start: windowStart,
            end: windowEnd,
            limit: includeEvidenceItems
          })
        : [];

    return {
      latest: z,
      previous: null,
      changePercent: null,
      context: {
        entityName,
        entityType: entityType || null,
        window: {
          start: windowStart.toISOString(),
          end: windowEnd.toISOString(),
          minutes: windowMinutes,
          ...current,
          negativeRatio: currentNegRatio,
          avgScore: currentAvg
        },
        baseline: {
          start: baselineStart.toISOString(),
          end: baselineEnd.toISOString(),
          minutes: baselineWindowMin,
          ...baseline,
          negativeRatio: baselineNegRatio,
          avgScore: baselineAvg
        },
        z,
        minEntityConfidence,
        evidence
      }
    };
  }

  private async computeWindowStats(
    orgId: string,
    entityName: string,
    entityType: string,
    minEntityConfidence: number,
    start: Date,
    end: Date
  ): Promise<SentimentWindowStats> {
    const matchEntities: Record<string, unknown> = {
      name: entityName,
      confidence: { $gte: minEntityConfidence }
    };
    if (entityType) {
      matchEntities.type = entityType;
    }

    const pipeline = [
      {
        $match: {
          orgId,
          status: "completed",
          $or: buildSortAtWindowOr(start, end),
          "result.sentiment_label": { $exists: true, $ne: null },
          "result.entities": { $elemMatch: matchEntities }
        }
      },
      {
        $project: {
          sentiment: { $toLower: "$result.sentiment_label" }
        }
      },
      {
        $project: {
          sentiment: 1,
          score: {
            $switch: {
              branches: [
                { case: { $eq: ["$sentiment", "positive"] }, then: 1 },
                { case: { $eq: ["$sentiment", "neutral"] }, then: 0 },
                { case: { $eq: ["$sentiment", "negative"] }, then: -1 }
              ],
              default: 0
            }
          },
          neg: { $cond: [{ $eq: ["$sentiment", "negative"] }, 1, 0] },
          pos: { $cond: [{ $eq: ["$sentiment", "positive"] }, 1, 0] },
          neu: { $cond: [{ $eq: ["$sentiment", "neutral"] }, 1, 0] }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          negative: { $sum: "$neg" },
          positive: { $sum: "$pos" },
          neutral: { $sum: "$neu" },
          scoreSum: { $sum: "$score" }
        }
      },
      {
        $project: {
          _id: 0,
          total: 1,
          negative: 1,
          positive: 1,
          neutral: 1,
          scoreSum: 1
        }
      }
    ];

    const result = await ProcessedItemModel.aggregate(pipeline).allowDiskUse(true);
    const row = (result?.[0] ?? null) as SentimentWindowStats | null;
    return {
      total: typeof row?.total === "number" ? row.total : 0,
      negative: typeof row?.negative === "number" ? row.negative : 0,
      positive: typeof row?.positive === "number" ? row.positive : 0,
      neutral: typeof row?.neutral === "number" ? row.neutral : 0,
      scoreSum: typeof row?.scoreSum === "number" ? row.scoreSum : 0
    };
  }

  private async fetchEvidence(input: {
    orgId: string;
    entityName: string;
    entityType: string;
    minEntityConfidence: number;
    start: Date;
    end: Date;
    limit: number;
  }): Promise<
    Array<{
      processedId: string;
      itemMetaId: string;
      createdAt: string;
      ingestedAt: string | null;
      publishedAt: string | null;
      title: string | null;
      source: string | null;
      sentimentLabel: string | null;
      summary: string | null;
    }>
  > {
    const entityMatch: Record<string, unknown> = {
      name: input.entityName,
      confidence: { $gte: input.minEntityConfidence }
    };
    if (input.entityType) {
      entityMatch.type = input.entityType;
    }

    const records = await ProcessedItemModel.find(
      {
        orgId: input.orgId,
        status: "completed",
        $or: buildSortAtWindowOr(input.start, input.end),
        "result.sentiment_label": { $regex: /^negative$/i },
        "result.entities": { $elemMatch: entityMatch }
      },
      {
        itemMetaId: 1,
        createdAt: 1,
        ingestedAt: 1,
        "result.title": 1,
        "result.summary": 1,
        "result.published_at": 1,
        "result.source": 1,
        "result.sentiment_label": 1
      }
    )
      .sort({ sortAt: -1, ingestedAt: -1, createdAt: -1 })
      .limit(Math.max(0, input.limit))
      .lean();

    return (records ?? []).map((doc: any) => {
      const ingestedAt = doc?.ingestedAt instanceof Date ? doc.ingestedAt.toISOString() : null;
      const processedAt = doc?.createdAt instanceof Date ? doc.createdAt.toISOString() : null;
      const createdAt = ingestedAt ?? processedAt ?? String(doc?.createdAt ?? "");

      return {
        processedId: typeof doc?._id?.toString === "function" ? doc._id.toString() : String(doc?._id ?? ""),
        itemMetaId: typeof doc?.itemMetaId === "string" ? doc.itemMetaId : "",
        createdAt,
        ingestedAt,
        publishedAt: typeof doc?.result?.published_at === "string" ? doc.result.published_at : null,
        title: typeof doc?.result?.title === "string" ? doc.result.title : null,
        source: typeof doc?.result?.source === "string" ? doc.result.source : null,
        sentimentLabel: typeof doc?.result?.sentiment_label === "string" ? doc.result.sentiment_label : null,
        summary: typeof doc?.result?.summary === "string" ? doc.result.summary : null
      };
    });
  }
}
