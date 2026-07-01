import { Injectable } from "@nestjs/common";

import { CrawlResultService } from "./crawl-result.service";
import type {
  CrawlDetailExpansionOptions,
  CrawlPageTypeHint,
  CrawlQualityProfile,
  CrawlTaskOptions
} from "./crawl.types";
import type { Crawl4aiArticle } from "./crawl4ai.client";

export type CrawlPageKind = "detail" | "list" | "mixed" | "blocked";
export type CrawlPublishTimeSource = "meta" | "time_tag" | "jsonld" | "url_path" | "none";

export interface CrawlArticleSignal {
  wordCount: number;
  paragraphCount: number;
  headingCount: number;
  linkCount: number;
  linkDensity: number;
  bulletLines: number;
  publishTimeConfidence: number;
  publishTimeSource: CrawlPublishTimeSource;
  mediaDensity: number;
  domListRisk: number;
  score: number;
  isListLike: boolean;
}

export interface CrawlLowSignalAssessment {
  index: number;
  article: Crawl4aiArticle;
  quality: CrawlArticleSignal;
  linkInventory: number;
}

export interface CrawlPageAssessment {
  kind: CrawlPageKind;
  assessments: CrawlLowSignalAssessment[];
  lowSignalAssessments: CrawlLowSignalAssessment[];
  allLowSignal: boolean;
  maxLowSignalWords: number;
  minLowSignalWords: number;
  meanLowSignalWords: number;
  bestLowSignalScore: number;
  maxLowSignalLinkDensity: number;
  meanLowSignalLinkDensity: number;
}

const DEFAULT_DETAIL_EXPANSION_OPTIONS: Required<CrawlDetailExpansionOptions> = {
  maxDetailUrls: 12,
  minRelevanceScore: 0.35,
  requireSameDomain: true,
  allowExternalLinks: true,
  includeUrlPatterns: [],
  excludeUrlPatterns: [
    "/tag/",
    "/tags/",
    "/topic/",
    "/topics/",
    "/archive/",
    "/category/",
    "/categories/",
    "/author/",
    "/authors/",
    "/section/",
    "/sections/",
    "/latest"
  ],
  minPublishTimeConfidence: 0.55,
  preferFitMarkdownForQuality: true
};

@Injectable()
export class CrawlQualityStrategyService {
  constructor(private readonly resultService: CrawlResultService) {}

  assessPageSignals(
    successes: Crawl4aiArticle[],
    hint: CrawlPageTypeHint = "auto",
    detailExpansion?: CrawlDetailExpansionOptions
  ): CrawlPageAssessment {
    const resolvedDetailExpansion = this.resolveDetailExpansion({
      detailExpansion
    } as CrawlTaskOptions);
    const assessments = successes.map((article, index) => {
      const quality = this.assessArticleMarkdownSignal(
        article,
        resolvedDetailExpansion.preferFitMarkdownForQuality
      );
      return {
        index,
        article,
        quality,
        linkInventory: this.countArticleLinkInventory(article)
      };
    });

    const lowSignalAssessments = assessments.filter((entry) => this.isLowSignal(entry.quality, entry.linkInventory));
    const allLowSignal = assessments.length > 0 && lowSignalAssessments.length === assessments.length;

    const maxLowSignalWords = lowSignalAssessments.reduce(
      (maxWords, entry) => Math.max(maxWords, entry.quality.wordCount),
      0
    );
    const minLowSignalWords = lowSignalAssessments.reduce(
      (minWords, entry) => Math.min(minWords, entry.quality.wordCount),
      Number.POSITIVE_INFINITY
    );
    const meanLowSignalWords =
      lowSignalAssessments.length > 0
        ? lowSignalAssessments.reduce((total, entry) => total + entry.quality.wordCount, 0) /
          lowSignalAssessments.length
        : 0;
    const bestLowSignalScore = lowSignalAssessments.reduce(
      (maxScore, entry) => Math.max(maxScore, entry.quality.score),
      Number.NEGATIVE_INFINITY
    );
    const maxLowSignalLinkDensity = lowSignalAssessments.reduce(
      (maxDensity, entry) => Math.max(maxDensity, entry.quality.linkDensity),
      0
    );
    const meanLowSignalLinkDensity =
      lowSignalAssessments.length > 0
        ? lowSignalAssessments.reduce((total, entry) => total + entry.quality.linkDensity, 0) /
          lowSignalAssessments.length
        : 0;

    return {
      kind: this.classifyPageKind(assessments, lowSignalAssessments, hint),
      assessments,
      lowSignalAssessments,
      allLowSignal,
      maxLowSignalWords,
      minLowSignalWords,
      meanLowSignalWords,
      bestLowSignalScore,
      maxLowSignalLinkDensity,
      meanLowSignalLinkDensity
    };
  }

