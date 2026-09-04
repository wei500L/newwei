import type { WarMapTranslateFn } from "./war-map-overlay-model";
import { getErrorMessage } from "./war-map-format";

export interface WarMapLoadOverlayStateParams {
  mapLoadError: {
    title: string;
    description: string;
  } | null;
  mapReady: boolean;
  anyLoading: boolean;
  errors: unknown[];
  hasData?: boolean;
  deckCounts: {
    eventsCount: number;
    newsCount: number;
    eventClustersCount: number;
    newsClustersCount: number;
    staticVisibleCount: number;
  };
  monitorsVisible: boolean;
  monitorPointsCount: number;
  refreshingMapData: boolean;
  retryMapLoad: () => void;
  refreshMapData: () => void;
  t: WarMapTranslateFn;
}

export interface WarMapLoadOverlayState {
  showBootOverlay: boolean;
  bootOverlayLabel: string;
  hasData: boolean;
  hasFatalDataError: boolean;
  fatalOverlay: {
    title: string;
    description: string;
    actionLabel: string;
    actionLoading: boolean;
    onAction: () => void;
  } | null;
  hasFatalOverlay: boolean;
  hasNonFatalDataError: boolean;
}

/** boot/致命错误覆盖层状态派生（FE-批4A：从 war-map.tsx 迁移）。 */
export function buildWarMapLoadOverlayState(
  params: WarMapLoadOverlayStateParams,
): WarMapLoadOverlayState {
  const {
    mapLoadError,
    mapReady,
    anyLoading,
    errors,
    hasData,
    deckCounts,
    monitorsVisible,
    monitorPointsCount,
    refreshingMapData,
    retryMapLoad,
    refreshMapData,
    t,
  } = params;

  const effectiveHasData =
    hasData ??
    (deckCounts.eventsCount +
      deckCounts.newsCount +
      deckCounts.eventClustersCount +
      deckCounts.newsClustersCount +
      deckCounts.staticVisibleCount +
      (monitorsVisible ? monitorPointsCount : 0) >
      0);
  const showBootOverlay =
    !mapLoadError && (!mapReady || (anyLoading && !effectiveHasData));
  const bootOverlayLabel = !mapReady
    ? t("dashboard.charts.warMap.status.loadingMap")
    : t("dashboard.charts.warMap.status.loadingData");
  const hasFatalDataError = !anyLoading && errors.length > 0 && !effectiveHasData;
  const fatalOverlay = mapLoadError
    ? {
        title: mapLoadError.title,
        description: mapLoadError.description,
        actionLabel: t("common.retry"),
        actionLoading: false,
        onAction: retryMapLoad,
      }
    : hasFatalDataError
      ? {
          title: t("dashboard.dataAbnormal"),
          description:
            getErrorMessage(errors[0]) ?? t("common.serviceUnavailable"),
          actionLabel: t("dashboard.actions.retryFetch"),
          actionLoading: refreshingMapData,
          onAction: () => {
            refreshMapData();
          },
        }
      : null;

  return {
    showBootOverlay,
    bootOverlayLabel,
    hasData: effectiveHasData,
    hasFatalDataError,
    fatalOverlay,
    hasFatalOverlay: Boolean(fatalOverlay),
    hasNonFatalDataError: errors.length > 0 && effectiveHasData,
  };
}
