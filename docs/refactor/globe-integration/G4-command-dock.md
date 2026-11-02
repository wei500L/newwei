# 3D 地球 G4：底部命令坞（搜索飞行 / 底图 / 视觉滤镜 / 回到地球 / 快捷键）

> **一句话目标**：在地球底部中央做一条「命令坞」，包含：
> - 地点搜索：输入地名、坐标或 `geo:` URI 后飞过去；
> - 底图切换：Google 3D / Esri 卫星图 / OSM；
> - 视觉滤镜：正常、CRT、夜视、热成像、动漫、黑白；
> - 检测框开关；
> - 回到整个地球。
>
> 同时复刻 GEV 的键盘快捷键。
>
> **依赖**：G2 已合入。可与 G3 并行，**只动** `app/(app)/globe/components/command-dock*.tsx`、`lib/globe/command-model.ts`、`lib/globe/shortcuts.ts`，以及 `runtime.ts` 里的 `actions` 扩展（和 G3 都会改 `runtime.ts`：只在 `actions` 对象上**追加**方法，冲突时两边都保留）。
>
> **开工前必读**：README 全文；G2 报告；下面列出的 GEV 源码。

## GEV 的操作逻辑（照这个复刻）

| 功能 | GEV 源码 | 说明 |
|---|---|---|
| 地点搜索 | `standalone/placeSearch.js`（`createStandalonePlaceSearch`）、`search/index.js`、`ui/locationNavigation.js`、`ui/location.js`、`ui/stores/location.js`、`ui/views/CommandDockView.vue` | 先尝试十进制坐标、`geo:` URI、内置城市和地标（`cityPois.js`，不发网络请求），再尝试 Google（有密钥时）、Photon，最后是 `/api/geocode`（Nominatim）。选中结果后飞过去。搜索框的建议列表、键盘上下选择、Esc 关闭，都按 `CommandDockView.vue` 的行为来 |
| 底图 | `maps/catalog.js`、`maps/controller.js`、`ui/mapSourceControls.js` | 栈 id：`photoreal`（Google 3D，需要 Google 密钥）、`esri-imagery`、`osm`。`bing-aerial` 和 `bing-labels` 需要 Cesium ion 令牌，**我们没有，不显示** |
| 视觉滤镜 | `ui/visualSettings.js` 的 `setStyle`（约 :1473）、`ui/visualPresets.js` | 名称：`normal`、`retro`（CRT）、`surveillance`（夜视）、`thermal`（热成像）、`anime`、`noir`。切换时 GEV 会自动应用该风格的预设，包括检测框，见 `STYLE_PRESET_DEFAULTS` |
| 检测框 | `data/detection.js` 的 `cycleMode` / `getMode` | 屏幕空间的目标框和编号 |
| 回到地球 | `locations.js` 的 `flyToGlobeView` | — |
| 快捷键 | `ui/applicationShortcuts.js` | `1`–`6` 风格；`Esc` 关闭搜索；`H` HUD；`O` 自动旋转；`V` 纯净视图；`F` 显示 / 隐藏图层面板；`D` 切换检测框；`C` 开关摄像头图层（**注意：不是驾驶舱**） |

## 任务

### 4.1 运行时 actions（`lib/globe/runtime.ts`，只追加）

在 `actions` 上追加以下方法，每个方法上方注释写明对应的 GEV 源码位置：

- `searchPlaces(query, signal)`：返回 `{ id, label, sublabel?, lat, lon, kind }[]`。使用 `createStandalonePlaceSearch({ presets: CITY_POIS, resolveApiKey: () => googleApiKey, signal })`，在 G2 运行时里创建一次。
- `flyToPlace(result)`：走 `LocationNavigation` 的现成方法（它会处理导航权限和跟踪释放）。如果 G2 没有创建 `LocationNavigation`，就退回 `locations.js` 的 `flyToLandmark`。
- `setMapStack(id)` / `getMapStack()`，以及 `availableMapStacks()`：过滤掉 `requiresIon` 的栈；没有 Google 密钥时再去掉 `photoreal`。
- `setStyle(name)` / `getStyle()`：使用 `VisualSettings.setStyle`，参数照外壳的调用方式。
- `cycleDetection()` / `getDetectionMode()`。
- `resetGlobe()`：先释放跟踪（与 G3 的 `untrack` 相同），再 `flyToGlobeView(viewer)`。
- `toggleOrbit()`：`OrbitController` 是外壳在 `composition.js` 里注入的 service，**`composition.js` 在黑名单里**。所以直接 import `@gev/orbit.js`（已核实不会碰到 `.vue`），照外壳 `_initOrbit` 的写法创建。

### 4.2 状态读取

