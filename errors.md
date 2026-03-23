## 2026-03-23 16:29:53 +0800 - 错误 @ http://localhost:3000/today
**页面**：Modular Admin
**描述**：点击侧边导航中的 Dashboard 链接 @e49 后未发生跳转，等待 networkidle 后当前 URL 仍停留在 /today。
**证据**：./screenshots/screenshot-1774254593193.png
**快照引用**：@e49 Dashboard link, @e2 Open navigation menu, @e24 Close
**控制台错误**：无浏览器控制台错误；agent-browser errors/console 均为空。


## 2026-03-23 16:32:16 +0800 - 错误 @ http://localhost:3000/subscriptions?tab=channels
**页面**：Modular Admin
**描述**：在 Add channel 弹窗中，必填字段 Name 和 Target 留空后点击 Save @e31，没有出现任何可见校验提示，弹窗保持打开且用户无法得知失败原因。
**证据**：./screenshots/screenshot-1774254736275.png
**快照引用**：@e31 Save, @e33 * Name, @e35 * Target, @e40 * Type
**控制台错误**：无浏览器控制台错误；agent-browser errors/console 均为空。


## 2026-03-23 16:32:48 +0800 - 错误 @ http://localhost:3000/subscriptions?tab=channels
**页面**：Modular Admin
**描述**：在 Add channel 弹窗中点击 Cancel @e30 后，弹窗仍然保持打开，后续页面标签无法正常切换，说明取消动作未生效。
**证据**：./screenshots/screenshot-1774254768019.png
**快照引用**：@e30 Cancel, @e27 Close, @e31 Save, @e25 Alert Channels, @e26 Notifications
**控制台错误**：无浏览器控制台错误；agent-browser errors/console 均为空。


## 2026-03-23 16:33:48 +0800 - 错误 @ http://localhost:3000/alerts?eventId=cmn2wvl7s0001e265ysjaw2j5
**页面**：Modular Admin
**描述**：从 Notifications 页点击 Open alert 后进入 Alert Center，页面无法加载告警历史，显示 'Technical detail: HTTP 500'。
**证据**：./screenshots/screenshot-1774254828008.png
**快照引用**：@e12 Retry fetch, @e8 Alert Center
**控制台错误**：无浏览器控制台错误；页面正文显示 HTTP 500。


## 2026-03-23 16:36:33 +0800 - 错误 @ http://localhost:3000/search
**页面**：Modular Admin
**描述**：Search 页点击热词按钮 OpenAI (64) @e16 后，页面没有任何状态变化，仍显示 'No query detected'，查询控件也未填入关键词，快捷搜索入口失效。
**证据**：./screenshots/screenshot-1774254993722.png
**快照引用**：@e16 OpenAI (64), @e57 Search combobox, @e28 Refresh
**控制台错误**：无浏览器控制台错误；agent-browser errors/console 均为空。

## 2026-03-23 16:43:21 +0800 - 错误 @ http://localhost:3000/items/cmmtbs6wl079qzf7b59eujkuk
**页面**：Modular Admin
**描述**：Item 详情页点击 Raw JSON @e14 后没有展开任何原始载荷内容，按钮状态仍为 collapsed，说明 Raw JSON 切换失效。
**证据**：./screenshots/screenshot-1774255401609.png
**快照引用**：@e14 Raw JSON, @e21 Status failed, @e22 Processed status failed
**控制台错误**：无浏览器控制台错误；按钮点击后页面无任何可见变化。


## 2026-03-23 16:45:20 +0800 - 错误 @ http://localhost:3000/events/cmlo5zxox00nm7l2d1lc3tycb
**页面**：Modular Admin
**描述**：从 News Events 列表点击 Open 后进入动态事件详情页，页面直接显示 'Application error: a client-side exception has occurred while loading localhost'，事件详情无法使用。
**证据**：./screenshots/screenshot-1774255520858.png
**快照引用**：@e1 Application error heading
**控制台错误**：agent-browser errors 返回空错误标记；页面正文为 client-side exception。


