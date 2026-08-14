# Fuck My Shit Mountain Audit Report

**Project:** newwei / modular-monolith（全球态势感知与新闻情报分析平台）
**Audit mode:** full
**Date:** 2026-08-13
**Reviewer:** opencode (deepseek-v4-pro) — fuck-my-shit-mountain skill
**Commit:** `beb32ead`（branch `main`）
**Remediation review:** 2026-08-14 — 下文只保留仍开放的 Finding。

---

## 1. Executive Summary

这是一个体量可观、工程底子相当扎实的多租户情报平台（pnpm + Turborepo monorepo：NestJS 11 API + Next.js 15 Web + 向量服务 + AIS relay，Prisma/MySQL + Mongoose/MongoDB + BullMQ/Redis + Qdrant + LiteLLM）。核心安全与一致性基础设施的完成度显著高于同规模项目：认证采用 bcrypt、refresh token 轮换与黑名单、TOTP MFA 与恢复码、按组织隔离的 RBAC、GraphQL 深度/复杂度限制、SSRF 校验器、MongoOutbox 事务外发模式、DataLoader 批量加载、生产环境异常过滤器脱敏、近乎全覆盖的 Docker healthcheck 与启动依赖链。这些都不是"看起来对"，而是有具体实现与单测佐证。

仍开放的风险集中在两处：无 CI、无组件/行为测试（REL-01、TST-03/05/06）；发布面仍是 root 容器、滚动 tag 与默认弱凭据（REL-02~08）。

**亮点**：outbox 事务外发、DataLoader、异常脱敏、SSRF 防护、refresh token 轮换、MFA、组织隔离、新闻管线/助手输入护栏、助手按组织额度、LiteLLM fallback 观测、解析失败进 DLQ、ES/向量降级打点是本项目值得保留并继续沿用的工程资产。

### Score Dashboard

```
Security        ██████░░░░  6.0  B   强实现，但默认配置面有已知弱密钥与明文密钥
Stability       ███████░░░  6.5  B   无空 catch、超时齐全；跨库写与多处原子性缺口
Performance     ███████░░░  7.0  A   DataLoader 与分页到位，未见明显 N+1
Testing         ████░░░░░░  4.0  C   无 CI、e2e 全 mock、前端测试为源码文本断言
Maintainability █████░░░░░  4.5  C   多个 4000-8200 行文件与 god service
Design          █████░░░░░  5.0  B   SRP 普遍违反，但 outbox/loader 模式优秀
Release         ████░░░░░░  4.0  C   无 CI、root 容器、未固定镜像、默认弱凭据
─────────────────────────────────────
Overall         █████░░░░░  5.3  B
```

每个维度 0.0–10.0，**越高越好（10=干净，0=屎山）**。评分为基于证据的综合判断，非机械扣分；各维度一句话判据见上表。**上表为审计当日（`beb32ead`）基线评分，不因后续修复回溯改写。**

### Finding Statistics

仍开放（2026-08-14）：

| Severity | Open Confirmed | Open Suspected |
|----------|----------------|----------------|
| Critical | 0 | 0 |
| High | 5 | 0 |
| Medium | 11 | 0 |
| Low | 5 | 0 |
| Info | 0 | 0 |
| **Total** | **21** | **0** |

## 2. Project Map

**运行时组件**：`apps/api`（NestJS 网关：REST `/api` + GraphQL `/graphql` + Socket.IO + Swagger + Bull Board）、`apps/web`（Next.js 15 App Router，路由组 `(app)` 控制台 / `(portal)` 门户 / `(reader)` 阅读器 / `(auth)` 登录）、`apps/vector`（Qdrant 适配层，`x-internal-token` 内网鉴权）、`apps/ais-relay`（AISStream WebSocket 聚合为 `/ais/snapshot`）。

**数据层**：MySQL（Prisma，强一致：组织/用户/RBAC/系统设置/任务状态）＋ MongoDB（Mongoose，半结构：新闻内容、流水线结果、运行日志）＋ Redis（缓存 + BullMQ 队列）。一致性桥梁是自研 **MongoOutbox** 事务外发模式（MySQL 事务内写 outbox 行，cron/`setImmediate` 排空，`updateMany` 租约占用，幂等 Mongo upsert）。

**外部接口**：Crawl4AI（抓取，走 SSRF 代理）、LiteLLM（LLM 网关）、Akshare（经济数据）、Model Service（预测/聚类）、GDELT/OpenSky（态势兜底）、MinIO/S3、Qdrant、Elasticsearch。

**AI 表面**：`news-pipeline`（LLM 清洗/去重/分类，最高频）、`assistant`（Query/Report/Forecast，带 `web_search_preview` 工具）、`analysis`（关联/异常）、`situation-monitor`。护栏覆盖助手与新闻管线（pre-call）。

**安全边界**：JWT（issuer/audience/jti 黑名单，每次请求回查 DB profile）、RBAC（按组织，actor 不可授予超出自身权限）、`validateSsrfUrl`、GraphQL 复杂度限制、登录限流。

**测试结构**（审计当日）：API 263 个 `*.spec.ts` + 2 个 e2e；Web 189 个 Vitest spec；vector 无测试。**2026-08-14：全部 `*.spec.ts`/`*.test.ts` 与 Jest/Vitest 工具链已删除（`a452f264`），仓库现以 lint/typecheck + 静态审查为唯一验证；仍无 CI。**

**发布**：Docker Compose 本地栈；`docker-up.js` 有锁文件一致性/Prisma 迁移 id/Redis AOF 完整性预检；无 semver/changelog/SBOM/签名；镜像多按 tag 非 digest。

### Coverage Matrix

