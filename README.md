# newwei

一个使用 pnpm 和 Turborepo 的工作区，将 Next.js 管理控制台与 NestJS 后端整合在一起。技术栈以模块化单体架构构建，涵盖 RBAC、认证、队列、SQL + Mongo 持久化，以及容器化的本地开发环境。

## 技术栈

- **前端**：Next.js 15（App Router）、React 18、Ant Design 5、Apollo Client、GraphQL Code Generator、ECharts、TanStack Query、Zustand、Auth.js（NextAuth）
- **后端**：NestJS 11、Apollo GraphQL（代码优先）、Prisma（MySQL）、Mongoose（MongoDB）、BullMQ（Redis）、class-validator、OpenAPI/Swagger
- **工具链**：pnpm 9、Turborepo、TypeScript 严格模式、Zod 环境变量校验、Husky + lint-staged + Commitlint

## 快速开始

```bash
# 安装依赖并准备 Husky 钩子
cp .env.example .env
cp infra/docker/.env.sample infra/docker/.env
pnpm install
pnpm prepare

# 校验环境配置
pnpm --filter infra-scripts run env:check

# 应用 Prisma schema 并灌入示例数据
pnpm db:migrate
pnpm db:seed

# 同时启动 Next.js 与 NestJS
pnpm dev
```

访问地址：
- 前端：http://localhost:3000/login
- API 健康检查：http://localhost:4000/api/healthz
- Swagger UI：http://localhost:4000/docs
- GraphQL Playground（开发环境）：http://localhost:4000/graphql

预置管理员账号：`admin@example.com` / `Change_me123!`

### Docker Compose

```bash
cp infra/docker/.env.sample infra/docker/.env
pnpm docker:up   # 启动 MySQL、Mongo、Redis、API、Web
pnpm docker:logs # 追踪整个栈的日志
pnpm docker:down
```

服务定义位于 `infra/docker/docker-compose.yml`，包含健康检查与挂载卷以支持热重载。容器在启动时会执行 `pnpm install`，因此首次启动可能需要一些时间。`crawl4ai` 新闻抓取容器默认暴露在 `8082` 端口，API 会通过 `CRAWL4AI_BASE_URL` 访问它。

## 工作区脚本

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 以监听模式运行 `@modular/api` 和 `@modular/web` |
| `pnpm build` | 对所有包执行 Turbo 构建 |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | 汇总执行 lint、类型检查与测试 |
| `pnpm db:migrate` | 通过 `packages/db` 执行 Prisma 迁移 |
| `pnpm db:seed` | 灌入默认的组织、角色与管理员账号 |
| `pnpm docker:*` | 包装 docker-compose 全生命周期（infra/scripts） |

关键包脚本：
- `apps/api`：`dev`、`build`、`test`、`test:e2e`
- `apps/web`：`dev`、`build`、`start`、`typecheck`
- `infra/scripts`：`env:check`、`docker:up`、`docker:down`、`docker:logs`

## 代码结构

```
apps/
  api/   # NestJS 服务（认证、RBAC、队列、项目、swagger、graphql）
  web/   # Next.js 管理控制台，使用 NextAuth 凭证模式
packages/
  config/  # 共享 tsconfig/eslint/prettier 配置 + RBAC 种子数据
  db/      # Prisma schema、迁移、种子辅助
  mongo/   # Mongoose 模型与连接助手
  utils/   # Zod 环境加载器、日志器、格式化工具
infra/
  docker/  # docker-compose、环境样例、开发 Dockerfile
  scripts/ # 辅助脚本（环境检查、compose 包装器）
```

## crawl4ai 新闻抓取能力

