// eslint-disable-next-line import/order -- 必须在任何 Cesium / GEV 模块求值前执行
import "./cesium-base";
// ^ 第一条 import：在 Cesium / GEV 模块求值前设置 window.CESIUM_BASE_URL。

import { localGeoJsonServices } from "@gev/app/localGeojsonServices.js";
import { createApplicationScene } from "@gev/app/scene.js";
import {
  interruptCameraMotion,
  interruptGlobeRotation,
} from "@gev/cameraVerbs.js";
import { CITY_POIS } from "@gev/cityPois.js";
import { aircraftTrackingTarget } from "@gev/cockpitTracking.js";
import {
  getContextStore as getGevContextStore,
  selectEntityContext,
} from "@gev/data/contextStore.js";
import {
  cycleMode as cycleDetectionMode,
  initDetection,
  destroyDetection,
  setDetectionStyle,
  getMode as getDetectionMode,
  getDetectionTuning,
  setMode as setDetectionModeByLabel,
  setDetectionTuning,
  getDetectionDiagnostics,
  suspendDetection,
  resumeDetection,
} from "@gev/data/detection.js";
import { LayerLifecycle } from "@gev/data/lifecycle.js";
import { createLocalGeoJsonLayer } from "@gev/data/localGeojsonCore.js";
import {
  fetchRegionalBrief,
  regionalDistanceM,
  weatherCodeLabel,
} from "@gev/data/regionalBrief.js";
import { isTr3b, toggleTr3b } from "@gev/data/tr3bRegistry.js";
import {
  initTrackedReadout,
  destroyTrackedReadout,
} from "@gev/data/trackedReadout.js";
import { IntelHUD } from "@gev/hud.js";
import { setLocale as setGevLocale } from "@gev/i18n/index.js";
import { flyToGlobeView, flyToLandmark } from "@gev/locations.js";
import { MAP_STACKS } from "@gev/maps/catalog.js";
import { OrbitController } from "@gev/orbit.js";
import {
  initWorldOverlay,
  destroyWorldOverlay,
} from "@gev/overlays/worldOverlay.js";
import {
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from "@gev/renderGovernor.js";
import { createApplicationRequestServices } from "@gev/services/requests.js";
import { createStandaloneCatalog } from "@gev/standalone/catalog.js";
import { createStandalonePlaceSearch } from "@gev/standalone/placeSearch.js";
import { CockpitCoordinator } from "@gev/ui/cockpitCoordinator.js";
import { ContextControls } from "@gev/ui/context.js";
import { LayerBindings } from "@gev/ui/layerBindings.js";
import { LocationNavigation } from "@gev/ui/locationNavigation.js";
import { NavigationController } from "@gev/ui/navigationController.js";
import { useCockpitStore as getCockpitStore } from "@gev/ui/stores/cockpit.js";
import { useContextStore as getContextStore } from "@gev/ui/stores/context.js";
import { useHudStore as getHudStore } from "@gev/ui/stores/hud.js";
import { useLocationStore as getLocationStore } from "@gev/ui/stores/location.js";
import { VisualSettings } from "@gev/ui/visualSettings.js";
import { applicationPinia } from "@gev/ui/vueRuntime.js";
import * as Cesium from "cesium";
import { setActivePinia } from "pinia";

import { placeKindFromTypes } from "./command-model";
import { detectionModeStore } from "./detection-mode-store";
import type {
  CockpitCoordinatorLike,
  CockpitViewLike,
  ContextControlsLike,
  GlobeOwners,
  GlobeTargetRecord,
  IntelHUDLike,
  LayerBindingsLike,
  LayerLifecycleLike,
  LocationNavigationLike,
  MapStackControllerLike,
  NavigationControllerLike,
  VisualSettingsLike,
} from "./engine-types";
import { acquireGlobeSlot, createRuntimeLifecycle } from "./runtime-lifecycle";

export interface GlobeRuntimeOptions {
  /** process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY */
  googleApiKey?: string;
  locale: "zh-CN" | "en";
  /** 加载状态文字（GEV 每条 loaderStatus 更新时回调）。 */
  onStatus?: (text: string) => void;
  /** G6 情报图层在面板里的显示名（由 React 侧用 `t()` 传入）。 */
  intelLayerNames?: { events: string; news: string };
}

/** G6 `actions.setIntelData` 的输入；每类可选，只更新传入的图层。 */
export interface IntelDataPayload {
  eventsGeojsonl?: string;
  newsGeojsonl?: string;
}

/** 地点搜索结果（`searchPlaces` 的返回项，命令坞建议列表用）。 */
export interface GlobePlaceResult {
  id: string;
  label: string;
  sublabel?: string;
  lat: number;
  lon: number;
  /** 结果类型 kicker：coordinate / city / region / landmark / place。 */
  kind: string;
  /** G6：覆盖取景距离（米），`/globe` 深链用 300 km 观察情报点。 */
  rangeM?: number;
}

/** 可用的底图栈（已按 `requiresIon` / Google 密钥过滤）。 */
export interface GlobeMapStackInfo {
  id: string;
  label: string;
  shortLabel: string;
}

/** 图层面板上 React 侧可调用的动作。每个方法上都注明对应的 GEV 源码位置。 */
export interface GlobeRuntimeActions {
  /** `data/lifecycle.js:602`（`toggle`）。 */
  toggleLayer(id: string): Promise<boolean>;
  /** 跟踪：`layers/flights/queries.js:757` `trackById`、`layers/military/queries.js:677`、
   *  `layers/satellites/controls.js:252`、`layers/vessels/queries.js:428` `selectById`、
   *  `layers/installations/controls.js:172` `focusById`、`layers/localAdsb/index.js:819` `selectAircraft`。 */
  track(record: GlobeTargetRecord): boolean;
  /** 停止跟踪：`ui/navigationController.js:129` `_releaseFollowCamera`（内部会调用各图层的 `stopTracking`）。 */
  untrack(): void;
  /** 飞到目标：`locations.js:38-94` 的相机飞行写法 + `worldFocus.js:104` `flyToWorldTarget`。 */
  flyTo(record: GlobeTargetRecord): boolean;
  /** 切换 CONTACTS / SPACE MISSIONS：`ui/contextActions.js:57` `setContextMode`。 */
  contextMode(
    mode: "contacts" | "space-missions" | "off",
  ): Promise<unknown>;
  /** 全部关闭：`ui/contextActions.js:184` `clearSelectedLayers`（外壳在 `applicationShell.js:1571-1583` 接线）。 */
  clearLayers(): Promise<unknown>;

  // ── G4 命令坞 ────────────────────────────────────────────────
  /** 地点搜索：`standalone/placeSearch.js` `createStandalonePlaceSearch`
   *  （= `search/defaults.js` `createDefaultPlaceSearch`）的多来源回退。 */
  searchPlaces(query: string, signal?: AbortSignal): Promise<GlobePlaceResult[]>;
  /** 选中搜索结果后飞过去：`locations.js:94` `flyToLandmark`（G2 的
   *  `LocationNavigation` 是无 DOM 的构造，没有可复用的「飞到任意结果」方法，
   *  故按提示词允许的退回到 `flyToLandmark`；先释放跟踪，等价 G3 的 `untrack`）。 */
  flyToPlace(result: GlobePlaceResult): boolean;
  /** 切换底图栈：`maps/controller.js:190` `setStack`。 */
  setMapStack(id: string): Promise<unknown>;
  /** 当前底图栈 id：`maps/controller.js:112` `getActiveId`。 */
  getMapStack(): string;
  /** 可取用的底图栈：过滤 `requiresIon`，无 Google 密钥时再去掉 `photoreal`。 */
  availableMapStacks(): GlobeMapStackInfo[];
  /** 视觉滤镜：`ui/visualSettings.js:1473` `setStyle`（外壳以 `{ userInitiated: true }` 调用）。 */
  setStyle(name: string): void;
  /** 当前风格：`ui/visualSettings.js` 的 `activeStyle`。 */
  getStyle(): string;
  /** HUD 显隐：`hud.js:1014` `toggle`（外壳见 `ui/displayBindings.js:59-64`）。 */
  toggleHud(): void;
  /** 切换检测框：`data/detection.js:410` `cycleMode`（Off ↔ 上一次非 Off 模式）。 */
  cycleDetection(): void;
  /** 当前检测框模式标签：`data/detection.js:446` `getMode`。 */
  getDetectionMode(): string;
  /** 回到整个地球：先释放跟踪（同 G3 `untrack`），再 `locations.js:38` `flyToGlobeView`。 */
  resetGlobe(): void;
  /** 自动旋转：`orbit.js` `OrbitController.toggle`（外壳在 `_initOrbit` 里创建）。 */
  toggleOrbit(): boolean;
  /** 创建 / 重建驾驶舱协调器（React 骨架挂载后调用）。返回销毁函数。 */
  attachCockpit(): () => void;

  // ── G6 情报图层 ────────────────────────────────────────────
  /** 把事件 / 新闻 GeoJSONL 写入对应本地图层。每类可选，只刷新传入的图层。 */
  setIntelData(data: IntelDataPayload): Promise<void>;
  /** 按 `${layerId}:${newweiId}` 选中一个情报要素（GET 参数 focus 用）。 */
  selectIntelFeature(layerId: string, newweiId: string): boolean;
}

export interface GlobeRuntime {
  /** Cesium.Viewer（窄类型见 engine-types；这里用 unknown 隔离 Cesium）。 */
  viewer: unknown;
  dataManager: LayerLifecycleLike;
  mapStackController: MapStackControllerLike;
  owners: GlobeOwners;
  pinia: unknown;
  actions: GlobeRuntimeActions;
  setLocale(locale: "zh-CN" | "en"): void;
  destroy(): Promise<void>;
}

/** 外壳传给负责人的 DOM 控件占位：不挂载到页面，只满足 `connect()` 调用。 */
function createPlaceholderControl() {
  return {
    connect() {
      return undefined;
    },
    disconnect() {
      return undefined;
    },
    destroy() {
      return undefined;
    },
    attachDataManager() {
      return undefined;
    },
  };
}

const noop = () => undefined;

/** 负责人外壳里那些「更新自己 DOM / 布局」的回调，G2 一律用空函数。 */
const detachOperations = {
  _restorePanelState: noop,
  _layoutRightPanels: noop,
  _scheduleAdaptivePanelLayout: noop,
  _scheduleRightPanelLayout: noop,
  _setCockpitDisclosure: noop,
  _cockpitDisclosureOpen: () => false,
  _setMapStack: noop,
  _presentPanel: noop,
  _syncShareState: noop,
  setPanelCollapsed: noop,
  _updateTrafficSyncChip: noop,
  _updateGlobalLoadingFeedback: noop,
  _syncContextModeButtons: noop,
  _stampNavigation: () => 0,
  _runExplicitCctvFocus: noop,
  _runExplicitWorldFocus: noop,
  runImmediateNavigation: noop,
  _showToast: noop,
} as const;

/** GEV 图层实例（按 `app/catalog.js:1-16` 的角色 → id 映射）。 */
const LAYER_IDS = {
  trafficLayer: "traffic",
  flightsLayer: "flights",
  militaryFlightsLayer: "military",
  satellitesLayer: "satellites",
  cctvLayer: "cctv",
  streetLevelLayer: "street-level",
  radioLayer: "radio",
  bikeshareLayer: "bikeshare",
  transitLayer: "transit",
  aisLiveVesselsLayer: "ais-live-vessels",
  militaryAwarenessLayer: "military-awareness",
  militaryInstallationsLayer: "military-installations",
  rocketLaunchesLayer: "rocket-launches",
  localAdsbLayer: "local-adsb",
} as const;

/** `initDetection` 的图层顺序（applicationShell.js:503-516），不存在的过滤掉。 */
const DETECTION_LAYER_IDS = [
  "traffic",
  "flights",
  "military",
  "local-adsb",
  "satellites",
  "cctv",
  "bikeshare",
  "transit",
  "ais-live-vessels",
] as const;

/**
 * 组装 GEV 引擎运行时。
 *
 * **只在客户端运行**。调用方（`globe-stage.tsx`）通过
 * `next/dynamic({ ssr: false })` 加载，容器必须 `id="cesiumContainer"`。
 */
export async function createGlobeRuntime(
  container: HTMLElement,
  options: GlobeRuntimeOptions,
): Promise<GlobeRuntime> {
  const lifecycle = createRuntimeLifecycle();

  try {
    // 1) 页面级单例守卫：新的启动等上一个 destroy 完成。
    const releaseSlot = await acquireGlobeSlot();
    lifecycle.defer(releaseSlot);

    // 4) 容器：GEV 的 createApplicationScene 写死了 'cesiumContainer'。
    if (container.id !== "cesiumContainer") {
      throw new Error(
        `createGlobeRuntime requires a container with id="cesiumContainer" (got "${container.id}")`,
      );
    }

    // 2) 语言：GEV 自己的 i18n（setLocale 会通知所有 onLocaleChange 监听）。
    setGevLocale(options.locale);

    // 3) Pinia：整个页面共用一个实例；不 mount Vue UI 运行时。
    const pinia = applicationPinia();
    setActivePinia(pinia);

    // 5) 场景。credits 在 standalone 里未传（standalone/application.js 的
    //    createStandaloneScene 调用没有 credits 字段），这里同样传 undefined。
    // GEV 用 `loaderStatus.textContent = ...` 更新加载文字；一个带 setter 的
    // 普通对象即可，setter 里回调 options.onStatus。
    const statusSink = {
      _text: "",
      get textContent(): string {
        return this._text;
      },
      set textContent(value: string) {
        this._text = String(value ?? "");
        options.onStatus?.(this._text);
      },
    };

    const scene = await createApplicationScene({
      requestServices: createApplicationRequestServices(),
      googleApiKey: options.googleApiKey || undefined,
      googleTokens: null,
      cesiumToken: undefined,
      credits: undefined,
      loaderStatus: statusSink,
      signal: lifecycle.signal,
      defer: lifecycle.defer,
    });

    const viewer = scene.viewer;
    const mapStackController =
      scene.mapStackController as MapStackControllerLike;

    // G4 地点搜索：`standalone/placeSearch.js` → `search/defaults.js`。约定
    // 「在 G2 运行时里创建一次」；内置 CITY_POIS 让城市/地标不发网络请求，
    // 坐标由 coordinateGeocoder 直接回答，其余按 Google → Photon → Nominatim 回退。
    const placeSearch = createStandalonePlaceSearch({
      presets: CITY_POIS,
      resolveApiKey: () => options.googleApiKey,
      signal: lifecycle.signal,
    });

    // 6) 图层目录。不传 nepalBoundaryResolver：放弃 Bhote Koshi 洪水场景的
    //    边界绘制（该图层仍会注册，只是没有边界 resolver）。
    const catalog = createStandaloneCatalog({
      signal: lifecycle.signal,
      surface: scene.operations.surface,
    });

    // 7) 数据生命周期：照 app/data.js:15-41 的顺序自己写（不引用 app/data.js）。
    const dataManager: LayerLifecycleLike = new LayerLifecycle(viewer, {
      visibilityTarget: document,
      getSourceAvailability: catalog.getSourceAvailability,
    });
    lifecycle.defer(() => dataManager.destroyAll());

    for (const layer of catalog.layers) {
      dataManager.register(layer);
    }

    // G6：我们的情报图层。事件和新闻各自一种颜色，所以是两张本地 GeoJSON 图层。
    // 必须在 finalizeRegistrations 之前注册；初始 URL 是空 Blob（零要素），
    // 由 `actions.setIntelData` 在数据到达后换成本地 Blob URL。
    interface IntelLayerLike {
      reload(viewer: unknown, nextUrl?: string): Promise<void>;
    }
    const intelNames = options.intelLayerNames ?? {
      events: "Intel Events",
      news: "Intel News",
    };
    const createEmptyGeojsonUrl = () =>
      URL.createObjectURL(new Blob([""], { type: "application/geo+json" }));
    const intelUrls = {
      events: createEmptyGeojsonUrl(),
      news: createEmptyGeojsonUrl(),
    };
    const intelLayers = {
      events: createLocalGeoJsonLayer(
        {
          id: "newwei-events",
          url: intelUrls.events,
          name: intelNames.events,
          color: "#f59e0b",
          icon: "◆",
          source: "Newwei",
        },
        localGeoJsonServices,
      ) as IntelLayerLike,
      news: createLocalGeoJsonLayer(
        {
          id: "newwei-news",
          url: intelUrls.news,
          name: intelNames.news,
          color: "#38bdf8",
          icon: "●",
          source: "Newwei",
        },
        localGeoJsonServices,
      ) as IntelLayerLike,
    };
    lifecycle.defer(() => {
      URL.revokeObjectURL(intelUrls.events);
      URL.revokeObjectURL(intelUrls.news);
    });
    dataManager.register(intelLayers.events);
    dataManager.register(intelLayers.news);

    for (const layer of catalog.layers) {
      (layer as { attachDataManager?: (manager: unknown) => void })
        .attachDataManager?.(dataManager);
    }
    for (const layer of catalog.layers) {
      (
        layer as { attachMapStackController?: (controller: unknown) => void }
      ).attachMapStackController?.(mapStackController);
    }
    dataManager.finalizeRegistrations([
      ...catalog.metadata,
      { id: "newwei-events", disposition: "local-only" },
      { id: "newwei-news", disposition: "local-only" },
    ]);
    // 跳过：LayerPresentation.mount('#data-toggles') 与 createCyberSonarScene。

    // 图层实例（按源码 id 取；缺失的过滤掉）。
    const layers: Record<string, unknown> = {};
    for (const [role, id] of Object.entries(LAYER_IDS)) {
      layers[role] = catalog.get(id);
    }

    // 8) 引擎服务（applicationShell.js:488-525 的顺序）。
    let visualSettingsRef: VisualSettingsLike | null = null;

    initWorldOverlay(viewer);
    lifecycle.defer(() => destroyWorldOverlay());

    const detectionLayers = DETECTION_LAYER_IDS.map((id) =>
      catalog.get(id),
    ).filter(Boolean);
    initDetection(viewer, detectionLayers, (modeLabel: string) => {
      visualSettingsRef?._updateDetectionButton?.(modeLabel);
      // G4：第三个参数是「模式标签回调」，G2 里只喂 VisualSettings；这里同时
      // 写进外部仓库，React 命令坞订阅它显示当前检测框模式。
      detectionModeStore.set(String(modeLabel));
    });
    lifecycle.defer(() => destroyDetection());

    initTrackedReadout(viewer);
    lifecycle.defer(() => destroyTrackedReadout());

    setDetectionStyle("normal");
    // 初始模式（`getMode()` 此时为 OFF）；之后每次变化由上面的回调更新。
    detectionModeStore.set(getDetectionMode());

    // 8b) Intel HUD —— 照 `applicationShell.js:350-356` 创建。HUD 只负责计算
    //     相机读数并发布到 `hud` 仓库，React 一侧（`intel-hud.tsx`）负责绘制。
    //     `summaryService` 默认会调用 OpenAI 生成摘要；我们没有 OpenAI，传入
    //     一个「未配置」的假服务：`configured()` 恒为 false，HUD 因此不会发起
    //     摘要请求，只显示确定性摘要行（`hud.js:_summaryAvailable`）。
    const hudStore = getHudStore(pinia);
    const hudSummaryService = {
      configured: async () => false,
      summarize: async () => ({ ok: false, status: 0, data: null }),
    };
    const hud = new IntelHUD(viewer, {
      placeSearch,
      summaryService: hudSummaryService,
      publish: (view: unknown) => hudStore.publish(view),
    }) as IntelHUDLike;
    lifecycle.defer(() => hud.destroy());

    // 9) 负责人模块。
    const controlServices = (scene.operations.surface as {
      controlServices: {
        cachedGroundFloor: unknown;
        cachedMeshFloor: unknown;
        GROUND_FLOOR_LIFT_M: unknown;
        meshFloorPreferred: unknown;
        warmGroundFloor: unknown;
        sampleMeshFloorCells: unknown;
      };
    }).controlServices;

    // 9a) VisualSettings —— 构造参数见 applicationShell.js:193-246。
    //     外壳的 `_initStages` / `_initBloomSharpen`（applicationShell.js:524-525）
    //     实际委托给 `_visualEffects.initStyles()` / `initPostProcess()`
    //     （ui/visualSettings.js:292-294、466-469）。
    const visualServices = {
      governorRequestRender,
      holdContinuousRender,
      releaseContinuousRender,
      // 检测 / 滤镜 / scope / celestial 服务：真实取自 detection.js，
      // scope / celestial 相关在 G2 用安全占位（G3/G4 用到时再接真实现）。
      setDetectionStyle,
      getDetectionMode,
      getDetectionTuning,
      setDetectionModeByLabel,
      setDetectionTuning,
      readDetectionDiagnostics: getDetectionDiagnostics,
      suspendDetection,
      resumeDetection,
      setScopeMaskEnabled: noop,
      isScopeMaskEnabled: () => false,
      setScopeMaskFeather: noop,
      getScopeMaskFeather: () => 0,
      setScopeTerminusOverride: noop,
      getScopeTerminusOverride: () => null,
      clampScopeTerminusPct: (value: number) => value,
      isCelestialRingStyleSupported: () => false,
      getKeyholeFadeTuning: () => ({ fadeRatio: 0.07, outsideOpacity: 0.01 }),
      setKeyholeFadeTuning: noop,
    };

    const visualSettings = new VisualSettings({
      viewer,
      mapStackController,
      services: visualServices,
      elements: { _ppToggles: null, _sliderPanel: null },
      operations: detachOperations,
      readHud: () => hud,
      readCockpit: () => null,
      readDataManager: () => dataManager,
      readShareLinks: () => null,
      readCelestialRing: () => null,
      readContextMode: () => null,
      readContextChanging: () => false,
      readDisplayPortalActive: () => false,
    }) as VisualSettingsLike;
    visualSettingsRef = visualSettings;
    visualSettings._setDetectionDensity?.();
    visualSettings._initStages();
    visualSettings._initBloomSharpen();
    lifecycle.defer(() => visualSettings.destroy());

    // 9b) NavigationController —— 构造参数见 applicationShell.js:166-190。
    const navigation = new NavigationController({
      viewer,
      tracking: {
        flightsLayer: layers.flightsLayer,
        militaryFlightsLayer: layers.militaryFlightsLayer,
        satellitesLayer: layers.satellitesLayer,
        aisLiveVesselsLayer: layers.aisLiveVesselsLayer,
        militaryAwarenessLayer: layers.militaryAwarenessLayer,
        rocketLaunchesLayer: layers.rocketLaunchesLayer,
      },
      settleSearch: noop,
      interruptCameraMotion,
      interruptGlobeRotation,
      isCockpitActive: () => false,
      clearLocation: noop,
      cancelShareSelection: () => false,
      getDataManager: () => dataManager,
      stopOrbit: noop,
      showToast: noop,
      cancelOrientation: noop,
    }) as NavigationControllerLike;
    lifecycle.defer(() => navigation.destroy());

    // 9c) ContextControls —— 构造参数见 applicationShell.js:936-966。
    //     这里只做 ContextControls 自身与 contextStore.publish；外壳额外的
    //     awareness / missions 面板连接也一并照搬（见下方）。
    let contextControls: ContextControlsLike | null = null;
    const contextStore = getContextStore(pinia);
    contextControls = new ContextControls({
      elements: {
        _globalContextFlightsBtn: null,
        _globalContextMissionsBtn: null,
        _installationsSearchBtn: null,
      },
      installations: layers.militaryInstallationsLayer ?? null,
      publish: (view: unknown) => contextStore.publish(view),
      actions: {
        getCockpit: () => null,
        refreshRadio: noop,
        claimVisualAuthority: noop,
        syncDetection: noop,
        scheduleLayout: noop,
        setPanelCollapsed: noop,
        showToast: noop,
        setClearBusy: noop,
      },
    }) as ContextControlsLike;
    lifecycle.defer(async () => {
      contextControls?.stop();
      await contextControls?.restoreForDisposal();
      contextControls?.disconnect();
    });

    // 外壳在 _initGlobalContextPanel 里把 Contacts / Space Missions 面板接到
    // 各自的 store（applicationShell.js:968-1005）。没有 DOM，只保留发布通道。
    const militaryAwarenessLayer = layers.militaryAwarenessLayer as
      | { subscribePanel?: (cb: (view: unknown) => void) => () => void }
      | undefined;
    const rocketLaunchesLayer = layers.rocketLaunchesLayer as
      | { subscribePanel?: (cb: (view: unknown) => void) => () => void }
      | undefined;
    contextStore.connectAwareness(militaryAwarenessLayer ?? null);
    contextStore.publishAwareness(null);
    const awarenessPanelUnsub = militaryAwarenessLayer?.subscribePanel?.((view) =>
      contextStore.publishAwareness(view),
    );
    contextStore.connectMissions(rocketLaunchesLayer ?? null);
    contextStore.publishMissions(null);
    const missionsPanelUnsub = rocketLaunchesLayer?.subscribePanel?.((view) =>
      contextStore.publishMissions(view),
    );
    lifecycle.defer(() => {
      awarenessPanelUnsub?.();
      contextStore.connectAwareness(null);
      contextStore.publishAwareness(null);
      missionsPanelUnsub?.();
      contextStore.connectMissions(null);
      contextStore.publishMissions(null);
    });

    // 9d) LayerBindings —— 构造参数见 applicationShell.js:253-295。
    //     外壳的 hud / cctv / radio / streetLevel 控件在 G2 不创建（G3-G5 的
    //     React 组件取代），这里用不挂载的占位对象满足 attachDataManager。
    const placeholderControl = createPlaceholderControl();
    const layerBindings = new LayerBindings({
      viewer,
      services: {
        imageryHost: () => null,
        cachedGroundFloor: controlServices.cachedGroundFloor,
        warmGroundFloor: controlServices.warmGroundFloor,
        cctvLayer: layers.cctvLayer,
      },
      readControls: () => ({
        hud,
        _contextControls: contextControls,
        _cctvControls: placeholderControl,
        _radioControls: placeholderControl,
        _streetLevelControls: placeholderControl,
      }),
      operations: detachOperations,
      feedback: { _loadingFeedbackEvent: null },
      shareRestoration: {
        connect: noop,
        cancelSelection: () => false,
      },
    }) as LayerBindingsLike;
    layerBindings.attachDataManager(dataManager);
    lifecycle.defer(() => {
      layerBindings.stop();
      layerBindings.disconnect();
    });

    // 9e) LocationNavigation —— 构造参数见 applicationShell.js:298-348。
    //     构造只需要 services.OrbitController；DOM/搜索操作在 G4 接。
    const locationStore = getLocationStore(pinia);
    const locationNavigation = new LocationNavigation({
      viewer,
      placeSearch: undefined,
      navigation,
      services: { OrbitController },
      elements: { _locationSearch: null },
      readCockpit: () => null,
      operations: {
        _publishLocation: (view: unknown) => locationStore.publish(view),
        _connectLocation: (controls: unknown) => locationStore.connect(controls),
        _connectGlobeReset: noop,
        _publishGlobeResetting: noop,
        _beginDeferredNavigation: () => 0,
        _reassertNavigationHandoff: noop,
        _settleLocationSearchUi: noop,
        _runExplicitNavigation: noop,
        _stampNavigation: () => 0,
        _updateTrafficSyncChip: noop,
        _showToast: noop,
      },
    }) as LocationNavigationLike;
    lifecycle.defer(() => locationNavigation.destroy());

    // G4 自动旋转：`OrbitController` 在外壳里是 `composition.js` 注入的 service
    // （在黑名单里），这里照外壳 `_initOrbit` 的写法直接 import `@gev/orbit.js`
    // 并创建（已核实不会碰到 `.vue`）。
    const orbitController = new OrbitController(viewer) as {
      active: boolean;
      toggle(
        target: unknown,
        options?: { radius?: number; pitch?: number },
      ): boolean;
      stop(): void;
    };
    lifecycle.defer(() => orbitController.stop());
    // 最近一次 `flyToPlace` 的目标，供 `O` 键绕其旋转。
    let orbitTarget: unknown = null;
    let orbitOptions: { radius?: number; pitch?: number } = {};

    // 9f) CockpitCoordinator —— 照 `applicationShell.js:358-423` 组装。它由
    //     `actions.attachCockpit()` 延迟创建：`CockpitViewController` 的构造函数
    //     会按 id 抓取 DOM 元素（`ui/cockpitController.js:99-141`），必须等 React
    //     骨架（`cockpit-dom-contract.tsx`）渲染完成之后才创建。
    const cockpitStore = getCockpitStore(pinia);
    const cockpitPublish = {
      presence: (view: unknown) => cockpitStore.publishPresence(view),
      brief: (view: unknown) => cockpitStore.publishBrief(view),
      context: (view: unknown) => cockpitStore.publishContext(view),
      instruments: (view: unknown) => cockpitStore.publishInstruments(view),
      route: (view: unknown) => cockpitStore.publishRoute(view),
      vision: (view: unknown) => cockpitStore.publishVision(view),
      signals: (rows: unknown) => cockpitStore.publishSignals(rows),
      utilityLayout: (layout: unknown) =>
        cockpitStore.publishUtilityLayout(layout),
    };
    let cockpitCoordinator: CockpitCoordinatorLike | null = null;
    lifecycle.defer(() => {
      cockpitCoordinator?.destroy();
      cockpitCoordinator = null;
    });

    // 10) 初始相机：整个地球（GEV 默认飞 Austin，这里不照搬）。
    flyToGlobeView(viewer);

    // G3 React 侧动作。GEV 里这些行为由外壳的按钮/负责人触发，这里直接调用
    // 同样的引擎方法（见上面 GlobeRuntimeActions 的源码位置注释）。
    const trackableLayer = (layerId: string) =>
      layers[
        {
          flights: "flightsLayer",
          military: "militaryFlightsLayer",
          satellites: "satellitesLayer",
          "ais-live-vessels": "aisLiveVesselsLayer",
          "military-installations": "militaryInstallationsLayer",
          "local-adsb": "localAdsbLayer",
        }[layerId] ?? ""
      ] as
        | {
            trackById?: (id: unknown, options?: { origin?: string }) => boolean;
            selectById?: (id: unknown) => boolean;
            selectAircraft?: (id: string) => boolean;
            focusById?: (id: unknown) => boolean;
            clearSelection?: () => void;
            stopTracking?: (options?: { origin?: string }) => void;
          }
        | undefined;

    const actions: GlobeRuntimeActions = {
      toggleLayer(id) {
        return dataManager.toggle(id, { origin: "user" });
      },
      track(record) {
        const layerId = String(record?.layerId ?? "");
        const properties = record?.properties ?? {};
        let targetId = record?.targetId ?? record?.id;
        // AIS 的上下文记录 id 是 `ais-<mmsi>`，图层 API 要 mmsi 本体。
        if (layerId === "ais-live-vessels" && properties.mmsi !== undefined) {
          targetId = properties.mmsi as string | number;
        }
        // local-adsb 的实体 id 带前缀，图层 API 要裸 ICAO。
        if (layerId === "local-adsb" && properties.icao !== undefined) {
          targetId = properties.icao as string | number;
        }
        if (!layerId || targetId === undefined || targetId === null) return false;
        const layer = trackableLayer(layerId);
        if (!layer) return false;
        switch (layerId) {
          case "flights":
          case "military":
          case "satellites":
            return Boolean(layer.trackById?.(targetId, { origin: "user" }));
          case "ais-live-vessels":
            return Boolean(layer.selectById?.(targetId));
          case "military-installations":
            return Boolean(layer.focusById?.(targetId));
          case "local-adsb":
            return Boolean(layer.selectAircraft?.(String(targetId)));
          default:
            return false;
        }
      },
      untrack() {
        navigation._releaseFollowCamera?.({
          trackingOrigin: "user",
          preserveVesselSelection: false,
        });
        // local-adsb 没有相机跟随，`_releaseFollowCamera` 不会碰到它。
        trackableLayer("local-adsb")?.clearSelection?.();
      },
      flyTo(record) {
        const camera = (
          viewer as {
            camera?: {
              cancelFlight?: () => void;
              heading?: number;
              flyToBoundingSphere?: (
                sphere: Cesium.BoundingSphere,
                options?: {
                  duration?: number;
                  offset?: Cesium.HeadingPitchRange;
                },
              ) => void;
            };
          }
        ).camera;
        if (!camera?.flyToBoundingSphere) return false;
        const point = record?.position;
        let destination: Cesium.Cartesian3 | null = null;
        if (
          point &&
          Number.isFinite(point.x) &&
          Number.isFinite(point.y) &&
          Number.isFinite(point.z)
        ) {
          destination = new Cesium.Cartesian3(
            Number(point.x),
            Number(point.y),
            Number(point.z),
          );
        } else if (
          Number.isFinite(record?.latitude) &&
          Number.isFinite(record?.longitude)
        ) {
          destination = Cesium.Cartesian3.fromDegrees(
            Number(record.longitude),
            Number(record.latitude),
            Number.isFinite(record.altitudeM) ? Number(record.altitudeM) : 0,
          );
        }
        if (!destination) return false;
        camera.cancelFlight?.();
        camera.flyToBoundingSphere(new Cesium.BoundingSphere(destination, 1000), {
          duration: 1.6,
          offset: new Cesium.HeadingPitchRange(
            Number.isFinite(camera.heading) ? Number(camera.heading) : 0,
            Cesium.Math.toRadians(-35),
            22000,
          ),
        });
        return true;
      },
      contextMode(mode) {
        return contextControls?.setContextMode?.(mode) ?? Promise.resolve(null);
      },
      clearLayers() {
        return contextControls?.clearSelectedLayers?.() ?? Promise.resolve(null);
      },

      // ── G4 命令坞 ────────────────────────────────────────────
      async searchPlaces(query, signal) {
        const text = String(query ?? "").trim();
        if (!text) return [];
        // `createPlaceSearch` 负责多来源回退与取消：坐标 / 内置地名 / Google /
        // Photon / Nominatim（`search/defaults.js`）。GEV 一次只返回最佳匹配。
        const outcome = await placeSearch.geocode(text, { signal });
        const place = outcome?.place;
        if (!place) return [];
        const lat = Number(place.lat);
        const lon = Number(place.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
        const label = String(place.label || place.name || text);
        const name = String(place.name || "");
        return [
          {
            id: `${lat.toFixed(5)},${lon.toFixed(5)}|${label}`,
            label,
            sublabel: name && name !== label ? name : undefined,
            lat,
            lon,
            kind: placeKindFromTypes(place.types),
          },
        ];
      },
      flyToPlace(result) {
        if (
          !result ||
          !Number.isFinite(result.lat) ||
          !Number.isFinite(result.lon)
        ) {
          return false;
        }
        // 先释放跟踪，等价 G3 的 `untrack`（LocationNavigation 的导航交接在
        // 无 DOM 的 G2 里没有可复用入口，按提示词退回到 flyToLandmark）。
        actions.untrack();
        // 不同尺度的结果给不同的取景距离：城市看全景，地标贴近，坐标适中。
        const rangeByKind: Record<string, number> = {
          coordinate: 1200,
          city: 15000,
          region: 200000,
          landmark: 900,
          place: 4000,
        };
        const range = Number.isFinite(result.rangeM)
          ? Number(result.rangeM)
          : (rangeByKind[result.kind] ?? 4000);
        const flight = flyToLandmark(viewer, result.lat, result.lon, {
          range,
          pitch: -35,
          heading: 0,
          duration: 2.6,
        });
        // 记下目标，供 `O` 键自动旋转。
        orbitTarget = flight?.targetPosition ?? null;
        orbitOptions = { radius: range, pitch: -35 };
        return Boolean(flight);
      },
      setMapStack(id) {
        // `maps/controller.js:190` `setStack`。
        return mapStackController.setStack(id);
      },
      getMapStack() {
        // `maps/controller.js:112` `getActiveId`。
        return mapStackController.getActiveId();
      },
      availableMapStacks() {
        // `maps/catalog.js` `MAP_STACKS`：过滤 `requiresIon`；`photoreal`
        // （Google 3D）在没有 Google 密钥时去掉。
        const hasGoogle = Boolean(String(options.googleApiKey ?? "").trim());
        return (MAP_STACKS as {
          id: string;
          label: string;
          shortLabel?: string;
          requiresIon?: boolean;
        }[])
          .filter(
            (stack) =>
              !stack.requiresIon &&
              (hasGoogle || stack.id !== "photoreal"),
          )
          .map((stack) => ({
            id: stack.id,
            label: stack.label,
            shortLabel: stack.shortLabel ?? stack.label,
          }));
      },
      setStyle(name) {
        // 外壳的调用方式：`setStyle(style, { userInitiated: true })`
        // （`ui/displayBindings.js:57`）。其余选项走 `setStyle` 的默认值。
        // VisualSettings 在切换后会通过 `readHud()` 拿到 HUD 并调用
        // `hud.onStyleChange(style)`（`ui/visualSettings.js:1545`），颜色与
        // 自动显隐（军事风格自动显示）因此与外壳完全一致。
        visualSettings.setStyle?.(name, { userInitiated: true });
      },
      getStyle() {
        // `ui/visualSettings.js:223` 的 `this.activeStyle`。
        return visualSettings.activeStyle ?? "normal";
      },
      toggleHud() {
        // `ui/displayBindings.js:61`：`this.hud.toggle()` —— 用户显式开关，
        // 内部会关闭 `_autoMode`，之后不再随风格自动显隐。
        hud.toggle();
      },
      cycleDetection() {
        // 外壳在 `cycleDetectionMode()` 前调用 `claimDetection()`（`applicationShell.js:571`），
        // 把这次切换记为显式的用户选择，之后的风格预设不会覆盖它。
        visualSettings._detectionUserOverridden = true;
        // `data/detection.js:410` `cycleMode`。
        cycleDetectionMode();
      },
      getDetectionMode() {
        // `data/detection.js:446` `getMode`。
        return getDetectionMode();
      },
      resetGlobe() {
        // 先释放跟踪（与 G3 的 `untrack` 相同），再飞回整个地球。
        actions.untrack();
        orbitController.stop();
        orbitTarget = null;
        flyToGlobeView(viewer);
      },
      toggleOrbit() {
        // `orbit.js` `OrbitController.toggle`（外壳 `_initOrbit` / `_toggleOrbit`）。
        if (!orbitTarget) return false;
        return Boolean(orbitController.toggle(orbitTarget, orbitOptions));
      },
      attachCockpit() {
        // 重建前先销毁旧实例：React StrictMode 会「挂载 → 清理 → 再挂载」。
        cockpitCoordinator?.destroy();
        cockpitCoordinator = null;

        const coordinator = new CockpitCoordinator({
          viewer,
          services: {
            flightsLayer: layers.flightsLayer,
            militaryFlightsLayer: layers.militaryFlightsLayer,
            isTr3b,
            toggleTr3b,
            militaryAwarenessLayer: layers.militaryAwarenessLayer,
            cachedGroundFloor: controlServices.cachedGroundFloor,
            cachedMeshFloor: controlServices.cachedMeshFloor,
            GROUND_FLOOR_LIFT_M: controlServices.GROUND_FLOOR_LIFT_M,
            meshFloorPreferred: controlServices.meshFloorPreferred,
            warmGroundFloor: controlServices.warmGroundFloor,
            sampleMeshFloorCells: controlServices.sampleMeshFloorCells,
            holdContinuousRender,
            releaseContinuousRender,
            fetchRegionalBrief,
            regionalDistanceM,
            weatherCodeLabel,
          },
          // 外壳面板的显示切换控件我们没有，传 null（`_initCockpitDisplayPortal`
          // 不会在无外壳时被调用）。
          elements: {
            _ppToggles: null,
            _cockpitDisplayPanel: null,
            _hudBtn: null,
            _detectionBtn: null,
            _sliderPanel: null,
            _models3dBtn: null,
          },
          operations: {
            publishCockpit: cockpitPublish,
            publishCockpitPortal: noop,
            _layoutRightPanels: noop,
            _setCockpitVision: (
              mode: string,
              active: boolean,
              options?: { revealParameters?: boolean },
            ) => visualSettings._setCockpitVision?.(mode, active, options),
            _stampNavigation: () => 0,
            getAircraftTrackingTarget: () =>
              aircraftTrackingTarget(
                cockpitCoordinator?.cockpitView?.readAircraftInfo?.(),
              ),
            _scheduleRightPanelLayout: noop,
          },
          readDataManager: () => dataManager,
          readContext: () =>
            contextControls?.getContextModeState?.() ?? {
              mode: null,
              changing: false,
            },
          readActiveStyle: () => visualSettings.activeStyle ?? "normal",
          readUtilityDisclosureOpen: () => false,
          enterPanels: noop,
          exitPanels: noop,
        }) as CockpitCoordinatorLike;

        // 放宽驾驶舱入场门槛。GEV 的 `cockpitEntryAllowed`（`contextModePolicy.js`）
        // 要求 Contacts 模式且航班 + 军机图层同时开启——那来自 GEV 的 CONTACTS
        // 面板语义，我们的 UI 没有这套面板。这里改为「航班或军机图层已开启」，
        // 真正能否进入仍由 `enter()` 对 `viewer.trackedEntity` / 飞机信息的检查把关
        // （`ui/cockpitTrackingController.js:141-144`）。
        const cockpitView = coordinator.cockpitView as
          | (CockpitViewLike & { isEntryAllowed?: () => boolean })
          | undefined;
        if (cockpitView) {
          cockpitView.isEntryAllowed = () =>
            dataManager.isEnabled("flights") ||
            dataManager.isEnabled("military");
        }

        cockpitCoordinator = coordinator;
        return () => {
          if (cockpitCoordinator === coordinator) {
            coordinator.destroy();
            cockpitCoordinator = null;
          }
        };
      },

      // ── G6 情报图层 ────────────────────────────────────────────
      async setIntelData(data) {
        const jobs: Promise<unknown>[] = [];
        if (typeof data.eventsGeojsonl === "string") {
          const next = URL.createObjectURL(
            new Blob([data.eventsGeojsonl], {
              type: "application/geo+json",
            }),
          );
          const previous = intelUrls.events;
          intelUrls.events = next;
          jobs.push(
            Promise.resolve(intelLayers.events.reload(viewer, next)).catch(
              () => undefined,
            ),
          );
          URL.revokeObjectURL(previous);
        }
        if (typeof data.newsGeojsonl === "string") {
          const next = URL.createObjectURL(
            new Blob([data.newsGeojsonl], {
              type: "application/geo+json",
            }),
          );
          const previous = intelUrls.news;
          intelUrls.news = next;
          jobs.push(
            Promise.resolve(intelLayers.news.reload(viewer, next)).catch(
              () => undefined,
            ),
          );
          URL.revokeObjectURL(previous);
        }
        await Promise.all(jobs);
      },
      selectIntelFeature(layerId, newweiId) {
        if (!layerId || !newweiId) return false;
        const store = getGevContextStore();
        const target = String(newweiId);
        const candidates = [
          `${layerId}:${target}`,
          `${layerId}:evt:${target}`,
          `${layerId}:news:${target}`,
        ];
        let record: { entity?: unknown } | undefined;
        for (const id of candidates) {
          const found = store.entities.get(id) as
            | { entity?: unknown }
            | undefined;
          if (found) {
            record = found;
            break;
          }
        }
        if (!record) {
          for (const candidate of store.entities.values() as Iterable<
            {
              layerId?: string;
              entity?: unknown;
              properties?: Record<string, unknown>;
            }
          >) {
            if (candidate?.layerId !== layerId) continue;
            const properties = candidate.properties ?? {};
            if (
              String(properties.newweiId ?? "") === target ||
              String(properties.id ?? "") === target
            ) {
              record = candidate;
              break;
            }
          }
        }
        if (!record?.entity) return false;
        selectEntityContext(record.entity);
        return true;
      },
    };

    // G4 预留给 G5：`H` 键在 `globe-stage.tsx` 的快捷键绑定里派发
    // `globe:toggle-hud`，这里转调 `actions.toggleHud`（等价外壳 `H` → `hud.toggle()`）。
    const onToggleHud = () => actions.toggleHud();
    window.addEventListener("globe:toggle-hud", onToggleHud);
    lifecycle.defer(() =>
      window.removeEventListener("globe:toggle-hud", onToggleHud),
    );

    const runtime: GlobeRuntime = {
      viewer,
      dataManager,
      mapStackController,
      owners: {
        visualSettings,
        navigation,
        layerBindings,
        context: contextControls,
        locationNavigation,
        // F5：coordinator 由 `attachCockpit()` 稍后创建，必须在读取时取值。
        get cockpit() {
          return cockpitCoordinator;
        },
      },
      pinia,
      actions,
      setLocale(locale) {
        setGevLocale(locale);
      },
      destroy() {
        return lifecycle.destroy();
      },
    };

    // 11) 开发调试句柄。
    if (process.env.NODE_ENV !== "production") {
      window.__newweiGlobe = runtime;
      lifecycle.defer(() => {
        if (window.__newweiGlobe === runtime) {
          delete window.__newweiGlobe;
        }
      });
    }

    // G6：进入页面时默认启用事件图层（新闻图层由用户在面板打开）。
    if (!dataManager.isEnabled("newwei-events")) {
      void dataManager
        .toggle("newwei-events", { origin: "user" })
        .catch(() => undefined);
    }

    return runtime;
  } catch (error) {
    // 12) 任何一步抛错：先销毁已获得的一切，再把错误抛出去。
    await lifecycle.destroy().catch(() => undefined);
    throw error;
  }
}
