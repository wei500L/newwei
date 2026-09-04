"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useUrlState } from "@/hooks/use-url-state";
import dayjs from "@/lib/dayjs";

import {
  ALERT_URL_DEFAULT_DATE_PRESET,
  parseAlertCenterUrlState,
  resolveAlertUrlCustomRangeMs,
  serializeAlertCenterUrlState,
  type AlertCenterUrlState,
} from "../alert-center-url-state";
import type { AlertFilterState } from "../alert-center.utils";

/**
 * Alert Center 的 URL-backed 应用状态（FE-01）。
 *
 * 组合层职责（不含展示）：
 * - 把 URL 状态拆成三组 setter：筛选组（severity/status/provider/keyword/
 *   range/from/to，变化时 page 重置为 1）、用户导航组（page/pageSize）与
 *   自动导航组（page，保留 eventId）。
 * - rule keyword 的 220ms debounce：输入值（ruleKeywordInput）即时保留
 *   （输入框不抖动），写入 URL 的 q 在静默 220ms 后落盘；过滤计算消费
 *   debounced 值（appliedRuleKeyword）。
 * - URL 状态 → 组件筛选态（AlertFilterState + customRangeMs）的派生。
 *
 * 分页优先级契约（确定性，由 alert-center 行为测试锁定）：
 * 1. 外部进入或浏览器导航带合法 eventId → 一次性定位到该事件所在页
 *    （alert-center 的定位 effect 排队并消费请求，写入走自动路径）；
 * 2. 用户明确点击分页器（setPage）→ 用户分页意图优先：URL 清除会与
 *    分页意图冲突的旧 eventId，页面稳定停留目标页；
 * 3. 用户明确修改 pageSize（setPageSize）→ page 重置 1 且清除旧 eventId；
 * 4. 筛选变化（updateFilters）→ page 重置 1，不被旧组件内选中拉回
 *    （定位是一次性的，不持续监听 page）；
 * 5. 仅 page、无 eventId 的分享链接按 URL page 打开；
 * 6. page 超出总页数时由组件收敛到最后一页（自动路径，保留 eventId；
 *    仅在事件数据就绪后执行，避免加载期把 URL page 改写回 1）；
 * 7. 未知 query 参数由 useUrlState 原样保留；
 * 8. 合法 eventId 深链仍可自动定位（见优先级 1）；
 * 9. 自动定位/收敛与用户分页使用可区分的写入路径（自动路径不调用
 *    「清除 eventId 的手动分页 setter」），配合 useUrlState 的防循环
 *    语义，不产生 effect/router 写回循环；
 * 10. 分页器、默认选中与 URL 状态均为既有能力，不做规避性删除。
 */

const RULE_KEYWORD_DEBOUNCE_MS = 220;

export interface UseAlertCenterUrlStateResult {
  /** URL-backed 筛选态（keyword 字段为即时输入值）。 */
  filterState: AlertFilterState;
  /** debounced 后生效的规则关键字（供过滤计算）。 */
  appliedRuleKeyword: string;
  /** 输入框即时值（不因 URL 写回抖动）。 */
  ruleKeywordInput: string;
  setRuleKeywordInput: (value: string) => void;
  page: number;
  pageSize: number;
  eventId: string | null;
  updateFilters: (patch: Partial<AlertFilterState>) => void;
  /** 用户分页写入（优先级 2）：page 优先，清除与分页意图冲突的旧 eventId。 */
  setPage: (page: number) => void;
  /** 用户 pageSize 写入（优先级 3）：page 重置 1，清除旧 eventId。 */
  setPageSize: (pageSize: number) => void;
  /**
   * 自动导航写入（优先级 1/6）：eventId 一次性定位与 page 越界收敛使用，
   * 只写 page、保留 eventId —— 与用户分页写入路径区分，避免自动定位
   * 调用「清除 eventId 的手动分页 setter」。
   */
  setPagePreservingEventId: (page: number) => void;
  setEventId: (eventId: string | null) => void;
}

