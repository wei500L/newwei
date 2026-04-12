type AnyRecord = Record<string, unknown>;

export interface CrawlConfigPolicyIssue {
  path: string;
  message: string;
}

const hasOwn = (value: AnyRecord, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const isPlainObject = (value: unknown): value is AnyRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const findUnsupportedProxyIssues = (
  value: unknown,
  path: string,
): CrawlConfigPolicyIssue[] => {
  if (!isPlainObject(value)) {
    return [];
  }

  const issues: CrawlConfigPolicyIssue[] = [];
  if (hasOwn(value, 'proxyUrl')) {
    issues.push({
      path: `${path}.proxyUrl`,
      message: 'Custom upstream proxies are no longer supported.',
    });
  }
  if (hasOwn(value, 'proxyConfig')) {
    issues.push({
      path: `${path}.proxyConfig`,
      message: 'Custom upstream proxies are no longer supported.',
    });
  }
  return issues;
};

export const findUnsupportedFrontierProfileIssues = (
  value: unknown,
  path = 'config',
): CrawlConfigPolicyIssue[] => {
  if (!isPlainObject(value)) {
    return [];
  }

  const issues: CrawlConfigPolicyIssue[] = [];
  const crawlOptions = isPlainObject(value.crawlOptions)
    ? value.crawlOptions
    : undefined;
  if (crawlOptions) {
    issues.push(...findUnsupportedProxyIssues(crawlOptions, `${path}.crawlOptions`));
    if (hasOwn(crawlOptions, 'additionalUrls')) {
      issues.push({
        path: `${path}.crawlOptions.additionalUrls`,
        message: 'Frontier node crawl must keep a single primary URL.',
      });
    }
    if (hasOwn(crawlOptions, 'multiUrlConfigs')) {
      issues.push({
        path: `${path}.crawlOptions.multiUrlConfigs`,
        message: 'Frontier node crawl must keep a single primary URL.',
      });
    }
  }

  const pageRules = isPlainObject(value.pageRules) ? value.pageRules : undefined;
  if (!pageRules) {
    return issues;
  }

  for (const pageType of ['home', 'category', 'list', 'article'] as const) {
    const pageRule = isPlainObject(pageRules[pageType])
      ? pageRules[pageType]
      : undefined;
    if (!pageRule) {
      continue;
    }
    const pagePath = `${path}.pageRules.${pageType}`;
    issues.push(...findUnsupportedProxyIssues(pageRule, pagePath));
    if (hasOwn(pageRule, 'additionalUrls')) {
      issues.push({
        path: `${pagePath}.additionalUrls`,
        message: 'Frontier node crawl must keep a single primary URL.',
      });
    }
    if (hasOwn(pageRule, 'multiUrlConfigs')) {
      issues.push({
        path: `${pagePath}.multiUrlConfigs`,
        message: 'Frontier node crawl must keep a single primary URL.',
      });
    }
  }

  return issues;
};

export const formatCrawlConfigPolicyIssues = (
  issues: CrawlConfigPolicyIssue[],
): string => issues.map((issue) => `${issue.path}: ${issue.message}`).join(" ");
