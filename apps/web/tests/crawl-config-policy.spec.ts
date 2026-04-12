import { describe, expect, it } from 'vitest';

import {
  findUnsupportedFrontierProfileIssues,
  findUnsupportedProxyIssues,
} from '../lib/crawl-config-policy';

describe('crawl config policy', () => {
  it('flags unsupported proxy fields in generic crawl options', () => {
    expect(
      findUnsupportedProxyIssues(
        {
          proxyUrl: 'http://proxy.example:8080',
          proxyConfig: { server: 'http://proxy.example:8080' },
        },
        'options',
      ),
    ).toEqual([
      {
        path: 'options.proxyUrl',
        message: 'Custom upstream proxies are no longer supported.',
      },
      {
        path: 'options.proxyConfig',
        message: 'Custom upstream proxies are no longer supported.',
      },
    ]);
  });

  it('flags proxy and multi-url fields in frontier profile node scopes', () => {
    expect(
      findUnsupportedFrontierProfileIssues({
        crawlOptions: {
          proxyUrl: 'http://proxy.example:8080',
          additionalUrls: ['https://example.com/extra'],
        },
        pageRules: {
          article: {
            multiUrlConfigs: [{ urls: ['https://example.com/1'] }],
          },
        },
      }),
    ).toEqual([
      {
        path: 'config.crawlOptions.proxyUrl',
        message: 'Custom upstream proxies are no longer supported.',
      },
      {
        path: 'config.crawlOptions.additionalUrls',
        message: 'Frontier node crawl must keep a single primary URL.',
      },
      {
        path: 'config.pageRules.article.multiUrlConfigs',
        message: 'Frontier node crawl must keep a single primary URL.',
      },
    ]);
  });
});
