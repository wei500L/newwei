import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ⚠️ vi.mock 工厂只允许动态 import 零依赖模块（@/test/component-mock-state）：
 * 工厂在 war-map.tsx 加载过程中执行，import 传递依赖被测模块会形成模块加载
 * 死锁（远端 CI 表现为测试步骤超时挂起）。
 *
 * MapLibre/Deck：mock @/lib/map/map-runtime（fake map 实例 + 受控视口/事件）
 * 与 @deck.gl/layers（记录构造 props）——图层构造与事件接线是被测行为，
 * WebGL 渲染不是。
 */
vi.mock("@deck.gl/layers", async () => {
  const { testDeckLayers } = await import("@/test/component-mock-state");
  function makeRecordingLayer(type: string) {
    return function RecordingLayer(
      this: Record<string, unknown>,
      props: Record<string, unknown>,
    ) {
      testDeckLayers.instances.push({ type, props });
      this.id = props.id;
      this.props = props;
      this.clone = () => ({ id: props.id, props });
    };
  }
  return {
    IconLayer: makeRecordingLayer("IconLayer"),
    TextLayer: makeRecordingLayer("TextLayer"),
    PathLayer: makeRecordingLayer("PathLayer"),
    PolygonLayer: makeRecordingLayer("PolygonLayer"),
    ScatterplotLayer: makeRecordingLayer("ScatterplotLayer"),
  };
});

vi.mock("@/lib/map/map-runtime", async () => {
  const { testMapRuntime } = await import("@/test/component-mock-state");

  function createFakeMap() {
    const handlers = new Map<string, ((payload?: unknown) => void)[]>();
    return {
      __handlers: handlers,
      on(event: string, handler: (payload?: unknown) => void) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      off(event: string, handler: (payload?: unknown) => void) {
        const list = handlers.get(event) ?? [];
        const index = list.indexOf(handler);
        if (index >= 0) {
          list.splice(index, 1);
        }
      },
      addControl: () => undefined,
      remove: () => undefined,
      resize: () => {
        testMapRuntime.resizeCalls += 1;
      },
      easeTo: (options: Record<string, unknown>) => {
        testMapRuntime.easeToCalls.push(options);
      },
      getCenter: () => ({
        lat: testMapRuntime.viewport.lat,
        lng: testMapRuntime.viewport.lng,
      }),
      getZoom: () => testMapRuntime.viewport.zoom,
      getBearing: () => testMapRuntime.viewport.bearing,
      getPitch: () => testMapRuntime.viewport.pitch,
      getBounds: () => ({
        getWest: () => testMapRuntime.bounds[0],
        getSouth: () => testMapRuntime.bounds[1],
        getEast: () => testMapRuntime.bounds[2],
        getNorth: () => testMapRuntime.bounds[3],
      }),
      setProjection: () => undefined,
      setBearing: () => undefined,
      setPitch: () => undefined,
      touchZoomRotate: { disableRotation: () => undefined },
      keyboard: { disableRotation: () => undefined },
      touchPitch: { disable: () => undefined },
    };
  }

  return {
    createDeckMapRuntime: (options: Record<string, unknown>) => {
      const map = createFakeMap();
      const overlay = {
        setProps: () => undefined,
        finalize: () => undefined,
      };
      const instance = { options, map, overlay, destroyed: false };
      testMapRuntime.instances.push(instance);
      testMapRuntime.createdCount += 1;

      map.on("load", () => {
        (options.onMapReady as ((map: unknown) => void) | undefined)?.(map);
      });
      map.on("moveend", () => {
        (options.onMoveEnd as ((map: unknown) => void) | undefined)?.(map);
      });
      map.on("error", (event: unknown) => {
        const detail =
          (event as { error?: unknown } | undefined)?.error ?? event;
        (
          options.onMapError as
            | ((map: unknown, detail: unknown) => void)
            | undefined
        )?.(map, { trigger: "map_error", error: detail, rawEvent: event });
      });

      return {
        map,
        overlay,
        destroy: () => {
          instance.destroyed = true;
          testMapRuntime.destroyedCount += 1;
        },
      };
    },
    extractMapBbox: () =>
      [...testMapRuntime.bounds] as [number, number, number, number],
    setDeckOverlayProps: (
      overlay: unknown,
      props: Record<string, unknown>,
    ) => {
      testMapRuntime.overlayPropsCalls.push({ overlay, props });
    },
  };
});

vi.mock("@/lib/api-client", async () => {
  const { testApiMock } = await import("@/test/component-mock-state");
  return {
    createApiClient: () => ({
      get: async (
        url: string,
        config?: { params?: Record<string, unknown> },
      ) => {
        testApiMock.calls.push({ url, params: config?.params ?? {} });
        if (!(url in testApiMock.responses)) {
          throw new Error(`Unexpected API call in war map test: ${url}`);
        }
        return { data: testApiMock.responses[url] };
      },
    }),
  };
});

