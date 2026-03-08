import { describe, expect, it } from 'vitest';

import { NEWS_SOURCE_RUNTIME_SECRET_REQUIRED_CODE } from '../lib/api-error';
import {
  resolveExpandedRuntimeSecretSourceIds,
  resolveRuntimeSecretDeepLinkAction,
  shouldShowRuntimeSecretCta,
} from '../lib/news-source-runtime-secrets-ui';

describe('news source runtime secret UI helpers', () => {
  it('waits for source metadata before handling a deep-linked source', () => {
    expect(resolveRuntimeSecretDeepLinkAction([], {}, 'weibo')).toEqual({ type: 'pending' });

    expect(
      resolveRuntimeSecretDeepLinkAction(
        [],
        {
          weibo: {
            runtimeSecrets: {
              suggestedKeys: ['cookie'],
            },
          },
        },
        'weibo',
      ),
    ).toEqual({
      type: 'create',
      sourceId: 'weibo',
      secretKey: 'cookie',
    });
  });

  it('focuses an existing row before waiting on catalog metadata', () => {
    const existingRow = {
      rowKey: 'draft:1',
      sourceId: 'weibo',
      key: 'cookie',
    };

    const action = resolveRuntimeSecretDeepLinkAction([existingRow], {}, 'weibo');

    expect(action.type).toBe('focus');
    if (action.type !== 'focus') {
      throw new Error('Expected existing deep-linked row to be focused');
    }
    expect(action.row).toEqual(existingRow);
  });

  it('shows the runtime-secret CTA for metadata-only sources and explicit 424 errors', () => {
    expect(
      shouldShowRuntimeSecretCta({
        runtimeSecrets: {
          suggestedKeys: ['cookie'],
        },
      }),
    ).toBe(true);
    expect(shouldShowRuntimeSecretCta(undefined, NEWS_SOURCE_RUNTIME_SECRET_REQUIRED_CODE)).toBe(
      true,
    );
    expect(shouldShowRuntimeSecretCta({ name: 'Hacker News' })).toBe(false);
  });

  it('keeps source groups collapsed after the user closes them all', () => {
    expect(
      resolveExpandedRuntimeSecretSourceIds({
        currentExpandedSourceIds: [],
        visibleSourceIds: ['weibo', 'producthunt'],
        sourceQuery: '',
        hasInitialized: true,
      }),
    ).toEqual({
      nextExpandedSourceIds: [],
      hasInitialized: true,
    });
  });

  it('auto-expands groups on first load and when filters replace the visible sources', () => {
    expect(
      resolveExpandedRuntimeSecretSourceIds({
        currentExpandedSourceIds: [],
        visibleSourceIds: ['weibo', 'producthunt'],
        sourceQuery: '',
        hasInitialized: false,
      }),
    ).toEqual({
      nextExpandedSourceIds: ['weibo', 'producthunt'],
      hasInitialized: true,
    });

    expect(
      resolveExpandedRuntimeSecretSourceIds({
        currentExpandedSourceIds: ['weibo'],
        visibleSourceIds: ['github'],
        sourceQuery: '',
        hasInitialized: true,
      }),
    ).toEqual({
      nextExpandedSourceIds: ['github'],
      hasInitialized: true,
    });
  });

  it('reopens the searched source when it should be focused', () => {
    expect(
      resolveExpandedRuntimeSecretSourceIds({
        currentExpandedSourceIds: [],
        visibleSourceIds: ['weibo', 'github'],
        sourceQuery: 'weibo',
        hasInitialized: true,
      }),
    ).toEqual({
      nextExpandedSourceIds: ['weibo'],
      hasInitialized: true,
    });
  });
});
