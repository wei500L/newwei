import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  WAR_MAP_QUERY_KEYS,
  WAR_MAP_UNSUPPORTED_LAYER_IDS,
  buildWarMapEventsQueryKey,
  buildWarMapLayersQueryKey,
  buildWarMapNewsMarkersQueryKey,
  buildWarMapRequestParams,
  normalizeStoredSituationMonitors,
  normalizeWarMapEventsResponse,
  normalizeWarMapLayersResponse,
  normalizeWarMapNewsMarkersResponse,
} from "../app/(app)/dashboard/charts/war-map/war-map-data";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");
const readJson = <T>(relativePath: string): T =>
  JSON.parse(read(relativePath)) as T;

describe("war-map data contract helpers", () => {
  it("builds stable query keys for the three map data chains", () => {
    const input = {
      start: "2026-03-01T00:00:00.000Z",
      end: "2026-03-02T00:00:00.000Z",
      translateTarget: "zh-CN" as const,
      bbox: "10,20,30,40",
      zoom: 4.257,
      flightMode: "all" as const,
      aisMode: "density" as const,
    };

    expect(buildWarMapEventsQueryKey(input)).toEqual([
      ...WAR_MAP_QUERY_KEYS.eventsPrefix,
      input.start,
      input.end,
      input.bbox,
      4.26,
      "zh-CN",
    ]);
    expect(buildWarMapNewsMarkersQueryKey(input)).toEqual([
      ...WAR_MAP_QUERY_KEYS.newsMarkersPrefix,
      input.start,
      input.end,
      input.bbox,
      4.26,
      "zh-CN",
    ]);
    expect(buildWarMapLayersQueryKey(input)).toEqual([
      ...WAR_MAP_QUERY_KEYS.layersPrefix,
      input.start,
      input.end,
      input.bbox,
      4.26,
      "zh-CN",
      "all",
      "density",
    ]);
  });

  it("builds request params without leaking undefined values", () => {
    expect(
      buildWarMapRequestParams({
        start: "2026-03-01T00:00:00.000Z",
        end: "2026-03-02T00:00:00.000Z",
        zoom: 3.555,
        cluster: false,
        flightMode: "all",
        aisMode: "density",
      }),
    ).toEqual({
      start: "2026-03-01T00:00:00.000Z",
      end: "2026-03-02T00:00:00.000Z",
      zoom: "3.56",
      cluster: "0",
      flightMode: "all",
      aisMode: "density",
    });
  });

  it("normalizes events, news markers, layers, and monitors defensively", () => {
    expect(
      normalizeWarMapEventsResponse({
        events: [
          { id: "ev-1", name: "Paris", lat: 48.8, lng: 2.3, severity: "high" },
          { id: "", name: "bad", lat: 1, lng: 1, severity: "low" },
        ],
      }),
    ).toEqual({
      events: [
        {
          id: "ev-1",
          name: "Paris",
          lat: 48.8,
          lng: 2.3,
          severity: "high",
          derivedScore: 0,
          value: 0,
        },
      ],
      updatedAt: undefined,
      clustered: undefined,
    });

    expect(
      normalizeWarMapNewsMarkersResponse({
        markers: [
          {
            id: "news-1",
            title: "Headline",
            location: "Paris",
            lat: 48.8,
            lng: 2.3,
            geoSource: "fallback-country",
          },
          { id: "bad", title: "", location: "nowhere", lat: 0, lng: 0 },
        ],
      }),
    ).toEqual({
      markers: [
        {
          id: "news-1",
          title: "Headline",
          location: "Paris",
          lat: 48.8,
          lng: 2.3,
          geoSource: "fallback-country",
        },
      ],
      updatedAt: undefined,
      clustered: undefined,
    });

    expect(
      normalizeWarMapLayersResponse({
        updatedAt: "2026-03-01T00:00:00.000Z",
        layers: {
          conflicts: {
            layerId: "conflicts",
            geometryType: "polygon",
            features: [
              {
                id: "polygon-1",
                polygon: [[[1, 2]]],
                properties: { name: "A" },
              },
            ],
          },
          ignored: {
            layerId: "ignored",
            geometryType: "point",
            features: [{ id: "x", lat: 1, lng: 2 }],
          },
        },
      }),
    ).toEqual({
      updatedAt: "2026-03-01T00:00:00.000Z",
      layers: {
        conflicts: {
          layerId: "conflicts",
          geometryType: "polygon",
          features: [
            { id: "polygon-1", polygon: [[[1, 2]]], properties: { name: "A" } },
          ],
        },
      },
    });

    expect(
      normalizeStoredSituationMonitors([
        { id: "monitor-1", name: "A" },
        null,
        { name: "missing-id" },
      ]),
    ).toEqual([{ id: "monitor-1", name: "A" }]);
  });

  it("keeps unsupported raster layers out of the displayable set", () => {
    expect(WAR_MAP_UNSUPPORTED_LAYER_IDS.has("dayNight")).toBe(true);
  });
});

