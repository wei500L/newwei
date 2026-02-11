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

# 应用 Prisma schema 并初始化基础数据（不会灌入演示/模拟内容）
pnpm db:migrate
pnpm db:seed

# 同时启动 Next.js 与 NestJS
pnpm dev
```

访问地址：

- 前端：http://localhost:3000/login
- API 健康检查：http://localhost:4000/api/healthz
- Bull Board 队列仪表盘：http://localhost:4000/admin/queues
- Swagger UI：http://localhost:4000/docs
- GraphQL Playground（开发环境）：http://localhost:4000/graphql
- MinIO S3 Endpoint：http://localhost:9000
- MinIO Console：http://localhost:9001

首次运行前请在 `.env` 配置种子数据（用于创建你的组织与初始管理员）：

- `SEED_ORG_SLUG` / `SEED_ORG_NAME`（可选：`SEED_ORG_DESCRIPTION`）
- `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` / `SEED_ADMIN_FIRST_NAME` / `SEED_ADMIN_LAST_NAME`

如需保护 Bull Board，可在 `.env` 配置 `BULL_BOARD_USERNAME` / `BULL_BOARD_PASSWORD` 启用 Basic Auth。

### 邮件发送

`.env` 与 `infra/docker/.env` 增加了 SMTP 配置，可用于 163 邮箱等服务：

```bash
SMTP_HOST=smtp.163.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=wei500l@163.com
SMTP_PASS=your_smtp_app_password
SMTP_FROM="Wei <wei500l@163.com>"
```

### Docker Compose

```bash
cp infra/docker/.env.sample infra/docker/.env
pnpm docker:up   # 启动 MySQL、Mongo、Redis、Qdrant、Vector、Crawl4AI、API、Web（会先检查镜像，缺失才拉取/构建）
pnpm docker:u    # docker:up 的别名
pnpm docker:up:extras # 兼容保留（目前等同于 docker:up）
pnpm docker:up:build  # 需要重建镜像时使用（会触发拉取基础镜像）
pnpm docker:logs # 追踪整个栈的日志
pnpm docker:down
```

服务定义位于 `infra/docker/docker-compose.yml`，包含健康检查与挂载卷以支持热重载。容器在启动时会执行 `pnpm install`，因此首次启动可能需要一些时间。

其中：
- `minio` 提供本地 S3 兼容存储（头像上传使用）。默认会通过 `minio-init` 自动创建 `S3_BUCKET` 并写入 CORS 配置（允许浏览器 PUT/GET/HEAD），并将桶设置为匿名可读（便于头像用 `S3_PUBLIC_BASE_URL` 直接访问）。
- `akshare` 提供经济数据抓取的 Python 网关（默认暴露在 `8081` 端口），API 通过 `AKSHARE_HTTP_BASE_URL` 访问它。
- `model-service` 提供时序预测/异常检测的 Python 模型服务（默认暴露在 `8090` 端口），API 通过 `MODEL_SERVICE_BASE_URL` 访问；开启需设置 `MODEL_SERVICE_ENABLED=true` 并配置 `MODEL_SERVICE_INTERNAL_TOKEN`（与 Docker Compose 中的服务一致）。
- `crawl4ai` 新闻抓取容器默认暴露在 `8082` 端口，API 会通过 `CRAWL4AI_BASE_URL` 访问它（建议随 `extras` 一起启动）。
- `qdrant` + `vector` 组成语义向量检索栈。当 `VECTOR_SERVICE_ENABLED=true`（或在系统设置里启用向量服务）时，API 会优先走向量服务做语义去重/搜索；需要将历史向量回填到 Qdrant 可运行 `pnpm --filter @modular/api run vector:backfill`。
- `crawl4ai` 自带实时监控仪表盘（系统指标、请求与浏览器池）：`http://localhost:8082/dashboard/`。控制台 `Operations → Crawl4AI Monitor` 提供自研监控面板（WebSocket 实时流 + REST 指标）并保留内置仪表盘标签页（需要配置 `CRAWL4AI_DASHBOARD_URL` / `CRAWL4AI_BASE_URL`，见下文）。
- 如果你打开 `http://localhost:8082/dashboard/` 看到 `{\"detail\":\"Not Found\"}`，通常是 crawl4ai 镜像版本太旧/用错 tag（Docker Hub 的 `unclecode/crawl4ai:latest` 比较常见），缺少内置面板与监控接口；请将 `infra/docker/.env` 的 `CRAWL4AI_IMAGE` 改为 `unclecode/crawl4ai:0`（推荐，跟随最新 release 且不锁死具体 minor/patch），并执行 `pnpm docker:up -d --force-recreate crawl4ai` 重新创建容器。
- 不同版本的内置面板路径可能不同（例如 `/dashboard/` 或 `/playground/`）；如遇到 404，可将 `CRAWL4AI_DASHBOARD_URL` 先设为 `http://localhost:8082/` 再尝试。
- 经济数据抓取模块使用 `AKSHARE_HTTP_BASE_URL` 指向一个 Python 网关（默认暴露在 `8081` 端口，底层通过 `pip install akshare` 调用 Akshare 并以 HTTP 提供数据）。如果你不需要该能力，可设置 `AKSHARE_ENABLED=false`（禁用所有 Akshare jobs）。