## 2026-03-23 16:48:52 +0800 - 错误 @ http://localhost:3000/assistant
**页面**：Modular Admin
**描述**：Assistant 页点击 Quick Report @e21 后没有填充输入框、没有新增对话、也没有任何加载或反馈，快捷动作失效。
**证据**：./screenshots/screenshot-1774255732751.png
**快照引用**：@e21 Quick Report, @e20 Assistant message input, @e23 Send
**控制台错误**：无浏览器控制台错误；点击后页面无任何可见变化。


## 2026-03-23 16:53:31 +0800 - 错误 @ http://localhost:3000/admin/ops/crawl-tasks
**页面**：Modular Admin
**描述**：/admin/ops/crawl-tasks 列表首行 View 链接 @e189 点击后未跳转到任务详情，也未展开任何详情区域；re-snapshot 后 DOM 与 URL 均保持不变。
**证据**：./screenshots/screenshot-1774255997622.png
**快照引用**：@e189, @e51, @e69
**控制台错误**：agent-browser errors 仅返回空错误标记；点击后页面无任何可见变化。

## 2026-03-23 16:54:57 +0800 - 错误 @ http://localhost:3000/admin/ops/crawl-tasks/cmmxcfkx90003104xporl0cb3
**页面**：Modular Admin
**描述**：任务详情页首条日志的 Expand row 按钮 @e191 点击后未展开详情，re-snapshot 后该按钮仍显示 expanded=false，日志区无新增内容。
**证据**：./screenshots/screenshot-1774256097253.png
**快照引用**：@e191, @e150, @e157
**控制台错误**：agent-browser errors 未提供可用错误；点击后页面无任何可见变化。


## 2026-03-23 16:57:09 +0800 - 错误 @ http://localhost:3000/admin/ops/crawl-tasks/cmmxcfkx90003104xporl0cb3
**页面**：Modular Admin
**描述**：任务详情页在无结果数据时点击 Backfill to Items 的 Confirm @e159 后，主按钮变为 loading Backfill to Items 且持续不恢复，没有成功提示、失败提示或状态更新。
**证据**：./screenshots/screenshot-1774256229717.png
**快照引用**：@e159, @e15, @e31, @e32
**控制台错误**：agent-browser errors 未提供可用错误；页面保持原状，仅按钮进入 loading。


## 2026-03-23 16:58:22 +0800 - 错误 @ http://localhost:3000/admin/ops/crawl-monitor
**页面**：Modular Admin
**描述**：Crawl Monitor 的 Requests tab 中首条完成请求的 View 按钮 @e158 点击后没有打开任何请求详情，也没有产生 URL、DOM 或可见文本变化。
**证据**：./screenshots/screenshot-1774256304201.png
**快照引用**：@e158, @e52, @e72
**控制台错误**：agent-browser errors 未提供可用错误；点击后界面保持原状。


## 2026-03-23 17:00:45 +0800 - 错误 @ http://localhost:3000/admin/ops/crawl-monitor
**页面**：Modular Admin
**描述**：Crawl Monitor 的 Timeline tab 切入后仅显示空白面板；但同页 Raw tab 返回了完整 timeline 数据（timestamps/values），说明前端时间线视图未渲染。
**证据**：./screenshots/screenshot-1774256386063.png
**快照引用**：@e37, @e14 Timeline tabpanel
**控制台错误**：agent-browser errors 未提供可用错误；Raw 面板可见 timeline JSON，但 Timeline 面板无可见内容。


