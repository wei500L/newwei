import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..');

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), 'utf8');

describe('item detail payload wiring', () => {
  it('controls payload panel state and resets it only when the item changes', () => {
    const source = read('app/(app)/items/[id]/item-detail.tsx');

    expect(source).toContain('const [activePayloadKeys, setActivePayloadKeys] = useState<string[]>([]);');
    expect(source).toContain('setActivePayloadKeys([]);');
    expect(source).toContain('activeKey={activePayloadPanelKeys}');
    expect(source).toContain('onChange={handlePayloadCollapseChange}');
  });
});
