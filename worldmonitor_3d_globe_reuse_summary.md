# WorldMonitor 3D Globe (deck.gl + MapLibre) 实现拆解与复用总结

> 目标：梳理 `D:\wei\worldmonitor` 中 3D 地图/图层/聚类/时间过滤/URL 分享的真实实现，给本项目复用提供可落地方案。

## 1. 核心架构（实际代码）

### 1.1 双渲染器架构
- 统一入口是 `MapContainer`，按设备能力自动选择：
  - 桌面/支持 WebGL2：`DeckGLMap`（MapLibre + deck.gl）
  - 移动端/低能力：`Map.ts`（SVG/D3 fallback）
- 关键点：这不是“单组件地图”，而是“能力探测 + 统一 API 代理”。

代码锚点：
- `src/components/MapContainer.ts`
- `src/components/DeckGLMap.ts`
- `src/components/Map.ts`

### 1.2 MapLibre + deck.gl 叠加方式
- 底图：`maplibregl.Map`
- 数据图层：`MapboxOverlay`（`@deck.gl/mapbox`）
- 关键配置：
  - `interleaved: true`（与 MapLibre 共享渲染上下文）
  - `useDevicePixels: window.devicePixelRatio > 2 ? 2 : true`（限制高 DPR 成本）
  - `pickingRadius: 10`（点击容错）

代码锚点：
- `src/components/DeckGLMap.ts`（`initMapLibre()`、`initDeck()`）

### 1.3 “3D globe”在代码里的真实含义
- README 文案写的是 3D globe。
- 实际实现主要是：WebGL + 俯仰/旋转交互（`VITE_MAP_INTERACTION_MODE=flat|3d`），并非显式 `setProjection('globe')`。
- 即：更接近“3D 交互世界地图”而非 MapLibre Globe 投影模式。

代码锚点：
- `src/components/DeckGLMap.ts`（`MAP_INTERACTION_MODE`、`initMapLibre()`）
- `README.md`

## 2. 图层系统（40+ 可切换）

### 2.1 图层状态模型
- `MapLayers` 是单一状态源，当前包含 **44 个 boolean 图层开关**。
- 包括用户提到的军事基地、核设施、海底电缆、AI 数据中心、石油管道、Gulf FDI 等。

代码锚点：
- `src/types/index.ts`（`interface MapLayers`）
- `src/e2e/map-harness.ts`（`allLayersEnabled`）

### 2.2 变体化默认图层
- 默认层不是固定一套，而是按 variant（`full/tech/finance/happy`）选择。
- 并且有移动端默认层（`MOBILE_DEFAULT_MAP_LAYERS`）做性能降载。

代码锚点：
- `src/config/panels.ts`（`FULL_MAP_LAYERS` / `TECH_MAP_LAYERS` / `FINANCE_MAP_LAYERS` / `HAPPY_MAP_LAYERS`）
- `src/App.ts`（启动时装配默认层）

### 2.3 图层构建流水线
- 每次渲染执行 `buildLayers()`：按开关 + zoom + 数据是否存在，动态拼接 deck.gl layers。
- 图层类型覆盖：`GeoJsonLayer`、`ScatterplotLayer`、`PathLayer`、`IconLayer`、`TextLayer`、`ArcLayer`、`HeatmapLayer`、`PolygonLayer`。
- 使用“空幽灵层（ghost layer）”保持 layer id 稳定，减少 interleaved 模式下层结构抖动。

代码锚点：
- `src/components/DeckGLMap.ts`（`buildLayers()`、`createEmptyGhost()`）

## 3. 智能聚类实现

### 3.1 客户端 Supercluster（4类）
- 用 `supercluster` 对高密度点做实时聚类：
  - protests
  - tech HQ
  - tech events
  - datacenters
- 聚类不是只算点数：`map/reduce` 聚合了业务语义字段（如 severity、riotCount、soonCount、totalChips 等）。
- 仅在必要时重算：缓存 `zoom + bounds + layerMask`，不变则直接复用。

代码锚点：
- `src/components/DeckGLMap.ts`
  - `rebuildProtestSupercluster()`
  - `rebuildTechHQSupercluster()`
  - `rebuildTechEventSupercluster()`
  - `rebuildDatacenterSupercluster()`
  - `updateClusterData()`

