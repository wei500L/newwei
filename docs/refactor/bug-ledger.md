# 缺陷台账（Bug Ledger）

> 生成时间：2026-09-03 · 基线 commit `95759f59` · 修复提交至 `edf0c8cf`
> 审计方法：5 路并行代码勘察（API 契约 / 鉴权安全 / 队列拓扑 / vector 服务 / 前端 IA）+ 主线逐项复核。**标注「已复核」的条目经主线二次验证（文件:行号 亲验）；其余为单路勘察结论，修复前需按同一标准复核。**
> 规则：先证据后修复；每条修复必须可独立回滚；不制造假测试。

## 0. 字段与级别说明

- **严重级别**：P0 阻断发布/门禁失效/数据泄漏 · P1 核心功能受损 · P2 体验/性能/工程化
- **状态**：✅ 已修复（含回归验证）· 🔧 已修复待运行时验证 · 🔶 部分改善 · ⬜ 开放 · 👁 观察项

## 1. 七条关键用户流程覆盖

| # | 流程 | 本轮涉及条目 |
|---|---|---|
| F1 | 认证与会话（login/MFA/OIDC/refresh/机器令牌） | BL-04/BL-08（构建期）· SEC-01~04 · API-01 |
| F2 | 新闻采集与入库（调度→抓取→处理→聚类→索引→向量） | SEC-01/02（向量链路）· BAPI-01 |
| F3 | 信息浏览与检索（items/search/newsnow/reader/公共门户） | BAPI-01 · FE-01 |
| F4 | 态势与分析（dashboard/war-map/situation-monitor/analysis） | BL-01（war-map 等组件 lint 内）· FE-01 |
| F5 | 告警与通知（规则/事件/投递/WS） | BAPI-01（alerts 列表） |
| F6 | 管理与运维（admin/crawl/system-settings/RBAC/可观测） | BL-02/03/09 · SEC-03 · API-01 |
| F7 | 个性化与个人工作台（user-settings/digest/subscriptions/onboarding） | API-01 · FE-02/03 |

## 2. 总览

| ID | 级别 | 一句话 | 状态 | 修复提交 |
|---|---|---|---|---|
| BL-01 | P0 | web 35 处 lint 错误，CI 门禁失效 | ✅ | 4210e892 |
| BL-02 | P0 | CI 中 packages 未先构建致 import 解析失败 | ✅ | abed388d |
| BL-03 | P0 | db/mongo typecheck 必挂（tsconfig paths 矛盾） | ✅ | abed388d |
| BL-04 | P1 | Edge Runtime 拒绝 tracing.ts 的 eval("require") | ✅ | b25583e9 |
| BL-05 | P2 | 根脚本 pnpm codegen 损坏 | ✅ | abed388d |
| BL-06 | P2 | codegen 无 CI 门禁（漂移不可检测） | ✅ | abed388d |
| BL-07 | P2 | 提交版 generated.ts 与 schema 漂移 | ✅ | abed388d |
| BL-08 | P1 | RSC 引入 react-i18next 致 build 崩（createContext） | ✅ | b25583e9 |
| BL-09 | P0 | api 32 处潜伏 lint 错误（turbo 取消效应掩盖） | ✅ | 0aef412c |
| API-01 | P1 | onboarding 端点缺权限元数据，引导状态永不保存 | 🔧 | edf0c8cf |
| SEC-01 | **P0** | 任意 org 管理员可改**全局** vector 服务配置（token 外泄链） | 🔧 单元级 CI 已验证；真实登录态未验证 | 本轮（见 §4） |
| SEC-02 | P1 | vector 服务信任请求体 orgId（跨租户读写前提） | 👁 | — |
| SEC-03 | P2 | /api/metrics 全局数据未按 org 过滤 | ✅ | 本批（见 §4） |
| SEC-04 | P2 | vector 内部 token 非常量时间比较 | ✅ | 见 §4 |
| BAPI-01 | P2 | GraphQL 列表无分页（全量返回） | ⬜ | — |
| FE-01 | P2 | alert-center 过滤器不入 URL（与全局模式不一致） | ✅ | PR #4（FE-批3，run 33849497917） |
| FE-02 | P2 | 死代码：zustand store/sidebar.ts | ✅ | 见 §3 |
| FE-03 | P2 | vitest coverage include 仅覆盖 3 个已测文件（覆盖率数字失真） | 🔶 | 部分（include 8→22→约 40（Alert Center 9→32），见 §3） |
| CI-01 | P2 | OpenAPI 快照生成非确定性：同一 SHA 无 API 变更时 resolved schema 可能降级为 x-unresolved-schema | ✅ | PR #12（见 §3，根因已证：createParamDecorator 随机 uid 键被 parseInt 误读） |
| WM-RT-01 | P1 | War Map retry 重建后新 Deck overlay 丢失业务图层（FE-批4A 拆分引入，合并前修复） | ✅ | PR #6 第二轮（见 §3） |
| WM-RT-02 | P1 | War Map standalone 底部 Drawer 点击内部控件即被误关（非 minimal 密度） | ✅ | PR #6 第二轮（见 §3） |
| FE-A11Y-01 | P2 | War Map legend 聚焦徽标硬编码英文 "Focus"（中文界面遗留英文） | ✅ | PR #7（FE-批4B，见 §3） |
| FE-A11Y-02 | P2 | War Map legend section 折叠按钮缺 aria-expanded/aria-controls | ✅ | PR #7（FE-批4B，见 §3） |
| FE-DD-01 | P3 | war-map-geometry.ts 两个零消费导出（splitDeckPathSegments/buildSanitizedPathFeatures，批4A 遗留） | ✅ | FE-批4B 合并后收口 PR（见 §3） |
| FE-TPL-01 | P1 | Create Drawer defaultTemplateKey 持续回写：用户主动选模板被立即改回 news | ✅ | FE-批5B（见 §3） |
| FE-A11Y-03 | P2 | Create Drawer 模板选择器为 Card+onClick，无键盘语义/选中可访问状态 | ✅ | FE-批5B（见 §3） |
| FE-SUBMIT-01 | P2 | Create Drawer loading 期间 Enter/表单 submit 仍可重复触发 onSubmit | ✅ | FE-批5B（见 §3） |
| FE-I18N-02 | P2 | Create Drawer 域 3 个 i18n 键缺失/丢插值占位符（reutersCf×2、jsStep 序号） | ✅ | FE-批5B（见 §3） |
| FE-TPL-02 | P3 | Create Drawer proxy 告警分支不可达：undefined 键被 hasOwn 计入，恒为 error 级 | ⬜ | 开放（FE-批5B 登记，见 §4） |
| FE-RT-01 | P1 | realtime-signals 初始 GET 失败后以 EMPTY_SETTINGS 填充表单并允许保存——默认值可覆盖未知持久化配置 | ✅ | FE-批6A（见 §3） |
| FE-RT-02 | P2 | realtime-signals Save/Reset 无 handler 层互斥：表单 submit 路径可重复 PUT，PUT 与 DELETE 可并发 | ✅ | FE-批6A（见 §3） |
| FE-RT-03 | P2 | realtime-signals diagnostics 加载失败污染 settings 域：错误横幅挂在整个页面，与设置加载失败无法区分 | ✅ | FE-批6A（见 §3） |
| SEC-05 | **P0** | 4 组全局治理设置写接口只要求 `settings.manage`：任一租户管理员可改全平台 MFA 策略/助手配额/内容审核护栏/LLM 日志保留期 | 🔧 待远端验证（本轮，见 §7） |
| TTL-01 | P1 | `tasklogs` 集合不存在时 PUT/DELETE `/task-logs` 返回 500（NamespaceNotFound 26 未按空索引列表处理） | 🔧 待远端验证（本轮，见 §7） |
| CONC-01 | P1 | `llm-request-logs` 部分 PUT 以进程内 30 秒旧缓存为合并基准且无互斥，会悄悄回滚他人写入 | 🔧 待远端验证（本轮，见 §7） |
| AS1 | **P0** | 机器令牌轮换先撤销后创建、无原子事务：创建失败旧凭证已被撤销，并发轮换可留下多个有效 successor | ✅ Nest 与 Go 两侧已修复；普通 CI 与真实栈 smoke 均已远端验证（见 §8） | 本轮（见 §8） |
| AS2 | **P0** | 并发修改密码可覆盖另一个已成功提交的密码修改（事务内仅按 id 更新） | ✅ Nest 与 Go 两侧已修复；普通 CI 与真实栈 smoke 均已远端验证（见 §8） | 本轮（见 §8） |
| AS3 | P1 | profile 字段显式 null 穿过 `@IsOptional` 后触发 `.trim()` 500；机器身份更新不存在 User 也 500 | ✅ Nest 与 Go 两侧已修复；普通 CI 与真实栈 smoke 均已远端验证（见 §8） | 本轮（见 §8） |
| AS4 | P1 | 机器令牌 `createdById` 直接写入 `machine:<id>` 触发 User 外键 1452；DTO `MinLength(1)` 在 trim 前判断，空白名称可入库 | ✅ Nest 与 Go 两侧已修复；普通 CI 与真实栈 smoke 均已远端验证（见 §8） | 本轮（见 §8） |

## 3. 已修复条目（详细）

### BL-01 web lint 35 处错误 — ✅ 已修复【已复核】

- **流程/影响**：全流程（构建门禁）。CI 自 2026-08-15 引入从未绿过，主因之一。
- **复现**：基线 commit 上 `pnpm lint` → `@modular/web#lint` exit 1。
- **根因**：19 import/order + 10 array-type（自动修复）；6 unused-vars（analysis-workspace 的 Avatar/allTasks、war-map-symbols 的 mapStrokePath、war-map 的 readSummaryBoolean、access-settings 的 roles、realtime-signals 死变量）。
- **证据**：/tmp/web-lint-full.log（基线存档）；baseline.md §3.4。
- **修复**：`4210e892`（25 文件，含 eslint --fix 回归 TS1361 的 useEconomicData.ts 手工修正）。
- **回归验证**：CI gate `pnpm lint`（现全绿；run 33729250187 success）。

### BL-02 CI 构建顺序 — ✅ 已修复【已复核】

- **根因**：`packages/utils` 的 main/types 指向 dist/；CI 全新安装 lint 先于 build 执行 → import/no-unresolved ×16。
- **修复**：`abed388d` turbo.json：`lint.dependsOn:["^build"]`、`typecheck.dependsOn:["^typecheck","^build"]`。
- **回归验证**：CI run 33729250187（Node 20 干净环境）success。

### BL-03 db/mongo typecheck — ✅ 已修复【已复核】

- **根因**：`tsconfig.build.json` 显式 `"paths":{}` 覆盖了 tsconfig.json 的 `@modular/config`/`@modular/utils` 源码映射，而这两个包无 dist → TS2307。
- **修复**：`abed388d` 新增 `packages/{db,mongo}/tsconfig.typecheck.json`（paths 指向 src，参照 api/vector 先例），typecheck 脚本改用之。
- **回归验证**：`pnpm typecheck` 14/14 tasks ✅。

### BL-04 Edge Runtime eval — ✅ 已修复【已复核】

- **流程/影响**：F1（middleware 鉴权链）。web 生产构建失败 → 无法出包。
- **复现**：基线 `pnpm build` → `Dynamic Code Evaluation not allowed in Edge Runtime`（链路 middleware.ts → lib/auth.ts → lib/env.server.ts → @modular/utils → tracing.js）。
- **根因**：`packages/utils/src/tracing.ts:30` 用 `eval("require")` 动态加载 node:async_hooks；运行时有守卫但 webpack **静态检测**即拒绝。
- **修复**：`b25583e9` 改用 `process.getBuiltinModule("node:async_hooks")`（Node ≥20.16，打包器不可静态解析；CI Node 20.16+ 需确认——见 §6 风险）。
- **回归验证**：`pnpm build`（middleware 141 kB 产出）+ CI success。

### BL-05/06/07 codegen 三联 — ✅ 已修复【已复核】

