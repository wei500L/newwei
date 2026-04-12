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
        code: 'unsupported_proxy',
        path: 'options.proxyUrl',
      },
      {
        code: 'unsupported_proxy',
        path: 'options.proxyConfig',
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
        code: 'unsupported_proxy',
        path: 'config.crawlOptions.proxyUrl',
      },
      {
        code: 'frontier_single_primary_url',
        path: 'config.crawlOptions.additionalUrls',
      },
      {
        code: 'frontier_single_primary_url',
        path: 'config.pageRules.article.multiUrlConfigs',
      },
    ]);
  });
});
