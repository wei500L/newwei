/**
 * runtime-lifecycle.ts — 与 GEV `app/application.js` 语义一致的小型生命周期。
 *
 * 关键语义（对照 vendor/gods-eye-view/src/app/application.js）：
 * - `defer(cleanup)`：后进先出清理栈（application.js:81-91 的 `defer`）。
 * - `destroy()`：幂等；先 `abort()`，再按后进先出依次执行全部 cleanup，单个
 *   cleanup 抛错不阻止其余，最后抛 `AggregateError`（application.js:54-71、125-142）。
 *
 * `acquireGlobeSlot()` 是页面级单例守卫：GEV 在 `window` 上保存全局状态，同一
 * 时间只能有一个运行时。`next.config` 开了 `reactStrictMode: true`，开发环境下
 * effect 会「挂载 → 清理 → 再挂载」；第二次启动必须等第一次 `destroy()` 完成。
 */

export interface RuntimeLifecycle {
  signal: AbortSignal;
  /** 注册清理函数；后进先出执行。 */
  defer(cleanup: () => void | Promise<void>): void;
  /** 幂等。先 abort，再按后进先出执行全部 cleanup；失败聚合为 AggregateError。 */
  destroy(): Promise<void>;
}

export function createRuntimeLifecycle(): RuntimeLifecycle {
  const controller = new AbortController();
  const cleanups: (() => void | Promise<void>)[] = [];
  let destroyPromise: Promise<void> | null = null;

  return {
    signal: controller.signal,
    defer(cleanup) {
      if (typeof cleanup !== "function") return;
      cleanups.push(cleanup);
    },
    destroy() {
      if (destroyPromise) return destroyPromise;
      destroyPromise = (async () => {
        // 先 abort：让依赖 signal 的等待方立刻退出（与 application.js 的
        // destroy() 同步 abort 一致）。
        controller.abort();
        const errors: unknown[] = [];
        while (cleanups.length > 0) {
          const cleanup = cleanups.pop();
          if (!cleanup) continue;
          try {
            await cleanup();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, "Globe runtime cleanup failed");
        }
      })();
      return destroyPromise;
    },
  };
}

/**
 * 模块级 Promise 链：每次 `acquireGlobeSlot()` 都排在上一次 `release()` 之后。
 *
 *   const releaseA = await acquireGlobeSlot();
 *   // ... 启动运行时 A ...
 *   await destroyA(); // 内部调用 releaseA()
 *   const releaseB = await acquireGlobeSlot(); // 此刻才真正开始
 *
 * 返回的 release 幂等（多次调用只释放一次）。
 */
let slotChain: Promise<void> = Promise.resolve();

export function acquireGlobeSlot(): Promise<() => void> {
  const previous = slotChain;
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  // 下一次 acquire 必须等 current（即本次 release）完成。
  slotChain = previous.then(() => current);
  // 本次 acquire 必须等上一次 release 完成，然后交出 release 函数。
  return previous.then(() => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseCurrent();
    };
  });
}
