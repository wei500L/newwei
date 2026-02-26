import { sanitizeCrawlOptions } from '@modular/utils';
import { describe, expect, it } from 'vitest';

describe('crawl options serialization', () => {
  it('keeps and normalizes detailExpansion fields from form values', () => {
    const sanitized = sanitizeCrawlOptions({
      autoExpandDetails: true,
      detailExpansion: {
        maxDetailUrls: 66,
        minRelevanceScore: 1.4,
        requireSameDomain: false,
        allowExternalLinks: true,
        includeUrlPatterns: [' /article/* ', '', '/article/*', '/world/* '],
        excludeUrlPatterns: [' /tag/ ', '/archive/', '/tag/'],
        minPublishTimeConfidence: -0.2,
        preferFitMarkdownForQuality: false,
      },
    } as any);

    expect(sanitized.autoExpandDetails).toBe(true);
    expect(sanitized.detailExpansion).toEqual(
      expect.objectContaining({
        maxDetailUrls: 30,
        minRelevanceScore: 1,
        requireSameDomain: false,
        allowExternalLinks: true,
        includeUrlPatterns: ['/article/*', '/article/*', '/world/*'],
        excludeUrlPatterns: ['/tag/', '/archive/', '/tag/'],
        minPublishTimeConfidence: 0,
        preferFitMarkdownForQuality: false,
      }),
    );
  });

  it('serializes detailExpansion in multi-url strategy overrides', () => {
    const sanitized = sanitizeCrawlOptions({
      multiUrlConfigs: [
        {
          name: 'world-pages',
          matcher: {
            matchMode: 'glob',
            patterns: ['https://example.com/world/*'],
          },
          options: {
            detailExpansion: {
              maxDetailUrls: 0,
              minRelevanceScore: 0.4567,
              includeUrlPatterns: [' /world/* ', '/world/*'],
              excludeUrlPatterns: ['   '],
              minPublishTimeConfidence: 0.87654,
              preferFitMarkdownForQuality: true,
            },
          },
        },
      ],
    } as any);

    const detailExpansion = sanitized.multiUrlConfigs?.[0]?.options?.detailExpansion;
    expect(detailExpansion).toEqual(
      expect.objectContaining({
        maxDetailUrls: 1,
        minRelevanceScore: 0.457,
        includeUrlPatterns: ['/world/*', '/world/*'],
        minPublishTimeConfidence: 0.877,
        preferFitMarkdownForQuality: true,
      }),
    );
    expect(detailExpansion?.excludeUrlPatterns).toEqual([]);
  });
});