### 3.2 服务器辅助聚类（军事基地）
- 基地数据走 `fetchMilitaryBases()`：按 bbox + zoom 请求后端返回 bases + clusters。
- 客户端做网格量化缓存（quantized bbox）+ 并发去重（`pendingFetch`）。

代码锚点：
- `src/services/military-bases.ts`
- `src/components/DeckGLMap.ts`（`fetchServerBases()`）

### 3.3 点击聚类懒加载叶子节点
- 点击 cluster 时，如 `items` 为空再调用 `getLeaves()` 补齐明细。
- 通过 `MAX_CLUSTER_LEAVES=200` 控制上限，兼顾信息量与弹窗性能。

代码锚点：
- `src/components/DeckGLMap.ts`（`handleClick()`）

## 4. 8个区域预设

- 预设视角定义在 `VIEW_PRESETS`：
  - `global`, `america`, `mena`, `eu`, `asia`, `latam`, `africa`, `oceania`
- UI 通过 `view-select` 控制，调用 `setView()` -> `map.flyTo()`。

代码锚点：
- `src/components/DeckGLMap.ts`（`VIEW_PRESETS`、`createControls()`、`setView()`）

## 5. 时间过滤（1h–7d）

### 5.1 时间范围模型
- `TimeRange = '1h' | '6h' | '24h' | '48h' | '7d' | 'all'`
- 核心函数：`filterByTime(items, getTime)`，统一做 cutoff 过滤。

### 5.2 过滤生效范围
- 应用于 earthquakes / natural events / weather / outages / cable advisories / flight delays / military flights / vessels / UCDP / news locations 等。
- 抗议聚类会在切换时间范围后重建（`rebuildProtestSupercluster()`）。

代码锚点：
- `src/components/DeckGLMap.ts`（`getTimeRangeMs()`、`filterByTime()`、`setTimeRange()`、`buildLayers()`）
- `src/app/panel-layout.ts`（时间范围同步到新闻面板）

## 6. URL 状态分享实现

### 6.1 URL 编解码模块
- `parseMapUrlState(search, fallbackLayers)`：解析并校验
  - `view`
  - `zoom`
  - `lat/lon`
  - `timeRange`
  - `layers`
  - `country`
- `buildMapUrl(baseUrl, state)`：生成可分享链接。

代码锚点：
- `src/utils/urlState.ts`

### 6.2 启动恢复流程
1. `App` 启动时读取 localStorage 图层
2. 解析 URL state
3. URL 图层可覆盖本地层
4. `PanelLayout.applyInitialUrlState()` 在 map 创建后回放到 map

代码锚点：
- `src/App.ts`
- `src/app/panel-layout.ts`（`applyInitialUrlState()`）

### 6.3 运行时同步流程
- `EventHandlerManager.setupUrlStateSync()` 监听 `map.onStateChanged()`
- 通过 `debounce(250ms)` 执行 `history.replaceState()` 更新 URL
- 复制按钮使用 `getShareUrl()` + clipboard

代码锚点：
- `src/app/event-handlers.ts`

## 7. 60fps 相关性能策略（可复用）

> 这里的 60fps 不是“绝对保证”，而是围绕 16ms 帧预算做的系统化优化。

### 7.1 调度与重绘控制
- `render()` 用 `requestAnimationFrame` 合帧
- `rafSchedule()` 合并高频更新请求
- `debounce()` 控制重建和服务器拉取

### 7.2 图层与数据优化
- `layerCache` + `updateTriggers`，减少 layer 实例重建
- zoom 阈值分层展示（progressive disclosure）
- 低 zoom 时使用 cluster，避免全量点渲染
- `useDevicePixels` 上限 2，降低高分屏 GPU 压力

### 7.3 状态稳定与容错
- `webglcontextlost/restored` 处理
- `renderPaused`（隐藏/空闲时暂停动画）
- 脉冲动画按需启动，且有启动冷却窗口
- `ResizeObserver` + isResizing 控制 resize 抖动
- 开发态输出 `buildLayers/updateLayers >16ms` 日志，方便定位卡顿层

代码锚点：
- `src/components/DeckGLMap.ts`
- `src/utils/index.ts`（`debounce`、`rafSchedule`）

## 8. 复用到本项目的推荐落地拆分

### 8.1 模块拆分建议
1. `MapEngine`：MapLibre 初始化 + Deck Overlay 生命周期
2. `LayerRegistry`：图层 schema（MapLayers）+ layer factory
3. `ClusterService`：Supercluster 实例管理与缓存
4. `TimeFilterService`：统一时间窗过滤
5. `UrlStateCodec`：URL parse/build + 回放
6. `MapStateSync`：`onStateChanged` 与 localStorage/URL 同步

