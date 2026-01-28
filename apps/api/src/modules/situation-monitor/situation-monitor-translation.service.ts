import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema, type JsonSchema7Type } from "zod-to-json-schema";

import { safeJsonParseFromText } from "../../common/llm-json";
import { CacheService } from "../cache/cache.service";
import { LiteLlmService, type LiteLlmMessage } from "../news-pipeline/litellm.service";
import type { JsonSchemaResponseFormat } from "../news-pipeline/news-prompt.builder";
import { SituationMonitorSettingsService } from "../system-settings/situation-monitor-settings.service";

import type { SituationMonitorInsightsResponse } from "./situation-monitor.service";
import type { SituationMonitorHeadline, SituationMonitorFedNewsItem } from "./situation-monitor.types";

const logger = createLogger({ name: "situation-monitor-translation" });

const TRANSLATION_CACHE_KEY_PREFIX = "situation-monitor:translation:v1:zh-cn";
const TRANSLATION_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;
const TRANSLATION_BATCH_MAX_CHARS = 3_000;
const DEFAULT_TRANSLATION_MAX_CONCURRENCY = 2;

const TranslationItemSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
});

const TranslationResponseSchema = z.object({
  translations: z.array(
    z.object({
      id: z.string().min(1),
      zh: z.string(),
    }),
  ),
});

type TranslationResponse = z.infer<typeof TranslationResponseSchema>;

const TRANSLATION_JSON_SCHEMA: JsonSchema7Type = zodToJsonSchema(
  TranslationResponseSchema,
  { $refStrategy: "none" },
);

const TRANSLATION_RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "situation_monitor_translation",
    schema: TRANSLATION_JSON_SCHEMA,
  },
};

function normalizeText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function chunkByChars<T extends { text: string }>(items: T[], maxChars: number): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentChars = 0;

  for (const item of items) {
    const nextChars = item.text.length + 50;
    if (current.length > 0 && currentChars + nextChars > maxChars) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(item);
    currentChars += nextChars;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

class AsyncSemaphore {
  private limit: number;
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(limit: number) {
    this.limit = Math.max(1, Math.trunc(limit));
  }

  setLimit(limit: number) {
    this.limit = Math.max(1, Math.trunc(limit));
    this.drain();
  }

  async withPermit<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(() => this.release());
    }

    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve(() => this.release());
      });
    });
  }

  private release() {
    this.active = Math.max(0, this.active - 1);
    this.drain();
  }

  private drain() {
    while (this.active < this.limit && this.queue.length > 0) {
      const next = this.queue.shift();
      next?.();
    }
  }
}

@Injectable()
export class SituationMonitorTranslationService {
  private readonly semaphore = new AsyncSemaphore(DEFAULT_TRANSLATION_MAX_CONCURRENCY);

  constructor(
    private readonly cache: CacheService,
    private readonly llm: LiteLlmService,
    private readonly settings: SituationMonitorSettingsService,
  ) {}

  async applyZhTranslationsBestEffort(
    insights: SituationMonitorInsightsResponse,
  ): Promise<{ applied: boolean; error?: string }> {
    const targets = this.collectTranslationTargets(insights);
    if (targets.size === 0) {
      return { applied: true };
    }

    try {
      const maxConcurrency = await this.settings.getTranslationMaxConcurrency();
      this.semaphore.setLimit(maxConcurrency);

      const translated = await this.translateHashesToZh(targets);
      this.applyTranslationMap(insights, translated);
      return { applied: true };
    } catch (error) {
      logger.warn(
        {
          error,
          message: error instanceof Error ? error.message : "unknown error",
        },
        "Failed to apply zh-CN translations for situation monitor (best-effort)",
      );
      return {
        applied: false,
        error: error instanceof Error ? error.message : "Failed to translate via LLM gateway.",
      };
    }
  }

