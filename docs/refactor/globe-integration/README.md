# 3D 地球融合（gods-eye-view 引擎 + 我们的 React 界面）

> 本目录是给编码模型执行的分批提示词。**先完整读完本 README，再读你负责的批次文件。**

## 1. 背景与目标

用户看中了开源项目 [gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view)（下称 **GEV**，MIT 许可）：照片级 3D 地球（Cesium + Google Photorealistic 3D Tiles），上面实时显示航班、船舶、卫星、地震、山火、天气、公开摄像头，并且可以切换夜视、热成像等滤镜。

**目标**：把 GEV 的**地球引擎和数据图层**接进我们的 Next 控制台，新增页面 `/globe`。GEV 原来的 Vue 界面**不搬过来**，而是参照它的操作逻辑**用 React 重写**，做成我们自己的风格，并加上我们的特色：情报上图，以及后续的 AI 助手、地图建告警、事件时间轴。

**与用户确认过的决定**

| 项 | 决定 |
|---|---|
| 代码放置 | GEV 源码以**快照方式拷进仓库**：`vendor/gods-eye-view/`，记录上游 commit，升级靠脚本 |
| 界面 | 不复用 GEV 的 Vue 视图；用 React 重写界面，引擎复用 |
| 使用性质 | 个人 / 内部研究，**非商用**（可以保留 OpenSky、海缆等非商用数据） |
| 密钥 | 有 Google Maps 密钥、AISStream、OpenSky；**没有 OpenAI，语音功能不做** |
| 第一版范围 | 图层面板 + 目标详情卡（含跟踪）、搜索飞行 + 底图切换 + 视觉滤镜、HUD 读数 + 驾驶舱、我们的情报上图 |
| 验证方式 | **纯静态代码审查 + CI**，暂不在本机启动；浏览器冒烟由用户以后执行 |

上游锁定版本：`43a67f9ae224e7a1d6d32d81f690520f5c7f7f70`（2026-11-02）。

## 2. GEV 的结构（已读源码核实，是本方案的依据）

GEV 分三层：

1. **引擎层**（纯 JS + Cesium）：地球、底图栈、数据图层、选中目标、相机导航、视觉滤镜。**复用。**
2. **界面层**（`src/ui/**`，Vue 3 + Pinia）：
   - 「负责人」模块把要显示的内容整理成普通对象，交给 Pinia 仓库，再由 Vue 组件渲染；
   - 但它的总外壳 `src/ui/applicationShell.js`（1862 行）通过 `readShellElements()` 按 id 抓取约 60 个固定的 DOM 元素来挂事件，和 Vue 视图深度耦合。

   **不复用，用 React 重写。**
3. **服务端**（`server/providers/**`）：以 Vite 中间件形式运行的数据代理，持有各家服务的 API 密钥，暴露 `/api/flights`、`/api/celestrak` 等约 30 个路径。**原样作为旁车服务运行**，浏览器通过 Next 的 rewrites 访问它。

### 2.1 引擎模块白名单 / 黑名单（关键！）

我们的 Next 构建**不能编译 `.vue` 文件**。下表是逐个顺着 import 链追踪的结果：

| ✅ 可以引用（不会间接碰到 `.vue`） | ❌ 禁止引用（会间接带进 `.vue`，构建必挂） |
|---|---|
| `app/scene.js`（`createApplicationScene`） | `app/application.js`（→ `ui/views/*.vue`） |
| `standalone/catalog.js`（`createStandaloneCatalog`） | `app/data.js`（→ `ui/layers.js` → `WeatherReadout.vue`） |
| `services/requests.js`（`createApplicationRequestServices`） | `app/controls.js`、`ui/composition.js`（StyleManager） |
| `data/lifecycle.js`（`LayerLifecycle`） | |
| `data/contextStore.js` | `ui/applicationShell.js` 及 `src/ui/views/**`、`ui/layerPanel.js`（→ `LayerRows.vue`） |
| `ui/visualEffects.js`、`ui/visualPresets.js`（滤镜） | 任何 `src/ui/stores/*` 之外的 `src/ui/*.vue` 及引用它们的模块 |
| `ui/navigationController.js` | `src/main.js`、`src/standalone/application.js` |
| `locations.js`（`flyToGlobeView`、`searchAndFlyTo` 等） | |
| `overlays/worldOverlay.js`、`data/detection.js`、`data/trackedReadout.js` | |
| `data/localGeojsonCore.js`（`createLocalGeoJsonLayer`）、`app/localGeojsonServices.js` | |
| `search/index.js`、`standalone/placeSearch.js`、`cityPois.js`、`orbit.js`、`cockpitMath.js`、`maps/controller.js` | |
| `ui/cockpitController.js`（会操作 DOM，见 G5） | |
| 负责人：`ui/visualSettings.js`、`ui/layerBindings.js`、`ui/context.js`、`ui/locationNavigation.js`、`ui/cockpitCoordinator.js` | |
| 全部 `ui/stores/*.js`（Pinia 仓库）、`ui/vueRuntime.js` 中的 `applicationPinia` | |
| `data/feedState.js`（`layerFeedState`）、`ui/layerNames.js`、`ui/keyGuidance.js`、`ui/statusText.js` | |
| `i18n/index.js` | |
| `hud.js`（`IntelHUD`）：**打完 G5 的一行补丁后**可以引用，整条依赖链不碰 `.vue` | |

