/**
 * Crawl Task Detail（FE-批5A）专用组件级 mock 状态与 vi.mock 工厂。
 *
 * 关键约束：
 * 1. 本模块必须保持零生产代码依赖 —— vi.mock 工厂会在被测模块的加载
 *    过程中动态 import 本模块；若本模块（传递地）依赖任何被 mock 的模块
 *    （如 next-auth/react / next/navigation / socket.io-client / @/lib/api-client），
 *    会形成「工厂等模块、模块等工厂」的加载死锁（远端 CI 表现为测试步骤
 *    45 分钟超时挂起）。不要在这里 import 任何项目生产模块。
 * 2. 允许且只允许单向依赖同为零依赖测试状态模块的
 *    @/test/component-mock-state（共享 session 基础状态）；该模块不得
 *    反向 import 本文件，避免循环。
 */

import {
  resetTestSessionMock,
  testSessionMock,
  type TestSessionMockData,
  type TestSessionMockState,
} from "@/test/component-mock-state";

export type TestOpsLiveStatus =
  | "disconnected"
  | "connecting"
  | "connected";

/** socket.io 受控替身捕获的单个监听器。 */
export interface TestOpsSocketListener {
  event: string;
  handler: (payload?: unknown) => void;
}

export interface TestOpsSocketMockState {
  /** io() 收到的 namespace（形如 "http://…/ops"）。 */
  namespaces: string[];
  /** io() 收到的 options（auth/transports/withCredentials/autoConnect/timeout）。 */
  options: Array<Record<string, unknown>>;
  /** 每个已创建 socket 实例（含已 disconnect 的）。 */
  instances: Array<{
    listeners: TestOpsSocketListener[];
    connectCalls: number;
    disconnectCalls: number;
    offCalls: Array<{ event: string }>;
    destroyed: boolean;
  }>;
  connectCount: number;
  disconnectCount: number;
}

export const testOpsSocket: TestOpsSocketMockState = {
  namespaces: [],
  options: [],
  instances: [],
  connectCount: 0,
  disconnectCount: 0,
};

export interface TestCrawlSocket {
  on: (event: string, handler: (payload?: unknown) => void) => void;
  off: (event: string, handler: (payload?: unknown) => void) => void;
  connect: () => void;
  disconnect: () => void;
}

export function createCrawlTestSocket(
  namespace: string,
  options: Record<string, unknown>,
): TestCrawlSocket {
  const instance = {
    listeners: [] as Array<{
      event: string;
      handler: (payload?: unknown) => void;
    }>,
    connectCalls: 0,
    disconnectCalls: 0,
    offCalls: [] as Array<{ event: string }>,
    destroyed: false,
  };
  testOpsSocket.instances.push(instance);
  return {
    on: (event, handler) => {
      instance.listeners.push({ event, handler });
    },
    off: (event, handler) => {
      instance.offCalls.push({ event });
      instance.listeners = instance.listeners.filter(
        (entry) => !(entry.event === event && entry.handler === handler),
      );
    },
    connect: () => {
      instance.connectCalls += 1;
      testOpsSocket.connectCount += 1;
    },
    disconnect: () => {
      instance.disconnectCalls += 1;
      testOpsSocket.disconnectCount += 1;
      instance.destroyed = true;
    },
  };
}

/** 触发 socket 上指定事件的全部当前监听器（模拟服务端推送）。 */
export function emitCrawlSocketEvent(
  event: string,
  payload?: unknown,
  socketIndex?: number,
): void {
  const instance =
    testOpsSocket.instances[
      socketIndex === undefined ? testOpsSocket.instances.length - 1 : socketIndex
    ];
  if (!instance) {
    return;
  }
  for (const listener of [...instance.listeners]) {
    if (listener.event === event) {
      listener.handler(payload);
    }
  }
}

export function resetTestOpsSocketMock(): void {
  testOpsSocket.namespaces.length = 0;
  testOpsSocket.options.length = 0;
  testOpsSocket.instances.length = 0;
  testOpsSocket.connectCount = 0;
  testOpsSocket.disconnectCount = 0;
}

/** antd message API 调用记录（App.useApp mock 写入）。 */
export type TestMessageKind =
  | "success"
  | "error"
  | "info"
  | "warning"
  | "loading";

export interface TestMessageCall {
  kind: TestMessageKind;
  content: string;
  key?: string;
}

export const testMessages: TestMessageCall[] = [];

/** antd Modal.confirm 调用记录。 */
export interface TestModalConfirmState {
  calls: Array<{
    title: string;
    onOk?: () => void | Promise<void>;
  }>;
}

export const testModalConfirm: TestModalConfirmState = { calls: [] };