vi.mock("next-auth/react", async () => {
  const { testSessionMock } = await import("@/test/component-mock-state");
  return {
    useSession: () => ({
      status: testSessionMock.status,
      data: { ...testSessionMock.data, accessToken: "test-access-token" },
    }),
  };
});

vi.mock("@/graphql/generated", async () => {
  const { testGeoTransport } = await import("@/test/component-mock-state");
  return {
    GeoTransportKind: { Aircraft: "AIRCRAFT", Vessel: "VESSEL" },
    useRequestGeoTransportMutation: () => [
      (options?: { variables?: unknown }) => {
        testGeoTransport.calls.push({ variables: options?.variables });
        return Promise.resolve({ data: { success: true } });
      },
      { loading: false },
    ],
  };
});

vi.mock("sonner", async () => {
  const { testToasts } = await import("@/test/component-mock-state");
  const record =
    (kind: "success" | "error" | "warning" | "info") => (message: string) => {
      testToasts.calls.push({ kind, message });
    };
  return {
    toast: {
      success: record("success"),
      error: record("error"),
      warning: record("warning"),
      info: record("info"),
    },
  };
});

vi.mock("@/lib/client-telemetry", async () => {
  const { testTelemetry } = await import("@/test/component-mock-state");
  return {
    captureClientError: (message: string, error?: unknown) => {
      testTelemetry.errors.push({ message, error });
    },
  };
});

vi.mock("../../use-dashboard-stream", async () => {
  const { testDashboardStream } = await import("@/test/component-mock-state");
  return {
    useDashboardStream: (options: Record<string, unknown>) => {
      testDashboardStream.options.push(options);
      return testDashboardStream.state;
    },
  };
});

import { useWarMapSettingsStore } from "@/store/war-map-settings";

import type { DashboardStreamState } from "../../use-dashboard-stream";

import { WarMap } from "./war-map";
import {
  buildStandardWarMapResponses,
  buildWarMapEventFixture,
  buildWarMapMonitorFixture,
  buildWarMapNewsFixture,
  emitWarMapMapEvent,
  renderWarMap,
  resetWarMapTestState,
  setWarMapInView,
  warMapIntersectionObservers,
  warMapTestApi,
  warMapTestDeckLayers,
  warMapTestGeoTransport,
  warMapTestRuntime,
  warMapTestStream,
  warMapTestTelemetry,
  warMapTestToasts,
} from "./war-map-test-support";

/** 桌面视口：常用 min-width 断点命中（antd Grid.useBreakpoint → screens.lg）。 */
function createDesktopMatchMedia(query: string) {
  return {
    matches:
      /min-width/.test(query) &&
      !/min-width:\s*(1[4-9]\d{2}|[2-9]\d{3,})px/.test(query),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  };
}

class ControllableIntersectionObserver {
  constructor(
    callback: (entries: { isIntersecting: boolean }[]) => void,
  ) {
    warMapIntersectionObservers.push({
      callback,
      observe: () => undefined,
      disconnect: () => undefined,
    });
  }
  observe() {
    return undefined;
  }
  unobserve() {
    return undefined;
  }
  disconnect() {
    return undefined;
  }
  takeRecords() {
    return [];
  }
}

const windowOpenMock = vi.fn();

/** 取最新构造的指定 id 的 Deck 图层（memo 重建后旧实例仍在注册表里）。 */
function findDeckLayer(
  id: string,
): { type: string; props: Record<string, unknown> } | undefined {
  for (let index = warMapTestDeckLayers.instances.length - 1; index >= 0; index -= 1) {
    const instance = warMapTestDeckLayers.instances[index];
    if (instance && instance.props.id === id) {
      return instance;
    }
  }
  return undefined;
}

function latestOverlayProps(): Record<string, unknown> | undefined {
  return warMapTestRuntime.overlayPropsCalls.at(-1)?.props;
}

function apiCallsFor(url: string) {
  return warMapTestApi.calls.filter((call) => call.url === url);
}

async function waitForDeckLayer(id: string) {
  return waitFor(() => {
    const layer = findDeckLayer(id);
    expect(layer).toBeDefined();
    return layer!;
  });
}

/** 激活地图：进入视口 → 创建实例 → 触发 load（resize 次数是 mapReady 信号）。 */
async function activateMap(): Promise<void> {
  setWarMapInView(true);
  await waitFor(() => {
    expect(warMapTestRuntime.createdCount).toBe(1);
  });
  emitWarMapMapEvent("load");
  await waitFor(() => {
    expect(warMapTestRuntime.resizeCalls).toBeGreaterThanOrEqual(1);
  });
}

