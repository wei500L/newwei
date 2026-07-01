"use client";

import { Button } from "antd";
import * as echarts from "echarts/core";
import { install as installCandlestickChart } from "echarts/lib/chart/candlestick/install.js";
import { install as installGraphChart } from "echarts/lib/chart/graph/install.js";
import { install as installLineChart } from "echarts/lib/chart/line/install.js";
import { install as installAxisPointerComponent } from "echarts/lib/component/axisPointer/install.js";
import { install as installDataZoomComponent } from "echarts/lib/component/dataZoom/install.js";
import { install as installGridComponent } from "echarts/lib/component/grid/install.js";
import { install as installLegendComponent } from "echarts/lib/component/legend/install.js";
import { install as installTooltipComponent } from "echarts/lib/component/tooltip/install.js";
import { install as installCanvasRenderer } from "echarts/lib/renderer/installCanvasRenderer.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ChartSkeleton } from "@/components/chart-skeleton";
import {
  CHART_DARK_TEXT_COLORS,
  CHART_DARK_TOOLTIP_BG,
  CHART_DARK_TOOLTIP_BORDER,
  CHART_LIGHT_TEXT_COLORS,
  CHART_LIGHT_TOOLTIP_BG,
  CHART_SERIES_DARK,
  CHART_SERIES_LIGHT,
} from "@/lib/chart-theme-tokens";
import {
  downloadDataUrlFile,
  sanitizeFilename,
  yieldToMain,
} from "@/lib/data-export";
import {
  hasRenderableContainerSize,
  useRenderableContainer,
} from "@/lib/map/use-renderable-container";

type Installer = Parameters<typeof echarts.use>[0];

interface EchartsRuntimeState {
  installed: Set<string>;
  installPromises: Map<string, Promise<void>>;
  themesRegistered: boolean;
}

const ECHARTS_RUNTIME_KEY = "__modular_echarts_runtime__";

const getRuntimeState = (): EchartsRuntimeState => {
  const target = globalThis as typeof globalThis & {
    [ECHARTS_RUNTIME_KEY]?: EchartsRuntimeState;
  };

  if (!target[ECHARTS_RUNTIME_KEY]) {
    target[ECHARTS_RUNTIME_KEY] = {
      installed: new Set<string>(),
      installPromises: new Map<string, Promise<void>>(),
      themesRegistered: false,
    };
  }

  return target[ECHARTS_RUNTIME_KEY];
};

const preinstallRuntimeModules = () => {
  const runtime = getRuntimeState();
  const installers: [string, Installer][] = [
    // These modules back the finance dashboard's hot path and are worth
    // preloading to avoid long-lived skeletons while dynamic chunks resolve.
    ["renderer:canvas", installCanvasRenderer as unknown as Installer],
    ["component:grid", installGridComponent as unknown as Installer],
    ["component:tooltip", installTooltipComponent as unknown as Installer],
    ["component:axisPointer", installAxisPointerComponent as unknown as Installer],
    ["component:dataZoom", installDataZoomComponent as unknown as Installer],
    ["component:legend", installLegendComponent as unknown as Installer],
    ["chart:line", installLineChart as unknown as Installer],
    ["chart:candlestick", installCandlestickChart as unknown as Installer],
    // Graph depends on coordinate-system/layout hooks that must exist before init.
    ["chart:graph", installGraphChart as unknown as Installer],
  ];

  installers.forEach(([key, installer]) => {
    if (runtime.installed.has(key)) {
      return;
    }
    echarts.use(installer);
    runtime.installed.add(key);
  });
};

preinstallRuntimeModules();

const installOnce = (key: string, loader: () => Promise<Installer>) => {
  const runtime = getRuntimeState();

  if (runtime.installed.has(key)) {
    return Promise.resolve();
  }
  const existing = runtime.installPromises.get(key);
  if (existing) {
    return existing;
  }
  const p = loader()
    .then((installer) => {
      if (runtime.installed.has(key)) return;
      echarts.use(installer);
      runtime.installed.add(key);
    })
    .finally(() => {
      runtime.installPromises.delete(key);
    });
  runtime.installPromises.set(key, p);
  return p;
};