### 8.2 迁移顺序（建议）
1. 先落地图层状态模型（MapLayers）
2. 接入 MapLibre + deck.gl 最小栈（先 3~5 个图层）
3. 加入 `filterByTime` 和 URL 编解码
4. 再接入 Supercluster 与服务端聚类
5. 最后做 16ms 帧预算监控与降载策略

## 9. 复用时必须注意的当前实现“坑点”

1. `urlState` 的 `LAYER_KEYS` 不是 44 全量：
   - 当前缺少 finance/happy/dayNight 等部分图层字段
   - 结果：分享链接不会完整还原所有图层

2. 时间范围变化未直接触发 URL 同步：
   - `setTimeRange()` 触发了渲染与回调，但 URL 同步主要挂在 `onStateChanged`（移动/缩放）
   - 结果：只改时间范围但不移动地图时，URL 可能还是旧的

3. README 的 “3D globe” 与代码实现语义存在差异：
   - 代码核心是 WebGL 叠加 + 3D 交互，不是显式 globe 投影

## 10. 可直接复用的关键设计结论

- 用 **统一 MapLayers 状态模型** 做跨 UI / URL / 存储 的单一事实源。
- 用 **buildLayers + 条件组装** 替代“每层独立生命周期”，可显著降低状态复杂度。
- 把聚类做成 **“语义聚类”（map/reduce）**，不是纯点数聚类。
- 用 **rafSchedule + debounce + layerCache** 作为默认性能底座。
- URL 分享必须做成 **编码器/解码器独立模块**，并在启动与运行时双向同步。

---

如果你要，我可以下一步直接在你当前项目里给出一版“可运行最小实现骨架”：
- `MapLayers` 类型
- `MapView` + `TimeRange` + URL codec
- `MapLibre + DeckOverlay` 初始化
- 2~3 个样例图层（points/path/cluster）
- 同步本项目现有状态管理（例如 Redux/Zustand/React state）

## 11. 基于当前项目状态的复用优化建议（按现仓库落地）

### 11.1 先给结论：采用“渲染器替换优先”，不要先动数据契约
- 你当前项目已经有可复用底座，不建议推倒重来：
  - 前端 `WarMap` 已有按时间范围请求数据 + 图层开关 + 懒加载能力（`apps/web/app/(app)/dashboard/charts/war-map.tsx`）。
  - 图层状态已标准化为 `WarMapLayerVisibility`（`apps/web/store/war-map-settings.ts`）。
  - 用户设置已有“本地缓存 + 远端同步 + 回写防抖”完整链路（`apps/web/app/(app)/components/user-ui-settings-sync.tsx`）。
  - 后端已稳定提供 `war-map` 四类接口（`apps/api/src/modules/dashboard/dashboard.controller.ts`）。
- 因此最佳路径是：
  1. 先新增 deck.gl + MapLibre 渲染器并挂在同一数据源下；
  2. 再逐步扩展图层模型、URL 分享、聚类与性能治理；
  3. 最后将 ECharts 作为 fallback/灰度兜底。

### 11.2 现状差距与优先级

| 维度 | 当前项目（/mnt/d/wei） | 目标能力（WorldMonitor 复用） | 优先级 |
|---|---|---|---|
| 渲染引擎 | ECharts `geo + scatter/custom` | MapLibre + deck.gl（interleaved） | P0 |
| 图层规模 | 7 个可切换层（hotspots/conflict 等） | 40+ 层、按 zoom/time 条件组装 | P1 |
| 视角预设 | 暂无区域预设 | 8 个区域预设（global/mena/eu/asia 等） | P1 |
| 时间过滤 | 依赖全局 `start/end` 区间查询 | 前端补充 `1h/6h/24h/48h/7d/all` 快速过滤 | P1 |
| URL 分享 | 暂无 war-map URL 状态回放 | `view + zoom + center + timeRange + layers` 双向同步 | P2 |
| 聚类 | 无 supercluster | 客户端语义聚类 + 可选服务端 bbox 聚类 | P2 |
| 性能治理 | 动态加载 + IntersectionObserver 已有 | 帧预算监控 + DPR 限制 + layer cache | P3 |

### 11.3 分阶段迁移（建议按 4 个里程碑）

