# 重构基线报告（Baseline）

> 生成时间：2026-09-03
> 基线 commit：`95759f596257ca699de77b5a6fb34b4226f73bf4`（branch `main`，2026-08-16 15:22:07 +0800）
> 报告人：Claude Code（渐进式重构任务第一阶段）
> 结论先行：**当前 main 不可通过质量门禁——CI 自引入（2026-08-15）以来 3 次运行全部失败，且 Build 步骤即使到达也会失败。** 安装、生成、单元测试均可复现通过；lint / typecheck / build 存在可定位的真实错误。

---

## 1. 工具链版本

| 工具 | 本机版本 | 仓库声明 | 一致性 |
|---|---|---|---|
| Node | v26.7.0 | `engines.node: >=20`（root package.json） | 满足（CI 用 20，本机 26，见 §5 差异说明） |
| pnpm | 9.15.4（homebrew） | `packageManager: pnpm@9.0.0` | **同 major 不同 minor**。本机无 corepack，无法强制 9.0.0；9.x 系列 lockfileVersion 9 兼容，未出现 `ignored build scripts` 类假失败。CI 通过 `pnpm/action-setup@v4` 读取 packageManager，用 9.0.0 |
| Go | 1.27.1 darwin/arm64 | 尚无 Go 代码 | 供 `apps/api-go` 骨架使用 |
| Docker | **未安装** | infra/docker/docker-compose.yml | **环境缺口**：Compose 配置校验、容器健康冒烟无法本地执行，只能静态校验（见 §3.9/§3.10） |
| MySQL client | 未安装 | — | 不影响静态基线；数据库集成测试待 Docker 可用后补 |
| mongosh | 未安装 | — | 同上 |
| git | clean worktree | — | 基线从干净工作区开始（仅本报告新增文件） |

数据库版本以 `infra/docker/docker-compose.yml` 镜像 tag 为准（本机未运行容器，未实测连接）：mysql、mongo、redis、qdrant、elasticsearch、minio、litellm(+postgres)、akshare、model-service、crawl4ai。

## 2. 基线事实复核（对照任务提示词第二节）

| 提示词声称 | 实测（commit 95759f59） | 结论 |
|---|---|---|
| apps/api/src 约 778 文件 | 770 个 .ts/.js 文件 | 基本吻合（约数） |
| 42 个业务模块 | `src/modules/` 下 41 个模块目录 | 基本吻合 |
| 71 REST Controller | 71 | ✅ 一致 |
| 25 GraphQL Resolver | 25 | ✅ 一致 |
| 6 WebSocket Gateway | 6 | ✅ 一致 |
| 10 队列 Processor | 10 | ✅ 一致 |
| 222 Service | 222 | ✅ 一致 |
| SDL 约 150 type / 85 input / 53 enum | 150 / 85 / 53（`apps/api/schema.gql`，2925 行，自动生成物） | ✅ 一致 |
| 约 76 Query / 58 Mutation / 4 Subscription | 77 / 57 / 4（`alertEvents`、`analysisEvents`、`assistantEvents`、`queueEvents`） | ✅ 基本一致 |
| Prisma 93 model / 53 enum | 93 / 53（schema.prisma 2478 行） | ✅ 一致 |
| Web 72 路由 / 305 TSX | 72 个 page.tsx / 305 个 TSX | ✅ 一致 |
| Web 3 个测试文件 5 用例 / Vector 4 文件 11 用例 / 主 API 无测试 | 3 文件 5 用例（全过）/ 4 文件 11 用例（全过）/ `apps/api` 0 个测试文件 | ✅ 一致 |
| 巨型文件：地图 ~4400 / 告警 ~4000 / 抓取详情 ~3800 | war-map.tsx 4420 / alert-center.tsx 4074 / task-detail.tsx 3822；另有 CreateCrawlTaskDrawer 3147、realtime-signals 面板 3014、crawl-monitor 2993、quality 2875 等 | ✅ 一致（完整清单见 system-map） |
| 后端 2000–5200 行巨型服务 | crawl-frontier.service 5217、news-source.scheduler 4837、crawl-metadata 3389、litellm 3073 等 | ✅ 一致 |
| globals.css 约 2120 行 | 2120 行 | ✅ 一致 |
| 前端混用 Apollo/TanStack/fetch/Axios/Zustand/NextAuth/Socket.IO | 依赖确认：@apollo/client 3.11、@tanstack/react-query 5.51、axios 1.6.8、zustand 4.5.4、next-auth 5.0.0-beta.21、socket.io-client 4.8.1；**app/components/hooks 中 0 个文件 import axios**（axios 声明未用或仅残留在依赖里），**71 个文件直接 `fetch(`** | 基本吻合（axios 实际使用面待前端勘察报告确认） |

