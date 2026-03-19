import type {
  CrawlFrontierPageType,
  CrawlFreshnessRules,
  CrawlHostScope,
  CrawlLlmAssistAutoPublishThresholds,
  CrawlLlmAssistConfig,
  CrawlLlmAssistRecallMode,
  CrawlLlmAssistShadowConfig,
  CrawlLlmAssistShadowRole,
  CrawlLlmAssistShadowState,
  CrawlLocaleScopeConfig,
  CrawlSeedDiscoveryConfig,
  CrawlSeedDiscoveryMode,
  CrawlSeedQualityThresholds,
  CrawlSeedStrategy,
  CrawlPageTypeSignalConfig,
  CrawlPriorityClass,
  CrawlSiteProfileConfig,
  CrawlSourceTier,
} from "./crawl.types";
import { assertNoCrawl4aiLlmOptions } from "./crawl4ai-llm.guard";

const ARTICLE_SIGNAL_PATTERN =
  /\/(20\d{2}\/\d{1,2}\/\d{1,2}\/|article\/|articles\/|story\/|stories\/|content\/)/i;
const DATED_ARTICLE_SLUG_PATTERN =
  /(?:^|\/)[^/?#]+-\d{4}-\d{1,2}-\d{1,2}\/?$/i;
const LIST_SIGNAL_PATTERN =
  /(?:[?&](?:page|p)=\d+\b|\/page\/\d+(?:\/|$)|\/(?:latest|archive|archives|index)(?:\/|$))/i;
const CATEGORY_SIGNAL_PATTERN =
  /\/(?:section|sections|category|categories|channel|channels|desk|desks|vertical|verticals)(?:\/|$)/i;
const NON_ARTICLE_SIGNAL_PATTERN =
  /\/(?:section|sections|topic|topics|tag|tags|author|authors|profile|profiles|series|search|newsletter|newsletters|gallery|galleries|video|videos|podcast|podcasts)(?:\/|$)/i;
const UTILITY_PATH_PATTERN =
  /\/(?:about|contact|contacts|donate|support|help|jobs|careers|advertis(?:e|ing)|press|privacy|terms|sitemap|site-map|account|login|log-in|signin|sign-in|register|signup|sign-up|subscribe|subscription|membership|shop|store|apps?|network|community-guidelines|code-of-ethics|ethics|schedule|schedules|today-in-history|photography|photo-gallery|photo-essays|video|videos|podcast|podcasts|newsletter|newsletters|gallery|galleries|rss|xml|sponsored|stay-connected|regulatory|eu-eea-regulatory|accessibility(?:-statement)?|insidetheguardian|profile|profiles|author|authors|contributors?|bios?|editorial|tabs-[a-z0-9-]+)(?:\/|$)/i;
const UTILITY_LINK_TEXT_PATTERN =
  /\b(?:about(?: us)?|contact(?: us)?|donate|support|help(?: center)?|jobs|careers|advertis(?:e|ing)|press|privacy|terms|site map|account|log(?:\s|-)?in|sign(?:\s|-)?in|register|sign(?:\s|-)?up|subscribe|subscription|membership|shop|store|download app|our network|community guidelines|code of ethics|schedule|today in history|photo gallery|photo essay|photography|video|podcasts?|newsletters?|rss|sponsored|stay connected|regulatory|accessibility|inside the guardian|editorial profile|author profile|our writers)\b/i;
const COMPOUND_PUBLIC_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "gov.uk",
  "ac.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "com.br",
  "com.mx",
  "com.tr",
  "com.cn",
  "com.hk",
  "com.tw",
  "com.sg",
  "co.jp",
  "co.kr",
  "co.in",
  "co.id",
  "co.il",
  "com.ar",
  "com.sa",
  "com.ng",
]);
const PAGE_TYPE_BUDGET_PRIORITY: CrawlFrontierPageType[] = [
  "article",
  "category",
  "article",
  "list",
];
const PAGE_TYPE_DISCOVERY_PRIORITY: Record<
  CrawlFrontierPageType,
  CrawlFrontierPageType[]
> = {
  home: ["category", "list", "article", "home"],
  category: ["list", "article", "category", "home"],
  list: ["article", "list", "category", "home"],
  article: ["article", "list", "category", "home"],
};
const DEFAULT_PRIORITY_KEYWORDS = [
  "breaking",
  "live",
  "update",
  "updates",
  "latest",
  "exclusive",
  "war",
  "conflict",
  "sanctions",
  "strike",
  "election",
  "markets",
  "security",
];
const DEFAULT_DENY_KEYWORDS = [
  "about",
  "contact",
  "privacy",
  "terms",
  "site map",
  "newsletter",
  "podcast",
  "video",
  "gallery",
  "sponsored",
  "community guidelines",
  "code of ethics",
  "download app",
  "rss",
];
const DEFAULT_LLM_ASSIST_BUDGETS: Partial<
  Record<CrawlFrontierPageType, number>
> = {
  home: 24,
  category: 24,
  list: 16,
  article: 0,
};
const DEFAULT_LLM_ASSIST_AUTO_PUBLISH: CrawlLlmAssistAutoPublishThresholds = {
  minArticleLift: 0.15,
  minNoiseReduction: 0.2,
  minJudgeConfidence: 0.75,
};
const LOCALE_ALIAS_LANGUAGE_MAP: Record<string, string> = {
  zhongwen: "zh",
  chinese: "zh",
  espanol: "es",
  espana: "es",
  spanish: "es",
  mundo: "es",
  francais: "fr",
  french: "fr",
  deutsch: "de",
  german: "de",
  portuguese: "pt",
  portugues: "pt",
  brasil: "pt",
  arabic: "ar",
  russian: "ru",
  hindi: "hi",
  japanese: "ja",
  korean: "ko",
  turkiye: "tr",
  turkce: "tr",
  indonesia: "id",
  vietnam: "vi",
};

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
}