- **BL-05**：根 `pnpm codegen` 指向不存在于根依赖的二进制 + 失效 codegen.yml（指向 localhost:4000 活体）→ 改指 `@modular/web run generate`、删除 codegen.yml、README 同步。
- **BL-06**：CI 无 drift 检查 → ci.yml 新增 `generate && git diff --exit-code apps/web/graphql/generated.ts`。
- **BL-07**：提交版 generated.ts 的 QueueStatsDocument 缺 `countsAvailable`（与同文件 TS 类型不一致，手改嫌疑）；消费方 system-health-context.tsx:205 → 重新生成提交。
- **回归验证**：CI 内建 drift gate + 本地 generate 后无 diff。

### BL-08 RSC 引入 react-i18next — ✅ 已修复【已复核】

- **流程/影响**：全流程（root layout 渲染）。build "Collecting page data" 阶段 `TypeError: createContext is not a function`。
- **根因**：`app/layout.tsx`（Server Component）→ `lib/i18n.ts` 顶层 import react-i18next → 其模块作用域调用 `React.createContext`（react-server 条件无此 API）。
- **修复**：`b25583e9` 拆分 `lib/i18n.ts`（服务端安全）与 `lib/i18n-client.ts`（"use client"），更新 4 个引用点。
- **回归验证**：`pnpm build` 全路由出包 + CI success。
- **教训**：与 BL-04 同为「门禁从未跑到」的潜伏失败——**修复一层后会暴露下一层**，分层修复后必须整链复跑。

### BL-09 api 32 处潜伏 lint — ✅ 已修复【已复核】

- **根因**：turbo 失败即取消：web lint 先挂 → api lint 被取消从未上报（基线报告初版误记为「通过」，已勘误）。
- **修复**：`0aef412c`（28 import/order + 1 array-type 自动；settings.resolver 两个退化映射改穷尽 switch；socket-error-payloads 删未用导入）。
- **回归验证**：`pnpm lint` 全绿（仓库首次）+ CI success。

### API-01 onboarding 死路由 — 🔧 已修复（契约测试 CI 已验证；真实用户流程未验证）【已复核】

- **流程**：F7 个性化。**用户影响**：新用户引导完成状态永不保存——每次进入应用重新触发引导（welcome/onboarding-boundary 消费）。
- **复现**：登录态 `GET/PUT /api/user-settings/ui/onboarding` → 403 `PERMISSION_METADATA_MISSING`（全局 PermissionsGuard fail-closed）。
- **预期/实际**：预期返回/更新 per-user 引导状态；实际恒 403。
- **根因**：两个 handler 缺 `@Permissions` 装饰器（同 controller 其余 10 个端点均有）。
- **证据**：`user-ui-settings.controller.ts:110,116`（修复前）；前端 `onboarding-boundary.tsx:67,98`。
- **修复**：`edf0c8cf` 补 `@Permissions("items.read")`（与 5 组兄弟端点一致）。
- **本轮静态闭环复核（全链路）**：
  1. 权限元数据 ✅：GET/PUT 均带 `@Permissions("items.read")`（鉴权矩阵生成器 fail-closed 断言全库 0 死路由）。
  2. 上下文来源 ✅：orgId/userId 均取自 `@CurrentUser()`（JWT orgId claim → membership 重推导），无请求体信任。
  3. 前后端一致性 ✅：前端 `ONBOARDING_SETTINGS_PATH = "user-settings/ui/onboarding"` + axios baseURL（`/api` 前缀）→ 后端 `@Controller("user-settings/ui")` + 全局前缀；PUT 体 `{ settings: ... }` 与 DTO 唯一字段一致；GET 响应 envelope（version/updatedAt/settings）与前端类型镜像一致。
  4. 无保存后查询不到的字段差异 ✅：存储键 `ui:onboarding:settings:v1`（per org+user+key 唯一），normalize 白名单四步键（today/events/map/finance）两侧一致。
  5. 错误吞掉风险 ⚠️（登记，未改）：前端 `persistSettings`/GET 的 catch 只上报 telemetry（captureClientError），无用户可见提示——这正是原 403 长期不可见的原因。属前端 IA 重构（onboarding-boundary 拆分批次）处理项，不在本轮范围强行加 UI。
- **回归验证**：`user-ui-settings.controller.test.ts` 锚定 controller→service 契约（远端 CI 已验证，4/4，run 33748591315）；鉴权矩阵 CI 断言权限元数据存在（四态语义：无权限 JWT denied / 有权限 allowed / wrongOrg runtime-required）。⚠️ **真实用户流程（登录→完成引导→刷新不重现）未验证**——CI 无数据库栈，需部署环境冒烟。

### WM-RT-01 War Map retry 重建后新 overlay 丢失业务图层 — ✅ 已修复（合并前，PR #6 第二轮）【静态审查发现 · 红→绿远端验证】

- **流程**：F4 态势与分析。**用户影响**：地图加载错误点击 Retry 后底图恢复，但业务图层/tooltip/cursor 为空，直到下一次数据、hover 或选中变化才恢复。
- **触发链（FE-批4A 拆分引入）**：`useWarMapRuntime.setOverlayProps` 在 `deckOverlayRef.current` 为空时直接丢弃 props（旧实现 early return）→ retry（`mapMountNonce` 变化）销毁旧 runtime 并创建新 overlay → `useWarMapLayers` 的 overlay props effect 依赖（deckData/tooltip/cursor/renderable）均未变化、不感知 runtime 世代 → 新 overlay 永远收不到上一份 props。
- **既有测试盲区**：retry 测试只断言旧实例销毁/新实例创建，不校验新 overlay 的 props。
- **修复**：`useWarMapRuntime` 成为 overlay props 唯一持有者——`latestOverlayPropsRef` 无论 overlay 是否存在都保存最新 props；runtime 创建 effect 在写入 `deckOverlayRef` 后立即回放。`useWarMapLayers` 不感知 runtime 世代，根组件不暴露 generation 补丁；不可渲染容器传空 layers 的语义不变。
- **回归验证**：行为级红→绿——红灯测试（retry 后按第二个 overlay 身份断言恢复最后一份 layers/getTooltip/getCursor，不依赖数据/交互变化）先独立提交，远端 run 33945984922 唯一失败即该测试（`expected undefined to be defined`，Lint/Typecheck 均过）；修复后 run 33946342887 全绿。仅 jsdom 行为级验证，未做真实浏览器 Retry 操作。

### WM-RT-02 standalone 底部 Drawer 点击内部控件即被误关 — ✅ 已修复（合并前，PR #6 第二轮）【新行为测试暴露】

- **流程**：F4 态势与分析（`/map` standalone 页）。**用户影响**：非 minimal 密度（如桌面视口）下打开 controls Drawer 后，点击 Drawer 内任何控件（切换 Transport、checkbox 等）都先触发 rail 外 mousedown 误关 Drawer，面板打开后无法操作。
- **根因**：interaction hook 的「面板外 mousedown 关闭」效应只按 `useDrawerControls`（minimal 密度）豁免；standalone 布局的底部 Drawer 同样渲染在 rail 之外且效应仍激活。embedded 内联面板渲染在 rail 内不受影响——此前无任何 Drawer 内点击的测试覆盖，属 FE-批4A 之前即存在的行为（拆分时原样迁移）。
- **修复**：hook 选项 `useDrawerControls` 改为 `overlayPanelsInDrawer`（编排层计算 `standaloneLayout || useDrawerControls`）——效应仅在面板以 inline 形式渲染于 rail 内时激活；Drawer 场景关闭语义由 Drawer mask（antd onClose）唯一负责。
- **回归验证**：新增 standalone「打开完整图例」行为测试（Drawer 内连续点击 → 保持可操作 → 关闭 Drawer + 下一帧 scrollIntoView）在旧实现上远端失败（run 33947812370，找不到 Open full legend 按钮——Drawer 已被误关）；修复后通过。另新增 embedded 回归锁（rail 外 mousedown 关闭 inline 面板）。仅 jsdom 行为级验证。

### FE-A11Y-01 / FE-A11Y-02 War Map legend 聚焦徽标硬编码与折叠按钮缺 aria 状态 — ✅ 已修复【PR #7（FE-批4B）】

- **现象 1（FE-A11Y-01）**：war-map-controls-panel.tsx LegendItemsGrid 的 pinned 徽标 `endAdornment` 硬编码英文 `"Focus"`（原实现第 343 行），中文界面下聚焦徽标遗留英文。
- **修复 1**：新增 i18n 键 `dashboard.charts.warMap.legend.focusBadge`（en: "Focused" / zh: "已聚焦"），t 全链路传递；组件行为测试锁定徽标经 t() 解析，en/zh 键值配对由独立 locale 测试锁定。
- **现象 2（FE-A11Y-02）**：legend section 折叠按钮为原生 button 但无 `aria-expanded`/`aria-controls`，展开状态对辅助技术不可表达。
- **修复 2**：`LegendSectionCard` 折叠按钮补 `aria-expanded`（受控）与 `aria-controls`（`useId()` 前缀 + section key 生成稳定唯一 id，受控区域 `<div id>` 真实渲染）；行为测试断言折叠前后 aria 状态翻转与受控区域存在性。
- **验证**：仅 jsdom 行为级验证；屏幕阅读器实测未做（部署环境人工验收项）。

### FE-DD-01 war-map-geometry.ts 两个零消费导出 — ✅ 已处理【FE-批4B 合并后收口 PR】

- **证据（静态引用审查）**：`rg` 全仓核对 `splitDeckPathSegments` / `buildSanitizedPathFeatures`——除定义处（war-map-geometry.ts 原第 129/170 行）外零命中：无生产调用、无测试调用、无 re-export（全仓无 `export *`）、无动态名称引用；唯一 import 该模块的生产文件 war-map-static-vector-layers.ts 实际消费的是 `buildSanitizedPathGeometry` / `buildSanitizedPolygonResult` / `isValidDeckCoordinate` / `DeckCoordinate`。两者均为对内部实现的一行投影包装（`.segments` / `.pathFeatures`）。
- **处理**：删除两个包装导出（war-map-geometry.ts 277 → 267 行）；底层实现 `splitDeckPathGeometry` / `buildSanitizedPathGeometry` 保持不动（前者仍被模块内两处调用，后者仍被 static-vector-layers 消费）；无死类型或死 import 随之产生（DeckCoordinate / SanitizedDeckPathFeature / WarMapLayerFeature 均仍有消费者）；polygon/path 消毒行为不变。
- **验证方式**：仅静态引用审查 + 远端 CI（lint/typecheck/web 测试/构建）；无运行时行为变化（删除的是零调用代码，不属可运行验证范畴）。

### FE-RT-01：realtime-signals 初始 GET 失败后以 EMPTY_SETTINGS 填充表单并允许保存 — ✅ 已修复【FE-批6A 静态审查发现】

- **现象**：面板初始 `GET system-settings/realtime-signals` 失败（网络错误/5xx）时，
  旧实现 catch 分支执行 `setSettings(EMPTY_SETTINGS)` + `form.setFieldsValue(toFormValues(EMPTY_SETTINGS))`——
  用户看到的是一份完整、可编辑、带默认值的「配置」，Save 按钮可用。用户保存即以
  默认值 PUT 覆盖服务器上未知的持久化配置（或对 env 配置产生一次无意义写入）。
- **根因**：`loadSettings` 的 catch 分支把「加载失败」与「加载成功但字段缺省」混同，
  EMPTY_SETTINGS 同时承担「安全补全默认值」与「失败兜底」两个职责。
- **修复**：`use-realtime-signals-settings.ts` 引入三态 `loadState`
  （initialLoading / blockingError / ready）：settings 为 null 且 GET 失败 →
  blockingError，根编排层不渲染 Form（Save/Reset 不可达），提供 Retry；Retry 成功
  后以真实响应初始化表单。EMPTY_SETTINGS 仅经 `mergeSettingsDefaults` 用于成功响应
  字段补全。已有真实数据后的刷新失败保留旧数据 + 非阻断警告（不满足阻断条件）。
- **验证**：远端 jsdom（初始 GET 失败 → 无 Save/Reset、出现 Retry；Retry 成功 →
  表单出现）；真实浏览器/真实后端未验证。

### FE-RT-02：realtime-signals Save/Reset 无 handler 层互斥 — ✅ 已修复【FE-批6A 静态审查发现】

- **现象**：旧实现仅靠按钮 loading/disabled 防重复。Form 的 onFinish 直连
  `handleSubmit`——表单 submit 事件（Enter/编程式 submit）不经过按钮，saving 期间
  可再发一次 PUT（与 FE-SUBMIT-01 同类）；Reset 按钮仅 `disabled={saving}`，
  saving 期间 Modal 已弹出时确认仍可触发 DELETE 与 PUT 并发。快速双击在 loading
  状态提交前亦可产生两次 PUT。
