# 3D 地球 G2（地基）：无界面引擎运行时 + React 桥接 + 最小 `/globe` 页面

> **一句话目标**：在 `/globe` 页面里运行 GEV 的引擎，界面全部由 React 负责。做法分两层：
> - **照搬** GEV 的「负责人模块 → Pinia 仓库」这一层（它们不依赖 Vue 组件，也不按 id 抓 DOM，已逐个核实）；
> - 只把「仓库 → 画面」这一层换成 React。
>
> 本批完成后，页面上要能看到：地球（有 Google 密钥时是照片级 3D，否则是 Esri 卫星图）、一行加载状态文字，以及一个临时的调试条（开关一个图层、显示当前选中目标的名称）。正式面板在 G3–G5 做。
>
> **这是最难的一批。** 务必先读源码再写代码，并在报告里写清楚每个构造参数是怎么确定的。
>
> **依赖**：G0、G1 已合入。**开工前必读**：本目录 README 全文（尤其 §2.1 白名单、§2.2 对接点、§5 硬约束），以及下面「必读源码」列出的全部文件。

## 必读源码（vendor/gods-eye-view/src/）

| 文件 | 读什么 |
|---|---|
| `standalone/application.js:40-110` | 独立版的组装顺序：设置语言 → 地点搜索 → 场景 → 图层目录 → 控件 → 数据 → 工具 |
| `app/application.js` | 生命周期语义：`defer` 清理栈（后进先出）、`AbortSignal`、启动失败时回滚。**只读，不引用**（黑名单） |
| `app/scene.js` | `createApplicationScene` 的参数。注意两点：容器 id 写死为 `'cesiumContainer'`；会自己创建 `#cesium-credits` 并挂到 `document.body` |
| `standalone/scene.js`、`services/requests.js` | `requestServices` 的来源 |
| `standalone/catalog.js`、`app/constructCatalog.js` | `createStandaloneCatalog({ signal, surface })` 的返回结构（`layers`、`metadata`…） |
| `app/data.js` | `LayerLifecycle` 的构造与注册顺序（`register` → `attachDataManager` → `attachMapStackController` → `finalizeRegistrations`）。**只读，照着写，不引用**（黑名单） |
| `ui/applicationShell.js:150-620` | 外壳构造函数：负责人模块的创建顺序与参数，尤其是：`NavigationController`（约 :166）、`initWorldOverlay`（:492）、`initDetection`（:503）、`initTrackedReadout`（:520）、`_initStages` / `_initBloomSharpen`（:524） |
| `ui/visualSettings.js` | 滤镜负责人：构造参数、`setStyle` 一类方法（约 :1480-1530）、发布到 `display` 仓库 |
| `ui/layerBindings.js` | 图层与选中跟踪的绑定 |
| `ui/context.js`、`ui/contextControls.js`、`ui/stores/context.js` | 右侧情境 / 详情的负责人与仓库 |
| `ui/locationNavigation.js`、`ui/location.js`、`ui/stores/location.js` | 地点搜索与飞行 |
| `ui/cockpitCoordinator.js`、`ui/stores/cockpit.js` | 驾驶舱负责人（G5 使用，本批只完成构造） |
| `ui/stores/owners.js` | 仓库里的 `connect / act` 模式：视图调用 `act(name, …)`，由最新接入的负责人响应 |
| `ui/vueRuntime.js` | `applicationPinia()`：整个页面共用一个 Pinia 实例 |
| `i18n/index.js` | `setLocale` / `getLocale` / `onLocaleChange` |
| `ui/views/*.vue` | **只读**：每个 Vue 视图读了哪些仓库字段、触发了哪些动作。G3–G5 的 React 组件要照这个契约来写 |

## 架构

```
apps/web/lib/globe/
  engine-types.ts      我们实际用到的 GEV 接口的窄类型（手写，按源码核对）
  runtime.ts           createGlobeRuntime(container, options) → GlobeRuntime（只在客户端运行；唯一引用 @gev/* 的文件群之一）
  runtime-lifecycle.ts 通用的 defer 栈 + AbortController + 单例守卫（纯逻辑，可测试）
  pinia-bridge.ts      useGevStore(store, selector)：用 useSyncExternalStore 订阅 Pinia 仓库（不依赖引擎，可测试）
  gev-events.ts        useGevWindowEvent / useGevSelection / useMapStack / useGevStyle：订阅 window 上的 gev:* 事件（可测试）
  runtime-context.tsx  <GlobeRuntimeProvider> / useGlobeRuntime()
apps/web/app/(app)/globe/
  page.tsx             服务端组件：只渲染 <GlobeContent />
  globe-content.tsx    客户端组件：next/dynamic(() => import("./globe-stage"), { ssr: false })
  globe-stage.tsx      挂载 #cesiumContainer、启动和销毁运行时、显示加载 / 错误状态、提供 Context
  globe-debug-bar.tsx  临时调试条（G3 删除）
```