function normalizeDomain(value: string): string {
  return normalizeHostname(value).replace(/^www\./, "");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapeRegex(value: string) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function wildcardToRegex(pattern: string) {
  const normalized = pattern.trim();
  const body = escapeRegex(normalized).replace(/\*/g, ".*");
  return new RegExp(`^${body}$`, "i");
}

function toStringList(value: unknown, max = 100): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  if (normalized.length === 0) {
    return undefined;
  }
  return Array.from(new Set(normalized)).slice(0, max);
}

function toObjectRecord(
  value: unknown,
): Record<string, Record<string, unknown>> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const normalized: Record<string, Record<string, unknown>> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isPlainObject(entry)) {
      normalized[key] = entry;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function toKeywordList(value: unknown, fallback?: string[]) {
  return toStringList(value, 100) ?? (fallback ? [...fallback] : undefined);
}

function toHostScope(value: unknown): CrawlHostScope | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "registrable_domain" ||
    normalized === "strict_hosts"
  ) {
    return normalized;
  }
  return undefined;
}

function toSourceTier(value: unknown): CrawlSourceTier | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "tier1" || normalized === "tier2" || normalized === "tier3") {
    return normalized;
  }
  return undefined;
}

function toSeedStrategy(value: unknown): CrawlSeedStrategy | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "auto" ||
    normalized === "seed_first" ||
    normalized === "frontier_first" ||
    normalized === "frontier_only"
  ) {
    return normalized;
  }
  return undefined;
}

function toSeedDiscoveryMode(value: unknown): CrawlSeedDiscoveryMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "robots" ||
    normalized === "common_paths" ||
    normalized === "sitemap_only" ||
    normalized === "disabled"
  ) {
    return normalized;
  }
  return undefined;
}

function toLocale(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized.slice(0, 16) : undefined;
}

function toTrimmedString(value: unknown, max = 191): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized.slice(0, max) : undefined;
}

function toRecallMode(value: unknown): CrawlLlmAssistRecallMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "high_recall" ||
    normalized === "balanced" ||
    normalized === "low_cost"
  ) {
    return normalized;
  }
  return undefined;
}

function toShadowRole(value: unknown): CrawlLlmAssistShadowRole | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "active" || normalized === "shadow") {
    return normalized;
  }
  return undefined;
}

function toShadowState(value: unknown): CrawlLlmAssistShadowState | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "candidate" ||
    normalized === "evaluating" ||
    normalized === "published"
  ) {
    return normalized;
  }
  return undefined;
}

function toPageTypeSignalConfig(
  value: unknown,
): CrawlPageTypeSignalConfig | undefined {
  if (Array.isArray(value)) {
    const patterns = toStringList(value, 100);
    return patterns ? { patterns } : undefined;
  }
  if (!isPlainObject(value)) {
    return undefined;
  }
  const patterns = toStringList(value.patterns, 100);
  const keywords = toStringList(value.keywords, 100);
  if (!patterns && !keywords) {
    return undefined;
  }
  return {
    patterns,
    keywords,
  };
}

function toFreshnessRules(value: unknown): CrawlFreshnessRules | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const recentHours = toPositiveInt(value.recentHours, 1, 24 * 30, 24);
  const weekHours = toPositiveInt(value.weekHours, recentHours, 24 * 60, 24 * 7);
  const monthHours = toPositiveInt(value.monthHours, weekHours, 24 * 365, 24 * 30);
  return {
    recentHours,
    weekHours,
    monthHours,
  };
}

function toSeedQualityThresholds(
  value: unknown,
): CrawlSeedQualityThresholds | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  return {
    minCandidates: toPositiveInt(value.minCandidates, 1, 200, 3),
    minArticleRatio: toScore(value.minArticleRatio, 0.4),
    maxNoiseRatio: toScore(value.maxNoiseRatio, 0.45),
    minFreshRatio: toScore(value.minFreshRatio, 0.2),
  };
}

function toLocaleScope(value: unknown): CrawlLocaleScopeConfig | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const locale = toLocale(value.locale);
  const acceptLanguages = toStringList(value.acceptLanguages, 16);
  const denyUrlPatterns = toStringList(value.denyUrlPatterns, 100);
  const denyHostPatterns = toStringList(value.denyHostPatterns, 50);
  if (!locale && !acceptLanguages && !denyUrlPatterns && !denyHostPatterns) {
    return undefined;
  }
  return {
    locale,
    acceptLanguages,
    denyUrlPatterns,
    denyHostPatterns,
  };
}

