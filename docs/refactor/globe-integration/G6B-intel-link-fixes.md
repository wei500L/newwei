# 3D 地球 G6B：情报图层的跳转修正（审查后补丁）

> **一句话目标**：修正 G6 两个「打开详情」按钮跳到错误页面的问题，并顺手收紧深链参数。
>
> **背景**：G6 提示词假设了两件事，审查发现都不成立：
> - 「战争地图事件 id = 事件详情页 id」；
> - 「新闻标记 id = 新闻详情页 id」。
>
> 代码按提示词执行没有问题，是提示词的前提错了。
>
> **依赖**：G6 已合入。**开工前必读**：本文件、G6 提示词、下面列出的源码（逐条核实后再动手）。

## 审查结论（已用源码核实）

### F1 「事件」图层的点其实是**国家/地区聚合**，不是事件

- `apps/api-go/internal/dashboardwarmap/assemble.go:145-157`：`warEvent.ID = strings.ToLower(code)`，也就是国家代码，例如 `ua`、`us`。`Name` 是国家名，`NewsCount` / `AlertCount` / `DerivedScore` 是该地区的新闻数、告警数和热度。
- 数据来源 `mysql.go:14-31`：`AlertEvent` 加上 `ProcessedArticle.location`，按国家聚合。没有任何一处引用事件表的 id。

带来的后果：

| 位置 | 现状 | 问题 |
|---|---|---|
| `lib/globe/intel-geojson.ts:166` | `consoleUrl: /events/<国家代码>` | 「打开事件详情」跳到 `/events/ua`，**详情页找不到** |
| `lib/globe/target-format.ts` 的兜底链接 | 同上 | 同上 |
| `app/(app)/events/[id]/event-globe-button.tsx:34-36` | `focus: newwei-events:<事件 id>` | 这个 id 在图层里永远不存在。`globe-stage.tsx:175-183` 会空转轮询 10 秒，然后放弃，最终只飞过去、不会选中任何东西 |

`war-map-event-cluster-inspector.tsx:128` 用的是 `item.id`（国家代码），与图层 id 一致，**这里是对的，保持不变**。

### F2 「新闻」图层的 id 是 `ProcessedArticle.id`，但新闻详情页按 `ItemMeta.id` 查

- `dashboardwarmap/mysql.go` 中的 `markerArticleSQL` 选取的是 `pa.id`（ProcessedArticle）。
- `/items/[id]`：`item-detail.tsx:405` → GraphQL `item(id)` → `itemsreading/register.go:83` `ItemMetaOrNull` → `itemsreading/service.go:212-224` `FindItemMeta`。这里按 **ItemMeta.id** 查找。
- 在 Prisma 中，`ItemMeta` 和 `ProcessedArticle` 之间没有直接外键（`packages/db/prisma/schema.prisma` 的 `model ItemMeta`），两者的 id 不通用。事件详情页同时存在 `processedArticleId` 和 `itemMetaId` 两个字段（`event-detail.tsx:60-66`），也说明它们不是同一个东西。

后果：「打开新闻」跳到 `/items/<ProcessedArticle.id>`，**显示找不到**。

### F3（小）深链 `focus` 没有限定图层

`lib/globe/globe-link.ts:104-110` 接受任意 `layerId`。`globe-stage.tsx:170-174` 会对它执行 `toggleLayer`。所以 `/globe?lat=0&lon=0&focus=cctv:x` 会在进入页面时打开摄像头图层，向第三方拉取画面。

### F4（小）站内入口用 antd `Button href`，会整页刷新

`event-globe-button.tsx:40`、`war-map-event-cluster-inspector.tsx:124`、`war-map-news-inspector.tsx:70` 用的都是 antd `Button` 的 `href`。它渲染成普通的 `<a>`，点击后整个应用重新加载，丢掉了 Next 的客户端导航和已加载的查询缓存。

### F5（极小）`runtime.owners.cockpit` 永远是 `null`

`lib/globe/runtime.ts:1144` 在构造时取值，而 coordinator 是之后由 `attachCockpit()` 创建的。

## 任务

### B1 事件图层改名为「地区态势」，并修正它的跳转

1. **i18n**：
   - `globe.intel.events` 改为「地区态势」/「Regional activity」；
   - `globe.intel.openEvent` 改为「查看该地区事件」/「Events in this region」；
   - 其它出现「情报事件」语义的文案一并核对。
2. **`lib/globe/intel-geojson.ts` 的 `eventsToGeojsonl`**：
   - `properties` 增加：`kind: "region"`、`countryCode`（即 id）、`newsCount`、`alertCount`、`score`（`derivedScore`）。这些字段在 `normalizeWarMapEventsResponse` 中都已保留，见 `war-map-data.ts:264-286`；
   - `consoleUrl` 改为该地区的事件列表链接：
     - **先核实** `/events` 列表的 `entity` 参数（`app/(app)/events/events-content.tsx:203` 的 `normalizeEntityFilter`，以及它请求的后端接口如何使用这个参数）能否用国家名（`event.name`，英文名）筛出该地区的事件；
     - **能**：用 `/events?entity=<encodeURIComponent(name)>`；
     - **不能，或无法确定**：退回到 `/search?q=<name>`，并在报告里写明你的判断依据；
   - Feature `id` 保持 `evt:<code>`，`newweiId` 保持国家代码。这样战争地图检查器的 `focus` 仍然有效。
3. **`lib/globe/target-format.ts` 的 `formatNewweiIntel`**：
   - 事件类显示的字段：地区（`name`）、严重程度（保持 Tag 颜色规则）、新闻数、告警数、热度、最近时间。摘要为空时不显示；
   - `kindKey` 用新的 `globe.target.kinds.region`（需要新增）；
   - 兜底链接（`consoleUrl` 缺失时）改为与第 2 步相同的规则，**不再拼** `/events/<id>`。