const ensureRenderer = async (renderer: "canvas" | "svg") => {
  if (renderer === "svg") {
    await installOnce("renderer:svg", async () => {
      const m = await import("echarts/lib/renderer/installSVGRenderer.js");
      return m.install;
    });
    return;
  }
  await installOnce("renderer:canvas", async () => {
    const m = await import("echarts/lib/renderer/installCanvasRenderer.js");
    return m.install;
  });
};

const normalizeToArray = (value: unknown): unknown[] => {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
};

const inferSeriesTypes = (option: echarts.EChartsCoreOption): Set<string> => {
  const series = normalizeToArray((option as { series?: unknown }).series);
  const types = new Set<string>();
  for (const s of series) {
    if (!s || typeof s !== "object") continue;
    const t = (s as { type?: unknown }).type;
    if (typeof t === "string") {
      types.add(t);
    }
  }
  return types;
};

const optionNeedsGrid = (
  option: echarts.EChartsCoreOption,
  seriesTypes: Set<string>,
) => {
  const o = option as Record<string, unknown>;
  if (o.grid || o.xAxis || o.yAxis) return true;
  for (const t of seriesTypes) {
    if (
      t === "line" ||
      t === "bar" ||
      t === "candlestick" ||
      t === "scatter" ||
      t === "heatmap"
    ) {
      return true;
    }
  }
  return false;
};