如果你调用某个 Akshare HTTP 端点出现 `400 ... got an unexpected keyword argument ...`，通常表示你传的 query 参数不符合当前安装的 Akshare 版本函数签名。建议先在 akshare 容器里确认签名：

```bash
docker compose --env-file infra/docker/.env -f infra/docker/docker-compose.yml --profile extras exec akshare \
  python -c "import inspect, akshare as ak; print(inspect.signature(ak.futures_zh_spot))"
```

#### Akshare 网关与版本更新

本项目通过一个 Python 网关容器对外提供 Akshare 数据（默认 `http://akshare:8081`），而不是直接在 Node/Nest 里安装 Akshare。Akshare 更新频繁时，推荐用“管理后台一键升级”保持最新版本。

##### 管理后台一键升级（始终最新）

- 入口：Web → `System Settings` → `Akshare` → `Upgrade to latest`
- 前提：在 `infra/docker/.env` 配置 `AKSHARE_ADMIN_TOKEN`（示例见 `infra/docker/.env.sample`）
- 行为：会在网关容器内执行 `pip install -U akshare`，并自动重启网关进程一次；页面展示升级状态/失败信息、“真实运行版本”（来自网关 `/version`）以及升级历史（来自审计日志 `akshare_gateway.*`）

`AKSHARE_ADMIN_TOKEN` 等同于一个“远程执行 pip 升级”的管理口令，请使用足够随机的值并避免泄露/提交到仓库。

##### 构建时版本（可选）

你也可以在构建镜像时指定 Akshare 版本（影响“首次 build/重建容器”的版本基线）：

- 固定版本：`AKSHARE_VERSION=1.17.94`
- 总是最新：`AKSHARE_VERSION=latest`（建议配合 `docker compose build --no-cache akshare` 避免缓存）

##### 仅重建/重启 akshare 服务

```bash
docker compose --env-file infra/docker/.env -f infra/docker/docker-compose.yml build akshare
docker compose --env-file infra/docker/.env -f infra/docker/docker-compose.yml --profile extras up -d akshare
```

##### 可选：官方 aktools 镜像做交互验证

Akshare 官方提供 `aktools:jupyter` 镜像，适合本地临时进入 Python 环境验证数据源与函数行为（不替代本项目的网关服务协议）：

```bash
docker pull registry.cn-shanghai.aliyuncs.com/akfamily/aktools:jupyter
docker run -it --rm registry.cn-shanghai.aliyuncs.com/akfamily/aktools:jupyter python
```

注意：`JWT_SECRET` / `NEXTAUTH_SECRET` 需要至少 16 位（见 `packages/utils/src/env.ts` 的校验），否则 `api` 容器会启动失败并被判定为 unhealthy。

如果你暂时不需要经济数据/新闻抓取能力，可先只跑核心栈：`pnpm docker:up`（不启用 `extras`），避免因为拉取 Python/GHCR 镜像失败而卡住开发环境。

如果你访问 Docker Hub 不稳定，导致 `akshare` 网关构建时拉取 `python:3.11-slim` 失败，可以在 `infra/docker/.env` 里指定一个 **Python 3.11+** 的基础镜像（`akshare>=1.16.72` 依赖 `aiohttp>=3.11.13`，因此 **Python 3.8/3.7 的镜像会构建失败**）。建议先验证镜像内 Python 版本：

- `docker run --rm <IMAGE> python -V`

然后把 `infra/docker/.env` 里的 `AKSHARE_PYTHON_IMAGE` 改成你可用的镜像（示例之一）：

- `AKSHARE_PYTHON_IMAGE=python:3.11-slim`

如果你本机已经有一个可用的 Python 镜像但只有 image id（没有 tag），先打一个本地 tag 再引用更稳：