- API 新增 `crawl` 模块（REST `/api/crawl-tasks` 与 GraphQL `crawlTasks`/`crawlTask`/`createCrawlTask`/`retryCrawlTask`），负责任务编排、去重、Markdown 存档（Prisma + Mongo）、超时与重试。任务状态、日志与 Markdown 内容会写入 BullMQ 队列与 `CrawlResultContent` 集合，可在 E2E 中复用。
- 前端在 `/crawl` 下提供管理界面，包括任务列表、状态筛选、创建表单、重试按钮，以及 `/crawl/[taskId]` 的结果详情与 Markdown 预览。所有请求通过 Apollo Client 调用 GraphQL。
- `.env` / `infra/docker/.env` 新增下列配置：
  - `CRAWL4AI_BASE_URL`：指向容器或远程 crawl4ai 服务的 HTTP 地址。
  - `CRAWL4AI_API_KEY`：可选 API Key，若服务启用鉴权可在 Header 传递。
  - `CRAWL4AI_TIMEOUT_MS` / `CRAWL4AI_MAX_CONCURRENCY` / `CRAWL4AI_MAX_RETRIES`：用于 BullMQ 任务的超时、并发与重试上限。
- `pnpm db:migrate && pnpm db:seed` 会创建 `CrawlTask` / `CrawlResult` 表并灌入一个示例任务；Mongo 中新增 `CrawlResultContent` 模型用来存储 Markdown。
- Docker Compose 中新增 `crawl4ai` 服务（基于 `ghcr.io/unclecode/crawl4ai:latest`），默认对 API 暴露 8080 端口并有健康检查；若需要本地调试可以通过 `http://localhost:8082` 命中。
- 参考 crawl4ai 官方文档关于 *Full-Page Scanning*（见 `docs/md_v2/blog/releases/0.4.1.md`）的实现，我们在任务配置中加入 “Full-page scanning” 开关与滚动延迟，API 会在调用 `/crawl` 时自动下发 `scan_full_page` 与 `scroll_delay`，可用于处理瀑布流/无限滚动的新闻站点。
- 如果目标站点启用了 Cloudflare/DataDome 等高强度检测，可勾选 “Undetected browser” 与 “Stealth mode”。这会将 crawl4ai `BrowserConfig` 的 `browser_type` 设为 `undetected` 并启用 `enable_stealth`（官方文档 `docs/md_v2/advanced/undetected-browser.md`），同时把 `magic/simulate_user/override_navigator` 等参数写入 `CrawlerRunConfig`，以更贴近真实用户（光标移动、Navigator 属性伪装等）避免被识别。
- 依据 crawl4ai v0.7.4 发布说明中的 *Enhanced Proxy Support*（`docs/blog/release-v0.7.4.md`），创建任务时可在前端表单或 GraphQL 输入中选择字符串代理（`http://user:pass@proxy:8080`、`socks5://...`）或字典代理（`server/username/password` 分离），API 会自动将其映射为 `BrowserConfig.proxy_config`，方便在不同供应商之间切换。
- 参考 crawl4ai README 关于 *Memory Monitoring* 的 `MemoryMonitor` 实践，我们从 `/crawl` 响应中读取 `serverMemoryMb/peakMemoryMb/memoryEfficiency`，在后台日志与控制台详情页展示该指标，帮助排查 OOM 或批量任务的资源瓶颈。

## 测试

- 针对认证和 RBAC 服务的单元测试（`pnpm --filter @modular/api test`）
- 使用 Supertest 覆盖 `/api/healthz` 与 `/api/auth/login` 的 E2E 冒烟测试

## Swagger 与 RBAC

- Swagger 文档暴露在 `/docs`
- 全局 JWT 与权限守卫；使用 `@Permissions(...)` 保护路由
- 预置角色与权限来自 `packages/config/src/rbac.ts`

## TODO 与扩展点

- [ ] 在简单的撤销机制之外，实现刷新令牌黑名单
- [ ] 添加前端组件测试（Playwright 或 Vitest）
- [ ] 在指标栈接入后，用真实分析替换仪表盘占位叙事卡片
- [ ] 将 BullMQ 任务事件接入 WebSockets，实现 UI 实时更新

欢迎根据自身组织模型调整 docker 工作流（例如改为生产模式的多阶段镜像）或扩展种子数据。
