import { describe, expect, it } from 'vitest';

import {
  filterRuntimeSecretSources,
  findExistingRuntimeSecretRow,
  getPrimaryRuntimeSecretKey,
  getRuntimeSecretEnvFallbackKeys,
  getRuntimeSecretRequirementLevel,
  getRuntimeSecretSuggestedKeys,
  listConfiguredRuntimeSecretSourceIds,
  matchesRuntimeSecretRowQuery,
  matchesRuntimeSecretSourceQuery,
  sourceRequiresRuntimeSecrets,
  sourceSupportsRuntimeSecrets,
  type RuntimeSecretSourceEntry,
} from '../lib/news-source-runtime-secrets';

describe('news source runtime secret helpers', () => {
  it('detects whether a source supports runtime-secret configuration', () => {
    expect(
      sourceSupportsRuntimeSecrets({
        name: 'Product Hunt',
        runtimeSecrets: {
          requiredAnyOfKeys: ['token'],
        },
      }),
    ).toBe(true);

    expect(sourceSupportsRuntimeSecrets({ name: 'Hacker News' })).toBe(false);
    expect(
      sourceRequiresRuntimeSecrets({
        name: 'Product Hunt',
        runtimeSecrets: { requiredAnyOfKeys: ['token'] },
      }),
    ).toBe(true);
    expect(
      sourceRequiresRuntimeSecrets({
        name: 'Weibo',
        runtimeSecrets: { suggestedKeys: ['cookie'] },
      }),
    ).toBe(false);
    expect(
      getRuntimeSecretRequirementLevel({
        name: 'Product Hunt',
        runtimeSecrets: { requiredAnyOfKeys: ['token'] },
      }),
    ).toBe('required');
    expect(
      getRuntimeSecretRequirementLevel({
        name: 'Weibo',
        runtimeSecrets: { suggestedKeys: ['cookie'] },
      }),
    ).toBe('optional');
    expect(getRuntimeSecretRequirementLevel({ name: 'Hacker News' })).toBe('none');
  });

  it('merges required and suggested keys without duplicates', () => {
    expect(
      getRuntimeSecretSuggestedKeys({
        requiredAnyOfKeys: ['token', 'api_token'],
        suggestedKeys: ['api_token', 'producthunt.token'],
      }),
    ).toEqual(['token', 'api_token', 'producthunt.token']);

    expect(
      getRuntimeSecretEnvFallbackKeys({
        envFallbackKeys: ['PRODUCTHUNT_API_TOKEN', 'PRODUCTHUNT_API_TOKEN'],
      }),
    ).toEqual(['PRODUCTHUNT_API_TOKEN']);

    expect(
      getPrimaryRuntimeSecretKey({
        requiredAnyOfKeys: ['token', 'api_token'],
        suggestedKeys: ['producthunt.token'],
      }),
    ).toBe('token');
  });

  it('finds an existing row for quick-add duplicate handling', () => {
    const rows = [
      { rowKey: 'persisted:producthunt::token', sourceId: 'producthunt', key: 'token' },
      { rowKey: 'draft:1', sourceId: 'weibo', key: 'cookie' },
    ];

    expect(findExistingRuntimeSecretRow(rows, 'producthunt', 'token')?.rowKey).toBe(
      'persisted:producthunt::token',
    );
    expect(findExistingRuntimeSecretRow(rows, 'weibo', 'weibo.cookie')?.rowKey).toBe('draft:1');
    expect(findExistingRuntimeSecretRow(rows, 'github', 'token')).toBeNull();
  });

  it('lists configured source ids from persisted rows only', () => {
    expect(
      listConfiguredRuntimeSecretSourceIds([
        { rowKey: 'persisted:producthunt::token', sourceId: 'producthunt', key: 'token', persisted: true },
        { rowKey: 'draft:1', sourceId: 'weibo', key: 'cookie', persisted: false },
        { rowKey: 'persisted:producthunt::api_token', sourceId: 'producthunt', key: 'api_token', persisted: true },
      ]),
    ).toEqual(['producthunt']);
  });

  it('filters runtime-secret sources by configured and required flags', () => {
    const sources: RuntimeSecretSourceEntry[] = [
      {
        sourceId: 'producthunt',
        metadata: { runtimeSecrets: { requiredAnyOfKeys: ['token'] } },
      },
      {
        sourceId: 'weibo',
        metadata: { runtimeSecrets: { suggestedKeys: ['cookie'] } },
      },
      {
        sourceId: 'hackernews',
        metadata: {},
      },
    ];
    const rows = [
      { rowKey: 'persisted:producthunt::token', sourceId: 'producthunt', key: 'token', persisted: true },
      { rowKey: 'draft:1', sourceId: 'weibo', key: 'cookie', persisted: false },
    ];

    expect(filterRuntimeSecretSources(sources, rows, {})).toHaveLength(2);
    expect(filterRuntimeSecretSources(sources, rows, { onlyConfigured: true })).toEqual([
      sources[0],
    ]);
    expect(filterRuntimeSecretSources(sources, rows, { onlyRequired: true })).toEqual([
      sources[0],
    ]);
  });

  it('matches source and row queries across source ids, names, and keys', () => {
    const source = {
      sourceId: 'producthunt',
      metadata: {
        name: 'Product Hunt',
        runtimeSecrets: {
          requiredAnyOfKeys: ['token'],
          envFallbackKeys: ['PRODUCTHUNT_API_TOKEN'],
        },
      },
    } satisfies RuntimeSecretSourceEntry;

    expect(matchesRuntimeSecretSourceQuery(source, 'product')).toBe(true);
    expect(matchesRuntimeSecretSourceQuery(source, 'api_token')).toBe(true);
    expect(matchesRuntimeSecretSourceQuery(source, 'github')).toBe(false);

    expect(
      matchesRuntimeSecretRowQuery(
        {
          rowKey: 'persisted:producthunt::token',
          sourceId: 'producthunt',
          key: 'token',
          persisted: true,
        },
        source.metadata,
        'hunt',
      ),
    ).toBe(true);
    expect(
      matchesRuntimeSecretRowQuery(
        {
          rowKey: 'persisted:producthunt::token',
          sourceId: 'producthunt',
          key: 'token',
          persisted: true,
        },
        source.metadata,
        'cookie',
      ),
    ).toBe(false);
  });
});