- `docker tag <IMAGE_ID> akshare-python-base:local`
- `AKSHARE_PYTHON_IMAGE=akshare-python-base:local`

如果启动时 `crawl4ai` 拉取出现 `error from registry: denied`（例如无法访问 GHCR），可以二选一：

- 直接改用 Docker Hub 浮动 tag：`CRAWL4AI_IMAGE=unclecode/crawl4ai:0`
- 或把你已拉到本地的镜像重新打 tag：`docker tag unclecode/crawl4ai:<TAG> ghcr.io/unclecode/crawl4ai:<TAG>`

如果启动时构建 `api/web` 失败并提示无法从 Docker Hub 获取 `node:20`（例如 `failed to fetch anonymous token` / 网络被重置），可以在 `infra/docker/.env` 里改用镜像源（示例之一）：

- `NODE_IMAGE=dockerproxy.com/library/node:20`

如果构建时出现 `invalid file request .../node_modules/...`，通常是 Docker Desktop 在发送构建上下文时无法处理 Windows 上的 `node_modules` 链接；确保仓库根目录的 `.dockerignore` 生效（会排除 `**/node_modules`）后重新构建即可。

## 工作区脚本

| 命令                                         | 说明                                            |
| -------------------------------------------- | ----------------------------------------------- |
| `pnpm dev`                                   | 以监听模式运行 `@modular/api` 和 `@modular/web` |
| `pnpm build`                                 | 对所有包执行 Turbo 构建                         |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | 汇总执行 lint、类型检查与测试                   |
| `pnpm db:migrate`                            | 通过 `packages/db` 执行 Prisma 迁移             |
| `pnpm db:seed`                               | 根据 `.env` 的 `SEED_*` 创建组织、角色与管理员账号，并初始化“新闻-指标”默认设置 |
| `pnpm docker:*`                              | 包装 docker-compose 全生命周期（infra/scripts） |

关键包脚本：

- `apps/api`：`dev`、`build`、`test`、`test:e2e`
- `apps/web`：`dev`、`build`、`start`、`typecheck`
- `infra/scripts`：`env:check`、`docker:up`、`docker:down`、`docker:logs`

## 安全与限流

- 登录接口默认启用 `RATE_LIMIT_LOGIN` / `RATE_LIMIT_LOGIN_WINDOW`，防止暴力破解。
- `RATE_LIMIT_CRAWL_TASK_CREATE` / `RATE_LIMIT_CRAWL_TASK_CREATE_WINDOW` 控制每位成员在窗口期内可新建的 Crawl 任务数（默认 10 次 / 5 分钟），避免批量滥用抓取和下游 LLM 资源。
- `RATE_LIMIT_RBAC_WRITE` / `RATE_LIMIT_RBAC_WRITE_WINDOW` 针对角色创建与成员授权提供独立限流（默认 20 次 / 10 分钟），杜绝误操作或恶意批量改权限。
- 以上环境变量仅提供兜底默认值，推荐在管理后台 Settings → Rate Limits 面板中动态配置。保存后立即写入数据库，并实时影响登录、爬虫任务和 RBAC 写操作的限流窗口。
- 如需临时关闭限流，可在 UI 中设置一个足够大的限额，或在环境配置中指定新的默认值。

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
- Crawl 结果页支持一键 “Send to Items”：将某条 `CrawlResult` 作为 `Item` 输入，交给新闻管道执行 LLM 清洗/结构化与去重，随后在 `Items / Today / Topics` 等阅读页中展示。
- `.env` / `infra/docker/.env` 新增下列配置：
  - `CRAWL4AI_BASE_URL`：指向容器或远程 crawl4ai 服务的 HTTP 地址。
  - `CRAWL4AI_HTTP_PROXY` / `CRAWL4AI_HTTPS_PROXY` / `CRAWL4AI_NO_PROXY`：可选，给 crawl4ai 容器注入代理环境变量；若代理跑在宿主机本地 7890，请用 `http://host.docker.internal:7890`（不要用容器内的 `127.0.0.1`）。
  - `CRAWL4AI_DASHBOARD_URL`：可选，控制台嵌入 Crawl4AI `/dashboard/` 时使用（Docker 默认建议设为 `http://localhost:8082/dashboard/`；不填则从 `CRAWL4AI_BASE_URL` 推导）。
  - `CRAWL4AI_API_KEY`：可选 API Key，若服务启用鉴权可在 Header 传递。
  - `CRAWL4AI_TIMEOUT_MS` / `CRAWL4AI_MAX_CONCURRENCY` / `CRAWL4AI_MAX_RETRIES`：用于 BullMQ 任务的超时、并发与重试上限。
  - `CRAWL_MEDIA_FETCH_TIMEOUT_MS` / `CRAWL_MEDIA_MAX_BYTES` / `CRAWL_MEDIA_MAX_PER_RESULT`：控制在 `storeMedia` 打开时后端下载新闻图片/视频的网络超时、单文件最大字节与每条结果最多缓存的媒体数量。