#### P0（1-2 天）：并行渲染架构与开关
1. 新增渲染器开关（环境变量或用户开关）：
   - `NEXT_PUBLIC_WAR_MAP_RENDERER=echarts|deckgl`
2. 保持现有查询 key 与接口不变：
   - `dashboard/war-map/geojson`
   - `dashboard/war-map/events`
   - `dashboard/war-map/news-markers`
   - `dashboard/war-map/layers`
3. 抽出 `WarMapDataAdapter`（仅做数据标准化），让 ECharts 与 deck.gl 共用同一份数据。

交付标准：
- 切换开关后可在两套渲染器间无刷新切换；
- 现有图层开关与统计标签行为不回归。

#### P1（3-5 天）：最小可用 deck.gl 地图
1. 前端引入依赖（当前 `apps/web/package.json` 尚无这些包）：
   - `maplibre-gl`
   - `deck.gl` / `@deck.gl/layers` / `@deck.gl/mapbox`
   - `supercluster`
2. 新增 `war-map-deckgl` 组件，先接入 4 类层：
   - `events`（ScatterplotLayer）
   - `news-markers`（ScatterplotLayer）
   - `conflict-zones`（Polygon/GeoJsonLayer）
   - `strategic-points`（Icon/Text/Scatter）
3. 复用当前 Zustand 图层状态：
   - 继续使用 `useWarMapSettingsStore`，保证 UI 与用户设置同步链路不变。
4. 增加 8 个区域预设（以 `flyTo` 改视角）。

交付标准：
- deck.gl 模式下功能覆盖当前 ECharts 主要可视能力；
- 图层开关、时间窗查询、翻译文案显示与现状一致。

#### P2（4-7 天）：URL 状态分享 + 时间快捷过滤 + 聚类
1. 增加 `UrlStateCodec`：
   - 解析/构建字段：`lat/lon/zoom/bearing/pitch/layers/timeRange/preset`
   - 启动回放 + 运行时 debounce 同步（`router.replace`）。
2. 增加 WarMap 本地时间快捷过滤：
   - 在现有 `start/end` 查询基础上，叠加 `1h/6h/24h/48h/7d/all` 前端过滤。
3. 接入 supercluster：
   - 先对 `events/news-markers` 聚类；
   - 使用 map/reduce 聚合业务字段（severity、newsCount、alertScore）。

交付标准：
- 复制 URL 在新窗口可恢复视角、图层、时间筛选；
- 低缩放层级下数据点显著减少，交互稳定。

#### P3（3-5 天）：性能治理与灰度收敛
1. 性能策略落地：
   - 限制高 DPR（例如 `useDevicePixels <= 2`）
   - `requestAnimationFrame` 合帧
   - layer 实例缓存 + `updateTriggers`
2. 灰度策略：
   - 默认保留 ECharts fallback
   - 通过组织/用户白名单切换 deck.gl
3. 监控：
   - 记录 `buildLayers` 耗时、可见点数、失败率、回退率。

交付标准：
- 中高密度场景（数千点）交互无明显卡顿；
- 任意渲染失败可一键回退 ECharts。

### 11.4 接口演进建议（兼容优先）

保持现有端点不变，增量扩展字段，避免前后端一次性大改：

1. `GET /dashboard/war-map/layers`
   - 保留当前字段；
   - 增加可选 `renderHints`（symbol/minZoom/maxZoom/pickable）。
2. `GET /dashboard/war-map/events`、`news-markers`
   - 增加可选聚类参数：`bbox`、`zoom`、`cluster=1`（后续可启用服务端聚类）。
3. `PUT /user-settings/ui/war-map`
   - `settings` 从仅 `layerVisibility` 逐步扩为：`layerVisibility`、`viewState`（center/zoom/pitch/bearing）、`timeRangePreset`、`activePreset`。

这样可以复用当前 `normalizeWarMapSettings()` 机制平滑兼容旧数据。

### 11.5 状态与存储建议（复用你现有同步链路）

1. 保留当前 store，不要重命名：
   - `useWarMapSettingsStore`
   - `useUserUiSyncStatusStore`
2. 在 `WarMapSettings` 里扩展字段，而不是新建一套平行状态：
   - 复用 `user-ui-settings-sync.tsx` 现有防抖/指纹/迁移逻辑。
3. 先在前端完成字段扩展，再在后端 `user-settings.service.ts` 做 normalize 默认值兜底。