## 任务

### 2.1 `runtime-lifecycle.ts`（纯逻辑）

实现一个和 GEV `app/application.js` 语义一致的小型生命周期：

```ts
export interface RuntimeLifecycle {
  signal: AbortSignal;
  defer(cleanup: () => void | Promise<void>): void; // 后进先出
  destroy(): Promise<void>; // 幂等；先 abort，再按后进先出执行全部 cleanup；单个 cleanup 抛错不影响其余，最后抛出 AggregateError
}
export function createRuntimeLifecycle(): RuntimeLifecycle;

/** 每个页面同时只能有一个 GEV 运行时（它在 window 上保存全局状态）。新的启动必须等上一个 destroy 完成。 */
export function acquireGlobeSlot(): Promise<() => void>;
```

`acquireGlobeSlot` 的实现：模块级保存一个 Promise 链。之所以需要它，是因为 `next.config` 开了 `reactStrictMode: true`，开发环境下 effect 会「挂载 → 清理 → 再挂载」，第二次启动必须等第一次彻底销毁之后才能开始。

测试：清理顺序为后进先出；destroy 幂等；单个 cleanup 抛错不阻止其它 cleanup；`acquireGlobeSlot` 能让两次启动串行执行。

### 2.2 `runtime.ts`：组装顺序（核心）

签名：

```ts
export interface GlobeRuntimeOptions {
  googleApiKey?: string;               // process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
  locale: "zh-CN" | "en";
  onStatus?: (text: string) => void;    // 加载状态文字
}
export interface GlobeRuntime {
  viewer: unknown;                     // Cesium.Viewer（engine-types 里给出窄类型）
  dataManager: LayerLifecycleLike;
  mapStackController: MapStackControllerLike;
  owners: { visualSettings; navigation; layerBindings; context; locationNavigation; cockpit };
  pinia: unknown;
  setLocale(locale: "zh-CN" | "en"): void;
  destroy(): Promise<void>;
}
export async function createGlobeRuntime(container: HTMLElement, options: GlobeRuntimeOptions): Promise<GlobeRuntime>;
```

文件第一行（在任何 `@gev` 或 `cesium` 的 import 之前）设置 `window.CESIUM_BASE_URL = "/cesium/"`。由于 ES import 会被提升，这一句要单独放进 `lib/globe/cesium-base.ts`，再在 `runtime.ts` 的第一条 import 引入它。另外 `import "cesium/Build/Cesium/Widgets/widgets.css"`，如果 Next 不允许在这里引入全局 CSS，就放到 `globe-stage.tsx` 里。

组装步骤，**每一步都要先对照上面的必读源码确认参数**：

1. `lifecycle = createRuntimeLifecycle()`；`releaseSlot = await acquireGlobeSlot()`，并 `defer(releaseSlot)`。
2. 语言：`setLocale(options.locale)`（`@gev/i18n/index.js`）。
3. Pinia：`const pinia = applicationPinia()`（`@gev/ui/vueRuntime.js`），`setActivePinia(pinia)`。**不要**调用 `createUiRuntime().mount`。
4. 容器：GEV 写死了 `'cesiumContainer'`。确认传入的 `container.id === "cesiumContainer"`，否则抛错。
5. 场景：
   ```ts
   const scene = await createApplicationScene({
     requestServices: createApplicationRequestServices(),
     googleApiKey: options.googleApiKey || undefined,
     googleTokens: null,
     cesiumToken: undefined,
     credits: /* 照 standalone 的写法；源码里找不到就传 undefined，并在报告里说明 */,
     loaderStatus: statusSink,   // 一个带 textContent setter 的普通对象，setter 里调用 options.onStatus
     signal: lifecycle.signal,
     defer: lifecycle.defer,
   });
   ```
   - `#cesium-credits` 由 GEV 挂到 `document.body`。在 `globe-stage.tsx` 里用全局 CSS 把它固定在地球容器的右下角（`position: fixed; right: 12px; bottom: 12px; z-index` 高于面板）。**不能隐藏它**（许可要求）。
6. 图层目录：
   ```ts
   const catalog = createStandaloneCatalog({ signal: lifecycle.signal, surface: scene.operations.surface });
   ```
   Nepal 边界解析器（`nepalBoundaryResolver`）不传，也就是放弃洪水场景的边界绘制，在报告中说明。
