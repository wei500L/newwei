import { Injectable } from "@nestjs/common";

import type {
  CrawlDetailExpansionOptions,
  CrawlPageTypeHint,
  CrawlQualityProfile,
  CrawlTaskOptions
} from "./crawl.types";
import type { Crawl4aiArticle } from "./crawl4ai.client";
import { CrawlResultService } from "./crawl-result.service";

export type CrawlPageKind = "detail" | "list" | "mixed" | "blocked";

export interface CrawlArticleSignal {
  wordCount: number;
  paragraphCount: number;
  headingCount: number;
  linkCount: number;
  linkDensity: number;
  bulletLines: number;
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
  allowExternalLinks: true
};

@Injectable()
export class CrawlQualityStrategyService {
  constructor(private readonly resultService: CrawlResultService) {}

  assessPageSignals(successes: Crawl4aiArticle[], hint: CrawlPageTypeHint = "auto"): CrawlPageAssessment {
    const assessments = successes.map((article, index) => {
      const quality = this.assessArticleMarkdownSignal(article);
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

    return {
      maxDetailUrls,
      minRelevanceScore,
      requireSameDomain,
      allowExternalLinks
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

  assessArticleMarkdownSignal(article: Crawl4aiArticle): CrawlArticleSignal {
    const markdownResult = this.resultService.extractMarkdownResult(article.markdown);
    const markdown = typeof markdownResult.primary === "string" ? markdownResult.primary.trim() : "";
    if (!markdown) {
      return {
        wordCount: 0,
        paragraphCount: 0,
        headingCount: 0,
        linkCount: 0,
        linkDensity: 0,
        bulletLines: 0,
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

    const listLikeSignals =
      (linkCount >= 16 && wordCount <= 1500) ||
      (bulletLines >= 10 && linkCount >= 10) ||
      (linkDensity >= 0.09 && wordCount <= 1200);
    const hasArticleLikeBody = paragraphCount >= 8 && wordCount >= 260 && linkDensity <= 0.22;
    const isListLike = listLikeSignals && !hasArticleLikeBody;
    const boilerplateRatio = this.estimateBoilerplateRatio(markdown);

    const score =
      Math.min(scoreWordCount, 12_000) +
      Math.min(paragraphCount, 220) * 6 +
      headingCount * 3 -
      linkCount * 6 -
      bulletLines * 2 -
      Math.round(boilerplateRatio * 320);

    return {
      wordCount,
      paragraphCount,
      headingCount,
      linkCount,
      linkDensity,
      bulletLines,
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
    if (quality.isListLike) {
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
}
