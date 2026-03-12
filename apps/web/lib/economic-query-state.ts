import { NetworkStatus } from '@apollo/client';

export function resolveEconomicQueryData<T>({
  data,
  previousData,
  networkStatus,
}: {
  data?: T;
  previousData?: T;
  networkStatus: NetworkStatus;
}): T | null {
  if (networkStatus === NetworkStatus.setVariables) {
    return null;
  }

  return data ?? previousData ?? null;
}

export function isEconomicQueryRefreshing(networkStatus: NetworkStatus): boolean {
  return (
    networkStatus === NetworkStatus.refetch || networkStatus === NetworkStatus.setVariables
  );
}
