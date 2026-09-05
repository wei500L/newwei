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

/* ------------------------------------------------------------------ */
/* War Map（FE-批4A）组件级 mock 共享状态                              */
/* ------------------------------------------------------------------ */

export interface TestDeckLayerRecord {
  type: string;
  props: Record<string, unknown>;
}

export interface TestDeckLayersMockState {
  instances: TestDeckLayerRecord[];
}

export const testDeckLayers: TestDeckLayersMockState = {
  instances: [],
};

/** fake maplibre map 的受控视口（createDeckMapRuntime mock 读取）。 */
export interface TestMapRuntimeViewport {
  lat: number;
  lng: number;
  zoom: number;
  bearing: number;
  pitch: number;
}

export interface TestMapRuntimeMockState {
  createdCount: number;
  destroyedCount: number;
  /** 每次创建时的 options（含 onMapReady/onMapError/onMoveEnd 回调）。 */
  instances: Array<{
    options: Record<string, unknown>;
    map: Record<string, unknown>;
    overlay: Record<string, unknown>;
    destroyed: boolean;
  }>;
  viewport: TestMapRuntimeViewport;
  bounds: [number, number, number, number];
  easeToCalls: Array<Record<string, unknown>>;
  resizeCalls: number;
  overlayPropsCalls: Array<{
    overlay: unknown;
    props: Record<string, unknown>;
  }>;
}

export const testMapRuntime: TestMapRuntimeMockState = {
  createdCount: 0,
  destroyedCount: 0,
  instances: [],
  viewport: { lat: 20, lng: 0, zoom: 1.8, bearing: 0, pitch: 0 },
  bounds: [-180, -85, 180, 85],
  easeToCalls: [],
  resizeCalls: 0,
  overlayPropsCalls: [],
};

export function resetTestMapRuntimeMock(options?: {
  viewport?: TestMapRuntimeViewport;
  bounds?: [number, number, number, number];
}): void {
  testMapRuntime.createdCount = 0;
  testMapRuntime.destroyedCount = 0;
  testMapRuntime.instances.length = 0;
  testMapRuntime.viewport = options?.viewport ?? {
    lat: 20,
    lng: 0,
    zoom: 1.8,
    bearing: 0,
    pitch: 0,
  };
  testMapRuntime.bounds = options?.bounds ?? [-180, -85, 180, 85];
  testMapRuntime.easeToCalls.length = 0;
  testMapRuntime.resizeCalls = 0;
  testMapRuntime.overlayPropsCalls.length = 0;
}

export interface TestApiMockState {
  responses: Record<string, unknown>;
  calls: Array<{ url: string; params: Record<string, unknown> }>;
}

export const testApiMock: TestApiMockState = {
  responses: {},
  calls: [],
};

export interface TestGeoTransportMockState {
  calls: Array<{ variables: unknown }>;
  loading: boolean;
}

export const testGeoTransport: TestGeoTransportMockState = {
  calls: [],
  loading: false,
};

export type TestToastKind = "success" | "error" | "warning" | "info";

export interface TestToastMockState {
  calls: Array<{ kind: TestToastKind; message: string }>;
}

export const testToasts: TestToastMockState = { calls: [] };

export interface TestTelemetryMockState {
  errors: Array<{ message: string; error?: unknown }>;
}

export const testTelemetry: TestTelemetryMockState = { errors: [] };

export interface TestDashboardStreamMockState {
  options: Array<Record<string, unknown>>;
  state: {
    connected: boolean;
    status: string;
    retryCount: number;
    error?: string;
    lastMessageAt?: number;
    lastUpdateAt?: number;
  };
}

export const testDashboardStream: TestDashboardStreamMockState = {
  options: [],
  state: { connected: false, status: "offline", retryCount: 0 },
};
