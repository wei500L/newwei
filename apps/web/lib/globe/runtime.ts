// eslint-disable-next-line import/order -- 必须在任何 Cesium / GEV 模块求值前执行
import "./cesium-base";
// ^ 第一条 import：在 Cesium / GEV 模块求值前设置 window.CESIUM_BASE_URL。

import { createApplicationScene } from "@gev/app/scene.js";
import {
  interruptCameraMotion,
  interruptGlobeRotation,
} from "@gev/cameraVerbs.js";
import {
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
import {
  initTrackedReadout,
  destroyTrackedReadout,
} from "@gev/data/trackedReadout.js";
import { setLocale as setGevLocale } from "@gev/i18n/index.js";
import { flyToGlobeView } from "@gev/locations.js";
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
import { ContextControls } from "@gev/ui/context.js";
import { LayerBindings } from "@gev/ui/layerBindings.js";
import { LocationNavigation } from "@gev/ui/locationNavigation.js";
import { NavigationController } from "@gev/ui/navigationController.js";
import { useContextStore as getContextStore } from "@gev/ui/stores/context.js";
import { useLocationStore as getLocationStore } from "@gev/ui/stores/location.js";
import { VisualSettings } from "@gev/ui/visualSettings.js";
import { applicationPinia } from "@gev/ui/vueRuntime.js";
import * as Cesium from "cesium";
import { setActivePinia } from "pinia";

import type {
  ContextControlsLike,
  GlobeOwners,
  GlobeTargetRecord,
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
    for (const layer of catalog.layers) {
      (layer as { attachDataManager?: (manager: unknown) => void })
        .attachDataManager?.(dataManager);
    }
    for (const layer of catalog.layers) {
      (
        layer as { attachMapStackController?: (controller: unknown) => void }
      ).attachMapStackController?.(mapStackController);
    }
    dataManager.finalizeRegistrations(catalog.metadata);
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
    });
    lifecycle.defer(() => destroyDetection());

    initTrackedReadout(viewer);
    lifecycle.defer(() => destroyTrackedReadout());

    setDetectionStyle("normal");

    // 9) 负责人模块。
    const controlServices = (scene.operations.surface as {
      controlServices: {
        cachedGroundFloor: unknown;
        warmGroundFloor: unknown;
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
      readHud: () => null,
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
        hud: placeholderControl,
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

    // 9f) CockpitCoordinator —— 构造参数太多（applicationShell.js:358-434），
    //     G2 先不创建，留给 G5（详见报告）。

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
    };

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
        cockpit: null,
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

    return runtime;
  } catch (error) {
    // 12) 任何一步抛错：先销毁已获得的一切，再把错误抛出去。
    await lifecycle.destroy().catch(() => undefined);
    throw error;
  }
}
