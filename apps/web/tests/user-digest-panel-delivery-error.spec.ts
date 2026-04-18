import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..');

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), 'utf8');

describe('user digest panel delivery error handling', () => {
  it('keeps delivery settings load errors out of the main digest error state', () => {
    const source = read('app/(app)/today/user-digest-panel.tsx');

    expect(source).toContain(
      'const [deliveryErrorMessage, setDeliveryErrorMessage] = useState<string | null>(null);',
    );
    expect(source).toContain('setDeliveryErrorMessage(null);');
    expect(source).toContain('setDeliveryErrorMessage(');
    expect(source).toContain('message={deliveryErrorMessage}');
    expect(source).not.toContain('setErrorMessage(t("pages.digest.deliveryLoadFailed"');
  });
});