function toSeedDiscovery(value: unknown): CrawlSeedDiscoveryConfig | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const strategy = toSeedStrategy(value.strategy) ?? "auto";
  const mode = toSeedDiscoveryMode(value.mode) ?? "robots";
  const freshnessWindowHours =
    value.freshnessWindowHours !== undefined
      ? toPositiveInt(value.freshnessWindowHours, 1, 24 * 365, 24 * 7)
      : undefined;
  const maxSeedUrls =
    value.maxSeedUrls !== undefined
      ? toPositiveInt(value.maxSeedUrls, 1, 500, 80)
      : undefined;
  const topologyBudgetPages =
    value.topologyBudgetPages !== undefined
      ? toPositiveInt(value.topologyBudgetPages, 1, 100, 12)
      : undefined;
  const topologyBudgetDepth =
    value.topologyBudgetDepth !== undefined
      ? toPositiveInt(value.topologyBudgetDepth, 1, 8, 2)
      : undefined;
  const qualityThresholds = toSeedQualityThresholds(value.qualityThresholds);
  const hasExplicitFields =
    value.strategy !== undefined ||
    value.mode !== undefined ||
    value.freshnessWindowHours !== undefined ||
    value.maxSeedUrls !== undefined ||
    value.topologyBudgetPages !== undefined ||
    value.topologyBudgetDepth !== undefined ||
    value.qualityThresholds !== undefined;
  if (!hasExplicitFields) {
    return undefined;
  }
  return {
    strategy,
    mode,
    freshnessWindowHours,
    maxSeedUrls,
    topologyBudgetPages,
    topologyBudgetDepth,
    qualityThresholds,
  };
}

function toLlmAssistAutoPublishThresholds(
  value: unknown,
): CrawlLlmAssistAutoPublishThresholds | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  return {
    minArticleLift: toScore(value.minArticleLift, 0.15),
    minNoiseReduction: toScore(value.minNoiseReduction, 0.2),
    minJudgeConfidence: toScore(value.minJudgeConfidence, 0.75),
  };
}

function toLlmAssistShadowConfig(
  value: unknown,
): CrawlLlmAssistShadowConfig | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const role = toShadowRole(value.role);
  const shadowOfProfileId = toTrimmedString(value.shadowOfProfileId);
  const originProfileVersion =
    value.originProfileVersion !== undefined
      ? toPositiveInt(value.originProfileVersion, 1, 10_000, 1)
      : undefined;
  const state = toShadowState(value.state);
  const evaluationRunsCompleted =
    value.evaluationRunsCompleted !== undefined
      ? toPositiveInt(value.evaluationRunsCompleted, 0, 10_000, 0)
      : undefined;
  const consecutivePasses =
    value.consecutivePasses !== undefined
      ? toPositiveInt(value.consecutivePasses, 0, 10_000, 0)
      : undefined;
  const lastOriginRunId = toTrimmedString(value.lastOriginRunId);
  const lastShadowRunId = toTrimmedString(value.lastShadowRunId);
  const lastPublishedAt =
    value.lastPublishedAt === null
      ? null
      : toTrimmedString(value.lastPublishedAt, 64);
  const lastSuggestedAt =
    value.lastSuggestedAt === null
      ? null
      : toTrimmedString(value.lastSuggestedAt, 64);
  const lastSuggestionConfidence =
    typeof value.lastSuggestionConfidence === "number"
      ? toScore(value.lastSuggestionConfidence, 0.75)
      : undefined;
  const lastSuggestionReason =
    value.lastSuggestionReason === null
      ? null
      : toTrimmedString(value.lastSuggestionReason, 500);
  if (
    !role &&
    !shadowOfProfileId &&
    !state &&
    evaluationRunsCompleted === undefined &&
    consecutivePasses === undefined &&
    !lastOriginRunId &&
    !lastShadowRunId &&
    lastPublishedAt === undefined &&
    lastSuggestedAt === undefined &&
    lastSuggestionConfidence === undefined &&
    lastSuggestionReason === undefined
  ) {
    return undefined;
  }
  return {
    role,
    shadowOfProfileId,
    originProfileVersion,
    state,
    evaluationRunsCompleted,
    consecutivePasses,
    lastOriginRunId,
    lastShadowRunId,
    lastPublishedAt,
    lastSuggestedAt,
    lastSuggestionConfidence,
    lastSuggestionReason,
  };
}

function toLlmAssistConfig(value: unknown): CrawlLlmAssistConfig | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const candidateBudgetByPageType: Partial<
    Record<CrawlFrontierPageType, number>
  > = {};
  if (isPlainObject(value.candidateBudgetByPageType)) {
    for (const key of ["home", "category", "list", "article"] as const) {
      if (value.candidateBudgetByPageType[key] !== undefined) {
        candidateBudgetByPageType[key] = toPositiveInt(
          value.candidateBudgetByPageType[key],
          0,
          200,
          key === "article" ? 0 : 24,
        );
      }
    }
  }
  const autoPublishThresholds = toLlmAssistAutoPublishThresholds(
    value.autoPublishThresholds,
  );
  const shadow = toLlmAssistShadowConfig(value.shadow);
  const enabled =
    typeof value.enabled === "boolean" ? value.enabled : undefined;
  const recallMode = toRecallMode(value.recallMode);
  const judgeModel = toTrimmedString(value.judgeModel);
  const siteLearnerModel = toTrimmedString(value.siteLearnerModel);
  const minJudgeConfidence =
    value.minJudgeConfidence !== undefined
      ? toScore(value.minJudgeConfidence, 0.75)
      : undefined;
  const shadowEvaluationRuns =
    value.shadowEvaluationRuns !== undefined
      ? toPositiveInt(value.shadowEvaluationRuns, 1, 20, 3)
      : undefined;
  if (
    enabled === undefined &&
    !recallMode &&
    !judgeModel &&
    !siteLearnerModel &&
    Object.keys(candidateBudgetByPageType).length === 0 &&
    minJudgeConfidence === undefined &&
    shadowEvaluationRuns === undefined &&
    !autoPublishThresholds &&
    !shadow
  ) {
    return undefined;
  }
  return {
    enabled,
    recallMode,
    judgeModel,
    siteLearnerModel,
    candidateBudgetByPageType:
      Object.keys(candidateBudgetByPageType).length > 0
        ? candidateBudgetByPageType
        : undefined,
    minJudgeConfidence,
    shadowEvaluationRuns,
    autoPublishThresholds,
    shadow,
  };
}

function toPositiveInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function toScore(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, Number(parsed.toFixed(3))));
}

export function normalizeCrawlSiteProfileConfig(
  raw: unknown,
): CrawlSiteProfileConfig {
  const value = isPlainObject(raw) ? raw : {};
  assertNoCrawl4aiLlmOptions(value, "crawlSiteProfile.config");

  return {
    keywords: toKeywordList(value.keywords),
    priorityKeywords: toKeywordList(
      value.priorityKeywords,
      DEFAULT_PRIORITY_KEYWORDS,
    ),
    denyKeywords: toKeywordList(value.denyKeywords, DEFAULT_DENY_KEYWORDS),
    blockedDomains: toStringList(value.blockedDomains, 200),
    hostScope: toHostScope(value.hostScope),
    allowedHosts: toStringList(value.allowedHosts, 100),
    allowedDomains: toStringList(value.allowedDomains, 100),
    domLinkScopes: toStringList(value.domLinkScopes, 50),
    domLinkExcludeSelectors: toStringList(value.domLinkExcludeSelectors, 50),
    urlQueryParamAllowlist: toStringList(value.urlQueryParamAllowlist, 50),
    urlPatterns: (() => {
      if (!isPlainObject(value.urlPatterns)) {
        return undefined;
      }
      const patterns: Partial<
        Record<CrawlFrontierPageType | "exclude", string[]>
      > = {};
      for (const key of ["home", "category", "list", "article", "exclude"] as const) {
        const normalized = toStringList(value.urlPatterns[key], 100);
        if (normalized) {
          patterns[key] = normalized;
        }
      }
      return Object.keys(patterns).length > 0 ? patterns : undefined;
    })(),
    pageTypeSignals: (() => {
      if (!isPlainObject(value.pageTypeSignals)) {
        return undefined;
      }
      const signals: Partial<
        Record<CrawlFrontierPageType | "deny", CrawlPageTypeSignalConfig>
      > = {};
      for (const key of ["home", "category", "list", "article", "deny"] as const) {
        const signal = toPageTypeSignalConfig(value.pageTypeSignals[key]);
        if (signal) {
          signals[key] = signal;
        }
      }
      return Object.keys(signals).length > 0 ? signals : undefined;
    })(),
    freshnessRules: toFreshnessRules(value.freshnessRules),
    localeScope: toLocaleScope(value.localeScope),
    seedDiscovery: toSeedDiscovery(value.seedDiscovery),
    llmAssist: toLlmAssistConfig(value.llmAssist),
    sourceTier: toSourceTier(value.sourceTier),
    pageRules: (() => {
      const rules = toObjectRecord(value.pageRules);
      if (!rules) {
        return undefined;
      }
      const normalized: Partial<
        Record<CrawlFrontierPageType, Record<string, unknown>>
      > = {};
      for (const key of ["home", "category", "list", "article"] as const) {
        if (rules[key]) {
          assertNoCrawl4aiLlmOptions(
            rules[key],
            `crawlSiteProfile.config.pageRules.${key}`,
          );
          normalized[key] = rules[key];
        }
      }
      return Object.keys(normalized).length > 0 ? normalized : undefined;
    })(),
    layeredOptions: (() => {
      if (!isPlainObject(value.layeredOptions)) {
        return undefined;
      }
      return {
        maxDepth: toPositiveInt(value.layeredOptions.maxDepth, 1, 8, 3),
        maxPages: toPositiveInt(value.layeredOptions.maxPages, 1, 500, 60),
        maxChildrenPerNode: toPositiveInt(
          value.layeredOptions.maxChildrenPerNode,
          1,
          200,
          24,
        ),
        paginationKeepCount: toPositiveInt(
          value.layeredOptions.paginationKeepCount,
          1,
          10,
          3,
        ),
        scoreThreshold: toScore(value.layeredOptions.scoreThreshold, 0.35),
      };
    })(),
    nativeOptions: (() => {
      if (!isPlainObject(value.nativeOptions)) {
        return undefined;
      }
      return {
        deepCrawlStrategy: isPlainObject(value.nativeOptions.deepCrawlStrategy)
          ? (value.nativeOptions.deepCrawlStrategy as {
              type: string;
              params?: Record<string, unknown>;
            })
          : undefined,
        filterChain: isPlainObject(value.nativeOptions.filterChain)
          ? (value.nativeOptions.filterChain as {
              type: string;
              params?: Record<string, unknown>;
            })
          : undefined,
        urlScorer: isPlainObject(value.nativeOptions.urlScorer)
          ? (value.nativeOptions.urlScorer as {
              type: string;
              params?: Record<string, unknown>;
            })
          : undefined,
        adaptiveCrawling: isPlainObject(value.nativeOptions.adaptiveCrawling)
          ? (value.nativeOptions.adaptiveCrawling as {
              type: string;
              params?: Record<string, unknown>;
            })
          : undefined,
        stream:
          typeof value.nativeOptions.stream === "boolean"
            ? value.nativeOptions.stream
            : undefined,
        fallbackToLayered:
          typeof value.nativeOptions.fallbackToLayered === "boolean"
            ? value.nativeOptions.fallbackToLayered
            : undefined,
        minAcceptedResults: toPositiveInt(
          value.nativeOptions.minAcceptedResults,
          0,
          500,
          0,
        ),
        minArticleResults: toPositiveInt(
          value.nativeOptions.minArticleResults,
          0,
          500,
          0,
        ),
      };
    })(),
    crawlOptions: (() => {
      if (!isPlainObject(value.crawlOptions)) {
        return undefined;
      }
      assertNoCrawl4aiLlmOptions(value.crawlOptions, "crawlSiteProfile.config.crawlOptions");
      return value.crawlOptions;
    })(),
  };
}

