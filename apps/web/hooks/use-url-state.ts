"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

/**
 * useUrlState：URL query 状态的通用原语（FE-批3 / FE-01）。
 *
 * 职责边界：
 * - codec（parse/serialize）由调用方注入的纯函数承载，本 hook 不包含
 *   任何业务枚举。
 * - 本 hook 只负责与 Next navigation 对接：初始从 URL 读取、用户态变化
 *   写回（默认 replace，不产生历史记录）、URL 外部变化（back/forward/
 *   分享链接）采纳进本地状态。
 *
 * 契约（调用方必须遵守）：
 * - parse 对非法输入安全回退；parse 与 serialize 需满足 round-trip 稳定
 *   （serialize(parse(url)) 的自身参数与 url 一致），否则会触发写回循环。
 * - serialize 必须完整拥有自己的 key（先删后写）；hook 不拥有的 query
 *   参数原样保留，也不会以重建 query 的方式删除它们。
 *
 * 防循环/防抖语义：
 * - 首次挂载只读不写（非法 URL 回退到默认状态时不立即改写 URL）。
 * - URL 外部变化被采纳时不回写（比较判等后无差异即无操作）。
 * - 连续快速 setState 期间以最近一次写入的 query 为基底，避免用尚未
 *   落地的 searchParams 作为基底导致前一次变更丢失。
 */
export interface UseUrlStateOptions<T> {
  /** URL → 状态；非法值安全回退默认值。 */
  parse: (params: URLSearchParams) => T;
  /** 状态 → URL；只增删自己拥有的 key，其余参数保持不动。 */
  serialize: (state: T, params: URLSearchParams) => void;
  /** 判等（默认 Object.is）。 */
  equals?: (a: T, b: T) => boolean;
  /** 写入方式：默认 replace（避免每次筛选变化产生历史记录）。 */
  method?: "replace" | "push";
}

export function useUrlState<T>(
  options: UseUrlStateOptions<T>,
): [T, Dispatch<SetStateAction<T>>] {
  const { parse, serialize, equals = Object.is, method = "replace" } = options;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchKey = searchParams.toString();

  const [state, setState] = useState<T>(() =>
    parse(new URLSearchParams(searchKey)),
  );

  // 最新 state / searchKey 的同步镜像（事件回调中读取，规避 stale closure）
  const stateRef = useRef(state);
  stateRef.current = state;
  const searchKeyRef = useRef(searchKey);
  searchKeyRef.current = searchKey;
  // 上一次 router 写入尚未落地期间的 query 基底
  const pendingQueryRef = useRef<string | null>(null);

  // URL 外部变化（back/forward/分享链接）→ 采纳进本地状态；不回写。
  useEffect(() => {
    pendingQueryRef.current = null;
    const fromUrl = parse(new URLSearchParams(searchKey));
    if (!equals(fromUrl, stateRef.current)) {
      stateRef.current = fromUrl;
      setState(fromUrl);
    }
  }, [searchKey, parse, equals]);

  const setUrlState = useCallback(
    (action: SetStateAction<T>) => {
      const previous = stateRef.current;
      const next =
        typeof action === "function"
          ? (action as (previous: T) => T)(previous)
          : action;
      stateRef.current = next;
      setState(next);

      const base = pendingQueryRef.current ?? searchKeyRef.current;
      const nextParams = new URLSearchParams(base);
      serialize(next, nextParams);
      const nextQuery = nextParams.toString();
      if (nextQuery === base) {
        return;
      }
      pendingQueryRef.current = nextQuery;
      const href = nextQuery ? `${pathname}?${nextQuery}` : pathname;
      if (method === "push") {
        router.push(href);
      } else {
        router.replace(href);
      }
    },
    [method, pathname, router, serialize],
  );

  return [state, setUrlState];
}
