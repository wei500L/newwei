/**
 * War Map 行为测试共享支撑（FE-批4A 迁移前 characterization tests）。
 *
 * 本文件只被 *.test.ts(x) 引用，不属于生产代码；vitest coverage.include
 * 为显式清单，不会把它计入覆盖率。
 *
 * 设计约束（与 alert-center-test-support 一致）：
 * - vi.mock 工厂只允许动态 import 零依赖模块（@/test/component-mock-state）：
 *   工厂在 war-map.tsx 加载过程中执行，若 import 传递地依赖被测模块会形成
 *   模块加载死锁（远端 CI 表现为测试步骤超时挂起）。
 * - MapLibre/Deck 运行时通过 mock @/lib/map/map-runtime 注入受控 fake map
 *   （jsdom 无 WebGL）；@deck.gl/layers 以记录 props 的轻量类替换——图层
 *   构造（id/data/pickable/onClick/onHover）是被测行为，Deck 渲染不是。
 * - 数据出口 mock @/lib/api-client：React Query、QueryClient、缓存、
 *   placeholderData、失效链路全部真实执行。
 * - QueryClient 在本文件创建（本文件不被 vi.mock 工厂引用，可依赖
 *   @tanstack/react-query），每个测试经 resetWarMapTestState 重建。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";

import { ThemeProvider } from "@/hooks/use-theme";
import { useWarMapSettingsStore } from "@/store/war-map-settings";
import {
  resetTestMapRuntimeMock,
  testApiMock,
  testDashboardStream,
  testDeckLayers,
  testGeoTransport,
  testMapRuntime,
  testSessionMock,
  testTelemetry,
  testToasts,
} from "@/test/component-mock-state";
import { renderWithProviders } from "@/test/render";

import { WarMap } from "./war-map";

/** 会话 mock（vi.mock 工厂共享单例）。 */
export const warMapTestSession = testSessionMock;
/** Deck 图层 mock 记录。 */
export const warMapTestDeckLayers = testDeckLayers;
/** 地图运行时 mock 记录。 */
export const warMapTestRuntime = testMapRuntime;
/** API mock 记录。 */
export const warMapTestApi = testApiMock;
/** geo transport mutation mock 记录。 */
export const warMapTestGeoTransport = testGeoTransport;
/** toast mock 记录。 */
export const warMapTestToasts = testToasts;
/** telemetry mock 记录。 */
export const warMapTestTelemetry = testTelemetry;
/** dashboard stream mock 记录。 */
export const warMapTestStream = testDashboardStream;

let warMapQueryClient: QueryClient | null = null;

export interface WarMapEventApiFixture {
  id: string;
  name: string;
  lat: number;
  lng: number;
  severity: "low" | "medium" | "high";
  derivedScore: number;
  value: number;
  alertCount?: number;
  newsCount?: number;
  latestAt?: string;
}

export function buildWarMapEventFixture(
  overrides: Partial<WarMapEventApiFixture> & { id: string },
): WarMapEventApiFixture {
  return {
    name: `Event ${overrides.id}`,
    lat: 35,
    lng: 105,
    severity: "high",
    derivedScore: 9,
    value: 9,
    alertCount: 1,
    newsCount: 2,
    latestAt: "2026-01-05T00:00:00.000Z",
    ...overrides,
  };
}

export interface WarMapNewsApiFixture {
  id: string;
  title: string;
  lat: number;
  lng: number;
  location: string;
  geoSource: "geocoded" | "fallback-country";
  publishedAt?: string;
  ingestedAt?: string;
  url?: string | null;
}

export function buildWarMapNewsFixture(
  overrides: Partial<WarMapNewsApiFixture> & { id: string },
): WarMapNewsApiFixture {
  return {
    title: `News ${overrides.id}`,
    lat: 36,
    lng: 106,
    location: "Test Location",
    geoSource: "geocoded",
    publishedAt: "2026-01-05T01:00:00.000Z",
    url: "https://example.com/news",
    ...overrides,
  };
}