export function resolveEffectiveLlmAssistConfig(
  config: CrawlSiteProfileConfig,
  purpose: "judge" | "learn" = "judge",
): CrawlLlmAssistConfig | undefined {
  const configured = config.llmAssist;
  if (configured?.enabled === false) {
    return undefined;
  }
  if (purpose === "learn" && (!configured || configured.enabled !== true)) {
    return undefined;
  }
  return {
    enabled: true,
    recallMode: configured?.recallMode ?? "high_recall",
    judgeModel: configured?.judgeModel,
    siteLearnerModel: configured?.siteLearnerModel,
    candidateBudgetByPageType:
      configured?.candidateBudgetByPageType ?? DEFAULT_LLM_ASSIST_BUDGETS,
    minJudgeConfidence: configured?.minJudgeConfidence ?? 0.72,
    shadowEvaluationRuns: configured?.shadowEvaluationRuns ?? 3,
    autoPublishThresholds:
      configured?.autoPublishThresholds ?? DEFAULT_LLM_ASSIST_AUTO_PUBLISH,
    shadow: configured?.shadow,
  };
}

export function matchHostPattern(pattern: string, host: string): boolean {
  const normalizedPattern = pattern.trim().toLowerCase();
  const normalizedHost = host.trim().toLowerCase();
  if (!normalizedPattern || !normalizedHost) {
    return false;
  }
  if (normalizedPattern === normalizedHost) {
    return true;
  }
  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(1);
    return normalizedHost.endsWith(suffix);
  }
  if (normalizedPattern.includes("*")) {
    return wildcardToRegex(normalizedPattern).test(normalizedHost);
  }
  return normalizedHost === normalizedPattern;
}

export function matchUrlPattern(pattern: string, url: string): boolean {
  const normalizedPattern = pattern.trim();
  if (!normalizedPattern) {
    return false;
  }
  return wildcardToRegex(normalizedPattern).test(url);
}

export function matchesAnyPattern(
  patterns: string[] | undefined,
  url: string,
): boolean {
  return Boolean(patterns?.some((pattern) => matchUrlPattern(pattern, url)));
}

function matchesSignalPattern(
  pattern: string,
  url: string,
  linkText?: string,
): boolean {
  const normalizedPattern = pattern.trim().toLowerCase();
  if (!normalizedPattern) {
    return false;
  }
  const normalizedUrl = url.toLowerCase();
  const normalizedText = linkText?.trim().toLowerCase() ?? "";
  if (
    normalizedPattern.includes("*") ||
    normalizedPattern.includes("://") ||
    normalizedPattern.startsWith("/")
  ) {
    return matchUrlPattern(pattern, url);
  }
  return (
    normalizedUrl.includes(normalizedPattern) ||
    normalizedText.includes(normalizedPattern)
  );
}

function matchesSignalConfig(
  signal: CrawlPageTypeSignalConfig | undefined,
  url: string,
  linkText?: string,
): boolean {
  return Boolean(
    signal?.patterns?.some((pattern) =>
      matchesSignalPattern(pattern, url, linkText),
    ) ||
      signal?.keywords?.some((keyword) =>
        matchesSignalPattern(keyword, url, linkText),
      ),
  );
}

function matchesConfiguredKeyword(
  keywords: string[] | undefined,
  url: string,
  linkText?: string,
): boolean {
  const normalizedUrl = url.toLowerCase();
  const normalizedText = linkText?.trim().toLowerCase() ?? "";
  return Boolean(
    keywords?.some((keyword) => {
      const normalizedKeyword = keyword.trim().toLowerCase();
      if (!normalizedKeyword) {
        return false;
      }
      return (
        normalizedUrl.includes(normalizedKeyword) ||
        normalizedText.includes(normalizedKeyword)
      );
    }),
  );
}

function resolveFrontierHostScope(config: CrawlSiteProfileConfig): CrawlHostScope {
  if (config.hostScope) {
    return config.hostScope;
  }
  return (config.allowedHosts?.length ?? 0) > 0 &&
    (config.allowedDomains?.length ?? 0) === 0
    ? "strict_hosts"
    : "registrable_domain";
}

function extractPathSegments(url: string): string[] {
  try {
    return new URL(url).pathname
      .split("/")
      .map((segment) => segment.trim().toLowerCase())
      .filter((segment) => segment.length > 0);
  } catch {
    return [];
  }
}

function normalizeLanguageCode(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return null;
  }
  const [base] = normalized.split(/[-_]/, 1);
  return base && /^[a-z]{2,3}$/.test(base) ? base : null;
}

function resolvePreferredLanguageCode(
  config: CrawlSiteProfileConfig,
): string | null {
  const localeLanguage = normalizeLanguageCode(config.localeScope?.locale);
  if (localeLanguage) {
    return localeLanguage;
  }
  for (const entry of config.localeScope?.acceptLanguages ?? []) {
    const language = normalizeLanguageCode(entry);
    if (language) {
      return language;
    }
  }
  return null;
}