  private collectTranslationTargets(insights: SituationMonitorInsightsResponse): Map<string, string> {
    const targets = new Map<string, string>();

    const collect = (text: unknown) => {
      const normalized = normalizeText(text);
      if (!normalized) {
        return;
      }
      targets.set(sha256(normalized), normalized);
    };

    if (insights.headlines) {
      for (const list of Object.values(insights.headlines)) {
        for (const entry of list) {
          collect(entry.title);
          collect(entry.summary);
          if (Array.isArray(entry.keyPoints)) {
            for (const point of entry.keyPoints) {
              collect(point);
            }
          }
        }
      }
    }

    if (Array.isArray(insights.alerts)) {
      for (const entry of insights.alerts) {
        collect(entry.title);
        collect(entry.summary);
        if (Array.isArray(entry.keyPoints)) {
          for (const point of entry.keyPoints) {
            collect(point);
          }
        }
      }
    }

    if (Array.isArray(insights.leaders)) {
      for (const leader of insights.leaders) {
        for (const entry of leader.headlines ?? []) {
          collect(entry.title);
        }
      }
    }

    if (Array.isArray(insights.situations)) {
      for (const panel of insights.situations) {
        collect(panel.title);
        collect(panel.subtitle);
        for (const entry of panel.headlines ?? []) {
          collect(entry.title);
        }
      }
    }

    if (insights.fed?.news) {
      for (const entry of insights.fed.news) {
        collect(entry.title);
        collect(entry.description);
        collect(entry.typeLabel);
      }
    }

    if (insights.correlation) {
      const correlation = insights.correlation;
      for (const entry of correlation.emergingPatterns ?? []) {
        collect(entry.name);
        for (const headline of entry.headlines ?? []) {
          collect(headline.title);
        }
      }
      for (const entry of correlation.momentumSignals ?? []) {
        collect(entry.name);
        for (const headline of entry.headlines ?? []) {
          collect(headline.title);
        }
      }
      for (const entry of correlation.crossSourceCorrelations ?? []) {
        collect(entry.name);
        for (const headline of entry.headlines ?? []) {
          collect(headline.title);
        }
      }
      for (const entry of correlation.predictiveSignals ?? []) {
        collect(entry.name);
        collect(entry.prediction);
        for (const headline of entry.headlines ?? []) {
          collect(headline.title);
        }
      }
    }

    if (insights.correlationSummary) {
      collect(insights.correlationSummary.status);
    }

    if (insights.narrative) {
      const narrative = insights.narrative;
      const buckets = [
        narrative.emergingFringe,
        narrative.fringeToMainstream,
        narrative.narrativeWatch,
        narrative.disinfoSignals,
      ];
      for (const list of buckets) {
        for (const entry of list ?? []) {
          collect(entry.name);
          for (const headline of entry.headlines ?? []) {
            collect(headline.title);
          }
        }
      }
    }

    if (insights.narrativeSummary) {
      collect(insights.narrativeSummary.status);
    }

    if (insights.mainCharacterSummary) {
      collect(insights.mainCharacterSummary.status);
    }

    return targets;
  }

  private async translateHashesToZh(targets: Map<string, string>): Promise<Map<string, string>> {
    const translated = new Map<string, string>();
    const missing: { id: string; text: string }[] = [];

    for (const [hash, text] of targets.entries()) {
      const cached = await this.cache.get<string>(this.translationCacheKey(hash));
      if (cached) {
        translated.set(hash, cached);
        continue;
      }
      missing.push({ id: hash, text });
    }

    if (missing.length === 0) {
      return translated;
    }

    const chunks = chunkByChars(missing, TRANSLATION_BATCH_MAX_CHARS);
    const tasks = chunks.map((chunk) =>
      this.semaphore.withPermit(async () => {
        const response = await this.requestZhTranslations(chunk);
        for (const entry of response.translations) {
          const hash = entry.id;
          const zh = normalizeText(entry.zh);
          if (!targets.has(hash) || !zh) {
            continue;
          }
          translated.set(hash, zh);
          await this.cache.set(this.translationCacheKey(hash), zh, TRANSLATION_CACHE_TTL_SECONDS);
        }
      }),
    );

    const results = await Promise.allSettled(tasks);
    const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
    if (failed) {
      throw failed.reason instanceof Error ? failed.reason : new Error("Failed to translate via LLM gateway");
    }

    return translated;
  }

