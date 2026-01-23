import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema, type JsonSchema7Type } from "zod-to-json-schema";

import { safeJsonParseFromText } from "../../common/llm-json";
import { CacheService } from "../cache/cache.service";
import { LiteLlmService, type LiteLlmMessage } from "../news-pipeline/litellm.service";
import type { JsonSchemaResponseFormat } from "../news-pipeline/news-prompt.builder";

import type { SituationMonitorInsightsResponse } from "./situation-monitor.service";
import type { SituationMonitorHeadline, SituationMonitorFedNewsItem } from "./situation-monitor.types";

const logger = createLogger({ name: "situation-monitor-translation" });

const TRANSLATION_CACHE_KEY_PREFIX = "situation-monitor:translation:v1:zh-cn";
const TRANSLATION_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;
const TRANSLATION_BATCH_MAX_CHARS = 3_000;

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

@Injectable()
export class SituationMonitorTranslationService {
  constructor(
    private readonly cache: CacheService,
    private readonly llm: LiteLlmService,
  ) {}

  async applyZhTranslationsBestEffort(
    insights: SituationMonitorInsightsResponse,
  ): Promise<{ applied: boolean; error?: string }> {
    const targets = this.collectTranslationTargets(insights);
    if (targets.size === 0) {
      return { applied: true };
    }

    try {
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
      }
    }

    if (insights.correlation) {
      const correlation = insights.correlation;
      for (const entry of correlation.emergingPatterns ?? []) {
        for (const headline of entry.headlines ?? []) {
          collect(headline.title);
        }
      }
      for (const entry of correlation.momentumSignals ?? []) {
        for (const headline of entry.headlines ?? []) {
          collect(headline.title);
        }
      }
      for (const entry of correlation.crossSourceCorrelations ?? []) {
        for (const headline of entry.headlines ?? []) {
          collect(headline.title);
        }
      }
      for (const entry of correlation.predictiveSignals ?? []) {
        for (const headline of entry.headlines ?? []) {
          collect(headline.title);
        }
      }
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
          for (const headline of entry.headlines ?? []) {
            collect(headline.title);
          }
        }
      }
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
    for (const chunk of chunks) {
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
      for (const entry of correlation.emergingPatterns ?? []) {
        for (const ref of entry.headlines ?? []) {
          applyHeadlineRef(ref);
        }
      }
      for (const entry of correlation.momentumSignals ?? []) {
        for (const ref of entry.headlines ?? []) {
          applyHeadlineRef(ref);
        }
      }
      for (const entry of correlation.crossSourceCorrelations ?? []) {
        for (const ref of entry.headlines ?? []) {
          applyHeadlineRef(ref);
        }
      }
      for (const entry of correlation.predictiveSignals ?? []) {
        for (const ref of entry.headlines ?? []) {
          applyHeadlineRef(ref);
        }
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
      const buckets = [
        narrative.emergingFringe,
        narrative.fringeToMainstream,
        narrative.narrativeWatch,
        narrative.disinfoSignals,
      ];
      for (const list of buckets) {
        for (const entry of list ?? []) {
          for (const headline of entry.headlines ?? []) {
            applyNarrativeHeadline(headline);
          }
        }
      }
    }
  }

  private translationCacheKey(hash: string) {
    return `${TRANSLATION_CACHE_KEY_PREFIX}:${hash}`;
  }
}
