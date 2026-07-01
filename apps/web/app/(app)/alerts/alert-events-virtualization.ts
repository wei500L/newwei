export const ALERT_EVENTS_VIRTUALIZATION_THRESHOLD = 25;
export const ALERT_EVENT_ROW_ESTIMATE_PX = 190;

export function shouldVirtualizeAlertEvents(eventCount: number): boolean {
  return eventCount > ALERT_EVENTS_VIRTUALIZATION_THRESHOLD;
}

export function shouldUpdateAlertEventsMetric(
  previousValue: number,
  nextValue: number,
): boolean {
  if (!Number.isFinite(nextValue)) {
    return false;
  }
  return Math.abs(previousValue - nextValue) > 1;
}
