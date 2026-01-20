import {
  SituationSignalFeedbackModel,
  SituationSignalLearningStateModel,
  type SituationSignalFeedbackLabel,
  type SituationSignalType,
} from "@modular/mongo";
import { Injectable } from "@nestjs/common";

import { CacheService } from "../cache/cache.service";

export interface SituationSignalLearningStateSnapshot {
  signalType: SituationSignalType;
  signalId: string;
  falsePositiveCount: number;
  falseNegativeCount: number;
  suppressedItemMetaIds: string[];
  boostedTokens: string[];
  blockedTokens: string[];
}

const INSIGHTS_LEARNING_REV_KEY_PREFIX = "situation-monitor:insights:learning-rev:v1";
const INSIGHTS_LEARNING_REV_TTL_SECONDS = 60 * 60 * 24 * 90;

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "he",
  "her",
  "hers",
  "him",
  "his",
  "i",
  "in",
  "into",
  "is",
  "it",
  "its",
  "may",
  "more",
  "of",
  "on",
  "or",
  "our",
  "ours",
  "she",
  "that",
  "the",
  "their",
  "them",
  "then",
  "they",
  "this",
  "to",
  "was",
  "we",
  "were",
  "will",
  "with",
  "you",
  "your",
]);

@Injectable()
export class SituationMonitorFeedbackService {
  private readonly boostedTokenActivationThreshold = 1;
  private readonly blockedTokenActivationThreshold = 2;

  constructor(private readonly cache: CacheService) {}

  async recordFeedback(options: {
    orgId: string;
    userId: string;
    signalType: SituationSignalType;
    signalId: string;
    label: SituationSignalFeedbackLabel;
    itemMetaId?: string;
    itemLink?: string;
    itemTitle?: string;
    itemSource?: string;
    note?: string;
  }) {
    const signalId = options.signalId.trim();
    if (!signalId) {
      throw new Error("signalId is required");
    }

    const itemMetaId = typeof options.itemMetaId === "string" ? options.itemMetaId.trim() : "";
    const itemLink = typeof options.itemLink === "string" ? options.itemLink.trim() : "";
    const itemTitle = typeof options.itemTitle === "string" ? options.itemTitle.trim() : "";
    const itemSource = typeof options.itemSource === "string" ? options.itemSource.trim() : "";
    const note = typeof options.note === "string" ? options.note.trim() : "";

    await SituationSignalFeedbackModel.create({
      orgId: options.orgId,
      userId: options.userId,
      signalType: options.signalType,
      signalId,
      label: options.label,
      itemMetaId: itemMetaId || null,
      itemLink: itemLink || null,
      itemTitle: itemTitle || null,
      itemSource: itemSource || null,
      note: note || null,
    });

    const tokens = this.extractTokens(itemTitle);
    const inc: Record<string, number> = {};
    const addToSet: Record<string, unknown> = {};

    if (options.label === "false_positive") {
      inc.falsePositiveCount = 1;
      for (const token of tokens) {
        inc[`blockedTokenCounts.${token}`] = 1;
      }
      if (itemMetaId) {
        addToSet.suppressedItemMetaIds = itemMetaId;
      }
    } else {
      inc.falseNegativeCount = 1;
      for (const token of tokens) {
        inc[`boostedTokenCounts.${token}`] = 1;
      }
    }

    const update: Record<string, unknown> = {
      $setOnInsert: {
        orgId: options.orgId,
        signalType: options.signalType,
        signalId,
        falsePositiveCount: 0,
        falseNegativeCount: 0,
        suppressedItemMetaIds: [],
        boostedTokenCounts: {},
        blockedTokenCounts: {},
      },
      $inc: inc,
    };

    if (Object.keys(addToSet).length > 0) {
      update.$addToSet = addToSet;
    }

    await SituationSignalLearningStateModel.updateOne(
      { orgId: options.orgId, signalType: options.signalType, signalId },
      update,
      { upsert: true },
    ).exec();

    await this.cache.incr(this.insightsLearningRevKey(options.orgId), INSIGHTS_LEARNING_REV_TTL_SECONDS);

    return { ok: true };
  }

  async getLearningState(orgId: string, signalType: SituationSignalType, signalIds: string[]) {
    const ids = Array.from(
      new Set(
        (signalIds ?? [])
          .filter((id) => typeof id === "string")
          .map((id) => id.trim())
          .filter((id) => id.length > 0),
      ),
    );
    if (ids.length === 0) {
      return new Map<string, SituationSignalLearningStateSnapshot>();
    }

    const docs = await SituationSignalLearningStateModel.find({
      orgId,
      signalType,
      signalId: { $in: ids },
    })
      .select({
        signalType: 1,
        signalId: 1,
        falsePositiveCount: 1,
        falseNegativeCount: 1,
        suppressedItemMetaIds: 1,
        boostedTokenCounts: 1,
        blockedTokenCounts: 1,
      })
      .lean()
      .exec();

    const map = new Map<string, SituationSignalLearningStateSnapshot>();
    for (const doc of docs) {
      const boostedTokens = this.pickActiveTokens((doc as any).boostedTokenCounts, this.boostedTokenActivationThreshold);
      const blockedTokens = this.pickActiveTokens((doc as any).blockedTokenCounts, this.blockedTokenActivationThreshold);
      map.set(String((doc as any).signalId ?? ""), {
        signalType,
        signalId: String((doc as any).signalId ?? ""),
        falsePositiveCount: this.toSafeInt((doc as any).falsePositiveCount),
        falseNegativeCount: this.toSafeInt((doc as any).falseNegativeCount),
        suppressedItemMetaIds: Array.isArray((doc as any).suppressedItemMetaIds)
          ? (doc as any).suppressedItemMetaIds.filter((entry: unknown) => typeof entry === "string")
          : [],
        boostedTokens,
        blockedTokens,
      });
    }

    return map;
  }

  private insightsLearningRevKey(orgId: string) {
    return `${INSIGHTS_LEARNING_REV_KEY_PREFIX}:${orgId}`;
  }

  private pickActiveTokens(value: unknown, threshold: number): string[] {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [];
    }
    const record = value as Record<string, unknown>;
    const entries = Object.entries(record)
      .map(([token, count]) => ({
        token,
        count: typeof count === "number" && Number.isFinite(count) ? count : 0,
      }))
      .filter((entry) => entry.count >= threshold && entry.token.length > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 25)
      .map((entry) => entry.token);
    return entries;
  }

  private extractTokens(text: string): string[] {
    if (!text) {
      return [];
    }
    const matches = text.toLowerCase().match(/[a-z0-9]{3,24}/g) ?? [];
    const result: string[] = [];
    const seen = new Set<string>();
    for (const raw of matches) {
      if (STOPWORDS.has(raw)) {
        continue;
      }
      if (seen.has(raw)) {
        continue;
      }
      seen.add(raw);
      result.push(raw);
      if (result.length >= 8) {
        break;
      }
    }
    return result;
  }

  private toSafeInt(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return 0;
    }
    return Math.max(0, Math.trunc(value));
  }
}