7. 数据生命周期：照 `app/data.js` 的顺序**自己写**（不要引用 `app/data.js`）：
   - `new LayerLifecycle(viewer, { visibilityTarget: document, getSourceAvailability: catalog.getSourceAvailability })`；
   - 对 `catalog.layers` 依次执行 `register` → `attachDataManager` → `attachMapStackController`；
   - 再执行 `finalizeRegistrations(catalog.metadata)`；
   - `defer(() => dataManager.destroyAll())`。
   - **跳过** `LayerPresentation.mount(#data-toggles)` 和 `createCyberSonarScene`。
8. 引擎服务：按 `applicationShell.js:488-525` 的顺序：
   - `initWorldOverlay(viewer)`；
   - `initDetection(viewer, [这几个图层实例], onModeLabel)`：图层实例从 `dataManager` 或 `catalog` 中按 id 取，id 以源码为准，对应 traffic、flights、military、localAdsb、satellites、cctv、bikeshare、transit、vessels，不存在的过滤掉；
   - `initTrackedReadout(viewer)`；
   - 每一项都要 `defer` 对应的 `destroy*`。
9. 负责人模块：按 `applicationShell.js` 里的构造参数逐个创建。所需的 `services`、`elements`、`readers` 从外壳代码里照抄：
   - `VisualSettings`：随后调用它的 `_initStages()` 等价逻辑，也就是外壳里 `_initStages` / `_initBloomSharpen` 委托的方法，以源码为准；
   - `NavigationController`；
   - `LayerBindings`：接入 `dataManager`；
   - `ContextControls`：`ui/context.js`；
   - `LocationNavigation`；
   - `CockpitCoordinator`。

   **原则**：
   - 外壳传给负责人的 DOM 元素（例如 `this._models3dBtn`），我们一律传 `null`。如果负责人在 `null` 时会报错，就传一个**不挂载到页面的** `document.createElement("button")` 占位，并在报告里逐个列出。
   - 外壳传入的回调里，如果是更新它自己 DOM 的（例如 `_updateDetectionButton`），我们传空函数。
   - 如果是发布到 Pinia 仓库的，保留。G3–G5 的 React 组件就是读这些仓库。
   - 每个负责人都要 `defer` 它的 `dispose` / `destroy` / `stop`，名字以源码为准。
   - **遇到构造参数多到无法判断的负责人**（尤其是 `CockpitCoordinator`），本批可以先不创建，在 `owners` 里放 `null`，并在报告里说明需要哪些参数，留给 G5。
10. 初始相机：调用 `locations.js` 的 `flyToGlobeView(viewer)`，看到整个地球。GEV 默认飞往 Austin，这一步**不照搬**。
11. 开发调试：在 `process.env.NODE_ENV !== "production"` 时设置 `window.__newweiGlobe = runtime`，并 `defer(delete)`。
12. 任何一步抛错：执行 `await lifecycle.destroy()` 后再把错误抛出去。

### 2.3 `engine-types.ts`

只为 2.2 中实际用到的成员写**窄**接口：`LayerLifecycleLike` 的 `getAll`、`subscribe`、`toggle`、`isEnabled`、`getLayerLifecycleState`，`MapStackControllerLike` 的 `setStack` 和当前栈的读取，等等。每个接口上方注释写出对应的源码位置（`文件:行`）。不要写 `any` 的大对象。

### 2.4 `pinia-bridge.ts`（不依赖引擎，可测试）

```ts
/** 订阅一个 Pinia 仓库的某个字段。GEV 的负责人每次发布都替换成新的 markRaw 对象，所以按引用比较即可。 */
export function useGevStore<S, T>(store: S & { $subscribe: Function }, selector: (s: S) => T): T;
```

用 `useSyncExternalStore` 实现：

- `subscribe` 内部调用 `store.$subscribe(cb, { detached: true })`，返回值是取消订阅函数；
- `getSnapshot` 返回 `selector(store)`；
- `getServerSnapshot` 返回 `undefined`（这个 hook 只会在客户端组件里被调用）。

测试：在 jsdom 里用真实的 `pinia`（`createPinia` + `setActivePinia` + `defineStore`）定义一个仿照 `gev-context` 写法的仓库（`shallowRef` + `publish`）。验证调用 `publish` 后组件重新渲染并拿到新值。**不引入 Vue 组件。**

### 2.5 `gev-events.ts`（可测试）

- `useGevWindowEvent<T>(type: string): T | null`：监听 `window` 上的 `CustomEvent`，返回最近一次的 `detail`。
- `useGevSelection()`：
  - 合并 `gev:entity-selected`、`gev:awareness-subject-selected` 和 `gev:entity-selection-cleared`；
  - 返回 `{ source: "entity" | "tracked", record } | null`；
  - 先读 `data/contextStore.js:44-60` 和 `data/trackedReadout.js:229-300`，确认两种事件 `detail` 的结构。
