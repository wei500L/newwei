import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..');

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), 'utf8');

describe('akshare manual refresh wiring', () => {
  it('wires the system settings panel to the preset mutation and shared preset registry', () => {
    const source = read('components/settings/akshare-gateway-settings-panel.tsx');

    expect(source).toContain('useTriggerEconomicDataRefreshPresetMutation');
    expect(source).toContain('useEconomicDataRefreshPresetStatusQuery');
    expect(source).toContain('ECONOMIC_DASHBOARD_REFRESH_PRESET_ORDER.map');
    expect(source).toContain('ECONOMIC_DASHBOARD_REFRESH_PRESET_CONFIG[selectedPreset]');
    expect(source).toContain('permissions.includes("economicdata.manage")');
    expect(source).toContain('triggerEconomicDataRefreshPreset({');
    expect(source).toContain('pollInterval: statusPolling ? 2000 : 0');
    expect(source).toContain('manualRefresh.fields.preset');
    expect(source).toContain('manualRefresh.summary.title');
  });

  it('defines dedicated GraphQL documents for preset refresh and status', () => {
    const documentSource = read('graphql/economicData.graphql');

    expect(documentSource).toContain(
      'query EconomicDataRefreshPresetStatus($preset: EconomicDashboardRefreshPreset!)'
    );
    expect(documentSource).toContain(
      'economicDataRefreshPresetStatus(preset: $preset)'
    );
    expect(documentSource).toContain(
      'mutation TriggerEconomicDataRefreshPreset($preset: EconomicDashboardRefreshPreset!)'
    );
    expect(documentSource).toContain(
      'triggerEconomicDataRefreshPreset(preset: $preset)'
    );
  });
});