describe("war-map page wiring", () => {
  it("removes the external time range control from the standalone map page", () => {
    const source = read("app/(app)/map/page.tsx");

    expect(source).not.toContain("TimeRangeControls");
    expect(source).toContain('<WarMap className="h-full" />');
    expect(source).toContain("OpenSky flight activity");
    expect(source).toContain("Signals, News & Flights");
  });

  it("wires dashboard stream coverage for map news and layers", () => {
    const source = read("app/(app)/dashboard/use-dashboard-stream.ts");

    expect(source).toContain("DASHBOARD_STREAM_EVENT_TYPES.warMapNewsMarkers");
    expect(source).toContain("DASHBOARD_STREAM_EVENT_TYPES.warMapLayers");
    expect(source).toContain("WAR_MAP_QUERY_KEYS.newsMarkersPrefix");
    expect(source).toContain("WAR_MAP_QUERY_KEYS.layersPrefix");
  });

  it("requests viewport-aware layers without keeping stale placeholder data", () => {
    const source = read(
      "app/(app)/dashboard/charts/war-map/use-war-map-data.ts",
    );
    const layersBlock =
      source
        .split("const layersQuery = useQuery({")[1]
        ?.split("const monitorsQuery = useQuery({")[0] ?? "";

    expect(layersBlock).toContain(
      "queryKey: buildWarMapLayersQueryKey(queryInput)",
    );
    expect(layersBlock).toContain(
      "params: buildWarMapRequestParams(queryInput)",
    );
    expect(layersBlock).not.toContain(
      "placeholderData: (previous) => previous",
    );
  });

  it("uses layer-only reset and realtime status in the shared WarMap component", () => {
    const source = read("app/(app)/dashboard/charts/war-map/war-map.tsx");

    expect(source).toContain("const resetLayers = useWarMapSettingsStore");
    expect(source).toContain("onClick={() => resetLayers()}");
    expect(source).toContain("const internalStreamState = useDashboardStream(");
    expect(source).toContain(
      "const resolvedStreamState = streamState ?? internalStreamState;",
    );
    expect(source).toContain(
      "const dataEnabled = Boolean(session?.accessToken && inView);",
    );
    expect(source).toContain("enabled: dataEnabled,");
    expect(source).toContain("WAR_MAP_UNSUPPORTED_LAYER_IDS.has(layerId)");
    expect(source).not.toContain("useDashboardRangeStore");
    expect(source).toContain(
      "const [rangeAnchorMs, setRangeAnchorMs] = useState(() => Date.now())",
    );
    expect(source).toContain("onEffectiveRangeChange");
    expect(source).toContain(
      'const flightsSource = readSummaryString(flightsSummary, "source");',
    );
    expect(source).toContain(
      'const flightsScope = readSummaryString(flightsSummary, "scope");',
    );
    expect(source).toContain('defaultValue: "Flight source"');
    expect(source).toContain('defaultValue: "OpenSky"');
    expect(source).toContain('defaultValue: "Military / possible military"');
    expect(source).toContain(
      "const flightMode = useWarMapSettingsStore((state) => state.flightMode);",
    );
    expect(source).toContain(
      "const aisMode = useWarMapSettingsStore((state) => state.aisMode);",
    );
    expect(source).toContain('onClick={() => setFlightMode("all")}');
    expect(source).toContain('onClick={() => setAisMode("density")}');
    expect(source).toContain('onClick={() => setAisMode("all")}');
    expect(source).toContain('id: "wm-ais-density-heatmap"');
    expect(source).toContain("dashboard.charts.warMap.legend.aisTitle");
  });

  it("keeps loading non-blocking and refreshes only the current query window", () => {
    const source = read("app/(app)/dashboard/charts/war-map/war-map.tsx");
    const refreshBlock =
      source
        .split(
          "const { pending: refreshingMapData, run: refreshMapData } = usePendingAction(",
        )[1]
        ?.split(");")[0] ?? "";

    expect(source).toContain("import {");
    expect(source).toContain("  Button,");
    expect(source).toContain("  Checkbox,");
    expect(source).toContain("  Drawer,");
    expect(source).toContain("  Typography,");
    expect(source).toContain('} from "antd";');
    expect(source).not.toContain("Skeleton");
    expect(source).toContain("formatRelativeTime");
    expect(source).toContain("const showBootOverlay =");
    expect(source).toContain(
      "!mapLoadError && (!mapReady || (anyLoading && !hasData));",
    );
    expect(source).toContain('defaultValue: "Loading map base layer…"');
    expect(source).toContain('defaultValue: "Refreshing {{count}} chains"');
    expect(source).toContain('defaultValue: "Stream message"');
    expect(source).toContain('defaultValue: "Data updated"');
    expect(refreshBlock).not.toContain("refreshRangeAnchor();");
    expect(refreshBlock).toContain("eventsQuery.refetch()");
    expect(refreshBlock).toContain("newsQuery.refetch()");
    expect(refreshBlock).toContain("layersQuery.refetch()");
    expect(refreshBlock).toContain("monitorsQuery.refetch()");
  });

  it("shares a single dashboard stream connection with the embedded map", () => {
    const source = read("app/(app)/dashboard/dashboard-content.tsx");

    expect(source).toContain(
      "const dashboardStreamState = useDashboardStream({",
    );
    expect(source).toContain(
      "const [warMapStreamRange, setWarMapStreamRange] = useState",
    );
    expect(source).toContain("streamState={dashboardStreamState}");
    expect(source).toContain(
      "onEffectiveRangeChange={handleWarMapRangeChange}",
    );
  });
});

