export enum NewsContentType {
  news_fact = "news_fact",
  opinion = "opinion",
  analysis = "analysis",
  mixed = "mixed",
}

const CONTENT_TYPE_ALIASES = new Map<string, NewsContentType>([
  ["news_fact", NewsContentType.news_fact],
  ["news-fact", NewsContentType.news_fact],
  ["newsfact", NewsContentType.news_fact],
  ["fact", NewsContentType.news_fact],
  ["factual", NewsContentType.news_fact],
  ["report", NewsContentType.news_fact],
  ["reporting", NewsContentType.news_fact],
  ["hard_news", NewsContentType.news_fact],
  ["straight_news", NewsContentType.news_fact],
  ["新闻事实", NewsContentType.news_fact],
  ["事实", NewsContentType.news_fact],
  ["事实报道", NewsContentType.news_fact],
  ["资讯", NewsContentType.news_fact],
  ["快讯", NewsContentType.news_fact],

  ["opinion", NewsContentType.opinion],
  ["op-ed", NewsContentType.opinion],
  ["oped", NewsContentType.opinion],
  ["editorial", NewsContentType.opinion],
  ["commentary", NewsContentType.opinion],
  ["观点", NewsContentType.opinion],
  ["评论", NewsContentType.opinion],
  ["社论", NewsContentType.opinion],
  ["专栏", NewsContentType.opinion],

  ["analysis", NewsContentType.analysis],
  ["analytical", NewsContentType.analysis],
  ["explainer", NewsContentType.analysis],
  ["deep_dive", NewsContentType.analysis],
  ["解读", NewsContentType.analysis],
  ["分析", NewsContentType.analysis],
  ["研判", NewsContentType.analysis],
  ["复盘", NewsContentType.analysis],

  ["mixed", NewsContentType.mixed],
  ["hybrid", NewsContentType.mixed],
  ["mixed_content", NewsContentType.mixed],
  ["mixed-content", NewsContentType.mixed],
  ["综合", NewsContentType.mixed],
  ["混合", NewsContentType.mixed],
  ["事实+观点", NewsContentType.mixed],
  ["fact_and_opinion", NewsContentType.mixed],
]);

const OPINION_KEYWORDS = [
  "opinion",
  "op-ed",
  "editorial",
  "commentary",
  "column",
  "观点",
  "评论",
  "社论",
  "专栏",
];

const ANALYSIS_KEYWORDS = [
  "analysis",
  "analytical",
  "explainer",
  "deep dive",
  "insight",
  "解读",
  "分析",
  "研判",
  "复盘",
  "观察",
];

const FACT_KEYWORDS = [
  "breaking",
  "report",
  "update",
  "announced",
  "statement",
  "disclosed",
  "发布",
  "通报",
  "公告",
  "快讯",
  "报道",
];

const OPINION_URL_HINTS = [
  "/opinion",
  "/commentary",
  "/editorial",
  "/op-ed",
  "/column",
];
const ANALYSIS_URL_HINTS = [
  "/analysis",
  "/explainer",
  "/insight",
  "/deep-dive",
];

const sanitizeToken = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_\-+\u4e00-\u9fff]/g, "");

const normalizeText = (value: unknown): string => {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
};

const includesAny = (text: string, keywords: string[]): boolean =>
  keywords.some((keyword) => text.includes(keyword.toLowerCase()));

const scoreKeywordHits = (text: string, keywords: string[]): number =>
  keywords.reduce(
    (score, keyword) =>
      text.includes(keyword.toLowerCase()) ? score + 1 : score,
    0,
  );

export const normalizeNewsContentType = (
  value: unknown,
): NewsContentType | null => {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = sanitizeToken(value);
  if (!normalized) {
    return null;
  }
  return CONTENT_TYPE_ALIASES.get(normalized) ?? null;
};

export const inferNewsContentType = (input: {
  title?: string | null;
  summary?: string | null;
  source?: string | null;
  url?: string | null;
  topics?: string[] | null;
  tags?: string[] | null;
}): NewsContentType => {
  const title = normalizeText(input.title);
  const summary = normalizeText(input.summary);
  const source = normalizeText(input.source);
  const url = normalizeText(input.url);
  const topics = Array.isArray(input.topics)
    ? input.topics
        .map((entry) => normalizeText(entry))
        .filter((entry) => entry.length > 0)
    : [];
  const tags = Array.isArray(input.tags)
    ? input.tags
        .map((entry) => normalizeText(entry))
        .filter((entry) => entry.length > 0)
    : [];
  const combinedText = [title, summary, source, ...topics, ...tags].join(" ");

  let opinionScore = 0;
  let analysisScore = 0;
  let factScore = 0;

  if (OPINION_URL_HINTS.some((hint) => url.includes(hint))) {
    opinionScore += 3;
  }
  if (ANALYSIS_URL_HINTS.some((hint) => url.includes(hint))) {
    analysisScore += 3;
  }

  opinionScore += scoreKeywordHits(combinedText, OPINION_KEYWORDS);
  analysisScore += scoreKeywordHits(combinedText, ANALYSIS_KEYWORDS);
  factScore += scoreKeywordHits(combinedText, FACT_KEYWORDS);

  if (includesAny(source, OPINION_KEYWORDS)) {
    opinionScore += 1;
  }
  if (includesAny(source, ANALYSIS_KEYWORDS)) {
    analysisScore += 1;
  }

  const hasOpinion = opinionScore >= 2;
  const hasAnalysis = analysisScore >= 2;
  const hasFact = factScore >= 2;

  if ((hasOpinion && hasAnalysis) || ((hasOpinion || hasAnalysis) && hasFact)) {
    return NewsContentType.mixed;
  }
  if (hasOpinion) {
    return NewsContentType.opinion;
  }
  if (hasAnalysis) {
    return NewsContentType.analysis;
  }
  return NewsContentType.news_fact;
};
