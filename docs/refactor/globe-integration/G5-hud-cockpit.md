# 3D 地球 G5：HUD 读数层 + 驾驶舱

> **一句话目标**：
> - 复用 GEV 的 `IntelHUD`：它的读数包括坐标、MGRS、高度、地面分辨率、离天底角、时间戳、模式、分类标签。HUD 只负责计算，并把读数发布到 `hud` 仓库，React 负责绘制成我们的 HUD 角标；
> - 复用 GEV 的 `CockpitCoordinator` / `CockpitViewController`：跟踪一架飞机时可以「进入驾驶舱」，相机跟着飞机飞，React 绘制仪表（速度、高度、航向罗盘、呼号、视觉模式切换）。
>
> **依赖**：G3 已合入（详情卡上的「进入驾驶舱」按钮在 G3 中先置为 disabled）。
>
> **开工前必读**：README 全文；G2、G3 的报告；下面列出的 GEV 源码。

## 已核实的关键事实

1. **`hud.js` 现在引用不了**：它的第 41 行 `import { localizeLayerName } from './ui/layerPanel.js'` 会间接带进 `LayerRows.vue`。但 `localizeLayerName` 本来就定义在 `ui/layerNames.js:73`，`layerPanel.js:12` 只是转手导出。所以**只需改一行 import**，行为完全不变（见 5.1）。改完后 `hud.js` 整条依赖链都不碰 Vue（已验证）。
2. **`IntelHUD` 的构造**（`hud.js:171-200`）：`new IntelHUD(viewer, { placeSearch, summaryPolicy, basemapContext, summaryService, publish })`。外壳在 `applicationShell.js:352` 附近创建它，`publish` 写到 `useHudStore()`。`summaryService` 默认是 `applicationServices.summary`，会调用 OpenAI 生成 HUD 摘要；我们没有 OpenAI，所以传一个永远返回 `null` 的假服务。具体形状以 `services/application.js` 为准。
3. **驾驶舱的内容全部由仓库驱动**：
   - `ui/views/CockpitView.vue` 读取 `useCockpitStore()` 的 `instruments`、`presence`、`vision`、`brief`、`context`、`signals`、`route`、`utilityLayout`；
   - `CockpitViewController` 不往 DOM 写任何文字（`textContent`、`classList` 等的写入次数为 0），它**只按 id 查找元素并绑定点击等事件**（`ui/cockpitController.js:99-140`）。
4. **创建时机**：`CockpitViewController` 是在 `CockpitCoordinator` 的构造函数里（`ui/cockpitCoordinator.js:56`）创建的。所以**在创建 `CockpitCoordinator` 之前，页面上必须已经有那些 id 的元素**。

## 任务

### 5.1 vendor 补丁（唯一一处）

`vendor/gods-eye-view/src/hud.js:41`：

```diff
- import { localizeLayerName } from './ui/layerPanel.js';
+ import { localizeLayerName } from './ui/layerNames.js';
```

- 在 `UPSTREAM.md` 的「本地补丁」表登记：文件、目的「让 HUD 可以脱离 Vue 视图单独使用」、摘要「改为从定义处引入，行为不变」、批次 G5。
- 从 G0 的 `globe-check-imports.mjs` 黑名单中移除 `hud.js`，并在 README §2.1 中把 `hud.js` 移到白名单（README 已写明「打完 G5 补丁后可以引用」，同步改表格即可）。
- 运行 `globe:check-imports` 确认通过。

### 5.2 HUD

**运行时（`runtime.ts` 追加）**：

- 照 `applicationShell.js:340-357` 创建 `IntelHUD`：`publish: (view) => useHudStore(pinia).publish(view)`，`placeSearch` 用 G4 创建的那个实例，`summaryService` 传假服务。
- `defer(() => hud.destroy())`。
- 外壳在切换风格时会通知 HUD（`setStyle` / 自动显隐，查找 `this.hud.` 的调用点），照着接到 G4 的 `setStyle` action 上。
- `actions.toggleHud()` 调用 HUD 的显隐方法（名称以源码为准）。
- 监听 G4 预留的 `globe:toggle-hud` 事件，转调 `toggleHud`。

**React（`app/(app)/globe/components/intel-hud.tsx`）**：

- 数据来自 `useGevStore(useHudStore(), s => s.hud)`。字段以 `ui/views/IntelHudView.vue` 为准：`latlon`、`mgrs`、`alt`、`gsd`、`ona`、`orbital`、`mode`、`classification`、`system`、`timestamp`、`summary`、`summaryLabel`、`vessel`、`coll`、`bottom`、`line` 等。逐个确认哪些可能为空。
- 布局：四角角标，`pointer-events-none`。整个 HUD 层位于地球之上、面板之下：
  - 左上：`classification`（`kicker`，`text-amber-400`）+ `system`；
  - 右上：`timestamp`（UTC，`font-mono`）+ `mode`；
  - 左下：`latlon`、`mgrs`（`font-mono`）；
  - 右下：`alt`、`gsd`、`ona`（`font-mono`）。**必须让出右下角的数据署名位置**，HUD 右下角块整体上移 32px。
- 风格：`font-mono text-[11px] uppercase tracking-wider text-slate-200`，加细细的角线（1px `border-slate-500` 的 L 形框）。**不要**霓虹发光、扫描线动画。
- HUD 不可见时（仓库的 `hud` 为 `null` 或可见标记为假）不渲染。
- 纯净视图（G4 的 `V`）时也不渲染。

### 5.3 驾驶舱

**React DOM 骨架（`app/(app)/globe/components/cockpit-dom-contract.tsx`）**：