function resolveForeignLocaleAlias(options: {
  url: string;
  preferredLanguage: string | null;
}): string | null {
  if (!options.preferredLanguage) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(options.url);
  } catch {
    return null;
  }
  const firstPathSegment =
    parsed.pathname
      .split("/")
      .map((segment) => segment.trim().toLowerCase())
      .find((segment) => segment.length > 0) ?? null;
  const hostLabels = parsed.hostname
    .split(".")
    .map((segment) => segment.trim().toLowerCase())
    .filter((segment) => segment.length > 0);
  const candidateAliases = new Set<string>();
  if (firstPathSegment) {
    candidateAliases.add(firstPathSegment);
  }
  if (hostLabels.length > 0) {
    candidateAliases.add(hostLabels[0]!);
  }
  for (const alias of candidateAliases) {
    const aliasedLanguage = LOCALE_ALIAS_LANGUAGE_MAP[alias];
    if (aliasedLanguage && aliasedLanguage !== options.preferredLanguage) {
      return aliasedLanguage;
    }
  }
  return null;
}

function inferNonArticleHubPageType(
  parentPageType: CrawlFrontierPageType,
): CrawlFrontierPageType {
  if (parentPageType === "home") {
    return "category";
  }
  if (parentPageType === "article") {
    return "article";
  }
  return "list";
}

export function inferFrontierPageType(options: {
  url: string;
  parentPageType: CrawlFrontierPageType;
  config: CrawlSiteProfileConfig;
  linkText?: string;
  publishedAtTs?: number | null;
}): CrawlFrontierPageType {
  const url = options.url;
  const patterns = options.config.urlPatterns;
  const signals = options.config.pageTypeSignals;
  const hasPublishedTimestamp =
    typeof options.publishedAtTs === "number" &&
    Number.isFinite(options.publishedAtTs);
  const matchesNonArticleSignal = NON_ARTICLE_SIGNAL_PATTERN.test(url);
  const matchesArticleHeuristic =
    !matchesNonArticleSignal &&
    (ARTICLE_SIGNAL_PATTERN.test(url) || DATED_ARTICLE_SLUG_PATTERN.test(url));
  if (matchesSignalConfig(signals?.article, url, options.linkText)) {
    return "article";
  }
  if (matchesSignalConfig(signals?.list, url, options.linkText)) {
    return "list";
  }
  if (matchesSignalConfig(signals?.home, url, options.linkText)) {
    return "home";
  }
  if (matchesAnyPattern(patterns?.article, url)) {
    return "article";
  }
  if (matchesAnyPattern(patterns?.list, url)) {
    return "list";
  }
  if (matchesAnyPattern(patterns?.home, url)) {
    return "home";
  }
  if (
    hasPublishedTimestamp &&
    !matchesNonArticleSignal &&
    !matchesAnyPattern(patterns?.exclude, url) &&
    !matchesSignalConfig(signals?.deny, url, options.linkText)
  ) {
    return "article";
  }
  if (matchesArticleHeuristic) {
    return "article";
  }
  if (matchesSignalConfig(signals?.category, url, options.linkText)) {
    return "category";
  }
  if (matchesAnyPattern(patterns?.category, url)) {
    return "category";
  }
  if (LIST_SIGNAL_PATTERN.test(url)) {
    return inferNonArticleHubPageType(options.parentPageType);
  }
  if (CATEGORY_SIGNAL_PATTERN.test(url) || matchesNonArticleSignal) {
    return inferNonArticleHubPageType(options.parentPageType);
  }
  if (options.parentPageType === "home") {
    return "category";
  }
  if (options.parentPageType === "category") {
    return "list";
  }
  if (options.parentPageType === "list") {
    return "list";
  }
  return "article";
}

export function computeFrontierPageTypeBudgets(options: {
  maxDepth: number;
  maxPages: number;
}): Record<CrawlFrontierPageType, number> {
  const budgets: Record<CrawlFrontierPageType, number> = {
    home: options.maxPages > 0 ? 1 : 0,
    category: 0,
    list: 0,
    article: 0,
  };
  const activePageTypes = (["category", "list", "article"] as const).filter(
    (pageType) =>
      (pageType === "category" && options.maxDepth >= 1) ||
      (pageType === "list" && options.maxDepth >= 2) ||
      (pageType === "article" && options.maxDepth >= 3),
  );
  let remaining = Math.max(0, options.maxPages - budgets.home);
  for (const pageType of activePageTypes) {
    if (remaining === 0) {
      return budgets;
    }
    budgets[pageType] += 1;
    remaining -= 1;
  }
  const priority = PAGE_TYPE_BUDGET_PRIORITY.filter((pageType) =>
    activePageTypes.includes(pageType as (typeof activePageTypes)[number]),
  );
  let cursor = 0;
  while (remaining > 0 && priority.length > 0) {
    const pageType = priority[cursor % priority.length]!;
    budgets[pageType] += 1;
    remaining -= 1;
    cursor += 1;
  }
  return budgets;
}