- **修复**：`useRealtimeSignalsOperationGate`（useRef + state）：同一时刻最多一个
  save/reset 操作；`save`/`reset` 入口先 `begin`（占用失败直接 return），
  finally 中 `end` 释放；确认弹窗取消路径同样释放门禁（否则 Reset 永久锁死）。
- **验证**：远端 jsdom（挂起 PUT 期间连点三次 submit → 仅一次 PUT）；
  Save/Reset 并发与真实网络条件未验证。

### FE-RT-03：realtime-signals diagnostics 加载失败污染 settings 域 — ✅ 已修复【FE-批6A 静态审查发现】

- **现象**：旧实现两个数据域共享一个页面级渲染树：diagnostics GET 失败只显示错误
  Alert（可接受），但错误横幅与 settings 的 errorMessage 渲染在同一层级，且
  diagnostics 与 settings 初次加载失败都表现为「页面顶部一条 Alert」——用户无法
  区分「配置加载失败（不能保存）」与「运行时诊断加载失败（可以继续保存）」；
  diagnostics 的刷新按钮也无法从视觉上与设置表单状态解耦。
- **修复**：`use-realtime-signals-diagnostics.ts` 独立状态域（loading/error/
  diagnostics），错误 Alert 连同独立 Retry 收敛进 runtime 诊断 Card 内部；settings
  表单照常渲染。初始并行加载保持（两个 hook 各自挂载即发起）。
- **验证**：远端 jsdom（diagnostics GET 拒绝 → 表单仍在、诊断区错误可见）；
  真实浏览器未验证。

## 4. 开放条目（待修复，按优先级排序）

### SEC-01 全局 vector 配置可被任意 org 管理员改写 — 🔧 已修复（单元级 CI 已验证；真实登录态未验证）【已复核】

- **流程**：F1/F2/F6。**用户影响**：跨租户向量数据读写 + 内部 token 外泄（多租户隔离破坏）。
- **攻击链**：① org-A 管理员（有 settings.manage）`PUT /api/system-settings/vector-service` 改 `baseUrl` 为攻击者服务器（该设置是**全局单例**，非 per-org）→ ② api 的 vector-client 向攻击者服务器发请求，**携带真实 `x-internal-token`**（token 外泄）→ ③ 攻击者用窃取的 token 调真实 vector 服务，配合 SEC-02（body orgId 任意填）读写任意 org 的向量。
- **证据**：`system-settings/vector-service-settings.controller.ts:33-40`（PUT 仅 `@Permissions("settings.manage")`——per-org 权限写全局设置）；`packages/vector-client/src/client.ts:127-131`（发送 x-internal-token）。
- **修复（本轮）**：PUT 与 DELETE handler 首行注入 `platformAccess.assertPlatformAdmin(user.id)`——复用 audit-log/email/task-log 设置控制器的既有模式（不新建第二套平台管理员判断）。GET 与 GET /diagnostics 保持 `settings.manage` 读取语义（合法内部调用与运维可观测不受影响）。
- **网络白名单（设计建议，未实施）**：baseUrl 修改后的网络边界加固（SSRF 白名单/私网段拦截）依赖部署拓扑（内网 DNS、服务网格策略各异），凭空硬编码可能破坏内网部署——建议方向：① 部署侧用 NetworkPolicy/egress 白名单限制 api 出口到 vector 服务网段；② 应用侧可选 `VECTOR_SERVICE_ALLOWED_BASE_URLS` 显式允许清单（平台管理员维护）。本轮只登记，不实施。
- **回归验证**：`vector-service-settings.controller.test.ts`（vitest，CI 执行）覆盖：非平台管理员的 settings.manage 持有者 PUT/DELETE → 403 且 service 未被调用；平台管理员 PUT/DELETE 正常；GET 不做平台校验（读取兼容）。**运行时（真实 DB/登录态）验证仍待远端集成环境**。
- **状态**：✅ 单元级远端 CI 已验证（run 33748591315：vitest 6/6——非平台管理员 403 / 平台管理员通过 / GET 无平台门禁）。⚠️ **真实数据库登录态冒烟（登录→PUT→403）未验证**（CI 无 DB 栈）。攻击链①（权限入口）已关闭，②的出口（baseUrl 指向）网络层建议见上。

### SEC-02 vector 服务信任请求体 orgId — 👁 观察项【勘察报告】

- **流程**：F2。**用户影响**：持内部 token 的调用方可指定任意 orgId 读写该 org 向量（多租户边界依赖上游自觉）。
- **证据**：`apps/vector/src/modules/vector/vector.controller.ts`（orgId 取自 body，Qdrant filter.must[0]）；audit-report BoundaryContract 项开放中。
- **决策记录（2026-09-03）**：Go 试点（apps/vector-go）保持同构——orgId 仍来自请求体，因为该服务的定位是**内部信任边界后的纯执行器**（调用方仅 apps/api，orgId 由其服务端推导）。真正的修复点在 SEC-01（防止外部因素劫持调用链）。若未来出现第二调用方，需引入按调用方身份推导 orgId 的接口约定。
- **注**：现实风险 = SEC-01 的后置条件；SEC-01 关闭后此项降级为架构约束记录。

### SEC-03 /api/metrics 未按 org 过滤 — ✅ 已收紧为平台级读取

- **流程**：F6。**用户影响**：持 metrics.read 的普通组织成员，以及普通组织管理员创建的机器令牌，原先可以读取进程级和跨组织聚合指标。
- **证据**：`modules/observability/metrics.controller.ts` 的 `renderPrometheusMetrics()` 返回 prom-client 全局注册表（HTTP、后台任务、调度器，以及带 `org_id` 标签的 `pipeline_metric_value`）。没有独立的平台采集账号表。机器令牌行在 `MachineAccessToken`，必带 `orgId`，创建者是 `createdById`；唯一的平台身份是 `GlobalRoleAssignment.role = platform_admin`。
- **定位**：保持端点为平台级全量指标，不把输出滤成残缺的组织指标。`metrics.read` 仍由 PermissionsGuard 要求，但不再充分。
- **人类**：`platformAccess.assertPlatformAdmin(user.id)`，查的是 `GlobalRoleAssignment`，不看 JWT 里的 permissions 或 globalRoles。
- **机器令牌**：用 bearer 的 SHA-256 再查 `MachineAccessToken`。不看 `mtk_` 前缀，也不看令牌上的权限 JSON 来判断平台身份。允许条件是 `createdById` 当前仍有 `platform_admin`。`createdById` 为空、令牌撤销/过期、组织停用，或创建者不是当前平台管理员，一律 403。普通组织管理员创建或轮换后仍指向该管理员的旧令牌因此不能读全局指标。种子管理员本身是平台管理员，其创建的令牌在其仍持有该角色时可以继续采集。要新增采集主体，由当前平台管理员再创建一枚机器令牌。轮换复制原来的 `createdById`，授权跟着创建者的当前角色，不跟着谁拿着新密钥。
- **回归**：`metrics.controller.test.ts` 覆盖普通 metrics.read 用户、普通组织机器令牌（含创建者已清空）、以及创建者当前为平台管理员的机器令牌（密钥不必带 `mtk_` 前缀）。鉴权矩阵把该 GET 标成 handler 平台校验。

### SEC-04 vector 内部 token 非常量时间比较 — ✅ 已修复【已复核】

- **证据**：`apps/vector/src/modules/internal-auth/internal-auth.guard.ts:22-29`（`===` 比较）；对照：litellm guard 用 `crypto.timingSafeEqual`（`common/internal-token.ts`）。
- **修复**：NestJS 版（`internal-auth.guard.ts`）与 Go 试点（`apps/vector-go/internal/httpapi/server.go` 的 `requireInternalToken`，`crypto/subtle.ConstantTimeCompare`）均已改为常量时间比较。**回归验证**：vector 11/11 测试 + vector-go 行为测试全过；lint/typecheck/build 绿。
- **注**：长度不同的短路（先比 byteLength）是可接受泄漏——token 长度由部署方控制。

### BAPI-01 GraphQL 列表无分页 — ⬜ P2【已复核】

- **流程**：F3/F5。**用户影响**：数据量增长后 alerts/newsEvents 查询内存与时延线性恶化；审计报告遗留项，确认仍开放。
- **证据**：`alerts.resolver.ts:29,49`（alertChannels/alertRules 全量返回）；`news-events.resolver.ts:80-105`（仅 limit 1..100 clamp，无 cursor/offset）。
- **修复方向**：契约演进（加可选分页参数、默认值保持现状）——属 schema 变更，走版本化并更新契约清单；**Go 迁移前不动**，避免双实现期契约漂移。

### FE-01 alert-center 过滤器不入 URL — ✅ 已修复（远端 CI 已验证；真实浏览器未人工操作）【已复核】

- **证据**：items/search/events 页过滤器全量 URL 同步；alert-center 自成一套内存态（alert-center.tsx 仅 eventId 进 URL，`searchParams.get("eventId")`）。**用户影响**：告警视图不可分享/不可刷新恢复。
- **修复（PR #4 / FE-批3）**：落地通用 `hooks/use-url-state.ts` + `lib/url-state-codec.ts`（类型安全、codec 注入、无业务耦合）；Alert Center 十参数契约（severity/status/provider/q/range/from/to/page/pageSize/eventId）经 `alerts/alert-center-url-state.ts`（纯 codec）与 `alerts/hooks/use-alert-center-url-state.ts`（组合层，220ms keyword debounce）接入。默认值不写入 URL；非法值安全回退且不改写 URL；未知参数保留；写回 router.replace；筛选变化 page 重置 1；URL eventId 自动定位页码。
- **回归验证**：URL codec round-trip / 默认省略 / 数组去重排序 / 非法日期反向日期 / 保留未知参数与 eventId / debounce / URL 外部变化（back/forward）/ 无 mount 写入 / 无循环写回 / filter-page-eventId 优先级，均由远端 CI 执行（见 PR #4）；真实浏览器 back/forward 未人工操作。
- **验证状态**：远端 CI 全绿（最终 run 33857305521 @ 966b6b0f；PR #4 已合并进 main，合并提交 b9669b2b，main 合并后 CI run 33858778995 success）——lint/typecheck/组件测试(含 URL round-trip 全矩阵)/契约 drift/build 全部通过；真实浏览器 back/forward 与视觉未人工操作（需部署环境）。

### FE-02 死代码 store/sidebar.ts — ✅ P2【已修复（静态验证）】

- **修复**：FE-批2 IA 重构时删除（`rg "useSidebarStore|SidebarState|store/sidebar"` 全仓零引用——仅自身定义命中；crawl-frontier-console 的 `.sidebar` 为无关 CSS 选择器字符串）。导航状态已由 navigation-model / use-navigation 单一真源承载。
- **回归防护**：残留引用由 typecheck 拦截（删除文件后任何 import 即编译失败，远端 CI `tsc --noEmit` 必红）。

### FE-03 vitest coverage include 失真 — 🔶 部分改善 P2【勘察报告】

- **证据**：vitest.config.ts coverage.include 仅列 3 个已测文件 → 47% 语句覆盖率是「已测文件内部」的数字，非全仓覆盖率。
- **本轮（PR #3）**：include 增至 8 个（+page-container.tsx / nav-mode.ts / action-rail-routing.ts / navigation-model.ts / top-nav-density.ts——App Shell 第一批的可测原语）。
- **PR #4（FE-批3）**：include 增至 22 个（+useUrlState / url-state-codec / DataStateBoundary / alert-center.tsx / alert-center-url-state / use-alert-center-url-state / alert-chart-options / evidence-utils / 四个 evidence 组件）。阈值不变（lines 35 / functions 3 / statements 35 / branches 30）。
- **PR #5（FE-批3B）**：Alert Center include 增至 32（+alert-center-actions/data-state/filters/summary/list-model + alert-events-virtualization + alert-event-list/row/toolbar/detail/detail-model/五页签 + use-alert-events-feed/selection/status-actions/batch/detail/virtualization/charts；全站 include 总数约 40）。阈值不变（lines 35 / functions 3 / statements 35 / branches 30）。
- **PR #7（FE-批4B）**：include 79 → 107（war-map 35 → 63：新增 symbol-types/color/svg/icons/legend-model/legend-swatch + overlay-theme/types/layout/view-model/summary/quick-legend + controls-types/primitives/header/view-section/transport-controls/ais-reference/feed-controls/legend-sections/legend-panel/legend-dock + inspector-types/shell/四个内容组件）。阈值不变。**勘误（合并后收口 PR）**：此前登记为「85 → 113」，与合并后 main 实测不符（实际 107，逐条清点核对 db21bf1f）；war-map 35 → 63 一致。
- **FE-批4B 合并后收口 PR**：include 107 → 111（war-map 63 → 67：symbol-svg 拆分补入 svg-primitives/glyphs 两模块，legend-model 拆分补入 item/quick/full 三模块并移除旧条目）。阈值不变（lines 35 / functions 3 / statements 35 / branches 30）。仍为「部分改善」：全仓 glob + 阈值重设待 FE-批5+（task-detail 等未拆分）。
- **仍为「部分改善」**：全仓 glob + 阈值重设待 FE-批4+（巨型组件 war-map/task-detail 等未拆分、无测试，纳入即红 CI）。