  private async requestZhTranslations(items: z.infer<typeof TranslationItemSchema>[]): Promise<TranslationResponse> {
    const safeItems = TranslationItemSchema.array().parse(items);
    const systemPrompt = [
      "You are a professional translator.",
      "Translate each provided text into Simplified Chinese (zh-CN).",
      "Be objective and faithful: do not add, remove, or infer any information.",
      "Preserve names, proper nouns, abbreviations, numbers, dates, units, and punctuation.",
      "Do not translate URLs.",
      "If the input text is already Simplified Chinese, return it unchanged.",
      "Return ONLY valid JSON matching the provided schema.",
    ].join("\n");

    const userPrompt = [
      "Translate the following items.",
      "",
      JSON.stringify({ items: safeItems }, null, 2),
    ].join("\n");

    const messages: LiteLlmMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    const completion = await this.llm.acompletion({
      messages,
      temperature: 0,
      response_format: TRANSLATION_RESPONSE_FORMAT,
      metadata: { feature: "situation-monitor", action: "translate", target: "zh-CN" },
      timeoutMs: 120_000,
      max_tokens: 2_000,
    });

    const content = completion.choices?.[0]?.message?.content ?? "";
    const parsed = safeJsonParseFromText<unknown>(content);
    if (!parsed) {
      throw new Error("LiteLLM return was not valid JSON");
    }
    return TranslationResponseSchema.parse(parsed);
  }

