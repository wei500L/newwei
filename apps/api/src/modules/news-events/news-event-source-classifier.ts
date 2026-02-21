const DEFAULT_AUTHORITATIVE_DOMAINS = [
  "reuters.com",
  "bloomberg.com",
  "apnews.com",
  "afp.com",
  "bbc.com",
  "bbc.co.uk",
  "ft.com",
  "financialtimes.com",
  "wsj.com",
  "thetimes.co.uk",
  "telegraph.co.uk",
  "independent.co.uk",
  "skynews.com",
  "news.sky.com",
  "nytimes.com",
  "washingtonpost.com",
  "theguardian.com",
  "economist.com",
  "theatlantic.com",
  "foreignpolicy.com",
  "foreignaffairs.com",
  "hbr.org",
  "cnbc.com",
  "forbes.com",
  "marketwatch.com",
  "barrons.com",
  "foxbusiness.com",
  "wsj.net",
  "yahoo.com",
  "finance.yahoo.com",
  "axios.com",
  "politico.com",
  "npr.org",
  "cnn.com",
  "foxnews.com",
  "abcnews.go.com",
  "abcnews.com",
  "cbsnews.com",
  "nbcnews.com",
  "time.com",
  "newsweek.com",
  "usatoday.com",
  "latimes.com",
  "thehill.com",
  "aljazeera.com",
  "dw.com",
  "france24.com",
  "lemonde.fr",
  "lefigaro.fr",
  "lesechos.fr",
  "liberation.fr",
  "elpais.com",
  "elmundo.es",
  "expansion.com",
  "corriere.it",
  "repubblica.it",
  "ilsole24ore.com",
  "spiegel.de",
  "faz.net",
  "handelsblatt.com",
  "sueddeutsche.de",
  "tagesschau.de",
  "nzz.ch",
  "swissinfo.ch",
  "nikkei.com",
  "asia.nikkei.com",
  "scmp.com",
  "caixin.com",
  "kyodonews.net",
  "jiji.com",
  "asahi.com",
  "mainichi.jp",
  "yomiuri.co.jp",
  "yna.co.kr",
  "koreatimes.co.kr",
  "koreaherald.com",
  "joongang.co.kr",
  "japantimes.co.jp",
  "straitstimes.com",
  "channelnewsasia.com",
  "thejakartapost.com",
  "nzherald.co.nz",
  "stuff.co.nz",
  "1news.co.nz",
  "smh.com.au",
  "theage.com.au",
  "afr.com",
  "abc.net.au",
  "theglobeandmail.com",
  "globalnews.ca",
  "cp24.com",
  "cbc.ca",
  "ctvnews.ca",
  "i24news.tv",
  "haaretz.com",
  "jpost.com",
  "thenationalnews.com",
  "arabnews.com",
  "timesofindia.indiatimes.com",
  "economictimes.indiatimes.com",
  "hindustantimes.com",
  "thehindu.com",
  "indianexpress.com",
  "moneycontrol.com",
  "newyorker.com",
  "propublica.org",
  "semafor.com",
  "fortune.com",
  "businessinsider.com",
  "federalreserve.gov",
  "ecb.europa.eu",
  "imf.org",
  "worldbank.org",
  "oecd.org",
  "bis.org",
  "sec.gov",
  "cftc.gov",
  "treasury.gov",
  "who.int",
  "un.org",
  "boe.co.uk",
  "bankofengland.co.uk",
  "bankofcanada.ca",
  "rba.gov.au",
  "boj.or.jp",
  "fca.org.uk",
  "esma.europa.eu",
  "europa.eu",
] as const;

const DEFAULT_AUTHORITATIVE_LABELS = [
  "reuters",
  "bloomberg",
  "associated press",
  "ap news",
  "agence france-presse",
  "afp",
  "bbc",
  "financial times",
  "wall street journal",
  "the times",
  "the telegraph",
  "the independent",
  "sky news",
  "new york times",
  "washington post",
  "the guardian",
  "the economist",
  "the atlantic",
  "foreign policy",
  "foreign affairs",
  "harvard business review",
  "cnbc",
  "fox business",
  "yahoo finance",
  "marketwatch",
  "barrons",
  "politico",
  "axios",
  "npr",
  "cnn",
  "fox news",
  "abc news",
  "cbs news",
  "nbc news",
  "le monde",
  "le figaro",
  "les echos",
  "liberation",
  "el pais",
  "el mundo",
  "expansion",
  "corriere della sera",
  "la repubblica",
  "il sole 24 ore",
  "der spiegel",
  "frankfurter allgemeine",
  "handelsblatt",
  "suddeutsche zeitung",
  "tagesschau",
  "nzz",
  "swissinfo",
  "nikkei",
  "south china morning post",
  "caixin",
  "kyodo news",
  "jiji press",
  "asahi shimbun",
  "mainichi shimbun",
  "yomiuri shimbun",
  "yonhap",
  "korea times",
  "korea herald",
  "joongang ilbo",
  "the jakarta post",
  "new zealand herald",
  "the age",
  "sydney morning herald",
  "australian financial review",
  "al jazeera",
  "deutsche welle",
  "france 24",
  "cbc news",
  "ctv news",
  "the globe and mail",
  "the jerusalem post",
  "the national",
  "arab news",
  "times of india",
  "the economic times",
  "hindustan times",
  "the hindu",
  "the indian express",
  "straits times",
  "channel news asia",
  "new yorker",
  "propublica",
  "fortune",
  "federal reserve",
  "european central bank",
  "imf",
  "world bank",
  "oecd",
  "bank for international settlements",
  "sec",
  "cftc",
  "u s treasury",
  "who",
  "united nations",
  "bank of england",
  "bank of canada",
  "reserve bank of australia",
  "bank of japan",
  "fca",
  "esma",
] as const;