- `pnpm db:migrate` 会创建 `CrawlTask` / `CrawlResult` 等表结构；`pnpm db:seed` 会根据 `.env` 的 `SEED_*` 创建组织、角色与管理员账号，并写入“新闻-指标（News ↔ Indicators）”功能的默认 Settings（后续可在后台补齐真实指标数据与配置）。
- Docker Compose 中新增 `crawl4ai` 服务（默认 `unclecode/crawl4ai:0`，可用 `CRAWL4AI_IMAGE` 覆盖），并有健康检查；若需要本地调试可以通过 `http://localhost:8082` 命中。
- 参考 crawl4ai 官方文档关于 _Full-Page Scanning_（见 `docs/md_v2/blog/releases/0.4.1.md`）的实现，我们在任务配置中加入 “Full-page scanning” 开关与滚动延迟，API 会在调用 `/crawl` 时自动下发 `scan_full_page` 与 `scroll_delay`，可用于处理瀑布流/无限滚动的新闻站点。
- 参考 crawl4ai 官方 _Link & Media Extraction_ 指南（`docs/md_v2/core/link-media.md`），当 `storeMedia` 打开时 API 会自动启用 `wait_for_images`、允许跨域图片并解析 `result.media`；后端会在 `CRAWL_MEDIA_*` 限制内抓取最多 6 个图片/视频并以内联 Base64 存进 `CrawlResultContent.mediaAssets`，前端详情页可直接预览或下载这些媒体。
- 为了匹配 crawl4ai _Simple Crawling_ 指南中的新闻监控实践（`docs/md_v2/core/simple-crawling.md`），API 默认会下发 `word_count_threshold=80`、`exclude_external_links=true`、`remove_overlay_elements=true` 与 `process_iframes=true`，同时开放 REST/GraphQL 字段让你细调 `wordCountThreshold`、`textMode`、`captureScreenshot`、`cssSelector` 与 `excludedTags`。多 URL 策略也能逐条重写这些参数，以便首页/文章页套用不同的噪声过滤策略。
- 对应 crawl4ai _Virtual Scroll_ 能力（`docs/md_v2/advanced/virtual-scroll.md`），任务与策略表单新增 `virtualScroll` 配置（容器选择器、滚动次数、滚动方式、滚动后的等待时间），API 会构造 `VirtualScrollConfig` 并将其附在 `CrawlerRunConfig.virtual_scroll_config`，用于抓取虚拟列表或无限下拉的新闻流。
- 同样来自 crawl4ai `0.4.1` 版本的 _Dynamic Viewport Adjustment_（`docs/md_v2/blog/releases/0.4.1.md`），控制台与 GraphQL/REST DTO 新增 `adjustViewportToContent` 开关，API 会把该布尔值映射到 `CrawlerRunConfig.adjust_viewport_to_content`，确保对响应式/超长页面自动缩放视口并捕获完整内容；多 URL 策略也可单独覆盖该设置。
- 如果目标站点启用了 Cloudflare/DataDome 等高强度检测，可勾选 “Undetected browser” 与 “Stealth mode”。这会将 crawl4ai `BrowserConfig` 的 `browser_type` 设为 `undetected` 并启用 `enable_stealth`（官方文档 `docs/md_v2/advanced/undetected-browser.md`），同时把 `magic/simulate_user/override_navigator` 等参数写入 `CrawlerRunConfig`，以更贴近真实用户（光标移动、Navigator 属性伪装等）避免被识别。
- 针对会偶发返回验证页（Cloudflare/DataDome/`Please enable JS`）的站点，API 现在会自动触发“稳态反爬重试链路”：先基于目标域名复用/生成 `session_id`，再用同域 warmup URL（如首页/栏目页）预热会话，随后执行最多 3 轮递进重试（逐步放宽 `wait_for`、增大超时与渲染延迟、指数退避），并在多轮结果中按 challenge 命中数 + markdown 质量评分选取最佳结果。该策略对 Reuters 这类站点有效，也可复用于其他高强度反爬新闻源。
- 控制台已内置可复用预设：在 `Crawl Tasks -> Create` 可直接选择 “Reuters + Cloudflare” 模板；在 `Operations -> News Sources` 的抓取配置中可一键应用 “Cloudflare preset” 或 “Reuters + CF preset”。它们会自动写入 `headless=false`、`enableUndetectedBrowser=true`、`enableStealthMode=true`、`antiBotMode=enabled` 及新闻正文提取参数，便于快速复用到同类站点。
- 参考 crawl4ai 官方 _Managed Browser: Use user-owned browsers with full control, avoiding bot detection_（`docs/md_v2/advanced/identity-based-crawling.md`），我们在 API/控制台新增 “Managed browser” 与 “User data directory” 配置，能够将 `BrowserConfig.use_managed_browser`/`user_data_dir` 传给 Crawl4AI，直接复用你本机登陆后的浏览器 profile（或 BrowserProfiler 导出的路径），让任务以真实身份与指纹执行、降低反爬风险。
- 参考 crawl4ai 官方 _Full Browser Control: Modify headers, cookies, user agents, and more for tailored crawling setups_（`docs/md_v2/core/browser-crawler-config.md`、`docs/md_v2/assets/llm.txt/txt/config_objects.txt`），控制台新增 “Browser identity” 区块，可配置自定义 Header/Cookie、用户代理（静态或随机生成策略）以及 Locale/Timezone/Geolocation。API 会自动将这些参数映射到 `BrowserConfig` / `CrawlerRunConfig`，便于在需要特定指纹或持久身份的站点执行抓取。
- 依据 crawl4ai v0.7.4 发布说明中的 _Enhanced Proxy Support_（`docs/blog/release-v0.7.4.md`），创建任务时可在前端表单或 GraphQL 输入中选择字符串代理（`http://user:pass@proxy:8080`、`socks5://...`）或字典代理（`server/username/password` 分离），API 会自动将其映射为 `BrowserConfig.proxy_config`，方便在不同供应商之间切换。
- 参考 crawl4ai 官方 _Multi-URL Configuration_ 文档（`docs/md_v2/advanced/multi-url-crawling.md` / `docs/blog/release-v0.7.3.md`），创建任务时可以在 “Multi-URL strategies” 中声明不同的 URL 列表或匹配模式（glob/regex 等）及其专属 `CrawlerRunConfig` 覆盖，例如为 PDF、API、博客页面配置不同的缓存策略、滚动和提取选项；API 会自动将这些规则映射为 `crawler_configurations` 发送到 Crawl4AI，并在同一批次内抓取多条 URL。
- 参考 crawl4ai 官方 _Markdown Generation_ 指南（`docs/md_v2/core/markdown-generation.md`）与 _Fit Markdown: Heuristic-based filtering to remove noise and irrelevant parts_（`docs/md_v2/core/fit-markdown.md`），创建任务时可配置 `DefaultMarkdownGenerator` 的 `content_source` 与 `options`（忽略链接、逃逸 HTML、Wrap 宽度等）以及 `PruningContentFilter` 的 `threshold/threshold_type/min_word_threshold`；API 会在 `CrawlerRunConfig` 中下发 `markdown_generator`，并在结果详情页展示原始 / 引用 / Fit Markdown，方便在不同渠道复用内容。
- 参考 crawl4ai 官方 _Enhanced Table Extraction: Direct DataFrame conversion from web tables_（`docs/blog/release-v0.7.3.md`），API 新增 `table_score_threshold` 与 `table_extraction` 映射，控制台提供“Enhanced table extraction”表单用于设置 `DefaultTableExtraction` 的最小行列或切换到 LLM 策略；抓取结果会把 `result.tables` 中的 caption/source/metadata/rows 序列化为 DataFrame-ready JSON，GraphQL/详情页可直接预览并导出表格，便于后续在 Pandas/Viz 中复用。
- 参考 crawl4ai 官方 _Clean Markdown: Generates clean, structured Markdown with accurate formatting_ 实践（`docs/examples/quickstart.ipynb`、`docs/md_v2/core/content-selection.md`），控制台新增 “Clean Markdown” 配置面板，可传递 `css_selector/target_elements/excluded_tags/remove_overlay_elements/word_count_threshold` 到 Crawl4AI 以去除导航/页脚 & 弹层，仅保留满足字数阈值的正文；API 会把 `cleanMarkdown` 写进 `CrawlerRunConfig`，任务详情页还会突出显示 Clean (fit) Markdown 变体。
- 参考 crawl4ai 官方 _Link Analysis: Extract and analyze all links for detailed data exploration_（`docs/md_v2/core/link-media.md`、`docs/blog/release-v0.7.0.md`），API 现在会根据任务中的 LinkPreviewConfig 为 Crawl4AI 注入 `link_preview_config` + `score_links`，抓取完成后将链接得分、分类统计写入 Mongo。控制台的创建侧栏提供 LinkPreviewConfig 的完整参数（include/exclude patterns、最大链接数、BM25 query、score threshold 等），任务详情页也会聚合展示顶级链接/待关注链接、桶计数和平均内在得分，辅助数据探索。
- 参考 crawl4ai README 关于 _Memory Monitoring_ 的 `MemoryMonitor` 实践，我们从 `/crawl` 响应中读取 `serverMemoryMb/peakMemoryMb/memoryEfficiency`，在后台日志与控制台详情页展示该指标，帮助排查 OOM 或批量任务的资源瓶颈。
- 参考 crawl4ai 官方 “Error Handling: Robust error management for seamless execution” 实践（`docs/md_v2/assets/llm.txt/txt/http_based_crawler_strategy.txt` 与 `docs/md_v2/assets/llm.txt/txt/multi_urls_crawling.txt`），API 现会解析 `success/status_code/error_message` 字段，将失败 URL 收集到队列日志，并标记 429/503/timeout 等可重试错误，方便在控制台快速排查与重试部分失败的抓取任务。
- 参考 crawl4ai 官方 _Dynamic Crawling: Execute JS and wait for async or sync for dynamic content extraction_ 指南（`docs/md_v2/advanced/session-management.md` 与 `docs/md_v2/assets/llm.txt/txt/config_objects.txt`），API 与控制台现支持为基础任务或 Multi-URL 策略注入 `js_code/js_only/wait_for/wait_for_timeout`。可在抓取前执行自定义 JavaScript（滚动、点击“加载更多”）并等待 CSS 选择器或 JS 条件达成后再返回 Markdown，解决瀑布流、懒加载页面内容缺失的问题。
- 参考 crawl4ai 官方 _Session Management: Preserve browser states and reuse them for multi-step crawling_（`docs/md_v2/advanced/session-management.md`）以及 _Storage State tutorial_（`docs/examples/storage_state_tutorial.md`）的实践，任务表单新增 “Session management” 区块。可以在 API 请求中注入 `session_id`（复用同一 Playwright 浏览器标签）与 `storage_state`（粘贴 cookies/localStorage JSON 或服务器上的 state 文件路径），方便处理需要先登录/多步跳转的站点，并支持在任务详情页回显已保存的会话参数。
- 参考 crawl4ai 官方 _Media Support: Extract images, audio, videos, and responsive image formats like srcset and picture_（`docs/md_v2/core/link-media.md`、`docs/md_v2/core/crawler-result.md`），API 现在可在任务创建时开启 “Store media assets” 选项来持久化 `result.media`，并在控制台结果详情中渲染图像/音视频缩略图、srcset 与 picture source 等响应式信息，辅助核对素材抓取质量。
- 参考 crawl4ai 官方 _Metadata Extraction: Retrieve structured metadata from web pages_ 能力（`docs/md_v2/core/url-seeding.md`、`docs/md_v2/assets/llm.txt/txt/url_seeder.txt`），新增 “Metadata extraction” 预览卡片。后端提供 `POST /api/crawl-tasks/metadata` 与 GraphQL `crawlMetadata` 查询，使用 sitemap seeding + `<head>` 解析提取 title/description/keywords/Open Graph/JSON-LD，并支持 query + score threshold 过滤。前端可在不排队 crawl 任务的前提下先评估站点的元数据质量，辅助调参。