| Dimension | Coverage | Evidence inspected | Exclusions / limits |
|-----------|----------|--------------------|---------------------|
| Architecture | High | apps/api 模块结构、packages、outbox 模式、边界 | 未运行依赖图工具 |
| Security | High | guards/auth/rbac/SSRF/CORS/密钥/secrets 扫描、.env* | 未做动态渗透 |
| Stability | High | catch/timeout/fallback 全库扫描、异常过滤器 | 未做故障注入 |
| Performance | Medium | DataLoader、分页、索引迁移、N+1 抽样 | 未压测、未看 bundle 拆分细节 |
| Testing | High | 审计当日 456 测试文件全量清单、CI 缺失、e2e/单元抽样；2026-08-14 复核套件已删 | 审计当日未跑全量测试套件 |
| Maintainability | High | 全库行数统计、type 逃逸计数、大文件清单 | 未度量圈复杂度 |
| Design | High | 原则映射（SRP/DRY/fail-fast/类型逃逸） | — |
| Release | High | Dockerfile/compose/CI/锁文件/版本/SBOM 扫描 | 未构建镜像 |
| Documentation | Medium | README/AGENTS.md/docs 与代码对读 | 未逐篇核对全部 docs |
| Configuration | High | env.schema/Zod/process.env 散布/默认值 | — |
| Data-Integrity | High | 事务/幂等/迁移/乐观锁扫描 | — |
| Privacy | Medium | PII 字段、日志、.env 样例 | 未做数据流全链追踪 |
| Accessibility | Low | 组件静态审读 | 无浏览器实测，见章节 |
| Supply-Chain | High | lockfile/install 脚本/Docker 固定 | 未跑 SBOM 工具 |
| Cost | Medium | LLM 预算/重试/缓存扫描 | 无计费数据 |
| AI-Safety | High | prompt 模板/工具授权/护栏/检索范围 | — |
| Fallback | High | 全库空 catch/兜底扫描 | — |
| Testing-Authenticity | High | e2e mock/源码断言/私有方法 spy | — |
| Type-Safety | High | 全库 `any`/断言/`!`/ts-ignore 计数 | — |
| Frontend-State | Medium | store/组件行数/状态重复 | 未运行客户端 |
| Backend-API | High | 校验/分页/N+1/错误响应 | GraphQL 校验接线未最终确认 |
| Dependency-Weight | Medium | package.json/import 搜索 | 未测真实 bundle 体积 |
| Code-Consistency | Medium | 命名/引号/import/错误风格抽样 | — |
| Comment-Coverage | High | TODO/FIXME 全库计数 | — |
| Concurrency | Medium | 读改写/锁/原子占用扫描 | 未跑 race 检测 |

## 3. Top Risks

1. **无 CI/CD**（REL-01, High）— lint/typecheck 从不自动运行；测试套件已删除。
2. **无前端组件渲染测试**（TST-03, High）— 假测试已删，行为测试未重建。
3. **容器以 root 运行**（REL-02, High）— 抓取浏览器进程以 root 跑，被攻破即容器 root。
4. **多个 4000–8200 行 god 文件**（MAINT-01, High）— 不可审查、回归面大。
5. **`undefined as unknown as ItemMetaModel`**（TYPES-01, High）— 伪造类型，下游无法信任空 meta。

## 4. Detailed Findings

### Finding: STAB-04 多处图表/摘要/设置静默 null

- Severity: Low
- Confidence: High
- Category: Stability
- Status: Confirmed
- Affected area: `dashboard.controller.ts:431`、`user-digest.service.ts:535`、`news-events.resolver.ts:65`
- Evidence: `getSpacetimeGeoHeatmap(...).catch(() => null)` 等。
- Problem: 流式面板/摘要/设置失败无上下文。
- Why it matters: 用户可见内容无声缺失。
- Realistic failure scenario: 热力图生成失败 → 面板空白。
- Minimal fix: 记 warn + 前端降级提示。
- Better long-term fix: 统一降级响应含错误码。
- Regression test suggestion: 单测断言失败路径记录日志。
- Estimated effort: 1 hour

### Finding: TST-03 无前端组件渲染测试

- Severity: High
- Confidence: High
- Category: Testing
- Status: Confirmed
- Affected area: `apps/web`（`vitest.config.ts` 已随套件删除）；`AGENTS.md` Verification 段
- Evidence: 2026-08-14 复核：仓库 0 个 `*.spec.ts`/`*.test.ts`；无 `@testing-library/react`/`jsdom`/`render(`；`AGENTS.md` 明确禁止新增测试文件，验证仅限 lint/typecheck。
- Problem: React 19 + AntD 大型控制台零组件覆盖。
- Why it matters: 渲染/事件/prop 接线错误完全无保护。
- Realistic failure scenario: 组件渲染崩溃/事件失效，测试不覆盖。
- Minimal fix: 增加 jsdom 环境 + 关键页面组件测试。
- Better long-term fix: 关键工作流（登录后列表/设置保存）组件级测试 + Playwright。
- Regression test suggestion: 关键工作流组件级测试。
- Estimated effort: 2–4 days

### Finding: TST-05 覆盖率配置了但从不收集/无阈值

- Severity: Medium
- Confidence: High
- Category: Testing
- Status: Confirmed
- Affected area: `apps/api/jest.config.ts`（已删除）、`AGENTS.md` Verification 段
- Evidence: 审计当日 `collectCoverageFrom` 已配但脚本不带 `--coverage`、无 `coverageThreshold`。2026-08-14 复核：Jest/Vitest 与覆盖率配置随 `a452f264` 删除；仍无覆盖率门禁、无 `pnpm test`。
- Problem: 无法知道代码覆盖了什么；现已无测试套件可收集覆盖率。
- Why it matters: 关键模块（如 model-service）零覆盖无人察觉。
- Realistic failure scenario: 覆盖率持续下降无门禁。
- Minimal fix: 加 `--coverage` 与阈值门槛，接入 CI。
- Better long-term fix: 覆盖率报告 + 关键路径门禁。
- Regression test suggestion: CI 门禁断言覆盖率不低于阈值。
- Estimated effort: 1–2 hours

### Finding: TST-06 apps/vector 零测试且无 test 脚本

- Severity: Medium
- Confidence: High
- Category: Testing
- Status: Confirmed
- Affected area: `apps/vector/package.json`、`AGENTS.md` Verification 段
- Evidence: 无 `test` 脚本、0 spec。2026-08-14 复核：全仓测试工具链已删，`AGENTS.md` 禁止新增 spec；vector 鉴权/检索仍无验证。
- Problem: 整个可部署服务无保护。
- Why it matters: 向量鉴权/检索核心无验证。
- Realistic failure scenario: 鉴权/orgId 过滤回归，测试不覆盖。
- Minimal fix: 为其鉴权/检索核心加单测。
- Better long-term fix: 纳入 CI 与统一测试门槛。
- Regression test suggestion: internal-auth guard 与 orgId 过滤测试。
- Estimated effort: 1 day

### Finding: TST-07 生产代码按 NODE_ENV==="test" 分支

- Severity: Low
- Confidence: High
- Category: Testing
- Status: Confirmed
- Affected area: `apps/api/src/modules/crawl/crawl-execution.service.ts:2009`
- Evidence: `sleep(ms)` 在 `NODE_ENV==="test"` 时直接 `Promise.resolve()`（2026-08-14 复核：该分支仍在；测试套件已删，此生产路径测试缝仍泄漏）。
- Problem: 测试缝泄漏进生产路径，节流/退避时序在生产与测试不一致。
- Why it matters: 节流行为在测试中不可见。
- Realistic failure scenario: 生产节流 bug 无法被测试捕获。
- Minimal fix: 注入可替换的 timer，而非环境分支。
- Better long-term fix: 时间抽象注入。
- Regression test suggestion: 以注入 timer 重写。
- Estimated effort: 1–2 hours

### Finding: REL-01 无 CI/CD 流水线

