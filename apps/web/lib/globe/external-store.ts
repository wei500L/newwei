/**
 * external-store.ts — 一个极小的外部状态仓库，配合 React 的
 * `useSyncExternalStore` 使用。
 *
 * G4 用它承接 `initDetection` 的第三个参数（模式标签回调）：GEV 在模式
 * 变化时把标签写进这里，React 组件订阅它即可，不必读取 Pinia。
 */

export interface ExternalStore<T> {
  getSnapshot(): T;
  set(next: T | ((previous: T) => T)): void;
  subscribe(listener: () => void): () => void;
}

export function createExternalStore<T>(initial: T): ExternalStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();

  return {
    getSnapshot() {
      return value;
    },
    set(next) {
      const resolved =
        typeof next === "function"
          ? (next as (previous: T) => T)(value)
          : next;
      if (Object.is(resolved, value)) return;
      value = resolved;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
