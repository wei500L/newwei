"use client";

import { NetworkStatus } from "@apollo/client";
import { useMemo } from "react";
import { useSession } from "next-auth/react";

import type { DashboardHeroMetricsQuery, DashboardHeroMetricsQueryVariables } from "@/graphql/generated";
import { useDashboardHeroMetricsQuery } from "@/graphql/generated";

import {
  pickCoarsestGranularity,
  pickFinestGranularity,
  timeGranularityToUiGranularity,
  UiTimeGranularity,
} from "./time-granularity";

export const HERO_METRICS_PERMISSION = "economicdata.read";
export const HERO_METRICS_REFRESH_INTERVAL_MS = 60_000;

type SessionStatus = "authenticated" | "loading" | "unauthenticated";
type HeroMetricsQueryData = Pick<
  DashboardHeroMetricsQuery,
  "conflict" | "market" | "resource" | "supply"
>;

export interface HeroMetricsAccessState {
  canQuery: boolean;
  kind: "available" | "forbidden" | "loading" | "unauthenticated";
}

export interface HeroMetricsGranularityInfo {
  coarsest: UiTimeGranularity;
  range: {
    coarsest: UiTimeGranularity;
    finest: UiTimeGranularity;
  } | null;
}

export interface UseHeroMetricsOptions {
  end: Date;
  refreshIntervalMs?: number;
  start: Date;
}

function getHeroMetricSeries(data: HeroMetricsQueryData | null | undefined) {
  return [
    data?.conflict ?? [],
    data?.market ?? [],
    data?.resource ?? [],
    data?.supply ?? [],
  ];
}

export function getSessionPermissions(
  session:
    | {
        permissions?: string[];
        user?: {
          permissions?: string[];
        };
      }
    | null
    | undefined,
) {
  return session?.permissions ?? session?.user?.permissions ?? [];
}

export function canReadHeroMetrics(permissions: readonly string[]) {
  return permissions.includes(HERO_METRICS_PERMISSION);
}

export function getHeroMetricsAccessState(
  status: SessionStatus,
  permissions: readonly string[],
): HeroMetricsAccessState {
  if (status === "loading") {
    return { canQuery: false, kind: "loading" };
  }

  if (status !== "authenticated") {
    return { canQuery: false, kind: "unauthenticated" };
  }

  if (!canReadHeroMetrics(permissions)) {
    return { canQuery: false, kind: "forbidden" };
  }

  return { canQuery: true, kind: "available" };
}

export function hasHeroMetricsData(data: HeroMetricsQueryData | null | undefined) {
  return getHeroMetricSeries(data).some((series) => series.length > 0);
}

export function getHeroMetricsGranularityInfo(
  data: HeroMetricsQueryData | null | undefined,
): HeroMetricsGranularityInfo {
  const effectiveGranularities = getHeroMetricSeries(data)
    .flat()
    .map((point) => timeGranularityToUiGranularity(point.effectiveGranularity));
  const coarsest = pickCoarsestGranularity(effectiveGranularities);
  const finest = pickFinestGranularity(effectiveGranularities);

  return {
    coarsest,
    range:
      coarsest !== UiTimeGranularity.Unknown &&
      finest !== UiTimeGranularity.Unknown &&
      coarsest !== finest
        ? { coarsest, finest }
        : null,
  };
}

export function createHeroMetricsVariables(
  start: Date,
  end: Date,
): DashboardHeroMetricsQueryVariables {
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    granularity: null,
  };
}

export function useHeroMetrics({
  end,
  refreshIntervalMs = HERO_METRICS_REFRESH_INTERVAL_MS,
  start,
}: UseHeroMetricsOptions) {
  const { data: session, status } = useSession();
  const permissions = getSessionPermissions(session);
  const accessState = getHeroMetricsAccessState(status, permissions);
  const variables = useMemo(() => createHeroMetricsVariables(start, end), [end, start]);

  const query = useDashboardHeroMetricsQuery(
    accessState.canQuery
      ? {
          variables,
          fetchPolicy: "cache-and-network",
          nextFetchPolicy: "cache-first",
          notifyOnNetworkStatusChange: true,
          pollInterval: refreshIntervalMs,
        }
      : {
          skip: true,
          notifyOnNetworkStatusChange: true,
        },
  );

  const resolvedData = accessState.canQuery ? query.data ?? query.previousData ?? null : null;
  const hasData = hasHeroMetricsData(resolvedData);
  const networkStatus = query.networkStatus;
  const loading =
    accessState.kind === "loading" ||
    (accessState.canQuery &&
      !hasData &&
      (query.loading ||
        networkStatus === NetworkStatus.loading ||
        networkStatus === NetworkStatus.setVariables));
  const refreshing =
    accessState.canQuery &&
    hasData &&
    (networkStatus === NetworkStatus.poll ||
      networkStatus === NetworkStatus.refetch ||
      networkStatus === NetworkStatus.setVariables);
  const updating =
    accessState.kind === "loading" ||
    (accessState.canQuery &&
      (networkStatus === NetworkStatus.loading ||
        networkStatus === NetworkStatus.refetch ||
        networkStatus === NetworkStatus.setVariables));
  const granularityInfo = useMemo(
    () => getHeroMetricsGranularityInfo(resolvedData),
    [resolvedData],
  );

  return {
    accessState,
    data: resolvedData,
    error: accessState.canQuery ? query.error : undefined,
    granularityInfo,
    hasData,
    loading,
    permissions,
    refreshing,
    refetch: query.refetch,
    updating,
    variables,
  };
}