### CI-01 OpenAPI 快照生成非确定性 — ✅ 已修复（PR #12 关闭）【PR #5 第五轮登记；PR #6 两次复现；main merge `bff2ebae` 后正式阻断】

**（以下为历史登记，保留原始记录）**

PR #6（FE-批4A，纯前端改动、无 API 变更）再次复现：run 33900456381 的
OpenAPI snapshot drift check 首跑失败——快照中大量端点凭空出现 `query` 查询
参数（形如 name:"query", in:"query", schema string），diff 超 2000 行；同一
SHA 对同一 job 做一次针对性重跑后通过（run 33900456381 rerun, verify ✓）。
与第五轮的 x-unresolved-schema 降级是同一非确定性缺陷的不同表现
（decorator 元数据解析顺序不稳定）。按规程未修改快照/生成器/CI；缺陷保持开放，
证据已保存。

PR #6 第二轮（合并前静态收口）观察：本轮各次 CI run 中，未执行到 OpenAPI
drift 步骤的均为 web 测试步骤先行失败（33945984922 预期红灯、33947812370
standalone Drawer 缺陷暴露），执行到该步骤的 run 均首跑通过（如 33946342887
verify success）——CI-01 本轮未复现，无重跑。

- **现象**：PR #5（纯前端，`apps/api` 零改动）的 CI run `33874825439` 首次执行 `contract:openapi:snapshot` 时，`git diff --exit-code apps/api/tests/contract/openapi.snapshot.json` 失败；对同一失败 job 做单次针对性重跑后通过（同 SHA、同代码）。
- **失败 diff 特征**：多个端点（vector settings 相关路由）新增 `requestBody` 条目且标记 `x-unresolved-schema: true`——即该次运行中 NestJS schema 未被解析，产物降级为 unresolved 占位形状，而非任何代码驱动的契约变化。
- **根因假设（当时）**：`tsx`/`NODE_PATH` 环境下模块加载时序非确定性，导致 schema 解析偶发失败（未验证，需单独排查 `scripts/generate-openapi-snapshot.ts`）。
- **风险**：契约漂移门禁可能产生**假失败**（或理论上假通过），CI 信号不可靠。
- **证据**：run 33874825439 首次失败日志（OpenAPI contract snapshot drift check 步骤）与同 SHA 重跑成功；对照点：同一分支早前 run 33870697826 该步骤 success。
- **状态（当时）**：**开放，待后续单独修复**（本轮仅登记，未修改生成器/快照/CI——PR #5 明确禁止触碰）。

**（PR #12 根因确认与修复——2026-09-06）**

- **正式阻断**：PR #11（纯 web 测试精简，`apps/api` 零改动）合并 main 后
  （merge `bff2ebae`），run `34031744982` 的 `OpenAPI contract snapshot drift
  check` 步骤失败——大量本无 `@Body` 的端点凭空新增 `requestBody`
  （`x-unresolved-schema` 形状），其后步骤全部取消。同一 API 源码在 PR HEAD
  run `34030229911` 通过——两 run 的差异是随机命中，不是代码因果。
- **根因（已证）**：Nest `createParamDecorator`（本仓库 `@CurrentUser()`，
  全仓 289 处、唯一自定义参数装饰器）把参数元数据写到
  `ROUTE_ARGS_METADATA` 时键为 `uid(21) 十六进制随机串 +
  "__customRouteArgs__":序号`（`@nestjs/common` 11.1.9
  `utils/assign-custom-metadata.util.js`；uid 2.0.2 = `Math.random` 十六进制
  串，每冷进程重新随机）。扫描器 `scan-routes.ts` 用 `parseInt` 解析键前缀：
  前缀以 `3`+字母开头 → 误判 `@Body`（requestBody 污染，run 33874825439 /
  34031744982 的签名）；`4`+字母 → 误判 `@Query`（query 污染，run
  33900456381 的签名）；`5`+字母 → 误判 `@Param`。每冷进程约 7% 的
  `@CurrentUser` 参数被随机污染（289 个参数 → 期望约 20 个端点/次）；重跑
  即绿是因为新一轮随机 uid 大概率不命中——"同 SHA 首跑红、重跑绿"由此而来。
  决定性证据：失败 diff 首个污染端点 `POST /api/admin/akshare/upgrade` 的
  签名是 `upgrade(@CurrentUser() user)`——没有任何 `@Body`。
- **旧假设证伪**：基线 145 个 `requestBody` 全部 `typeName=null`（无 `$ref`）
  → tsx/esbuild 不发射 `design:paramtypes`，不存在"schema 解析降级"；
  `TS_NODE_TRANSPILE_ONLY` 对 tsx 无效（tsx 不读 ts-node 环境变量）——误导
  排查的红鲱鱼，已从 `apps/api/package.json` 移除。
- **修复（方向 A：最小确定性修复，非 AST、非换 runner）**：
  1. `ROUTE_ARGS_METADATA` 键前缀与序号必须严格纯数字（内置
     `@Body/@Query/@Param` 只写 `"3:0"` 形式），随机 uid 键一律忽略；
  2. `ROUTE_ARGS_METADATA` 与 `design:paramtypes` 改用
     `Reflect.getOwnMetadata`（基类/同名 handler 的参数元数据不再穿透；
     `design:paramtypes` 读取目标修正为 `(prototype, methodName)`——TS/tlib
     实际写入位置，经 dist 编译产物 + reflect-metadata 源码静态核实）；
  3. routeParams 排序 comparator 严格全序（完全相等返回 0，最终排序键
     `(kind, name, index, key)`）。
- **快照基线**：逐字节不变（370 operations / 294 paths / 145 requestBody /
  159 query / 199 path params）——修复读取逻辑未改变任何契约内容。
- **CI 加固**：OpenAPI 步骤升级为 `OpenAPI contract snapshot determinism +
  drift check`——同一 `contract:openapi:snapshot` 命令（生成器新增
  `--output`，单一生成入口不变）在两个互相独立的冷 Node 进程各生成一次，
  SHA-256 必须一致，再与已提交快照逐字节（`cmp`）比对；无 retry、无 sleep、
  无重跑择优。
- **最小回归**：扩展 `tools/scan-routes.test.ts`（不新建文件）——真实
  `createParamDecorator` 键形状（`uid(21) + __customRouteArgs__`）不产生
  body/query/param；基类同名 handler 参数不穿透（getOwnMetadata 语义）；
  `@Body/@Query/@Param` 混合签名输出顺序确定性（相等返回 0）；手工注入两种
  历史脆弱键形状（`"3a7f…:0"`、`"4f9c…__customRouteArgs__:1"`）断言零参数。
  首个提交的断言误以为 Nest 11 键形为 `"uid:序号"`（无后缀）——CI 首跑
  run `34033854098` 的失败日志暴露真实形态，已修正（这本身验证了
  fail-closed 测试流程：读日志→定位→修复→重推）。
- **验证**：PR #12 最终 HEAD `30029210` 首次执行 run `34034235302`
  verify + vector-integration 全绿（contract-baseline-regen 按事件设计
  skipped）。OpenAPI 步骤确认：冷进程 run1/run2 SHA-256 均为
  `d617766a00fdc8cf665400918cea22f6fce50486406a8f32bf6802dfae19e87c`
  （一致），与已提交快照逐字节一致（"deterministic across cold processes
  and byte-identical to committed snapshot"）；370 端点/294 路径计数不变；
  无 retry。


### FE-I18N-01：task-detail 域 14 个 i18n 键丢失插值占位符（用户可见数值不显示）

- **现象**：`apps/web/app/(app)/crawl/[taskId]/` 详情页多个字段只显示标签文字，不显示实际数值——内存字段显示字面量「Memory value/内存值」而非「512 MB」、链接分桶 Tag 显示「Bucket item/分桶条目」而非「social × 2」、表格剩余行数、多 URL 模式/覆盖项、媒体来源数、wait timeout 等同。
- **根因**：`apps/web/lib/locales/{en,zh}.json` 中 14 个键的文案缺少 `{{value}}` 等插值占位符（疑似某次批量翻译/同步工具丢失），组件传入的参数被 i18next 静默丢弃。涉及键：`crawl.detail.memoryValue/percentValue/waitTimeoutValue/multiUrl.patterns/multiUrl.overrides/media.more/media.sources/tables.defaultTitle/tables.source/tables.remaining`、`crawl.links.bucketItem/linkScore/intrinsicScore`、`crawl.multiUrl.strategyTitle`（en+zh 各 14 处）。
- **发现方式**：FE-批5A characterization tests（批6 静态 i18n 键核对暴露；批1 曾在 presentation 测试中以注释记录该现状）。
- **修复**：恢复占位符（en/zh 双语，如 `{{value}} MB`、`{{kind}} × {{count}}`、`{{preview}} shown, {{remaining}} more`），并把 presentation/results 中记录缺陷现状的 4 处断言更新为修复后行为（512 MB/768 MB/66%、social × 2、2 shown, 5 more、Picture sources (1)）。
- **波及**：`crawl.multiUrl.strategyTitle` 同时被 `CreateCrawlTaskDrawer.tsx` 消费——该文件本轮未修改，locale 修复使其策略标题从字面量「Strategy title」恢复为「Strategy {n}」（行为改善，随本条一并生效）。
- **验证**：远端 CI（jsdom characterization 全绿）；修复措辞为机械恢复（MB/%/ms/× 等数值单位），非重新设计文案。
- **状态**：✅ 已随 FE-批5A PR #9 修复。

### FE-TPL-01：Create Drawer defaultTemplateKey 持续回写覆盖用户主动选择 — ✅ 已随 FE-批5B 修复

- **现象**：news-sources 入口恒定传入 `defaultTemplateKey="news"`，原 effect 在
  `defaultTemplateKey !== selectedTemplate` 时无条件重放模板——用户在本次打开期间
  主动选择 general/forum/social 后被立即改回 news，无法选用其他模板。
- **根因**：defaultTemplateKey 被当作持续受控值而非"一次打开会话的初始默认值"；
  初始化 effect 依赖 selectedTemplate 变化反复触发。
- **附带发现（同轮修复）**：原"打开时应用 selectedTemplate"的回退分支因 rc-drawer
  首渲染延迟挂载（mergedOpen=false）+ `isFieldsTouched(true)` 在零注册字段时返回
  true（空数组 every）而从未在冷启动生效（仅重开时生效）。修复后冷启动同样应用
  默认模板（恢复原设计意图；草稿保护改用 store 值判定，不依赖字段注册时序）。
- **修复**：单一会话初始化 effect（session 标记 + 草稿保护：已填 URL 或表单已有值
  时跳过）；会话内用户选择优先；关闭复位会话标记。两个消费入口的既有语义保持：
  crawl-tasks 草稿跨开合保留、news-sources 关闭 reset 后重开重新应用 news。
- **验证**：远端 jsdom 回归测试（news 默认下切换模板不被回写、草稿保护、两种父
  reset 语义、defaultTemplateKey 合法/trim/非法/缺失）。

### FE-A11Y-03：Create Drawer 模板选择器缺少键盘语义 — ✅ 已随 FE-批5B 修复

- **现象**：模板卡为 antd Card（div）+ onClick——Tab 不可达、Enter/Space 无效、
  无 selected 可访问状态。