- Severity: High
- Confidence: High
- Category: Release
- Status: Confirmed
- Affected area: 仓库根（`.github/workflows` 不存在）
- Evidence: `ls .github` 不存在；`.husky/` 仅有 `_` stub，无真实 pre-commit/commit-msg；lint-staged/commitlint 配置未生效。
- Problem: lint/typecheck 从不自动运行；测试套件已删除（`a452f264`）；任何代码可直接合入 main。
- Why it matters: 无合并门禁，回归无人拦截。
- Realistic failure scenario: 破坏性变更直接合入 main 无人发现。
- Minimal fix: 新增 CI（lint/typecheck/build 门禁）。
- Better long-term fix: PR 门禁 + 覆盖率 + 依赖漏洞扫描。
- Regression test suggestion: CI 跑 `pnpm lint && pnpm typecheck`。
- Estimated effort: 0.5–1 day

### Finding: REL-02 容器以 root 运行

- Severity: High
- Confidence: High
- Category: Release
- Status: Confirmed
- Affected area: `infra/docker/*.Dockerfile`、`infra/akshare/Dockerfile`、`infra/model-service/Dockerfile`
- Evidence: 无任何 `USER` 指令。
- Problem: API/web/vector/ais-relay 及抓取浏览器进程均以 root 跑；无 `read_only`/`cap_drop`/`security_opt`。
- Why it matters: 任一服务被攻破即容器 root。
- Realistic failure scenario: crawl4ai 处理恶意网页被利用 → 容器 root。
- Minimal fix: 加非 root `USER` + `cap_drop: ALL`。
- Better long-term fix: 最小权限 + 只读根文件系统。
- Regression test suggestion: CI 断言镜像非 root（`docker inspect`）。
- Estimated effort: 0.5–1 day

### Finding: REL-03 镜像按可变 tag 固定

- Severity: Medium
- Confidence: High
- Category: Release
- Status: Confirmed
- Affected area: `infra/docker/docker-compose.yml:123,137,267`
- Evidence: `minio:latest`、`minio/mc:latest`、`unclecode/crawl4ai:0`（滚动 tag）。
- Problem: 上游镜像变化静默改变构建（供应链风险）。
- Why it matters: 构建不可复现。
- Realistic failure scenario: 上游镜像更新引入破坏 → 静默影响。
- Minimal fix: 按 digest 固定。
- Better long-term fix: 全部镜像 digest 固定 + SBOM。
- Regression test suggestion: 校验清单用 digest。
- Estimated effort: 1–2 hours

### Finding: REL-04 NEXTAUTH_SECRET 经 build ARG→ENV 烧入镜像

- Severity: Medium
- Confidence: High
- Category: Release
- Status: Confirmed
- Affected area: `infra/docker/runtime.Dockerfile:6,27`
- Evidence: `ARG NEXTAUTH_SECRET=change_me_...` + `ENV NEXTAUTH_SECRET=$NEXTAUTH_SECRET`。
- Problem: 真实密钥若作为 build arg 传入即残留在 `docker history` 与推送镜像。
- Why it matters: 密钥泄露到镜像层。
- Realistic failure scenario: 推送镜像 → 任何人 `docker history` 提取密钥。
- Minimal fix: 仅运行时注入（compose `env_file` 已做，删除 bake）。
- Better long-term fix: 密钥统一运行时注入。
- Regression test suggestion: 检查镜像层不含 secret。
- Estimated effort: <1 hour

### Finding: REL-05 数据存储默认弱凭据/无鉴权

- Severity: Medium
- Confidence: High
- Category: Release
- Status: Confirmed
- Affected area: `infra/docker/docker-compose.yml:12-13,34-35,81-82,126-127`
- Evidence: Mongo `root:secret`（硬编码）、MySQL `secret`、litellm-postgres `litellm:litellm`、MinIO `minioadmin`；Redis/Qdrant 无密码、ES `xpack.security.enabled:false`。
- Problem: 默认栈任何可访问主机即可读取全部数据。
- Why it matters: 数据未授权访问。
- Realistic failure scenario: 默认部署 → 内网任何人连 Redis/Mongo 读数据。
- Minimal fix: 强制随机凭据 + Redis/Qdrant/ES 开鉴权。
- Better long-term fix: 一键生成强随机凭据并写入 .env。
- Regression test suggestion: 预检脚本断言无默认凭据。
- Estimated effort: 0.5–1 day

### Finding: REL-06 端口发布到 0.0.0.0

- Severity: Medium
- Confidence: High
- Category: Release
- Status: Confirmed
- Affected area: `infra/docker/docker-compose.yml`（多处）
- Evidence: 3306/27017/6379/9200/9000-9001/4001/8082/3000 等无 `127.0.0.1:` 绑定。
- Problem: 全栈（含管理控制台、LLM 网关、crawl4ai 面板）对任意网卡可达。
- Why it matters: 本地栈暴露到局域网。
- Realistic failure scenario: 本机默认栈被同网段主机访问。
- Minimal fix: 本地栈绑定 `127.0.0.1`。
- Better long-term fix: 网络分段 + 端口策略。
- Regression test suggestion: compose 配置审查。
- Estimated effort: <1 hour

### Finding: REL-07 LiteLLM master key 默认缺失

- Severity: Medium
- Confidence: High
- Category: Release
- Status: Confirmed
- Affected area: `infra/docker/docker-compose.yml:228-230`
- Evidence: 空 `LITELLM_MASTER_KEY` 时 `unset`，代理在 :4001 无鉴权。
- Problem: 任意客户端可盗用 LLM 网关计费。
- Why it matters: 计费滥用。
- Realistic failure scenario: 默认部署 → 局域网任何人用 LLM 网关。
- Minimal fix: 缺失即 fail-closed 或生成随机 key。
- Better long-term fix: 网关鉴权强制。
- Regression test suggestion: 预检断言 key 存在。
- Estimated effort: <1 hour

### Finding: REL-08 无 semver/changelog/SBOM/签名

- Severity: Medium
- Confidence: High
- Category: Release
- Status: Confirmed
- Affected area: `version.json:1` vs 各 `package.json`（`0.1.0`）
- Evidence: `version.json.latest_version=0.73.0` 与所有 `package.json` 的 `0.1.0` 不一致；无 changelog/changeset/SBOM/cosign。
- Problem: 无法识别破坏性变更，无发布记录，无依赖清单/签名。
- Why it matters: 发布不可追溯、不可验证。
- Realistic failure scenario: 版本混乱，无法审计发布内容。
- Minimal fix: 引入 changesets + SBOM 生成 + 镜像签名。
- Better long-term fix: 语义化发布流水线。
- Regression test suggestion: 发布流程自动生成 changelog/SBOM。
- Estimated effort: 1–2 days

