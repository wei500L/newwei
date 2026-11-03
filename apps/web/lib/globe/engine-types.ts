/**
 * engine-types.ts — 我们实际用到的 GEV 引擎接口的**窄**类型。
 *
 * GEV 是无类型 JS（`declare module "@gev/*"` 是宽松声明），所以这里只手写
 * 我们真正依赖的成员，并按批次用 `@gev/*` 的实例赋值给这些结构类型。
 * 每个接口上方注明对应的 vendor 源码位置（`文件:行`），便于核对。
 */

/** 一个图层的序列化/展示状态。
 * 来源：`data/lifecycle.js:2264`（`LayerLifecycle#getAll` 的返回项）。 */
export interface LayerSummary {
  id: string;
  name: string;
  icon?: string;
  source?: string;
  /** 是否出现在图层开关面板。来源：`data/lifecycle.js:2270`。 */
  showInTogglePanel: boolean;
  requiresKeyId?: string | null;
  enabled: boolean;
  lifecycleState: string;
  lifecycleUncertain?: boolean;
  stats?: Record<string, unknown> | null;
}

/** 图层生命周期状态。来源：`data/lifecycle.js:2254`（`getLayerLifecycleState`）。 */
export interface LayerLifecycleState {
  enabled: boolean;
  lifecycleState: string;
  uncertain?: boolean;
}

/** `LayerLifecycle.subscribe` 推送的变更对象。
 * 来源：`data/lifecycle.js:2286`（订阅）、`_notifyListeners`（`data/lifecycle.js:2329`）。 */
export interface LayerLifecycleChange {
  type?: string;
  layerId?: string;
  enabled?: boolean;
  origin?: string;
  [key: string]: unknown;
}

/**
 * 只保留我们实际调用的 `LayerLifecycle` 成员。
 * - 构造与注册顺序：`app/data.js:15-41`
 * - `getAll` / `subscribe` / `toggle` / `isEnabled` / `getLayerLifecycleState`：
 *   `data/lifecycle.js:2264` / `:2286` / `:602` / `:2248` / `:2254`
 * - `destroyAll`：`data/lifecycle.js:2241`
 */
export interface LayerLifecycleLike {
  getAll(): LayerSummary[];
  subscribe(callback: (change: LayerLifecycleChange) => void): () => void;
  toggle(
    layerId: string,
    options?: { origin?: string; notificationToken?: unknown },
  ): Promise<boolean>;
  isEnabled(layerId: string): boolean;
  getLayerLifecycleState(layerId: string): LayerLifecycleState | null;
  register(layer: unknown): void;
  finalizeRegistrations(metadata: readonly unknown[]): void;
  destroyAll(): Promise<void>;
  /** id → { module, enabled, ... }。来源：`data/lifecycle.js:89`。 */
  readonly layers: Map<string, unknown>;
}

/** 地图栈状态。来源：`maps/controller.js:131`（`getState`）。 */
export interface MapStackState {
  activeId: string;
  activeStack: unknown;
  stacks: unknown[];
  status: string;
  lastError: string | null;
  switchOrigin: string;
}

/**
 * 只保留我们实际调用的 `MapStackController` / `MapSourceController` 成员。
 * - `setStack`：`maps/controller.js:190`
 * - `getActiveId` / `getState`：`maps/controller.js:112` / `:131`
 * - `getImageryHostTileset`：`maps/controller.js:102`
 * - `destroy`：`maps/controller.js`（`MapStackController` 继承，scene 内部已 defer）
 */
export interface MapStackControllerLike {
  setStack(id: string, options?: { silent?: boolean }): Promise<unknown>;
  getActiveId(): string;
  getState(status?: string): MapStackState;
  getImageryHostTileset?(): unknown;
  destroy(): void;
}

/** VisualSettings 的窄接口。构造见 `ui/applicationShell.js:193`；
 * `_initStages` / `_initBloomSharpen` 见 `ui/applicationShell.js:524-525`。 */
export interface VisualSettingsLike {
  _initStages(): void;
  _initBloomSharpen(): void;
  _setDetectionDensity?(pct?: number): void;
  _updateDetectionButton?(label: string): void;
  /** 当前风格（`ui/visualSettings.js:223` 的 `this.activeStyle`）。 */
  activeStyle?: string;
  /** 是否已由用户显式切换过检测框（`ui/visualSettings.js:227`）。 */
  _detectionUserOverridden?: boolean;
  setStyle?(name: string, options?: unknown): void;
  /** 驾驶舱视觉模式覆盖：`ui/visualSettings.js:351` `_setCockpitVision`。 */
  _setCockpitVision?(
    mode: string,
    active: boolean,
    options?: { revealParameters?: boolean },
  ): void;
  stop(): void;
  destroy(): void;
}

