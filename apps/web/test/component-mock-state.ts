/**
 * 组件级 mock 的共享可变状态（vi.mock 工厂与测试助手共用）。
 *
 * 关键约束：本模块必须保持零依赖 —— vi.mock 工厂会在被测模块的加载
 * 过程中动态 import 本模块；若本模块（传递地）依赖任何被 mock 的模块
 * （如 next-auth/react / next/navigation / @tanstack/react-virtual），
 * 会形成「工厂等模块、模块等工厂」的加载死锁（远端 CI 表现为测试步骤
 * 45 分钟超时挂起）。不要在这里 import 任何项目模块。
 */

export interface TestSessionMockState {
  status: "authenticated" | "loading" | "unauthenticated";
  data: { permissions: string[] } | null;
}

export const testSessionMock: TestSessionMockState = {
  status: "authenticated",
  data: { permissions: ["alerts.read"] },
};

export interface TestVirtualizerMockState {
  enabled: boolean | null;
  count: number | null;
  measureCalls: number;
}

export const testVirtualizerMock: TestVirtualizerMockState = {
  enabled: null,
  count: null,
  measureCalls: 0,
};

export function resetTestSessionMock(
  permissions: string[] = ["alerts.read"],
): void {
  testSessionMock.status = "authenticated";
  testSessionMock.data = { permissions };
}

export function resetTestVirtualizerMock(): void {
  testVirtualizerMock.enabled = null;
  testVirtualizerMock.count = null;
  testVirtualizerMock.measureCalls = 0;
}
