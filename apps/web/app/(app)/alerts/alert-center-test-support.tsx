import { ApolloLink, Observable, type FetchResult, type Observer } from "@apollo/client";
import { MockedProvider } from "@apollo/client/testing";
import { type RenderResult } from "@testing-library/react";

import {
  AlertChannelType,
  AlertDeliveryStatus,
  AlertEventStatus,
  AlertMetricProvider,
  AlertSeverity,
  AlertTuningAction,
  type AlertEventReplayQuery,
  type AlertRuleTuningSuggestionQuery,
} from "@/graphql/generated";
import { renderWithProviders } from "@/test/render";
import {
  testSessionMock,
  testVirtualizerMock,
  type TestSessionMockState,
} from "@/test/component-mock-state";
import {
  applyTestNavigationHref,
  notifyTestNavigation,
  resetTestNavigation,
  setTestUrl,
  testNavigation,
} from "@/test/url-navigation";

import { AlertCenterContent } from "./alert-center";
import type { AlertEventItem } from "./alert-center.utils";

/**
 * Alert Center 行为测试共享支撑（FE-批3 迁移前 characterization tests）。
 *
 * 本文件只被 *.test.ts(x) 引用，不属于生产代码；vitest coverage.include
 * 为显式清单，不会把它计入覆盖率。
 *
 * 设计约束（对应任务规范）：
 * - Apollo 走 MockedProvider + 自定义 ApolloLink：query / subscription /
 *   mutation / refetch 全部经过真实 Apollo 客户端执行（loading、缓存、
 *   refetch 语义为真），仅把网络出口替换为受控响应 —— 属于允许的边界 mock。
 * - vi.mock 工厂只允许动态 import 零依赖模块（@/test/component-mock-state
 *   与 @/test/url-navigation）。工厂会在被测模块加载过程中执行：若工厂
 *   import 了会（传递地）import 被测模块的文件（如本文件），会形成
 *   「工厂等模块、模块等工厂」的模块加载死锁，远端 CI 表现为测试步骤
 *   45 分钟超时挂起（run 33790444855 / 33841300653）。
 * - @tanstack/react-virtual 以确定性 fake virtualizer 替换（jsdom 无法
 *   提供真实滚动几何），仅断言启用阈值与行集合派生，不测 tanstack 本身。
 */

export type AlertTestSessionStatus = TestSessionMockState["status"];

/** 会话 mock 状态（与 vi.mock 工厂共享同一单例）。 */
export const alertTestSession = testSessionMock;

/** 虚拟化 mock 状态（与 vi.mock 工厂共享同一单例）。 */
export const alertTestVirtualizer = testVirtualizerMock;

/** 导航 mock 状态（与 vi.mock 工厂共享同一单例）。 */
export const alertTestNavigation = testNavigation;

export const notifyAlertTestUrlChange = notifyTestNavigation;

/** 模拟 router.replace / router.push：记录调用、更新 URL 并通知订阅组件。 */
export function applyAlertTestHref(href: string, calls: string[] | null): void {
  applyTestNavigationHref(href, calls);
}

/** 模拟浏览器 back/forward 或外部导航导致的 URL 变化（不产生历史记录调用）。 */
export const setAlertTestUrl = setTestUrl;

export function resetAlertTestState(initialUrl = "/alerts"): void {
  testSessionMock.status = "authenticated";
  testSessionMock.data = { permissions: ["alerts.read"] };
  testVirtualizerMock.enabled = null;
  testVirtualizerMock.count = null;
  testVirtualizerMock.measureCalls = 0;
  resetTestNavigation(initialUrl);
}

const SEVERITY_MAP = {
  low: AlertSeverity.Low,
  medium: AlertSeverity.Medium,
  high: AlertSeverity.High,
} as const;

const STATUS_MAP = {
  delivered: AlertEventStatus.Delivered,
  pending: AlertEventStatus.Pending,
  failed: AlertEventStatus.Failed,
  confirmed: AlertEventStatus.Confirmed,
  ignored: AlertEventStatus.Ignored,
} as const;

export type AlertTestSeverity = keyof typeof SEVERITY_MAP;
export type AlertTestStatus = keyof typeof STATUS_MAP;

export interface AlertTestEventInput {
  id: string;
  /** ISO 时间戳；默认取当前时间（默认 30d 窗口内）。 */
  triggeredAt?: string;
  severity?: AlertTestSeverity;
  status?: AlertTestStatus;
  message?: string | null;
  ruleId?: string | null;
  ruleName?: string | null;
  metricProvider?: AlertMetricProvider | null;
  metricSlug?: string | null;
  metricValue?: number;
  changePercent?: number | null;
  context?: Record<string, unknown> | null;
  deliveries?: AlertEventItem["deliveries"];
}

