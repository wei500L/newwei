"use client";

import * as echarts from "echarts/core";
import { useEffect, useRef } from "react";

type Installer = Parameters<typeof echarts.use>[0];

const installed = new Set<string>();
const installPromises = new Map<string, Promise<void>>();

const installOnce = (key: string, loader: () => Promise<Installer>) => {
  if (installed.has(key)) {
    return Promise.resolve();
  }
  const existing = installPromises.get(key);
  if (existing) {
    return existing;
  }
  const p = loader()
    .then((installer) => {
      if (installed.has(key)) return;
      echarts.use(installer);
      installed.add(key);
    })
    .finally(() => {
      installPromises.delete(key);
    });
  installPromises.set(key, p);
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

const optionNeedsGrid = (option: echarts.EChartsCoreOption, seriesTypes: Set<string>) => {
  const o = option as Record<string, unknown>;
  if (o.grid || o.xAxis || o.yAxis) return true;
  for (const t of seriesTypes) {
    if (t === "line" || t === "bar" || t === "candlestick" || t === "scatter" || t === "heatmap") {
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
      case "treemap":
        promises.push(
          installOnce("chart:treemap", async () => {
            const m = await import("echarts/lib/chart/treemap/install.js");
            return m.install;
          }),
        );
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
  renderer?: "canvas" | "svg";
  group?: string;
  theme?: string | object;
  onEvents?: {
    type: string;
    handler: (params: unknown, chart: echarts.ECharts) => void;
  }[];
}

export function DashboardChart({
  option,
  height = 360,
  renderer = "canvas",
  group,
  theme,
  onEvents,
}: EchartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const initPromiseRef = useRef<Promise<echarts.EChartsType | undefined> | null>(
    null,
  );

  useEffect(() => {
    const dom = ref.current;
    if (!dom) return;

    let cancelled = false;
    let handleResize: (() => void) | undefined;
    const initPromise = (async () => {
      await ensureRenderer(renderer);
      if (cancelled) return;

      const chart = echarts.init(dom, theme as any, { renderer });
      if (group) {
        chart.group = group;
        echarts.connect(group);
      }

      handleResize = () => chart.resize();
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
        })
        .catch(() => undefined);
      initPromiseRef.current = null;
    };
  }, [renderer, group, theme]);

  useEffect(() => {
    const p = initPromiseRef.current;
    if (!p) return;

    let cancelled = false;
    (async () => {
      const chart = await p;
      if (!chart || cancelled) return;
      await ensureOptionModules(option);
      if (cancelled) return;
      chart.setOption(option);
    })().catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [option, renderer, group, theme]);

  useEffect(() => {
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
  }, [onEvents, renderer, group, theme]);

  return <div ref={ref} style={{ width: "100%", height }} />;
}