### Finding: MAINT-01 多个 4000–8200 行 god 文件

- Severity: High
- Confidence: High
- Category: Maintainability
- Status: Confirmed
- Affected area: `apps/web/app/(app)/admin/ops/news-sources/news-sources-content.tsx`(8194)、`apps/web/components/settings/llm-gateway-settings-panel.tsx`(7525)、`apps/web/app/(app)/situation-monitor/situation-monitor-content.tsx`(7242)、`apps/api/src/modules/crawl/crawl-execution.service.ts`(7332)、`apps/api/src/modules/items/items.service.ts`(6270)、`dashboard-charts.service.ts`(5934)、`realtime-signals.service.ts`(5908)、`news-pipeline.service.ts`(5561)
- Evidence: 单文件含 27-65 个 `useState`、26-54 个 memo/callback、12-21 个 effect。
- Problem: 单文件多职责（SRP 1.1）、远超文件规模阈值（1.2）。
- Why it matters: 不可审查、合并冲突面大、回归风险高。
- Realistic failure scenario: 任一文件的小改动引入大范围回归。
- Minimal fix: 逐文件抽取子组件/子服务（先拆 UI 面板，再拆 service）。
- Better long-term fix: 建立文件规模门禁（>1000 行告警）。
- Regression test suggestion: 拆分前先补行为测试锚定。
- Estimated effort: 每文件 1–3 天

### Finding: TYPES-01 `undefined as unknown as ItemMetaModel` 伪造类型

- Severity: High
- Confidence: High
- Category: Design
- Status: Confirmed
- Affected area: `apps/api/src/graphql/resolvers/items.resolver.ts:942`
- Evidence: `meta: undefined as unknown as ItemMetaModel`。
- Problem: 用双重断言把 `undefined` 伪造成模型类型，下游消费方无法信任。
- Why it matters: 破坏类型安全保证。
- Realistic failure scenario: meta 缺失 → 下游访问属性崩溃。
- Minimal fix: 类型改为 `ItemMetaModel | undefined` 并处理空态。
- Better long-term fix: 边界用运行时校验替代断言。
- Regression test suggestion: 单测断言 meta 缺失时不崩溃。
- Estimated effort: <1 hour

### Finding: TYPES-02 GraphQL 上下文与鉴权守卫类型为 any

- Severity: Medium
- Confidence: High
- Category: Maintainability
- Status: Confirmed
- Affected area: `apps/api/src/graphql/graphql.module.ts:131-133,382`、`common/guards/gql-auth.guard.ts:34-39`
- Evidence: `req?: any; res?: any; extra?: any`、`handleRequest<TUser = any>(err: any, user: any, info: any, ...)`。
- Problem: 整个 GraphQL 上下文与鉴权路径无类型，错误 user 形状可令 resolver 崩溃。
- Why it matters: 核心路径失去类型保护。
- Realistic failure scenario: 错误 user 形状 → resolver 运行时崩溃。
- Minimal fix: 定义 `GraphQLContext`/`AuthenticatedUser` 类型。
- Better long-term fix: 全链类型化 + 边界校验。
- Regression test suggestion: 类型检查覆盖上下文。
- Estimated effort: 0.5 day

### Finding: TYPES-03 生产中 99 处 `as unknown as` 双重断言

- Severity: Medium
- Confidence: High
- Category: Design
- Status: Confirmed
- Affected area: 全库（如 `raw-item.loader.ts:23`、`llm-gateway-test.service.ts:1229`、`rate-limiter.service.ts:95,232`）
- Evidence: 全库 2793 处 `as any`（约 2767 在测试）、228 处 `as unknown as`（99 在生产）。
- Problem: 双重断言绕过类型系统，`.lean()` 返回未类型化文档被静默转成具体类型。
- Why it matters: 类型系统在边界失效。
- Realistic failure scenario: 上游结构漂移 → 运行时 undefined 访问。
- Minimal fix: 用运行时校验/显式类型守卫替换，优先处理 loader 与边界。
- Better long-term fix: lint 规则限制 `as unknown as`。
- Regression test suggestion: lint 规则阻止新增。
- Estimated effort: 2–3 days

### Finding: DEP-01 supercluster 两个应用均未使用

- Severity: Medium
- Confidence: High
- Category: Maintainability
- Status: Confirmed
- Affected area: `apps/web/package.json`、`apps/api/package.json`
- Evidence: 两处均声明 `supercluster` + `@types/supercluster`，全库 0 import。
- Problem: 两个 bundle/安装均含死依赖。
- Why it matters: 安装体积与攻击面增大。
- Realistic failure scenario: 死依赖引入漏洞仍需升级。
- Minimal fix: 移除。
- Better long-term fix: 依赖扫描识别未使用依赖。
- Regression test suggestion: 移除后 `pnpm build` 通过。
- Estimated effort: <1 hour

### Finding: DEP-02 three.js 仅 1 文件使用（~600KB chunk）

- Severity: Low
- Confidence: High
- Category: Performance
- Status: Confirmed
- Affected area: `apps/web/package.json`、`knowledge-graph-3d.tsx:9-10`
- Evidence: `three` 仅一处 import。
- Problem: 大体积依赖仅服务单个 3D 图。
- Why it matters: 首屏 bundle 增大。
- Realistic failure scenario: 未拆分 → 首屏加载大。
- Minimal fix: 动态 import + 按需 chunk 拆分。
- Better long-term fix: 审视重型可视化依赖的按需加载策略。
- Regression test suggestion: 验证 chunk 拆分后首屏不含 three。
- Estimated effort: 0.5 day

### Finding: DEP-03 war-map 归一化逻辑 store↔utils 重复

- Severity: Low
- Confidence: High
- Category: Maintainability
- Status: Confirmed
- Affected area: `apps/web/store/war-map-settings.ts:62-145`
- Evidence: 本地 `normalizeWarMapSettingsFallback` 重复实现 `@modular/utils` 已有逻辑，另有 `normalizeWarMapSettingsSafe` 包裹但仍保留本地 fallback。
- Problem: 双源真值漂移。
- Why it matters: 归一化规则两处不一致。
- Realistic failure scenario: 只改一处 → 两处行为不同。
- Minimal fix: 移除本地重复，统一走 utils。
- Better long-term fix: 单一归一化源。
- Regression test suggestion: 单测断言两处归一化一致。
- Estimated effort: 1–2 hours

### Finding: BAPI-01 若干 GraphQL 列表无分页

- Severity: Low
- Confidence: High
- Category: Maintainability
- Status: Confirmed
- Affected area: `alerts.resolver.ts:29,49`、`news-events.resolver.ts:76-101`
- Evidence: `alertChannels/alertRules` 返回全量数组；`newsEvents` 仅 `limit`（clamp 1-100）无 cursor。
- Problem: 规则/频道/事件增长后无分页。
- Why it matters: 数据量大后接口退化。
- Realistic failure scenario: 事件数超 100 无法翻页。
- Minimal fix: 加 cursor + total。
- Better long-term fix: 统一列表分页契约。
- Regression test suggestion: 分页返回测试。
- Estimated effort: 0.5–1 day

