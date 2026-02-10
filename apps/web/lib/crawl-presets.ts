import type {
  CleanMarkdownFormValue,
  CrawlDetailExpansionOptionsFormValue,
  MarkdownFilterFormValue,
  MarkdownOptionsFormValue,
  CrawlOptionsFormValues
} from "@modular/utils";

export type CrawlTaskTemplateKey = "general" | "news" | "reuters_cf" | "forum" | "social";

export interface CrawlTaskTemplateDescriptor {
  key: CrawlTaskTemplateKey;
  label: string;
  defaultLabel: string;
  description: string;
  defaultDescription: string;
}

export interface CrawlTaskTemplateValues extends CrawlOptionsFormValues {
  ingestToItems?: boolean;
  qualityProfile?: "quality_first" | "balanced" | "speed_first";
  pageTypeHint?: "auto" | "list" | "detail";
  autoExpandDetails?: boolean;
  detailExpansion?: CrawlDetailExpansionOptionsFormValue;
  markdownOptions?: MarkdownOptionsFormValue;
  markdownFilter?: MarkdownFilterFormValue;
  cleanMarkdown?: CleanMarkdownFormValue;
}

interface BuildCrawlTaskTemplateOptions {
  canWriteItems: boolean;
}

const REUTERS_CLEAN_MARKDOWN: CleanMarkdownFormValue = {
  cssSelector: "article,main,[data-testid='Body'],.article-body",
  removeOverlayElements: true,
  wordCountThreshold: 80,
  excludedTags: ["nav", "footer", "script", "style", "noscript", "form"]
};

export const CRAWL_TASK_TEMPLATE_DESCRIPTORS: CrawlTaskTemplateDescriptor[] = [
  {
    key: "general",
    label: "crawl.templates.general",
    defaultLabel: "General",
    description: "crawl.templates.generalDesc",
    defaultDescription: "Basic crawl defaults for most websites"
  },
  {
    key: "news",
    label: "crawl.templates.news",
    defaultLabel: "News",
    description: "crawl.templates.newsDesc",
    defaultDescription: "Article-focused profile for common news sites"
  },
  {
    key: "reuters_cf",
    label: "crawl.templates.reutersCf",
    defaultLabel: "Reuters + Cloudflare",
    description: "crawl.templates.reutersCfDesc",
    defaultDescription: "Headed + stealth + anti-bot retries tuned for Reuters-like protected sites"
  },
  {
    key: "forum",
    label: "crawl.templates.forum",
    defaultLabel: "Forum",
    description: "crawl.templates.forumDesc",
    defaultDescription: "List-page and pagination friendly setup"
  },
  {
    key: "social",
    label: "crawl.templates.social",
    defaultLabel: "Social",
    description: "crawl.templates.socialDesc",
    defaultDescription: "High-delay strategy for dynamic timelines"
  }
];

const buildGeneralTemplateValues = (): Partial<CrawlTaskTemplateValues> => ({
  ingestToItems: false,
  onlyMainContent: true,
  scanFullPage: false,
  extractLinks: false,
  antiBotMode: "auto",
  qualityProfile: "quality_first",
  pageTypeHint: "auto",
  autoExpandDetails: false,
  detailExpansion: undefined
});

const buildNewsTemplateValues = ({ canWriteItems }: BuildCrawlTaskTemplateOptions): Partial<CrawlTaskTemplateValues> => ({
  ingestToItems: canWriteItems ? true : false,
  onlyMainContent: true,
  extractLinks: false,
  scanFullPage: false,
  adjustViewportToContent: true,
  scrollDelayMs: 200,
  includeImages: true,
  excludeExternalImages: false,
  waitForImages: true,
  antiBotMode: "enabled",
  simulateUser: true,
  overrideNavigator: true,
  waitUntil: "networkidle",
  pageTimeoutMs: 45_000,
  delayBeforeReturnHtmlMs: 800,
  meanDelayMs: 800,
  maxDelayRangeMs: 250,
  semaphoreCount: 5,
  removeForms: true,
  qualityProfile: "quality_first",
  pageTypeHint: "detail",
  autoExpandDetails: false,
  detailExpansion: undefined,
  markdownOptions: {
    contentSource: "cleaned_html",
    escapeHtml: true,
    bodyWidth: 80
  },
  markdownFilter: {
    type: "pruning",
    thresholdType: "dynamic",
    minWordThreshold: 80
  },
  cleanMarkdown: {
    cssSelector: "article,main,.article-body",
    removeOverlayElements: true,
    wordCountThreshold: 120,
    excludedTags: ["nav", "footer", "script", "style"]
  }
});

