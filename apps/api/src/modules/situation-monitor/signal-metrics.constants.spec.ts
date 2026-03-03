import {
  SITUATION_OREF_ACTIVE_ALERTS_METRIC_SLUG,
  SITUATION_OREF_HISTORY_24H_METRIC_SLUG,
} from "@modular/utils";

import {
  SITUATION_MONITOR_DEFAULT_OREF_ALERT_RULES,
  SITUATION_MONITOR_OREF_ACTIVE_ALERTS_METRIC_SLUG,
  SITUATION_MONITOR_OREF_HISTORY_24H_METRIC_SLUG,
} from "./signal-metrics.constants";

describe("signal-metrics constants", () => {
  it("reuses shared OREF system metric slugs", () => {
    expect(SITUATION_MONITOR_OREF_ACTIVE_ALERTS_METRIC_SLUG).toBe(
      SITUATION_OREF_ACTIVE_ALERTS_METRIC_SLUG,
    );
    expect(SITUATION_MONITOR_OREF_HISTORY_24H_METRIC_SLUG).toBe(
      SITUATION_OREF_HISTORY_24H_METRIC_SLUG,
    );
  });

  it("keeps default OREF alert rules aligned with exported slugs", () => {
    expect(
      SITUATION_MONITOR_DEFAULT_OREF_ALERT_RULES.map((rule) => rule.slug),
    ).toEqual([
      SITUATION_MONITOR_OREF_ACTIVE_ALERTS_METRIC_SLUG,
      SITUATION_MONITOR_OREF_HISTORY_24H_METRIC_SLUG,
    ]);
  });
});