## 5. Architecture Concerns

**Coverage: High** — 已审读模块结构、outbox 边界、跨层依赖方向。

**Inspected evidence**: apps/api 模块清单、packages/db|mongo|utils|vector-client、MongoOutbox 实现、GraphQL loader/resolver、Docker 边界。

**Exclusions / limits**: 未运行依赖图/循环依赖检测工具。

### Architecture Summary

| Subtype | Count | Affected Areas | Recommended Action |
|---------|-------|----------------|-------------------|
| ModuleBoundary | 1 | `crawl-execution.service`(god service) | 拆分服务、抽出仓储边界 |
| BoundaryContract | 1 | vector 服务信任 body `orgId`（共享 token 后） | 向量边界显式契约 + 服务端重推导 |
| EvolutionRisk | 3 | 4000-8200 行文件、`CRAWL4AI_JSCODE_ENABLED` 默认开 | 抽取扩展点、收紧默认 |

**正向资产**：MongoOutbox 事务外发、DataLoader、按组织的请求级作用域、分层清晰（module → service → 仓储）在多数模块执行到位；`org`/`rbac`/`org-invite` 的多步写入正确包裹事务。

## 6. Security Concerns

**Coverage: High** — 已审 guards/auth/rbac/SSRF/CORS/密钥、`.env*`、Docker 默认凭据。

**Inspected evidence**: `common/guards`、`common/authz`、`auth/strategies`、`ssrf-url.validator.ts`、`global-exception.filter.ts`、`.env.example`、`infra/docker/.env.sample`、`docker-compose.yml`。

**Exclusions / limits**: 未做动态渗透/依赖 CVE 扫描。

已核实的**正确措施**：bcrypt cost 10、refresh token 轮换+黑名单、TOTP MFA+恢复码、jti 登出黑名单、issuer/audience 校验、每次请求回查 DB profile、actor 不可授予超出自身权限、`validateSsrfUrl`（RFC1918/环回/链路本地/云元数据/DNS rebinding）、GraphQL 深度/复杂度/CSRF 防护、生产异常脱敏、机器 token 仅 `metrics.read`。本维度无仍开放的 Finding。

## 7. Stability Concerns

**Coverage: High** — 全库空 catch/timeout/fallback 扫描 + 事务/原子性审读。

**Inspected evidence**: 1003 个 API `.ts` 文件的 catch/`fetch`/`void` 扫描；`queue.processor`、outbox 租约、`rate-limiter`。

**Exclusions / limits**: 未做故障注入/压测。

见 STAB-04。**正确措施**：全库 0 个真正空 catch；几乎所有上游客户端带显式超时（Crawl4AI/LiteLLM/vector/akshare/model-service/GDELT/OpenSky，kaopu 源走 `myFetch`）；ES/向量搜索降级打 warn + metric；生产异常过滤器彻底脱敏；outbox 租约占用正确。

## 8. Performance Concerns

**Coverage: Medium** — DataLoader/分页/索引迁移抽样审读，未压测。

**Inspected evidence**: `graphql/loaders/*`、`items.resolver.ts` 分页、`packages/db/prisma/migrations` 中的索引迁移（`add_hot_path_indexes`、`add_alert_rule_query_indexes` 等）。

**Exclusions / limits**: 未测 bundle 拆分与真实负载。

**正向**：DataLoader 全面用于嵌套字段；items/crawlTasks 有 cursor+total 分页；热路径索引迁移存在。**缺口**：DEP-02（three.js chunk）、BAPI-01（少数列表无分页）。

## 9. Testing Gaps

**Coverage: High** — 审计当日 456 测试文件全量清单 + CI 缺失 + 单元/e2e 抽样。

**Inspected evidence**: 审计当日 263 API spec + 189 web spec + 2 ais-relay + 2 db；`app.e2e-spec.ts`、`graphql.e2e-spec.ts`、`vitest.config.ts`、`jest.config.ts`。2026-08-14 复核：上述文件均已删除（`a452f264`）。

**Exclusions / limits**: 审计当日未跑全量套件。

见 TST-03、TST-05 ~ TST-07。**缺口仍开放**：无 CI（REL-01）、无组件测试（TST-03）、vector 零测试（TST-06）、无覆盖率门禁（TST-05）、生产路径 `NODE_ENV==="test"` 分支（TST-07）。

## 10. Maintainability Concerns

**Coverage: High** — 全库行数统计、type 逃逸计数、大文件清单。

**Inspected evidence**: 1733 TS/TSX 文件、533,390 行；top-20 大文件清单；`any`/断言计数。

**Exclusions / limits**: 未度量圈复杂度。

见 MAINT-01、DEP-01、DEP-03。**核心问题**：8 个 4000-8200 行 god 文件（前端面板 + 后端 service）；99 处 `as unknown as` 双重断言；26 处生产 `as any`。**正向**：全库 0 个 TODO/FIXME/HACK；`Record<string, unknown>`（1755 处）为偏好模式。

## 11. Design / Principles Concerns

**Coverage: High** — 原则映射审读。

见第 30 节 Principles Compliance。

## 12. Type Safety Concerns

**Coverage: High** — 全库类型逃逸计数。

### Summary

| Subtype | Count | Critical | High | Medium | Low |
|---------|-------|----------|------|--------|-----|
| TypeAssertion（`as any`/`as unknown as`） | 228（99 生产） | 0 | 1 | 2 | 0 |
| InputBoundary（GraphQL 上下文 any） | 2 | 0 | 0 | 1 | 0 |
| StringlyTyped | 少量（`bertopic_primary`） | 0 | 0 | 0 | 1 |

见 TYPES-01、TYPES-02、TYPES-03。`@ts-ignore` 0、`@ts-nocheck` 0、`@ts-expect-error` 仅测试中 3 处——这是显著优点。非空断言 `!` 约 1599 处中大部分是 NestJS GraphQL `@Field() prop!:` 惯用写法，非真实风险。

## 13. Documentation Analysis

**Coverage: Medium** — README/AGENTS/docs 与代码对读。

**Inspected evidence**: `README.md`（534 行，含架构/配置/排障）、`AGENTS.md`、`docs/*`。

**Exclusions / limits**: 未逐篇核对全部 docs。

### Documentation Summary

