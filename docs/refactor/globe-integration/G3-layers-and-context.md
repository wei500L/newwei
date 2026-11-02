# 3D 地球 G3：左侧图层面板 + 右侧目标详情卡（含跟踪、附近目标）

> **一句话目标**：
> - 删掉 G2 的临时调试条；
> - 左侧做正式的「数据图层」面板，分组、顺序、状态文字与 GEV 一致；
> - 右侧做「目标详情卡」，点地球上任何目标都会显示，并提供跟踪、飞过去、去控制台搜索等操作；
> - 右侧另有一个「附近目标」页签，复刻 GEV 的 CONTACTS 名单。
>
> 视觉是我们的夜班风格，不照搬 GEV 的霓虹 HUD。
>
> **依赖**：G2 已合入。可与 G4 并行（G4 只动底部命令坞和快捷键，文件不相交）。
>
> **开工前必读**：README 全文；G2 的报告（了解运行时实际创建了哪些负责人）；下面列出的 GEV 源码。

## GEV 的操作逻辑（照这个复刻）

**左侧 DATA LAYERS**：图层分组和顺序以 `vendor/gods-eye-view/src/ui/layerPanel.js:41-99` 的 `PANEL_GROUPS` 为准（展示顺序与注册顺序无关）。

| 组 | 图层 id |
|---|---|
| 移动 Movement | satellites, flights, military, local-adsb, ais-live-vessels, traffic, transit, bikeshare |
| 摄像头 Cameras | cctv, recent-imagery, street-level |
| 基础设施 Infrastructure | alpr-cameras, military-installations, local-datacenters, telegeography-submarine-cables, local-dams |
| 事件 Events | rocket-launches, earthquakes, local-firms, fire-perimeters, gnss-integrity, s2-ghostmaps |
| 天气 Weather | air-quality, wind, weather-radar, weather-satellite, weather-lightning, weather-cyclones |
| 音频 Audio | radio |

- `directions` 属于 GEV 的 Utilities 面板，**第一版不做**。
- 我们的情报图层 `newwei-intel` 由 G6 加入，作为第一组「情报」排在最前面。

每一行显示：图标 + 名称 + 状态 + 数量 + 开关。状态取自 `dataManager.getAll()[i].stats` 和 `lifecycleState`，状态文字与 `layerPanel.js:26-37` 的 `FEED_STATE_LABEL_KEYS` 一一对应：

| 状态 | 中文 |
|---|---|
| nominal | 正常 |
| loading | 加载中 |
| degraded | 降级 |
| stale | 过期 |
| partial | 部分 |
| fallback | 备用源 |
| unavailable | 不可用 |
| enabling / disabling | 开启中 / 关闭中 |

**从 stats 推导状态**：**直接引用** GEV 的 `@gev/data/feedState.js` 中的 `layerFeedState(stats)`，它不碰 Vue（已核实）。`layerPanel.js` 本身也是调用它。图层显示名用 `@gev/ui/layerNames.js` 的 `shownLayerName(name, id)`；缺少密钥时的提示文字用 `@gev/ui/keyGuidance.js` 的 `keyGuidanceText` / `keyRequirementText`；错误文字用 `@gev/ui/statusText.js` 的 `translateFeedError`。先读 `layerPanel.js` 里这几个函数被调用的方式，然后照着调用。**`ui/layerPanel.js` 本身不能引用**，它会带进 `LayerRows.vue`。

- `stats.keyRequired` 为真，或 `requiresKeyId` 存在且图层报告缺少密钥时，显示「需要密钥」，开关禁用，悬停提示「在旁车的环境变量中配置」。
- `stats.error` 显示在行下方，红色小字，最多两行。

**选中**：GEV 中点击目标后，相机锁定，拖出轨迹，地球上画出标签卡（这部分由引擎负责，`trackedReadout` + `worldOverlay`，**保留**）。我们在右侧另外加一张 React 详情卡。

**附近目标（CONTACTS）**：

- GEV 的右侧面板 `ui/views/ContextView.vue` 有一个 CONTACTS 模式，列出 250 km 内最近的飞机、船、设施，可以逐个切换，入口按钮是 `global-context-flights-btn`。
- 负责人是 `ui/context.js`（`ContextControls`），它把名单发布到 `useContextStore().awareness`；外壳在 `applicationShell.js:928-992` 的 `_initGlobalContextPanel` 中完成接线。
- 请读 `ui/views/panels/AwarenessPanel.vue`、`AwarenessNames.vue`、`AwarenessDirection.vue`，弄清 `awareness` 视图对象的字段和可触发的动作。