- **修复**：Col 内以原生 `<button type="button" aria-pressed>` 包裹 Card（Card 改
  纯展示，无嵌套交互元素）；布局/图标/说明/选中边框不变；按钮内容为本地化文本
  （即可访问名）。
- **验证**：远端 jsdom（原生 button 语义、focus 可达、aria-pressed 随选择切换、
  鼠标点击行为保持）。Enter/Space 激活由原生 button 语义保证——jsdom 不合成键盘
  click，未做运行时键盘断言（真实键盘/读屏未验证，见 PR 未验证清单）。

### FE-SUBMIT-01：Create Drawer loading 期间表单 submit 仍可重复触发 onSubmit — ✅ 已随 FE-批5B 修复

- **现象**：仅提交按钮带 loading（antd loading 按钮 disabled），但 Form 的 onFinish
  直连外部 onSubmit——表单 submit 事件（Enter 提交路径/编程式 submit）不经过按钮，
  loading 期间仍会再次调用 onSubmit（characterization 测试证明该路径可达且原实现
  无拦截）。
- **修复**：Drawer 边界 fail-closed guard：`onFinish` 在 loading 时直接返回；
  loading=false 行为与 onSubmit 异步返回语义不变。
- **验证**：远端 jsdom 回归测试（loading=true 时 submit 事件不触发 onSubmit；
  loading=false 时触发）。

### FE-I18N-02：Create Drawer 域 3 个 i18n 键缺失/丢插值占位符 — ✅ 已随 FE-批5B 修复

- **现象**：① `crawl.templates.reutersCf` / `reutersCfDesc` 缺失于 en+zh——中文界面
  回退英文 defaultValue（"Reuters + Cloudflare"）；② `crawl.dynamic.jsStep` 缺
  `{{index}}` 占位符（en+zh），JS 步骤标签不显示序号（与 FE-I18N-01 同类）。
- **修复**：补 en/zh 双语键与占位符；characterization 中记录缺陷现状的断言更新为
  修复后行为。
- **验证**：远端 jsdom（zh 模板名中文、JS step 1 序号）。

### FE-TPL-02：Create Drawer proxy 告警分支不可达（恒为 error 级） — ⬜ 开放【FE-批5B 登记】

- **现象**：创建抽屉的 proxy Alert 恒为 error 级 "Unsupported legacy proxy
  configuration" 并列出 options.proxyUrl / options.proxyConfig——即使表单从未填写
  代理字段，用户每次打开高级配置都看到错误级提示。
- **根因**：组件向 `findUnsupportedProxyIssues` 传入 `{proxyUrl: watch(...),
  proxyConfig: watch(...)}` 字面量——两键恒存在（值为 undefined），
  `hasOwnProperty` 命中即计入 issue；"自定义上游代理已禁用"的 warning 分支不可达。
- **修复方向（未实施）**：仅在键有值时报 issue（或由调用方过滤 undefined 键）；
  涉及用户可见文案语义取舍（warning vs error），单独决策。
- **状态**：开放。FE-批5B 以 characterization 锁定现状（测试内注明缺陷），未修改。

## 5. 观察项（非缺陷，迁移决策输入）

1. GraphQL Subscription 进程内 PubSub vs WS Redis adapter（水平扩容语义不一致）
2. crawl4ai legacy 与 hot/normal 双轨队列并存
3. itemPipeline DLQ 在 worker failed 事件中入队（非 BullMQ 原生语义）
4. 隐藏写入方：news-pipeline-crawl-bridge.service.ts:185-188（结果缺失时同步触发抓取）、CrawlTaskJanitor 直改状态
5. TopNav 589 行 / ActionRail 3 个重复图标 / newsnow 自加 1760px 宽度特例（IA 重构输入）
6. ~~war-map-geometry.ts 零消费导出 splitDeckPathSegments/buildSanitizedPathFeatures（FE-DD-01，批4A 遗留）~~ ✅ 已随 FE-批4B 合并后收口 PR 删除（FE-DD-01，见 §3）
7. vector-integration 的 upsert 确定性点 ID 断言偶发 500 vs 201（run 33957774254，真实 Qdrant 环境；同分支纯前端改动后的相邻 run 33957963593 通过，无代码因果，非 CI-01 变体——登记观察待复现规律）。第二次复现：PR #12 文档收口提交 `1e9fe1c9`（仅改 3 个 markdown）run 34034804518 vector-integration 同断言失败（500 vs 201）；同 PR 代码提交首跑 run 34034235302 通过——两次 run 之间无代码差异，进一步佐证与代码无因果。仍为观察项。

## 6. 风险与未验证登记

- **BL-04 的 Node 版本前提**：`process.getBuiltinModule` 需 Node ≥20.16。CI 当前 Node 20（latest tag，实际 ≥20.16）已验证通过；若未来 CI 固定到 <20.16 需回退方案。
- **API-01 / SEC 系列真实登录态验证**：SEC-01 单元级与 API-01 契约级测试已由远端 CI 验证（run 33748591315）；**真实数据库登录态冒烟**（登录→PUT vector 配置→403 / 完成引导→刷新不重现）仍需 Docker 数据库栈——CI 无 DB，列为部署环境可用后的第一优先验证项。
- 基线环境缺口（AISSTREAM_API_KEY 空、infra/docker/.env 缺失）不属代码缺陷，不入本台账。

### F1：Frontier 取消改写终态运行、无事务无行锁、并发重复记事件 — 🟡 已修，待远端验证

- **现象**：对 `completed`/`canceled` 的 run 调 `POST /runs/:id/cancel` 会把它改写成
  `canceled` 并覆盖 `finishedAt`；批量取消把已完成的 run 计入 `canceledIds`；同一
  run 的并发取消会追加两条 `frontier_run_canceled` 事件。
- **证据（以 origin/main@39ad5b55 为准）**：
  - `apps/api/src/modules/crawl/crawl-frontier.service.ts:830-888` `cancelRunRecords`
    对传入 id 无条件 `status='canceled', finishedAt=now`（原 :844-855），不排除
    `completed`/`canceled`；`crawlFrontierRun.updateMany` 与 `crawlFrontierNode.updateMany`
    用 `Promise.all` 并行，没有事务与行锁。
  - 同函数原 :868-887 对 workflow run 无条件 `markRunStatus('canceled')` 并把
    `error` 清成 `null`（recorder `crawl-strategy-run-recorder.service.ts:407-424`）。
  - `crawl-frontier.service.ts:752-775` 原 `cancelRuns` 的 `canceledIds` 来自只按
    `orgId` 过滤的 `findMany`，会把已完成的 run 计为「已取消」。
  - 前端 `apps/web/app/(app)/admin/ops/crawl-frontier/crawl-frontier-console.tsx:1444`
    与 `:1694` 已把 `completed`/`canceled` 视为不可取消，`:1186-1191` 按
    `ids.length - canceledCount` 显示 skipped；后端没有执行这个约束。
- **修法（Nest 与 Go 两侧一致）**：
  1. 开事务；第一条语句按 `orgId` + id 集合 + `status NOT IN ('completed','canceled')`
     且 `ORDER BY id ASC FOR UPDATE` 锁定，升序加锁避免两个批量取消交叉死锁。
  2. 没有行时提交并返回空列表。
  3. `finishedAt` 取当前时间（毫秒）；两条 UPDATE 的 WHERE 都带 `orgId`。
  4. 提交后按 id 升序对锁定行串行 `appendEvent` 与 `markRunStatus`（`error` 清空）。
  - Nest：`crawl-frontier.service.ts` `cancelRun`、`cancelRuns`、`cancelRunRecords`
    改为 `this.prisma.$transaction` + `tx.$queryRaw(Prisma.sql\`… FOR UPDATE\`)`。
  - Go：`apps/api-go/internal/crawlfrontierruns/cancel.go` 同一协议（id 集合用
    `JSON_CONTAINS` 固定 arity，保持 `ORDER BY id ASC FOR UPDATE`）。
  - `cancelRun` 保留存在性检查与 404，无论是否发生状态转换都返回完整详情（201）；
    终态取消是幂等无操作。`failed` 仍可取消（与前端
    `status !== "completed" && status !== "canceled"` 一致）。
- **回归方式**：`api-go-crawl-frontier-runs-smoke` 阶段 2 断言：
  - `completed run cancel keeps completed`：201；DB 中 status 仍 `completed`、
    `finishedAt` 不变、workflow run 仍 `completed` 且 `error='keep-me'`、事件数不变。
  - `running run cancel transitions once`：201；run/节点/workflow run 变 `canceled`；
    恰好新增 1 条 `frontier_run_canceled`，sequence = 原数量 + 1。
  - `bulk cancel skips terminal and cross-tenant`：`canceledIds` 升序、count 正确。
  - `concurrent cancel appends one event`：同一 run 并发 10 次（Go/Nest 各半），
    最终恰好 1 条取消事件、`finishedAt` 只写一次。
  - `opposite-order bulk cancels do not deadlock`：两个 id 顺序相反的批量取消并发 5 轮
    无 500/死锁。
- **状态**：待远端验证（Nest 与 Go 两侧已同修；本机按约束未运行构建与测试）。

### F1-FOLLOWUP-01：recorder appendEvent 的 count+1 sequence 与 worker 并发可能重复 — ⬜ 只登记，不修

- **现象**：`crawl-strategy-run-recorder.service.ts:206-209` 用
  `COUNT(*) + 1` 计算 `sequence`；与 worker 并发写同一 run 的事件时可能产生重复
  sequence（表上只有 `@@index([runId, sequence])`，没有唯一约束）。
- **不修原因**：该路径属于 worker 共用代码，本批只迁移 HTTP；Go 侧按同一语义复刻
  （`cancel.go` 的 `appendCancelEvent` 同样用 `COUNT(*) + 1`）。
- **后续方向**：为 `CrawlStrategyWorkflowRunEvent` 增加 `(runId, sequence)` 唯一约束，
  或在事务内 `SELECT … FOR UPDATE` 计数后写入；需要与 worker 写入方一起评估。
- **状态**：只登记。

### F1-FOLLOWUP-02：POST workflow-runs/:runId/replay 只要求 crawl.read — ⬜ 只登记，不修

- **现象**：`apps/api/src/modules/crawl/crawl-strategy.controller.ts:155-163` 的
  `POST /api/admin/crawl-frontier/workflow-runs/:runId/replay` 是写操作，却只声明
  `@Permissions('crawl.read')`。
- **不修原因**：该路由不在本批 11 条迁移范围内，且控制器受
  「不改 `apps/api/src/**/*.controller.ts`」约束（避免 auth-matrix 与 OpenAPI 漂移）。
- **后续方向**：单独一批把权限改为 `crawl.write`，并同步 auth-matrix 快照。
- **状态**：只登记。

## 7. 基础设施连接与采集运行凭据批次（IS1–IS4）

本批次把「基础设施连接与采集运行凭据配置」7 条 HTTP 用 Strangler Fig 方式迁入
apps/api-go（独立开关 `API_GO_INFRASTRUCTURE_SETTINGS_MODE`，默认 legacy），并同步
修复 Nest 侧 IS1–IS4。行号以基线 `b89c35a85998512392e32566ccd96b2766f65441`
（origin/main，普通 CI run 39051652549 success）为准。

### IS1 全局存储和采集凭据写入缺平台管理员门禁 — ✅ 已修复【P0】

- **用户影响**：跨租户存储与采集凭据劫持。九个 `storage_*` SystemSetting 与
  `news_source_runtime_secrets` 都是**全局单例**（无 orgId 维度），任何持有
  `settings.manage` 的普通组织管理员即可改写所有租户的 S3 目标与新闻源 cookie/token。
- **证据（b89c35a8）**：
  - `apps/api/src/modules/storage/storage-settings.controller.ts:27-33`：PATCH 只有
    `@Permissions("settings.manage")`，直接进 service；
  - `apps/api/src/modules/storage/storage-settings.service.ts:170-206`：`updateStorageSettings`
    更新 9 个无 orgId 维度的全局 key；
  - `apps/api/src/modules/system-settings/news-source-runtime-secrets.controller.ts:23-29`：
    PUT 只有 `settings.manage`；
  - `apps/api/src/modules/system-settings/news-source-runtime-secrets.service.ts:111-201`（基线
    `:158-173` 为写入段）：写全局 `news_source_runtime_secrets`；
  - 对照：`apps/api/src/modules/system-settings/vector-service-settings.controller.ts:47,56`
    相同全局配置已要求平台管理员。
