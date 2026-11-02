# 3D 地球 G6：我们的情报上图 + 「在 3D 地球查看」入口

> **一句话目标**：
> - 把我们自己的**新闻事件**和**新闻标记**作为 GEV 图层画到 3D 地球上，复用它的标签、细节层级（LOD）和点选逻辑，放在图层面板最前面的「情报」组；
> - 点中情报点后，详情卡显示事件或新闻的摘要，并能一键跳回控制台的事件详情页、新闻详情页；
> - 在事件详情页、战争地图检查器中加入「在 3D 地球查看」按钮。
>
> 这是本项目区别于原版 GEV 的核心特色。
>
> **依赖**：G3 已合入。**开工前必读**：README 全文；G2、G3 的报告；下面列出的源码。

## 已核实的关键事实

- **数据源**（我们已有，按 org 隔离，并且带登录态）：
  - `apiClient.get("dashboard/war-map/events", { params })`
  - `apiClient.get("dashboard/war-map/news-markers", { params })`

  参数用 `buildWarMapBaseRequestParams({ start, end, cluster: false })`，返回值用 `normalizeWarMapEventsResponse` / `normalizeWarMapNewsMarkersResponse` 归一化。这些函数都在 `app/(app)/dashboard/charts/war-map/war-map-data.ts`，**直接复用**。写法参考同目录的 `use-war-map-data.ts:30-60`。
- **GEV 图层工厂**：`@gev/data/localGeojsonCore.js` 的 `createLocalGeoJsonLayer({ id, url, name, color, icon, source, labels }, services)`，`services` 用 `@gev/app/localGeojsonServices.js` 的 `localGeoJsonServices`。具体行为：
  - 用 `fetch(url)` 读取 **GeoJSONL**，每行一个 GeoJSON Feature，解析函数是 `sources/infrastructureData.js:22` 的 `parseGeojsonLines`。坐标为 `[lon, lat]`，高度可省略。
  - 标签取 `properties.name`（`localGeojsonCore.js:1219`）。
  - 点选后会调用 `registerEntityContext`，记录中包含 `layerId`、`label`、`properties`（完整原样）、`latitude`、`longitude`（`localGeojsonCore.js:692-705`）。G3 的 `useGevSelection` 会收到这条记录。
  - **一个实例只有一种颜色**，所以事件和新闻分成两个图层。
  - **数据只在首次启用时加载一次**：缓存 `_cachedFeatures` 只在 `destroy` 时清空（`:355`、`:587-601`、`:1084`），没有刷新入口。所以需要下面 6.1 的补丁。

## 任务

### 6.1 vendor 补丁：给 local GeoJSON 图层加 `reload()`

在 `vendor/gods-eye-view/src/data/localGeojsonCore.js` 中，`createLocalGeoJsonLayer` 返回的对象上**新增**一个方法 `reload()`，只做追加，不改现有方法的行为：

- 清空 `_cachedFeatures`。
- 如果图层当前是启用状态：移除旧的数据源、overlay 条目和上下文记录，清理方式与 `disable` / `destroy` 中的现有代码一致（**调用现有的内部函数**，不要复制逻辑），然后重新执行加载流程（即启用时调用的那个内部加载函数），使新数据生效。
- 如果未启用，只清空缓存，下次启用时自动重新读取。
- 返回一个 Promise，在加载完成或失败时 resolve。

要求：

- 补丁尽量小，在方法上方加注释 `// newwei patch (globe G6): …`。
- 在 `UPSTREAM.md` 的「本地补丁」表登记。
- 新增一个 GEV 风格的单元测试 `src/data/localGeojsonReload.test.mjs`，模仿同目录的 `localGeojson*.test.mjs` 的写法，用它们已有的假 viewer 和 fetch 工具。测试内容：`reload()` 后会再次调用 fetch；未启用时不发起 fetch。
- 把这个测试文件加入 G0 CI `globe-vendor` job 的测试命令：`node --test src/data/localGeojsonReload.test.mjs`；如果它的测试必须通过 `scripts/run-unit-tests.mjs` 运行，以它的方式为准。