export function useAlertCenterUrlState(): UseAlertCenterUrlStateResult {
  const [urlState, setUrlState] = useUrlState({
    parse: parseAlertCenterUrlState,
    serialize: serializeAlertCenterUrlState,
  });

  // 输入框即时值：仅由用户输入与「URL 外部变化」驱动
  const [ruleKeywordInput, setRuleKeywordInputState] = useState(
    () => urlState.ruleKeyword,
  );
  // 标记「当前 URL keyword 是我们写入的」：写入后的 URL 变化不回灌输入框
  const ownKeywordWriteRef = useRef(false);
  useEffect(() => {
    if (ownKeywordWriteRef.current) {
      ownKeywordWriteRef.current = false;
      return;
    }
    // back/forward / 分享链接 → 输入框跟随 URL
    setRuleKeywordInputState(urlState.ruleKeyword);
  }, [urlState.ruleKeyword]);

  // 220ms debounce：静默后把输入值写入 URL（q），page 重置为 1
  useEffect(() => {
    if (ruleKeywordInput === urlState.ruleKeyword) {
      return;
    }
    const timer = window.setTimeout(() => {
      ownKeywordWriteRef.current = true;
      setUrlState((previous) => ({
        ...previous,
        ruleKeyword: ruleKeywordInput,
        page: 1,
      }));
    }, RULE_KEYWORD_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [ruleKeywordInput, setUrlState, urlState.ruleKeyword]);

  const setRuleKeywordInput = useCallback((value: string) => {
    setRuleKeywordInputState(value);
  }, []);

  const updateFilters = useCallback(
    (patch: Partial<AlertFilterState>) => {
      setUrlState((previous) => {
        const next: AlertCenterUrlState = {
          ...previous,
          severities: patch.severities ?? previous.severities,
          statuses: patch.statuses ?? previous.statuses,
          providers: patch.providers ?? previous.providers,
          ruleKeyword:
            patch.ruleKeyword !== undefined
              ? patch.ruleKeyword
              : previous.ruleKeyword,
          datePreset: patch.datePreset ?? previous.datePreset,
          customFrom: previous.customFrom,
          customTo: previous.customTo,
          page: 1,
        };

        // 显式提供日期区间（RangePicker 语义）：合法对 → custom + 日期；
        // 清空 → 显式回退默认 30d。「custom 已选、日期未选」的瞬态由
        // codec 表示为 range=custom（不带 from/to），round-trip 稳定
        if (patch.customRangeMs !== undefined) {
          const start = patch.customRangeMs?.[0];
          const end = patch.customRangeMs?.[1];
          if (typeof start === "number" && typeof end === "number") {
            next.datePreset = "custom";
            next.customFrom = dayjs(start).format("YYYY-MM-DD");
            next.customTo = dayjs(end).format("YYYY-MM-DD");
          } else {
            next.datePreset = ALERT_URL_DEFAULT_DATE_PRESET;
            next.customFrom = null;
            next.customTo = null;
          }
        }

        // 切换到非 custom 预设 → 清空日期（与组件 Segmented 行为一致）
        if (
          patch.datePreset !== undefined &&
          patch.datePreset !== "custom"
        ) {
          next.customFrom = null;
          next.customTo = null;
        }
        return next;
      });
    },
    [setUrlState],
  );

  // 用户分页写入（优先级 2）：用户意图优先，清除旧 eventId —— 刷新/分享
  // 该 URL 不会重新触发旧事件定位，URL 无自相矛盾状态
  const setPage = useCallback(
    (page: number) => {
      setUrlState((previous) => ({ ...previous, page, eventId: null }));
    },
    [setUrlState],
  );

  // 用户 pageSize 写入（优先级 3）：page 重置 1，同样清除旧 eventId
  const setPageSize = useCallback(
    (pageSize: number) => {
      setUrlState((previous) => ({
        ...previous,
        pageSize,
        page: 1,
        eventId: null,
      }));
    },
    [setUrlState],
  );

  // 自动导航写入（优先级 1/6）：eventId 定位 / page 越界收敛专用
  const setPagePreservingEventId = useCallback(
    (page: number) => {
      setUrlState((previous) => ({ ...previous, page }));
    },
    [setUrlState],
  );

  const setEventId = useCallback(
    (eventId: string | null) => {
      setUrlState((previous) => ({ ...previous, eventId }));
    },
    [setUrlState],
  );

  const filterState = useMemo<AlertFilterState>(
    () => ({
      severities: urlState.severities,
      statuses: urlState.statuses,
      providers: urlState.providers,
      ruleKeyword: ruleKeywordInput,
      datePreset: urlState.datePreset,
      customRangeMs: resolveAlertUrlCustomRangeMs(urlState),
    }),
    [
      ruleKeywordInput,
      urlState.customFrom,
      urlState.customTo,
      urlState.datePreset,
      urlState.providers,
      urlState.severities,
      urlState.statuses,
    ],
  );

  return {
    filterState,
    appliedRuleKeyword: urlState.ruleKeyword,
    ruleKeywordInput,
    setRuleKeywordInput,
    page: urlState.page,
    pageSize: urlState.pageSize,
    eventId: urlState.eventId,
    updateFilters,
    setPage,
    setPageSize,
    setPagePreservingEventId,
    setEventId,
  };
}