- **修复（Nest）**：
  - `storage-settings.service.ts`：`updateStorageSettings` 首行 `assertPlatformAdmin(actorId)`，
    直查 `GlobalRoleAssignment`（`userId` + `role='platform_admin'`）抛
    `ForbiddenException("Platform admin access required")`。AuthModule 已依赖
    StorageModule，注入 PlatformAccessService 会新增循环依赖，故按同一谓词内联。
  - `news-source-runtime-secrets.service.ts`：`updateSettings` 首行复用已注入的
    `PlatformAccessService.assertPlatformAdmin(actorId)`。
  - 空白 body / 空数组 / 无实际变更同样先授权；controller、DTO、module 注册均未改；
    三个 GET 保持 `settings.manage` 可读。
- **修复（Go）**：写路径在 DTO 校验之后执行同一平台门禁；机器令牌（`machine:<id>`）
  不是 User 行，永不满足门禁。
- **远端回归断言**：org A/B 普通管理员与 `settings.manage` 机器令牌四条写均 403 且无
  配置/审计/缓存副作用；平台管理员 P 四条写 200；三个 GET 对有权限机器令牌 200；
  有平台角色但无 `settings.manage` 仍 403；非平台用户的非法 DTO 先 400、合法 DTO 才 403。
- **状态**：✅ Nest 与 Go 两侧已修复；真实栈回归由 `api-go-infrastructure-settings-smoke` 的 IS1 断言组覆盖（见 PR #55）。

### IS2 运行凭据的进程缓存与无锁整体写导致丢失更新 — ✅ 已修复【P1】

- **用户影响**：管理端读到旧值；并发 PUT 互相覆盖未触及条目（例如并入新增 C 时丢掉
  另一进程刚写入的 B）。
- **证据（b89c35a8）**：
  - `news-source-runtime-secrets.service.ts:123-173`：`getPublicSettings`/`updateSettings`
    都从 `loadStoredSettingsStrict()` 读后合并，再整体 upsert `news_source_runtime_secrets`；
  - `:334-347`：`loadStoredSettingsStrict` 命中 30,000ms 进程缓存即返回，跨进程更新
    （Nest worker / Go 接管）不会使其失效；
  - `:199`、`:432-434`：写后只清当前实例缓存。
- **修复（Nest）**：管理 GET 改走新增的 `loadStoredSettingsStrictFromDb()`（DB 权威
  strict parse）；PUT 的合并基准同样来自锁内 DB；整段读-改-写在
  `infra-settings:news-source-runtime-secrets:v1` 全局 MySQL 会话锁内完成；响应使用
  本次写入快照（删空时 source 为 `none`）。`getSecretsForSource` 等消费者保留原有
  30 秒进程缓存与降级语义，`invalidateCache()` 仍在写后调用。
- **修复（Go）**：管理 GET 无进程缓存；PUT 在同一锁名内做 DB 权威读改写；不新增
  Redis 版本键。
- **远端回归断言**：Nest 先 GET 暖缓存 → 另一连接改 DB → 管理 GET 立即返回新值；
  暖 A、DB 改 [A,B]、再 PUT 新增 C → 最终 [A,B,C]；Nest/Nest、Go/Go、Nest/Go 真实并发
  （新增不同条目 / 删除不同条目 / 删 A 加 C）集合正确；首次无记录并发创建；strict
  损坏记录仍按 400/409 拒绝且不被覆盖清空。
- **状态**：✅ 两侧已修复；真实栈回归由 `api-go-infrastructure-settings-smoke` 的 IS2/IS3 断言组覆盖（见 PR #55）。

### IS3 向量 PUT 省略 token 时旧 Redis 值覆盖已轮换 token — ✅ 已修复【P1】

- **用户影响**：已轮换的 vector 内部 token 被旧缓存值写回，向量调用携带失效 token。
- **证据（b89c35a8）**：`vector-service-settings.service.ts:98`（更新基准取自
  `loadStoredSettings()`）、`:188` 起（缓存优先，命中 `vector_service:settings` 即用
  Redis 旧值）、`:103` + `resolveNextToken`（absent token 保留该旧基准的 token）、
  `:124-139`（随后整体覆盖 DB）。
- **修复（Nest）**：PUT 与 DELETE 共用 `infra-settings:vector-service:v1` 全局锁；
  token 保留基准改为锁内 `loadStoredSettingsFromDb()`；absent/null/空白/非空四态
  语义不变；写后清共享 Redis 缓存。controller 门禁、vector-client、diagnostics 未改。
- **修复（Go）**：同一锁名；同样从 DB 权威读 base；四态语义逐字对齐。
- **远端回归断言**：DB token=B、Redis 信封 token=A、PUT 省略 token 后解密核对仍为 B
  （Nest 与 Go 各一遍，只断言 hasToken 不算通过）；PUT 与 DELETE 均等待同一固定锁。
- **状态**：✅ 两侧已修复；真实栈回归由 `api-go-infrastructure-settings-smoke` 的 IS2/IS3 断言组覆盖（见 PR #55）。

### IS4 存储清空字段直接向必填 JSON 列传 JS null — ✅ 已修复【P1】

- **用户影响**：`endpoint: null` / `forcePathStyle: null` / `presignedUrlTtlSeconds: null`
  的「清空」语义无法持久化（必填 Json 列拒绝 SQL NULL，写入报错或语义错乱）。
- **静态证据（b89c35a8）**：
  - `apps/api/src/modules/storage/dto/storage-settings.dto.ts`：`endpoint` 及其他可选字段
    `@IsOptional()` 允许显式 null；
  - `storage-settings.service.ts:260-308`（`normalizeUpdates`）：`endpoint` 显式 null 被保留；
    `forcePathStyle`、`presignedUrlTtlSeconds` 仅判 `undefined`，null 也会保留；
  - `:178-202`（`Object.entries` 循环）：`recordValue` 原样作为 Prisma JSON 列 `value`，
    没有 `JsonNull` 转换；
  - `packages/db/prisma/schema.prisma:758-767`：`SystemSetting.value` 为必填 `Json`；
    生成的 `SystemSettingCreate/UpdateInput.value` 类型是 `JsonNullValueInput | InputJsonValue`
    （`node_modules/.prisma/client/index.d.ts:121960-121973`），SQL NULL（`Prisma.DbNull`）
    与 JSON null（`Prisma.JsonNull`）不可混用。
- **修复（Nest）**：新增具名 `NormalizedStorageSettingsUpdate`（可空输入显式建模）与
  `toStorageJsonValue()`；顶层业务 null 转 `Prisma.JsonNull`；不再用 `Object.entries` 的
  any 掩盖类型；审计 metadata 内的 null 仍是普通 JSON null。DTO、schema 未改，行未删除。
- **修复（Go）**：向 JSON 列写字面量 `null`，不传 SQL NULL。
- **远端回归断言（须先留修复前复现证据）**：`endpoint:null`、`forcePathStyle:null`、
  `presignedUrlTtlSeconds:null` 均 200；`JSON_TYPE(value)="NULL"` 且 `value IS NULL` 为 false；
  GET 按 env 回退（endpoint 依 env 决定有值或省略）；混合 PATCH 事务原子；空字符串
  endpoint 仍 DTO 400。
- **状态**：✅ 两侧已修复；真实栈回归由 `api-go-infrastructure-settings-smoke` 的 JSON null 断言组覆盖（`JSON_TYPE=NULL` 且 `value IS NULL=0`）。

## 8. 账户资料、会话退出与机器令牌批次（AS1–AS4）

本批次把「账户资料、会话退出与机器令牌管理」8 条 HTTP 用 Strangler Fig 方式迁入
apps/api-go（独立开关 `API_GO_ACCOUNT_SECURITY_MODE`，默认 legacy），并同步修复
Nest 侧 AS1–AS4。行号以基线 `57d1d4baa5f8432686c8db396968633fd559d43e`
（origin/main，普通 CI run 39064805065 success）为准。

远端验收：`api-go-account-security-smoke` 阶段 A–F 全部通过（PR #60，head
`c6eb4e06`：普通 CI run 39079671944 success、smoke run 39079675913 success，
末行输出 `api-go account security smoke: ALL OK`）。

### AS1 机器令牌轮换不是原子操作 — ✅ 已修复（远端验证）【P0】

- **用户影响**：轮换可能先撤销旧凭证、再因创建失败（例如存储权限归一化后为空、
  数据库错误）留下不可恢复的空档；并发轮换同一令牌可产生多个有效 successor，
  旧凭证的持有者与轮换者都能拿到有效令牌。
- **证据（57d1d4ba）**：
  - `apps/api/src/modules/auth/machine-token.service.ts:115-133`：`rotate` 先
    `findFirst`，`:126` 调 `revoke`，`:127` 再调 `create`——两次写不在同一事务；
  - `:104-113`：`revoke` 用 `updateMany` 命中后立即返回，无法参与外层事务；
  - `:61-86`：`create` 始终在 `this.prisma` 上执行，事务内调用也会逃出事务。
- **修复（Nest）**：`rotate` 改为 `prisma.$transaction(async (tx) => ...)`；新增
  接受 `Prisma.TransactionClient` 的内部 helper `createRecord`，事务内绝不再调用
  public `create`；归一化（权限白名单/空数组/空白名称）在条件撤销之前完成，条件
  `WHERE id + orgId + revokedAt IS NULL` 的 `updateMany` 影响行数必须为 1。
- **修复（Go）**：`machine_tokens.go` 用 `sql.Tx`：`SELECT ... FOR UPDATE` →
  归一化 → 条件 `UPDATE`（RowsAffected 必须为 1）→ `INSERT` successor → `Commit`；
  任何错误路径 `Rollback`，Commit 成功后才返回新明文。
- **远端回归断言**：正常轮换旧 token 失效、新 token 有效；仅含不支持权限的历史
  token 轮换失败且旧行 `revokedAt` 保持 NULL；用触发器让新行 INSERT 失败时旧行
  `revokedAt` 仍为 NULL（证明回滚）；Nest/Go 并发轮换同一旧 token 只有一个 201，
  其余 400 同一错误；最终仅一个 successor；token 明文不出现在 DB/Redis/audit/日志。