| Subtype | Count | Affected Docs | Recommended Action |
|---------|-------|---------------|-------------------|
| StaleDocs | 1 | `version.json`(0.73.0) vs `package.json`(0.1.0) | 统一版本来源 |
| ConfigDocs | 2 | `.env.example`/`.env.sample` 未记录 `RATE_LIMIT_REDIS_FAIL_OPEN`、`CRAWL4AI_JSCODE_ENABLED` 默认开 | 补齐关键开关文档 |

**正向**：README 的架构图、配置速览、SSRF 排障、健康语义文档质量高且与实现一致（如 `AISSTREAM_API_KEY` 缺失即启动失败、`/healthz/live` vs `/health` 语义）。

## 14. Privacy / Data Governance Analysis

**Coverage: Medium** — PII 字段与日志/样例审读，未做全链数据流追踪。

**Inspected evidence**: `schema.prisma`（User email/avatar、Membership）、`user-news-behavior`（行为画像）、`auth` 日志、`.env.example` 中的 `SMTP_USER=wei500l@163.com`。

**Exclusions / limits**: 未追踪每条日志/遥测中的 PII 流。

### Privacy Summary

| Subtype | Count | Affected Data | Recommended Action |
|---------|-------|---------------|-------------------|
| Minimization | 1 | `user-news-behavior`（view/click/bookmark 画像写入 Redis） | 确认画像最小化与保留期 |
| TelemetryPrivacy | 1 | `.env.example` 泄漏真实个人邮箱 `wei500l@163.com` | 替换为占位符 |

**正向**：组织级数据隔离在 items/knowledge-graph/dashboard/situation-monitor 等查询中一致执行；机器 token 最小权限；无 PII 明文日志的明显证据。

## 15. Accessibility / UX Correctness Analysis

**Coverage: Low** — 组件静态审读，未做 DOM/键盘/对比度实测。

**Inspected evidence**: `apps/web/app/(app)/*`、`components/*`（静态）。

**Exclusions / limits**: 无浏览器实测，无法验证语义/焦点/对比度/响应式行为。

### Accessibility Summary

| Subtype | Count | Affected Workflows | Recommended Action |
|---------|-------|-------------------|-------------------|
| ErrorState | 1 | 多处 `.catch(() => null)` 静默降级（STAB-04） | 前端提供可恢复的错误/空态 |

**结论**：该维度因未做浏览器实测而覆盖有限，**无法给出干净结论**。建议后续用 Playwright 补关键工作流（登录、设置保存、战争地图）的可访问性/错误态回归。前端存在 0 个组件渲染测试（TST-03），进一步限制了本维度证据。

## 16. Supply Chain / Reproducibility Analysis

**Coverage: High** — lockfile/install 脚本/Docker 固定审读。

**Inspected evidence**: `pnpm-lock.yaml`（lockfileVersion 9.0，已提交）、`pnpm-workspace.yaml`、Dockerfile、`docker-up.js` 预检。

**Exclusions / limits**: 未跑 SBOM 工具。

### Supply Chain Summary

| Subtype | Count | Affected Surface | Recommended Action |
|---------|-------|------------------|-------------------|
| ArtifactProvenance | 2 | `minio:latest`/`crawl4ai:0` 滚动 tag、无 SBOM/签名 | digest 固定 + SBOM + cosign |
| Reproducibility | 1 | `runtime.Dockerfile` bake `NEXTAUTH_SECRET` | 仅运行时注入 |
| RegistryHygiene | 1 | `supercluster` 死依赖（DEP-01） | 移除 |

**正向**：`pnpm-lock.yaml` 已提交且 `--frozen-lockfile` 强制；pnpm 9 默认禁用依赖安装脚本（`hasInstallScript` = 0）；LiteLLM 镜像按 SHA-256 digest 固定；`docker-up.js` 有锁文件一致性/迁移 id/Redis AOF 预检；无真实密钥提交历史。

## 17. Cost / Resource Economics Analysis

**Coverage: Medium** — LLM 预算/重试/缓存扫描，无计费数据。

**Inspected evidence**: `assistant.service`、`litellm.service`、`queue.service`、`news-dedupe-settings.service`。

**Exclusions / limits**: 无真实账单数据。

### Cost Summary

| Subtype | Count | Cost Driver | Recommended Action |
|---------|-------|-------------|-------------------|
| ExternalApiCost | 1 | 无 `LITELLM_MASTER_KEY`（REL-07） | fail-closed |

**正向**：助手按组织小时限流 + in-flight + 月度 token 预算；历史预算有界（1000 字符/消息、8000 总量、runs clamp 100）；去重 LLM 比较次数有上限（默认 12）；输入截断（`maxInputChars`）；所有重试均指数退避 + jitter 且上限 10s；确定性 JSON 解析失败走 `QueuePermanentError` 进 DLQ；LiteLLM fallback / ES / 向量降级打 metric。

## 18. Configuration Safety Analysis

**Coverage: High** — env.schema/Zod/process.env 散布/默认值审读。

**Inspected evidence**: `packages/utils/src/env.ts`、`apps/api/src/modules/config/env.schema.ts`、各 app 的 env 校验、`.env.example`、`.env.sample`、`process.env` 散布扫描。

**Exclusions / limits**: 未枚举全部运行时动态配置来源。

### Configuration Summary

| Subtype | Count | Affected Keys / Files | Recommended Action |
|---------|-------|-----------------------|-------------------|
| UnsafeDefault | 2 | `CRAWL4AI_JSCODE_ENABLED` 默认开、`NODE_ENV` 默认 development | 收紧默认 |
| SecretConfig | 2 | `LITELLM_API_KEY` 可选、`VECTOR_INTERNAL_TOKEN=dev-token` | fail-closed |
| EnvironmentSeparation | 1 | 大量布尔 `!== "production"` 分支，`NODE_ENV` 未设即走 dev 分支 | 默认生产安全 |
| SchemaValidation | 1 | ais-relay 无 Zod 校验，`process.env` 直读 + 静默回退 | 集中校验 |

见 REL-07。**正向**：API/vector 用 `@nestjs/config` + Zod `validate`；`env:check` 脚本覆盖 AIS 相关配置；助手按组织额度有 SystemSetting + env 默认。

## 19. Observability / Operability Analysis

**Coverage: Medium** — 日志/指标/健康/降级路径审读。

**Inspected evidence**: `packages/utils/src/logger.ts`、`otel.ts`、`health.controller.ts`、`global-exception.filter.ts`、`observability` 模块。

**Exclusions / limits**: 未核实告警/runbook 的完整落地。

### Signal Summary

| Subtype | Count | Critical Signals Missing | Recommended Action |
|---------|-------|--------------------------|-------------------|
| HealthCheck | 1 | qdrant/minio 无 healthcheck（`docker-compose.yml:94-101,122-134`） | 补齐 |
| Debuggability | 1 | 错误响应无安全 correlation handle（部分路径） | 补 traceId 关联 |