## 3. 质量命令实测结果

分类说明：**环境问题**（本机缺工具/缺配置）/ **依赖问题** / **生成代码问题** / **真实编译错误** / **真实运行错误**。

### 3.1 `pnpm install --frozen-lockfile` — ✅ PASS

```
Scope: all 11 workspace projects
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 2.2s
```
（node_modules 已与 lockfile 同步；husky prepare 正常执行，仅报 install 命令 DEPRECATED 警告，非失败。）

### 3.2 `pnpm --filter db run prisma:generate` — ✅ PASS

Prisma Client v5.22.0 生成成功（286ms）。仅 Node `module.register()` deprecation 警告（DEP0205，非失败）。

### 3.3 GraphQL codegen — ⚠️ 根脚本损坏；正确入口可用

- `pnpm codegen`（root）— ❌ **FAIL**：`sh: graphql-codegen: command not found`。根脚本直接调用 `graphql-codegen` 二进制，但 `@graphql-codegen/cli` 声明在 `apps/web` 而非根 devDependencies。**CI 不跑 codegen，因此从未暴露。**
- `pnpm --filter @modular/web run generate` — ✅ PASS：基于 `codegen.cjs`（schema 指向本地快照 `apps/api/schema.gql`，可离线复现）。
- 注意存在**两份配置**：`codegen.cjs`（实际使用，指向本地 SDL 快照）与 `codegen.yml`（根脚本引用，指向 `http://localhost:4000/graphql` 活体 API）。`codegen.yml` 属于遗留/失效配置。
- **发现 schema 漂移**：重新生成后 `apps/web/graphql/generated.ts` 与提交版本不一致（+2/-1）。提交版本的 `QueueStatsDocument` gql 字符串缺少 `countsAvailable` 字段，但同文件 TS 类型里却有该字段——类型与文档不一致，系手改产物嫌疑。消费方 `apps/web/app/(app)/components/system-health-context.tsx:205` 读取 `queueStats?.countsAvailable`。运行时影响被 `prebuild`（codegen 再生成）缓解——实测 pnpm 9.15.4 会执行 pre-scripts——但 typecheck/lint 门禁检查的是陈旧提交版文件。已计入 bug-ledger（BL-07）。

### 3.4 `pnpm lint`（turbo fan-out） — ❌ FAIL

turbo 结果：`Tasks: 6 successful, 8 total`，`Failed: @modular/web#lint`（exit 1）。

本地 `apps/web` lint 全量错误 **35 个 Error**（另有多条 Warning）：

| 规则 | 数量 |
|---|---|
| import/order | 19 |
| @typescript-eslint/array-type（`Array<T>` 应为 `T[]`） | 10 |
| @typescript-eslint/no-unused-vars | 6 |

代表性位置：`apps/web/lib/server-public-portal.ts:66,74,80`（array-type）；import/order 与 unused-vars 分布在多个组件（完整清单见 `/tmp/web-lint-full.log`，修复 PR 中附全量列表）。

**与 CI 的差异（重要）**：CI 日志（run 31933703947）额外出现约 16 处 `Unable to resolve path to module '@modular/utils'`（import/no-unresolved）。原因：`packages/utils` 的 `main/types` 指向 `dist/`，本机存在历史构建产物所以可解析；CI 全新安装后未先 build packages，dist 不存在 → 解析失败。**分类：依赖/工程化问题（构建顺序），叠加真实代码 lint 错误。**

**勘误（2026-09-03 修复过程中实测）**：初版报告称"其余 6 个包（api、vector、ais-relay、db、mongo、config）lint 全部通过"——**不准确**。turbo 在 `@modular/web#lint` 失败后取消了尚未完成的任务（6 successful + 1 failed = 7/8，余下 1 个为 cancelled）。修复 web lint 后复跑，`@modular/api#lint` 实际有 **32 个 Error**（import/order 28、array-type 1、no-unused-vars 3，详见 BL-09），此前从未在 CI 中跑到。vector、ais-relay、db、mongo、config 五个包 lint 确实通过。**教训：turbo 失败即取消会掩盖后续包的失败，分层修复时必须逐包复跑。**