  shouldAutoExpand(options: CrawlTaskOptions, page: CrawlPageAssessment): boolean {
    if (options.autoExpandDetails === false) {
      return false;
    }
    if (page.lowSignalAssessments.length === 0) {
      return false;
    }

    const hint = options.pageTypeHint ?? "auto";
    if (hint === "detail") {
      return page.allLowSignal;
    }
    if (hint === "list") {
      return true;
    }
    return page.kind === "list" || page.kind === "mixed" || page.allLowSignal;
  }

  resolveDetailExpansion(options: CrawlTaskOptions): Required<CrawlDetailExpansionOptions> {
    const input = options.detailExpansion;
    const maxDetailUrls =
      typeof input?.maxDetailUrls === "number" && Number.isFinite(input.maxDetailUrls)
        ? Math.max(1, Math.min(30, Math.round(input.maxDetailUrls)))
        : DEFAULT_DETAIL_EXPANSION_OPTIONS.maxDetailUrls;
    const minRelevanceScore =
      typeof input?.minRelevanceScore === "number" && Number.isFinite(input.minRelevanceScore)
        ? Math.max(0, Math.min(1, Number(input.minRelevanceScore.toFixed(3))))
        : DEFAULT_DETAIL_EXPANSION_OPTIONS.minRelevanceScore;
    const requireSameDomain =
      typeof input?.requireSameDomain === "boolean"
        ? input.requireSameDomain
        : DEFAULT_DETAIL_EXPANSION_OPTIONS.requireSameDomain;
    const allowExternalLinks =
      typeof input?.allowExternalLinks === "boolean"
        ? input.allowExternalLinks
        : requireSameDomain === false
          ? true
          : DEFAULT_DETAIL_EXPANSION_OPTIONS.allowExternalLinks;
    const includeUrlPatterns = this.normalizePatternList(input?.includeUrlPatterns) ?? [];
    const excludeUrlPatterns =
      this.normalizePatternList(input?.excludeUrlPatterns) ??
      DEFAULT_DETAIL_EXPANSION_OPTIONS.excludeUrlPatterns;
    const minPublishTimeConfidence =
      typeof input?.minPublishTimeConfidence === "number" &&
      Number.isFinite(input.minPublishTimeConfidence)
        ? Math.max(0, Math.min(1, Number(input.minPublishTimeConfidence.toFixed(3))))
        : DEFAULT_DETAIL_EXPANSION_OPTIONS.minPublishTimeConfidence;
    const preferFitMarkdownForQuality =
      typeof input?.preferFitMarkdownForQuality === "boolean"
        ? input.preferFitMarkdownForQuality
        : DEFAULT_DETAIL_EXPANSION_OPTIONS.preferFitMarkdownForQuality;

    return {
      maxDetailUrls,
      minRelevanceScore,
      requireSameDomain,
      allowExternalLinks,
      includeUrlPatterns,
      excludeUrlPatterns,
      minPublishTimeConfidence,
      preferFitMarkdownForQuality
    };
  }