const buildReutersCloudflareTemplateValues = ({
  canWriteItems
}: BuildCrawlTaskTemplateOptions): Partial<CrawlTaskTemplateValues> => ({
  ingestToItems: canWriteItems ? true : false,
  headless: false,
  enableUndetectedBrowser: true,
  enableStealthMode: true,
  antiBotMode: "enabled",
  useManagedBrowser: false,
  onlyMainContent: true,
  extractLinks: false,
  scanFullPage: false,
  adjustViewportToContent: true,
  includeImages: true,
  excludeExternalImages: false,
  waitForImages: true,
  simulateUser: true,
  overrideNavigator: true,
  userAgentMode: "random",
  waitForSelector: "article",
  waitUntil: "load",
  waitForTimeoutMs: 12_000,
  pageTimeoutMs: 120_000,
  delayBeforeReturnHtmlMs: 2_000,
  meanDelayMs: 900,
  maxDelayRangeMs: 1_500,
  semaphoreCount: 4,
  removeForms: true,
  qualityProfile: "quality_first",
  pageTypeHint: "detail",
  autoExpandDetails: false,
  detailExpansion: undefined,
  markdownOptions: {
    contentSource: "cleaned_html",
    escapeHtml: true,
    citations: true,
    bodyWidth: 80
  },
  markdownFilter: {
    type: "pruning",
    thresholdType: "dynamic",
    threshold: 0.28,
    minWordThreshold: 60
  },
  cleanMarkdown: REUTERS_CLEAN_MARKDOWN
});

const buildForumTemplateValues = (): Partial<CrawlTaskTemplateValues> => ({
  ingestToItems: false,
  onlyMainContent: false,
  scanFullPage: true,
  extractLinks: false,
  scrollDelayMs: 1_000,
  antiBotMode: "auto",
  qualityProfile: "balanced",
  pageTypeHint: "list",
  autoExpandDetails: true,
  detailExpansion: {
    maxDetailUrls: 12,
    minRelevanceScore: 0.25,
    requireSameDomain: true,
    allowExternalLinks: true
  }
});

const buildSocialTemplateValues = (): Partial<CrawlTaskTemplateValues> => ({
  ingestToItems: false,
  headless: false,
  enableStealthMode: true,
  enableUndetectedBrowser: true,
  antiBotMode: "enabled",
  scanFullPage: true,
  onlyMainContent: false,
  waitForTimeoutMs: 5_000,
  scrollDelayMs: 2_000,
  userAgentMode: "random",
  qualityProfile: "speed_first",
  pageTypeHint: "list",
  autoExpandDetails: false,
  detailExpansion: undefined
});

const CRAWL_TASK_TEMPLATE_VALUE_BUILDERS: Record<
  CrawlTaskTemplateKey,
  (options: BuildCrawlTaskTemplateOptions) => Partial<CrawlTaskTemplateValues>
> = {
  general: () => buildGeneralTemplateValues(),
  news: (options) => buildNewsTemplateValues(options),
  reuters_cf: (options) => buildReutersCloudflareTemplateValues(options),
  forum: () => buildForumTemplateValues(),
  social: () => buildSocialTemplateValues()
};

export const resolveCrawlTaskTemplateKey = (value?: string | null): CrawlTaskTemplateKey | null => {
  if (!value) {
    return null;
  }
  const normalized = value.trim() as CrawlTaskTemplateKey;
  return Object.prototype.hasOwnProperty.call(CRAWL_TASK_TEMPLATE_VALUE_BUILDERS, normalized)
    ? normalized
    : null;
};

export const buildCrawlTaskTemplateValues = (
  key: CrawlTaskTemplateKey,
  options: BuildCrawlTaskTemplateOptions
): Partial<CrawlTaskTemplateValues> => {
  return CRAWL_TASK_TEMPLATE_VALUE_BUILDERS[key](options);
};

export interface NewsSourcePresetValues {
  crawlHeadlessMode: "auto" | "headless" | "headed";
  crawlUndetectedMode: "auto" | "enable" | "disable";
  crawlStealthMode: "auto" | "enable" | "disable";
  crawlAntiBotMode: "auto" | "enable" | "disable";
  crawlScanMode?: "default" | "full_page" | "virtual_scroll";
  crawlQualityProfile?: "quality_first" | "balanced" | "speed_first";
  crawlPageTypeHint?: "auto" | "list" | "detail";
  crawlAutoExpandDetails?: boolean;
  crawlMarkdownContentSource?: "cleaned_html" | "raw_html" | "fit_html";
  crawlMarkdownEscapeHtmlMode?: "auto" | "enable" | "disable";
  crawlMarkdownCitationsMode?: "auto" | "enable" | "disable";
}

export const buildNewsSourceCloudflarePresetValues = (): NewsSourcePresetValues => ({
  crawlHeadlessMode: "headed",
  crawlUndetectedMode: "enable",
  crawlStealthMode: "enable",
  crawlAntiBotMode: "enable"
});

export const buildNewsSourceReutersCfPresetValues = (): NewsSourcePresetValues => ({
  ...buildNewsSourceCloudflarePresetValues(),
  crawlScanMode: "default",
  crawlQualityProfile: "quality_first",
  crawlPageTypeHint: "detail",
  crawlAutoExpandDetails: false,
  crawlMarkdownContentSource: "cleaned_html",
  crawlMarkdownEscapeHtmlMode: "enable",
  crawlMarkdownCitationsMode: "enable"
});