**每个批次新增 GEV 引用后，都必须用 G0 提供的脚本 `pnpm --filter @modular/web globe:check-imports` 检查**（该脚本从我们引用的 GEV 入口出发追踪 import 图，一旦碰到 `.vue` 就失败）。CI 也会运行它。

### 2.2 引擎与 React 的对接点

| 想知道 / 想做的事 | 用什么 |
|---|---|
| 图层列表、开关状态、数量、是否新鲜 | `dataManager.getAll()` + `dataManager.subscribe(cb)`（`LayerLifecycle`） |
| 开关图层 | `dataManager.toggle(layerId, { origin: 'user' })`（具体参数以源码为准） |
| 选中了什么 | 监听 window 事件：`gev:entity-selected`（`detail` 是上下文记录）、`gev:awareness-subject-selected`（飞机等跟踪型图层）、`gev:entity-selection-cleared` |
| 底图切换 | `mapStackController.setStack(id)` + window 事件 `gev:map-stack-changed` |
| 视觉滤镜 | `VisualEffects` + `STYLES` 预设；GEV 会广播 `gev:style-change` / `gev:vision-change` |
| 驾驶舱状态 | `gev:cockpit-mode-changed` |
| 相机 | `viewer.camera.changed` / `viewer.scene.postRender`（HUD 读数），`locations.js` 的飞行函数 |

React 侧统一用 `useSyncExternalStore` 订阅，**不要**在 React 里引入 Vue 或 Pinia 的响应式 API。

## 3. 总体架构

```
浏览器 /globe（我们的 React 页面，.dark 夜班风格）
  ├─ <div id="cesiumContainer">  ← GEV 引擎（来自 vendor 源码，经 webpack 别名 @gev/* 引入）
  ├─ React 面板：图层 / 详情卡 / 命令坞 / HUD / 驾驶舱仪表
  └─ fetch /api/flights、/api/celestrak、/models/...  ──Next rewrites──►  globe-sidecar（GEV 服务端，127.0.0.1:4173）
                                                                               └─ 持有 Google 服务端密钥、AISStream、OpenSky
  情报图层：apiClient（带登录态）→ api-go /api/dashboard/war-map/events、news-markers → 转成 GeoJSONL Blob → GEV 图层工厂
```

## 4. 批次与依赖

| 批次 | 文件 | 内容 | 依赖 |
|---|---|---|---|
| G0 | [G0-vendor-build.md](G0-vendor-build.md) | 引入 vendor 快照、依赖、Next 构建配置（别名、Cesium 静态资源）、import 白名单检查脚本、CI | — |
| G1 | [G1-sidecar-proxy.md](G1-sidecar-proxy.md) | GEV 服务端作为旁车：compose 服务、开发脚本、Next rewrites、环境变量 | G0 |
| G2 | [G2-engine-runtime.md](G2-engine-runtime.md) | **地基**：无界面的引擎运行时 + React 桥接 hooks + 最小 `/globe` 页面 | G0、G1 |
| G3 | [G3-layers-and-context.md](G3-layers-and-context.md) | 左侧图层面板 + 右侧目标详情卡（含跟踪） | G2 |
| G4 | [G4-command-dock.md](G4-command-dock.md) | 底部命令坞：搜索飞行、底图切换、视觉滤镜、回到地球、快捷键 | G2 |
| G5 | [G5-hud-cockpit.md](G5-hud-cockpit.md) | HUD 读数层 + 驾驶舱 | G3 |
| G6 | [G6-intel-overlay.md](G6-intel-overlay.md) | 我们的情报上图 + 「在 3D 地球查看」入口 | G3 |
| G6B | [G6B-intel-link-fixes.md](G6B-intel-link-fixes.md) | 审查补丁：地区态势链接、新闻打开原文、深链 focus 白名单 | G6 |

```
G0 → G1 → G2 → ┬ G3 → ┬ G5
               │      └ G6
               └ G4（可与 G3 并行，文件不相交）
```

**第一版之后的规划**（本目录暂不写提示词，见 §8）：AI 助手问区域、地图上建告警、事件时间轴，以及第二阶段「地震 / 山火 / 卫星 / 天气 / 摄像头数据进入我们的后端，供告警、事件关联、态势面板使用」。

## 5. 通用硬约束（所有批次）

