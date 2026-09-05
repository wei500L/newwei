import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SITUATION_MONITOR_MONITORS_UPDATED_EVENT } from "@/app/(app)/situation-monitor/utils/monitor-events";

import { useWarMapData } from "./use-war-map-data";

interface ApiCall {
  url: string;
  params: Record<string, unknown>;
}

function createMockApiClient(responses: Record<string, unknown>) {
  const calls: ApiCall[] = [];
  const client = {
    get: vi.fn(async (url: string, config?: { params?: Record<string, unknown> }) => {
      calls.push({ url, params: config?.params ?? {} });
      if (!(url in responses)) {
        throw new Error(`Unexpected API call: ${url}`);
      }
      return { data: responses[url] };
    }),
  };
  return { client, calls };
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { Wrapper, queryClient };
}

const STANDARD_RESPONSES = {
  "dashboard/war-map/events": { events: [], updatedAt: "2026-01-01T00:00:00Z" },
  "dashboard/war-map/news-markers": { markers: [] },
  "dashboard/war-map/layers": { layers: {} },
  "situation-monitor/monitors": [],
};

const STANDARD_QUERY_INPUT = {
  start: "2026-01-01T00:00:00.000Z",
  end: "2026-01-08T00:00:00.000Z",
};

describe("useWarMapData（查询门禁与实时更新）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("enabled=false 时不发起任何请求", async () => {
    const { client, calls } = createMockApiClient(STANDARD_RESPONSES);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () =>
        useWarMapData({
          apiClient: client as never,
          enabled: false,
          ...STANDARD_QUERY_INPUT,
        }),
      { wrapper: Wrapper },
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(calls).toEqual([]);
    expect(result.current.eventsQuery.isLoading).toBe(false);
    expect(result.current.eventsQuery.data).toBeUndefined();
  });

  it("enabled=true 时查询 events/news-markers/layers/monitors 四条链路", async () => {
    const { client, calls } = createMockApiClient(STANDARD_RESPONSES);
    const { Wrapper } = createWrapper();

    renderHook(
      () =>
        useWarMapData({
          apiClient: client as never,
          enabled: true,
          ...STANDARD_QUERY_INPUT,
        }),
      { wrapper: Wrapper },
    );

    await waitFor(
      () => {
        expect(calls.map((call) => call.url)).toEqual(
          expect.arrayContaining([
            "dashboard/war-map/events",
            "dashboard/war-map/news-markers",
            "dashboard/war-map/layers",
            "situation-monitor/monitors",
          ]),
        );
      },
      { timeout: 3000 },
    );
  });

  it("bbox/zoom/mode 进入请求参数", async () => {
    const { client, calls } = createMockApiClient(STANDARD_RESPONSES);
    const { Wrapper } = createWrapper();

    renderHook(
      () =>
        useWarMapData({
          apiClient: client as never,
          enabled: true,
          ...STANDARD_QUERY_INPUT,
          bbox: "1,2,3,4",
          zoom: 5.12,
          flightMode: "all",
          aisMode: "density",
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(calls.length).toBeGreaterThanOrEqual(3);
    });

    const eventsCall = calls.find((call) => call.url === "dashboard/war-map/events");
    expect(eventsCall?.params).toEqual(
      expect.objectContaining({
        start: "2026-01-01T00:00:00.000Z",
        end: "2026-01-08T00:00:00.000Z",
        bbox: "1,2,3,4",
        zoom: "5.12",
        cluster: "0",
      }),
    );
    const layersCall = calls.find((call) => call.url === "dashboard/war-map/layers");
    expect(layersCall?.params).toEqual(
      expect.objectContaining({
        bbox: "1,2,3,4",
        zoom: "5.12",
        flightMode: "all",
        aisMode: "density",
      }),
    );
  });

  it("monitors updated 事件触发 monitors 失效重取", async () => {
    const { client, calls } = createMockApiClient(STANDARD_RESPONSES);
    const { Wrapper } = createWrapper();

    renderHook(
      () =>
        useWarMapData({
          apiClient: client as never,
          enabled: true,
          ...STANDARD_QUERY_INPUT,
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(
        calls.filter((call) => call.url === "situation-monitor/monitors").length,
      ).toBe(1);
    });

    await act(async () => {
      window.dispatchEvent(
        new Event(SITUATION_MONITOR_MONITORS_UPDATED_EVENT),
      );
    });

    await waitFor(() => {
      expect(
        calls.filter((call) => call.url === "situation-monitor/monitors").length,
      ).toBe(2);
    });
  });

  it("卸载后 monitors updated 事件不再触发请求", async () => {
    const { client, calls } = createMockApiClient(STANDARD_RESPONSES);
    const { Wrapper } = createWrapper();

    const { unmount } = renderHook(
      () =>
        useWarMapData({
          apiClient: client as never,
          enabled: true,
          ...STANDARD_QUERY_INPUT,
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(calls.length).toBeGreaterThanOrEqual(4);
    });

    unmount();

    const monitorsCallsBefore = calls.filter(
      (call) => call.url === "situation-monitor/monitors",
    ).length;

    window.dispatchEvent(new Event(SITUATION_MONITOR_MONITORS_UPDATED_EVENT));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    expect(
      calls.filter((call) => call.url === "situation-monitor/monitors").length,
    ).toBe(monitorsCallsBefore);
  });

  it("placeholderData 语义：key 变化时保留上一次数据", async () => {
    let requestCount = 0;
    const client = {
      get: vi.fn(async (url: string) => {
        if (url === "dashboard/war-map/events") {
          requestCount += 1;
          return {
            data: {
              events: [
                {
                  id: `e${requestCount}`,
                  name: `Event ${requestCount}`,
                  lat: 35,
                  lng: 105,
                  severity: "high",
                },
              ],
              updatedAt: "t",
            },
          };
        }
        if (url === "dashboard/war-map/news-markers") return { data: { markers: [] } };
        if (url === "dashboard/war-map/layers") return { data: { layers: {} } };
        return { data: [] };
      }),
    };
    const { Wrapper } = createWrapper();

    const { result, rerender } = renderHook(
      (props: { start: string }) =>
        useWarMapData({
          apiClient: client as never,
          enabled: true,
          start: props.start,
          end: "2026-01-08T00:00:00.000Z",
        }),
      {
        wrapper: Wrapper,
        initialProps: { start: "2026-01-01T00:00:00.000Z" },
      },
    );

    await waitFor(() => {
      expect(result.current.eventsQuery.data?.events[0]?.id).toBe("e1");
    });

    rerender({ start: "2026-01-02T00:00:00.000Z" });

    // 新 key 请求进行中时，placeholderData 保留旧数据（不闪回 undefined）
    await waitFor(() => {
      expect(result.current.eventsQuery.data?.events[0]?.id).toBe("e2");
    });
    expect(result.current.eventsQuery.isLoading).toBe(false);
    expect(result.current.eventsQuery.data?.events[0]?.name).toBe("Event 2");
  });
});