### 3.5 `pnpm typecheck`（turbo fan-out） — ❌ FAIL

turbo 结果：`Tasks: 5 successful, 8 total`，`Failed: @modular/db#typecheck`（exit 2）。

```
packages/db/src/rbac-default-description-backfill.ts(7,8): error TS2307: Cannot find module '@modular/config' or its corresponding type declarations.
packages/db/src/rbac-default-description-backfill.ts(54,6): error TS7006: Parameter 'definition' implicitly has an 'any' type.
packages/db/src/rbac-default-description-backfill.ts(56,40): error TS7006: ...
packages/db/src/seeds.ts(4,8): error TS2307: Cannot find module '@modular/config' ...
packages/db/src/seeds.ts(148,38): error TS7006: ...
```

根因：`packages/db/tsconfig.build.json` 显式设置 `"paths": {}`（覆盖 `tsconfig.json` 中指向 `../../config/src/index.ts` 的 paths 映射），而 `@modular/config` 的 `types` 指向不存在的 `dist/index.d.ts`（packages/config 从未构建）。db 的 typecheck 脚本用的是 `tsconfig.build.json`。**分类：工程化问题（tsconfig 配置矛盾）——CI 尚未跑到此步骤（lint 先挂），本地已证明必失败。**

注：`packages/mongo` 的 typecheck 存在同构问题（同款 `paths:{}` 覆盖 + `@modular/utils` 无 dist），基线运行中被 turbo 取消未暴露，修复时一并处理。

### 3.6 Web 组件测试 `pnpm --filter @modular/web test -- --coverage` — ✅ PASS

```
Test Files  3 passed (3)
     Tests  5 passed (5)
```
覆盖率（仅统计被测文件）：All files 47% stmts / 52.57% branch / 17.64% funcs。coverage thresholds 已配置（vitest.config.ts:26）并通过。**但全仓 305 个 TSX 中仅 3 个文件有测试**——覆盖面极窄，这是结构性缺口而非本次失败。

### 3.7 Vector 单元测试 `pnpm --filter @modular/vector test` — ✅ PASS

```
Test Files  4 passed (4)
     Tests  11 passed (11)
```
（internal-auth guard 4 例、qdrant.service 2 例、vector.controller 3 例、vector.service 2 例。）

### 3.8 CI 等价构建 — ❌ FAIL（仅 web）

命令（与 `.github/workflows/ci.yml` 一致，含 CI env）：

```
turbo run build --env-mode=loose --filter=@modular/ais-relay --filter=@modular/api --filter=@modular/vector --filter=@modular/web
```

结果：`Tasks: 8 successful, 9 total`，`Failed: @modular/web#build`（exit 1，18.3s）。

- ✅ ais-relay、api、vector、db、mongo、utils、config、infra-scripts 构建全部成功（`apps/api/dist/main.js`、`apps/vector/dist/main.js`、`apps/ais-relay/dist/index.js` 均产出）。
- ❌ web 构建失败：**Edge Runtime 禁止动态代码求值**。

```
../../packages/utils/dist/tracing.js
Dynamic Code Evaluation (e. g. 'eval', 'new Function', 'WebAssembly.compile') not allowed in Edge Runtime
Import trace: middleware.ts → ./lib/auth.ts → ./lib/env.server.ts → ../../packages/utils/dist/index.js → tracing.js
```

根因：`packages/utils/src/tracing.ts:30` 使用 `eval("require")` 动态加载 `node:async_hooks`（规避打包器解析 Node 内建模块）。运行时有 window/Node 守卫，但 webpack 对 Edge bundle 做**静态检测**即拒绝编译。该代码自 2025-12-16（`916b4a3b`）就存在；web 构建门禁 2026-08-15 才引入且从未跑到 Build 步骤，故一直潜伏。**分类：真实编译错误（P1，阻断 web 出包）。**