### 11.6 文件级落地映射（建议）

| 现有文件 | 建议动作 | 目标文件 |
|---|---|---|
| `apps/web/app/(app)/dashboard/charts/war-map.tsx` | 拆为容器 + 双渲染器 | `war-map/index.tsx`、`war-map/war-map-echarts.tsx`、`war-map/war-map-deckgl.tsx` |
| `apps/web/store/war-map-settings.ts` | 扩展 `viewState/timeRangePreset/activePreset` | 原文件增量演进 |
| `apps/web/app/(app)/components/user-ui-settings-sync.tsx` | 扩展 `fingerprintWarMapSettings` 与 PUT payload | 原文件增量演进 |
| `apps/api/src/modules/dashboard/dashboard.controller.ts` | 增加可选查询参数（bbox/zoom/cluster） | 原文件增量演进 |
| `apps/api/src/modules/dashboard/dashboard-charts.service.ts` | 增加聚类分支与 geometry/render hints | 原文件增量演进 |
| `apps/api/src/modules/user-settings/user-settings.service.ts` | 扩展 `normalizeWarMapSettings` | 原文件增量演进 |
| `apps/api/src/modules/user-settings/dto/war-map-ui-settings.dto.ts` | 对新增字段做校验（可分阶段） | 原文件增量演进 |

### 11.7 测试与验收建议（避免迁移后“看起来能用，实则回归”）

1. 单测（web）
   - `war-map-settings`：新字段默认值、hydrate 兼容旧 payload。
   - `url-state-codec`：parse/build 可逆。
2. 单测（api）
   - `normalizeWarMapSettings`：旧版仅 layerVisibility 输入仍可读写。
3. E2E（最关键）
   - 切换图层 + 调整视角 + 时间过滤 -> 复制 URL -> 新页面恢复一致。
4. 性能基线
   - 记录首屏可交互时间、缩放/拖拽卡顿率、聚类切换耗时。

### 11.8 风险与回滚策略

1. 风险：WebGL 兼容性、内存占用、图层过多导致拾取与重绘开销过高。
2. 缓解：
   - 保留 ECharts 渲染器并可随时切回；
   - deck.gl 首期只开放核心层（不要一次上 40+）。
3. 回滚：
   - 任何异常时将渲染器切回 `echarts`，数据接口和用户设置格式保持兼容，不影响业务可用性。

## 12. 可直接执行的下一步（建议）

1. 先做 P0：把 `WarMap` 拆成“数据容器 + ECharts/DeckGL 双渲染器”。
2. 同步扩展 `WarMapSettings`（先加 `viewState`），并接入现有 `user-ui-settings-sync` 链路。
3. 再做 P1 的最小 4 层 deck.gl 骨架，确保功能对齐后再扩到 40+ 图层。

## 13. 可直接创建 Issue 的执行清单（按你当前仓库）

| ID | 任务 | 主要改动文件 | 预估 |
|---|---|---|---|
| WM-P0-01 | 拆分 `WarMap` 为容器 + 渲染器接口 | `apps/web/app/(app)/dashboard/charts/war-map.tsx` -> `war-map/index.tsx` | 0.5 天 |
| WM-P0-02 | 新增渲染器选择开关（env + UI） | `apps/web/app/(app)/dashboard/charts/war-map/index.tsx` | 0.5 天 |
| WM-P0-03 | 抽 `WarMapDataAdapter`（events/news/layers 统一结构） | `apps/web/app/(app)/dashboard/charts/war-map/data-adapter.ts` | 1 天 |
| WM-P1-01 | 新增 deck.gl + MapLibre 基础渲染器 | `apps/web/app/(app)/dashboard/charts/war-map/war-map-deckgl.tsx` | 1.5 天 |
| WM-P1-02 | 迁移首批 4 层（events/news/conflict/strategic） | `war-map-deckgl.tsx` + `layers/*.ts` | 1.5 天 |
| WM-P1-03 | 新增 8 区域预设 | `apps/web/app/(app)/dashboard/charts/war-map/view-presets.ts` | 0.5 天 |
| WM-P2-01 | URL 编解码器（parse/build + 回放） | `apps/web/lib/war-map-url-state.ts` | 1 天 |
| WM-P2-02 | store 增加 `viewState/timeRangePreset/activePreset` | `apps/web/store/war-map-settings.ts` | 0.5 天 |
| WM-P2-03 | 用户设置同步扩展（fingerprint + PUT payload） | `apps/web/app/(app)/components/user-ui-settings-sync.tsx` | 0.5 天 |
| WM-P2-04 | events/news 聚类（supercluster） | `apps/web/app/(app)/dashboard/charts/war-map/cluster-service.ts` | 1 天 |
| WM-P3-01 | API 增加可选 `bbox/zoom/cluster` 查询参数 | `apps/api/src/modules/dashboard/dto/dashboard-charts.dto.ts` + `dashboard.controller.ts` | 0.5 天 |
| WM-P3-02 | API 聚类/geometry hints 分支（兼容返回） | `apps/api/src/modules/dashboard/dashboard-charts.service.ts` | 1-2 天 |
| WM-P3-03 | 后端 `WarMapSettings` normalize 扩展 | `apps/api/src/modules/user-settings/user-settings.service.ts` | 0.5 天 |
| WM-P3-04 | 回归测试与灰度开关收口 | web/api 测试文件 + env 文档 | 1 天 |