4. **事件详情页按钮 `event-globe-button.tsx`**：**去掉 `focus`**，因为该事件不在任何图层里。只飞到该坐标，并用 `label` 显示标题。`globe-stage.tsx` 的深链在没有 `focus` 时已经会跳过轮询，确认这一点即可。
   - 如果你认为飞过去之后应该自动打开「地区态势」图层，让用户看到周边热度，就在没有 `focus` 时调用 `toggleLayer("newwei-events")`（仅当未启用时）。这一步可选，在报告中说明你的选择。

### B2 新闻改为「打开原文」，站内入口改为「在控制台搜索」

1. **`newsMarkersToGeojsonl`**：
   - `properties` 增加 `url`：用 `lib/url.ts` 的 `safeHttpUrl(marker.url)` 处理，不合法时省略；
   - 增加 `location`（`locationZh` 优先，按 locale 选择）；
   - **删除** `consoleUrl`，因为它没有可用的站内详情页。
2. **`target-format.ts` 的新闻格式化器**：
   - 主按钮改为「打开原文」，新增 i18n `globe.intel.openSource`；
   - `console` 字段的类型增加 `external?: boolean`：新闻为 `true`，`href` 为 `url`；没有 `url` 时不给主按钮；
   - 次按钮「在控制台搜索」（G3 已有）保留，搜索词用标题。
3. **`target-card.tsx` / `target-card-container.tsx`**：
   - `external` 为真时，主按钮用 `<a href target="_blank" rel="noopener noreferrer">` 渲染，或调用 `window.open(href, "_blank", "noopener,noreferrer")`，二选一，与仓库里其它「打开原文」的写法保持一致（先 grep `noopener` 看现有写法）；
   - 否则照旧 `router.push`；
   - `href` 在渲染前**再用 `safeHttpUrl` 校验一次**，不信任 GeoJSON 里的字符串。
4. **不要**为了拿到 `ItemMeta.id` 去改 api-go。这是一个可选的后续改进，写进 README §8 的路线图一行即可：「战争地图新闻标记返回 itemMetaId，地球上可直达新闻详情」。

### B3 深链 `focus` 白名单

- 在 `globe-link.ts` 中导出常量 `GLOBE_FOCUS_LAYERS = ["newwei-events", "newwei-news"] as const`。
- `parseGlobeParams` 只接受这两个 `layerId`，其它值直接丢弃 `focus`（坐标照常生效）。
- `buildGlobeHref` 遇到非白名单的 `layerId` 也不写入 `focus`。
- 更新 `globe-link.test.ts`：白名单内的值通过；`cctv:x` 被丢弃，但 `lat` / `lon` 保留。

### B4 站内入口改为客户端导航

- 三处「在 3D 地球查看」按钮改为 Next 客户端导航。先 grep 仓库里「antd Button + 站内链接」的现成写法，例如 `event-detail.tsx:855` 的 `<Link href="/events">`，照着写：可以用 `<Link href={href}>` 包住 `Button`，也可以用 `onClick={() => router.push(href)}`。保持 `GlobalOutlined` 图标和原来的 `type`。
- 更新 `event-globe-button.test.tsx`：断言点击后调用了 `router.push`，或者链接的 `href` 正确（按你的实现选择断言方式），并断言 `href` 中**不含** `focus=`（对应 B1 第 4 步）。

### B5 `owners.cockpit` 改为读取时取值

- 在 `runtime.ts` 中把 `owners.cockpit` 改为 getter：`get cockpit() { return cockpitCoordinator; }`；相应调整 `GlobeOwners` 类型，改成只读属性。
- 如果没有任何调用方读取它，也可以直接删除这个字段。二选一，在报告中说明。

### B6 测试

- `intel-geojson.test.ts`：事件 Feature 带 `kind: "region"` 和新的计数字段，`consoleUrl` 符合 B1 第 2 步的规则；新闻 Feature 没有 `consoleUrl`，`url` 只保留合法的 http(s) 地址（`javascript:` 被丢弃）。
- `target-format.test.ts`：
  - 地区卡片的字段与 `kindKey`；
  - 新闻卡片的 `console.external === true`；
  - 新闻没有 url 时没有主按钮。
- `target-card.test.tsx`：`external` 链接渲染为新标签页打开，带 `rel` 属性。
- `globe-link.test.ts`：B3 的白名单测试。
- `event-globe-button.test.tsx`：B4 的断言。

## 禁止事项

- 修改 vendor 源码。
- 修改 api-go，包括为了 itemMetaId 新增字段（只写进路线图）。
- 在任何地方用拼接字符串生成指向 `/events/<国家代码>` 或 `/items/<ProcessedArticle.id>` 的链接。

## 验证与提交

- README §6 的命令（lint、typecheck、web 测试、`globe:check-imports`）。
- 提交一次：`🐛 fix(web): 3D 地球情报图层跳转修正——地区态势链接、新闻打开原文、深链 focus 白名单`。

## 留给用户的浏览器冒烟

- 地球上的琥珀色点，详情卡标题是国家/地区名，显示新闻数、告警数；点「查看该地区事件」后，进入的列表确实是该地区的事件；
- 打开新闻图层，点一个蓝点，「打开原文」在新标签页打开文章；
- 在某个事件详情页点「在 3D 地球查看」：不刷新整页，相机飞到该处，不会卡在等待选中；
- 手动访问 `/globe?lat=35&lon=139&focus=cctv:x`：飞到东京，摄像头图层**没有**被打开。