**正向**：健康探针语义清晰（`/healthz/live` vs `/health`）；`details.llmGateway` 含 completion/embedding/rerank 就绪状态；生产异常过滤器返回 traceId；OTEL 可启用；Bull Board 提供队列可视；LiteLLM fallback / ES / 向量降级打 `recordIntegrationEvent`。

## 20. Data Integrity Analysis

**Coverage: High** — 事务/幂等/迁移/乐观锁扫描。

**Inspected evidence**: Prisma schema、60 个迁移、MongoOutbox/AuditLogOutbox/CrawlCleanupOutbox、各 service 的读改写路径。

**Exclusions / limits**: 未做迁移回放演练。

### Integrity Summary

| Subtype | Count | Invariants at Risk | Recommended Action |
|---------|-------|-------------------|-------------------|
| MigrationSafety | 1 | 无回滚脚本 | 补 down 迁移或回滚手册 |

**正向**：MongoOutbox 事务外发 + 租约占用 + 幂等 upsert + 死信补偿；60 个迁移无破坏性操作（仅一次冗余 DROP INDEX）；关键复合唯一约束正确（Article/Membership/CrawlResult/KnowledgeEntity）。

## 21. AI / LLM Safety Analysis

**Coverage: High** — prompt 模板/工具授权/护栏/检索范围审读。

**Inspected evidence**: `news-prompt-config.service.ts`、`news-prompt.builder.ts`、`assistant.service.ts`、`litellm.service.ts`、`analysis.ts`、`qdrant.service.ts`。

**Exclusions / limits**: 未运行红队/注入 eval。

### AI Safety Summary

| Subtype | Count | Boundary Crossed | Recommended Action |
|---------|-------|------------------|-------------------|
| PromptInjection | 0 | 清洗/分类/助手历史已定界（正向） | 保持 |
| ToolAuthorization | 0 | 仅 `web_search_preview`，门控确定性（正向） | 保持 |
| RAGLeakage | 0 | 向量/ES/Mongo 均按 orgId 过滤（正向） | 保持 |
| ModelFallback | 0 | fallback 打 metric + 暴露实际模型（正向） | 保持 |
| AbuseCost | 0 | 助手按组织额度 + 新闻管线输入护栏（正向） | 保持 |

**正向**：新闻管线不可信路径默认附加 `openai-moderation-pre`；助手入队前按组织限流/并发/月度 token；清洗与历史用 `<untrusted_*>` 定界；护栏拦截走结构化状态码/头字段且不重试。`web_search_preview` 门控确定性（非 prompt 措辞）；LLM 选择的 slug/field 均对照 DB 候选集校验；planner 失败 fail-closed 到 `unsupported`；组织级检索过滤；LiteLLM fallback 结构化 metric；畸形 JSON 解析失败不重试。

## 22. Testing Authenticity Analysis

**Coverage: High** — e2e mock/源码断言/私有方法 spy 审读。

**Inspected evidence**: 仓库现无 `*.spec.ts`/`*.test.ts`；假 e2e / 源码断言套件已删，真实行为测试未重建。

**Exclusions / limits**: 无自动化套件可跑。

### Confidence Assessment

| Test Area | Real Confidence | Risk | Action |
|-----------|---------------|------|--------|
| API 单测 | None | 套件已删 | 重建行为测试（当前 `AGENTS.md` 禁止 spec） |
| API e2e | None | 真实依赖 e2e 仍缺 | Rewrite（testcontainers） |
| Web 组件 | None | 行为测试未重建（TST-03） | 补组件渲染测试 |
| model-service.client | None | 零测试 | 补测 |

### Missing Tests
model-service 客户端（circuit breaker/backoff/分类）；组件渲染；真实依赖的集成/认证流程。全仓现无任何自动化测试。

## 23. Fallback / Defensive Code Analysis

**Coverage: High** — 全库空 catch/兜底扫描。

**Inspected evidence**: 1003 API `.ts` 文件的 `catch`/`||`/兜底扫描。

**Exclusions / limits**: 未逐行审计全部兼容分支。

### Fallback Summary

| Subtype | Count | KeepWithAlert | FailFast | Remove |
|---------|-------|---------------|----------|--------|
| SilentFallback | 1 | 1（图表/摘要静默降级，STAB-04） | 0 | 0 |
| EmptyCatch | 0 | 0 | 0 | 0 |

**结论**：全库无空 catch（显著优点）；ES/向量降级已打 warn + metric。仍开放的静默降级见 STAB-04。

## 24. Frontend State Analysis

**Coverage: Medium** — store/组件行数/状态重复审读，未运行客户端。

**Inspected evidence**: `apps/web/store/*`（Zustand）、`apps/web/lib/*-state.ts`、大组件清单。

**Exclusions / limits**: 未运行客户端验证渲染行为。

### Summary

| Subtype | Count | Affected Components |
|---------|-------|-------------------|
| ComponentSize | 8 | 4000-8200 行组件（news-sources/situation-monitor/llm-gateway/war-map 等，MAINT-01） |
| StateDuplication | 2 | war-map 归一化 store↔utils 重复（DEP-03）、situation-monitor lib/store 平行 |

**正向**：Zustand store 类型良好、防御性 sessionStorage 解析、`create<State>()` 类型化 setter。

## 25. Backend API Analysis

**Coverage: High** — 校验/分页/N+1/错误响应审读。

**Inspected evidence**: `main.ts`（全局 ValidationPipe）、DTO（class-validator）、`global-exception.filter.ts`、resolver/loader。

**Exclusions / limits**: GraphQL `class-validator` 是否作用于 `@ArgsType` 未最终确认（需在 `graphql.module.ts` 驱动配置确认）。

### Summary

| Subtype | Count | Affected Endpoints |
|---------|-------|-------------------|
| ApiConsistency | 0 | 响应格式一致（正向） |
| Validation | 0 | 全局 whitelist+forbidNonWhitelisted（正向） |
| NplusOne | 0 | DataLoader 全面覆盖（正向） |
| Caching | 0 | 按 org+user 键（正向） |
| ErrorResponse | 0 | 生产脱敏（正向） |
| Pagination | 1 | alertChannels/alertRules/newsEvents（BAPI-01） |

**正向**：items/crawlTasks cursor+total 分页；生产异常过滤器 fail-closed；GraphQL 深度/复杂度限制；SSRF 校验。**缺口**：少数列表无分页（BAPI-01）。

## 26. Dependency Weight Analysis

**Coverage: Medium** — package.json/import 搜索，未测真实 bundle 体积。

**Inspected evidence**: 各 app 的 package.json、import 搜索、`pnpm-lock.yaml`。

**Exclusions / limits**: 未测真实 bundle 体积。

### Dependency Scoreboard

