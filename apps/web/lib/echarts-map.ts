import * as echarts from "echarts/core";

type EchartsMapModule = typeof echarts & {
  registerMap?: (mapName: string, geoJson: unknown) => void;
  getMap?: (mapName: string) => unknown;
};

interface EchartsMapRuntimeState {
  installPromise: Promise<EchartsMapModule> | null;
  mapApiReady: boolean;
}

const ECHARTS_MAP_RUNTIME_KEY = "__modular_echarts_map_runtime__";
const MAP_API_PROBE_NAME = "__modular_echarts_map_probe__";
const MAP_API_PROBE_GEO_JSON = {
  type: "FeatureCollection",
  features: [],
} as const;

const getMapRuntimeState = (): EchartsMapRuntimeState => {
  const target = globalThis as typeof globalThis & {
    [ECHARTS_MAP_RUNTIME_KEY]?: EchartsMapRuntimeState;
  };

  if (!target[ECHARTS_MAP_RUNTIME_KEY]) {
    target[ECHARTS_MAP_RUNTIME_KEY] = {
      installPromise: null,
      mapApiReady: false,
    };
  }

  return target[ECHARTS_MAP_RUNTIME_KEY];
};

const verifyMapApi = (echartsModule: EchartsMapModule) => {
  if (
    typeof echartsModule.registerMap !== "function" ||
    typeof echartsModule.getMap !== "function"
  ) {
    throw new Error("ECharts map module is unavailable");
  }

  if (!echartsModule.getMap(MAP_API_PROBE_NAME)) {
    echartsModule.registerMap(MAP_API_PROBE_NAME, MAP_API_PROBE_GEO_JSON);
  }

  if (!echartsModule.getMap(MAP_API_PROBE_NAME)) {
    throw new Error("ECharts map module failed to initialize");
  }
};

const ensureMapModule = async (): Promise<EchartsMapModule> => {
  const runtime = getMapRuntimeState();
  if (runtime.installPromise) {
    return runtime.installPromise;
  }

  runtime.installPromise = (async () => {
    const echartsModule = echarts as EchartsMapModule;

    if (!runtime.mapApiReady) {
      const installGeo = await import("echarts/lib/component/geo/install.js")
        .then((m) => m.install);
      const installMap = await import("echarts/lib/chart/map/install.js")
        .then((m) => m.install);

      echartsModule.use(installGeo);
      echartsModule.use(installMap);
      verifyMapApi(echartsModule);
      runtime.mapApiReady = true;
    }

    return echartsModule;
  })().catch((error) => {
    runtime.installPromise = null;
    runtime.mapApiReady = false;
    throw error;
  });

  return runtime.installPromise;
};

export async function ensureEchartsMapRegistered(
  mapName: string,
  geoJson: unknown,
) {
  const normalizedName = mapName.trim();
  if (!normalizedName) {
    return;
  }

  const echartsModule = await ensureMapModule();
  if (typeof echartsModule.registerMap !== "function") {
    throw new Error("ECharts map module is unavailable");
  }

  const existingMap =
    typeof echartsModule.getMap === "function"
      ? echartsModule.getMap(normalizedName)
      : null;

  if (!existingMap) {
    echartsModule.registerMap(normalizedName, geoJson);
  }
}