## 任务

### 3.1 运行时补充接线（`lib/globe/runtime.ts`）

- 如果 G2 没有完成 `ContextControls` 和 awareness 的接线（看 G2 报告），本批照 `applicationShell.js:928-992` 补上，让 `useContextStore()` 的 `view` 和 `awareness` 有值。
- 在 `GlobeRuntime` 上暴露：
  - `actions.toggleLayer(id)`
  - `actions.track(record)` / `actions.untrack()`：跟踪与取消跟踪走 `NavigationController` / `LayerBindings` 的现成方法，名称以源码为准，查找线索：`selected-tracker adoption`、`releaseTracking`
  - `actions.flyTo(record)`
  - `actions.contextMode(mode)`：切换 CONTACTS / SPACE MISSIONS，调用 `ContextControls` 的现成方法

  每个 action 上方注释写明对应的 GEV 源码位置。

### 3.2 纯逻辑模块 `lib/globe/layer-panel-model.ts`（可测试）

- `GLOBE_LAYER_GROUPS`：上表的分组。组名用 i18n key `globe.layers.groups.*`；每组列出 id 数组。
- `deriveLayerRow(layer: LayerSummary, deps): LayerRowView`：输入 `dataManager.getAll()` 的一项，输出 `{ id, name, icon, enabled, busy, state, stateLabelKey, count, countText, error, keyRequired, lastUpdate }`。`deps` 注入 `layerFeedState`、`shownLayerName` 等 GEV 函数，这样单元测试可以传入假的实现，不必加载 GEV。
- `groupLayers(all: LayerSummary[]): { groupKey, rows }[]`：
  - 按 `GLOBE_LAYER_GROUPS` 的顺序排列；
  - 未登记的图层且 `showInTogglePanel` 为真的，放进「其它」组；
  - `showInTogglePanel === false` 的不显示。
- 数量格式化：`count >= 10000` 显示为 `1.2万` / `12k`（按语言）；用 `font-mono` 显示。

测试覆盖：各状态的推导、分组排序、隐藏规则、数量格式化。

### 3.3 `app/(app)/globe/components/layer-panel.tsx`

- 位置：左侧浮动面板 `absolute left-3 top-3 bottom-20 w-[300px]`。窄屏（< 768px）时收起为左上角的一个图标按钮，点击后从左侧滑出（用 antd Drawer，`placement="left"`）。
- 外观：`rounded-md border border-slate-700 bg-slate-950/85 text-slate-100`，**不做模糊**。头部是 `SectionHeader`（kicker「DATA LAYERS」，标题为 `t("globe.layers.title")`），右侧放「全部关闭」按钮。按钮的实现参考 GEV 的 `ui/clearLayersControl.js`，调用逻辑移植过来。
- 组标题：`kicker` 风格，可折叠（antd `Collapse`，`ghost`），默认展开有已开启图层的组。
- 行：左侧图标（`layer.icon` 是 emoji 或字符，原样显示），名称；右侧数量（`font-mono text-xs text-slate-400`）+ antd `Switch size="small"`。状态不是「正常」时，名称下方显示一行小字状态，颜色：降级、过期、部分、备用源用 `text-amber-400`，不可用和错误用 `text-rose-400`，加载中用 `text-slate-400` 并配一个小 `Spin`。
- 数据：`useSyncExternalStore` 订阅 `runtime.dataManager.subscribe`，快照为 `getAll()`。注意 `getAll()` 每次返回新数组，要按 `JSON` 签名或版本号缓存，避免无限重渲染。
- 可访问性：每个 Switch 的 `aria-label` 为图层名；整个面板用 `<nav aria-label=…>`。
- 内容区域独立滚动，加 `rail-scrollbar` 类。

### 3.4 `app/(app)/globe/components/target-card.tsx` + `lib/globe/target-format.ts`

**数据来源**：`useGevSelection()`（G2），并合并跟踪型图层的实时更新。跟踪中的飞机，其记录会通过 `refreshTrackedSubjectContext` 更新，相关代码在 `data/contextStore.js:103-120`。可以每 1 秒从 `getContextStore().entities.get(id)` 重读一次，或者找到现成的事件；**不要**每帧都读。

**纯逻辑模块 `target-format.ts`（可测试）**：`formatTarget(record): TargetView`，输出：

