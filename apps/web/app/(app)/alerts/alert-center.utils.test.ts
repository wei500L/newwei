import { describe, expect, it } from "vitest";

import { AlertMetricProvider } from "@/graphql/generated";

import { buildAlertEvent } from "./alert-center-test-support";
import {
  buildAlertExportJson,
  buildAlertExportRows,
  buildAlertStats,
  buildSimilarAlerts,
  filterAlertEvents,
  resolveAlertCenterAccess,
  resolveFilterTimeWindow,
  resolveSelectedEventId,
  type AlertFilterState,
  type AlertTimeWindow,
} from "./alert-center.utils";

const NO_WINDOW: AlertTimeWindow = { startMs: null, endMs: null };

const ALL_FILTER: AlertFilterState = {
  severities: [],
  statuses: [],
  providers: [],
  ruleKeyword: "",
  datePreset: "30d",
  customRangeMs: null,
};

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

describe("resolveAlertCenterAccess 权限派生（单一来源）", () => {
  it("authenticated + alerts.read 才允许查询", () => {
    expect(resolveAlertCenterAccess("authenticated", ["alerts.read"])).toEqual({
      authenticated: true,
      canReadAlerts: true,
      shouldQueryEvents: true,
    });
    expect(resolveAlertCenterAccess("authenticated", [])).toEqual({
      authenticated: true,
      canReadAlerts: false,
      shouldQueryEvents: false,
    });
    expect(resolveAlertCenterAccess("loading", ["alerts.read"])).toEqual({
      authenticated: false,
      canReadAlerts: true,
      shouldQueryEvents: false,
    });
    expect(resolveAlertCenterAccess("unauthenticated", ["alerts.read"])).toEqual({
      authenticated: false,
      canReadAlerts: true,
      shouldQueryEvents: false,
    });
  });
});

describe("resolveSelectedEventId 选择优先级", () => {
  const newest = buildAlertEvent({ id: "newest", triggeredAt: minutesAgo(1) });
  const middle = buildAlertEvent({ id: "middle", triggeredAt: minutesAgo(2) });
  const oldest = buildAlertEvent({ id: "oldest", triggeredAt: minutesAgo(3) });
  const sortedEvents = [newest, middle, oldest];
  const filteredEvents = [middle];

  it("无事件时返回 null", () => {
    expect(
      resolveSelectedEventId({
        eventParam: null,
        selectedEventId: null,
        sortedEvents: [],
        filteredEvents: [],
      }),
    ).toBeNull();
  });

  it("合法 URL eventId 优先", () => {
    expect(
      resolveSelectedEventId({
        eventParam: "oldest",
        selectedEventId: "middle",
        sortedEvents,
        filteredEvents,
      }),
    ).toBe("oldest");
  });

  it("URL 无效时保留仍存在的当前选中", () => {
    expect(
      resolveSelectedEventId({
        eventParam: "missing",
        selectedEventId: "oldest",
        sortedEvents,
        filteredEvents,
      }),
    ).toBe("oldest");
  });

  it("否则回退筛选结果首项，再回退全部事件首项", () => {
    expect(
      resolveSelectedEventId({
        eventParam: "missing",
        selectedEventId: "missing",
        sortedEvents,
        filteredEvents,
      }),
    ).toBe("middle");
    expect(
      resolveSelectedEventId({
        eventParam: "missing",
        selectedEventId: "missing",
        sortedEvents,
        filteredEvents: [],
      }),
    ).toBe("newest");
  });
});

