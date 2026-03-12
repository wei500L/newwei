import { NetworkStatus } from '@apollo/client';
import { describe, expect, it } from 'vitest';

import {
  isEconomicQueryRefreshing,
  resolveEconomicQueryData,
} from '../lib/economic-query-state';

describe('economic query state', () => {
  it('drops stale previous data while variables are changing', () => {
    expect(
      resolveEconomicQueryData({
        data: { source: 'current' },
        previousData: { source: 'previous' },
        networkStatus: NetworkStatus.setVariables,
      }),
    ).toBeNull();

    expect(
      resolveEconomicQueryData({
        previousData: { source: 'previous' },
        networkStatus: NetworkStatus.setVariables,
      }),
    ).toBeNull();
  });

  it('keeps the last resolved payload during refetches', () => {
    expect(
      resolveEconomicQueryData({
        previousData: { source: 'previous' },
        networkStatus: NetworkStatus.refetch,
      }),
    ).toEqual({ source: 'previous' });
  });

  it('treats refetches and variable changes as refreshing states', () => {
    expect(isEconomicQueryRefreshing(NetworkStatus.refetch)).toBe(true);
    expect(isEconomicQueryRefreshing(NetworkStatus.setVariables)).toBe(true);
    expect(isEconomicQueryRefreshing(NetworkStatus.ready)).toBe(false);
  });
});