/** NavigationController 的窄接口。构造见 `ui/applicationShell.js:166`；`destroy` 见 `:269`。
 * `_releaseFollowCamera` 见 `ui/navigationController.js:129`（G3 的「停止跟踪」用它释放相机与各图层跟随）。 */
export interface NavigationControllerLike {
  stop(): void;
  destroy(): void;
  _releaseFollowCamera?(options?: {
    preserveVesselSelection?: boolean;
    preserveCameraFlight?: boolean;
    trackingOrigin?: string;
  }): boolean;
}

/** LayerBindings 的窄接口。构造见 `ui/applicationShell.js:253`；
 * `attachDataManager` / `stop` / `disconnect` 见 `ui/layerBindings.js:199` / `:261` / `:285`。 */
export interface LayerBindingsLike {
  attachDataManager(dataManager: LayerLifecycleLike): void;
  stop(): void;
  disconnect(): void;
}

/**
 * IntelHUD 的窄接口。构造见 `vendor/gods-eye-view/src/hud.js:171-200`；
 * `show` / `hide` / `toggle` / `setMode` / `onStyleChange` / `getVariant` /
 * `attachDataManager` / `destroy` 见 `hud.js:998` / `:1008` / `:1014` / `:1029` /
 * `:972` / `:1056` / `:1074` / `:1094`。
 */
export interface IntelHUDLike {
  show(): void;
  hide(): void;
  toggle(): void;
  setMode(mode: "auto" | "on" | "off"): void;
  onStyleChange(styleName: string): void;
  getVariant(): string;
  setVariant(name: string): void;
  readonly visible: boolean;
  attachDataManager(dataManager: LayerLifecycleLike): void;
  destroy(): void;
}

/** ContextControls 的窄接口。构造见 `ui/applicationShell.js:936`； * `connect` / `stop` / `restoreForDisposal` / `disconnect` 见 `ui/contextControls.js:70` / `:88` / `:94` / `:77`。
 * `setContextMode` 见 `ui/contextActions.js:57`；`clearSelectedLayers` 见 `ui/contextActions.js:184`。 */
export interface ContextControlsLike {
  connect(dataManager: LayerLifecycleLike): unknown;
  stop(): void;
  restoreForDisposal(): Promise<void>;
  disconnect(): void;
  setContextMode?(
    mode: "contacts" | "space-missions" | "off" | null,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  clearSelectedLayers?(options?: Record<string, unknown>): Promise<unknown>;
  /** 当前 Context 模式状态：`ui/contextActions.js:51` `getContextModeState`。 */
  getContextModeState?(): {
    mode?: string | null;
    active?: boolean;
    changing?: boolean;
  };
}

/** CockpitViewController 的窄接口（`ui/cockpitController.js:66`）。 */
export interface CockpitViewLike {
  readAircraftInfo?(): unknown;
  active?: boolean;
  isEntryAllowed?(): boolean;
}

/**
 * CockpitCoordinator 的窄接口。构造见 `ui/applicationShell.js:358-423`；
 * `cockpitView` / `stop` / `destroy` 见 `ui/cockpitCoordinator.js:56` / `:406` / `:410`。
 */
export interface CockpitCoordinatorLike {
  readonly cockpitView?: CockpitViewLike;
  stop?(): void;
  destroy(): void;
}

/** LocationNavigation 的窄接口。构造见 `ui/applicationShell.js:298`；`destroy` 见 `ui/locationNavigation.js:433`。 */
export interface LocationNavigationLike {
  destroy(): void;
  orbitController?: { stop?: () => void } | null;
}

/** 引擎/负责人集合。CockpitCoordinator 由 `attachCockpit()` 延迟创建。 */
export interface GlobeOwners {
  visualSettings: VisualSettingsLike | null;
  navigation: NavigationControllerLike | null;
  layerBindings: LayerBindingsLike | null;
  context: ContextControlsLike | null;
  locationNavigation: LocationNavigationLike | null;
  cockpit: CockpitCoordinatorLike | null;
}


/** 目标卡片/跟踪动作接收的记录（`gev:entity-selected` 或 `gev:awareness-subject-selected` 的 detail）。 */
export interface GlobeTargetRecord {
  id?: string | number;
  layerId?: string;
  layerName?: string;
  label?: string;
  name?: string;
  targetId?: string;
  latitude?: number;
  longitude?: number;
  altitudeM?: number;
  position?: { x?: number; y?: number; z?: number };
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}