const ensureOptionModules = async (option: echarts.EChartsCoreOption) => {
  const seriesTypes = inferSeriesTypes(option);
  const o = option as Record<string, unknown>;

  const promises: Promise<void>[] = [];

  if (o.title) {
    promises.push(
      installOnce("component:title", async () => {
        const m = await import("echarts/lib/component/title/install.js");
        return m.install;
      }),
    );
  }
  if (o.tooltip) {
    promises.push(
      installOnce("component:tooltip", async () => {
        const m = await import("echarts/lib/component/tooltip/install.js");
        return m.install;
      }),
    );
    promises.push(
      installOnce("component:axisPointer", async () => {
        const m = await import("echarts/lib/component/axisPointer/install.js");
        return m.install;
      }),
    );
  }
  if (o.legend) {
    promises.push(
      installOnce("component:legend", async () => {
        const m = await import("echarts/lib/component/legend/install.js");
        return m.install;
      }),
    );
  }
  if (optionNeedsGrid(option, seriesTypes)) {
    promises.push(
      installOnce("component:grid", async () => {
        const m = await import("echarts/lib/component/grid/install.js");
        return m.install;
      }),
    );
  }
  if (o.dataZoom) {
    promises.push(
      installOnce("component:dataZoom", async () => {
        const m = await import("echarts/lib/component/dataZoom/install.js");
        return m.install;
      }),
    );
  }
  if (o.toolbox) {
    promises.push(
      installOnce("component:toolbox", async () => {
        const m = await import("echarts/lib/component/toolbox/install.js");
        return m.install;
      }),
    );
  }
  if (o.visualMap) {
    promises.push(
      installOnce("component:visualMap", async () => {
        const m = await import("echarts/lib/component/visualMap/install.js");
        return m.install;
      }),
    );
  }
  if (o.timeline) {
    promises.push(
      installOnce("component:timeline", async () => {
        const m = await import("echarts/lib/component/timeline/install.js");
        return m.install;
      }),
    );
  }
  if (o.dataset) {
    promises.push(
      installOnce("component:dataset", async () => {
        const m = await import("echarts/lib/component/dataset/install.js");
        return m.install;
      }),
    );
    promises.push(
      installOnce("component:transform", async () => {
        const m = await import("echarts/lib/component/transform/install.js");
        return m.install;
      }),
    );
  }

  for (const t of seriesTypes) {
    switch (t) {
      case "line":
        promises.push(
          installOnce("chart:line", async () => {
            const m = await import("echarts/lib/chart/line/install.js");
            return m.install;
          }),
        );
        break;
      case "bar":
        promises.push(
          installOnce("chart:bar", async () => {
            const m = await import("echarts/lib/chart/bar/install.js");
            return m.install;
          }),
        );
        break;
      case "pie":
        promises.push(
          installOnce("chart:pie", async () => {
            const m = await import("echarts/lib/chart/pie/install.js");
            return m.install;
          }),
        );
        break;
      case "scatter":
        promises.push(
          installOnce("chart:scatter", async () => {
            const m = await import("echarts/lib/chart/scatter/install.js");
            return m.install;
          }),
        );
        break;
      case "effectScatter":
        promises.push(
          installOnce("chart:effectScatter", async () => {
            const m = await import(
              "echarts/lib/chart/effectScatter/install.js"
            );
            return m.install;
          }),
        );
        break;
      case "radar":
        promises.push(
          installOnce("chart:radar", async () => {
            const m = await import("echarts/lib/chart/radar/install.js");
            return m.install;
          }),
        );
        break;
      case "candlestick":
        promises.push(
          installOnce("chart:candlestick", async () => {
            const m = await import("echarts/lib/chart/candlestick/install.js");
            return m.install;
          }),
        );
        break;
      case "gauge":
        promises.push(
          installOnce("chart:gauge", async () => {
            const m = await import("echarts/lib/chart/gauge/install.js");
            return m.install;
          }),
        );
        break;
      case "heatmap":
        promises.push(
          installOnce("chart:heatmap", async () => {
            const m = await import("echarts/lib/chart/heatmap/install.js");
            return m.install;
          }),
        );
        break;
      case "custom":
        promises.push(
          installOnce("chart:custom", async () => {
            const m = await import("echarts/lib/chart/custom/install.js");
            return m.install;
          }),
        );
        break;
      case "treemap":
        promises.push(
          installOnce("chart:treemap", async () => {
            const m = await import("echarts/lib/chart/treemap/install.js");
            return m.install;
          }),
        );
        break;
      case "graph":
        // Graph extension is pre-registered at module load to ensure
        // coordinate-system/layout hooks are available before chart init.
        break;
      default:
        break;
    }
  }

  await Promise.all(promises);
};

export interface EchartProps {
  option: echarts.EChartsCoreOption;
  height?: number | string;
  lazy?: boolean;
  lazyRootMargin?: string;
  renderer?: "canvas" | "svg";
  group?: string;
  theme?: string | object;
  onEvents?: {
    type: string;
    handler: (params: unknown, chart: echarts.ECharts) => void;
  }[];
  actions?: ReactNode;
  showExportImage?: boolean;
  exportFilename?: string;
  exportPixelRatio?: number;
  exportBackgroundColor?: string;
}

const resolveExportBackground = (
  theme: string | object | undefined,
  override?: string,
) => {
  if (override) return override;
  if (theme && typeof theme === "object") {
    const candidate = (theme as Record<string, unknown>).backgroundColor;
    if (
      typeof candidate === "string" &&
      candidate.trim() &&
      candidate !== "transparent"
    ) {
      return candidate;
    }
  }
  if (typeof document !== "undefined") {
    const bodyBackground = getComputedStyle(document.body).backgroundColor;
    if (bodyBackground && bodyBackground !== "transparent") {
      return bodyBackground;
    }
  }
  if (theme === "smart-dark") {
    return "#0f172a";
  }
  return "#ffffff";
};