建议依赖顺序：
1. `WM-P0-*` -> `WM-P1-*`
2. `WM-P2-01~03` 与 `WM-P2-04` 可并行
3. `WM-P3-*` 在前端路径跑通后再落

## 14. URL 状态协议草案（复用目标）

建议统一为可读 query，便于排障与手改：

`/dashboard/map?lat=20.12&lon=105.31&zoom=2.6&bearing=8&pitch=35&preset=asia&tr=24h&layers=hotspots,conflictZones,monitors`

字段建议：
1. `lat/lon/zoom/bearing/pitch`
2. `preset`：`global|america|mena|eu|asia|latam|africa|oceania`
3. `tr`：`1h|6h|24h|48h|7d|all`
4. `layers`：仅存 `true` 的 layer id 列表
5. `renderer`（可选）：`echarts|deckgl`（调试/灰度有用）

优先级规则（建议）：
1. URL 参数
2. 远端用户设置（`user-settings/ui/war-map`）
3. 本地默认值

同步节奏（建议）：
1. 视角变化：`debounce 250ms`
2. 图层开关变化：`debounce 150ms`
3. 时间范围变化：立即写 URL（避免“仅改时间但 URL 不变”）

## 15. DeckGL 层映射（从当前 API 到新渲染器）

| 数据源 | 当前字段 | Deck 层建议 | 说明 |
|---|---|---|---|
| `events` | `lat/lng/derivedScore/severity` | `ScatterplotLayer` | 半径按 `derivedScore`，颜色按 `severity` |
| `news-markers` | `lat/lng/geoSource/url` | `ScatterplotLayer` | `fallback-country` 降低透明度 |
| `conflictZones` | `coords/color` | `PolygonLayer` 或 `GeoJsonLayer` | 支持填充 + 边界描边 |
| `hotspots` | `lat/lng/level` | `ScatterplotLayer + TextLayer` | `level` 决定 size |
| `strategic points` | `chokepoints/cable/nuclear/military` | `IconLayer` | icon atlas 或 unicode symbol |
| `monitors` | 本地 store location | `ScatterplotLayer` | 保持点击跳转搜索逻辑 |

## 16. 上线前质量闸门（建议）

功能闸门：
1. 图层开关、tooltip、点击跳转、翻译覆盖率统计与旧版一致。
2. URL 分享可跨浏览器恢复（至少 Chrome + Edge）。
3. 用户设置升级后，旧 `layerVisibility` 数据无丢失。

性能闸门：
1. 默认数据量下，拖拽/缩放体感无明显卡顿。
2. 高密度数据（>2000 points）下，聚类开启后交互稳定。
3. 首次进入地图不阻塞主线程明显超时（通过动态加载保底）。

稳定性闸门：
1. WebGL 初始化失败自动回退 ECharts。
2. API 聚类参数缺失时返回兼容旧结构，不影响旧前端。
3. 监控可区分 `renderer=deckgl` 与 `renderer=echarts` 的错误率。

## 17. 范围控制（防止一次性过大改造）

第一阶段明确不做：
1. 不一次迁移 40+ 图层，先保证 4-8 个核心层。
2. 不先改数据库模型，优先沿用现有 REST 契约增量扩展。
3. 不删除 ECharts 路径，至少保留一个发布周期作为兜底。

这样可以把复用任务从“高风险重构”变成“可灰度、可回退、可度量”的工程迭代。