**第二层潜伏失败（BL-08，修复 BL-04 后暴露）**：Edge eval 修复后编译通过，但 "Collecting page data" 阶段抛 `TypeError: (0, d.createContext) is not a function`。根因：`apps/web/app/layout.tsx`（Server Component）import `resolveLocale` 自 `@/lib/i18n`，而该文件顶层 import `react-i18next`（其模块作用域调用 `React.createContext`——该 API 在 react-server 条件下不存在）。即 RSC 边界违规。修复：拆分 `lib/i18n.ts`（服务端安全：locale 解析 + 格式化纯函数）与 `lib/i18n-client.ts`（`"use client"`：i18next 初始化、语言持久化），并更新 4 个引用点。**同为"从未跑到"的潜伏 P1。**

### 3.9 `pnpm --filter @modular/infra-scripts run compose:images:check` — ✅ PASS

`Compose image defaults are pinned.`（REL-03 关闭属实：镜像已按 digest 固定。）

### 3.10 `pnpm --filter @modular/infra-scripts run env:check` — ❌ FAIL（本地环境配置缺口）

```
❌ root environment failed validation Error: AISSTREAM_API_KEY is required: the ais-relay refuses to start without it and api depends on a healthy relay
⚠️ Missing docker env file at /Users/oo/project/newwei/infra/docker/.env
```

本地 `.env` 中 `AISSTREAM_API_KEY=` 为**空值**；`infra/docker/.env` 未创建（`.env.sample` 存在）。**分类：环境问题（本地密钥未配置），非代码错误**；fail-closed 行为符合设计。

### 3.11 Docker Compose 配置校验 / 容器健康冒烟 — ⛔ 未运行

本机未安装 Docker。`pnpm docker:up`、`docker compose config`、`docker:smoke:ais-relay-startup` 无法执行。CI 中也无 Compose 运行时冒烟（仅静态 images:check）。**列入未验证内容（§5）。**

### 3.12 CI 状态（GitHub Actions 实查）

`gh run list --branch main`：**main 最近 3 次 CI 全部 failure**（2026-08-15 16:47、16:53，2026-08-16 07:22）。CI 工作流 2026-08-15 才引入（与审计报告"2026-08-16 重建 CI"一致），**从未绿过**。首次失败步骤：Lint。

## 4. 失败汇总与优先级（详见 bug-ledger.md）

| # | 现象 | 分类 | 级别 |
|---|---|---|---|
| BL-01 | main CI 从未通过：lint 35 个真实错误（web） | 真实代码错误 | **P0**（质量门禁失效） |
| BL-02 | CI 中 `@modular/utils` import/no-unresolved（lint 前未 build packages，dist 缺失） | 依赖/构建顺序 | **P0**（同上，与 BL-01 叠加） |
| BL-03 | `packages/db` typecheck 必挂（`tsconfig.build.json` 的 `paths:{}` + config 无 dist） | 工程化配置矛盾 | **P0** |
| BL-04 | web 构建失败：Edge Runtime 检测到 `tracing.ts` 的 `eval("require")` | 真实编译错误 | **P1**（阻断出包） |
| BL-05 | 根脚本 `pnpm codegen` 损坏（二进制不在根依赖；引用失效的 codegen.yml） | 工程化 | P2 |
| BL-06 | codegen 无 CI 门禁 → schema 漂移不可检测 | 工程化 | P2（结构性） |
| BL-07 | 提交版 `generated.ts` 与 schema 漂移（QueueStatsDocument 缺 `countsAvailable`，类型与文档不一致） | 生成代码问题 | P2 |
| BL-08 | web 构建第二层失败：layout.tsx（RSC）→ lib/i18n.ts → react-i18next 的 `createContext`（react-server 条件无此 API） | 真实编译错误 | **P1**（阻断出包，被 BL-04 掩盖） |
| BL-09 | `apps/api` lint 32 个 Error（import/order 28、array-type 1、unused-vars 3），被 web lint 失败的 turbo 取消效应掩盖 | 真实代码错误 | **P0**（同 BL-01，质量门禁失效） |
| — | 本地 `.env` AISSTREAM_API_KEY 为空、`infra/docker/.env` 缺失 | 环境 | 配置项（非代码） |

**P0 定义对照**：任务提示词定义 P0 含"无法启动、核心页面崩溃、数据泄漏"。CI 全红 = 质量门禁失效 = 不可合并不可发布，按"先建立可复现基线"的第一目标计为 P0。

