import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..');
const source = fs.readFileSync(
  path.resolve(webRoot, 'components/settings/geo-nominatim-settings-panel.tsx'),
  'utf8',
);

describe('geo nominatim test feedback wiring', () => {
  it('keeps no-result state visible instead of relying on transient toast only', () => {
    expect(source).toContain('const [testAttempted, setTestAttempted] = useState(false);');
    expect(source).toContain('setTestAttempted(true);');
    expect(source).toContain('testAttempted && !testErrorMessage && !testResult');
    expect(source).toContain('No geocoding result was returned for this query.');
  });

  it('surfaces explicit success feedback for successful test runs', () => {
    expect(source).toContain('messageApi.success(');
    expect(source).toContain('Geocoding test completed.');
  });
});
