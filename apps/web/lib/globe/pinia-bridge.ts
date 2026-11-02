/**
 * pinia-bridge.ts — 用 `useSyncExternalStore` 订阅 Pinia 仓库的某个字段。
 *
 * GEV 的「负责人」模块每次发布都替换成一个新的 `markRaw` 对象（见
 * `ui/stores/context.js:16-19` 一类的 `publish`），因此按引用比较即可：
 * 值没换 → 不重渲染；换了新对象 → 重渲染。
 *
 * 不能在 React 里引入 Vue 的响应式 API；这里只用 Pinia 的 `$subscribe`。
 */
import { useCallback, useSyncExternalStore } from "react";

/** Pinia store 的最小订阅面（`$subscribe`），避免依赖 Pinia 具体类型。 */
export interface PiniaSubscribable {
  $subscribe(
    callback: (mutation?: unknown, state?: unknown) => void,
    options?: { detached?: boolean },
  ): () => void;
}

/**
 * 订阅 `store` 并由 `selector` 取值。
 *
 * 注意：`selector` 必须返回**稳定引用**（GEV 的负责人发布的是 markRaw 对象，
 * 天然满足）。若 selector 每次返回新对象，`useSyncExternalStore` 会认为快照
 * 一直在变而反复重渲染。
 */
export function useGevStore<S, T>(
  store: S & PiniaSubscribable,
  selector: (state: S) => T,
): T {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const unsubscribe = store.$subscribe(onStoreChange, { detached: true });
      return () => {
        unsubscribe();
      };
    },
    [store],
  );

  const getSnapshot = useCallback(() => selector(store), [store, selector]);

  // 这个 hook 只会在客户端组件里被调用；服务端快照返回 undefined。
  // `as never` 表示「此分支不会在客户端渲染路径上产生值」。
  const getServerSnapshot = useCallback((): T => undefined as never, []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
