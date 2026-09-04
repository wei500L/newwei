import { AlertMetricProvider } from "@/graphql/generated";
import dayjs from "@/lib/dayjs";
import {
  isValidUrlDateRange,
  parseUrlDateParam,
  parseUrlIntChoice,
  parseUrlPositiveInt,
  parseUrlStringEnum,
  parseUrlStringSet,
  serializeUrlPositiveInt,
  serializeUrlStringSet,
  serializeUrlValue,
} from "@/lib/url-state-codec";

import type { AlertDatePreset } from "./alert-center.utils";

/**
 * Alert Center 的 URL query 契约（FE-01）：
 *
 * | 参数       | 语义                                        | 默认（不写入 URL） |
 * |-----------|---------------------------------------------|------------------|
 * | severity  | 已选 severity（重复 key，去重 + 排序）          | 空               |
 * | status    | 已选 status（重复 key，去重 + 排序）            | 空               |
 * | provider  | 已选 metric provider（重复 key，去重 + 排序）    | 空               |
 * | q         | 规则关键字（组件侧 220ms debounce 后写入）       | 空               |
 * | range     | today / 7d / 30d / custom                   | 30d              |
 * | from / to | custom 起止日期 YYYY-MM-DD（from <= to 才生效） | 空               |
 * | page      | 当前页码（>= 1）                              | 1                |
 * | pageSize  | 20 / 30 / 50 / 100                          | 30               |
 * | eventId   | 当前选中事件                                  | 空               |
 *
 * 本文件只做纯转换；与 Next navigation 的对接见 hooks/use-url-state.ts，
 * 组合层见 hooks/use-alert-center-url-state.ts。组件内部状态
 * （eventsLimit、批量选择、备注、导出 scope、展开态、detailTab）不进 URL。
 */

export const ALERT_URL_KEYS = {
  severity: "severity",
  status: "status",
  provider: "provider",
  keyword: "q",
  range: "range",
  from: "from",
  to: "to",
  page: "page",
  pageSize: "pageSize",
  eventId: "eventId",
} as const;

export const ALERT_URL_SEVERITIES = ["low", "medium", "high"] as const;
export const ALERT_URL_STATUSES = [
  "delivered",
  "pending",
  "failed",
  "confirmed",
  "ignored",
] as const;
export const ALERT_URL_PROVIDERS = [
  AlertMetricProvider.EconomicAnomaly,
  AlertMetricProvider.EntitySentiment,
  AlertMetricProvider.EntityAssociation,
  AlertMetricProvider.EconomicData,
  AlertMetricProvider.SystemMetric,
  AlertMetricProvider.SystemEvent,
  AlertMetricProvider.PipelineJob,
  AlertMetricProvider.CrawlTask,
  AlertMetricProvider.RealtimeSignal,
] as const;
export const ALERT_URL_DATE_PRESETS = ["today", "7d", "30d", "custom"] as const;
export const ALERT_URL_PAGE_SIZES = [20, 30, 50, 100] as const;

export const ALERT_URL_DEFAULT_DATE_PRESET: AlertDatePreset = "30d";
export const ALERT_URL_DEFAULT_PAGE = 1;
export const ALERT_URL_DEFAULT_PAGE_SIZE = 30;

export interface AlertCenterUrlState {
  severities: string[];
  statuses: string[];
  providers: string[];
  ruleKeyword: string;
  datePreset: AlertDatePreset;
  customFrom: string | null;
  customTo: string | null;
  page: number;
  pageSize: number;
  eventId: string | null;
}

export const DEFAULT_ALERT_CENTER_URL_STATE: AlertCenterUrlState = {
  severities: [],
  statuses: [],
  providers: [],
  ruleKeyword: "",
  datePreset: ALERT_URL_DEFAULT_DATE_PRESET,
  customFrom: null,
  customTo: null,
  page: ALERT_URL_DEFAULT_PAGE,
  pageSize: ALERT_URL_DEFAULT_PAGE_SIZE,
  eventId: null,
};