## 测试

- 针对认证和 RBAC 服务的单元测试（`pnpm --filter @modular/api test`）
- 使用 Supertest 覆盖 `/api/healthz` 与 `/api/auth/login` 的 E2E 冒烟测试

## Swagger 与 RBAC

- Swagger 文档暴露在 `/docs`
- 全局 JWT 与权限守卫；使用 `@Permissions(...)` 保护路由
- 预置角色与权限来自 `packages/config/src/rbac.ts`

## LiteLLM 新闻清洗流水线

- BullMQ `itemPipeline` 队列现已对接 `NewsPipelineService`：任意 `items` API/GraphQL 创建的原始 payload 只要包含 `url`，就会依次完成 Crawl4AI 去重抓取、LiteLLM 清洗、Zod 校验与 `ProcessedItemModel` 存储。抓取/LLM/持久化三个阶段的日志会写入 `TaskLogModel`，可在仪表盘查看。
- LiteLLM 与 Crawl4AI 的高级参数集中在 `config/news-pipeline.config.yaml`。文件按照 `litellm_config` 与 `crawl4ai_config` 分区，支持模型 fallback、RPM 限流、virtual scroll、cleanMarkdown CSS 选择器等，修改后会被 `NewsPipelineConfigService` 热加载。若需多环境覆盖，可通过 `NEWS_PIPELINE_CONFIG_PATH` 指向自定义文件。
- 新增环境变量：`LITELLM_MODEL`、`LITELLM_API_URL`、`LITELLM_API_KEY`、`LITELLM_TIMEOUT_MS`、`LITELLM_TEMPERATURE`、`LITELLM_TOP_P`、`LITELLM_MAX_TOKENS`、`LITELLM_RETRY_ATTEMPTS`、`LITELLM_FALLBACK_MODELS`、`LITELLM_REQUESTS_PER_MINUTE`、`NEWS_PIPELINE_CACHE_TTL_SECONDS`、`NEWS_PIPELINE_MAX_INPUT_CHARS`、`NEWS_PIPELINE_CONFIG_PATH`、`NEWS_CRAWL_QUEUE_CONCURRENCY`、`NEWS_PROCESS_QUEUE_CONCURRENCY`、`NEWS_CRAWL_QUEUE_RATE_LIMIT`、`NEWS_PROCESS_QUEUE_RATE_LIMIT`。`pnpm --filter infra-scripts run env:check` 会同时校验。
- LiteLLM 调用走统一的 `LiteLlmService.acompletion`，包含 Redis RPM 限流、指数退避重试与模型级 fallback。模型输出由新版 `CleanedNewsSchema` 验证，字段涵盖标题、副标题、分类、主题、200~300 字摘要、要点、实体、噪声类型与质量分；同时以 [LiteLLM 成本追踪回调](https://docs.litellm.ai/docs/observability/custom_callback) 为参考记录 token 使用量、`costUsd` 与 `latencyMs`（相关缺陷修复见 [v1.74.0 release notes](https://docs.litellm.ai/release_notes/v1-74-0-stable)），方便后续预算/Guardrail。
- 网关参数兼容现已启用**严格模式**：当上游不支持 `metadata`、`response_format` 或 `json_schema` 时，不再静默删字段重试，而是直接抛出结构化兼容错误（`LLM compatibility error`）并返回修复提示，便于排障。
- `LiteLlmService` 额外支持 `aresponse`（`/v1/responses`，404 自动回退 `/responses`），用于接入外部 OpenAI-compatible 网关的 Responses API。
- Crawl4AI 结果默认缓存到 Redis（TTL 由 `NEWS_PIPELINE_CACHE_TTL_SECONDS` 控制），重复 URL 不会再次耗费 Token。若在 payload 中设置 `forceRefresh: true` 可强制重新抓取；LiteLLM 解析失败时队列会抛错并写入 `TaskLogModel`，方便追踪问题。

### LiteLLM 部署指南

本项目的 `LiteLlmService` 走 OpenAI-compatible 接口；推荐使用 LiteLLM Proxy 作为统一网关。

- **Docker Compose（推荐）**：`infra/docker/docker-compose.yml` 已内置 `litellm` 服务
  - 容器内（API 访问）：`http://litellm:4000`
  - 宿主机（本机调试）：`http://localhost:4001`
- **本机开发（pnpm dev）**：也可以单独跑一个 LiteLLM Proxy，保证 `http://localhost:4001` 可达即可

1. **配置 LiteLLM Proxy（docker-compose）**

   修改 `infra/docker/.env`（可从 `infra/docker/.env.sample` 复制）：

   - `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`：上游模型真实凭证（LiteLLM 代理内使用）
   - 可选：`OPENAI_API_KEYS` / `ANTHROPIC_API_KEYS`：逗号分隔的多 Key 列表，用于同一模型多部署负载均衡（Proxy 会在启动时将同一 `model_name` 扩展为多个 deployments 并自动分流）
   - 可选：`LITELLM_MASTER_KEY` 用于保护代理（非空才生效；若设置，也请把 `LITELLM_API_KEY` 设为同一值，方便 API 侧调用）
   - `NEWS_PIPELINE_CONFIG_PATH`：docker 默认使用 `config/news-pipeline.config.docker.yaml`（容器内指向 `http://litellm:4000`）
   - **内容安全 / 防封号（Guardrails）**：
     - LiteLLM Proxy 侧 guardrails 定义在 `infra/litellm/litellm-config.yaml`（docker-compose 会挂载并在启动时生成最终 config）。
     - API 侧（AI Assistant）默认会在每次请求里附带 `ASSISTANT_GUARDRAILS=openai-moderation-pre` 来做 `pre_call` 输入审核；如需禁用可设 `ASSISTANT_GUARDRAILS_ENABLED=false`。

2. **启动服务**

   ```bash
   pnpm docker:up
   ```

   如只想单独启动 LiteLLM Proxy：

   ```bash
   pnpm docker:up -d litellm
   ```

3. **校验 LiteLLM Proxy 是否可用**

   ```bash
   curl http://localhost:4001/health/liveliness
   curl http://localhost:4001/health/readiness
   ```

   如配置了 `LITELLM_MASTER_KEY`，访问受保护接口需带上：

   ```bash
   curl http://localhost:4001/v1/models -H "Authorization: Bearer ${LITELLM_MASTER_KEY}"
   ```

   可选：验证 Responses API（如网关支持）

   ```bash
   curl http://localhost:4001/v1/responses \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
     -d '{"model":"openai/gpt-4o-mini","input":"hi"}'
   ```

4. **系统设置中的网关兼容控制与测试（新增）**

   在 `Settings -> LLM gateway` 的 Profile 创建/编辑页可直接配置运行时兼容策略：

   - `response_format mode`: `json_schema` / `json_object` / `none`
   - `send metadata`: 开关（关闭后运行时不再发送 `metadata` 字段）

   在 `Test` 弹窗中也可测试：

   - `API surface`: `chat_completions` / `responses`
   - `response_format probe`: 默认继承 Profile，可按次覆盖
   - `include metadata probe`: 默认继承 Profile，可按次覆盖

   网关参数兼容采用**配置化严格模式**：不会再静默删字段重试；若上游不支持会直接返回结构化兼容诊断（code / field / hint / upstream message），便于快速排障。

   推荐 Profile 模板（外部 OpenAI-compatible）：

   - `OpenAI (Official)`
     - `apiBase`: `https://api.openai.com/v1`
     - `response_format mode`: `json_schema`
     - `send metadata`: `true`
   - `OpenRouter (Compatible)`
     - `apiBase`: `https://openrouter.ai/api/v1`
     - `response_format mode`: `json_object`
     - `send metadata`: `false`
   - `External Gateway (Conservative)`（第三方兼容不明确时优先）
     - `apiBase`: `https://your-openai-compatible-gateway.example.com/v1`
     - `response_format mode`: `none`
     - `send metadata`: `false`

   `apiBase` 输入框支持按域名自动推荐模板：前端会从后端接口拉取“域名 → 模板”映射配置（含默认兜底策略），失焦时按该配置匹配并在未手动修改相关字段时自动填充 `preset`、`response_format mode`、`send metadata`。为避免误覆盖，只有当 `apiBase` 相比当前表单初始值发生变化时才会应用推荐。

   你也可以在面板中开关：

   - `按场景自动推荐兼容模板`
   - `自动切换后显示提示`

   并且可在 `编辑推荐映射` 中维护域名规则（默认模板 / 本地域名 / 域名规则），保存后会持久化到 system settings 并即时生效。

   在 `Test` 弹窗里新增了 `按推荐策略重测`，可一键把 `response_format probe` + `include metadata probe` 切到推荐值并立即发起测试。

5. **本机模式（可选）**

   不使用 docker-compose 时，可按 LiteLLM 官方方式启动代理（示例）：

   ```bash
   docker run -p 4001:4000 \
     -v $(pwd)/infra/litellm/litellm-config.yaml:/app/config.yaml \
     -e OPENAI_API_KEY="sk-xxx" \
     ghcr.io/berriai/litellm:main-stable \
     --config /app/config.yaml
   ```

## TODO 与扩展点

- [x] 在简单的撤销机制之外，实现刷新令牌黑名单
- [ ] 添加前端组件测试（Playwright 或 Vitest）
- [ ] 在指标栈接入后，用真实分析替换仪表盘占位叙事卡片
- [x] 将 BullMQ 任务事件接入 WebSockets，实现 UI 实时更新

欢迎根据自身组织模型调整 docker 工作流（例如改为生产模式的多阶段镜像）或扩展种子数据。