export function scoreFrontierCandidate(options: {
  url: string;
  pageType: CrawlFrontierPageType;
  parentPageType?: CrawlFrontierPageType;
  parentUrl?: string;
  config: CrawlSiteProfileConfig;
  rawScore?: number;
  linkText?: string;
  freshnessScore?: number;
}): number {
  let score = typeof options.rawScore === "number" ? options.rawScore : 0;
  if (options.pageType === "article") {
    score += 0.35;
  } else if (options.pageType === "list") {
    score += 0.2;
  } else if (options.pageType === "category") {
    score += 0.1;
  }
  if (options.parentPageType === "home") {
    if (options.pageType === "category") {
      score += 0.6;
    } else if (options.pageType === "list") {
      score += 0.35;
    } else if (options.pageType === "article") {
      score -= 0.25;
    }
  } else if (options.parentPageType === "category") {
    if (options.pageType === "list") {
      score += 0.35;
    } else if (options.pageType === "category") {
      score -= 0.1;
    }
  } else if (options.parentPageType === "list") {
    if (options.pageType === "article") {
      score += 0.35;
    } else if (options.pageType === "list") {
      score -= 0.05;
    } else if (options.pageType === "category") {
      score -= 0.15;
    }
  }
  if (matchesAnyPattern(options.config.urlPatterns?.exclude, options.url)) {
    score -= 1;
  }
  const matchesConfiguredScope =
    matchesSignalConfig(
      options.config.pageTypeSignals?.[options.pageType],
      options.url,
      options.linkText,
    ) ||
    matchesAnyPattern(options.config.urlPatterns?.[options.pageType], options.url) ||
    matchesAnyPattern(options.config.urlPatterns?.home, options.url) ||
    matchesAnyPattern(options.config.urlPatterns?.category, options.url) ||
    matchesAnyPattern(options.config.urlPatterns?.list, options.url) ||
    matchesAnyPattern(options.config.urlPatterns?.article, options.url);
  if (matchesConfiguredScope) {
    score += 0.8;
  }
  const parentPathSegments = extractPathSegments(options.parentUrl ?? "");
  const childPathSegments = extractPathSegments(options.url);
  const parentScopeAnchor = parentPathSegments[0];
  if (parentScopeAnchor && childPathSegments.length > 0) {
    if (childPathSegments.includes(parentScopeAnchor)) {
      score += 0.6;
    } else {
      score -= matchesConfiguredScope ? 0.25 : 1.5;
    }
  }
  const text = options.linkText?.trim().toLowerCase() ?? "";
  for (const keyword of options.config.keywords ?? []) {
    if (text.includes(keyword.toLowerCase()) || options.url.toLowerCase().includes(keyword.toLowerCase())) {
      score += 0.05;
    }
  }
  if (
    matchesConfiguredKeyword(
      options.config.priorityKeywords,
      options.url,
      options.linkText,
    )
  ) {
    score += 0.1;
  }
  if (
    matchesConfiguredKeyword(
      options.config.denyKeywords,
      options.url,
      options.linkText,
    )
  ) {
    score -= 0.35;
  }
  if ((options.freshnessScore ?? 0) >= 0.99) {
    score += 0.35;
  } else if ((options.freshnessScore ?? 0) >= 0.74) {
    score += 0.2;
  } else if ((options.freshnessScore ?? 0) >= 0.39) {
    score += 0.05;
  }
  return Number(score.toFixed(4));
}

export function prioritizeFrontierCandidates<
  T extends {
    url: string;
    pageType: CrawlFrontierPageType;
    score: number;
    freshnessScore: number;
  },
>(options: {
  parentPageType: CrawlFrontierPageType;
  candidates: T[];
}): T[] {
  const priority =
    PAGE_TYPE_DISCOVERY_PRIORITY[options.parentPageType] ??
    PAGE_TYPE_DISCOVERY_PRIORITY.article;
  const rankByPageType = new Map(
    priority.map((pageType, index) => [pageType, index] as const),
  );
  return [...options.candidates].sort(
    (left, right) =>
      (rankByPageType.get(left.pageType) ?? priority.length) -
        (rankByPageType.get(right.pageType) ?? priority.length) ||
      right.score - left.score ||
      right.freshnessScore - left.freshnessScore ||
      left.url.localeCompare(right.url),
  );
}

export function isUtilityFrontierUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return UTILITY_PATH_PATTERN.test(parsed.pathname.toLowerCase());
  } catch {
    return false;
  }
}

export function isUtilityFrontierLinkText(value: string | null | undefined): boolean {
  const text = value?.trim().toLowerCase() ?? "";
  if (!text) {
    return false;
  }
  return UTILITY_LINK_TEXT_PATTERN.test(text);
}

export function resolveLocaleScopeLanguage(config: CrawlSiteProfileConfig): string | null {
  return resolvePreferredLanguageCode(config);
}

export function resolveNodeQueueClass(options: {
  pageType: CrawlFrontierPageType;
  freshnessScore?: number;
}): CrawlPriorityClass {
  if (options.pageType === "home" || options.pageType === "category") {
    return "hot";
  }
  if (options.pageType === "list") {
    return "hot";
  }
  return "normal";
}

export function estimateFreshnessScore(
  url: string,
  config?: CrawlSiteProfileConfig,
): number {
  const now = new Date();
  const match = url.match(/\/(20\d{2})\/(\d{1,2})\/(\d{1,2})\//);
  if (!match) {
    return 0;
  }
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month, day));
  if (Number.isNaN(parsed.getTime())) {
    return 0;
  }
  const ageHours = (now.getTime() - parsed.getTime()) / (1000 * 60 * 60);
  const freshnessRules = config?.freshnessRules;
  const recentHours = freshnessRules?.recentHours ?? 24;
  const weekHours = freshnessRules?.weekHours ?? 24 * 7;
  const monthHours = freshnessRules?.monthHours ?? 24 * 30;
  if (ageHours <= recentHours) {
    return 1;
  }
  if (ageHours <= weekHours) {
    return 0.75;
  }
  if (ageHours <= monthHours) {
    return 0.4;
  }
  return 0.1;
}

