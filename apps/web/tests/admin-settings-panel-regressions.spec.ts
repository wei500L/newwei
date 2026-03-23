import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..');

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), 'utf8');

describe('admin settings panel regressions', () => {
  it('scopes affected settings forms with stable unique names', () => {
    const rateLimitSource = read('components/settings/rate-limit-policies-panel.tsx');
    const llmGatewaySource = read('components/settings/llm-gateway-settings-panel.tsx');
    const emailSource = read('components/settings/email-settings-panel.tsx');
    const geoSource = read('components/settings/geo-nominatim-settings-panel.tsx');
    const personalizationSource = read(
      'components/settings/newsnow-personalization-settings-panel.tsx',
    );

    expect(rateLimitSource).toContain('name="rate-limit-policy-create"');
    expect(rateLimitSource).toContain('name="rate-limit-policy-edit"');
    expect(llmGatewaySource).toContain('name="llm-gateway-create"');
    expect(llmGatewaySource).toContain('name="llm-gateway-edit"');
    expect(llmGatewaySource).toContain('name="llm-gateway-test"');
    expect(emailSource).toContain('name="email-auth-code-settings"');
    expect(emailSource).toContain('name="email-test-settings"');
    expect(geoSource).toContain('name="geo-nominatim-settings"');
    expect(geoSource).toContain('name="geo-nominatim-test"');
    expect(personalizationSource).toContain(
      'name="newsnow-personalization-settings"',
    );
  });

  it('uses explicit confirmation for clearing NewsNow behavior profiles', () => {
    const source = read('components/settings/newsnow-personalization-settings-panel.tsx');

    expect(source).toContain('const confirmClearBehaviorProfile = useCallback(() => {');
    expect(source).toContain('Modal.confirm({');
    expect(source).toContain('onClick={confirmClearBehaviorProfile}');
  });

  it('submits knowledge graph approvals directly from the approve action', () => {
    const source = read('components/settings/knowledge-graph-review-panel.tsx');

    expect(source).toContain('const [quickReviewingId, setQuickReviewingId] = useState<string | null>(null);');
    expect(source).toContain('void applyReview({');
    expect(source).toContain('status: "approved"');
    expect(source).toContain('quick: true');
    expect(source).toContain('loading={quickReviewingId === row.id}');
    expect(source).toContain('name="knowledge-graph-review-form"');
  });
});