export function buildAlertEvent(input: AlertTestEventInput): AlertEventItem {
  return {
    __typename: "AlertEventModel",
    id: input.id,
    triggeredAt: input.triggeredAt ?? new Date().toISOString(),
    metricValue: input.metricValue ?? 42,
    changePercent: input.changePercent ?? null,
    severity: SEVERITY_MAP[input.severity ?? "high"],
    status: STATUS_MAP[input.status ?? "pending"],
    message: input.message ?? `Alert message ${input.id}`,
    ruleId: input.ruleId ?? "rule-1",
    ruleName: input.ruleName ?? `Rule ${input.id}`,
    metricProvider: input.metricProvider ?? AlertMetricProvider.SystemMetric,
    metricSlug: input.metricSlug ?? "metric.test",
    operator: null,
    thresholdValue: null,
    thresholdLower: null,
    thresholdUpper: null,
    changeWindowMin: null,
    context: input.context ?? null,
    deliveries:
      input.deliveries ??
      ([
        {
          __typename: "AlertDeliveryModel",
          id: `delivery-${input.id}`,
          status: AlertDeliveryStatus.Sent,
          channelType: AlertChannelType.Email,
          channelName: "Ops mailbox",
          target: "ops@example.com",
          sentAt: new Date().toISOString(),
          error: null,
        },
      ] as AlertEventItem["deliveries"]),
  };
}

export function buildAlertEvents(count: number, prefix = "event"): AlertEventItem[] {
  return Array.from({ length: count }, (_, index) => {
    const seq = index + 1;
    return buildAlertEvent({
      id: `${prefix}-${String(seq).padStart(3, "0")}`,
      triggeredAt: new Date(Date.now() - seq * 60_000).toISOString(),
      ruleName: `${prefix} rule ${seq}`,
      message: `${prefix} message ${seq}`,
    });
  });
}

type MockObserver = Observer<FetchResult>;

export interface AlertApolloMockState {
  events: AlertEventItem[];
  eventsError: Error | null;
  /** 挂起模式：AlertEvents 请求永不返回（模拟慢 refetch，验证旧数据保留）。 */
  eventsHang: boolean;
  /** 每次 AlertEvents 请求收到的 limit 变量（按请求顺序记录）。 */
  eventsLimits: number[];
  replay: NonNullable<AlertEventReplayQuery["alertEventReplay"]> | null;
  replayError: Error | null;
  tuning: NonNullable<AlertRuleTuningSuggestionQuery["alertRuleTuningSuggestion"]> | null;
  tuningError: Error | null;
  /** 命中该集合的 mutation 被拒绝（模拟部分失败）。 */
  rejectEventIds: Set<string>;
  /** 非空时所有 mutation 响应被挂起，用于观察分批边界。 */
  mutationGate: { promise: Promise<void>; release: () => void } | null;
  mutations: { eventId: string; status: string; note: string | null }[];
  /** 按到达顺序记录的 operationName 序列。 */
  operations: string[];
  activeSubscriptionObservers: Set<MockObserver>;
}

export interface AlertApolloMock {
  link: ApolloLink;
  state: AlertApolloMockState;
}

