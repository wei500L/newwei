import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..');

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), 'utf8');

describe('assistant quick action wiring', () => {
  it('keeps quick report modal-based while preventing composer blur from swallowing the click', () => {
    const source = read('app/(app)/assistant/assistant-content.tsx');

    expect(source).toContain("const quickActionPointerDownRef = useRef(false);");
    expect(source).toContain('!reportModalOpen &&');
    expect(source).toContain('!forecastModalOpen &&');
    expect(source).toContain('!quickActionPointerDownRef.current');
    expect(source).toContain('onMouseDown={(event) => {');
    expect(source).toContain("setReportModalOpen(true);");
  });
});
