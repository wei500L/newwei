import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..');

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), 'utf8');

describe('dashboard refresh feedback wiring', () => {
  it('provides a shared pending-action hook for manual refresh buttons', () => {
    const source = read('hooks/use-pending-action.ts');

    expect(source).toContain('export function usePendingAction');
    expect(source).toContain('const [pending, setPending] = useState(false);');
    expect(source).toContain('const promise = Promise.resolve(actionRef.current(...args)).finally(() => {');
    expect(source).toContain('return { pending, run };');
  });

  it('threads action loading through shared request error helpers', () => {
    const requestErrorBannerSource = read('components/request-error-banner.tsx');
    const requestErrorStateSource = read('lib/request-error-empty-state.tsx');
    const chartDataMetaSource = read('components/chart-data-meta.tsx');
    const chartStateBannerSource = read('components/chart-state-banner.tsx');
    const dashboardChartCardSource = read('components/dashboard-chart-card.tsx');

    expect(requestErrorBannerSource).toContain('actionLoading?: boolean;');
    expect(requestErrorBannerSource).toContain('actionLoading={state.actionLoading}');
    expect(requestErrorBannerSource).toContain('dashboard.actions.retryFetch');
    expect(requestErrorStateSource).toContain('actionLoading?: boolean;');
    expect(requestErrorStateSource).toContain('actionLabelOverride?: string;');
    expect(requestErrorStateSource).toContain('...(typeof actionLoading === "boolean" ? { actionLoading } : {}),');
    expect(chartDataMetaSource).toContain('dashboard.actions.fetchLatestTooltip');
    expect(chartStateBannerSource).toContain('dashboard.actions.fetchLatest');
    expect(chartStateBannerSource).toContain('dashboard.actions.retryFetch');
    expect(dashboardChartCardSource).toContain('dashboard.actions.retryFetch');
  });

  it('wires manual refresh loading across remaining dashboard retry entry points', () => {
    const files = [
      'app/(app)/dashboard/analysis-panel.tsx',
      'app/(app)/dashboard/alert-panel.tsx',
      'app/(app)/dashboard/components/analysis-stream.tsx',
      'app/(app)/dashboard/dashboard-content.tsx',
      'app/(app)/dashboard/drilldown-chart.tsx',
      'app/(app)/dashboard/spacetime-viz.tsx',
      'app/(app)/dashboard/charts/widget-renderer.tsx',
      'app/(app)/dashboard/charts/sector-heatmap.tsx',
      'app/(app)/dashboard/charts/financial-candlestick.tsx',
      'app/(app)/dashboard/charts/entity-impact-graph.tsx',
      'app/(app)/dashboard/charts/knowledge-graph.tsx',
      'app/(app)/dashboard/charts/knowledge-graph-3d.tsx',
      'app/(app)/dashboard/charts/spacetime-propagation.tsx',
      'app/(app)/dashboard/charts/spacetime-geo-heatmap.tsx',
      'app/(app)/dashboard/charts/war-map/war-map.tsx',
    ];

    for (const file of files) {
      const source = read(file);

      expect(source).toContain('usePendingAction');
      expect(
        source.includes('actionLoading=') || source.includes('loading={refreshing'),
      ).toBe(true);
    }
  });
});