export function createAlertApolloMock(options: {
  events?: AlertEventItem[];
  eventsError?: Error | null;
  replay?: NonNullable<AlertEventReplayQuery["alertEventReplay"]> | null;
  tuning?: NonNullable<AlertRuleTuningSuggestionQuery["alertRuleTuningSuggestion"]> | null;
  rejectEventIds?: string[];
} = {}): AlertApolloMock {
  const state: AlertApolloMockState = {
    events: options.events ?? [],
    eventsError: options.eventsError ?? null,
    eventsHang: false,
    eventsLimits: [],
    replay:
      options.replay ??
      ({
        __typename: "AlertEventReplayModel",
        eventId: "replay-event",
        metricProvider: AlertMetricProvider.SystemMetric,
        metricSlug: "metric.test",
        unit: "points",
        points: [
          { __typename: "AlertEventReplayPointModel", timestamp: new Date().toISOString(), value: 1 },
          { __typename: "AlertEventReplayPointModel", timestamp: new Date().toISOString(), value: 2 },
        ],
      } as NonNullable<AlertEventReplayQuery["alertEventReplay"]>),
    replayError: null,
    tuning:
      options.tuning ??
      ({
        __typename: "AlertRuleTuningSuggestionModel",
        ruleId: "rule-1",
        windowDays: 30,
        totalEvents: 10,
        reviewedEvents: 8,
        confirmedEvents: 5,
        ignoredEvents: 3,
        falsePositiveRate: 0.375,
        action: AlertTuningAction.None,
        message: "Consider raising the threshold.",
        suggestedThresholdValue: 12,
        suggestedThresholdLower: null,
        suggestedThresholdUpper: null,
      } as NonNullable<AlertRuleTuningSuggestionQuery["alertRuleTuningSuggestion"]>),
    tuningError: null,
    rejectEventIds: new Set(options.rejectEventIds ?? []),
    mutationGate: null,
    mutations: [],
    operations: [],
    activeSubscriptionObservers: new Set<MockObserver>(),
  };

  /** 异步（microtask）发送结果，模拟网络往返。 */
  const respond = (
    produce: () => Record<string, unknown> | Promise<Record<string, unknown>>,
  ): Observable<FetchResult> =>
    new Observable<FetchResult>((observer) => {
      let active = true;
      Promise.resolve()
        .then(produce)
        .then(
          (data) => {
            if (!active) {
              return;
            }
            observer.next({ data: { __typename: "Query", ...data } });
            observer.complete();
          },
          (error: Error) => {
            if (active) {
              observer.error(error);
            }
          },
        );
      return () => {
        active = false;
      };
    });

  const link = new ApolloLink((operation) => {
    state.operations.push(operation.operationName);
    const variables = operation.variables as Record<string, unknown>;

    switch (operation.operationName) {
      case "AlertEvents": {
        const limit = variables.limit;
        state.eventsLimits.push(typeof limit === "number" ? limit : -1);
        if (state.eventsHang) {
          // 挂起：订阅者永不收到响应
          return new Observable<FetchResult>(() => () => undefined);
        }
        if (state.eventsError) {
          return respond(() => Promise.reject(state.eventsError));
        }
        return respond(() => ({ alertEvents: state.events }));
      }
      case "AlertEventsStream":
        return new Observable<FetchResult>((observer) => {
          state.activeSubscriptionObservers.add(observer);
          return () => {
            state.activeSubscriptionObservers.delete(observer);
          };
        });
      case "UpdateAlertEventStatus": {
        const input = variables.input as {
          eventId: string;
          status: string;
          note?: string | null;
        };
        state.mutations.push({
          eventId: input.eventId,
          status: input.status,
          note: input.note ?? null,
        });
        return respond(async () => {
          if (state.rejectEventIds.has(input.eventId)) {
            throw new Error(`mutation rejected for ${input.eventId}`);
          }
          await state.mutationGate?.promise;
          return {
            updateAlertEventStatus: {
              __typename: "AlertEventModel",
              id: input.eventId,
              status: input.status,
            },
          };
        });
      }
      case "AlertEventReplay": {
        if (state.replayError) {
          return respond(() => Promise.reject(state.replayError));
        }
        return respond(() => ({
          alertEventReplay: state.replay
            ? { ...state.replay, eventId: String(variables.eventId ?? "") }
            : null,
        }));
      }
      case "AlertRuleTuningSuggestion": {
        if (state.tuningError) {
          return respond(() => Promise.reject(state.tuningError));
        }
        return respond(() => ({ alertRuleTuningSuggestion: state.tuning }));
      }
      default:
        return respond(() =>
          Promise.reject(
            new Error(`Unhandled Apollo operation: ${operation.operationName}`),
          ),
        );
    }
  });

  return { link, state };
}

/**
 * 挂起所有 mutation 响应，返回释放函数。
 * 用于观察批量更新的分批边界：第一批未完成时第二批不应发出。
 */
export function holdAlertTestMutations(
  state: AlertApolloMockState,
): () => void {
  let release!: () => void;
  state.mutationGate = {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release,
  };
  return () => {
    state.mutationGate?.release();
    state.mutationGate = null;
  };
}

/** 触发一次订阅推送（新告警事件到达）。 */
export function emitAlertTestSubscriptionEvent(state: AlertApolloMockState): void {
  for (const observer of state.activeSubscriptionObservers) {
    observer.next?.({
      data: {
        __typename: "Subscription",
        alertEvents: {
          __typename: "AlertEventModel",
          id: "stream-event",
          triggeredAt: new Date().toISOString(),
          severity: AlertSeverity.High,
          message: "stream message",
          metricValue: 1,
          changePercent: null,
          ruleName: "stream rule",
          metricSlug: "metric.stream",
          context: null,
        },
      },
    });
  }
}

export interface RenderAlertCenterOptions {
  events?: AlertEventItem[];
  eventsError?: Error | null;
  replay?: NonNullable<AlertEventReplayQuery["alertEventReplay"]> | null;
  tuning?: NonNullable<AlertRuleTuningSuggestionQuery["alertRuleTuningSuggestion"]> | null;
  rejectEventIds?: string[];
  sessionStatus?: TestSessionMockState["status"];
  permissions?: string[];
  initialUrl?: string;
}

export interface RenderAlertCenterResult extends RenderResult {
  apollo: AlertApolloMockState;
}

export function renderAlertCenter(
  options: RenderAlertCenterOptions = {},
): RenderAlertCenterResult {
  resetAlertTestState(options.initialUrl ?? "/alerts");
  alertTestSession.status = options.sessionStatus ?? "authenticated";
  alertTestSession.data = {
    permissions: options.permissions ?? ["alerts.read"],
  };

  const { link, state } = createAlertApolloMock({
    events: options.events,
    eventsError: options.eventsError,
    replay: options.replay,
    tuning: options.tuning,
    rejectEventIds: options.rejectEventIds,
  });

  const result = renderWithProviders(
    <MockedProvider link={link}>
      <AlertCenterContent />
    </MockedProvider>,
  );

  return { ...result, apollo: state };
}