## 2026-03-23 17:01:41 +0800 - 错误 @ http://localhost:8082/dashboard/
**页面**：Crawl4AI Monitor
**描述**：内置 dashboard 的 Resource Timeline 区块在页面完成加载并额外等待 2 秒后仍持续显示 Loading...，未渲染任何图表。
**证据**：./screenshots/screenshot-1774256501919.png
**快照引用**：@e12 Resource Timeline (5min), @e13 metric selector
**控制台错误**：agent-browser errors 未提供可用错误；多次快照后时间线区域仍未显示图表。


## 2026-03-23 17:04:58 +0800 - 错误 @ http://localhost:3000/events-archive
**页面**：Modular Admin
**描述**：Events Archive 页面首个 plus 按钮 @e29 点击后没有展开条目详情，也没有任何可见状态变化；re-snapshot 后按钮列表与正文完全不变。
**证据**：./screenshots/screenshot-1774256698160.png
**快照引用**：@e29, @e22, @e44
**控制台错误**：agent-browser errors 未提供可用错误；点击后界面保持原状。


## 2026-03-23 17:07:16 CST - 错误 @ http://localhost:3000/situation-monitor?lat=49.1476&lon=0.0000&zoom=1.51&bearing=0.00&pitch=0.00&preset=global&tr=24h&layers=conflicts%2Cbases%2Ccables%2Cpipelines%2Chotspots%2Cais%2Cnuclear%2Cirradiators%2Csanctions%2Cweather%2Ceconomic%2Cwaterways%2Coutages%2CcyberThreats%2Cdatacenters%2Cprotests%2Cflights%2Cmilitary%2Cnatural%2Cdisplacement%2Cclimate%2CstartupHubs%2CcloudRegions%2Caccelerators%2CtradeRoutes%2CiranAttacks%2CgpsJamming%2Cmonitors
**页面**：Modular Admin
**描述**：/situation-monitor 的 Cross-source 首行 Expand row 按钮 @e374 点击后，最新快照仍显示 expanded=false，表格没有展开详情。
**证据**：./screenshots/screenshot-1774256821230.png
**快照引用**：@e158, @e205, @e374
**控制台错误**：无可见输出（agent-browser console errors 返回 ✓ Done）

## 2026-03-23 17:08:04 CST - 错误 @ http://localhost:3000/situation-monitor?lat=49.1476&lon=0.0000&zoom=1.51&bearing=0.00&pitch=0.00&preset=global&tr=24h&layers=conflicts%2Cbases%2Ccables%2Cpipelines%2Chotspots%2Cais%2Cnuclear%2Cirradiators%2Csanctions%2Cweather%2Ceconomic%2Cwaterways%2Coutages%2CcyberThreats%2Cdatacenters%2Cprotests%2Cflights%2Cmilitary%2Cnatural%2Cdisplacement%2Cclimate%2CstartupHubs%2CcloudRegions%2Caccelerators%2CtradeRoutes%2CiranAttacks%2CgpsJamming%2Cmonitors
**页面**：Modular Admin
**描述**：/situation-monitor 页面底部 My Monitors 区域的 Add monitor 按钮 @e33 点击后无弹窗、无内联表单、无任何可见状态变化。
**证据**：./screenshots/screenshot-1774256871021.png
**快照引用**：@e33, @e34, @e73
**控制台错误**：无可见输出（agent-browser console errors 返回 ✓ Done）

## 2026-03-23 17:08:25 CST - 错误 @ http://localhost:3000/situation-monitor?lat=49.1476&lon=0.0000&zoom=1.51&bearing=0.00&pitch=0.00&preset=global&tr=24h&layers=conflicts%2Cbases%2Ccables%2Cpipelines%2Chotspots%2Cais%2Cnuclear%2Cirradiators%2Csanctions%2Cweather%2Ceconomic%2Cwaterways%2Coutages%2CcyberThreats%2Cdatacenters%2Cprotests%2Cflights%2Cmilitary%2Cnatural%2Cdisplacement%2Cclimate%2CstartupHubs%2CcloudRegions%2Caccelerators%2CtradeRoutes%2CiranAttacks%2CgpsJamming%2Cmonitors
**页面**：Modular Admin
**描述**：/situation-monitor 页面底部 My Monitors 区域的 Edit 按钮 @e416 点击后无编辑态、无弹窗、无内联表单，页面完全不变。
**证据**：./screenshots/screenshot-1774256895423.png
**快照引用**：@e34, @e416, @e415
**控制台错误**：无可见输出（agent-browser console errors 返回 ✓ Done）