- 当前风格：`useGevStore(useDisplayStore(), selector)`。字段以 `ui/stores/display.js` 和 `ui/views/DisplayControlsView.vue` 为准。如果仓库里没有，就用 G2 的 `useGevStyle()`（`gev:style-change` 事件）。
- 当前底图：`useMapStack()`（`gev:map-stack-changed`）。
- 检测框模式：`initDetection` 的第三个参数（模式标签回调）在 G2 里是空函数，本批改为写进一个很小的外部仓库（`createExternalStore`，放在 `lib/globe/` 下），React 订阅它。

### 4.3 纯逻辑 `lib/globe/command-model.ts`（可测试）

- `GLOBE_STYLES`：`[{ id: "normal", key: "1", labelKey: "globe.styles.normal" }, …]`，共 6 项，顺序和按键与 `STYLE_KEYS` 一致。
- `GLOBE_MAP_STACKS`：`photoreal` / `esri-imagery` / `osm` 的 labelKey 和是否需要 Google 密钥。
- `parseCoordinateQuery(q)`：识别 `lat, lon`、`lat lon`、`geo:lat,lon` 格式。命中时搜索框直接显示「飞到 xx.xxxx, yy.yyyy」，不发请求。GEV 的搜索也会处理这种情况，这里只用于**即时预览**。

测试覆盖上述三项。

### 4.4 `lib/globe/shortcuts.ts` + 绑定

- `bindGlobeShortcuts(target: Document, actions, { isSearchFocused })`，返回解绑函数。
- 键位与 GEV 一致：`1`–`6`、`Esc`、`H`、`O`、`V`、`F`、`D`、`C`。其中 `H`（HUD）、`V`（纯净视图）、`F`（图层面板）只是派发我们自己的 React 状态：
  - `F` 切换图层面板显隐，由 `globe-content` 持有状态，并传给 G3 的面板；
  - `V` 隐藏所有 React 面板，只保留地球和数据署名；
  - `H` 交给 G5，本批先预留，派发 `globe:toggle-hud` 自定义事件。
- 规则：在输入框、下拉框、文本框中不响应，只有 `Esc` 例外（照 `applicationShortcuts.js:29`）；任何修饰键（Ctrl / Meta / Alt）按下时不响应，避免和浏览器快捷键冲突。
- 测试：用 `fireEvent.keyDown(document, { key: "3" })`，断言调用了 `setStyle("surveillance")`；焦点在 input 里时不触发；按 Ctrl+3 不触发。

### 4.5 `app/(app)/globe/components/command-dock.tsx`

- 位置：`absolute bottom-4 left-1/2 -translate-x-1/2`，宽度 `min(760px, calc(100% - 24px))`。**必须避开右下角的数据署名**，窄屏时如果会遮挡，就把 dock 抬高到 `bottom-14`。
- 外观：`rounded-md border border-slate-700 bg-slate-950/85 px-2 py-2 flex items-center gap-2`，不做模糊。
- 从左到右：
  1. 搜索框：antd `AutoComplete` + `Input`，`placeholder` 为「搜索地点或输入坐标」。输入防抖 250ms，用 `AbortController` 取消上一次请求；结果项包含 label、sublabel（灰色小字），以及右侧的类型 kicker。选中后调用 `flyToPlace`。
  2. 风格：`Segmented size="small"`，6 项，每项的 `title` 含快捷键提示（例如「夜视 · 3」）。窄屏（< 640px）时收为 `Dropdown`。
  3. 底图：`Dropdown` 按钮，显示当前底图名。
  4. 检测框：`Button type="text"`，`aria-pressed`，显示当前模式标签。
  5. 回到地球：图标按钮，带 `aria-label` 和 `Tooltip`。
  6. 快捷键帮助：`?` 图标按钮，打开一个 `Popover`，列出全部快捷键（用 `<kbd>` 样式，`font-mono`）。
- 每个按钮都带 `aria-label`；所有文案走 i18n，放在 `globe.dock.*`。

---

## 禁止事项

- 引用 `ui/composition.js`、`ui/applicationShell.js` 等黑名单模块。
- 自己实现地理编码。搜索一律走 GEV 的 `placeSearch`，它已经负责多来源回退和限流。
- 修改 vendor 源码。

## 验证与提交

README §6。提交：`✨ feat(web): 3D 地球 G4 命令坞、视觉滤镜与快捷键`

## 留给用户的浏览器冒烟

- 搜「东京」后飞过去；输入 `31.23, 121.47` 后飞到上海；
- 按 `3` 切到夜视，按 `4` 切到热成像，按 `1` 恢复正常；
- 切到 OSM 底图，再切回 Google 3D；
- 按 `D` 能看到检测框；
- 点「回到地球」能看到整个地球；
- 在搜索框里按数字键不会切换风格。