describe("WarMap（迁移前 characterization）", () => {
  beforeAll(() => {
    // setup.ts 对 window 与 globalThis 分别 defineProperty，替换时保持一致
    const desktopMatchMedia = (query: string) =>
      createDesktopMatchMedia(query);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: desktopMatchMedia,
    });
    Object.defineProperty(globalThis, "matchMedia", {
      configurable: true,
      writable: true,
      value: desktopMatchMedia,
    });
    Object.defineProperty(window, "open", {
      configurable: true,
      writable: true,
      value: windowOpenMock,
    });
    Object.defineProperty(globalThis, "open", {
      configurable: true,
      writable: true,
      value: windowOpenMock,
    });
    vi.stubGlobal("IntersectionObserver", ControllableIntersectionObserver);
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 1200,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 640,
    });
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  beforeEach(() => {
    warMapIntersectionObservers.length = 0;
    window.history.replaceState(null, "", "/");
    windowOpenMock.mockClear();
    resetWarMapTestState();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("地图生命周期", () => {
    it("不在视口时不创建地图，显示 Preparing 状态", () => {
      renderWarMap();

      expect(screen.getByText("Preparing map…")).toBeInTheDocument();
      expect(warMapTestRuntime.createdCount).toBe(0);
      expect(warMapTestApi.calls).toEqual([]);
    });

    it("激活后只创建一次地图实例", async () => {
      renderWarMap();
      setWarMapInView(true);

      await waitFor(() => {
        expect(warMapTestRuntime.createdCount).toBe(1);
      });
      expect(warMapTestRuntime.instances[0]?.destroyed).toBe(false);
      expect(warMapTestRuntime.destroyedCount).toBe(0);
    });

    it("load 后 overlay props 更新（layers/getTooltip/getCursor）", async () => {
      renderWarMap();
      await activateMap();

      await waitFor(() => {
        const props = latestOverlayProps();
        expect(props).toBeDefined();
        expect(Array.isArray(props?.layers)).toBe(true);
        expect(typeof props?.getTooltip).toBe("function");
        expect(typeof props?.getCursor).toBe("function");
      });
    });

    it("地图加载错误：错误分类 UI、telemetry 与 toast", async () => {
      renderWarMap();
      setWarMapInView(true);
      await waitFor(() => {
        expect(warMapTestRuntime.createdCount).toBe(1);
      });

      emitWarMapMapEvent("error", { error: new Error("boom") });

      await waitFor(() => {
        expect(screen.getByText("地图底图初始化失败")).toBeInTheDocument();
      });
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
      expect(warMapTestTelemetry.errors[0]?.message).toBe(
        "War map basemap load failed",
      );
      expect(warMapTestToasts.calls[0]?.kind).toBe("error");
    });

    it("retry 后销毁旧实例并重新创建", async () => {
      renderWarMap();
      setWarMapInView(true);
      await waitFor(() => {
        expect(warMapTestRuntime.createdCount).toBe(1);
      });
      emitWarMapMapEvent("error", { error: new Error("boom") });
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Retry" }),
        ).toBeInTheDocument();
      });

      await userEvent.click(screen.getByRole("button", { name: "Retry" }));

      await waitFor(() => {
        expect(warMapTestRuntime.createdCount).toBe(2);
      });
      expect(warMapTestRuntime.destroyedCount).toBe(1);
      expect(warMapTestRuntime.instances[0]?.destroyed).toBe(true);
      expect(warMapTestRuntime.instances[1]?.destroyed).toBe(false);
    });

    it("retry 后新 overlay 立即恢复最后一份 layers/getTooltip/getCursor", async () => {
      const responses = buildStandardWarMapResponses();
      responses["dashboard/war-map/events"] = {
        events: [buildWarMapEventFixture({ id: "e1", lat: 35, lng: 105 })],
        updatedAt: "2026-01-05T00:00:00Z",
      };
      resetWarMapTestState({ responses });
      renderWarMap();
      await activateMap();

      // 首个 runtime：业务图层与 tooltip/cursor 已应用到第一个 overlay
      await waitForDeckLayer("wm-events-symbols-primary");
      const firstOverlay = warMapTestRuntime.instances[0]!.overlay;
      await waitFor(() => {
        const applied = warMapTestRuntime.overlayPropsCalls.filter(
          (call) => call.overlay === firstOverlay,
        );
        expect(applied.length).toBeGreaterThan(0);
        const last = applied.at(-1)!.props as {
          layers?: { id?: string }[];
          getTooltip?: unknown;
          getCursor?: unknown;
        };
        expect(last.layers?.map((layer) => layer.id)).toContain(
          "wm-events-symbols-primary",
        );
        expect(typeof last.getTooltip).toBe("function");
        expect(typeof last.getCursor).toBe("function");
      });

      // retry 前最后一份有效 props 与调用水位
      const lastCallBeforeRetry = warMapTestRuntime.overlayPropsCalls.at(-1)!;
      const propsBeforeRetry = lastCallBeforeRetry.props as {
        layers: { id?: string }[];
        getTooltip: unknown;
        getCursor: unknown;
      };
      const layerIdsBeforeRetry = propsBeforeRetry.layers.map(
        (layer) => layer.id,
      );
      const callsBeforeRetry = warMapTestRuntime.overlayPropsCalls.length;

      // 触发地图错误 → Retry：不改变查询数据、hover、选中或任何图层依赖
      emitWarMapMapEvent("error", { error: new Error("boom") });
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Retry" }),
        ).toBeInTheDocument();
      });
      await userEvent.click(screen.getByRole("button", { name: "Retry" }));

      await waitFor(() => {
        expect(warMapTestRuntime.createdCount).toBe(2);
      });
      expect(warMapTestRuntime.destroyedCount).toBe(1);
      expect(warMapTestRuntime.instances[0]?.destroyed).toBe(true);
      expect(warMapTestRuntime.instances[1]?.destroyed).toBe(false);

      // 针对第二个 overlay 断言：不等待 load/数据/交互变化，立即收到
      // retry 前最后一份有效 overlay props（layers/getTooltip/getCursor）
      const secondOverlay = warMapTestRuntime.instances[1]!.overlay;
      const secondOverlayCall = warMapTestRuntime.overlayPropsCalls
        .slice(callsBeforeRetry)
        .find((call) => call.overlay === secondOverlay);
      expect(secondOverlayCall).toBeDefined();
      const secondOverlayProps = secondOverlayCall!.props as {
        layers?: { id?: string }[];
        getTooltip?: unknown;
        getCursor?: unknown;
      };
      expect(secondOverlayProps.layers?.map((layer) => layer.id)).toEqual(
        layerIdsBeforeRetry,
      );
      expect(secondOverlayProps.layers?.map((layer) => layer.id)).toContain(
        "wm-events-symbols-primary",
      );
      expect(typeof secondOverlayProps.getTooltip).toBe("function");
      expect(typeof secondOverlayProps.getCursor).toBe("function");
    });

    it("卸载时销毁地图与 overlay（无实例泄漏）", async () => {
      const { unmount } = renderWarMap();
      await activateMap();

      unmount();

      expect(warMapTestRuntime.destroyedCount).toBe(
        warMapTestRuntime.createdCount,
      );
      expect(
        warMapTestRuntime.instances.filter((instance) => !instance.destroyed),
      ).toEqual([]);
    });

    it("Strict Mode 双挂载下激活不重复创建实例、卸载无泄漏", async () => {
      renderWarMap(
        <StrictMode>
          <WarMap />
        </StrictMode>,
      );
      // StrictMode 首挂载双执行 effect（此时 inView=false，创建 effect 早退）
      setWarMapInView(true);

      await waitFor(() => {
        expect(warMapTestRuntime.createdCount).toBe(1);
      });
      expect(
        warMapTestRuntime.instances.filter((instance) => !instance.destroyed)
          .length,
      ).toBe(1);
    });
  });

  describe("URL 与设置", () => {
    it("首次 hydration：URL 覆盖默认设置（一次写入 store）", async () => {
      window.history.replaceState(
        null,
        "",
        "/?lat=40.5&lon=-74&zoom=5&preset=america&tr=24h&layers=conflicts&fm=all&am=density",
      );
      renderWarMap();
      setWarMapInView(true);

      await waitFor(() => {
        const state = useWarMapSettingsStore.getState();
        expect(state.viewState.lat).toBe(40.5);
        expect(state.viewState.lon).toBe(-74);
        expect(state.viewState.zoom).toBe(5);
        expect(state.activePreset).toBe("america");
        expect(state.timeRangePreset).toBe("24h");
        expect(state.layerVisibility.conflicts).toBe(true);
        expect(state.layerVisibility.ais).toBe(false);
        expect(state.flightMode).toBe("all");
        expect(state.aisMode).toBe("density");
      });
    });

    it("URL 写回：默认状态防抖写回且不产生回写循环", async () => {
      const replaceStateSpy = vi.spyOn(window.history, "replaceState");
      renderWarMap();
      setWarMapInView(true);

      await waitFor(
        () => {
          expect(window.location.search).toContain("preset=global");
        },
        { timeout: 2500 },
      );
      expect(window.location.search).toContain("tr=7d");
      expect(window.location.search).toContain("am=all");
      expect(window.location.search).toContain("lat=");
      expect(window.location.search).toContain("zoom=");
      expect(window.location.search).not.toContain("fm=");

      const callsAfterStabilize = replaceStateSpy.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(replaceStateSpy.mock.calls.length).toBe(callsAfterStabilize);
    });

    it("URL 写回精度：lat/lon 4 位、zoom 2 位小数", async () => {
      renderWarMap();
      setWarMapInView(true);

      await waitFor(
        () => {
          expect(window.location.search).toContain("lat=20.0000");
        },
        { timeout: 2500 },
      );
      expect(window.location.search).toContain("lon=0.0000");
      expect(window.location.search).toContain("zoom=1.80");
    });

    it("hydration 后旧 aa 参数被清理、未知参数保留", async () => {
      window.history.replaceState(null, "", "/?aa=1&customTab=overview&preset=mena");
      renderWarMap();
      setWarMapInView(true);

      // 等待防抖写回完成（写回包含 lat 参数即代表已完成 URL 重写）
      await waitFor(
        () => {
          expect(window.location.search).toContain("lat=28.0000");
        },
        { timeout: 2500 },
      );
      expect(window.location.search).toContain("preset=mena");
      expect(window.location.search).not.toContain("aa=");
      expect(window.location.search).toContain("customTab=overview");
    });
  });

  describe("查询状态与实时回调", () => {
    it("默认视口（zoom<2.8）不发送 bbox；modes 进入 realtime query 回调", async () => {
      const onRealtimeQueryChange = vi.fn();
      renderWarMap(<WarMap onRealtimeQueryChange={onRealtimeQueryChange} />);
      await activateMap();

      await waitFor(() => {
        expect(onRealtimeQueryChange).toHaveBeenCalled();
      });
      const payload = onRealtimeQueryChange.mock.calls.at(-1)?.[0];
      expect(payload.bbox).toBeUndefined();
      expect(payload.zoom).toBeCloseTo(1.8, 2);
      expect(payload.translateTarget).toBeUndefined();
      expect(payload.flightMode).toBe("military");
      expect(payload.aisMode).toBe("all");

      const spanMs = payload.end.getTime() - payload.start.getTime();
      expect(Math.abs(spanMs - 7 * 24 * 60 * 60 * 1000)).toBeLessThan(5000);

      await waitFor(() => {
        expect(apiCallsFor("dashboard/war-map/layers").length).toBe(1);
      });
      expect(apiCallsFor("dashboard/war-map/layers")[0]?.params).not.toHaveProperty(
        "bbox",
      );
    });

    it("地图 moveend 后：view state 写回、bbox 进入查询与回调", async () => {
      const onRealtimeQueryChange = vi.fn();
      renderWarMap(<WarMap onRealtimeQueryChange={onRealtimeQueryChange} />);
      await activateMap();
      await waitFor(() => {
        expect(apiCallsFor("dashboard/war-map/layers").length).toBe(1);
      });

      warMapTestRuntime.viewport = {
        lat: 40,
        lng: -74,
        zoom: 4.2,
        bearing: 0,
        pitch: 0,
      };
      warMapTestRuntime.bounds = [10, 20, 30, 40];
      emitWarMapMapEvent("moveend");

      await waitFor(() => {
        expect(onRealtimeQueryChange.mock.calls.at(-1)?.[0].bbox).toBe(
          "10.00000,20.00000,30.00000,40.00000",
        );
      });
      expect(onRealtimeQueryChange.mock.calls.at(-1)?.[0].zoom).toBeCloseTo(
        4.2,
        2,
      );
      expect(useWarMapSettingsStore.getState().viewState.lat).toBe(40);
      expect(useWarMapSettingsStore.getState().viewState.lon).toBe(-74);

      await waitFor(() => {
        const layerCalls = apiCallsFor("dashboard/war-map/layers");
        expect(
          layerCalls.some(
            (call) =>
              call.params.bbox === "10.00000,20.00000,30.00000,40.00000",
          ),
        ).toBe(true);
      });
    });

    it("onEffectiveRangeChange：时间范围切换与 all 语义", async () => {
      const onEffectiveRangeChange = vi.fn();
      renderWarMap(<WarMap onEffectiveRangeChange={onEffectiveRangeChange} />);
      await activateMap();

      await waitFor(() => {
        expect(onEffectiveRangeChange).toHaveBeenCalled();
      });
      const initial = onEffectiveRangeChange.mock.calls.at(-1)?.[0];
      const initialSpanMs = initial.end.getTime() - initial.start.getTime();
      expect(Math.abs(initialSpanMs - 7 * 24 * 60 * 60 * 1000)).toBeLessThan(
        5000,
      );

      fireEvent.click(screen.getByRole("button", { name: "Controls" }));
      await waitFor(() => {
        expect(screen.getByText("Regions")).toBeInTheDocument();
      });

      await userEvent.click(screen.getByRole("button", { name: "24H" }));
      await waitFor(() => {
        const after24h = onEffectiveRangeChange.mock.calls.at(-1)?.[0];
        const span24h = after24h.end.getTime() - after24h.start.getTime();
        expect(Math.abs(span24h - 24 * 60 * 60 * 1000)).toBeLessThan(5000);
      });

      await userEvent.click(screen.getByRole("button", { name: "All" }));
      await waitFor(() => {
        const afterAll = onEffectiveRangeChange.mock.calls.at(-1)?.[0];
        expect(afterAll.start.getFullYear()).toBe(1970);
      });
    });

    it("数据查询门禁：激活前不发请求、激活后四条链路查询", async () => {
      renderWarMap();
      expect(warMapTestApi.calls).toEqual([]);

      setWarMapInView(true);
      await waitFor(() => {
        expect(warMapTestApi.calls.map((call) => call.url)).toEqual(
          expect.arrayContaining([
            "dashboard/war-map/events",
            "dashboard/war-map/news-markers",
            "dashboard/war-map/layers",
            "situation-monitor/monitors",
          ]),
        );
      });
    });

    it("内部 stream：未传 streamState 时以 effective range/viewport 装配", async () => {
      renderWarMap();
      await activateMap();

      warMapTestRuntime.viewport = {
        lat: 40,
        lng: -74,
        zoom: 4.2,
        bearing: 0,
        pitch: 0,
      };
      warMapTestRuntime.bounds = [10, 20, 30, 40];
      emitWarMapMapEvent("moveend");

      await waitFor(() => {
        const options = warMapTestStream.options.at(-1);
        expect(options).toBeDefined();
        expect(options?.enabled).toBe(true);
        expect(options?.warMapBBox).toBe("10.00000,20.00000,30.00000,40.00000");
        expect(options?.warMapZoom).toBeCloseTo(4.2, 2);
        expect(options?.warMapFlightMode).toBe("military");
        expect(options?.warMapAisMode).toBe("all");
        expect(options?.warMapStart).toBeInstanceOf(Date);
      });
    });

    it("外部 streamState 存在时内部 stream 禁用", async () => {
      const externalStreamState: DashboardStreamState = {
        connected: true,
        status: "live",
        retryCount: 0,
      };
      renderWarMap(<WarMap streamState={externalStreamState} />);
      await activateMap();

      const options = warMapTestStream.options.at(-1);
      expect(options?.enabled).toBe(false);
    });
  });

  describe("用户可见交互", () => {
    it("embedded 布局：controls 面板内联展开，preset 修改驱动地图与 URL", async () => {
      renderWarMap();
      await activateMap();

      expect(document.querySelector(".ant-drawer")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Controls" }));
      await waitFor(() => {
        expect(screen.getByText("Regions")).toBeInTheDocument();
      });
      // Window 文案同时出现在摘要头与 View 区块标题
      expect(screen.getAllByText("Window").length).toBeGreaterThan(0);

      await userEvent.click(screen.getByRole("button", { name: "MENA" }));
      await waitFor(() => {
        expect(useWarMapSettingsStore.getState().activePreset).toBe("mena");
      });
      expect(useWarMapSettingsStore.getState().viewState.lat).toBe(28);
      expect(useWarMapSettingsStore.getState().viewState.lon).toBe(45);

      await waitFor(() => {
        expect(
          warMapTestRuntime.easeToCalls.some(
            (call) =>
              Array.isArray(call.center) &&
              (call.center as number[])[0] === 45 &&
              (call.center as number[])[1] === 28,
          ),
        ).toBe(true);
      });

      await waitFor(
        () => {
          expect(window.location.search).toContain("preset=mena");
        },
        { timeout: 2500 },
      );
    });

    it("layer visibility 修改：checkbox 翻转写入 store 与 URL", async () => {
      renderWarMap();
      await activateMap();

      fireEvent.click(screen.getByRole("button", { name: "Controls" }));
      const conflictsCheckbox = await screen.findByRole("checkbox", {
        name: /Conflicts/i,
      });
      expect(conflictsCheckbox).toBeChecked();

      await userEvent.click(conflictsCheckbox);
      await waitFor(() => {
        expect(
          useWarMapSettingsStore.getState().layerVisibility.conflicts,
        ).toBe(false);
      });

      await waitFor(
        () => {
          expect(window.location.search).toContain("layers=");
        },
        { timeout: 2500 },
      );
      expect(window.location.search).not.toContain("layers=conflicts");
    });

    it("standalone 布局：controls 走底部 Drawer、legend dock 常驻", async () => {
      renderWarMap(<WarMap layoutVariant="standalone" />);
      await activateMap();

      // legend dock 常驻（standalone 无 Legend 工具按钮、无 quick legend）；
      // hint 同时出现在 dock 头部与 interaction strip
      expect(
        screen.getAllByText(
          "Live symbols stay aligned with the active map layers.",
        ).length,
      ).toBeGreaterThan(0);
      expect(
        screen.queryByRole("button", { name: "Legend" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Regions")).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "Controls" }));
      await waitFor(() => {
        expect(screen.getByText("Regions")).toBeInTheDocument();
      });
      expect(document.querySelector(".ant-drawer")).not.toBeNull();
    });

    it("事件选中：deck onClick → Inspector 展示 → Esc 关闭", async () => {
      const responses = buildStandardWarMapResponses();
      responses["dashboard/war-map/events"] = {
        events: [buildWarMapEventFixture({ id: "e1", lat: 35, lng: 105 })],
        updatedAt: "2026-01-05T00:00:00Z",
      };
      resetWarMapTestState({ responses });
      renderWarMap();
      await activateMap();

      const eventsLayer = await waitForDeckLayer("wm-events-symbols-primary");
      const point = (eventsLayer.props.data as Record<string, unknown>[])[0]!;
      expect(point.selectionKey).toBe("event:e1");

      (eventsLayer.props.onClick as (info: unknown) => void)({ object: point });

      await waitFor(() => {
        expect(screen.getByText("Event e1")).toBeInTheDocument();
      });
      expect(screen.getByText("Nearby signals")).toBeInTheDocument();

      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => {
        expect(screen.queryByText("Event e1")).not.toBeInTheDocument();
      });
    });

    it("事件聚类：两个同点位事件聚合，点击打开聚类 Inspector", async () => {
      const responses = buildStandardWarMapResponses();
      responses["dashboard/war-map/events"] = {
        events: [
          buildWarMapEventFixture({ id: "e1", lat: 35, lng: 105 }),
          buildWarMapEventFixture({ id: "e2", lat: 35, lng: 105 }),
        ],
        updatedAt: "2026-01-05T00:00:00Z",
      };
      resetWarMapTestState({ responses });
      renderWarMap();
      await activateMap();

      const eventsLayer = await waitForDeckLayer("wm-events-symbols-primary");
      const points = eventsLayer.props.data as Record<string, unknown>[];
      expect(points).toHaveLength(1);
      const clusterPoint = points[0]!;
      expect(clusterPoint.isCluster).toBe(true);
      expect(clusterPoint.clusterCount).toBe(2);
      expect(String(clusterPoint.selectionKey)).toContain("event-cluster:");

      (eventsLayer.props.onClick as (info: unknown) => void)({
        object: clusterPoint,
      });

      await waitFor(() => {
        expect(
          screen.getByText("2 nearby signals at this zoom level."),
        ).toBeInTheDocument();
      });
    });

    it("hover：onHover 更新 cursor getter", async () => {
      const responses = buildStandardWarMapResponses();
      responses["dashboard/war-map/events"] = {
        events: [buildWarMapEventFixture({ id: "e1", lat: 35, lng: 105 })],
        updatedAt: "2026-01-05T00:00:00Z",
      };
      resetWarMapTestState({ responses });
      renderWarMap();
      await activateMap();

      const eventsLayer = await waitForDeckLayer("wm-events-symbols-primary");

      const getCursor = () =>
        latestOverlayProps()?.getCursor as
          | ((state: { isDragging?: boolean }) => string)
          | undefined;
      expect(getCursor()?.({ isDragging: false })).toBe("grab");

      (eventsLayer.props.onHover as (info: unknown) => void)({
        object: (eventsLayer.props.data as Record<string, unknown>[])[0]!,
      });

      await waitFor(() => {
        expect(getCursor()?.({ isDragging: false })).toBe("pointer");
      });
      expect(getCursor()?.({ isDragging: true })).toBe("grabbing");
    });

    it("legend focus：聚焦 signal-high 后图层次化为 muted/emphasized", async () => {
      const responses = buildStandardWarMapResponses();
      responses["dashboard/war-map/events"] = {
        events: [
          buildWarMapEventFixture({
            id: "e-high",
            lat: 35,
            lng: 105,
            severity: "high",
          }),
          buildWarMapEventFixture({
            id: "e-low",
            lat: -35,
            lng: -105,
            severity: "low",
          }),
        ],
        updatedAt: "2026-01-05T00:00:00Z",
      };
      resetWarMapTestState({ responses });
      renderWarMap();
      await activateMap();

      await waitForDeckLayer("wm-events-symbols-primary");
      expect(findDeckLayer("wm-events-symbols-muted")).toBeUndefined();

      await userEvent.click(
        screen.getByRole("button", { name: "Signal / high severity" }),
      );

      await waitFor(() => {
        const muted = findDeckLayer("wm-events-symbols-muted");
        expect(muted).toBeDefined();
        const mutedData = muted!.props.data as { label: string }[];
        expect(mutedData.map((point) => point.label)).toEqual(["Event e-low"]);
      });
      const primary = findDeckLayer("wm-events-symbols-primary")!;
      const primaryData = primary.props.data as { label: string }[];
      expect(primaryData.map((point) => point.label)).toEqual(["Event e-high"]);
    });

    it("分析入口：无 analysis.run 权限时按钮禁用、mutation 不触发", async () => {
      resetWarMapTestState({ permissions: ["alerts.read"] });
      renderWarMap();
      await activateMap();

      fireEvent.click(screen.getByRole("button", { name: "Controls" }));
      await userEvent.click(screen.getByRole("button", { name: "Transport" }));
      const analyzeButton = await screen.findByRole("button", {
        name: /Analyze current view/i,
      });
      expect(analyzeButton).toBeDisabled();
      expect(warMapTestGeoTransport.calls).toEqual([]);
    });

    it("分析入口：有权限时提交 geo transport（flights+ais 可见）", async () => {
      renderWarMap();
      await activateMap();

      fireEvent.click(screen.getByRole("button", { name: "Controls" }));
      await userEvent.click(screen.getByRole("button", { name: "Transport" }));
      const analyzeButton = await screen.findByRole("button", {
        name: /Analyze current view/i,
      });
      expect(analyzeButton).toBeEnabled();

      await userEvent.click(analyzeButton);

      await waitFor(() => {
        expect(warMapTestGeoTransport.calls).toHaveLength(1);
      });
      const variables = warMapTestGeoTransport.calls[0]?.variables as {
        input: {
          transportKinds: string[];
          startDate: string;
          endDate: string;
          bbox?: string;
        };
      };
      expect(variables.input.transportKinds).toEqual(["AIRCRAFT", "VESSEL"]);
      expect(variables.input.startDate).toBeDefined();
      expect(variables.input.endDate).toBeDefined();

      await waitFor(() => {
        expect(
          warMapTestToasts.calls.some(
            (toast) =>
              toast.kind === "success" &&
              toast.message.includes("Transport analysis submitted"),
          ),
        ).toBe(true);
      });
    });

    it("新闻选中：inspector 展示新闻详情", async () => {
      const responses = buildStandardWarMapResponses();
      responses["dashboard/war-map/news-markers"] = {
        markers: [buildWarMapNewsFixture({ id: "n1", lat: 36, lng: 106 })],
      };
      resetWarMapTestState({ responses });
      renderWarMap();
      await activateMap();

      const newsLayer = await waitForDeckLayer("wm-news-symbols-primary");
      const point = (newsLayer.props.data as Record<string, unknown>[])[0]!;
      expect(point.selectionKey).toBe("news:n1");

      (newsLayer.props.onClick as (info: unknown) => void)({ object: point });

      await waitFor(() => {
        expect(screen.getByText("News n1")).toBeInTheDocument();
      });
    });

    it("监控点点击：以首个非空关键词打开搜索页", async () => {
      const responses = buildStandardWarMapResponses();
      responses["situation-monitor/monitors"] = [
        buildWarMapMonitorFixture({
          id: "m1",
          rawKeywords: ["  ", "taiwan strait"],
        }),
      ];
      resetWarMapTestState({ responses });
      renderWarMap();
      await activateMap();

      const monitorLayer = await waitForDeckLayer("wm-monitors-symbols-primary");
      const point = (monitorLayer.props.data as Record<string, unknown>[])[0]!;
      expect(point.interactionKey).toBe("monitor:m1");

      (monitorLayer.props.onClick as (info: unknown) => void)({ object: point });

      await waitFor(() => {
        expect(windowOpenMock).toHaveBeenCalledWith(
          "/search?q=taiwan%20strait",
          "_blank",
          "noopener,noreferrer",
        );
      });
    });

    it("AIS vessel 选中：inspector 展示并查询 transport-detail", async () => {
      const responses = buildStandardWarMapResponses();
      responses["dashboard/war-map/layers"] = {
        layers: {
          ais: {
            layerId: "ais",
            geometryType: "point",
            updatedAt: "2026-01-05T00:00:00Z",
            features: [
              {
                id: "v1",
                lat: 22,
                lng: 118,
                properties: {
                  sourceType: "ais",
                  featureKind: "vessel",
                  mmsi: "123456789",
                  name: "Test Vessel",
                  shipType: 35,
                },
              },
            ],
          },
        },
        updatedAt: "2026-01-05T00:00:00Z",
      };
      resetWarMapTestState({ responses });
      renderWarMap();
      await activateMap();

      const vesselLayer = await waitForDeckLayer("wm-ais-vessels-symbols-primary");
      const point = (vesselLayer.props.data as Record<string, unknown>[])[0]!;
      expect(point.selectionKey).toBe("transport:vessel:ais:123456789");

      (vesselLayer.props.onClick as (info: unknown) => void)({ object: point });

      await waitFor(() => {
        expect(screen.getByText("Test Vessel")).toBeInTheDocument();
      });
      await waitFor(() => {
        const detailCalls = apiCallsFor("dashboard/war-map/transport-detail");
        expect(detailCalls.length).toBeGreaterThanOrEqual(1);
        expect(detailCalls[0]?.params).toEqual(
          expect.objectContaining({
            kind: "vessel",
            objectKey: "ais:123456789",
          }),
        );
      });
    });
  });
});
