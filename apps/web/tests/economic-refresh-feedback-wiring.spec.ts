import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..');

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), 'utf8');

describe('economic refresh feedback wiring', () => {
  it('derives manual refresh state from the shared economic data hook', () => {
    const source = read('hooks/useEconomicData.ts');
    const queryStateSource = read('lib/economic-query-state.ts');

    expect(source).toContain('const { data: session, status: sessionStatus } = useSession();');
    expect(source).toContain('const permissions = session?.permissions ?? session?.user?.permissions ?? [];');
    expect(source).toContain('const canQuery =');
    expect(source).toContain('const variables = useMemo(');
    expect(source).toContain('skip: true');
    expect(source).toContain('notifyOnNetworkStatusChange: true');
    expect(source).toContain('resolveEconomicQueryData({');
    expect(source).toContain('sessionStatus === "loading" ||');
    expect(source).toContain('networkStatus === NetworkStatus.setVariables ||');
    expect(source).toContain('const refreshing = canQuery && isEconomicQueryRefreshing(networkStatus);');
    expect(source).toContain('refreshing,');
    expect(queryStateSource).toContain('return data ?? previousData ?? null;');
    expect(queryStateSource).toContain('networkStatus === NetworkStatus.refetch || networkStatus === NetworkStatus.setVariables');
  });

  it('threads refresh loading through shared chart state components', () => {
    const chartDataMetaSource = read('components/chart-data-meta.tsx');
    const chartStateBannerSource = read('components/chart-state-banner.tsx');
    const chartEmptyStateSource = read('components/chart-empty-state.tsx');

    expect(chartDataMetaSource).toContain('refreshing?: boolean;');
    expect(chartDataMetaSource).toContain('loading={refreshing}');
    expect(chartStateBannerSource).toContain('refreshing?: boolean;');
    expect(chartStateBannerSource).toContain('actionLoading={refreshing}');
    expect(chartEmptyStateSource).toContain('actionLoading?: boolean;');
    expect(chartEmptyStateSource).toContain('loading={actionLoading}');
  });

  it('passes refreshing into card meta and delayed banners across economic dashboards', () => {
    const pages = [
      'app/(app)/dashboard/economic-short/page.tsx',
      'app/(app)/dashboard/economic-medium/page.tsx',
      'app/(app)/dashboard/economic-long/page.tsx',
      'app/(app)/dashboard/economic-alert/page.tsx',
      'app/(app)/dashboard/livelihood-prices/page.tsx',
      'app/(app)/dashboard/key-monitor/page.tsx',
      'app/(app)/dashboard/military-alert/page.tsx',
    ];

    for (const page of pages) {
      const source = read(page);
      const refreshingMatches = source.match(/refreshing=\{refreshing\}/g) ?? [];

      expect(source).toContain('refreshing,');
      expect(refreshingMatches).toHaveLength(2);
    }
  });

  it('passes explicit loading into economic dashboard time range controls', () => {
    const timeRangeControlsSource = read('components/time-range-controls.tsx');

    expect(timeRangeControlsSource).toContain('loading?: boolean;');
    expect(timeRangeControlsSource).toContain('showAggregationLoading =');
    expect(timeRangeControlsSource).toContain('loading && backendGranularityEnabled && !hasResolvedGranularity');

    const pages = [
      'app/(app)/dashboard/economic-short/page.tsx',
      'app/(app)/dashboard/economic-medium/page.tsx',
      'app/(app)/dashboard/economic-long/page.tsx',
      'app/(app)/dashboard/economic-alert/page.tsx',
      'app/(app)/dashboard/livelihood-prices/page.tsx',
      'app/(app)/dashboard/key-monitor/page.tsx',
      'app/(app)/dashboard/military-alert/page.tsx',
    ];

    for (const page of pages) {
      const source = read(page);
      expect(source).toContain('loading={loading}');
    }
  });
});