describe("filterAlertEvents 筛选语义", () => {
  it("severity 筛选", () => {
    const events = [
      buildAlertEvent({ id: "a", severity: "high" }),
      buildAlertEvent({ id: "b", severity: "low" }),
    ];
    const result = filterAlertEvents(
      events,
      { ...ALL_FILTER, severities: ["high"] },
      NO_WINDOW,
    );
    expect(result.map((event) => event.id)).toEqual(["a"]);
  });

  it("status 筛选", () => {
    const events = [
      buildAlertEvent({ id: "a", status: "confirmed" }),
      buildAlertEvent({ id: "b", status: "pending" }),
    ];
    const result = filterAlertEvents(
      events,
      { ...ALL_FILTER, statuses: ["pending", "ignored"] },
      NO_WINDOW,
    );
    expect(result.map((event) => event.id)).toEqual(["b"]);
  });

  it("provider 筛选：缺失 provider 的事件被排除", () => {
    const events = [
      buildAlertEvent({
        id: "a",
        metricProvider: AlertMetricProvider.EconomicAnomaly,
      }),
      buildAlertEvent({ id: "b", metricProvider: null }),
    ];
    const result = filterAlertEvents(
      events,
      {
        ...ALL_FILTER,
        providers: [AlertMetricProvider.EconomicAnomaly, AlertMetricProvider.RealtimeSignal],
      },
      NO_WINDOW,
    );
    expect(result.map((event) => event.id)).toEqual(["a"]);
  });

  it("rule keyword：大小写不敏感、按规则名包含匹配、空白忽略", () => {
    const events = [
      buildAlertEvent({ id: "a", ruleName: "CPI Weekly Spike" }),
      buildAlertEvent({ id: "b", ruleName: "Sentiment Drift" }),
    ];
    const result = filterAlertEvents(
      events,
      { ...ALL_FILTER, ruleKeyword: "  cpi weekly  " },
      NO_WINDOW,
    );
    expect(result.map((event) => event.id)).toEqual(["a"]);
  });

  it("时间窗口：窗口外事件被排除", () => {
    const now = Date.now();
    const events = [
      buildAlertEvent({ id: "in", triggeredAt: new Date(now - 60_000).toISOString() }),
      buildAlertEvent({ id: "out", triggeredAt: new Date(now - 10 * 86_400_000).toISOString() }),
    ];
    const result = filterAlertEvents(events, ALL_FILTER, {
      startMs: now - 86_400_000,
      endMs: now,
    });
    expect(result.map((event) => event.id)).toEqual(["in"]);
  });
});

describe("resolveFilterTimeWindow 时间窗口派生", () => {
  const now = new Date("2026-06-15T12:34:56");

  it("today：当天起止", () => {
    const window = resolveFilterTimeWindow(
      { ...ALL_FILTER, datePreset: "today" },
      now,
    );
    expect(window.startMs).toBe(
      new Date("2026-06-15T00:00:00").getTime(),
    );
    expect(window.endMs).toBe(new Date("2026-06-15T23:59:59.999").getTime());
  });

  it("7d/30d：含当天的向前 7/30 个自然日", () => {
    const week = resolveFilterTimeWindow(
      { ...ALL_FILTER, datePreset: "7d" },
      now,
    );
    expect(week.startMs).toBe(new Date("2026-06-09T00:00:00").getTime());

    const month = resolveFilterTimeWindow(
      { ...ALL_FILTER, datePreset: "30d" },
      now,
    );
    expect(month.startMs).toBe(new Date("2026-05-17T00:00:00").getTime());
  });

  it("custom：合法区间按整天展开", () => {
    const window = resolveFilterTimeWindow(
      {
        ...ALL_FILTER,
        datePreset: "custom",
        customRangeMs: [
          new Date("2026-06-01T08:00:00").getTime(),
          new Date("2026-06-03T20:00:00").getTime(),
        ],
      },
      now,
    );
    expect(window.startMs).toBe(new Date("2026-06-01T00:00:00").getTime());
    expect(window.endMs).toBe(new Date("2026-06-03T23:59:59.999").getTime());
  });

  it("custom 缺失或未完成时窗口为空（不过滤时间）", () => {
    expect(
      resolveFilterTimeWindow(
        { ...ALL_FILTER, datePreset: "custom", customRangeMs: null },
        now,
      ),
    ).toEqual({ startMs: null, endMs: null });
    expect(
      resolveFilterTimeWindow(
        {
          ...ALL_FILTER,
          datePreset: "custom",
          customRangeMs: [new Date("2026-06-01").getTime(), null],
        },
        now,
      ),
    ).toEqual({ startMs: null, endMs: null });
  });
});