1. **不改 GEV 的逻辑**，除非批次文件明确要求打补丁。每个补丁都必须登记到 `vendor/gods-eye-view/UPSTREAM.md` 的「本地补丁」表：文件、目的、改动摘要。
2. **只引用 §2.1 白名单里的 GEV 模块**；新增引用后运行 `globe:check-imports`。
3. **GEV 的所有 JS 只能在客户端运行**：`/globe` 的引擎组件必须用 `next/dynamic(() => import(...), { ssr: false })` 加载，任何 `@gev/*` 的 import 都不能出现在服务端组件或会被 SSR 求值的模块里（Cesium 会访问 `window`）。
4. **密钥**：
   - Google 的浏览器端密钥 `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` 是唯一会发到浏览器的密钥，要在 Google Cloud 控制台按 HTTP referrer 限制，并在 README 注明；
   - 其它密钥（服务端 Google 密钥、AISStream、OpenSky）只放在旁车服务里；
   - **不代理** `/api/setup`、`/api/openai`、`/api/gemini`、`/api/realtime`。
5. **界面风格**：
   - `/globe` 页面整体是「夜班模式」：页面根容器加 `dark` 类，并且 antd 区域用嵌套的 `ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}`；
   - 面板沿用我们的设计原语（`SectionHeader`、`ChartEmptyState`、`kicker`、`font-mono` 数字、发丝线），浮在地球上的面板用 `bg-slate-950/80` 加 `border-slate-700`，不做毛玻璃，不加霓虹发光；
   - 颜色只用 token 和已映射的 Tailwind 色阶（见 `docs/refactor/frontend-ui-polish/README.md` §3、§3.5）。
6. **i18n**：新增文案一律 `t()`，同时写 `lib/locales/zh.json` 与 `en.json`（只追加），key 放在 `globe.*` 下。GEV 自身的 i18n（`src/i18n/index.js`）要按我们的当前语言设置为 `zh-CN` / `en`（G2 负责）。
7. **测试**：
   - Cesium 在 jsdom 里无法运行，所以引擎不测；
   - 测**纯逻辑**（桥接 hooks 的状态归并、格式化函数、事件到视图模型的转换）和**不依赖引擎的 React 组件**（给它们传模拟的视图模型）；
   - 引擎通过一个接口注入，测试里换成模拟对象；
   - 不写源码文本测试或快照测试。新文件加入 `vitest.config.ts` 的 `coverage.include`。
8. **不新增本批以外的依赖**；G0 统一添加依赖。添加依赖会改 lockfile，G0 需要运行一次 `pnpm install`，**用户已知悉此例外**。
9. **提交**：中文 emoji + `type(scope)`，例如 `✨ feat(web): 3D 地球 G3 图层面板`。只提交本批文件，不 amend、不 rebase、不 force-push。

## 6. 统一验证流程

```bash
pnpm --filter @modular/web lint
pnpm --filter @modular/web typecheck
pnpm --filter @modular/web test -- --coverage
pnpm --filter @modular/web globe:check-imports
pnpm --filter @modular/web build   # 确认 Cesium 和 GEV 能被 webpack 打包
```

如果本机没有准备好依赖，就做静态自查，并以 CI 结果为准（`gh run view <id> --json conclusion`，不要信 `gh run watch` 的退出码）。

## 7. 报告格式（每批完成后输出）

```markdown
## 3D 地球 Gn 执行报告
- 改动文件：…
- 新增 GEV 引用：…（已通过 globe:check-imports）
- vendor 补丁：…（已登记 UPSTREAM.md）/ 无
- 任务完成情况：逐项 ✅ / ⚠️（原因）
- 与提示词不一致之处及理由：…
- 留给用户的浏览器冒烟清单：…
```

## 8. 第一版之后的规划（暂不执行）

| 特色 | 要点 |
|---|---|
| AI 助手问区域 | 在地球上框选区域，把区域边界、可见图层统计、区域内的新闻事件交给我们现有的助手（`/assistant` 的后端），回答显示在右侧面板 |
| 地图上建告警 | 框选区域后生成告警规则草稿（区域 + 图层类型 + 阈值），跳到告警规则编辑器确认 |
| 事件时间轴 | 底部时间轴控制情报图层的时间窗口，可以播放；GEV 天气图层自带的时间轴可以参考 |
| 地球观测数据进后端 | Go 端采集 USGS 地震、NASA FIRMS 山火、CelesTrak 卫星、NOAA 风暴、公开摄像头目录，供告警、事件关联、态势面板使用（之前的规划草稿见 `/Users/oo/.claude/plans/luminous-imagining-widget.md`，执行前重新审查） |

## 9. 合规（保持）

- 保留 `vendor/gods-eye-view/` 下的 `LICENSE`、`THIRD_PARTY_NOTICES.md`、`DATA_SOURCES.md`、`public/models/README.md`。
- 地球右下角的数据署名区域（`#cesium-credits`）**不能被面板遮挡**，面板布局要避开它。
- 非商用数据：海缆（CC BY-NC-SA）、Bhote Koshi 洪水场景（CC BY-NC）、OpenSky（非商用研究许可）。以后如果转商用，必须移除这些数据。
- 摄像头：FL511 仅限个人使用；NYC 需要签协议，默认不开。
