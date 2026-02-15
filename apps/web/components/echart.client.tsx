"use client";

import { Button } from "antd";
import * as echarts from "echarts/core";
import { install as installGraphChart } from "echarts/lib/chart/graph/install.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ChartSkeleton } from "@/components/chart-skeleton";
import {
  downloadDataUrlFile,
  sanitizeFilename,
  yieldToMain,
} from "@/lib/data-export";

type Installer = Parameters<typeof echarts.use>[0];

// Pre-register graph chart extension before any chart instance is created.
// Graph depends on coordinate-system/layout hooks that must exist at init time.
echarts.use(installGraphChart as unknown as Installer);

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

const optionNeedsGeo = (
  option: echarts.EChartsCoreOption,
  seriesTypes: Set<string>,
) => {
  const o = option as Record<string, unknown>;
  if (o.geo) return true;
  if (seriesTypes.has("map")) return true;
  const series = normalizeToArray(o.series);
  return series.some((s) => {
    if (!s || typeof s !== "object") return false;
    const coord = (s as { coordinateSystem?: unknown }).coordinateSystem;
    if (coord === "geo") return true;
    const map = (s as { map?: unknown }).map;
    return typeof map === "string";
  });
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
  if (optionNeedsGeo(option, seriesTypes)) {
    promises.push(
      installOnce("component:geo", async () => {
        const m = await import("echarts/lib/component/geo/install.js");
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
      case "map":
        promises.push(
          installOnce("chart:map", async () => {
            const m = await import("echarts/lib/chart/map/install.js");
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
  const [isInView, setIsInView] = useState(!lazy);
  const [shouldInit, setShouldInit] = useState(!lazy);
  const [ready, setReady] = useState(false);

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
    if (!dom || !shouldInit) return;

    let cancelled = false;
    let handleResize: (() => void) | undefined;
    const initPromise = (async () => {
      await ensureRenderer(renderer);
      if (cancelled) return;
      await ensureOptionModules(option);
      if (cancelled) return;

      const runtime = getRuntimeState();
      if (!runtime.themesRegistered) {
        // Register Smart Light Theme
        echarts.registerTheme("smart-light", {
          color: [
            "#0050b3", // Primary (Deep Blue)
            "#faad14", // Secondary (Tech Gold)
            "#13c2c2", // Accent (Cyan)
            "#eb2f96", // Magenta
            "#722ed1", // Purple
            "#52c41a", // Green
            "#fadb14", // Yellow
            "#fa8c16", // Orange
          ],
          backgroundColor: "transparent",
          tooltip: {
            backgroundColor: "rgba(255, 255, 255, 0.95)",
            borderColor: "#e5e7eb",
            textStyle: {
              color: "#1f2937",
            },
            padding: [10, 14],
            extraCssText:
              "box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08); border-radius: 8px;",
          },
          title: {
            textStyle: {
              color: "#111827",
              fontWeight: 600,
            },
          },
          legend: {
            textStyle: {
              color: "#4b5563",
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
                color: "#e5e7eb",
              },
            },
            axisTick: {
              show: false,
            },
            axisLabel: {
              color: "#6b7280",
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
              color: "#6b7280",
              margin: 12,
            },
            splitLine: {
              show: false,
            },
          },
        });

        // Register Smart Dark Theme
        echarts.registerTheme("smart-dark", {
          color: [
            "#2563eb", // Vibrant Blue (was #177ddc)
            "#d48806", // Gold
            "#13a8a8", // Cyan
            "#cb2b83", // Magenta
            "#642ab5", // Purple
            "#49aa19", // Green
            "#d8bd14", // Yellow
            "#d87a16", // Orange
          ],
          backgroundColor: "transparent",
          tooltip: {
            backgroundColor: "rgba(15, 23, 42, 0.95)",
            borderColor: "rgba(255, 255, 255, 0.1)",
            textStyle: {
              color: "#e2e8f0",
            },
            padding: [10, 14],
            extraCssText:
              "box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3); border-radius: 8px;",
          },
          title: {
            textStyle: {
              color: "#f3f4f6",
              fontWeight: 700,
            },
          },
          legend: {
            textStyle: {
              color: "#9ca3af",
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
                color: "rgba(255, 255, 255, 0.1)",
              },
            },
            axisTick: {
              show: false,
            },
            axisLabel: {
              color: "#cbd5e1",
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
              color: "#9ca3af",
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
          chartRef.current?.resize();
        } catch {
          // noop: avoid bubbling resize-time chart exceptions from other panels
        }
      };
      window.addEventListener("resize", handleResize);

      return chart;
    })();

    initPromiseRef.current = initPromise;

    return () => {
      cancelled = true;
      initPromise
        .then((chart) => {
          if (handleResize) {
            window.removeEventListener("resize", handleResize);
          }
          chart?.dispose();
          chartRef.current = null;
        })
        .catch(() => undefined);
      initPromiseRef.current = null;
    };
  }, [renderer, group, theme, shouldInit]);

  useEffect(() => {
    if (!shouldInit || !isInView) return;
    const p = initPromiseRef.current;
    if (!p) return;

    let cancelled = false;
    (async () => {
      const chart = await p;
      if (!chart || cancelled) return;
      await ensureOptionModules(option);
      if (cancelled) return;
      const hasGraphSeries = inferSeriesTypes(option).has("graph");
      const applyOption = () => {
        chart.clear();
        chart.setOption(option, { notMerge: true, lazyUpdate: false });
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
            applyOption();
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
  }, [option, renderer, group, theme, isInView, shouldInit]);

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
        t("dashboard.charts.exportFailed", { defaultValue: "Export failed" }),
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
        t("dashboard.charts.exportSuccess", {
          defaultValue: "Export completed",
        }),
      );
    } catch {
      toast.error(
        t("dashboard.charts.exportFailed", { defaultValue: "Export failed" }),
      );
    } finally {
      setExporting(false);
    }
  };

  const exportLabel = exporting
    ? t("dashboard.charts.exporting", { defaultValue: "Exporting..." })
    : t("dashboard.charts.exportImage", { defaultValue: "Export Image" });

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