describe("buildAlertStats 统计派生", () => {
  it("total/pending/confirmed/ignored 与误报率", () => {
    const events = [
      buildAlertEvent({ id: "a", status: "confirmed" }),
      buildAlertEvent({ id: "b", status: "ignored" }),
      buildAlertEvent({ id: "c", status: "ignored" }),
      buildAlertEvent({ id: "d", status: "pending" }),
      buildAlertEvent({ id: "e", status: "delivered" }),
      buildAlertEvent({ id: "f", status: "failed" }),
    ];
    expect(buildAlertStats(events)).toEqual({
      total: 6,
      pending: 3,
      confirmed: 1,
      ignored: 2,
      falsePositiveRate: 2 / 3,
    });
  });

  it("无复核时误报率为 null", () => {
    const events = [buildAlertEvent({ id: "a", status: "pending" })];
    expect(buildAlertStats(events).falsePositiveRate).toBeNull();
  });
});

describe("buildSimilarAlerts 相似告警派生", () => {
  it("同规则优先于同指标，按时间距离排序", () => {
    const base = Date.now();
    const selected = buildAlertEvent({
      id: "selected",
      ruleId: "r1",
      metricProvider: AlertMetricProvider.EconomicAnomaly,
      metricSlug: "cpi",
      triggeredAt: new Date(base - 60_000).toISOString(),
    });
    const sameMetric = buildAlertEvent({
      id: "same-metric",
      ruleId: "r2",
      metricProvider: AlertMetricProvider.EconomicAnomaly,
      metricSlug: "cpi",
      triggeredAt: new Date(base - 120_000).toISOString(),
    });
    const sameRule = buildAlertEvent({
      id: "same-rule",
      ruleId: "r1",
      metricProvider: AlertMetricProvider.SystemMetric,
      metricSlug: "other",
      triggeredAt: new Date(base - 180_000).toISOString(),
    });
    const unrelated = buildAlertEvent({
      id: "unrelated",
      ruleId: "r3",
      metricProvider: AlertMetricProvider.RealtimeSignal,
      metricSlug: "signal",
      triggeredAt: new Date(base - 30_000).toISOString(),
    });

    const result = buildSimilarAlerts(selected, [sameMetric, sameRule, unrelated], 5);
    expect(result.map((item) => item.event.id)).toEqual(["same-rule", "same-metric"]);
    expect(result[0]!.reason).toBe("same_rule");
    expect(result[1]!.reason).toBe("same_metric");
  });
});

describe("导出行构造（includeRaw 语义）", () => {
  const event = buildAlertEvent({
    id: "export-1",
    context: { sourceName: "feed" },
  });

  it("默认不含 context/deliveries 列", () => {
    const rows = buildAlertExportRows([event]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).not.toContain("context");
    expect(rows[0]).not.toContain("deliveries");
    expect(rows[1]![0]).toBe("export-1");
  });

  it("includeRawExport 同时包含 context 与 deliveries 列", () => {
    const rows = buildAlertExportRows([event], {
      includeContext: true,
      includeDeliveries: true,
    });
    expect(rows[0]).toContain("context");
    expect(rows[0]).toContain("deliveries");
    expect(rows[1]!.length).toBe(rows[0]!.length);

    const json = buildAlertExportJson([event], {
      includeContext: true,
      includeDeliveries: true,
    });
    expect(json[0]).toMatchObject({ id: "export-1" });
    expect(json[0]).toHaveProperty("context");
    expect(json[0]).toHaveProperty("deliveries");
  });
});