### 6.2 情报数据转换 `lib/globe/intel-geojson.ts`（纯逻辑，可测试）

```ts
export function eventsToGeojsonl(events: WarMapEvent[], opts: { locale; consoleBase?: string }): string;
export function newsMarkersToGeojsonl(markers: WarMapNewsMarker[], opts): string;
```

每个点输出一行 Feature：

```json
{"type":"Feature","id":"evt:<id>","geometry":{"type":"Point","coordinates":[lon,lat]},
 "properties":{"name":"<标题，最多 80 字>","kind":"event","severity":"high","time":"<ISO>",
   "summary":"<摘要，最多 200 字>","consoleUrl":"/events/<id>","newweiId":"<id>"}}
```

- 新闻用 `"kind":"news"`，`consoleUrl` 指向新闻详情 `/items/<itemId>`。字段名以 `WarMapNewsMarker` 的实际类型为准。
- 坐标无效（NaN、超出范围）的点**丢弃**。
- 每类最多 2000 个点：事件按 severity 排序后截断，新闻按时间倒序截断。
- `name` 中的换行替换成空格。整行用 `JSON.stringify` 生成，保证一行一个 Feature。

测试：正常转换；无效坐标被丢弃；截断与排序；换行处理；输出的每一行都能被 `JSON.parse` 解析。

### 6.3 情报图层的创建与刷新（`lib/globe/runtime.ts` 追加 + `lib/globe/intel-feed.ts`）

- **图层必须在 `finalizeRegistrations` 之前注册**，所以要改 G2 运行时的第 7 步：在注册 catalog 图层之后、`finalizeRegistrations` 之前，追加两个图层：

  | id | name | color | icon | source |
  |---|---|---|---|---|
  | `newwei-events` | `t("globe.intel.events")` | `#f59e0b` | `◆` | `"Newwei"` |
  | `newwei-news` | `t("globe.intel.news")` | `#38bdf8` | `●` | `"Newwei"` |

- `url` 用一个**在运行时内部持有的 Blob URL**。初始为空 Blob（内容为空字符串，解析结果是零个要素）。
- `finalizeRegistrations(metadata)` 的 metadata 需要为这两个 id 补上条目，写法照 `app/constructCatalog.js` 里的 `LOCAL_ONLY_LAYER_METADATA`：`{ id, disposition: "local-only" }`。这样 GEV 的分享和状态序列化会忽略它们。
- `actions.setIntelData({ eventsGeojsonl, newsGeojsonl })`：
  - 为每类生成新的 Blob URL，并替换图层持有的 url。工厂的 `url` 参数在创建时就固定了，所以要么在创建时传入一个闭包读取的 getter，要么把 6.1 的 `reload()` 扩展为 `reload(nextUrl?)`。**选择改动最小、行为最清楚的那种**，并在报告中说明；
  - 然后调用 `layer.reload()`；
  - 调用 `URL.revokeObjectURL` 释放旧的 Blob URL；
  - 运行时销毁时释放全部 Blob URL。
- `lib/globe/intel-feed.ts`：一个 React hook `useIntelFeed(runtime)`：
  - 用 `@tanstack/react-query` 和 `apiClient` 拉取最近 72 小时（`start = now - 72h`，`end = now`）的事件和新闻标记；
  - `refetchInterval` 为 5 分钟，`staleTime` 为 60 秒；
  - 数据变化时调用 `eventsToGeojsonl` / `newsMarkersToGeojsonl`，再调用 `runtime.actions.setIntelData`；
  - **只在对应图层启用时请求**：订阅 `dataManager`，判断 `isEnabled`。

### 6.4 图层面板与详情卡