| Dependency | Status | Weight | Used For | Recommended Action |
|------------|--------|--------|----------|-------------------|
| supercluster（web+api） | Dead | — | 0 import | Remove |
| three（web） | Overweight | ~600KB | 1 文件 3D 图 | Dynamic import |
| axios（web） | Redundant | — | 与 fetch 客户端并存 | Consolidate |
| antd/echarts/deck.gl（web） | Healthy | 重 | 深度使用 | 校验 chunk 拆分 |

见 DEP-01、DEP-02。

## 27. Code Consistency Analysis

**Coverage: Medium** — 命名/引号/import/错误风格抽样。

**Inspected evidence**: Prettier 配置 vs store/lib 引号、`@/` vs 相对 import、错误处理风格计数。

**Exclusions / limits**: 未全量比对。

### Summary

| Subtype | Count | Evidence | Recommended Action |
|---------|-------|----------|-------------------|
| PatternUniformity | 1 | 引号风格 store 用 `"`、lib 混合；Prettier 未全量强制 | 全量 Prettier 一次 |
| ImportOrganization | 1 | 1016 `@/` vs 489 相对 import 并存 | 统一别名 |
| ErrorHandlingConsistency | 1 | 994 throw vs 924 return null vs 611 catch | 明确错误契约 |

**正向**：命名整体遵循 camelCase/PascalCase；枚举为共享协议（符合 AGENTS.md 规范）。

## 28. Comment Coverage Analysis

**Coverage: High** — TODO/FIXME 全库计数 + 关键文件审读。

**Inspected evidence**: 全库 TODO/FIXME/HACK 计数、weibo/hackernews 等文件。

**Exclusions / limits**: 未逐文件审读注释质量。

### Summary

| Subtype | Count | Evidence | Recommended Action |
|---------|-------|----------|-------------------|
| StaleComment | 1 | `hackernews.ts:17` 注释掉的代码行 | 清理 |
| MissingDoc | 0 | 公开 API 文档整体良好 | — |

**正向**：全库 0 个真实 TODO/FIXME/HACK（78 个命中均为 `hackernews`/`toDocument` 子串）；无大段注释代码块。整体注释卫生优秀。

## 29. Release Concerns

**Coverage: High** — Dockerfile/compose/CI/锁文件/版本/SBOM 扫描。

**Inspected evidence**: `infra/docker/*`、`.github`（缺失）、`version.json`、`docker-up.js`。

**Exclusions / limits**: 未构建镜像。

见 REL-01 ~ REL-08。**正向**：`docker-up.js` 预检（锁文件一致性/迁移 id/Redis AOF 修复）；近乎全覆盖 healthcheck + `depends_on: service_healthy`；ais-relay 多阶段构建 `pnpm deploy --prod` 精简镜像。**缺口**：无 CI、root 容器、可变 tag、默认弱凭据、无版本/SBOM/签名。

## 30. Principles Compliance

### Principles Violated

| Principle | Violations | Severity | Affected Areas |
|-----------|------------|----------|----------------|
| Single Responsibility (1.1) | 8+ | High | 4000-8200 行 god 文件/服务 |
| File Size Limit (1.2) | 20+ | High | 前端面板、crawl/items/dashboard service |
| Fail-Fast (4.4) | 1 | High | `LITELLM_API_KEY` 可选 |
| Fail on Missing Config (9.2) | 2 | Critical | `LITELLM_API_KEY`、`LITELLM_MASTER_KEY` |
| Don't Swallow Errors (6.1) | 1 | Medium | 图表/摘要静默 null（STAB-04） |
| Immutability Preference (5.1) | 1 | Medium | `ItemMeta.version` 死字段无乐观锁 |
| YAGNI (4.2) | 1 | Medium | `supercluster` 死依赖 |

### Principles Respected

- **Fail-Fast 的正面实现**：`AISSTREAM_API_KEY` 缺失即启动失败；`validateSsrfUrl` 在抓取边界拒绝私网；生产异常过滤器 fail-closed。
- **Don't Swallow Errors**：全库 0 空 catch（正向）；护栏拦截不重试。
- **Dependency Inversion (2.4)**：MongoOutbox 抽象了跨库一致性；vector-client/model-service 封装外部依赖。
- **Test Behavior (8.1)**：行为测试未重建（TST-03）。
- **Command-Query Separation 正面**：org 写权限在目标组织重推导。
- **Least Privilege (4.6)**：机器 token 仅 `metrics.read`；actor 不可授予超出自身权限。

## 31. Recommended Fix Order

### Fix Immediately（数据丢失/安全破坏/服务中断）

（无仍开放的立即修复项。）

### Fix Before Stable Release（降低可靠性/正确性/安全风险）

1. REL-01 加 CI（lint/typecheck/build）。
2. REL-02 容器非 root + cap_drop。
3. REL-03/04/05/06/07 Docker 固定 digest、去 root、随机凭据、127.0.0.1 绑定、LiteLLM key。
4. TST-03 真实组件/行为测试。

### Schedule Later（增加维护成本或限制规模）

5. MAINT-01 拆分 god 文件。
6. TYPES-01/02/03 收紧类型逃逸。
7. REL-08 semver/changelog/SBOM/签名。
8. DEP-01/02/03 依赖清理与去重。
9. BAPI-01 补齐分页。

### Ignore for Now

- STAB-04、TST-07 等低危项。
- 引号/import 风格不一致（Prettier 未全量强制）。

## 32. Quick Wins（低成本高价值，1–2 小时/项）

1. DEP-01 移除 `supercluster`。
2. TYPES-01 修 `undefined as unknown as ItemMetaModel`。
3. REL-04 删除 Dockerfile bake 的 secret。
4. REL-06 端口绑定 `127.0.0.1`。

## 33. Long-term Refactor Plan

1. **拆分 god 文件**（动机：不可审查/回归面大；方法：先补行为测试锚定，再逐面板/逐服务抽取子组件/子服务；风险：合并冲突；测试策略：每步抽取后跑 lint/typecheck；仓库现无测试套件）。
2. **类型系统收紧**（动机：消除 99 处 `as unknown as` 与 GraphQL 上下文 any；方法：定义 `GraphQLContext`/`AuthenticatedUser`，边界用运行时校验；风险：一次性改动大；测试：类型检查 + 关键 resolver 单测）。
3. **前端测试基础设施**（动机：行为测试未重建；方法：jsdom + @testing-library/react + Playwright 关键工作流；风险：初期投入大，且与当前 `AGENTS.md`「禁止 spec」冲突，需先修订指南；测试：以真实回归用例验证）。
4. **发布管线**（动机：无 CI/版本/SBOM；方法：CI 门禁 + changesets + SBOM + cosign；风险：低；测试：CI 即验证）。

---

*本报告由 fuck-my-shit-mountain skill 生成；所有发现均附具体 `file:line` 证据。审计当日未改被审代码。下文仅保留仍开放项。*