const DEFAULT_BLOG_DOMAINS = [
  "substack.com",
  "medium.com",
  "blogspot.com",
  "wordpress.com",
  "ghost.io",
  "github.io",
  "hashnode.dev",
  "dev.to",
  "rumble.com",
  "youtube.com",
  "youtu.be",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "reddit.com",
  "t.me",
  "telegram.me",
  "discord.gg",
  "discord.com",
  "facebook.com",
  "instagram.com",
  "threads.net",
  "weibo.com",
  "wechat.com",
  "patreon.com",
  "onlyfans.com",
  "kick.com",
  "bitchute.com",
  "quora.com",
  "tumblr.com",
  "linktr.ee",
  "mastodon.social",
  "pixelfed.social",
] as const;

const DEFAULT_BLOG_LABELS = [
  "substack",
  "newsletter",
  "blog",
  "creator",
  "influencer",
  "opinion blog",
  "rumble",
  "youtube",
  "twitter",
  "x",
  "reddit",
  "telegram",
  "tiktok",
  "discord",
  "threads",
  "weibo",
  "wechat",
  "patreon",
  "mastodon",
  "podcast",
] as const;

const MAX_LIST_SIZE = 1000;

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

const DOMAIN_SANITIZE_RE = /[^a-z0-9.-]+/g;
const LABEL_SANITIZE_RE = /[^a-z0-9\u4e00-\u9fff]+/g;

const normalizeDomain = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(DOMAIN_SANITIZE_RE, "")
    .replace(/^www\./, "")
    .replace(/^\.+|\.+$/g, "");

const normalizeLabel = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(LABEL_SANITIZE_RE, " ")
    .replace(/\s+/g, " ")
    .trim();

const normalizeUnique = (
  values: unknown,
  normalizer: (value: string) => string,
  maxSize = MAX_LIST_SIZE,
): string[] => {
  if (!Array.isArray(values)) {
    return [];
  }

  const deduped = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== "string") {
      continue;
    }
    const normalized = normalizer(raw);
    if (!normalized) {
      continue;
    }
    deduped.add(normalized);
    if (deduped.size >= maxSize) {
      break;
    }
  }

  return Array.from(deduped);
};

const normalizeListOrFallback = (
  value: unknown,
  normalizer: (value: string) => string,
  fallback: string[],
): string[] => {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const normalized = normalizeUnique(value, normalizer);
  return normalized;
};

const extractHostname = (url: unknown): string | null => {
  const raw = typeof url === "string" ? url.trim() : "";
  if (!raw) {
    return null;
  }
  try {
    const host = new URL(raw).hostname.trim().toLowerCase();
    const normalized = normalizeDomain(host);
    return normalized || null;
  } catch {
    return null;
  }
};

const toRegistrableDomain = (hostname: string | null): string | null => {
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
};

const tokenizeLabelWords = (label: string): Set<string> => {
  const words = new Set<string>();
  for (const word of label.split(" ")) {
    if (!word) {
      continue;
    }
    words.add(word);
  }
  return words;
};

const hasDomainMatch = (
  hostname: string | null,
  registrableDomain: string | null,
  domains: Set<string>,
): boolean => {
  if (!hostname && !registrableDomain) {
    return false;
  }

  for (const domain of domains) {
    const normalized = normalizeDomain(domain);
    if (!normalized) {
      continue;
    }

    if (registrableDomain && registrableDomain === normalized) {
      return true;
    }

    if (
      hostname &&
      (hostname === normalized || hostname.endsWith(`.${normalized}`))
    ) {
      return true;
    }
  }

  return false;
};

const hasLabelMatch = (
  normalizedLabel: string,
  labelWords: Set<string>,
  labels: Set<string>,
): boolean => {
  if (!normalizedLabel) {
    return false;
  }

  for (const label of labels) {
    const normalized = normalizeLabel(label);
    if (!normalized) {
      continue;
    }

    if (normalized.includes(" ")) {
      if (normalizedLabel.includes(normalized)) {
        return true;
      }
      continue;
    }

    // Single-word labels use token-level matching to avoid false positives from substrings.
    if (labelWords.has(normalized)) {
      return true;
    }
  }

  return false;
};

export interface NewsEventSourcePolicy {
  authoritativeDomains: string[];
  authoritativeLabels: string[];
  blogDomains: string[];
  blogLabels: string[];
}