- G3 的 `GLOBE_LAYER_GROUPS` 最前面新增「情报」组：`newwei-events`、`newwei-news`。**进入页面时默认启用 `newwei-events`**，在运行时启动完成后调用 `toggle` 一次。
- G3 的 `target-format.ts` 新增 `newwei-events` / `newwei-news` 的专用格式化器，数据从记录的 `properties` 中读取：
  - 标题：`name`；
  - 字段：类型、严重程度（用我们的严重程度 Tag 颜色：高用 error，中用 warning，低不加颜色，参见前端 README §3.6）、时间（`formatTimestamp`）、摘要；
  - 主按钮：「打开事件详情」或「打开新闻」，`router.push(consoleUrl)`；
  - 次按钮：「在控制台搜索」（G3 已有）。

### 6.5 「在 3D 地球查看」入口

- **URL 约定**：`/globe?lat=<lat>&lon=<lon>&label=<标题>&focus=<layerId>:<newweiId>`。在 `lib/globe/globe-link.ts` 中写一个纯函数 `buildGlobeHref(input)` / `parseGlobeParams(searchParams)`，并为它写测试，覆盖坐标校验和 label 长度截断（80 字）。
- **`/globe` 页面读取参数**：运行时就绪后：
  1. 用 G4 的 `flyToPlace` 飞到 `lat` / `lon`，高度约 300 km；
  2. 确保 `newwei-events` 或 `newwei-news` 已启用；
  3. 数据加载完成后，如果 `focus` 对应的要素存在，就选中它：通过 `getContextStore().entities` 找到 id 为 `${layerId}:${featureId}` 的记录，再调用 `selectEntityContext(record.entity)`。记录 id 的拼接规则见 `localGeojsonCore.js:693`，按实际实现为准。
  4. 处理完成后用 `router.replace("/globe")` 清除参数，避免刷新页面时重复飞行。
- **入口按钮**：
  - 事件详情页 `app/(app)/events/[id]/event-detail.tsx`：如果事件有坐标（字段以实际数据为准），在 `PageHeader` 的 `actions` 中追加一个按钮「在 3D 地球查看」，使用 `GlobalOutlined` 图标和 `type="default"`。
  - 战争地图检查器 `app/(app)/dashboard/charts/war-map/war-map-inspector-panel.tsx` 的事件和新闻检查内容：在操作区追加同样的按钮（`type="link"`）。
  - 两处都用 `buildGlobeHref`。

### 6.6 i18n 与测试

- 文案放在 `globe.intel.*` 下。
- 测试：
  - 6.2 的转换函数；
  - 6.5 的链接函数；
  - `target-format` 新增的两个格式化器；
  - 事件详情页的按钮：有坐标时渲染，没有坐标时不渲染。

---

## 禁止事项

- 除 6.1 的追加补丁外修改 vendor 源码。
- 新建后端接口。本批只用现有的 `dashboard/war-map/*` 接口，不改 api-go。
- 把我们的 `apiClient` 令牌或会话信息传给 GEV 的任何模块。GEV 读取的只是一个本地 Blob URL。

## 验证与提交

- README §6；CI 的 `globe-vendor` job 跑通新增的 GEV 测试。
- 提交分三次：
  - `🩹 feat(vendor): gods-eye-view local GeoJSON 图层新增 reload()`（vendor、UPSTREAM.md、CI 测试命令）
  - `✨ feat(web): 3D 地球 G6 情报图层（事件 / 新闻上图）`
  - `✨ feat(web): 3D 地球 G6 事件详情与战争地图加入「在 3D 地球查看」`

## 留给用户的浏览器冒烟

- 进入 `/globe` 后默认能看到琥珀色的事件点；
- 打开「新闻」图层后出现蓝色点；
- 点一个事件点：详情卡显示标题、严重程度、时间、摘要，点「打开事件详情」能跳到对应事件；
- 在某个有坐标的事件详情页点「在 3D 地球查看」：跳到地球，相机飞到该处并选中该事件；
- 等 5 分钟后数据自动刷新，点不会闪烁或重复。