## 2026-03-23 17:09:08 CST - 错误 @ http://localhost:3000/situation-monitor?lat=49.1476&lon=0.0000&zoom=1.51&bearing=0.00&pitch=0.00&preset=global&tr=24h&layers=conflicts%2Cbases%2Ccables%2Cpipelines%2Chotspots%2Cais%2Cnuclear%2Cirradiators%2Csanctions%2Cweather%2Ceconomic%2Cwaterways%2Coutages%2CcyberThreats%2Cdatacenters%2Cprotests%2Cflights%2Cmilitary%2Cnatural%2Cdisplacement%2Cclimate%2CstartupHubs%2CcloudRegions%2Caccelerators%2CtradeRoutes%2CiranAttacks%2CgpsJamming%2Cmonitors
**页面**：Modular Admin
**描述**：/situation-monitor 的 Live News 区域 Manage 按钮 @e47 点击后无弹窗、无抽屉、无路由变化，页面保持原状。
**证据**：./screenshots/screenshot-1774256937141.png
**快照引用**：@e47, @e54, @e57
**控制台错误**：无可见输出（agent-browser console errors 返回 ✓ Done）

## 2026-03-23 17:11:47 CST - 错误 @ http://localhost:3000/items?q=%27+OR+1%3D1+--
**页面**：Modular Admin
**描述**：/items 列表首条结果的 Open item 按钮 @e198 点击后没有进入详情页，URL 与列表内容保持不变。
**证据**：./screenshots/screenshot-1774257096631.png
**快照引用**：@e161, @e175, @e198
**控制台错误**：无可见输出（agent-browser console errors 返回 ✓ Done）

## 2026-03-23 17:13:49 CST - 错误 @ http://localhost:3000/items?q=%27+OR+1%3D1+--
**页面**：Modular Admin
**描述**：/items 列表首条结果的 Part of event 按钮（@e91, @e92, @e111）点击后仍停留在当前列表页，URL 维持 http://localhost:3000/items?q=%27+OR+1%3D1+--，未跳转到任何事件详情页，也没有可见反馈。
**证据**：./screenshots/screenshot-1774257216979.png
**快照引用**：@e91, @e92, @e111
**控制台错误**：无

## 2026-03-23 17:14:39 CST - 错误 @ http://localhost:3000/items?q=%27+OR+1%3D1+--
**页面**：Modular Admin
**描述**：/items 搜索框右侧 clear 按钮（@e17）点击后没有清空输入内容，输入框仍保留 SQL 注入测试查询，URL 仍是 http://localhost:3000/items?q=%27+OR+1%3D1+--。
**证据**：./screenshots/screenshot-1774257264575.png
**快照引用**：@e16, @e17
**控制台错误**：无

## 2026-03-23 17:15:21 CST - 错误 @ http://localhost:3000/items?q=%27+OR+1%3D1+--
**页面**：Modular Admin
**描述**：/items 的 Sentiment 区域里 Negative 复选框（@e87）点击后依然保持未选中，结果列表、URL 与筛选状态均无变化，情绪筛选无法启用。
**证据**：./screenshots/screenshot-1774257314809.png
**快照引用**：@e20, @e87
**控制台错误**：无

## 2026-03-23 17:16:12 CST - 错误 @ http://localhost:3000/items
**页面**：Modular Admin
**描述**：/items 首条新闻标题按钮（@e89）点击后没有进入任何详情页，也没有展开详情或其他可见反馈，URL 仍保持 http://localhost:3000/items。
**证据**：./screenshots/screenshot-1774257363654.png
**快照引用**：@e88, @e89
**控制台错误**：无