- `useMapStack()`：返回 `gev:map-stack-changed` 的 `detail`。
- `useGevStyle()`：返回 `gev:style-change` / `gev:vision-change` 的 `detail`。

测试：手动派发 `CustomEvent`，断言 hook 的返回值；派发清除事件后变回 `null`。

### 2.6 页面与入口

- `app/(app)/globe/page.tsx`：服务端组件，按其它页面的鉴权方式（参照 `/map/page.tsx`），未登录时跳转登录页。
- `globe-content.tsx`（客户端）：
  - 渲染页面骨架：页面根加 `dark` 类，并用 `ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}` 包住；
  - 通过 `next/dynamic` 以 `ssr: false` 加载 `globe-stage`；
  - 调用 `usePageTitle(t("globe.title"))`。
- `globe-stage.tsx`：
  - `<div id="cesiumContainer" className="absolute inset-0" />`；外层是 `relative h-[calc(100dvh-var(--top-nav-height)-var(--ticker-height,0px))] overflow-hidden bg-slate-950`；
  - `useEffect` 中调用 `createGlobeRuntime`，cleanup 中调用 `runtime.destroy()`；
  - 加载中：居中显示 `onStatus` 的文字，样式为 `kicker` 加 `text-slate-300`；
  - 失败：显示 `ChartEmptyState`，`variant="error"`，提示「3D 地球启动失败」，并附错误信息。旁车不可用时引擎仍能启动（keyless 地球），所以**不能**用旁车是否可用来判断失败；
  - 我们的 i18n 语言变化时调用 `runtime.setLocale`。
- `shell.tsx`：把 `/globe` 加入 `FLUID_LAYOUT_PATHS` 和 `EDGE_TO_EDGE_LAYOUT_PATHS`，让页面无内边距、铺满宽度。
- `navigation-model.ts`：在 `/map` 之后新增导航项 `{ key: "/globe", path: "/globe", icon: GlobalOutlined, labelKey: "nav.main.globe" }`。权限要求与 `/map` 一致。
- i18n：新增 `nav.main.globe`（中文「全球 3D」，英文 "3D Globe"）、`globe.title`、`globe.status.*`、`globe.error.*`。

### 2.7 临时调试条 `globe-debug-bar.tsx`（G3 删除）

位于左上角，样式为 `bg-slate-950/80 border border-slate-700 rounded-md p-2 text-xs font-mono`：

- 一个 Select，列出 `dataManager.getAll()` 中 `showInTogglePanel` 为真的图层（name + id），旁边一个开关，调用 `dataManager.toggle(id, …)`。订阅 `dataManager.subscribe` 来刷新。
- 一行显示 `useGevSelection()` 的 `record?.name ?? record?.id ?? "—"`。

---

## 禁止事项

- 引用 README §2.1 黑名单中的任何模块。新增引用后必须通过 `globe:check-imports`。
- 修改 vendor 源码。本批**不需要**任何补丁；如果确实绕不过去，就停下来，在报告里说明原因和你建议的补丁。
- 在服务端组件或会被 SSR 求值的模块中 import `@gev/*`、`cesium`、`lib/globe/runtime.ts`。
- 在 React 里引入 `vue` 的响应式 API（`watch`、`ref` 等）。`pinia-bridge.ts` 只能用 `$subscribe`。

## 测试

新增 `runtime-lifecycle.test.ts`、`pinia-bridge.test.tsx`、`gev-events.test.tsx`，并加入 `coverage.include`。`runtime.ts`、`globe-stage.tsx` 依赖 Cesium，不做单元测试，在 `coverage.exclude` 中排除并加注释说明原因。

## 验证

- README §6 全部命令通过，**`build` 必须通过**（这是本批最重要的信号：Cesium 和 GEV 能被 webpack 打包）。
- `globe:check-imports` 输出的入口清单与本批实际引用一致。

## 报告额外要求

逐个列出 2.2 第 9 步中每个负责人的构造参数来源（对应 `applicationShell.js` 的行号）、传了 `null` 或占位元素的参数，以及没能创建的负责人。

## 留给用户的浏览器冒烟

以后再做。启动 `pnpm dev:globe` 和 `pnpm dev`，打开 `/globe`，确认：
- 能看到地球；
- 调试条能打开「航班」和「卫星」图层；
- 点击一架飞机后调试条显示它的名称；
- 右下角有数据署名；
- 切换中英文后，加载文字的语言跟着变。