- **状态**：✅ Nest 与 Go 两侧已修复（纯单测覆盖事务客户端归属、零行撤销、INSERT
  失败回滚）；真实栈回归由 `api-go-account-security-smoke` 的 AS1 断言组覆盖。
  远端证据（PR #60，head `c6eb4e06`）：普通 CI run
  [39079671944](https://github.com/wei500L/newwei/actions/runs/39079671944) success、
  smoke run [39079675913](https://github.com/wei500L/newwei/actions/runs/39079675913)
  success（`api-go account security smoke: ALL OK`）。

### AS2 并发修改密码可覆盖已完成修改 — ✅ 已修复（远端验证）【P0】

- **用户影响**：两个请求都用同一旧密码通过校验时，后提交的请求会覆盖先成功的新
  密码——用户拿到「改密成功」但实际密码是另一个请求写入的，属于账户接管面。
- **证据（57d1d4ba）**：
  - `apps/api/src/modules/auth/auth.service.ts:1410-1428`：事务前读取并
    `bcrypt.compare` 旧 hash；
  - `:1431-1440`：事务中仅 `where: { id: userId }` 更新，没有把已校验的旧 hash
    作为条件，两个请求都可成功。
- **修复（Nest）**：`$transaction(async (tx) => ...)` 内先
  `tx.user.updateMany({ where: { id, passwordHash: user.passwordHash } })`，`count
  !== 1` 抛 `ConflictException("Password changed by another request; retry with
  the current password")`（事务回滚，refresh 撤销不生效）；同一事务内撤销该 user
  全部未撤销 `RefreshToken`。
- **修复（Go）**：`password.go` 同事务
  `UPDATE User SET passwordHash=? WHERE id=? AND passwordHash=?`，RowsAffected 必须
  为 1，否则返回 409 并回滚；refresh 撤销在同一事务。
- **远端回归断言**：Nest↔Go 用同一旧密码、不同新密码并发，最多一个 200；CAS 失败
  为 409；读取发生在获胜提交之后的请求按现有校验得到 401；最终只有获胜新密码能
  通过真实 Nest 登录；失败请求不覆盖密码；获胜事务撤销全部应撤销 refresh 行；
  纯单测确定性覆盖 CAS=0。
- **状态**：✅ 两侧已修复（单测覆盖 CAS=0、CAS 条件、cost=10、72 字节适配）；真实栈
  回归由 `api-go-account-security-smoke` 的 AS2 断言组覆盖（Nest↔Go 同旧密码并发，
  恰好一个 200、最终只有获胜密码可登录、refresh 行全部撤销）。远端证据同 §8 AS1。

### AS3 profile 显式 null 与不存在 User 触发 500 — ✅ 已修复（远端验证）【P1】

- **用户影响**：`PATCH /api/auth/profile` 传 `{"firstName": null}` 时
  class-validator 的 `@IsOptional()` 跳过后续校验，service 仍按 `!== undefined`
  进入 `.trim()` → TypeError → 500；机器身份（`id=machine:<tokenId>`）调用同一
  接口会对不存在的 User 主键发起更新 → 500。
- **证据（57d1d4ba）**：
  - `apps/api/src/modules/auth/dto/profile.dto.ts:6-21`：三个字段均 `@IsOptional()`；
  - `apps/api/src/modules/auth/auth.service.ts:1353-1370`：仅判 `!== undefined`
    后直接 `.trim()`，并用 `updates.avatarUrl` 之类经 `as string` 掩盖可空事实；
  - `:1386-1389`：`prisma.user.update({ where: { id: userId } })` 对机器身份不存在
    的行报错。
- **修复（Nest）**：新增 `UpdateProfileInput`（由 DTO 派生的可空映射类型），
  `null` 明确转为同字段 empty 400；`updateProfile` 在写入前
  `user.findUnique({ select: { id: true } })`，缺失抛
  `UnauthorizedException("Invalid access token")`，不再让 Prisma 更新不存在记录。
  DTO / 控制器 / OpenAPI 契约均未改。
- **修复（Go）**：`profile.go` 用同样的可空处理（`profileFieldValue`）与
  `userExists` 预检查；机器身份在资料更新中返回 401 `Invalid access token`。
- **远端回归断言**：三个字段分别 null、全空白均 400 且无部分写入；混合合法/非法
  字段失败时不发生部分更新；空 body 不更新 `updatedAt`；历史 `settings.manage`
  机器令牌调用 profile 不再 500；其他账户/组织的 User 不受影响。
- **状态**：✅ 两侧已修复（vitest + Go 单测覆盖 null/空白/机器身份/空 body 不写）；
  真实栈回归由 `api-go-account-security-smoke` 的 AS3 断言组覆盖。远端证据同 §8 AS1。

### AS4 机器令牌 createdById 外键与空白名称 — ✅ 已修复（远端验证）【P1】

- **用户影响**：历史带 `settings.manage` 的机器身份创建机器令牌时，
  `createdById` 写入 `machine:<id>`（不是 User 行）触发 MySQL 外键 1452 → 500；
  DTO `@MinLength(1)` 在 trim 前判断，纯空白名称可通过并入库为空名称。
- **证据（57d1d4ba）**：
  - `apps/api/src/modules/auth/machine-token.service.ts:74`：`createdById:
    input.actorId` 直接写入 actor id；
  - `packages/db/prisma/schema.prisma:96-97`：`createdById` 是
    `User?` 关系（外键）；
  - `apps/api/src/modules/auth/dto/machine-token.dto.ts:12-14`：`@MinLength(1)`
    在 service trim 之前判断；
  - `machine-token.service.ts:71`：`name: input.name.trim()` 可写入空串。
- **修复（Nest）**：复用 `normalizeAuditActorId`——`machine:` 前缀与空 actor 写
  SQL NULL，人类 id 保留；空白名称在权限归一化通过后 400
  `Machine token name cannot be empty`，不再创建空名记录；轮换继承原
  `createdById`，不改为当前操作者。
- **修复（Go）**：`machine_tokens.go` 用同一归一化（`nullableActorID`）与空白名称
  400；轮换同样继承原创建者（`machine:` 前缀 → NULL），不放宽新建权限白名单。
- **远端回归断言**：seed 一条历史 `settings.manage` 机器令牌后由它创建令牌
  `createdById IS NULL` 且 201；空白名称 400 且无新行；人类创建者保留原 id；
  轮换后 successor 的 `createdById` 不变；新建权限白名单仍只有 `metrics.read`。
- **状态**：✅ 两侧已修复（vitest + Go 单测覆盖 NULL 归一化、空白名称、creator
  继承、list 保留历史 permissions 输出）；真实栈回归由
  `api-go-account-security-smoke` 的 AS4 断言组覆盖。远端证据同 §8 AS1。

## 9. Go-批 M9 模型接入设置与 OpenAI 密钥分发（MA1–MA3）

> 基线 `b89c35a8`（origin/main，普通 CI run 39051652549 success）· 分支
> `refactor/go-model-access-settings` · 开关 `API_GO_MODEL_ACCESS_SETTINGS_MODE`
> 全部行号在开工时按该基线逐行复核（与规划提示词的差异见每条「行号复核」）。
> 三条均为本批明确要求改变的行为（MA1/MA2/MA3），不得以「兼容旧行为」保留。
> **状态：✅ 已修复并远端验证**（2026-10-17）。
> - 普通 CI：run [39066013527](https://github.com/wei500L/newwei/actions/runs/39066013527)
>   head `1e0b139e` conclusion success（lint/typecheck/web 覆盖率/vector/API
>   Vitest/OpenAPI 漂移/auth-matrix 漂移/api-go 测试全绿）。
> - 真实栈 smoke：run [39066023475](https://github.com/wei500L/newwei/actions/runs/39066023475)
>   head `1e0b139e` conclusion success。关键断言（日志原文）：
>   `parity ok: PUT /openai-keys` 等 13 条 legacy 逐接口对照、
>   `MA1 platform gate ok: six writes 403 for org admin and machine token, no side effects`、
>   `validation order ok: DTO 400 before the platform 403`、
>   `MA2 stale-cache read-modify-write ok (append and delete)`、
>   `MA3 token retention from the authoritative row ok`、
>   `lock protocol ok: 10s timeout -> 503 without a write, and the lock is reacquirable`、
>   `concurrency ok: Nest + Go appends produce the union`、
>   `cross-implementation crypto interop ok (model token + keys, both directions)`、
>   `takeover ok: ten routes served by Go, unmigrated paths stay on Nest (502)`、
>   `rollback ok: legacy mode proxies to NestJS and NestJS reads the same configuration`。
> - 既有 smoke 兼容：`api-go-runtime-settings-smoke`
>   [39063276096](https://github.com/wei500L/newwei/actions/runs/39063276096) 与
>   `api-go-graphql-settings-crawl-read-smoke`
>   [39063276148](https://github.com/wei500L/newwei/actions/runs/39063276148) success
>   （head `185740d3`，合并 #53 之后）。

### MA1：全局模型配置与 OpenAI 密钥写接口缺平台管理员门禁（P0）

- **证据（基线 b89c35a8 实际行号）**
  - `apps/api/src/modules/system-settings/model-service-settings.controller.ts:23-30`
    （PUT）与 `:32-36`（DELETE）：只有 `@Permissions("settings.manage")`，直接
    调用 service。
  - `model-service-settings.service.ts:120-135`（`prisma.systemSetting.upsert`
    key=`model_service`）与 `:162-163`（`resetToEnv` 的 `deleteMany`）：
    SystemSetting.key 是全局主键、没有 orgId 维度。
  - `openai-keys-settings.controller.ts:23-48`：PUT/POST/DELETE key/DELETE 四条写
    接口同样只有 `settings.manage`。
  - `openai-keys-settings.service.ts:151-166`（upsert key=`openai_keys`）与
    `:205-206`（`reset` 的 `deleteMany`）。
  - 对照既有同类全局配置：
    `vector-service-settings.controller.ts:47` 与 `:56`
    （`await this.platformAccess.assertPlatformAdmin(user.id);`，SEC-01）。
- **结果**：任意租户中持有 `settings.manage` 的组织管理员都能改写**全平台**
  模型接入端点/内部 token 或全平台 OpenAI keys；机器令牌
  （`MachineTokenService.validate` 返回 `machine:<tokenId>`）还可能把
  `machine:<id>` 写进 `SystemSetting.updatedById`（外键 → `User(id)`）得到 500。
- **修法**：两个 service 注入既有 `PlatformAccessService`；六个公开管理写方法
  （`ModelServiceSettingsService.updateSettings/resetToEnv`、
  `OpenAiKeysSettingsService.updateSettings/appendKeys/removeKeyByFingerprint/reset`）
  第一步 `assertPlatformAdmin(actorId)`，先于读取配置、加锁、编码、写库、审计与
  cache invalidation。控制器/DTO/模块注册均不改；只读 GET 不加门禁；内部取钥与
  上报保留自己的 LITELLM_CONFIG_INTERNAL_TOKEN 机制。
- **远端回归断言**（smoke `platform gate` 组）：普通 org 管理员与
  `settings.manage` 机器令牌在六条管理写上均 403 `Platform admin access required`；
  相同身份的两个 GET 仍 200；平台管理员 + `settings.manage` 六条写成功；
  有平台角色但无 `settings.manage` 走权限层 403
  （`INSUFFICIENT_PERMISSIONS`）；被拒请求后 SystemSetting/Redis/AuditLog 无变更；
  非平台用户 + 错 body 先得到 DTO 400（验证 service gate 在 DTO 之后）。
- **状态**：✅ 已修复并远端验证（smoke 断言名 `MA1 platform gate ok` /
  `validation order ok`）。

### MA2：密钥追加/按指纹删除使用缓存读改写且没有跨实例互斥（P1）

- **证据（基线 b89c35a8 实际行号）**
  - `openai-keys-settings.service.ts:189-195`（`appendKeys`：`loadStoredSettings`
    → 合并 → `return this.updateSettings(...)`）与 `:199-202`
    （`removeKeyByFingerprint`：同一「缓存读 → 合并 → 公开 updateSettings」）。
  - `:466-493`（`loadStoredSettings` 先读 30 秒 Redis 缓存
    `openai_keys:settings`，命中即返回，绝不回 DB）。
  - `:151-166`（最终整体 upsert，无行锁/版本条件/无跨进程互斥）。
  - 行号复核：规划提示词写 `:188-202` / `:466-486` / `:151-166`，
    实际合并基准代码在 `:189-195`、缓存读取函数体在 `:466-493`。
- **结果**：两个并发追加可能只保留其中一份；删除与追加交错可恢复已删除 key 或
  丢掉新 key；即使串行 HTTP，只要缓存旧于 DB，就会用旧集合整体覆盖当前集合。
- **修法**：PUT、POST、按指纹 DELETE、集合 DELETE 四条写共同遵守同一把全局
  MySQL 会话锁 `model-access:openai-keys:v1`；锁内重新 SELECT SystemSetting 权威
  值作为合并基准（不再用缓存）；append/remove 走私有锁内持久化函数，不递归进入
  公开加锁方法；锁保持到配置提交、审计与 cache invalidation 完成；响应由本次写入
  快照按原公共模型组装。读接口保留原有 30 秒 best-effort 缓存契约。
- **远端回归断言**：确定性旧缓存（DB=[A,B]、Redis 旧信封=[A]）下 POST 追加 C
  最终为 [A,B,C]；DELETE 指纹 A 最终保留 B；Nest 直连与 Go 两侧分别验证；
  真实跨进程并发（Nest/Nest、Go/Go、Nest/Go）两次追加不同 key 最终为并集、
  两次删除不同指纹两者均删除、删除 A 与追加 C 并发最终为「原集合去 A 加 C」。
- **状态**：✅ 已修复并远端验证（smoke 断言名 `MA2 stale-cache read-modify-write ok`
  / `concurrency ok: ...`）。

### MA3：模型 PUT 省略 internalToken 时可将旧缓存 token 写回（P1）

- **证据（基线 b89c35a8 实际行号）**
  - `model-service-settings.service.ts:94`（PUT 的 `const stored =
    await this.loadStoredSettings();`）。
  - `:183-212`（`loadStoredSettings` 30 秒缓存优先，命中即返回）。
  - `:100`（`resolveNextToken(stored, input.internalToken)`）与 `:235-249`
    （`internalToken` 为 absent 时 `return stored?.internalToken ?? null`）。
  - `:120-135`（随后整体 upsert 覆盖 DB）。
  - 行号复核：规划提示词写 `:94` / `:183-205` / `:100` / `:235-240` / `:120-134`；
    实际缓存读取函数体到 `:212`，`resolveNextToken` 到 `:249`，upsert 到 `:135`。
- **结果**：DB 已轮换为 token B 而缓存仍是 token A 时，一次不带 internalToken 的
  配置 PUT 会把 token 恢复成 A；并发 reset/PUT 也缺少统一序列化。
- **修法**：模型 PUT 与 DELETE 共用另一把全局会话锁
  `model-access:model-service:v1`；PUT 的 token 保留基准只来自锁内数据库当前记录；
  reset 用同一把锁；不改变 baseUrl 的省略语义，也不把整体 PUT 改成 PATCH；响应
  由本次权威写入快照构造。
- **远端回归断言**：DB token=B、Redis 旧信封 token=A 时，不带 internalToken 的
  合法 PUT 后 DB 与可解密 token 仍为 B（Nest 与 Go 两侧各一次）；持锁期间 PUT 与
  DELETE 都等待（不是只保护其中一个方法）；新 token 与省略 token 并发最终不得
  恢复旧 cache token。
- **状态**：✅ 已修复并远端验证（smoke 断言名 `MA3 token retention from the
  authoritative row ok` / `MA3 concurrency ok`）。

### 同批登记：源码与规划描述不一致（按源码保留既有契约）

1. `SystemSecuritySettingsService` 的 Redis 缓存 TTL 为 **60 秒**
   （`system-security-settings.service.ts:39` `CACHE_TTL_SECONDS = 60`），
   规划提示词表格写 30 秒。本批只读该缓存，按源码 60 秒理解，不修改它。
2. `openai_keys` 缓存读取路径中，`listKeyFingerprints` 对**明文 string 旧项**
   不丢弃 stripBearer 后为空的项（`:403-406` 无条件 push），而 `resolveKeys`
   会丢弃（`:358-363`）。两个算法刻意不合并——本批与单测/smoke 都保留该差异。
3. `MachineTokenService.MACHINE_TOKEN_ALLOWED_PERMISSIONS` 只允许 `metrics.read`
   （`machine-token.service.ts:16-18`），因此「持有 settings.manage 的机器令牌」
   只能由 seed/SQL 直接写入 `MachineAccessToken.permissions` 构造——smoke 按此
   准备数据，不通过 API 创建。

## 10. Go-批10（平台治理设置 16 条迁移）同批缺陷

本节记录随「平台治理设置 16 条迁入 Go」同批修复的三个缺陷。三处都在 NestJS 与 Go
两侧同修；证据行号以 `origin/main@0dbfc0d0` 为准，开工时已逐条复核。

### SEC-05（P0）：全局治理设置写接口只要求组织级权限 — 🔧 待远端验证

- **现象**：持有 `settings.manage` 的任意组织管理员（无 `GlobalRoleAssignment`
  的 `platform_admin`）即可改写全平台共享的治理设置。
- **根因证据**（`0dbfc0d0`）：
  - `apps/api/src/modules/system-settings/system-security-settings.controller.ts:23-30`
    —— PUT 只有 `@Permissions("settings.manage")`；service
    `system-security-settings.service.ts:36` 的存储键 `system_security` 无 org 维度，
    `:88-103` 直接 upsert 该全局行，其中 `mfaPolicy` 是全平台 MFA 策略。
  - `apps/api/src/modules/system-settings/assistant-quota-settings.controller.ts:23-36`
    —— PUT/DELETE 同样只有 `settings.manage`；service
    `assistant-quota-settings.service.ts:48`（键 `assistant_quota`）、`:148-163`
    （全局 upsert）、`:188`（全局 deleteMany）。
  - `apps/api/src/modules/system-settings/assistant-safety-settings.controller.ts:29-33,52-56`
    —— 可关闭全平台内容审核护栏；service
    `assistant-safety-settings.service.ts:35`（键 `assistant_safety`）、`:81-96`
    （全局 upsert）、`:120-121`（全局 deleteMany）。
  - `apps/api/src/modules/system-settings/llm-request-log-settings.controller.ts:23-42`
    —— 可把全平台 LLM 日志保留期改成 1 天；service
    `llm-request-log-settings.service.ts:291-295` 随即对 Mongo TTL 索引对账，
    所有租户的 `llmrequestlogs` 都会被删除。
  - 对照组（同目录已用平台门禁）：`task-log-settings.controller.ts:33-34,41`、
    `vector-service-settings.controller.ts:47,56`。
- **修法**：
  - Nest：4 个控制器构造函数注入 `PlatformAccessService`，在 PUT/DELETE/POST 共
    8 个 handler 首行加 `await this.platformAccess.assertPlatformAdmin(user.id);`
    （与 task-log/vector 完全同构，不另造第二套判断）。GET 不加。
  - Nest：4 个 service 写 `updatedById` 与 `AuditLog.actorId` 处统一改用
    `normalizeAuditActorId(actorId)`（纵深防御，与 PR #47 一致）。
  - Go：新增的 `internal/platformgovernance` 对表中 9 条标「是」的路由执行平台门禁；
    机器身份直接 403（与 Nest 查不到行的结果一致）。
  - 新增 4 个控制器 vitest（`system-security-` / `assistant-quota-` /
    `assistant-safety-` / `llm-request-log-settings.controller.test.ts`），
    只做行为断言：非平台管理员写 403 且 service 未被调用、平台管理员通过、
    GET 不调用 `assertPlatformAdmin`。
- **不在本批范围**：rate-limits、auth-cache、multi-tenant-schedulers、
  news-source-scheduler、newsnow-personalization、email、archive-preparation、
  realtime-signals 的同类全局写接口。原因：避免扩大范围、避免改动 PR #47
  已上线的鉴权契约；登记为后续跟进项（见 §4 同类条目）。
- **回归方式**：远端 `CI`（4 个新 vitest + auth-matrix 漂移门禁）与
  `api-go-platform-governance-settings-smoke` 阶段 2 `platform gate` 断言：
  普通组织管理员 A 对 10 条写路由（8 条新增 + task-logs 2 条）在 Nest 与 Go
  两侧都返回 403 `Platform admin access required`；A 的 GET 返回 200；机器令牌
  GET 返回 200、写返回 403；临时授予 `platform_admin` 后写成功，随后撤销。
- **状态**：待远端验证。

### TTL-01（P1）：`tasklogs` 集合不存在时 PUT/DELETE `/task-logs` 返回 500 — 🔧 待远端验证

- **现象**：全新部署或集合被清空后，平台管理员更新/重置任务日志保留期会 500，
  设置写不进去。
- **根因证据**（`0dbfc0d0`）：`apps/api/src/modules/system-settings/task-log-settings.service.ts:413-415`
  的 `loadIndexesSafe` 直接调用 `TaskLogModel.collection.indexes()`；集合不存在时
  MongoDB 返回 `NamespaceNotFound`(26)。`:498-515` 的 `isRetryableIndexError`
  可重试列表（85/86/91/112/12586）不含 26，于是 `:307-321` 走「不可重试」分支
  抛出原始错误，最终 500。对照组：
  `llm-request-log-settings.service.ts:937-948` 已经把 26 视为空列表。
- **修法**：
  - Nest：`task-log-settings.service.ts` 增加 `isNamespaceNotFound`（code 26 或
    codeName `NamespaceNotFound`），`loadIndexesSafe` 遇此返回 `[]`，写法与
    llm 版逐行一致。之后 `createIndex` 会自动建出集合。
  - Go：`internal/platformgovernance/ttlindex.go` 的 listIndexes 步骤对两套对账
    统一按「26/codeName NamespaceNotFound → 空列表」处理。
- **回归方式**：smoke 阶段 2 `namespace not found` 断言：`mongosh` 执行
  `db.tasklogs.drop()` 后，平台管理员对 Nest 直连 PUT `/task-logs`（值与当前不同）
  返回 200，且 `tasklogs` 上存在 `task_log_created_at_ttl` 且 `expireAfterSeconds`
  等于 `N·86400`；再 drop 一次对 Go 做同样断言。
- **状态**：待远端验证。

### CONC-01（P1）：`llm-request-logs` 部分 PUT 以过期缓存为基准且无互斥 — 🔧 待远端验证

- **现象**：实例 A 刚把 `retentionDays` 改成 45，30 秒内实例 B 收到只改 keys 的
  部分 PUT，会把旧的 `retentionDays` 写回 DB，但 Mongo TTL 索引仍是 45 天——
  DB 与索引不一致；两条部分 PUT 并发也会互相覆盖。
- **根因证据**（`0dbfc0d0`）：
  `llm-request-log-settings.service.ts:223` 的 `const current = await this.getSettings();`
  读的是进程内缓存，`:113` 的 `SETTINGS_CACHE_TTL_MS = 30_000`、`:169-175` 的
  `getSettings` 命中缓存即返回；`:225-289` 未提交字段沿用 `current`；
  `:291-295` 只有 `input.retentionDays` 有值时才做 TTL 对账。Go 接管写入后
  Nest 侧必然出现这个问题。
- **修法**：
  - 锁名固定为 `sys:llm_request_log_settings`，MySQL `GET_LOCK` 等待 10 秒。
  - Nest：把 `updateSettings` 主体抽成 `private async updateSettingsUnlocked(...)`，
    其中 `current` 改为 `await this.loadSettingsFromDb()`；
    `updateSettings` / `resetMetadataPolicy` / `resetToDefault` 各自只获取一次锁
    （`withMysqlSessionLock(process.env.DATABASE_URL ?? "", "sys:llm_request_log_settings", fn)`）。
    禁止嵌套获取锁（每次调用新开连接，嵌套等于自己等自己直到超时），所以
    `resetMetadataPolicy` 调用 `unlocked` 版本。捕获 `SituationMonitorLockError`
    转 `ConflictException("LLM request log settings are being updated by another request; retry later")`
    返回 409；其他错误原样抛出。写入成功后照旧 `setCachedSettings`。
  - Go：`db.Conn` 上 `SELECT GET_LOCK('sys:llm_request_log_settings', 10)`，结果不是
    1 时返回 409 同文案；锁内依次读 DB、合并、对账 TTL、upsert、写审计，
    `defer RELEASE_LOCK` 用独立的 2 秒 context（写法同 contentsubscriptions）。
  - task-logs、quota、safety、security 都是整体替换写，不加锁；不扩大加锁范围。
- **回归方式**：smoke 阶段 2 `stale cache rollback` 与 `concurrent partial update`
  断言：先用 Nest GET 预热其 30 秒缓存，再对 Go PUT `{"retentionDays":45}`，
  10 秒内对 Nest 直连 PUT `{"metadataAllowedTopLevelPrefixes":["x_"]}`，断言 DB 中
  `retentionDays` 仍为 45、prefixes 为 `["x_"]`；随后同时向 Go 与 Nest 各发一条
  只改不同字段的 PUT，重复 5 轮，断言最终 DB 同时包含两边修改、无 500、审计条数正确。
- **状态**：待远端验证。

### 观察（非本批缺陷）：class-validator 同一属性的消息顺序是「装饰器逆序」

本批 smoke 阶段 1 的 400 对照在真实 NestJS 上量到：对

```ts
@IsInt()
@Min(1)
@Max(3650)
retentionDays!: number;
```

传字符串 `"30"` 时，ValidationPipe 的 message 是

```
retentionDays must not be greater than 3650; retentionDays must not be less than 1; retentionDays must be an integer number
```

即**同一属性内按装饰器自下而上**（Max、Min、IsInt）报告，属性之间仍是声明顺序。
`internal/platformgovernance/dto.go` 按此顺序实现，并由 smoke 逐字节比对。

已合入的 `internal/runtimesettings/dto.go` 的 `integerConstraint` / `floatField` 按
自上而下（IsInt、Min、Max）拼消息。两者的差异只在**同一属性有多条约束同时失败**时
可见（例如把整数字段传成字符串）；单条约束失败时顺序无区别。本批不修改该已合入包，
登记为观察项，供后续统一核对。
