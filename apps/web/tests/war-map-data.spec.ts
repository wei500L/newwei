import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { normalizeStoredSituationMonitors } from "../app/(app)/situation-monitor/monitors-query";

import {
  WAR_MAP_QUERY_KEYS,
  WAR_MAP_UNSUPPORTED_LAYER_IDS,
  buildWarMapBaseRequestParams,
  buildWarMapEventsQueryKey,
  buildWarMapLayerRequestParams,
  buildWarMapLayersQueryKey,
  buildWarMapNewsMarkersQueryKey,
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

  it("builds base request params without leaking layer-only controls", () => {
    const input = {
      start: "2026-03-01T00:00:00.000Z",
      end: "2026-03-02T00:00:00.000Z",
      zoom: 3.555,
      cluster: false,
      flightMode: "all" as const,
      aisMode: "density" as const,
    };

    expect(buildWarMapBaseRequestParams(input)).toEqual({
      start: "2026-03-01T00:00:00.000Z",
      end: "2026-03-02T00:00:00.000Z",
      zoom: "3.56",
      cluster: "0",
    });
  });

  it("builds layer request params with explicit flight and AIS modes", () => {
    expect(
      buildWarMapLayerRequestParams({
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
    expect(source).toContain(
      '<WarMap className="flex-1" layoutVariant="standalone" />',
    );
    expect(source).toContain(
      "min-h-[calc(100dvh-var(--top-nav-height,4rem)-var(--ticker-height,0px)-2rem)]",
    );
    expect(source).toContain(
      "md:min-h-[calc(100dvh-var(--top-nav-height,4rem)-var(--ticker-height,0px)-3rem)]",
    );
    expect(source).toContain("max-h-[56rem]");
    expect(source).toContain("min-h-[30rem]");
    expect(source).toContain("OpenSky flight activity");
    expect(source).toContain("Signals, News & Flights");
  });

  it("wires dashboard stream coverage for map news and layers", () => {
    const source = read("app/(app)/dashboard/use-dashboard-stream.ts");

    expect(source).toContain("DASHBOARD_STREAM_EVENT_TYPES.warMapNewsMarkers");
    expect(source).toContain("DASHBOARD_STREAM_EVENT_TYPES.warMapLayers");
    expect(source).toContain("buildWarMapNewsMarkersQueryKey");
    expect(source).toContain("buildWarMapLayersQueryKey");
    expect(source).toContain(
      "queueStreamUpdate('war-map-news-markers', warMapNewsMarkersKey, payload)",
    );
    expect(source).toContain(
      "queueStreamUpdate('war-map-layers', warMapLayersKey, payload)",
    );
    expect(source).not.toContain("invalidateWarMapNewsMarkerQueries");
    expect(source).not.toContain("invalidateWarMapLayerQueries");
  });

  it("routes layer-only params exclusively to the layers chain", () => {
    const source = read(
      "app/(app)/dashboard/charts/war-map/use-war-map-data.ts",
    );
    const eventsBlock =
      source
        .split("const eventsQuery = useQuery({")[1]
        ?.split("const newsQuery = useQuery({")[0] ?? "";
    const newsBlock =
      source
        .split("const newsQuery = useQuery({")[1]
        ?.split("const layersQuery = useQuery({")[0] ?? "";
    const layersBlock =
      source
        .split("const layersQuery = useQuery({")[1]
        ?.split("const monitorsQuery = useQuery({")[0] ?? "";

    expect(eventsBlock).toContain(
      "params: buildWarMapBaseRequestParams({ ...queryInput, cluster: false })",
    );
    expect(newsBlock).toContain(
      "params: buildWarMapBaseRequestParams({ ...queryInput, cluster: false })",
    );
    expect(layersBlock).toContain(
      "queryKey: buildWarMapLayersQueryKey(queryInput)",
    );
    expect(layersBlock).toContain(
      "params: buildWarMapLayerRequestParams(queryInput)",
    );
    expect(layersBlock).not.toContain(
      "placeholderData: (previous) => previous",
    );
  });

  it("uses layer-only reset and realtime status in the shared WarMap component", () => {
    const source = read("app/(app)/dashboard/charts/war-map/war-map.tsx");
    const controlsSource = read(
      "app/(app)/dashboard/charts/war-map/war-map-controls-panel.tsx",
    );

    expect(source).toContain("const resetLayers = useWarMapSettingsStore");
    expect(source).toContain("onResetLayers: resetLayers,");
    expect(controlsSource).toContain("onClick={view.onResetLayers}");
    expect(source).toContain("const internalStreamState = useDashboardStream(");
    expect(source).toContain(
      "const resolvedStreamState = streamState ?? internalStreamState;",
    );
    expect(source).toContain("onRealtimeQueryChange");
    expect(source).toContain(
      "const dataEnabled = Boolean(session?.accessToken && inView && urlHydrated);",
    );
    expect(source).toContain("enabled: dataEnabled,");
    expect(source).toContain("WAR_MAP_UNSUPPORTED_LAYER_IDS.has(layerId)");
    expect(source).not.toContain("useDashboardRangeStore");
    expect(source).toContain(
      "const [rangeAnchorMs, setRangeAnchorMs] = useState(() => Date.now())",
    );
    expect(source).toContain("onEffectiveRangeChange");
    expect(source).toContain("warMapBBox: queryBbox");
    expect(source).toContain("warMapFlightMode: flightMode");
    expect(source).toContain("warMapAisMode: effectiveAisMode");
    expect(source).toContain(
      'const flightsSource = readSummaryString(flightsSummary, "source");',
    );
    expect(source).toContain(
      'const flightsScope = readSummaryString(flightsSummary, "scope");',
    );
    expect(source).toContain('defaultValue: "Flight source"');
    expect(source).toContain('defaultValue: "OpenSky"');
    expect(source).toContain('defaultValue: "Military / possible military"');
    expect(source).toContain("flightBudgetLimited");
    expect(source).toContain(
      "temporarily limited to preserve the daily credit budget",
    );
    expect(source).toContain(
      "const flightMode = useWarMapSettingsStore((state) => state.flightMode);",
    );
    expect(source).toContain(
      "const aisMode = useWarMapSettingsStore((state) => state.aisMode);",
    );
    expect(source).toContain(
      "const aisHighlightCandidates = useWarMapSettingsStore(",
    );
    expect(source).toContain("onFlightModeChange: setFlightMode,");
    expect(source).toContain(
      "onAisHighlightCandidatesChange: setAisHighlightCandidates,",
    );
    expect(source).toContain('id: "wm-ais-candidate-highlight-glow"');
    expect(controlsSource).toContain(
      'onClick={() => transport.onFlightModeChange("all")}',
    );
    expect(controlsSource).toContain(
      "transport.onAisHighlightCandidatesChange(",
    );
    expect(controlsSource).toContain(
      'onClick={() => transport.onAisModeChange("density")}',
    );
    expect(controlsSource).toContain(
      'onClick={() => transport.onAisModeChange("all")}',
    );
    expect(controlsSource.indexOf('defaultValue: "All vessels"')).toBeLessThan(
      controlsSource.indexOf('defaultValue: "Candidate vessels"'),
    );
    expect(controlsSource).toContain('defaultValue: "Candidate vessels"');
    expect(controlsSource).toContain('defaultValue: "Highlight candidates"');
    expect(controlsSource).toContain("aisCandidatesOnlyActiveHint");
    expect(controlsSource).toContain("aisDensityOnlyActiveHint");
    expect(controlsSource).toContain('defaultValue: "Switch to All vessels"');
    expect(source).toContain('id: "wm-ais-density-zones"');
    expect(source).toContain("Aggregated AIS hotspot, not individual vessels.");
    expect(source).toContain(
      "Aggregated AIS chokepoint signal, not individual vessels.",
    );
    expect(source).toContain("isAisViewportEmptyStateActive({");
    expect(source).toContain('id: "wm-ais-vessels"');
    expect(source).toContain("getAngle: resolveVesselIconAngle");
    expect(source).toContain(
      'defaultValue: "Viewport has no vessel positions"',
    );
    expect(source).toContain(
      "All vessels is active, but this viewport currently has no individual ship positions in the live snapshot.",
    );
    expect(controlsSource).toContain("transport.aisViewportEmptyStateActive");
    expect(controlsSource).toContain("transport.aisViewportEmptyStateHint");
    expect(controlsSource).toContain("dashboard.charts.warMap.legend.aisTitle");
    expect(source).toContain('className="grid gap-3 sm:grid-cols-2"');
    expect(source).toContain("!min-h-[42px] !w-full !items-center rounded-xl");
  });

  it("suppresses map chrome behind fatal overlays while keeping nonfatal retry banners", () => {
    const source = read("app/(app)/dashboard/charts/war-map/war-map.tsx");

    expect(source).toContain(
      "const hasFatalDataError = !anyLoading && errors.length > 0 && !hasData;",
    );
    expect(source).toContain("const fatalOverlay = mapLoadError");
    expect(source).toContain("const hasFatalOverlay = Boolean(fatalOverlay);");
    expect(source).toContain("{!hasFatalOverlay ? (");
    expect(source).toContain(
      'className="absolute inset-0 z-30 rounded-lg bg-white/80 backdrop-blur-sm dark:bg-slate-950/[0.72]"',
    );
    expect(source).toContain("showCachedDataHint");
  });

  it("keeps loading non-blocking and refreshes only the current query window", () => {
    const source = read("app/(app)/dashboard/charts/war-map/war-map.tsx");
    const overlayModelSource = read(
      "app/(app)/dashboard/charts/war-map/war-map-overlay-model.ts",
    );
    const refreshBlock =
      source
        .split(
          "const { pending: refreshingMapData, run: refreshMapData } = usePendingAction(",
        )[1]
        ?.split(");")[0] ?? "";

    expect(source).not.toContain("Skeleton");
    expect(source).toContain("formatRelativeTime");
    expect(source).toContain("const showBootOverlay =");
    expect(source).toContain(
      "!mapLoadError && (!mapReady || (anyLoading && !hasData));",
    );
    expect(source).toContain('defaultValue: "Loading map base layer…"');
    expect(source).toContain('defaultValue: "Refreshing {{count}} chains"');
    expect(overlayModelSource).toContain(
      'defaultValue: "Latest stream update"',
    );
    expect(overlayModelSource).toContain(
      'defaultValue: "No stream update yet"',
    );
    expect(overlayModelSource).toContain('defaultValue: "Awaiting refresh"');
    expect(source).toContain('defaultValue: "Awaiting first refresh"');
    expect(source).toContain('defaultValue: "Last updated {{value}}"');
    expect(refreshBlock).not.toContain("refreshRangeAnchor();");
    expect(refreshBlock).toContain("eventsQuery.refetch()");
    expect(refreshBlock).toContain("newsQuery.refetch()");
    expect(refreshBlock).toContain("layersQuery.refetch()");
    expect(refreshBlock).toContain("monitorsQuery.refetch()");
  });

  it("extracts overlay models and components while keeping controls stateful", () => {
    const source = read("app/(app)/dashboard/charts/war-map/war-map.tsx");

    expect(source).toContain('from "./war-map-overlay-model";');
    expect(source).toContain('from "./war-map-controls-panel";');
    expect(source).toContain('from "./war-map-overlay-rail";');
    expect(source).toContain('from "./war-map-inspector-panel";');
    expect(source).toContain("buildWarMapOverlayLayout({");
    expect(source).toContain("buildWarMapOverlayViewModel({");
    expect(source).toContain("<WarMapOverlayRail");
    expect(source).toContain("<WarMapControlsPanel");
    expect(source).toContain("<WarMapLegendDock");
    expect(source).toContain("<WarMapInspectorPanel");
    expect(source).toContain('useState<OverlayControlsSection>("view")');
    expect(source).toContain('layoutVariant = "embedded"');
    expect(source).toContain("const standaloneLayout =");
    expect(source).toContain("if (standaloneLayout) {");
    expect(source).toContain("scrollLegendDockIntoView();");
    expect(source).toContain('setOpenOverlayPanel("legend")');
    expect(source).not.toContain('setControlsSection("overview");');
    expect(source).not.toContain("legendOverlayRef");
    expect(source).not.toContain(
      "legend={{ showAisLegend: layerVisibility.ais }}",
    );
    expect(source).toContain('current === "controls" ? null : "controls"');
    expect(source).toContain('placement="bottom"');
    expect(source).toContain(
      "const mobileControlsDrawerHeight = `min(${overlayLayout.controlsDrawerHeight}px, calc(100dvh - 72px))`;",
    );
    expect(source).toContain(
      "const standaloneControlsDrawerHeight = `min(${overlayLayout.standaloneDrawerHeight}px, calc(100dvh - 96px))`;",
    );
    expect(source).toContain("closable={false}");
    expect(source).toContain(
      "getContainer={standaloneLayout ? false : undefined}",
    );
    expect(source).toContain(
      "style={{ height: overlayLayout.legendDockHeight }}",
    );
    expect(source).not.toContain('placement="right"');
    expect(source).toContain("resolveWarMapContainerClassName(className)");
  });

  it("keeps overlay settings surfaces dark-theme aware", () => {
    const source = read("app/(app)/dashboard/charts/war-map/war-map.tsx");
    const overlayModelSource = read(
      "app/(app)/dashboard/charts/war-map/war-map-overlay-model.ts",
    );
    const controlsSource = read(
      "app/(app)/dashboard/charts/war-map/war-map-controls-panel.tsx",
    );
    const railSource = read(
      "app/(app)/dashboard/charts/war-map/war-map-overlay-rail.tsx",
    );
    const inspectorSource = read(
      "app/(app)/dashboard/charts/war-map/war-map-inspector-panel.tsx",
    );

    expect(overlayModelSource).toContain("dark:bg-slate-950/[0.72]");
    expect(overlayModelSource).toContain("dark:hover:bg-slate-950/[0.82]");
    expect(overlayModelSource).toContain("resolveOverlayButtonClassName");
    expect(overlayModelSource).toContain("OVERLAY_STATUS_TAG_CLASS_NAME");
    expect(controlsSource).toContain("bg-white/[0.88]");
    expect(controlsSource).toContain("dark:bg-slate-900/70");
    expect(controlsSource).toContain("ControlsChoiceButton");
    expect(controlsSource).toContain("OVERLAY_PANEL_OPTION_GRID_CLASS_NAME");
    expect(controlsSource).toContain("OVERLAY_PANEL_TAB_GRID_CLASS_NAME");
    expect(controlsSource).toContain(
      "OVERLAY_PANEL_STANDALONE_SPLIT_GRID_CLASS_NAME",
    );
    expect(controlsSource).toContain("resolveOverlayButtonClassName({");
    expect(controlsSource).toContain("ControlsHeaderSummary");
    expect(controlsSource).toContain("renderControlsTabLabel");
    expect(controlsSource).toContain("ResizeObserver");
    expect(controlsSource).toContain("transport.onOpenLegend");
    expect(controlsSource).toContain("overscroll-contain");
    expect(controlsSource).toContain("WarMapLegendDock");
    expect(controlsSource).not.toContain("legend.showAisLegend");
    expect(railSource).toContain("dark:bg-slate-950/[0.78]");
    expect(railSource).toContain('layoutVariant = "embedded"');
    expect(railSource).toContain("right-4 z-10 flex justify-end");
    expect(railSource).toContain("iconOnly: !showActionLabels");
    expect(railSource).toContain(
      "!h-10 !min-w-[6.5rem] !px-4 !text-xs !font-semibold",
    );
    expect(railSource).toContain("const usesLegendDock =");
    expect(inspectorSource).toContain("dark:from-amber-500/10");
    expect(inspectorSource).toContain("dark:bg-slate-950/[0.78]");
    expect(inspectorSource).toContain("OVERLAY_NEUTRAL_TAG_CLASS_NAME");
    expect(source).toContain("OVERLAY_SURFACE_CLASS_NAME");
  });

  it("shares a single dashboard stream connection with the embedded map", () => {
    const source = read("app/(app)/dashboard/dashboard-content.tsx");

    expect(source).toContain(
      "const dashboardStreamState = useDashboardStream({",
    );
    expect(source).toContain(
      "const [warMapRealtimeQuery, setWarMapRealtimeQuery] = useState",
    );
    expect(source).toContain("warMapStart: warMapRealtimeQuery?.start");
    expect(source).toContain("warMapBBox: warMapRealtimeQuery?.bbox");
    expect(source).toContain("streamState={dashboardStreamState}");
    expect(source).toContain(
      "onRealtimeQueryChange={handleWarMapRealtimeQueryChange}",
    );
    expect(source).toContain(
      'className="xl:col-span-2 h-[500px] glass-panel border border-[var(--border)] overflow-hidden flex flex-col"',
    );
    expect(source).toContain('className="min-h-0 flex flex-1"');
    expect(source).toContain('className="flex-1"');
    expect(source).not.toContain('className="absolute top-4 left-4 z-10"');
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
    expect(zhWarMap.stats.flightBudgetLimited).toBe(
      "为了保留当天额度，OpenSky 全部航班模式已被临时限制。",
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