/** task-logs REST（admin/quality/task-logs）受控响应队列。 */
export interface TestTaskLogsMockState {
  /** 每次请求弹出一条；"hang" 哨兵表示永不返回。 */
  responses: Array<unknown[] | Error | "hang">;
  calls: Array<{
    url: string;
    params: Record<string, unknown>;
  }>;
}

export const testTaskLogs: TestTaskLogsMockState = {
  responses: [[]],
  calls: [],
};

/** Crawl Task Detail 共享 mock 状态复位。 */
export function resetCrawlTaskDetailMockState(): void {
  resetTestSessionMock();
  resetTestOpsSocketMock();
  testMessages.length = 0;
  testModalConfirm.calls.length = 0;
  testTaskLogs.responses.length = 0;
  testTaskLogs.responses.push([]);
  testTaskLogs.calls.length = 0;
}

/* ------------------------------------------------------------------ */
/* Crawl Task Detail vi.mock 工厂（供各测试文件以 3 行声明接入）         */
/* ------------------------------------------------------------------ */

/** next-auth/react mock：useSession 返回共享单例。 */
export function createCrawlSessionMock(): {
  useSession: () => {
    status: TestSessionMockState["status"];
    data: TestSessionMockData | null;
  };
} {
  return {
    useSession: () => ({
      status: testSessionMock.status,
      data: testSessionMock.data,
    }),
  };
}

/** antd mock：仅替换 App.useApp 的 message 与 Modal.confirm，其余原样。 */
export function createCrawlAntdMock(actual: unknown): Record<string, unknown> {
  const moduleExports = actual as Record<string, unknown>;
  const record =
    (kind: TestMessageKind) =>
    (arg: unknown): void => {
      if (typeof arg === "string") {
        testMessages.push({ kind, content: arg });
        return;
      }
      if (arg && typeof arg === "object") {
        const entry = arg as { content?: unknown; key?: string };
        testMessages.push({
          kind,
          content: typeof entry.content === "string" ? entry.content : "",
          ...(entry.key === undefined ? {} : { key: entry.key }),
        });
      }
    };
  const messageApi = {
    success: record("success"),
    error: record("error"),
    info: record("info"),
    warning: record("warning"),
    loading: record("loading"),
  };
  return {
    ...moduleExports,
    App: {
      ...(moduleExports.App as Record<string, unknown>),
      useApp: () => ({ message: messageApi }),
    },
    Modal: {
      ...(moduleExports.Modal as Record<string, unknown>),
      confirm: (config: {
        title?: unknown;
        onOk?: () => void | Promise<void>;
      }) => {
        testModalConfirm.calls.push({
          title: typeof config.title === "string" ? config.title : "",
          ...(config.onOk === undefined ? {} : { onOk: config.onOk }),
        });
      },
    },
  };
}

/** socket.io-client mock：io() 记录 namespace/options 并返回受控 socket。 */
export function createCrawlIoMock(): {
  io: (
    namespace: string,
    options?: Record<string, unknown>,
  ) => ReturnType<typeof createCrawlTestSocket>;
} {
  return {
    io: (namespace: string, options?: Record<string, unknown>) => {
      testOpsSocket.namespaces.push(namespace);
      testOpsSocket.options.push(options ?? {});
      return createCrawlTestSocket(namespace, options ?? {});
    },
  };
}

/** @/lib/api-client mock：createApiClient().get 走 task-logs 受控队列。 */
export function createCrawlApiClientMock(): {
  createApiClient: () => {
    get: (
      url: string,
      config?: { params?: Record<string, unknown> },
    ) => Promise<{ data: unknown }>;
  };
} {
  return {
    createApiClient: () => ({
      get: (
        url: string,
        config?: { params?: Record<string, unknown> },
      ): Promise<{ data: unknown }> => {
        testTaskLogs.calls.push({ url, params: config?.params ?? {} });
        const next = testTaskLogs.responses.shift();
        if (next === "hang") {
          return new Promise(() => undefined);
        }
        if (next instanceof Error) {
          return Promise.reject(next);
        }
        return Promise.resolve({ data: next ?? [] });
      },
    }),
  };
}

/** next/navigation mock：router.push/replace 记录进共享导航状态。 */
export function createCrawlNavigationMock(
  navigation: {
    pushCalls: string[];
    replaceCalls: string[];
  },
  applyHref: (href: string, calls: string[] | null) => void,
): {
  useRouter: () => {
    push: (href: string) => void;
    replace: (href: string) => void;
    prefetch: () => void;
    back: () => void;
  };
} {
  return {
    useRouter: () => ({
      push: (href: string) => applyHref(href, navigation.pushCalls),
      replace: (href: string) => applyHref(href, navigation.replaceCalls),
      prefetch: () => undefined,
      back: () => undefined,
    }),
  };
}