describe("war-map zh locale", () => {
  it("keeps the zh war-map copy free of the known English leftovers", () => {
    const zhWarMap = readJson<{
      dashboard: {
        charts: {
          warMap: {
            stats: Record<string, string>;
            tooltip: Record<string, string>;
            empty: Record<string, string>;
          };
        };
      };
    }>("lib/locales/zh.json").dashboard.charts.warMap;

    expect(zhWarMap.stats.flightNotConfigured).toBe(
      "尚未配置 OpenSky OAuth 客户端凭据。",
    );
    expect(zhWarMap.stats.aisClients).toBe("中继客户端");
    expect(zhWarMap.stats.aisAllUnavailableHint).toBe(
      "待 relay 在 snapshot 负载中提供 vessels[] 字段后，才会开放全部船舶模式。",
    );
    expect(zhWarMap.tooltip.clusterFlights).toBe(
      "{{count}} 架军用航班，点击放大查看。",
    );
    expect(zhWarMap.tooltip.clusterLayer).toBe(
      "{{count}} 个{{layer}}点位，点击放大查看。",
    );
    expect(zhWarMap.tooltip.observed).toBe("观测时间");
    expect(zhWarMap.tooltip.registration).toBe("注册号");
    expect(zhWarMap.tooltip.aircraftType).toBe("机型");
    expect(zhWarMap.tooltip.country).toBe("国家/地区");
    expect(zhWarMap.tooltip.heading).toBe("航向");
    expect(zhWarMap.tooltip.altitude).toBe("高度");
    expect(zhWarMap.tooltip.speed).toBe("速度");
    expect(zhWarMap.tooltip.updated).toBe("更新时间");
    expect(zhWarMap.empty.hiddenLayers).toBe(
      "有可用的叠加图层，但被筛选隐藏了；可在“图层”中开启。",
    );
  });
});