  private applyTranslationMap(insights: SituationMonitorInsightsResponse, translated: Map<string, string>) {
    const translateText = (text: unknown): string | null => {
      const normalized = normalizeText(text);
      if (!normalized) {
        return null;
      }
      const hash = sha256(normalized);
      return translated.get(hash) ?? null;
    };

    const translateKeyPoints = (points: unknown): string[] | null => {
      if (!Array.isArray(points)) {
        return null;
      }
      const out: string[] = [];
      let anyTranslated = false;
      for (const point of points) {
        const normalized = normalizeText(point);
        if (!normalized) {
          continue;
        }
        const zh = translateText(normalized);
        if (zh) {
          anyTranslated = true;
          out.push(zh);
        } else {
          out.push(normalized);
        }
      }
      return anyTranslated ? out : null;
    };

    const applyHeadline = (entry: SituationMonitorHeadline) => {
      const titleZh = translateText(entry.title);
      if (titleZh) {
        entry.titleZh = titleZh;
      }
      const summaryZh = translateText(entry.summary);
      if (summaryZh) {
        entry.summaryZh = summaryZh;
      }
      const keyPointsZh = translateKeyPoints(entry.keyPoints);
      if (keyPointsZh) {
        entry.keyPointsZh = keyPointsZh;
      }
    };

    const applyFedNews = (entry: SituationMonitorFedNewsItem) => {
      const titleZh = translateText(entry.title);
      if (titleZh) {
        entry.titleZh = titleZh;
      }
      const descriptionZh = translateText(entry.description);
      if (descriptionZh) {
        entry.descriptionZh = descriptionZh;
      }
      const typeLabelZh = translateText(entry.typeLabel);
      if (typeLabelZh) {
        entry.typeLabelZh = typeLabelZh;
      }
    };

    if (insights.headlines) {
      for (const list of Object.values(insights.headlines)) {
        for (const entry of list) {
          applyHeadline(entry);
        }
      }
    }

    if (Array.isArray(insights.alerts)) {
      for (const entry of insights.alerts) {
        applyHeadline(entry);
      }
    }

    if (Array.isArray(insights.leaders)) {
      for (const leader of insights.leaders) {
        for (const entry of leader.headlines ?? []) {
          const titleZh = translateText(entry.title);
          if (titleZh) {
            entry.titleZh = titleZh;
          }
        }
      }
    }

    if (Array.isArray(insights.situations)) {
      for (const panel of insights.situations) {
        const titleZh = translateText(panel.title);
        if (titleZh) {
          panel.titleZh = titleZh;
        }
        const subtitleZh = translateText(panel.subtitle);
        if (subtitleZh) {
          panel.subtitleZh = subtitleZh;
        }
        for (const entry of panel.headlines ?? []) {
          const entryTitleZh = translateText(entry.title);
          if (entryTitleZh) {
            entry.titleZh = entryTitleZh;
          }
        }
      }
    }

    if (insights.fed?.news) {
      for (const entry of insights.fed.news) {
        applyFedNews(entry);
      }
    }

    if (insights.correlation) {
      const correlation = insights.correlation;
      const applyHeadlineRef = (ref: { title: string; titleZh?: string }) => {
        const titleZh = translateText(ref.title);
        if (titleZh) {
          ref.titleZh = titleZh;
        }
      };
      const applyNameRef = (ref: { name: string; nameZh?: string }) => {
        const nameZh = translateText(ref.name);
        if (nameZh) {
          ref.nameZh = nameZh;
        }
      };
      for (const entry of correlation.emergingPatterns ?? []) {
        applyNameRef(entry);
        for (const ref of entry.headlines ?? []) {
          applyHeadlineRef(ref);
        }
      }
      for (const entry of correlation.momentumSignals ?? []) {
        applyNameRef(entry);
        for (const ref of entry.headlines ?? []) {
          applyHeadlineRef(ref);
        }
      }
      for (const entry of correlation.crossSourceCorrelations ?? []) {
        applyNameRef(entry);
        for (const ref of entry.headlines ?? []) {
          applyHeadlineRef(ref);
        }
      }
      for (const entry of correlation.predictiveSignals ?? []) {
        applyNameRef(entry);
        const predictionZh = translateText(entry.prediction);
        if (predictionZh) {
          entry.predictionZh = predictionZh;
        }
        for (const ref of entry.headlines ?? []) {
          applyHeadlineRef(ref);
        }
      }
    }

    if (insights.correlationSummary) {
      const statusZh = translateText(insights.correlationSummary.status);
      if (statusZh) {
        insights.correlationSummary.statusZh = statusZh;
      }
    }

    if (insights.narrative) {
      const narrative = insights.narrative;
      const applyNarrativeHeadline = (ref: { title: string; titleZh?: string }) => {
        const titleZh = translateText(ref.title);
        if (titleZh) {
          ref.titleZh = titleZh;
        }
      };
      const applyNarrativeName = (ref: { name: string; nameZh?: string }) => {
        const nameZh = translateText(ref.name);
        if (nameZh) {
          ref.nameZh = nameZh;
        }
      };
      const buckets = [
        narrative.emergingFringe,
        narrative.fringeToMainstream,
        narrative.narrativeWatch,
        narrative.disinfoSignals,
      ];
      for (const list of buckets) {
        for (const entry of list ?? []) {
          applyNarrativeName(entry);
          for (const headline of entry.headlines ?? []) {
            applyNarrativeHeadline(headline);
          }
        }
      }
    }

    if (insights.narrativeSummary) {
      const statusZh = translateText(insights.narrativeSummary.status);
      if (statusZh) {
        insights.narrativeSummary.statusZh = statusZh;
      }
    }

    if (insights.mainCharacterSummary) {
      const statusZh = translateText(insights.mainCharacterSummary.status);
      if (statusZh) {
        insights.mainCharacterSummary.statusZh = statusZh;
      }
    }
  }

  private translationCacheKey(hash: string) {
    return `${TRANSLATION_CACHE_KEY_PREFIX}:${hash}`;
  }
}
