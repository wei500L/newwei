import { describe, expect, it } from "vitest";

import { AlertMetricProvider } from "@/graphql/generated";

import {
  ALERT_URL_DEFAULT_PAGE,
  ALERT_URL_DEFAULT_PAGE_SIZE,
  DEFAULT_ALERT_CENTER_URL_STATE,
  parseAlertCenterUrlState,
  resolveAlertUrlCustomRangeMs,
  serializeAlertCenterUrlState,
  toAlertUrlCustomRange,
} from "./alert-center-url-state";

function stateFrom(url: string): ReturnType<typeof parseAlertCenterUrlState> {
  const [, query = ""] = url.split("?");
  return parseAlertCenterUrlState(new URLSearchParams(query));
}

function queryAfter(
  state: Parameters<typeof serializeAlertCenterUrlState>[0],
  baseUrl = "",
): string {
  const [, query = ""] = baseUrl.split("?");
  const params = new URLSearchParams(query);
  serializeAlertCenterUrlState(state, params);
  return params.toString();
}

describe("parseAlertCenterUrlState", () => {
  it("默认 URL 解析为全默认状态", () => {
    expect(stateFrom("/alerts")).toEqual(DEFAULT_ALERT_CENTER_URL_STATE);
    expect(stateFrom("/alerts?")).toEqual(DEFAULT_ALERT_CENTER_URL_STATE);
  });

  it("完整 URL 恢复所有字段", () => {
    const state = stateFrom(
      "/alerts?severity=high&severity=low&status=pending&provider=economic_anomaly" +
        "&q=cpi&range=custom&from=2026-06-01&to=2026-06-30&page=3&pageSize=50&eventId=e-9",
    );
    expect(state).toEqual({
      severities: ["high", "low"],
      statuses: ["pending"],
      providers: [AlertMetricProvider.EconomicAnomaly],
      ruleKeyword: "cpi",
      datePreset: "custom",
      customFrom: "2026-06-01",
      customTo: "2026-06-30",
      page: 3,
      pageSize: 50,
      eventId: "e-9",
    });
  });

  it("数组参数：未知值过滤、去重、稳定排序", () => {
    const state = stateFrom(
      "/alerts?severity=high&severity=critical&severity=low&severity=high",
    );
    expect(state.severities).toEqual(["high", "low"]);
  });

  it("非法 enum 回退默认：range 未知 → 30d", () => {
    expect(stateFrom("/alerts?range=all").datePreset).toBe("30d");
  });

  it("非法 page / pageSize 回退：page<1 → 1；pageSize 40 → 30", () => {
    expect(stateFrom("/alerts?page=0").page).toBe(1);
    expect(stateFrom("/alerts?page=-3").page).toBe(ALERT_URL_DEFAULT_PAGE);
    expect(stateFrom("/alerts?page=abc").page).toBe(ALERT_URL_DEFAULT_PAGE);
    expect(stateFrom("/alerts?pageSize=40").pageSize).toBe(
      ALERT_URL_DEFAULT_PAGE_SIZE,
    );
    expect(stateFrom("/alerts?pageSize=20").pageSize).toBe(20);
  });

  it("range=custom 保留瞬态：日期缺失/非法/反向时 from/to 置空（不整体回退 30d）", () => {
    // 「custom 已选、日期未选」是合法瞬态：若 parse 整体回退 30d，
    // useUrlState 的 URL 回声采纳会把刚选的 custom 立即弹回 30d
    const transient = stateFrom("/alerts?range=custom");
    expect(transient.datePreset).toBe("custom");
    expect(transient.customFrom).toBeNull();
    expect(transient.customTo).toBeNull();
    expect(
      stateFrom("/alerts?range=custom&from=2026/06/01&to=2026-06-30").datePreset,
    ).toBe("custom");
    expect(
      stateFrom("/alerts?range=custom&from=2026-02-31&to=2026-06-30").datePreset,
    ).toBe("custom");
    const reversed = stateFrom(
      "/alerts?range=custom&from=2026-06-30&to=2026-06-01",
    );
    expect(reversed.datePreset).toBe("custom");
    expect(reversed.customFrom).toBeNull();
    expect(reversed.customTo).toBeNull();
    expect(
      stateFrom("/alerts?range=custom&to=2026-06-30").datePreset,
    ).toBe("custom");
    // 合法 custom
    const valid = stateFrom("/alerts?range=custom&from=2026-06-01&to=2026-06-30");
    expect(valid.datePreset).toBe("custom");
    expect(valid.customFrom).toBe("2026-06-01");
    expect(valid.customTo).toBe("2026-06-30");
  });

  it("eventId 空串按默认处理（null）", () => {
    expect(stateFrom("/alerts?eventId=").eventId).toBeNull();
    expect(stateFrom("/alerts?eventId=e-1").eventId).toBe("e-1");
  });

  it("rule keyword 读取时 trim", () => {
    expect(stateFrom("/alerts?q=%20%20cpi%20%20").ruleKeyword).toBe("cpi");
  });
});