const renderSvgToPng = (
  svgDataUrl: string,
  width: number,
  height: number,
  pixelRatio: number,
  backgroundColor: string,
) =>
  new Promise<string>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(width * pixelRatio));
      canvas.height = Math.max(1, Math.floor(height * pixelRatio));
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("Unable to export image"));
        return;
      }
      context.fillStyle = backgroundColor;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.scale(pixelRatio, pixelRatio);
      context.drawImage(image, 0, 0, width, height);
      resolve(canvas.toDataURL("image/png"));
    };
    image.onerror = () => reject(new Error("Unable to export image"));
    image.src = svgDataUrl;
  });

export function DashboardChart({
  option,
  height = 360,
  lazy = true,
  lazyRootMargin = "200px",
  renderer = "canvas",
  group,
  theme,
  onEvents,
  actions,
  showExportImage = false,
  exportFilename,
  exportPixelRatio = 2,
  exportBackgroundColor,
}: EchartProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.EChartsType | null>(null);
  const initPromiseRef = useRef<Promise<
    echarts.EChartsType | undefined
  > | null>(null);
  const [exporting, setExporting] = useState(false);
  const [supportsHover, setSupportsHover] = useState(true);
  const [, setIsInView] = useState(!lazy);
  const [shouldInit, setShouldInit] = useState(!lazy);
  const [ready, setReady] = useState(false);
  // Once a chart has entered view at least once, let initialization finish even
  // if the user scrolls away during module loading or chart setup.
  const renderableContainerReady = useRenderableContainer(ref, shouldInit);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(hover: hover)");
    const updateSupport = () => setSupportsHover(media.matches);
    updateSupport();
    media.addEventListener("change", updateSupport);
    return () => {
      media.removeEventListener("change", updateSupport);
    };
  }, []);

  useEffect(() => {
    if (!lazy) {
      setIsInView(true);
      setShouldInit(true);
      return;
    }

    const dom = ref.current;
    if (!dom) {
      return;
    }

    if (typeof IntersectionObserver === "undefined") {
      setIsInView(true);
      setShouldInit(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        const intersecting = Boolean(entry?.isIntersecting);
        setIsInView(intersecting);
        if (intersecting) {
          setShouldInit(true);
        }
      },
      { rootMargin: lazyRootMargin },
    );

    observer.observe(dom);

    return () => observer.disconnect();
  }, [lazy, lazyRootMargin]);

  useEffect(() => {
    setReady(false);
  }, [renderer, group, theme, shouldInit]);

  useEffect(() => {
    const dom = ref.current;
    if (!dom || !shouldInit || !renderableContainerReady) return;

    let cancelled = false;
    let handleResize: (() => void) | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let resizeFrameId: number | null = null;
    const initPromise = (async () => {
      await ensureRenderer(renderer);
      if (cancelled) return;
      await ensureOptionModules(option);
      if (cancelled) return;

      const runtime = getRuntimeState();
      if (!runtime.themesRegistered) {
        // Register Smart Light Theme
        echarts.registerTheme("smart-light", {
          color: CHART_SERIES_LIGHT,
          backgroundColor: "transparent",
          tooltip: {
            backgroundColor: CHART_LIGHT_TOOLTIP_BG,
            borderColor: CHART_LIGHT_TEXT_COLORS.border,
            textStyle: {
              color: CHART_LIGHT_TEXT_COLORS.primary,
            },
            padding: [10, 14],
            extraCssText:
              "box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08); border-radius: 8px;",
          },
          title: {
            textStyle: {
              color: CHART_LIGHT_TEXT_COLORS.title,
              fontWeight: 600,
            },
          },
          legend: {
            textStyle: {
              color: CHART_LIGHT_TEXT_COLORS.secondary,
            },
          },
          grid: {
            show: false,
            top: 40,
            bottom: 40,
            left: 10,
            right: 10,
            containLabel: true,
          },
          categoryAxis: {
            axisLine: {
              show: true,
              lineStyle: {
                color: CHART_LIGHT_TEXT_COLORS.border,
              },
            },
            axisTick: {
              show: false,
            },
            axisLabel: {
              color: CHART_LIGHT_TEXT_COLORS.tertiary,
              margin: 12,
            },
            splitLine: {
              show: false,
            },
          },
          valueAxis: {
            axisLine: {
              show: false,
            },
            axisTick: {
              show: false,
            },
            axisLabel: {
              color: CHART_LIGHT_TEXT_COLORS.tertiary,
              margin: 12,
            },
            splitLine: {
              show: false,
            },
          },
        });

        // Register Smart Dark Theme
        echarts.registerTheme("smart-dark", {
          color: CHART_SERIES_DARK,
          backgroundColor: "transparent",
          tooltip: {
            backgroundColor: CHART_DARK_TOOLTIP_BG,
            borderColor: CHART_DARK_TOOLTIP_BORDER,
            textStyle: {
              color: CHART_DARK_TEXT_COLORS.primary,
            },
            padding: [10, 14],
            extraCssText:
              "box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3); border-radius: 8px;",
          },
          title: {
            textStyle: {
              color: CHART_DARK_TEXT_COLORS.title,
              fontWeight: 700,
            },
          },
          legend: {
            textStyle: {
              color: CHART_DARK_TEXT_COLORS.tertiary,
            },
          },
          grid: {
            show: false,
            top: 40,
            bottom: 40,
            left: 10,
            right: 10,
            containLabel: true,
          },
          categoryAxis: {
            axisLine: {
              show: true,
              lineStyle: {
                color: CHART_DARK_TOOLTIP_BORDER,
              },
            },
            axisTick: {
              show: false,
            },
            axisLabel: {
              color: CHART_DARK_TEXT_COLORS.secondary,
              margin: 12,
            },
            splitLine: {
              show: false,
            },
          },
          valueAxis: {
            axisLine: {
              show: false,
            },
            axisTick: {
              show: false,
            },
            axisLabel: {
              color: CHART_DARK_TEXT_COLORS.tertiary,
              margin: 12,
            },
            splitLine: {
              show: false,
            },
          },
        });

        runtime.themesRegistered = true;
      }

      const chart = echarts.init(dom, theme || "smart-light", { renderer });
      chartRef.current = chart;
      if (group) {
        chart.group = group;
        echarts.connect(group);
      }

      handleResize = () => {
        try {
          if (!hasRenderableContainerSize(dom)) {
            return;
          }
          chartRef.current?.resize();
        } catch {
          // noop: avoid bubbling resize-time chart exceptions from other panels
        }
      };
      window.addEventListener("resize", handleResize);
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => {
          if (
            typeof window !== "undefined" &&
            typeof window.requestAnimationFrame === "function"
          ) {
            if (resizeFrameId !== null) {
              window.cancelAnimationFrame(resizeFrameId);
            }
            resizeFrameId = window.requestAnimationFrame(() => {
              resizeFrameId = null;
              handleResize?.();
            });
            return;
          }
          handleResize?.();
        });
        resizeObserver.observe(dom);
      }
      handleResize();

      return chart;
    })();

    initPromiseRef.current = initPromise;

    return () => {
      cancelled = true;
      initPromise
        .then((chart) => {
          if (
            resizeFrameId !== null &&
            typeof window !== "undefined" &&
            typeof window.cancelAnimationFrame === "function"
          ) {
            window.cancelAnimationFrame(resizeFrameId);
          }
          resizeObserver?.disconnect();
          if (handleResize) {
            window.removeEventListener("resize", handleResize);
          }
          chart?.dispose();
          chartRef.current = null;
        })
        .catch(() => undefined);
      initPromiseRef.current = null;
    };
  }, [group, renderableContainerReady, renderer, shouldInit, theme]);

  useEffect(() => {
    if (!shouldInit) return;
    const p = initPromiseRef.current;
    if (!p) return;

    let cancelled = false;
    (async () => {
      const chart = await p;
      if (!chart || cancelled) return;
      await ensureOptionModules(option);
      if (cancelled) return;
      const hasGraphSeries = inferSeriesTypes(option).has("graph");
      const applyOption = (hardReset = false) => {
        if (hardReset) {
          chart.clear();
        }
        chart.setOption(option, {
          lazyUpdate: !hardReset,
          notMerge: hardReset,
        });
      };
      try {
        applyOption();
      } catch {
        // Graph charts are sensitive to module/init timing under heavy render churn.
        // Retry once after yielding to the main loop before falling back to empty.
        if (hasGraphSeries) {
          try {
            await yieldToMain();
            if (cancelled) return;
            chart.clear();
            chart.setOption({}, { notMerge: true, lazyUpdate: false });
            applyOption(true);
            setReady(true);
            return;
          } catch {
            // noop: use empty option fallback below
          }
        }

        chart.clear();
        chart.setOption({}, { notMerge: true, lazyUpdate: false });
      }
      setReady(true);
    })().catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [option, renderer, group, theme, shouldInit]);

  useEffect(() => {
    if (!shouldInit) return;
    const p = initPromiseRef.current;
    if (!p || !onEvents?.length) return;

    let cancelled = false;
    let cleanup: (() => void) | undefined;

    p.then((chart) => {
      if (!chart || cancelled) return;

      const handlers = onEvents.map((evt) => {
        const wrapped = (params: unknown) => evt.handler(params, chart);
        chart.on(evt.type, wrapped);
        return { type: evt.type, wrapped };
      });

      cleanup = () =>
        handlers.forEach(({ type, wrapped }) => chart.off(type, wrapped));
    }).catch(() => undefined);

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [onEvents, renderer, group, theme, shouldInit]);

  const handleExport = async () => {
    if (exporting) return;
    const chart = chartRef.current ?? (await initPromiseRef.current);
    if (!chart) {
      toast.error(
        t("dashboard.charts.exportFailed"),
      );
      return;
    }
    setExporting(true);
    try {
      await yieldToMain();
      const background = resolveExportBackground(theme, exportBackgroundColor);
      const dataUrl =
        renderer === "svg"
          ? await renderSvgToPng(
              chart.getDataURL({ type: "svg" }),
              chart.getWidth(),
              chart.getHeight(),
              exportPixelRatio,
              background,
            )
          : chart.getDataURL({
              type: "png",
              pixelRatio: exportPixelRatio,
              backgroundColor: background,
            });
      downloadDataUrlFile(
        dataUrl,
        `${sanitizeFilename(exportFilename ?? "chart", "chart")}.png`,
      );
      toast.success(
        t("dashboard.charts.exportSuccess"),
      );
    } catch {
      toast.error(
        t("dashboard.charts.exportFailed"),
      );
    } finally {
      setExporting(false);
    }
  };

  const exportLabel = exporting
    ? t("dashboard.charts.exporting")
    : t("dashboard.charts.exportImage");

  const renderActions = showExportImage || actions;
  const actionClassName = supportsHover
    ? "absolute right-2 top-2 z-10 flex items-center gap-2 opacity-0 pointer-events-none transition-opacity group-hover:pointer-events-auto group-hover:opacity-100"
    : "absolute right-2 top-2 z-10 flex items-center gap-2";

  const showLoadingSkeleton = !ready;

  return (
    <div className="group relative w-full" style={{ height }}>
      <div
        ref={ref}
        className={`h-full w-full transition-opacity duration-200 ${showLoadingSkeleton ? "opacity-0" : "opacity-100"}`}
      />
      {showLoadingSkeleton ? (
        <div className="pointer-events-none absolute inset-0">
          <ChartSkeleton height={height} />
        </div>
      ) : null}
      {renderActions ? (
        <div className={actionClassName}>
          {actions}
          {showExportImage ? (
            <Button
              size="small"
              type="default"
              onClick={handleExport}
              loading={exporting}
              aria-label={exportLabel}
            >
              {exportLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