export interface WarMapMonitorApiFixture {
  id: string;
  kind: "manual" | "system_sync";
  name: string;
  enabled: boolean;
  rawKeywords: string[];
  approvedTopics: string[];
  approvedEntities: string[];
  approvedSources: string[];
  approvedGeos: string[];
  approvedLexicalTerms: string[];
  rejectedSuggestions: Record<string, unknown>;
  location?: { lat: number; lng: number; name?: string };
}

export function buildWarMapMonitorFixture(
  overrides: Partial<WarMapMonitorApiFixture> & { id: string },
): WarMapMonitorApiFixture {
  return {
    kind: "manual",
    name: `Monitor ${overrides.id}`,
    enabled: true,
    rawKeywords: ["keyword"],
    approvedTopics: [],
    approvedEntities: [],
    approvedSources: [],
    approvedGeos: [],
    approvedLexicalTerms: [],
    rejectedSuggestions: {},
    location: { lat: 34, lng: 104, name: "Monitor Location" },
    ...overrides,
  };
}

/** 标准 API 响应集（空数据，测试可按需覆盖）。 */
export function buildStandardWarMapResponses(): Record<string, unknown> {
  return {
    "dashboard/war-map/events": {
      events: [],
      updatedAt: "2026-01-05T00:00:00Z",
    },
    "dashboard/war-map/news-markers": { markers: [] },
    "dashboard/war-map/layers": { layers: {}, updatedAt: "2026-01-05T00:00:00Z" },
    "situation-monitor/monitors": [],
    "dashboard/war-map/transport-detail": { detail: null },
  };
}

/** 重置全部共享 mock 状态并重建 QueryClient（每个测试 beforeEach 调用）。 */
export function resetWarMapTestState(options?: {
  permissions?: string[];
  responses?: Record<string, unknown>;
}): void {
  testSessionMock.status = "authenticated";
  testSessionMock.data = {
    permissions: options?.permissions ?? ["analysis.run"],
  };
  testDeckLayers.instances.length = 0;
  testGeoTransport.calls.length = 0;
  testGeoTransport.loading = false;
  testToasts.calls.length = 0;
  testTelemetry.errors.length = 0;
  testDashboardStream.options.length = 0;
  testDashboardStream.state = {
    connected: false,
    status: "offline",
    retryCount: 0,
  };
  testApiMock.responses = options?.responses ?? buildStandardWarMapResponses();
  testApiMock.calls.length = 0;
  resetTestMapRuntimeMock();
  useWarMapSettingsStore.getState().resetAll();

  warMapQueryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });
}

/** 渲染 WarMap（真实 React Query + i18n + antd，mock 运行时与 API）。 */
export function renderWarMap(ui: ReactElement = <WarMap />): RenderResult {
  const queryClient = warMapQueryClient;
  if (!queryClient) {
    throw new Error("resetWarMapTestState() must run before renderWarMap()");
  }
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>{ui}</ThemeProvider>
    </QueryClientProvider>,
  );
}

/** 在最新地图实例上触发一个 maplibre 事件（load/moveend/error）。 */
export function emitWarMapMapEvent(
  eventName: string,
  payload?: unknown,
): void {
  const latest = testMapRuntime.instances.at(-1);
  if (!latest || latest.destroyed) {
    throw new Error("No live war map runtime instance");
  }
  const handlers = latest.map.__handlers as
    | Map<string, ((payload?: unknown) => void)[]>
    | undefined;
  const listeners = handlers?.get(eventName) ?? [];
  act(() => {
    for (const listener of listeners) {
      listener(payload);
    }
  });
}

/** 激活地图：把受控 IntersectionObserver 的可见回调置为 isIntersecting。 */
export function setWarMapInView(visible: boolean): void {
  act(() => {
    for (const observer of warMapIntersectionObservers) {
      observer.callback([{ isIntersecting: visible }]);
    }
  });
}

/* ------------------------------------------------------------------ */
/* 受控 IntersectionObserver（war-map.test.tsx 通过 vi.stubGlobal 注入） */
/* ------------------------------------------------------------------ */

export interface WarMapIntersectionObserverStub {
  callback: (entries: { isIntersecting: boolean }[]) => void;
  disconnect: () => void;
  observe: () => void;
}

export const warMapIntersectionObservers: WarMapIntersectionObserverStub[] = [];
