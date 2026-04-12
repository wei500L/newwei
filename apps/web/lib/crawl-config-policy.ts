type AnyRecord = Record<string, unknown>;

export type CrawlConfigPolicyIssueCode =
  | 'unsupported_proxy'
  | 'frontier_single_primary_url';

export interface CrawlConfigPolicyIssue {
  code: CrawlConfigPolicyIssueCode;
  path: string;
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
      code: 'unsupported_proxy',
      path: `${path}.proxyUrl`,
    });
  }
  if (hasOwn(value, 'proxyConfig')) {
    issues.push({
      code: 'unsupported_proxy',
      path: `${path}.proxyConfig`,
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
        code: 'frontier_single_primary_url',
        path: `${path}.crawlOptions.additionalUrls`,
      });
    }
    if (hasOwn(crawlOptions, 'multiUrlConfigs')) {
      issues.push({
        code: 'frontier_single_primary_url',
        path: `${path}.crawlOptions.multiUrlConfigs`,
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
        code: 'frontier_single_primary_url',
        path: `${pagePath}.additionalUrls`,
      });
    }
    if (hasOwn(pageRule, 'multiUrlConfigs')) {
      issues.push({
        code: 'frontier_single_primary_url',
        path: `${pagePath}.multiUrlConfigs`,
      });
    }
  }

  return issues;
};

export const getCrawlConfigPolicyIssueTranslationKey = (
  code: CrawlConfigPolicyIssueCode,
): string => {
  switch (code) {
    case 'unsupported_proxy':
      return 'crawl.policy.unsupportedProxy';
    case 'frontier_single_primary_url':
      return 'crawl.policy.frontierSinglePrimaryUrl';
  }
};
