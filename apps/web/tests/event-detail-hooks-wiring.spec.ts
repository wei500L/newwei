import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..');

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), 'utf8');

describe('event detail hook wiring', () => {
  it('keeps the event view tracking effect before early-return guards', () => {
    const source = read('app/(app)/events/[id]/event-detail.tsx');

    const trackingEffectIndex = source.indexOf("useEffect(() => {\n    if (!event?.id) {");
    const loadingGuardIndex = source.indexOf('if (loading && !event) {');

    expect(trackingEffectIndex).toBeGreaterThan(-1);
    expect(loadingGuardIndex).toBeGreaterThan(-1);
    expect(trackingEffectIndex).toBeLessThan(loadingGuardIndex);
    expect(source).not.toContain('trackEventBehavior({ type: "view", url: representativeUrl ?? null });');
  });
});
