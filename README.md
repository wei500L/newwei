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
- 为了匹配 crawl4ai *Simple Crawling* 指南中的新闻监控实践（`docs/md_v2/core/simple-crawling.md`），API 默认会下发 `word_count_threshold=80`、`exclude_external_links=true`、`remove_overlay_elements=true` 与 `process_iframes=true`，同时开放 REST/GraphQL 字段让你细调 `wordCountThreshold`、`textMode`、`captureScreenshot`、`cssSelector` 与 `excludedTags`。多 URL 策略也能逐条重写这些参数，以便首页/文章页套用不同的噪声过滤策略。
- 对应 crawl4ai *Virtual Scroll* 能力（`docs/md_v2/advanced/virtual-scroll.md`），任务与策略表单新增 `virtualScroll` 配置（容器选择器、滚动次数、滚动方式、滚动后的等待时间），API 会构造 `VirtualScrollConfig` 并将其附在 `CrawlerRunConfig.virtual_scroll_config`，用于抓取虚拟列表或无限下拉的新闻流。
- 同样来自 crawl4ai `0.4.1` 版本的 *Dynamic Viewport Adjustment*（`docs/md_v2/blog/releases/0.4.1.md`），控制台与 GraphQL/REST DTO 新增 `adjustViewportToContent` 开关，API 会把该布尔值映射到 `CrawlerRunConfig.adjust_viewport_to_content`，确保对响应式/超长页面自动缩放视口并捕获完整内容；多 URL 策略也可单独覆盖该设置。
- 如果目标站点启用了 Cloudflare/DataDome 等高强度检测，可勾选 “Undetected browser” 与 “Stealth mode”。这会将 crawl4ai `BrowserConfig` 的 `browser_type` 设为 `undetected` 并启用 `enable_stealth`（官方文档 `docs/md_v2/advanced/undetected-browser.md`），同时把 `magic/simulate_user/override_navigator` 等参数写入 `CrawlerRunConfig`，以更贴近真实用户（光标移动、Navigator 属性伪装等）避免被识别。
- 参考 crawl4ai 官方 *Managed Browser: Use user-owned browsers with full control, avoiding bot detection*（`docs/md_v2/advanced/identity-based-crawling.md`），我们在 API/控制台新增 “Managed browser” 与 “User data directory” 配置，能够将 `BrowserConfig.use_managed_browser`/`user_data_dir` 传给 Crawl4AI，直接复用你本机登陆后的浏览器 profile（或 BrowserProfiler 导出的路径），让任务以真实身份与指纹执行、降低反爬风险。
- 参考 crawl4ai 官方 *Full Browser Control: Modify headers, cookies, user agents, and more for tailored crawling setups*（`docs/md_v2/core/browser-crawler-config.md`、`docs/md_v2/assets/llm.txt/txt/config_objects.txt`），控制台新增 “Browser identity” 区块，可配置自定义 Header/Cookie、用户代理（静态或随机生成策略）以及 Locale/Timezone/Geolocation。API 会自动将这些参数映射到 `BrowserConfig` / `CrawlerRunConfig`，便于在需要特定指纹或持久身份的站点执行抓取。
- 依据 crawl4ai v0.7.4 发布说明中的 *Enhanced Proxy Support*（`docs/blog/release-v0.7.4.md`），创建任务时可在前端表单或 GraphQL 输入中选择字符串代理（`http://user:pass@proxy:8080`、`socks5://...`）或字典代理（`server/username/password` 分离），API 会自动将其映射为 `BrowserConfig.proxy_config`，方便在不同供应商之间切换。
- 参考 crawl4ai 官方 *Multi-URL Configuration* 文档（`docs/md_v2/advanced/multi-url-crawling.md` / `docs/blog/release-v0.7.3.md`），创建任务时可以在 “Multi-URL strategies” 中声明不同的 URL 列表或匹配模式（glob/regex 等）及其专属 `CrawlerRunConfig` 覆盖，例如为 PDF、API、博客页面配置不同的缓存策略、滚动和提取选项；API 会自动将这些规则映射为 `crawler_configurations` 发送到 Crawl4AI，并在同一批次内抓取多条 URL。
- 参考 crawl4ai 官方 *Markdown Generation* 指南（`docs/md_v2/core/markdown-generation.md`）与 *Fit Markdown: Heuristic-based filtering to remove noise and irrelevant parts*（`docs/md_v2/core/fit-markdown.md`），创建任务时可配置 `DefaultMarkdownGenerator` 的 `content_source` 与 `options`（忽略链接、逃逸 HTML、Wrap 宽度等）以及 `PruningContentFilter` 的 `threshold/threshold_type/min_word_threshold`；API 会在 `CrawlerRunConfig` 中下发 `markdown_generator`，并在结果详情页展示原始 / 引用 / Fit Markdown，方便在不同渠道复用内容。
- 参考 crawl4ai 官方 *Enhanced Table Extraction: Direct DataFrame conversion from web tables*（`docs/blog/release-v0.7.3.md`），API 新增 `table_score_threshold` 与 `table_extraction` 映射，控制台提供“Enhanced table extraction”表单用于设置 `DefaultTableExtraction` 的最小行列或切换到 LLM 策略；抓取结果会把 `result.tables` 中的 caption/source/metadata/rows 序列化为 DataFrame-ready JSON，GraphQL/详情页可直接预览并导出表格，便于后续在 Pandas/Viz 中复用。
- 参考 crawl4ai 官方 *Clean Markdown: Generates clean, structured Markdown with accurate formatting* 实践（`docs/examples/quickstart.ipynb`、`docs/md_v2/core/content-selection.md`），控制台新增 “Clean Markdown” 配置面板，可传递 `css_selector/target_elements/excluded_tags/remove_overlay_elements/word_count_threshold` 到 Crawl4AI 以去除导航/页脚 & 弹层，仅保留满足字数阈值的正文；API 会把 `cleanMarkdown` 写进 `CrawlerRunConfig`，任务详情页还会突出显示 Clean (fit) Markdown 变体。
- 参考 crawl4ai 官方 *Link Analysis: Extract and analyze all links for detailed data exploration*（`docs/md_v2/core/link-media.md`、`docs/blog/release-v0.7.0.md`），API 现在会根据任务中的 LinkPreviewConfig 为 Crawl4AI 注入 `link_preview_config` + `score_links`，抓取完成后将链接得分、分类统计写入 Mongo。控制台的创建侧栏提供 LinkPreviewConfig 的完整参数（include/exclude patterns、最大链接数、BM25 query、score threshold 等），任务详情页也会聚合展示顶级链接/待关注链接、桶计数和平均内在得分，辅助数据探索。
- 参考 crawl4ai README 关于 *Memory Monitoring* 的 `MemoryMonitor` 实践，我们从 `/crawl` 响应中读取 `serverMemoryMb/peakMemoryMb/memoryEfficiency`，在后台日志与控制台详情页展示该指标，帮助排查 OOM 或批量任务的资源瓶颈。
- 参考 crawl4ai 官方 “Error Handling: Robust error management for seamless execution” 实践（`docs/md_v2/assets/llm.txt/txt/http_based_crawler_strategy.txt` 与 `docs/md_v2/assets/llm.txt/txt/multi_urls_crawling.txt`），API 现会解析 `success/status_code/error_message` 字段，将失败 URL 收集到队列日志，并标记 429/503/timeout 等可重试错误，方便在控制台快速排查与重试部分失败的抓取任务。
- 参考 crawl4ai 官方 *Dynamic Crawling: Execute JS and wait for async or sync for dynamic content extraction* 指南（`docs/md_v2/advanced/session-management.md` 与 `docs/md_v2/assets/llm.txt/txt/config_objects.txt`），API 与控制台现支持为基础任务或 Multi-URL 策略注入 `js_code/js_only/wait_for/wait_for_timeout`。可在抓取前执行自定义 JavaScript（滚动、点击“加载更多”）并等待 CSS 选择器或 JS 条件达成后再返回 Markdown，解决瀑布流、懒加载页面内容缺失的问题。
- 参考 crawl4ai 官方 *Session Management: Preserve browser states and reuse them for multi-step crawling*（`docs/md_v2/advanced/session-management.md`）以及 *Storage State tutorial*（`docs/examples/storage_state_tutorial.md`）的实践，任务表单新增 “Session management” 区块。可以在 API 请求中注入 `session_id`（复用同一 Playwright 浏览器标签）与 `storage_state`（粘贴 cookies/localStorage JSON 或服务器上的 state 文件路径），方便处理需要先登录/多步跳转的站点，并支持在任务详情页回显已保存的会话参数。
- 参考 crawl4ai 官方 *Media Support: Extract images, audio, videos, and responsive image formats like srcset and picture*（`docs/md_v2/core/link-media.md`、`docs/md_v2/core/crawler-result.md`），API 现在可在任务创建时开启 “Store media assets” 选项来持久化 `result.media`，并在控制台结果详情中渲染图像/音视频缩略图、srcset 与 picture source 等响应式信息，辅助核对素材抓取质量。
- 参考 crawl4ai 官方 *Metadata Extraction: Retrieve structured metadata from web pages* 能力（`docs/md_v2/core/url-seeding.md`、`docs/md_v2/assets/llm.txt/txt/url_seeder.txt`），新增 “Metadata extraction” 预览卡片。后端提供 `POST /api/crawl-tasks/metadata` 与 GraphQL `crawlMetadata` 查询，使用 sitemap seeding + `<head>` 解析提取 title/description/keywords/Open Graph/JSON-LD，并支持 query + score threshold 过滤。前端可在不排队 crawl 任务的前提下先评估站点的元数据质量，辅助调参。

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