- `{ kindKey, title, subtitle, fields: {labelKey, value, mono?}[], links: {labelKey, href}[], position?: {lat, lon, altM?} }`

为下面这些图层写**专用格式化器**。字段名以各图层 `registerEntityContext` / `selectTrackedSubjectContext` 时传入的 metadata 为准，先 grep 各图层的调用点确认：

| 图层 | 至少要显示的字段 |
|---|---|
| flights / military | 呼号、注册号、机型、高度、速度、航向、出发地 / 目的地（有就显示） |
| ais-live-vessels | 船名、MMSI、船型、航速、航向、目的港 |
| satellites | 名称、NORAD 编号、类别、轨道高度 |
| earthquakes | 震级、深度、地点、发生时间（用我们的 `formatTimestamp`） |
| local-firms | 亮温或 FRP、置信度、探测时间、卫星 |
| cctv | 摄像头名称、来源机构、最后一帧时间 |
| newwei-intel | G6 再补 |

其它图层用**通用格式化器**：把 metadata 中的原始类型字段（字符串、数字、布尔）按 key 排序后列出，排除 `entity`、`id`、`layerId`、以 `_` 开头的字段，以及函数和对象，最多 12 项。

**卡片 UI**：

- 位置：右侧浮动 `absolute right-3 top-3 w-[340px] max-h-[calc(100%-6rem)]`。未选中时不渲染。
- 外观与图层面板相同。
- 头部：kicker 为图层名，标题为 `title`（`font-serif text-lg`，这里属于「版面级标题」），右上角有关闭按钮（`aria-label`），点击后调用 `actions.untrack()` 并清除选中。
- 主体：`<dl>`，两列网格，标签用 `text-slate-400 text-xs`，值用 `text-sm`；`mono` 字段加 `font-mono`。
- 操作行：
  - 「跟踪 / 停止跟踪」：只对跟踪型图层显示；
  - 「飞过去」；
  - 「进入驾驶舱」：G5 接入，本批先渲染为 `disabled`，悬停提示「下一版提供」；
  - 「在控制台搜索」：跳转 `/search?q=<title>`，这是我们的特色，3D 目标和情报检索打通；
  - 外部链接：例如 FlightAware、MarineTraffic。只在 metadata 里本来就有 URL 时显示，**不要**自己拼第三方网站地址。

测试：每个专用格式化器给一份样例 metadata，断言输出；通用格式化器的过滤规则；卡片组件（传入模拟的 `TargetView`）能渲染标题和字段，点击关闭会调用回调。

### 3.5 右侧「附近目标」页签

- 详情卡上方有一个 `Segmented`，选项为「目标 / 附近 / 航天任务」。
  - 「附近」显示 `useGevStore(useContextStore(), s => s.awareness)` 的名单：每行包含类型图标、名称、距离（`font-mono`）、方位，点击一行就选中并跟踪它。
  - 「航天任务」显示 `missionRoster` / `mission`，读法照 `MissionRoster.vue` / `MissionDetail.vue`。
  - 进入「附近」或「航天任务」时，调用 `actions.contextMode(...)`。
- 名单为空时显示 `ChartEmptyState`，使用 `presentation="banner"`。
- 用 `useGevStore` 读仓库。

### 3.6 i18n

所有新文案放在 `globe.layers.*` / `globe.target.*` / `globe.context.*` 下，中英各一份。GEV 自己发布的文本（图层名、负责人发布的 awareness 文本）已经由它的 i18n 按 G2 设置的语言翻译好了，**原样显示**，不要重复翻译。

---

## 禁止事项

- 引用 `ui/layerPanel.js`（会间接带进 `.vue`）。分组常量 `PANEL_GROUPS` 需要**抄写**成我们的 TS 版本，在文件头注释写明「移植自 layerPanel.js:41-99」；状态推导等函数直接引用上面列出的 Vue-free 模块。
- 修改 vendor 源码。
- 用毛玻璃、霓虹发光、大圆角。

## 验证与提交

README §6。分两次提交：

- `✨ feat(web): 3D 地球 G3 数据图层面板`
- `✨ feat(web): 3D 地球 G3 目标详情卡与附近目标`

## 留给用户的浏览器冒烟

- 打开航班、卫星、地震三个图层，分组和状态显示正常；
- 点一架飞机：右侧出现详情卡，地球上有标签和轨迹；点「停止跟踪」后相机释放；
- 切到「附近」页签，名单中有飞机，点击会切换目标；
- 窄屏下图层面板收起为按钮。