export function resolveFreshnessBucket(score: number): string {
  if (score >= 0.99) {
    return "24h";
  }
  if (score >= 0.74) {
    return "7d";
  }
  if (score >= 0.39) {
    return "30d";
  }
  if (score > 0) {
    return "stale";
  }
  return "unknown";
}

export function toRegistrableDomain(hostname: string | null): string | null {
  if (!hostname) {
    return null;
  }
  const normalized = normalizeDomain(hostname);
  if (!normalized || !normalized.includes(".")) {
    return normalized || null;
  }
  const parts = normalized.split(".").filter((entry) => entry.length > 0);
  if (parts.length <= 2) {
    return normalized;
  }
  const tail2 = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  if (COMPOUND_PUBLIC_SUFFIXES.has(tail2) && parts.length >= 3) {
    return `${parts[parts.length - 3]}.${tail2}`;
  }
  return tail2;
}

function matchesAllowedDomain(host: string, domain: string): boolean {
  const normalizedHost = normalizeHostname(host);
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedDomain) {
    return false;
  }
  return (
    normalizedHost === normalizedDomain ||
    normalizedHost.endsWith(`.${normalizedDomain}`) ||
    toRegistrableDomain(normalizedHost) === normalizedDomain
  );
}

function isAllowedFrontierHost(options: {
  host: string;
  config: CrawlSiteProfileConfig;
  requireSameDomainHost?: string;
}): boolean {
  const host = normalizeHostname(options.host);
  const strictHostAllowlist =
    resolveFrontierHostScope(options.config) === "strict_hosts";
  const allowedHosts = new Set<string>(
    (options.config.allowedHosts ?? []).map((entry) => normalizeHostname(entry)),
  );
  const allowedDomains = strictHostAllowlist
    ? new Set<string>()
    : new Set<string>(
        (options.config.allowedDomains ?? []).map((entry) => normalizeDomain(entry)),
      );
  const baseHost = options.requireSameDomainHost
    ? normalizeHostname(options.requireSameDomainHost)
    : null;
  if (baseHost) {
    allowedHosts.add(baseHost);
    if (!strictHostAllowlist) {
      const registrable = toRegistrableDomain(baseHost);
      if (registrable) {
        allowedDomains.add(registrable);
      }
    }
  }
  if (Array.from(allowedHosts).some((pattern) => matchHostPattern(pattern, host))) {
    return true;
  }
  return Array.from(allowedDomains).some((domain) =>
    matchesAllowedDomain(host, domain),
  );
}

export function shouldRejectFrontierUrl(options: {
  url: string;
  config: CrawlSiteProfileConfig;
  requireSameDomainHost?: string;
  linkText?: string;
}): string | null {
  let parsed: URL;
  try {
    parsed = new URL(options.url);
  } catch {
    return "invalid_url";
  }
  const host = parsed.hostname.toLowerCase();
  if (
    options.requireSameDomainHost &&
    !isAllowedFrontierHost({
      host,
      config: options.config,
      requireSameDomainHost: options.requireSameDomainHost,
    })
  ) {
    return "cross_domain";
  }
  for (const blockedDomain of options.config.blockedDomains ?? []) {
    const normalized = blockedDomain.toLowerCase();
    if (host === normalized || host.endsWith(`.${normalized}`)) {
      return "blocked_domain";
    }
  }
  const localeScope = options.config.localeScope;
  if (
    localeScope?.denyHostPatterns?.some((pattern) =>
      matchHostPattern(pattern, host),
    )
  ) {
    return "foreign_locale";
  }
  if (matchesAnyPattern(localeScope?.denyUrlPatterns, options.url)) {
    return "foreign_locale";
  }
  if (
    resolveForeignLocaleAlias({
      url: options.url,
      preferredLanguage: resolvePreferredLanguageCode(options.config),
    })
  ) {
    return "foreign_locale";
  }
  if (isUtilityFrontierUrl(options.url)) {
    return "utility_url";
  }
  if (
    matchesConfiguredKeyword(
      options.config.denyKeywords,
      options.url,
      options.linkText,
    )
  ) {
    return "deny_keyword";
  }
  if (
    matchesSignalConfig(
      options.config.pageTypeSignals?.deny,
      options.url,
      options.linkText,
    )
  ) {
    return "deny_signal";
  }
  if (matchesAnyPattern(options.config.urlPatterns?.exclude, options.url)) {
    return "excluded_pattern";
  }
  return null;
}

export function classifyFrontierFailureKind(
  message: string | null | undefined,
): string | null {
  const normalized = message?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return null;
  }
  if (
    normalized.includes("ssrf protection") ||
    normalized.includes("resolves to private ip") ||
    normalized.includes("blocked non-public dns answer")
  ) {
    return "ssrf_blocked";
  }
  if (
    normalized.includes("datadome") ||
    normalized.includes("captcha") ||
    normalized.includes("cloudflare") ||
    normalized.includes("challenge") ||
    normalized.includes("protected") ||
    normalized.includes("access denied") ||
    normalized.includes("status code 401") ||
    normalized.includes("status code 403") ||
    normalized.includes("status code 429")
  ) {
    return "challenge_detected";
  }
  if (
    normalized.includes("err_tunnel_connection_failed") ||
    normalized.includes("tunnel_connection_failed") ||
    normalized.includes("err_connection_closed") ||
    normalized.includes("connection_closed") ||
    normalized.includes("econnreset") ||
    normalized.includes("etimedout") ||
    normalized.includes("navigation timeout") ||
    normalized.includes("request timed out")
  ) {
    return "network_tunnel_error";
  }
  return null;
}