## 2026-03-23 17:18:44 CST - 错误 @ http://localhost:3000/admin/settings/ingestion?panel=crawl-client
**页面**：Modular Admin
**描述**：/admin/settings/ingestion?panel=crawl-client 页面中 News source secrets 区域的 Add entry 按钮（@e39）点击后没有打开新增表单、抽屉或弹窗，也没有任何可见反馈。
**证据**：./screenshots/screenshot-1774257515029.png
**快照引用**：@e12, @e39
**控制台错误**：无

## 2026-03-23 17:19:42 CST - 错误 @ http://localhost:3000/admin/settings/ingestion?panel=news-source-runtime-secrets
**页面**：Modular Admin
**描述**：/admin/settings/ingestion?panel=news-source-runtime-secrets 页面顶部的 Access Settings 域按钮（@e30）点击后未跳转到任何 Access Settings 子路由，仍停留在当前 ingestion 设置页。
**证据**：./screenshots/screenshot-1774257571546.png
**快照引用**：@e28, @e30
**控制台错误**：无

## 2026-03-23 17:20:21 CST - 错误 @ http://localhost:3000/admin/settings/ingestion?panel=news-source-runtime-secrets
**页面**：Modular Admin
**描述**：/admin/settings/ingestion?panel=news-source-runtime-secrets 页面顶部的 Security & Governance 域按钮（@e31）点击后未跳转到任何安全设置子路由，仍停留在当前 ingestion 设置页。
**证据**：./screenshots/screenshot-1774257606268.png
**快照引用**：@e28, @e31
**控制台错误**：无

## 2026-03-23 17:21:20 CST - 错误 @ http://localhost:3000/admin/settings
**页面**：Modular Admin
**描述**：/admin/settings 根页中 Security & Governance 下的 Open domain 链接（@e43）点击后错误跳转到了 http://localhost:3000/admin/settings/ingestion?panel=news-source-runtime-secrets，而不是进入安全治理设置域。
**证据**：./screenshots/screenshot-1774257666577.png
**快照引用**：@e30, @e43
**控制台错误**：无

## 2026-03-23 17:22:16 CST - 错误 @ http://localhost:3000/admin/settings
**页面**：Modular Admin
**描述**：/admin/settings 根页中 Quick links 的 Knowledge graph review 链接（@e41）点击后没有进入任何知识图谱审核设置页，URL 仍保持 http://localhost:3000/admin/settings。
**证据**：./screenshots/screenshot-1774257726826.png
**快照引用**：@e28, @e41
**控制台错误**：无

## 2026-03-23 17:24:40 CST - 错误 @ http://localhost:3000/admin/settings/access?panel=roles
**页面**：Modular Admin
**描述**：/admin/settings/access?panel=roles 中空白角色表单点击 Create role（@e29）后没有显示任何必填校验提示、错误消息或字段高亮，页面状态保持不变。
**证据**：./screenshots/screenshot-1774257871405.png
**快照引用**：@e12, @e29, @e33, @e106
**控制台错误**：无

## 2026-03-23 17:25:40 CST - 错误 @ http://localhost:3000/admin/settings/security?panel=security
**页面**：Modular Admin
**描述**：/admin/settings/security?panel=security 中 Rate limit policies 区域的 New policy 按钮（@e18）点击后没有打开新策略表单、抽屉或弹窗，也没有任何可见反馈。
**证据**：./screenshots/screenshot-1774257933675.png
**快照引用**：@e17, @e18
**控制台错误**：无

## 2026-03-23 17:26:26 CST - 错误 @ http://localhost:3000/admin/settings/ai?panel=llm-gateway
**页面**：Modular Admin
**描述**：/admin/settings/ai?panel=llm-gateway 页面中的 New gateway 按钮（@e20）点击后没有打开新建网关表单、抽屉或弹窗，也没有任何可见反馈。
**证据**：./screenshots/screenshot-1774257980362.png
**快照引用**：@e14, @e20
**控制台错误**：无

