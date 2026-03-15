import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..');

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), 'utf8');

describe('llm gateway governance admin UI wiring', () => {
  it('supports binding completion, embedding, and rerank traffic from the governance dialog', () => {
    const source = read('components/settings/llm-gateway-settings-panel.tsx');

    expect(source).toContain(
      'proxyGovernance.preflight.actions.bindCompletion',
    );
    expect(source).toContain(
      'proxyGovernance.preflight.actions.bindEmbedding',
    );
    expect(source).toContain(
      'proxyGovernance.preflight.actions.bindRerank',
    );
    expect(source).toContain('void handleActivate(selectedGovernanceProfile.id);');
    expect(source).toContain(
      'void handleActivateEmbedding(selectedGovernanceProfile.id);',
    );
    expect(source).toContain(
      'void handleActivateRerank(selectedGovernanceProfile.id);',
    );
  });

  it('avoids reloading observed usage for the same governed profile and surfaces the leading error', () => {
    const source = read('components/settings/llm-gateway-settings-panel.tsx');

    expect(source).toContain('governanceUsageProfileId');
    expect(source).toContain('if (profileId === governanceUsageProfileId) {');
    expect(source).toContain('normalizeObservedUsageSummary');
    expect(source).toContain('leadingError');
    expect(source).toContain('requests in the last 24h');
  });
});