- 先读 `ui/cockpitController.js:95-145`，列出它查找的**所有** id 和 `data-*` 选择器，包括 `cockpit-entry`、`tr3b-toggle`、`map-view-switch`、`cockpit-hud`、`cockpit-vision-previous/current/next`、`cockpit-context*`、`cockpit-weather-toggle`、`cockpit-signal-*`、`cockpit-brief-*`、`[data-cockpit-brief-index]`。再对照 `CockpitView.vue` 确认每个元素的标签类型（`button` / `section` / `div`）和必需的属性。
- 用 React 渲染这些元素，id 与原来**完全一致**。它们由 React 渲染，但**事件交给 GEV 绑定**，React 不在这些元素上加 `onClick`。只有 `cockpit-hud` 外层用 `hidden={!active}` 控制显隐。
- 这个组件在 `/globe` 页面里**始终挂载**（不在驾驶舱时元素存在但隐藏）。挂载后调用 `runtime.actions.attachCockpit()`，卸载时调用返回的清理函数。
- **注意**：G3 详情卡上的「进入驾驶舱」按钮**不能**再用 `id="cockpit-entry"`，因为同一个 id 不能出现两次。骨架里的 `#cockpit-entry` 才是 GEV 绑定的入口。详情卡按钮的点击改为调用 `document.getElementById("cockpit-entry")?.click()`，或者如果 coordinator 有现成的进入方法，就调用那个方法（优先选这个，查 `ui/cockpitCoordinator.js`）。

**运行时 `actions.attachCockpit()`（`runtime.ts` 追加）**：

- 照 `applicationShell.js:358-420` 创建 `CockpitCoordinator`：
  - `services` 中的每一项（`cachedGroundFloor`、`warmGroundFloor`、`fetchRegionalBrief`、`regionalDistanceM`、`weatherCodeLabel` 等）在 `ui/composition.js` 里能找到来源模块。**不要 import `composition.js`**（黑名单），而是直接 import 这些来源模块，并逐个用 `globe:check-imports` 验证。
  - `elements` 中的 `_ppToggles`、`_cockpitDisplayPanel`、`_hudBtn` 等是外壳面板的元素，我们没有，传 `null`。如果出错，就传不挂载到页面的占位元素，并在报告中列出。
- 返回一个清理函数，用来销毁 coordinator（方法名以源码为准）。
- 如果 coordinator 依赖的 service 无法在不碰 Vue 的前提下获得，**停下来**，在报告中写明缺少哪个、为什么，并且不提交驾驶舱部分（HUD 部分照常提交）。

**驾驶舱仪表（`app/(app)/globe/components/cockpit-instruments.tsx`）**：

- 数据来自 `useGevStore(useCockpitStore(), s => s.instruments)`，再加上 `presence`、`vision`。
- 布局参照 `CockpitView.vue:131-195`：左侧速度带、右侧高度带、底部中央航向罗盘带；左上是呼号 + 机型元信息（紧急状态时用 `text-rose-400`）；上方中央是视觉模式（上一个 / 当前 / 下一个）。这三个按钮**用骨架里的同 id 元素**，仪表组件只负责显示文字，所以实现上要让仪表组件把文字渲染进骨架的按钮内部，**或者**把骨架和仪表合并为同一个组件（推荐后者：一个组件既提供 id，又显示仓库内容，按钮仍然不加 React 的 `onClick`）。
- 风格同 HUD：等宽字体、细线、`text-slate-100`、刻度用 `bg-slate-400`，**不用霓虹色**。
- 进入驾驶舱时，自动隐藏左侧图层面板和命令坞，只保留「退出驾驶舱」按钮（`map-view-switch`）和视觉切换；退出后恢复。是否处于驾驶舱，用 `gev:cockpit-mode-changed` 事件，或 `presence` 中的字段判断。
- G3 详情卡上的「进入驾驶舱」按钮：根据 `useCockpitStore().presence?.entryAvailable` 启用。

### 5.4 i18n 与测试

- 文案放在 `globe.hud.*`、`globe.cockpit.*` 下。GEV 发布的 HUD / 仪表文本已经由它自己的 i18n 翻译，原样显示。
- 测试：
  - `intel-hud.tsx`：传入模拟的 hud 视图对象，断言四个角的内容；`hud` 为 `null` 时不渲染。
  - `cockpit-instruments.tsx`：传入模拟的 `instruments` 和 `presence`，断言速度、高度、呼号；断言骨架中**存在** GEV 需要的全部 id，把 id 清单写成常量并在测试里逐个断言。这是防回归的关键测试：以后有人改 UI 时删掉某个 id，测试会失败。
  - 不测引擎。

---

## 禁止事项

- 除 5.1 那一行之外修改 vendor 源码。
- 在骨架元素上加 React `onClick`，这会和 GEV 的事件绑定冲突。
- 引用 `ui/composition.js`、`ui/applicationShell.js`、`ui/views/*`。

## 验证与提交

README §6。分两次提交：

- `🩹 fix(vendor): gods-eye-view hud.js 改从 layerNames 引入 localizeLayerName（行为不变）`（只包含 vendor、UPSTREAM.md、检查脚本黑名单、README 白名单）
- `✨ feat(web): 3D 地球 G5 HUD 读数层与驾驶舱`

## 留给用户的浏览器冒烟

- 按 `H` 显示 / 隐藏 HUD，四个角有坐标、MGRS、高度、时间；
- 打开航班图层，选中一架在飞的飞机，点「进入驾驶舱」：相机进入机舱视角，看到速度、高度、罗盘；
- 在驾驶舱里切换视觉模式（上一个 / 下一个）；
- 点「地图视角」退出，面板恢复；
- 右下角的数据署名始终可见。