## 2026-03-23 17:27:16 CST - 错误 @ http://localhost:3000/admin/settings/knowledge?panel=knowledge-graph-review
**页面**：Modular Admin
**描述**：/admin/settings/knowledge?panel=knowledge-graph-review 中首条待审关系的 Approve 按钮（@e90）点击后没有更新 Validation 状态、没有移除队列项，也没有任何成功反馈。
**证据**：./screenshots/screenshot-1774258029533.png
**快照引用**：@e44, @e45, @e90
**控制台错误**：无

## 2026-03-23 17:28:51 CST - 错误 @ http://localhost:3000/admin/settings/editorial?panel=news-prompts
**页面**：Modular Admin
**描述**：/admin/settings/editorial?panel=news-prompts 中 NewsNow personalization 区域的 Clear profile 按钮（@e47）点击后没有出现确认提示、成功消息，也没有任何指标变化。
**证据**：./screenshots/screenshot-1774258124043.png
**快照引用**：@e12, @e47
**控制台错误**：无

## 2026-03-23 17:39:21 CST - 错误 @ http://localhost:3000/admin/settings/integrations?panel=email
**页面**：Modular Admin
**描述**：/admin/settings/integrations?panel=email 页面中 Send test email 的 Recipient 输入框（@e66）执行填充后，实际被修改的是上方 Geocoding (Nominatim) 的 Email 字段（@e60），而 Recipient 仍保持 wei500l@163.com，表单输入目标发生错位。
**证据**：./screenshots/screenshot-1774258742556.png
**快照引用**：@e60, @e66
**控制台错误**：无

## 2026-03-23 17:40:05 CST - 错误 @ http://localhost:3000/admin/settings/integrations?panel=email
**页面**：Modular Admin
**描述**：/admin/settings/integrations?panel=email 中 Test geocoding 表单输入有效查询 New York / US 后点击 Test（@e64），页面没有出现任何查询结果、成功提示或错误提示，URL 与数据区域均无变化。
**证据**：./screenshots/screenshot-1774258790773.png
**快照引用**：@e62, @e63, @e64
**控制台错误**：无

## 2026-03-23 17:40:46 CST - 错误 @ http://localhost:3000/admin/settings/integrations?panel=email
**页面**：Modular Admin
**描述**：/admin/settings/integrations?panel=email 中 AKShare 区域点击 Refresh status（@e20）后，列表中所有已配置条目的 Latest status 仍全部为 Not available，没有任何成功提示或可用状态回填，状态刷新链路异常。
**证据**：./screenshots/screenshot-1774258832737.png
**快照引用**：@e17, @e20, @e87, @e93, @e99, @e105, @e111, @e117, @e123, @e129
**控制台错误**：无