## 5. 环境差异与未验证内容

1. **Node 26 vs CI Node 20**：本机 v26.7.0，CI v20。未发现 Node 26 特有失败；但最终验证以 CI（Node 20）为准。
2. **pnpm 9.15.4 vs 声明 9.0.0**：本机无 corepack。建议后续在仓库或 CI 明确 pnpm 版本策略（如启用 corepack 或 packageManager 已声明即以 CI 为准）。本次未复现 `ignored build scripts` 假失败。
3. **未运行**：Docker Compose 栈启动、数据库真实连接、Testcontainers 集成测试、Playwright、容器健康冒烟——原因：本机无 Docker。修复 BL-01~04 后的第一优先补验证项。
4. **未运行**：`pnpm dev` 全栈联调（依赖数据库栈，同上）。
5. **API 运行时冒烟**：`apps/api` 可构建（tsc 通过）但未启动（需要 MySQL/Mongo/Redis/外部服务）。健康语义（`/healthz/live` vs `/health`）仅从代码与 README 确认，未实测。

## 6. 可复现性说明

- 所有命令在干净 worktree（仅新增 docs/refactor/）上执行，工具版本见 §1。
- lint/typecheck/build 失败均可通过本文命令复现；对应日志已存档（/tmp/web-lint-full.log、/tmp/build-ci.log）。
- 审计报告 `audit-report-newwei-2026-08-13.md` 声称的 7 个开放 Finding 中，6 个已核实关闭（TST-05 覆盖率阈值已配、TST-06 vector 测试已建、REL-03 镜像 digest 已固定、REL-08 version.json 已删、TYPES-03 见 bug-ledger 复核），**BAPI-01（GraphQL 列表无分页）确认仍开放**（`apps/api/src/graphql/resolvers/alerts.resolver.ts:29,49` 全量返回；`news-events.resolver.ts:80-105` 仅 limit 无 cursor）。

## 7. 第一阶段行动结论

按任务要求，Go 迁移与前端重构开始前必须先：

1. 修复 BL-01~04（让 main CI 变绿）——lint 35 处、db tsconfig、web Edge eval、（顺带）BL-05/07 的 codegen 修正与重新提交。
2. 把 codegen drift 检查加入 CI（防 BL-06/07 复发）。
3. 之后才进入契约冻结与 `apps/api-go` 骨架。

## 8. 修复后复验记录（2026-09-03，BL-01~09 全部关闭）

修复内容：BL-01 web 35 处 lint（19 import/order + 10 array-type 自动修复，6 unused-vars 手工）；BL-02 turbo.json `lint.dependsOn:["^build"]`、`typecheck.dependsOn:["^typecheck","^build"]`；BL-03 db/mongo 新增 `tsconfig.typecheck.json`（paths 指向源码，参照 api/vector 先例）；BL-04 `tracing.ts` 改用 `process.getBuiltinModule("node:async_hooks")`（Node ≥20.16，打包器不可静态解析）；BL-05 根 `codegen` 脚本改指 `@modular/web run generate`、删除失效 codegen.yml；BL-06 CI 新增 codegen drift 检查步骤；BL-07 重新生成 `generated.ts`；BL-08 i18n 服务端/客户端拆分；BL-09 api 32 处 lint。

复验命令与结果（本机 Node 26.7.0 / pnpm 9.15.4，工作区含全部修复）：

| 命令 | 结果 |
|---|---|
| `pnpm lint` | ✅ exit 0（仓库史上首次全绿） |
| `pnpm typecheck` | ✅ exit 0（14/14 tasks） |
| `pnpm --filter @modular/web test -- --coverage` | ✅ 3 files / 5 tests passed |
| `pnpm --filter @modular/vector test` | ✅ 4 files / 11 tests passed |
| `pnpm build` | ✅ 9/9 tasks（含 web 全路由出包、middleware 141 kB） |
| `pnpm --filter @modular/web run generate && git diff --exit-code apps/web/graphql/generated.ts` | ✅ 修复提交后无漂移（提交前 diff 恰为 BL-07 预期 +2/-1） |

未验证项：CI（Node 20）远端运行结果待 push 后观察；Docker 依赖项同 §5。