describe("serializeAlertCenterUrlState", () => {
  it("默认状态序列化为空 query（默认值不写入）", () => {
    expect(queryAfter(DEFAULT_ALERT_CENTER_URL_STATE)).toBe("");
  });

  it("非默认值写入；未知参数原样保留", () => {
    const query = queryAfter(
      { ...DEFAULT_ALERT_CENTER_URL_STATE, page: 3, eventId: "e-9" },
      "/alerts?foo=bar",
    );
    expect(query).toBe("foo=bar&page=3&eventId=e-9");
  });

  it("custom 序列化 from/to；非 custom 清理 from/to", () => {
    const customQuery = queryAfter({
      ...DEFAULT_ALERT_CENTER_URL_STATE,
      datePreset: "custom",
      customFrom: "2026-06-01",
      customTo: "2026-06-30",
    });
    expect(customQuery).toContain("range=custom");
    expect(customQuery).toContain("from=2026-06-01");
    expect(customQuery).toContain("to=2026-06-30");

    const presetQuery = queryAfter(
      { ...DEFAULT_ALERT_CENTER_URL_STATE, datePreset: "7d" },
      "/alerts?from=2026-06-01&to=2026-06-30",
    );
    expect(presetQuery).toBe("range=7d");
  });

  it("round-trip：serialize(parse(url)) 自身参数保持等价", () => {
    const url =
      "severity=high&severity=low&status=confirmed&provider=realtime_signal" +
      "&q=cpi&range=custom&from=2026-06-01&to=2026-06-30&page=4&pageSize=100&eventId=e-2";
    const state = parseAlertCenterUrlState(new URLSearchParams(url));
    const roundTrip = queryAfter(state);
    const reparsed = parseAlertCenterUrlState(new URLSearchParams(roundTrip));
    expect(reparsed).toEqual(state);

    // custom 无日期瞬态同样 round-trip 稳定（range=custom 不带 from/to）
    const transient = parseAlertCenterUrlState(
      new URLSearchParams("range=custom"),
    );
    const transientRoundTrip = queryAfter(transient);
    expect(transientRoundTrip).toBe("range=custom");
    expect(
      parseAlertCenterUrlState(new URLSearchParams(transientRoundTrip)),
    ).toEqual(transient);
  });

  it("custom 无日期（瞬态）序列化为 range=custom，不写 from/to", () => {
    const query = queryAfter({
      ...DEFAULT_ALERT_CENTER_URL_STATE,
      datePreset: "custom",
      customFrom: null,
      customTo: null,
    });
    expect(query).toBe("range=custom");
  });
});

describe("custom range 毫秒 ↔ URL 日期转换", () => {
  it("resolveAlertUrlCustomRangeMs：合法 custom → [from, to] 毫秒", () => {
    const range = resolveAlertUrlCustomRangeMs({
      ...DEFAULT_ALERT_CENTER_URL_STATE,
      datePreset: "custom",
      customFrom: "2026-06-01",
      customTo: "2026-06-03",
    });
    expect(range).toEqual([
      new Date("2026-06-01T00:00:00").getTime(),
      new Date("2026-06-03T00:00:00").getTime(),
    ]);
  });

  it("resolveAlertUrlCustomRangeMs：非 custom 或缺失返回 null", () => {
    expect(resolveAlertUrlCustomRangeMs(DEFAULT_ALERT_CENTER_URL_STATE)).toBeNull();
    expect(
      resolveAlertUrlCustomRangeMs({
        ...DEFAULT_ALERT_CENTER_URL_STATE,
        datePreset: "custom",
        customFrom: null,
        customTo: null,
      }),
    ).toBeNull();
  });

  it("toAlertUrlCustomRange：毫秒 → YYYY-MM-DD", () => {
    expect(
      toAlertUrlCustomRange([
        new Date("2026-06-01T08:30:00").getTime(),
        new Date("2026-06-03T20:00:00").getTime(),
      ]),
    ).toEqual({ from: "2026-06-01", to: "2026-06-03" });
    expect(toAlertUrlCustomRange(null)).toEqual({ from: null, to: null });
    expect(toAlertUrlCustomRange([null, null])).toEqual({
      from: null,
      to: null,
    });
  });
});