/** URL → 状态：非法值安全回退；custom 需 from/to 都合法且 from <= to。 */
export function parseAlertCenterUrlState(
  params: URLSearchParams,
): AlertCenterUrlState {
  const rawFrom = parseUrlDateParam(params.get(ALERT_URL_KEYS.from));
  const rawTo = parseUrlDateParam(params.get(ALERT_URL_KEYS.to));
  const hasCustomRange = isValidUrlDateRange(rawFrom, rawTo);
  const parsedPreset = parseUrlStringEnum(
    params.get(ALERT_URL_KEYS.range),
    ALERT_URL_DATE_PRESETS,
    ALERT_URL_DEFAULT_DATE_PRESET,
  );
  // custom 但日期缺失/非法/反向 → 回退默认 30d（不保留无效 custom）
  const datePreset: AlertDatePreset =
    parsedPreset === "custom" && !hasCustomRange
      ? ALERT_URL_DEFAULT_DATE_PRESET
      : (parsedPreset as AlertDatePreset);

  return {
    severities: parseUrlStringSet(
      params.getAll(ALERT_URL_KEYS.severity),
      ALERT_URL_SEVERITIES,
    ),
    statuses: parseUrlStringSet(params.getAll(ALERT_URL_KEYS.status), ALERT_URL_STATUSES),
    providers: parseUrlStringSet(
      params.getAll(ALERT_URL_KEYS.provider),
      ALERT_URL_PROVIDERS,
    ),
    ruleKeyword: (params.get(ALERT_URL_KEYS.keyword) ?? "").trim(),
    datePreset,
    customFrom: datePreset === "custom" && hasCustomRange ? rawFrom : null,
    customTo: datePreset === "custom" && hasCustomRange ? rawTo : null,
    page: parseUrlPositiveInt(params.get(ALERT_URL_KEYS.page), ALERT_URL_DEFAULT_PAGE),
    pageSize: parseUrlIntChoice(
      params.get(ALERT_URL_KEYS.pageSize),
      ALERT_URL_PAGE_SIZES,
      ALERT_URL_DEFAULT_PAGE_SIZE,
    ),
    eventId: (params.get(ALERT_URL_KEYS.eventId) ?? "").trim() || null,
  };
}

/** 状态 → URL：默认值省略；只增删自己拥有的 key，未知参数保留。 */
export function serializeAlertCenterUrlState(
  state: AlertCenterUrlState,
  params: URLSearchParams,
): void {
  serializeUrlStringSet(params, ALERT_URL_KEYS.severity, state.severities);
  serializeUrlStringSet(params, ALERT_URL_KEYS.status, state.statuses);
  serializeUrlStringSet(params, ALERT_URL_KEYS.provider, state.providers);
  serializeUrlValue(params, ALERT_URL_KEYS.keyword, state.ruleKeyword, "");
  serializeUrlValue(
    params,
    ALERT_URL_KEYS.range,
    state.datePreset,
    ALERT_URL_DEFAULT_DATE_PRESET,
  );
  params.delete(ALERT_URL_KEYS.from);
  params.delete(ALERT_URL_KEYS.to);
  if (
    state.datePreset === "custom" &&
    isValidUrlDateRange(state.customFrom, state.customTo)
  ) {
    params.set(ALERT_URL_KEYS.from, state.customFrom as string);
    params.set(ALERT_URL_KEYS.to, state.customTo as string);
  }
  serializeUrlPositiveInt(
    params,
    ALERT_URL_KEYS.page,
    state.page,
    ALERT_URL_DEFAULT_PAGE,
  );
  serializeUrlPositiveInt(
    params,
    ALERT_URL_KEYS.pageSize,
    state.pageSize,
    ALERT_URL_DEFAULT_PAGE_SIZE,
  );
  serializeUrlValue(params, ALERT_URL_KEYS.eventId, state.eventId ?? "", "");
}

/** URL 状态 → 组件筛选态的 customRangeMs（本地时区当天毫秒）。 */
export function resolveAlertUrlCustomRangeMs(
  state: AlertCenterUrlState,
): [number, number] | null {
  if (
    state.datePreset !== "custom" ||
    !isValidUrlDateRange(state.customFrom, state.customTo)
  ) {
    return null;
  }
  return [
    dayjs(state.customFrom as string).valueOf(),
    dayjs(state.customTo as string).valueOf(),
  ];
}

/** 组件筛选态的 customRangeMs → URL 日期串。 */
export function toAlertUrlCustomRange(
  customRangeMs: [number | null, number | null] | null,
): { from: string | null; to: string | null } {
  if (
    !customRangeMs ||
    typeof customRangeMs[0] !== "number" ||
    typeof customRangeMs[1] !== "number"
  ) {
    return { from: null, to: null };
  }
  return {
    from: dayjs(customRangeMs[0]).format("YYYY-MM-DD"),
    to: dayjs(customRangeMs[1]).format("YYYY-MM-DD"),
  };
}
