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
 * - 把 URL 状态拆成两组 setter：筛选组（severity/status/provider/keyword/
 *   range/from/to，变化时 page 重置为 1）与导航组（page/pageSize/eventId）。
 * - rule keyword 的 220ms debounce：输入值（ruleKeywordInput）即时保留
 *   （输入框不抖动），写入 URL 的 q 在静默 220ms 后落盘；过滤计算消费
 *   debounced 值（appliedRuleKeyword）。
 * - URL 状态 → 组件筛选态（AlertFilterState + customRangeMs）的派生。
 *
 * 优先级契约（确定性）：
 * 1. URL eventId 合法（存在于数据中）→ 选中它，page 自动定位到该事件所在页；
 * 2. 筛选变化 → page 收敛为 1（事件定位仍可将其带去所在页）；
 * 3. URL 指定 page → 采纳，仅当超出总页数时收敛到最后一页。
 * （1 与 3 的交互由 alert-center 的选择/分页逻辑仲裁，本 hook 只保证
 *  各自写入时机不冲突。）
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
  setPage: (page: number) => void;
  setPageSize: (pageSize: number) => void;
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
        // 清空 → 回退默认 30d（URL 模型不存在「custom 无日期」状态）
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

  const setPage = useCallback(
    (page: number) => {
      setUrlState((previous) => ({ ...previous, page }));
    },
    [setUrlState],
  );

  const setPageSize = useCallback(
    (pageSize: number) => {
      setUrlState((previous) => ({ ...previous, pageSize, page: 1 }));
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
    setEventId,
  };
}
