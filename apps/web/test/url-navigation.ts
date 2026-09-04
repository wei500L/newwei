/**
 * next/navigation 的可控测试替身（URL 状态类测试共享）。
 *
 * 测试文件通过 vi.mock("next/navigation", ...) 引用本模块：
 * - router.replace / router.push 记录调用、更新 URL 并通知订阅组件
 *   （模拟真实 Next「URL 变化触发 useSearchParams 重渲染」）。
 * - setTestUrl 模拟 back/forward 或外部导航（不产生历史记录调用）。
 *
 * 本文件只被测试引用；vitest coverage.include 为显式清单，不会计入覆盖率。
 */

export interface TestNavigationState {
  pathname: string;
  params: URLSearchParams;
  replaceCalls: string[];
  pushCalls: string[];
  listeners: Set<() => void>;
}

export const testNavigation: TestNavigationState = {
  pathname: "/",
  params: new URLSearchParams(),
  replaceCalls: [],
  pushCalls: [],
  listeners: new Set<() => void>(),
};

export function notifyTestNavigation(): void {
  for (const listener of testNavigation.listeners) {
    listener();
  }
}

function applyTestHref(href: string, calls: string[] | null): void {
  if (calls) {
    calls.push(href);
  }
  const [rawPath, rawQuery = ""] = href.split("?");
  testNavigation.pathname = rawPath || "/";
  testNavigation.params = new URLSearchParams(rawQuery);
  notifyTestNavigation();
}

/** 模拟 router.replace / router.push：记录调用并驱动 URL 变化。 */
export function applyTestNavigationHref(href: string, calls: string[] | null): void {
  applyTestHref(href, calls);
}

/** 模拟浏览器 back/forward 或外部导航（不产生历史记录调用）。 */
export function setTestUrl(href: string): void {
  applyTestHref(href, null);
}

export function resetTestNavigation(initialUrl = "/"): void {
  const [rawPath, rawQuery = ""] = initialUrl.split("?");
  testNavigation.pathname = rawPath || "/";
  testNavigation.params = new URLSearchParams(rawQuery);
  testNavigation.replaceCalls.length = 0;
  testNavigation.pushCalls.length = 0;
  testNavigation.listeners.clear();
}
