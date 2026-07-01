import { BadRequestException } from '@nestjs/common';

type AnyRecord = Record<string, unknown>;

export interface CrawlConfigPolicyIssue {
  path: string;
  message: string;
}

const hasOwn = (value: AnyRecord, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const isPlainObject = (value: unknown): value is AnyRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const formatIssues = (issues: CrawlConfigPolicyIssue[]): string =>
  issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');

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
      message: 'custom upstream proxies are not supported',
    });
  }
  if (hasOwn(value, 'proxyConfig')) {
    issues.push({
      path: `${path}.proxyConfig`,
      message: 'custom upstream proxies are not supported',
    });
  }
  return issues;
};

export const findUnsupportedWorkflowDefinitionIssues = (
  value: unknown,
  path = 'draftDefinition',
): CrawlConfigPolicyIssue[] => {
  if (!isPlainObject(value) || !Array.isArray(value.nodes)) {
    return [];
  }

  const issues: CrawlConfigPolicyIssue[] = [];
  for (const [index, node] of value.nodes.entries()) {
    if (!isPlainObject(node) || !isPlainObject(node.config)) {
      continue;
    }
    const crawlOptions = isPlainObject(node.config.crawlOptions)
      ? node.config.crawlOptions
      : undefined;
    if (!crawlOptions) {
      continue;
    }
    issues.push(
      ...findUnsupportedProxyIssues(
        crawlOptions,
        `${path}.nodes[${index}].config.crawlOptions`,
      ),
    );
  }
  return issues;
};

export const findUnsupportedFrontierNodeScopeIssues = (
  value: unknown,
  path = 'crawlSiteProfile.config',
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
        message: 'frontier node crawl must target exactly one primary URL',
      });
    }
    if (hasOwn(crawlOptions, 'multiUrlConfigs')) {
      issues.push({
        path: `${path}.crawlOptions.multiUrlConfigs`,
        message: 'frontier node crawl must target exactly one primary URL',
      });
    }
  }

  const pageRules = isPlainObject(value.pageRules) ? value.pageRules : undefined;
  if (!pageRules) {
    return issues;
  }

  for (const pageType of ['home', 'category', 'list', 'article'] as const) {
    const rule = isPlainObject(pageRules[pageType]) ? pageRules[pageType] : undefined;
    if (!rule) {
      continue;
    }
    const rulePath = `${path}.pageRules.${pageType}`;
    issues.push(...findUnsupportedProxyIssues(rule, rulePath));
    if (hasOwn(rule, 'additionalUrls')) {
      issues.push({
        path: `${rulePath}.additionalUrls`,
        message: 'frontier node crawl must target exactly one primary URL',
      });
    }
    if (hasOwn(rule, 'multiUrlConfigs')) {
      issues.push({
        path: `${rulePath}.multiUrlConfigs`,
        message: 'frontier node crawl must target exactly one primary URL',
      });
    }
  }

  return issues;
};

export const assertNoUnsupportedProxy = (
  value: unknown,
  path: string,
): void => {
  const issues = findUnsupportedProxyIssues(value, path);
  if (issues.length === 0) {
    return;
  }
  throw new BadRequestException(
    `Unsupported crawl config: ${formatIssues(issues)}`,
  );
};

export const assertSupportedWorkflowDefinition = (
  value: unknown,
  path = 'draftDefinition',
): void => {
  const issues = findUnsupportedWorkflowDefinitionIssues(value, path);
  if (issues.length === 0) {
    return;
  }
  throw new BadRequestException(
    `Unsupported crawl config: ${formatIssues(issues)}`,
  );
};

export const assertSupportedFrontierProfileConfig = (
  value: unknown,
  path = 'crawlSiteProfile.config',
): void => {
  const issues = findUnsupportedFrontierNodeScopeIssues(value, path);
  if (issues.length === 0) {
    return;
  }
  throw new BadRequestException(
    `Unsupported crawl config: ${formatIssues(issues)}`,
  );
};
