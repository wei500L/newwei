import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..');

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), 'utf8');

describe('content subscriptions resilience wiring', () => {
  it('treats recommendations and post-mutation refresh as best-effort', () => {
    const source = read('app/(app)/subscriptions/content-subscriptions-tab.tsx');

    expect(source).toContain('const [subscriptionRefreshWarning, setSubscriptionRefreshWarning] =');
    expect(source).toContain('const [recommendationsWarning, setRecommendationsWarning] =');
    expect(source).toContain('const refreshSubscriptionViews = useCallback(async () => {');
    expect(source).toContain('Promise.allSettled([');
    expect(source).toContain('Failed to load content subscription recommendations');
    expect(source).toContain('Changes were saved, but the latest subscription list could not be reloaded.');
    expect(source).toContain('<Alert');
    expect(source).toContain('onClose={() => setSubscriptionRefreshWarning(null)}');
    expect(source).toContain('onClose={() => setRecommendationsWarning(null)}');
    expect(source).not.toContain('await Promise.all([\n        loadSubscriptions(),\n        loadRecommendations(),\n        loadCatalog(),\n      ]);');
  });
});