## 2026-03-23 17:42:19 CST - 错误 @ http://localhost:3000/admin/settings/monitoring?panel=rss-diagnostics
**页面**：Modular Admin
**描述**：/admin/settings/monitoring?panel=rss-diagnostics 中 RSS Chain Diagnostics 的 Dry Run 按钮（@e122）点击完成后，没有生成任何干跑结果、摘要区域或成功提示，诊断表格内容保持不变。
**证据**：./screenshots/screenshot-1774258908531.png
**快照引用**：@e79, @e122
**控制台错误**：无
## $(date) - 错误 @ http://localhost:3000/admin/logs?tab=errors
**页面**：Modular Admin
**描述**：在 Logs > Errors 页面点击首条错误记录 `newsEventBrief (NewsEventBrief)` 的 `View` 按钮后，页面 URL 保持 `http://localhost:3000/admin/logs?tab=errors`，DOM 无任何新增明细抽屉/弹窗，无法查看错误详情。已执行一次点击后 re-snapshot，页面结构与点击前一致。
**证据**：./screenshots/screenshot-1774259182415.png
**快照引用**：点击前/后均为 @e238（首条 View 按钮），关联错误行 @e88 @e92 @e93
**控制台错误**：console 无新增输出；browser errors 仅存在历史遗留的 /events/[id] React #310 报错，与当前点击无直接关联。
## $(date) - 错误 @ http://localhost:3000/dashboard/key-monitor
**页面**：Modular Admin
**描述**：`/dashboard/key-monitor` 打开后核心聚合区持续显示 `Aggregation: Loading...`，额外等待 5 秒后仍未渲染完成。页面正文虽有 `Market Sentiment`、`Supply Chain Stability` 数值文本，但聚合图表/数据区一直停留在加载态，未出现完成后的可视内容，属于数据加载卡死。该现象与后台错误日志中多条 `GET /api/dashboard/financial-candlestick?...` 500 记录相互印证。
**证据**：./screenshots/screenshot-1774259242048.png
**快照引用**：时间范围控件 @e21 @e22 @e23 @e24 @e25 @e26 @e27 @e28 @e29，页面标题 @e6
**控制台错误**：console 无新增输出；browser errors 仍仅为历史遗留的 /events/[id] React #310 报错。
## $(date) - 错误 @ http://localhost:3000/dashboard/military-alert
**页面**：Modular Admin
**描述**：`/dashboard/military-alert` 打开并完成网络空闲后，正文仍显示 `Aggregation: Loading...`，聚合区没有渲染完成。页面仅能看到顶部时间范围与标题，核心数据区长期处于加载态。
**证据**：./screenshots/screenshot-1774259272684.png
**快照引用**：标题 @e6，时间控件 @e21 @e22 @e23 @e24 @e25 @e26 @e27 @e28 @e29
**控制台错误**：console 无新增输出；browser errors 仅有历史遗留的 /events/[id] React #310 报错。

## $(date) - 错误 @ http://localhost:3000/dashboard/economic-alert
**页面**：Modular Admin
**描述**：`/dashboard/economic-alert` 在 `wait --load networkidle` 后又额外等待 3 秒，正文仍保留 `Aggregation: Loading...`，聚合图表/数据区未完成渲染，属于数据加载卡死。
**证据**：./screenshots/screenshot-1774259294291.png
**快照引用**：标题 @e6，时间控件 @e21 @e22 @e23 @e24 @e25 @e26 @e27 @e28 @e29
**控制台错误**：console 无新增输出；browser errors 仅有历史遗留的 /events/[id] React #310 报错。
## $(date) - 错误 @ http://localhost:3000/dashboard/economic-short
**页面**：Modular Admin
**描述**：`/dashboard/economic-short` 在 network idle 且额外等待 3 秒后仍显示 `Aggregation: Loading...`，聚合区没有渲染完成，核心数据内容长期不可用。
**证据**：./screenshots/screenshot-1774259327325.png
**快照引用**：标题 @e6，时间控件 @e21 @e22 @e23 @e24 @e25 @e26 @e27 @e28 @e29
**控制台错误**：console 无新增输出；browser errors 仅有历史遗留的 /events/[id] React #310 报错。
## $(date) - 错误 @ http://localhost:3000/dashboard/economic-short
**页面**：Modular Admin
**描述**：`/dashboard/economic-short` 在 network idle 且额外等待 3 秒后仍显示 `Aggregation: Loading...`，聚合区没有渲染完成，核心数据内容长期不可用。
**证据**：./screenshots/screenshot-1774259327325.png
**快照引用**：标题 @e6，时间控件 @e21 @e22 @e23 @e24 @e25 @e26 @e27 @e28 @e29
**控制台错误**：console 无新增输出；browser errors 仅有历史遗留的 /events/[id] React #310 报错。