  scoreMarkdownQuality(successes: Crawl4aiArticle[]): number {
    if (successes.length === 0) {
      return Number.NEGATIVE_INFINITY;
    }
    return successes.reduce((total, item) => total + this.scoreSingleMarkdownQuality(item), 0);
  }

  scoreSingleMarkdownQuality(item: Crawl4aiArticle): number {
    const markdownResult = this.resultService.extractMarkdownResult(item.markdown);
    const primary = typeof markdownResult.primary === "string" ? markdownResult.primary.trim() : "";
    if (!primary) {
      return -1000;
    }

    const words = primary.split(/\s+/).filter((entry) => entry.length > 0).length;
    const headings = (primary.match(/^#{1,6}\s+/gm) ?? []).length;
    const markdownLinks = (primary.match(/\]\((https?:\/\/|\/)/g) ?? []).length;
    const rawUrls = (primary.match(/https?:\/\/\S+/g) ?? []).length;
    const codeFenceMarkers = (primary.match(/```/g) ?? []).length;
    const codeBlocks = Math.floor(codeFenceMarkers / 2);
    const citationMarks = (primary.match(/\[\^\d+\]/g) ?? []).length;
    const boilerplateRatio = this.estimateBoilerplateRatio(primary);

    const score =
      Math.min(words, 6000) +
      headings * 8 +
      citationMarks * 2 -
      (markdownLinks + rawUrls) * 4 -
      codeBlocks * 3 -
      Math.round(boilerplateRatio * 220);
    return Number.isFinite(score) ? score : 0;
  }

  isSignificantDetailImprovement(
    quality: CrawlArticleSignal,
    baseScore: number,
    baseWords: number,
    baseLinkDensity: number
  ): boolean {
    if (quality.wordCount <= 0) {
      return false;
    }

    const densityTarget = Math.max(baseLinkDensity * 0.65, 0.08);
    if (
      quality.isListLike &&
      quality.wordCount < Math.max(baseWords + 80, 180) &&
      quality.linkDensity >= Math.max(densityTarget * 0.9, 0.12)
    ) {
      return false;
    }

    if (!quality.isListLike && quality.paragraphCount >= 3 && quality.wordCount >= 120 && quality.linkDensity <= densityTarget) {
      return true;
    }

    if (quality.score >= baseScore + 120 && quality.linkDensity <= Math.max(baseLinkDensity * 0.8, 0.2)) {
      return true;
    }

    if (quality.wordCount >= baseWords + 100 && quality.linkDensity <= Math.max(baseLinkDensity * 0.85, 0.22)) {
      return true;
    }

    if (
      !quality.isListLike &&
      quality.wordCount >= Math.max(Math.floor(baseWords * 0.6), 140) &&
      quality.linkCount <= Math.max(Math.floor(quality.wordCount * 0.12), 35)
    ) {
      return true;
    }

    return !quality.isListLike && quality.wordCount >= 180 && quality.headingCount >= 1 && quality.linkDensity <= 0.12;
  }

  resolveQualityProfile(value?: CrawlQualityProfile): CrawlQualityProfile {
    return value ?? "quality_first";
  }

  assessArticleMarkdownSignal(
    article: Crawl4aiArticle,
    preferFitMarkdownForQuality = true
  ): CrawlArticleSignal {
    const markdownResult = this.resultService.extractMarkdownResult(article.markdown);
    const markdown = this.selectMarkdownForQuality(markdownResult, preferFitMarkdownForQuality);
    const publishTimeSignal = this.resolvePublishTimeSignal(article);
    if (!markdown) {
      return {
        wordCount: 0,
        paragraphCount: 0,
        headingCount: 0,
        linkCount: 0,
        linkDensity: 0,
        bulletLines: 0,
        publishTimeConfidence: publishTimeSignal.confidence,
        publishTimeSource: publishTimeSignal.source,
        mediaDensity: 0,
        domListRisk: 0,
        score: Number.NEGATIVE_INFINITY,
        isListLike: false
      };
    }

    const { scoreWordCount, densityWordCount } = this.estimateMarkdownWordUnits(markdown);
    const wordCount = densityWordCount;
    const paragraphCount = markdown
      .split(/\n\s*\n/g)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0).length;
    const headingCount = (markdown.match(/^#{1,6}\s+/gm) ?? []).length;
    const markdownLinkCount = (markdown.match(/\]\((https?:\/\/|\/)/g) ?? []).length;
    const rawUrlCount = (markdown.match(/https?:\/\/\S+/g) ?? []).length;
    const linkCount = markdownLinkCount + rawUrlCount;
    const bulletLines = markdown
      .split(/\n/g)
      .map((entry) => entry.trim())
      .filter((entry) => entry.startsWith("- ") || entry.startsWith("* ") || entry.startsWith("• ")).length;
    const linkDensity = wordCount > 0 ? linkCount / wordCount : linkCount;
    const mediaDensity = this.estimateMediaDensity(article, wordCount);
    const domListRisk = this.estimateDomListRisk(article, {
      paragraphCount,
      linkCount,
      linkDensity,
      bulletLines
    });

    const listLikeSignals =
      (linkCount >= 16 && wordCount <= 1500) ||
      (bulletLines >= 10 && linkCount >= 10) ||
      (linkDensity >= 0.09 && wordCount <= 1200) ||
      domListRisk >= 0.72;
    const hasArticleLikeBody = paragraphCount >= 8 && wordCount >= 260 && linkDensity <= 0.22;
    const isShortHighValueBulletin =
      wordCount >= 60 &&
      paragraphCount >= 2 &&
      publishTimeSignal.confidence >= 0.75 &&
      linkDensity <= 0.16;
    const hasMixedMediaBody =
      mediaDensity >= 0.012 &&
      paragraphCount >= 4 &&
      wordCount >= 90 &&
      linkDensity <= 0.2;
    const isListLike = listLikeSignals && !hasArticleLikeBody && !isShortHighValueBulletin && !hasMixedMediaBody;
    const boilerplateRatio = this.estimateBoilerplateRatio(markdown);

    const score =
      Math.min(scoreWordCount, 12_000) +
      Math.min(paragraphCount, 220) * 6 +
      headingCount * 3 -
      linkCount * 6 -
      bulletLines * 2 -
      Math.round(boilerplateRatio * 320) +
      Math.round(Math.min(mediaDensity * 2200, 90)) +
      Math.round(publishTimeSignal.confidence * 140) -
      Math.round(domListRisk * 80);

    return {
      wordCount,
      paragraphCount,
      headingCount,
      linkCount,
      linkDensity,
      bulletLines,
      publishTimeConfidence: publishTimeSignal.confidence,
      publishTimeSource: publishTimeSignal.source,
      mediaDensity,
      domListRisk,
      score,
      isListLike
    };
  }

  countArticleLinkInventory(article: Crawl4aiArticle): number {
    if (!article.links || typeof article.links !== "object" || Array.isArray(article.links)) {
      return 0;
    }

    const collections = Object.values(article.links as Record<string, unknown>);
    let total = 0;
    for (const collection of collections) {
      if (Array.isArray(collection)) {
        total += collection.length;
      }
    }
    return total;
  }

  private selectMarkdownForQuality(
    markdownResult: ReturnType<CrawlResultService["extractMarkdownResult"]>,
    preferFitMarkdownForQuality: boolean
  ): string {
    if (preferFitMarkdownForQuality && typeof markdownResult.fit === "string" && markdownResult.fit.trim().length > 0) {
      return markdownResult.fit.trim();
    }
    if (typeof markdownResult.primary === "string" && markdownResult.primary.trim().length > 0) {
      return markdownResult.primary.trim();
    }
    if (typeof markdownResult.raw === "string" && markdownResult.raw.trim().length > 0) {
      return markdownResult.raw.trim();
    }
    if (typeof markdownResult.citations === "string" && markdownResult.citations.trim().length > 0) {
      return markdownResult.citations.trim();
    }
    if (typeof markdownResult.references === "string" && markdownResult.references.trim().length > 0) {
      return markdownResult.references.trim();
    }
    return "";
  }

  private resolvePublishTimeSignal(article: Crawl4aiArticle): {
    confidence: number;
    source: CrawlPublishTimeSource;
  } {
    const fromArticle = this.parseDateValue(article.publishedAt);
    if (fromArticle) {
      return {
        confidence: this.normalizePublishTimeConfidence(fromArticle, 0.92),
        source: "meta"
      };
    }

    const metadata = article.metadata;
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
      const metaRecord = metadata as Record<string, unknown>;
      const directMetaTimestamp = this.resolvePublishTimeFromMetaRecord(metaRecord);
      if (directMetaTimestamp) {
        return {
          confidence: this.normalizePublishTimeConfidence(directMetaTimestamp, 0.86),
          source: "meta"
        };
      }

      const timeTagTimestamp = this.parseDateValue(metaRecord.datetime) ?? this.parseDateValue(metaRecord.time);
      if (timeTagTimestamp) {
        return {
          confidence: this.normalizePublishTimeConfidence(timeTagTimestamp, 0.82),
          source: "time_tag"
        };
      }

      const jsonLdTimestamp = this.findJsonLdPublishDate(metaRecord);
      if (jsonLdTimestamp) {
        return {
          confidence: this.normalizePublishTimeConfidence(jsonLdTimestamp, 0.9),
          source: "jsonld"
        };
      }
    }

    const fromUrl = this.parseDateFromArticleUrl(article.url);
    if (fromUrl) {
      return {
        confidence: this.normalizePublishTimeConfidence(fromUrl, 0.62),
        source: "url_path"
      };
    }
    return {
      confidence: 0,
      source: "none"
    };
  }

  private resolvePublishTimeFromMetaRecord(record: Record<string, unknown>): number | undefined {
    const directMetaValues = [
      record["article:published_time"],
      record["og:published_time"],
      record.publishdate,
      record.publishDate,
      record.pubdate,
      record.date,
      record.datePublished
    ];
    for (const value of directMetaValues) {
      const ts = this.parseDateValue(value);
      if (ts) {
        return ts;
      }
    }

    for (const key of ["meta", "metadata", "openGraph", "open_graph"]) {
      const nested = record[key];
      if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
        continue;
      }
      const nestedTs = this.resolvePublishTimeFromMetaRecord(nested as Record<string, unknown>);
      if (nestedTs) {
        return nestedTs;
      }
    }
    return undefined;
  }

  private findJsonLdPublishDate(value: unknown): number | undefined {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const nested = this.findJsonLdPublishDate(entry);
        if (nested) {
          return nested;
        }
      }
      return undefined;
    }
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    for (const key of ["jsonld", "jsonLd", "structuredData", "ldJson"]) {
      const nested = record[key];
      if (nested) {
        const candidate = this.findJsonLdPublishDate(nested);
        if (candidate) {
          return candidate;
        }
      }
    }

    const directDate =
      this.parseDateValue(record.datePublished) ??
      this.parseDateValue(record.dateCreated) ??
      this.parseDateValue(record.dateModified);
    if (directDate) {
      return directDate;
    }
    for (const nested of Object.values(record)) {
      const found = this.findJsonLdPublishDate(nested);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  private parseDateValue(value: unknown): number | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const ts = Date.parse(trimmed);
    if (!Number.isFinite(ts) || ts <= 0) {
      return undefined;
    }
    return ts;
  }

  private parseDateFromArticleUrl(url?: string): number | undefined {
    if (!url || typeof url !== "string") {
      return undefined;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    const path = parsed.pathname.toLowerCase();
    const toUtcTimestamp = (year: number, month: number, day: number) => {
      if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
        return undefined;
      }
      if (month < 1 || month > 12 || day < 1 || day > 31) {
        return undefined;
      }
      const ts = Date.UTC(year, month - 1, day);
      if (!Number.isFinite(ts) || ts <= 0) {
        return undefined;
      }
      const check = new Date(ts);
      if (
        check.getUTCFullYear() !== year ||
        check.getUTCMonth() !== month - 1 ||
        check.getUTCDate() !== day
      ) {
        return undefined;
      }
      return ts;
    };
    const slashDate = /\/(20\d{2})\/([01]\d)\/([0-3]\d)(?:\/|$)/.exec(path);
    if (slashDate) {
      const ts = toUtcTimestamp(Number(slashDate[1]), Number(slashDate[2]), Number(slashDate[3]));
      if (ts) {
        return ts;
      }
    }
    const dashedDate = /(20\d{2})[-_/.]([01]\d)[-_/.]([0-3]\d)/.exec(path);
    if (dashedDate) {
      return toUtcTimestamp(Number(dashedDate[1]), Number(dashedDate[2]), Number(dashedDate[3]));
    }
    return undefined;
  }

  private normalizePublishTimeConfidence(timestamp: number, base: number): number {
    const now = Date.now();
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      return 0;
    }
    const year2000 = Date.UTC(2000, 0, 1);
    const maxFuture = now + 2 * 24 * 60 * 60 * 1000;
    if (timestamp < year2000 || timestamp > maxFuture) {
      return Math.max(0, Math.min(1, Number((base * 0.35).toFixed(3))));
    }
    const ageDays = Math.abs(now - timestamp) / (24 * 60 * 60 * 1000);
    const freshnessBoost = ageDays <= 10 ? 0.08 : ageDays <= 45 ? 0.03 : 0;
    return Math.max(0, Math.min(1, Number((base + freshnessBoost).toFixed(3))));
  }

  private estimateMediaDensity(article: Crawl4aiArticle, wordCount: number): number {
    const imageCount = this.countArticleImageInventory(article);
    if (imageCount <= 0) {
      return 0;
    }
    const density = imageCount / Math.max(wordCount, 1);
    return Number(Math.max(0, Math.min(1, density)).toFixed(4));
  }

  private countArticleImageInventory(article: Crawl4aiArticle): number {
    if (!article.media || typeof article.media !== "object" || Array.isArray(article.media)) {
      return 0;
    }
    let total = 0;
    for (const [key, value] of Object.entries(article.media)) {
      if (!Array.isArray(value) || value.length === 0) {
        continue;
      }
      const normalizedKey = key.trim().toLowerCase();
      if (normalizedKey.includes("image") || normalizedKey === "img" || normalizedKey === "images") {
        total += value.length;
      } else if (normalizedKey.includes("photo")) {
        total += value.length;
      } else {
        total += Math.min(2, value.length);
      }
    }
    return total;
  }

  private estimateDomListRisk(
    article: Crawl4aiArticle,
    metrics: {
      paragraphCount: number;
      linkCount: number;
      linkDensity: number;
      bulletLines: number;
    }
  ): number {
    let risk = 0;
    const linkInventory = this.countArticleLinkInventory(article);
    if (linkInventory >= 60) {
      risk += 0.5;
    } else if (linkInventory >= 40) {
      risk += 0.35;
    } else if (linkInventory >= 24) {
      risk += 0.2;
    }
    if (metrics.linkDensity >= 0.14) {
      risk += 0.35;
    } else if (metrics.linkDensity >= 0.09) {
      risk += 0.2;
    }
    if (metrics.bulletLines >= 12) {
      risk += 0.25;
    } else if (metrics.bulletLines >= 8) {
      risk += 0.12;
    }
    if (metrics.paragraphCount <= 2 && metrics.linkCount >= 10) {
      risk += 0.2;
    }
    if (this.hasListPathTokens(article.url)) {
      risk += 0.25;
    }
    return Number(Math.max(0, Math.min(1, risk)).toFixed(3));
  }

  private hasListPathTokens(url?: string): boolean {
    if (!url) {
      return false;
    }
    try {
      const parsed = new URL(url);
      const value = parsed.pathname.toLowerCase();
      return /\/(latest|archive|tag|tags|topic|topics|category|categories|section|sections|author|authors)(\/|$)/.test(
        value
      );
    } catch {
      return false;
    }
  }

  private classifyPageKind(
    assessments: CrawlLowSignalAssessment[],
    lowSignal: CrawlLowSignalAssessment[],
    hint: CrawlPageTypeHint
  ): CrawlPageKind {
    if (assessments.length === 0) {
      return "blocked";
    }

    if (hint === "detail") {
      return "detail";
    }
    if (hint === "list") {
      return "list";
    }

    const lowSignalRatio = lowSignal.length / assessments.length;
    if (lowSignalRatio >= 0.75) {
      return "list";
    }
    if (lowSignalRatio >= 0.35) {
      return "mixed";
    }
    return "detail";
  }

  private isLowSignal(quality: CrawlArticleSignal, linkInventory: number): boolean {
    const likelyHighValueBulletin =
      quality.publishTimeConfidence >= 0.75 &&
      quality.wordCount >= 60 &&
      quality.paragraphCount >= 2 &&
      quality.linkDensity <= 0.16;
    if (likelyHighValueBulletin) {
      return false;
    }

    const likelyMixedMediaDetail =
      quality.mediaDensity >= 0.012 &&
      quality.wordCount >= 90 &&
      quality.paragraphCount >= 4 &&
      quality.linkDensity <= 0.2;
    if (likelyMixedMediaDetail) {
      return false;
    }

    if (quality.isListLike) {
      return true;
    }
    if (quality.domListRisk >= 0.78 && quality.wordCount <= 1800) {
      return true;
    }
    if (quality.linkDensity >= 0.14 && quality.wordCount <= 1600) {
      return true;
    }
    if (quality.linkCount >= 12 && quality.wordCount <= 520) {
      return true;
    }
    if (linkInventory >= 40 && quality.wordCount <= 900) {
      return true;
    }
    return false;
  }

  private estimateMarkdownWordUnits(markdown: string): { scoreWordCount: number; densityWordCount: number } {
    const whitespaceWords = markdown.split(/\s+/).filter((entry) => entry.length > 0).length;
    const cjkChars = markdown.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu);
    const cjkCount = cjkChars ? cjkChars.length : 0;

    return {
      scoreWordCount: whitespaceWords + Math.round(cjkCount / 2),
      densityWordCount: whitespaceWords + Math.round(cjkCount / 6)
    };
  }

  private estimateBoilerplateRatio(markdown: string): number {
    if (markdown.length === 0) {
      return 0;
    }

    const lines = markdown
      .split(/\n/g)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) {
      return 0;
    }

    const boilerplateLines = lines.filter((line) =>
      /subscribe|newsletter|sign up|privacy policy|terms|cookie|follow us|advertisement/i.test(line)
    ).length;
    return Math.min(1, boilerplateLines / lines.length);
  }

  private normalizePatternList(patterns?: string[]): string[] | undefined {
    if (!patterns || patterns.length === 0) {
      return undefined;
    }
    const unique: string[] = [];
    for (const raw of patterns) {
      const normalized = typeof raw === "string" ? raw.trim() : "";
      if (!normalized || unique.includes(normalized)) {
        continue;
      }
      unique.push(normalized);
      if (unique.length >= 25) {
        break;
      }
    }
    return unique.length > 0 ? unique : undefined;
  }
}
