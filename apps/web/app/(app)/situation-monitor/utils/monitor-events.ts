export const SITUATION_MONITOR_MONITORS_UPDATED_EVENT =
  "situation-monitor:monitors-updated";

export type SituationMonitorMonitorsUpdatedSource =
  | "legacy-import"
  | "item-detail"
  | "monitors-panel"
  | "subscriptions"
  | "unknown";

export function getSituationMonitorMonitorsUpdatedSource(event: Event) {
  return (
    (event as CustomEvent<{ source?: SituationMonitorMonitorsUpdatedSource }>)
      .detail?.source ?? "unknown"
  );
}

export function emitSituationMonitorMonitorsUpdated(
  source: SituationMonitorMonitorsUpdatedSource = "unknown",
) {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent(SITUATION_MONITOR_MONITORS_UPDATED_EVENT, {
      detail: { source },
    }),
  );
}