export interface NewsEventSourcePolicyMatcher {
  authoritativeDomains: Set<string>;
  authoritativeLabels: Set<string>;
  blogDomains: Set<string>;
  blogLabels: Set<string>;
}

const DEFAULT_POLICY: NewsEventSourcePolicy = {
  authoritativeDomains: normalizeUnique(
    DEFAULT_AUTHORITATIVE_DOMAINS,
    normalizeDomain,
  ),
  authoritativeLabels: normalizeUnique(
    DEFAULT_AUTHORITATIVE_LABELS,
    normalizeLabel,
  ),
  blogDomains: normalizeUnique(DEFAULT_BLOG_DOMAINS, normalizeDomain),
  blogLabels: normalizeUnique(DEFAULT_BLOG_LABELS, normalizeLabel),
};

const copyPolicy = (value: NewsEventSourcePolicy): NewsEventSourcePolicy => ({
  authoritativeDomains: [...value.authoritativeDomains],
  authoritativeLabels: [...value.authoritativeLabels],
  blogDomains: [...value.blogDomains],
  blogLabels: [...value.blogLabels],
});

export const getDefaultNewsEventSourcePolicy = (): NewsEventSourcePolicy =>
  copyPolicy(DEFAULT_POLICY);

export const normalizeSourcePolicy = (
  value: Partial<NewsEventSourcePolicy> | null | undefined,
  fallback?: NewsEventSourcePolicy,
): NewsEventSourcePolicy => {
  const defaults = fallback ?? DEFAULT_POLICY;
  const source = value ?? {};

  return {
    authoritativeDomains: normalizeListOrFallback(
      source.authoritativeDomains,
      normalizeDomain,
      defaults.authoritativeDomains,
    ),
    authoritativeLabels: normalizeListOrFallback(
      source.authoritativeLabels,
      normalizeLabel,
      defaults.authoritativeLabels,
    ),
    blogDomains: normalizeListOrFallback(
      source.blogDomains,
      normalizeDomain,
      defaults.blogDomains,
    ),
    blogLabels: normalizeListOrFallback(
      source.blogLabels,
      normalizeLabel,
      defaults.blogLabels,
    ),
  };
};

export const createSourcePolicyMatcher = (
  policy: NewsEventSourcePolicy,
): NewsEventSourcePolicyMatcher => ({
  authoritativeDomains: new Set(policy.authoritativeDomains),
  authoritativeLabels: new Set(policy.authoritativeLabels),
  blogDomains: new Set(policy.blogDomains),
  blogLabels: new Set(policy.blogLabels),
});

const DEFAULT_POLICY_MATCHER = createSourcePolicyMatcher(DEFAULT_POLICY);

const isPolicyMatcher = (
  value: unknown,
): value is NewsEventSourcePolicyMatcher => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<NewsEventSourcePolicyMatcher>;
  return (
    candidate.authoritativeDomains instanceof Set &&
    candidate.authoritativeLabels instanceof Set &&
    candidate.blogDomains instanceof Set &&
    candidate.blogLabels instanceof Set
  );
};

export const resolveSourceKey = (
  sourceLabel: unknown,
  url: unknown,
): string => {
  const label = typeof sourceLabel === "string" ? sourceLabel.trim() : "";
  if (label) {
    return label.slice(0, 120);
  }

  const hostname = extractHostname(url);
  const registrableDomain = toRegistrableDomain(hostname);
  if (registrableDomain) {
    return registrableDomain.slice(0, 120);
  }
  if (hostname) {
    return hostname.slice(0, 120);
  }

  return "unknown";
};

export type ClassifiedSourceType = "authoritative" | "blog" | "unknown";

export const classifySourceByLabelAndUrl = (
  sourceLabel: unknown,
  url: unknown,
  policyOrMatcher?: NewsEventSourcePolicy | NewsEventSourcePolicyMatcher,
): ClassifiedSourceType => {
  const label = typeof sourceLabel === "string" ? sourceLabel : "";
  const normalizedLabel = normalizeLabel(label);
  const labelWords = tokenizeLabelWords(normalizedLabel);
  const hostname = extractHostname(url);
  const registrableDomain = toRegistrableDomain(hostname);

  const matcher =
    policyOrMatcher == null
      ? DEFAULT_POLICY_MATCHER
      : isPolicyMatcher(policyOrMatcher)
        ? policyOrMatcher
        : createSourcePolicyMatcher(
            normalizeSourcePolicy(policyOrMatcher, DEFAULT_POLICY),
          );

  // Blacklist has priority to prevent label spoofing on low-trust hosts.
  if (
    hasDomainMatch(hostname, registrableDomain, matcher.blogDomains) ||
    hasLabelMatch(normalizedLabel, labelWords, matcher.blogLabels)
  ) {
    return "blog";
  }

  if (
    hasDomainMatch(hostname, registrableDomain, matcher.authoritativeDomains) ||
    hasLabelMatch(normalizedLabel, labelWords, matcher.authoritativeLabels)
  ) {
    return "authoritative";
  }

  return "unknown";
};
