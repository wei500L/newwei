# api-go 切流手册（Go Cutover Runbook）

> **本批未在部署环境执行任何切换。** 本手册中的所有命令、接口调用、Redis/MySQL/Mongo 查询、重建与重启步骤**均未在本批执行**；本批只做了静态阅读与文本核对。手册不声称任何步骤已通过、已演练或已在生产验证。
>
> - 基线：`dcbe563b`（#136），worktree 分支 `docs/go-cutover-readiness`。
> - 事实来源：`apps/api-go/internal/config/config.go`（131 个 `API_GO_*` 开关与全部启动校验）、`apps/api-go/cmd/api/main.go`（路由表、Registry、worker 接线）、`apps/api-go/internal/legacyproxy/`（回落规则）、`infra/docker/docker-compose.yml`、`infra/docker/.env.sample`、`docs/refactor/go-*.md`、`docs/refactor/bug-ledger.md`。行号均来自 `dcbe563b`。
> - 配套交付：`infra/docker/api-go-cutover.env.sample`（131 个开关全 `go` 的样例）、`infra/docker/docker-compose.api-go-cutover.sample.yml`（compose override：env_file + 59 个重新声明）、`docs/refactor/cutover/switch-matrix.md`（逐开关矩阵，T3）、`docs/refactor/cutover/ownership-audit.md`（执行权审计，T1）、`docs/refactor/cutover/README.md`。**开关总数 131（本批 `refactor/go-crawl-frontier-writes` 新增 `API_GO_CRAWL_FRONTIER_WRITES_MODE`）；`/api/healthz/live` 是 C 类、没有开关、不计入 131。**
> - 本手册与 T3 矩阵的阶段归属如不一致，**以 `switch-matrix.md` 为准**；本手册用于演练编排与验证方法。

---

## 0. 阅读顺序与执行约定

### 0.1 约定

| 标记 | 含义 |
|---|---|
| 【未在本批执行】 | 该命令/验证只写成步骤，本批没有运行 |
| 【需用户在生产/预发执行】 | 必须在真实部署环境由用户执行并回填结果 |
| 【静态核对】 | 只读了源码/配置，未运行 |
| 重启 | 停止并重建容器（`docker compose up -d <svc>`），进程内状态丢失，无镜像构建 |
| 重建 | 重新构建镜像（`docker compose build <svc>`），构建期参数会重新内联 |
| 回退 | 改回环境变量 + 重启/重建；不涉及数据迁移（除个别队列排空） |

### 0.2 三条必须先知道的硬事实（会直接影响切流可行性）

**H1. compose 中 130 个开关并非都能用环境变量控制。**
`infra/docker/docker-compose.yml` 的 `api-go` 服务（`profiles: ["api-go-pilot"]`，`docker-compose.yml:776`）对 `API_GO_*` 有三类接线：

| 类别 | 数量 | 能否被 `--env-file` / `.env` 覆盖 | 证据 |
|---|---:|---|---|
| `${API_GO_X:-legacy}` 插值 | 71 | 能 | 71 条均形如 `API_GO_*: ${API_GO_*:-legacy}` |
| 写死字面量 | 49 | **不能** | 7 个固定 `go`、42 个固定 `legacy` |
| 完全未注入 | 10 | **不能**（api-go 没有 `env_file`） | 见下 |

- 固定 `go` 的 7 个：`API_GO_ONBOARDING_MODE`、`API_GO_USER_SETTINGS_READ_MODE`、`API_GO_USER_SETTINGS_WRITE_MODE`、`API_GO_PUBLIC_PORTAL_MODE`、`API_GO_DASHBOARD_STATS_MODE`、`API_GO_DASHBOARD_CHARTS_MODE`、`API_GO_DASHBOARD_WAR_MAP_MODE`（`docker-compose.yml:821-837`、`1633`）。
- 固定 `legacy` 的 42 个：`ACCOUNT_SECURITY`、`ADMIN_LOGS`、`ANALYSIS_BOARDS`、`ANALYSIS_EXPORT`、`ANALYSIS_THREADS`、`ANALYSIS_VIEWS`、`ARCHIVE_READING`、`AVATAR_UPLOAD`、`CLASSIFICATION_RSS_OPS`、`CONTENT_SUBSCRIPTIONS`、`CRAWL_METADATA`、`CRAWL_PROFILES`、`CRAWL_QUEUE_OPS`、`CRAWL_READ_TELEMETRY`、`CRAWL_TASK_WRITE`、`CRAWL_TEMPLATES`、`CRAWL_WORKFLOWS`、`EXCEPTION_INGEST`、`GRAPHQL_ALERT_RULES`、`GRAPHQL_CRAWL_METADATA`、`GRAPHQL_ITEMS_LIST`、`GRAPHQL_KG_IMPACT`、`GRAPHQL_KNOWLEDGE_REVIEW`、`GRAPHQL_NEWS_EVENT_BRIEF`、`GRAPHQL_ORG_ACCESS_WRITE`、`GRAPHQL_RSS_TRANSLATION`、`GRAPHQL_SETTINGS_CRAWL_READ`、`GRAPHQL_SETTINGS_WRITE`、`GRAPHQL_SOURCE_POLICY_WRITE`、`GRAPHQL_WORKSPACE_READ`、`GRAPHQL_WORKSPACE_WRITE`、`ITEMS_READING`、`LLM_LOGS`、`NEWSNOW_CLUSTERING_OPS`、`NEWS_INDICATORS`、`NEWS_SOURCES`、`QUALITY_OVERVIEW`、`RUNTIME_SETTINGS`、`SITUATION_MONITORS`、`USER_DATA_EXPORT`、`USER_DIGEST`、`USER_NEWS_BEHAVIOR`（均带 `_MODE` 后缀）。
- 完全未注入的 10 个：`API_GO_DASHBOARD_SPACETIME_GEO_MODE`、`API_GO_DASHBOARD_SPACETIME_PROPAGATION_MODE`、`API_GO_DASHBOARD_STREAM_MODE`、`API_GO_DASHBOARD_WAR_MAP_LAYERS_MODE`、`API_GO_DASHBOARD_WAR_MAP_TRANSPORT_MODE`、`API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE`、`API_GO_GRAPHQL_NEWS_EVENTS_MODE`、`API_GO_GRAPHQL_READ_MODE`、`API_GO_HEALTHZ_MODE`、`API_GO_RBAC_MODE`。

**结论：** 只把 `api-go-cutover.env.sample` 传给 `--env-file`，最多只能改变 71/130 个 compose 开关；本批新增的 `API_GO_CRAWL_FRONTIER_WRITES_MODE` 不在 compose 中，需随 override 的 `env_file` 注入。本批为此新增了配套 override `infra/docker/docker-compose.api-go-cutover.sample.yml`（同样**不会被默认加载**，必须用 `-f` 显式指定）：它给 `api-go` 服务加 `env_file: ./api-go-cutover.env.sample`（注入全部开关与资源占位符），并把 compose 中**不经过 `${VAR}` 插值的 59 个开关**（49 个写死字面量 + 10 个完全未注入）用 `${VAR:-legacy}` 重新声明（`environment` 优先级高于 `env_file`，不重新声明就改不动）。其余 71 个在 base compose 里已经是 `${API_GO_X:-legacy}`，无需重复。三者合起来，131 个开关才全部可控：

```
infra/docker/api-go-cutover.env.sample                    # 值（131 个开关 + 资源占位）
infra/docker/docker-compose.api-go-cutover.sample.yml     # 注入方式（env_file + 59 个重新声明）
```

> **名单差异提醒：** 规划窗口留下的临时名单只有 30 条（未随仓库提交，不作为证据）；按 `dcbe563b` 的 `docker-compose.yml:774-1697` 实测是 **49 个**写死开关（7 个固定 `go` + 42 个固定 `legacy`），临时名单缺的 19 个是：`ACCOUNT_SECURITY_MODE`、`AVATAR_UPLOAD_MODE`、`GRAPHQL_ALERT_RULES_MODE`、`GRAPHQL_CRAWL_METADATA_MODE`、`GRAPHQL_ITEMS_LIST_MODE`、`GRAPHQL_KG_IMPACT_MODE`、`GRAPHQL_KNOWLEDGE_REVIEW_MODE`、`GRAPHQL_NEWS_EVENT_BRIEF_MODE`、`GRAPHQL_ORG_ACCESS_WRITE_MODE`、`GRAPHQL_RSS_TRANSLATION_MODE`、`GRAPHQL_SETTINGS_CRAWL_READ_MODE`、`GRAPHQL_SETTINGS_WRITE_MODE`、`GRAPHQL_SOURCE_POLICY_WRITE_MODE`、`GRAPHQL_WORKSPACE_READ_MODE`、`GRAPHQL_WORKSPACE_WRITE_MODE`、`ITEMS_READING_MODE`、`ONBOARDING_MODE`、`RUNTIME_SETTINGS_MODE`、`USER_DATA_EXPORT_MODE`。override 按「49 个写死 + 10 个未注入 = 59 个」全列，否则这 19 个会静默保持 compose 的 legacy/go，env 文件写了也不生效。核对命令：

```bash
# 【静态核对，本批已执行；不启动服务】
awk 'NR>=774 && NR<=1697' infra/docker/docker-compose.yml \
  | grep -E '^\s+API_GO_[A-Z0-9_]+: (go|legacy)$' \
  | sed -E 's/^ *([A-Z0-9_]+):.*/\1/' | sort -u | wc -l   # 49
```

**H2. 阶段 0「全部开关仍 legacy」在结构上做不到；`/api/healthz/live` 没有开关，本批不新增开关（C-1）。**
- `/api/healthz/live` 在默认路由表中固定为 `ModeShadow`（`apps/api-go/internal/legacyproxy/proxy.go:135`）：Nest 是响应方，Go 只做差分。`main.go:2130` 虽然注册了 `health.LiveHandler`，但规则永远不进入 Go；`API_GO_HEALTHZ_MODE` 只接管**认证版** `GET /api/healthz`（`legacyproxy/proxy.go:410-423`；`main.go:35`）。要切 live 需要新增 builder + 开关，超出本批代码边界。
- **Lead 决策（2026-10-21）：本批不新增 `/live` 开关，按 C 类处理，交给用户决定。** 审计给出的三个选项见 `ownership-audit.md` §0.2 C-1：①新增 `API_GO_HEALTHZ_LIVE_MODE`（默认 shadow，阶段 6 前置 go，保留回退）；②直接把 `proxy.go:135` 改 `ModeGo`（失去回退）；③保持 shadow，把探针/编排改指 api-go `/__go/healthz`（`proxy.go:148`、`522`），停 Nest 后不再暴露 `/api/healthz/live`。
- `API_GO_ONBOARDING_MODE` 只接受 `shadow|go`，**没有 legacy**（`config.go:3395-3403`）；默认 shadow 意味着 onboarding GET 由 Nest 应答。`API_GO_USER_SETTINGS_READ_MODE` 接受空/`shadow`/`go`，空串是「兼容」语义，不等价于 legacy。
- 因此阶段 0 的准确表述是：**所有可切 legacy 的开关保持 legacy；两个结构性 shadow（`/api/healthz/live`、onboarding）无法关闭**。这也是 §4 停 Nest 判定不能用「legacy 请求数 = 0」一刀切的原因（见 §4.1）。

**H3. 「停业务流量」可做，「完全停 Nest」有硬阻断（C 类 + 编排依赖）。**
- `api-go` 服务 `depends_on: api: service_healthy`（`docker-compose.yml:1681-1689`），`api` 的 healthcheck 是 `GET /api/healthz/live`（`docker-compose.yml:665`）；Nest 停止后 api-go 无法被 compose 重新创建。
- `web` 启动命令会先等待 `${API_BASE_URL}/api/healthz/live`（最长 300s，失败即退出，`docker-compose.yml:1717-1723`）。当 `API_BASE_URL=http://api-go:4020` 时，该请求经 api-go 的 shadow 规则回落到 Nest；Nest 不在时 Web 重启会失败。
- 已知 C 类（`ownership-audit.md` §0.2）：C-1 `/api/healthz/live`、C-2/C-3/C-4（`POST /api/admin/crawl-frontier/runs`、`POST .../nodes/retry`、`POST .../nodes/:id/retry`，已在 `refactor/go-crawl-frontier-writes` 关闭）、C-5 `GET /api/system-settings/vector-service/diagnostics`、C-6 `itemPipelineDlq` 无消费者、C-7 Swagger `/docs`、C-8 Bull Board `/admin/queues`、C-9 根路径/未匹配 404。逐项与选项见 §4.2。
- 结论：**阶段 6 拆成 6a「停业务流量（本批可执行）」与 6b「完全停 Nest（本批不可执行，取决于 C 类决定）」**；6b 的前置工程变更见 §3.6。

### 0.3 切流总表

| 阶段 | 目标 | 开关数 | 改动对象 | 生效方式 | 回退耗时估计（依据） |
|---|---|---:|---|---|---|
| 0 | Web 入口指向 api-go，其余保持 legacy/ shadow | 0 | `.env`（`API_BASE_URL`）、可选 Web 构建参数 | 重启 web；浏览器入口需重建 web | 重启 1–2 分钟；重建另计 5–15 分钟（未实测） |
| 1 | 只读 HTTP + GraphQL 读 | 36 | api-go 环境变量 | 重启 api-go | 1–3 分钟（容器重启 + healthcheck 15s） |
| 2 | 写入 HTTP + GraphQL Mutation | 61 | api-go；部分开关 api 与 api-go 同值 | 重启 api-go；涉及 34 个有行为的双方开关时重启 api | 2–6 分钟（含 Nest 就绪等待，start_period 300s 为上限） |
| 3 | Cron / Interval / 启动任务 / 后台调度 | 18 | api + api-go 同值 | 先 api 后 api-go 重启 | 2–6 分钟（两侧重启） |
| 4 | BullMQ worker | 12 | api + api-go 同值 | 先 api 后 api-go，必要时排空 | 5–30 分钟（爬取任务运行超时上限 30 分钟，需排空） |
| 5 | GraphQL Subscription + 两个 Socket.IO 路径 | 3 | api + api-go + Web 构建参数 | 两侧重启 + **重建 Web** | 重建 5–15 分钟 + 重启 2–4 分钟（未实测） |
| 6a | 认证 `/api/healthz` + 停业务流量判定 | 1 | api-go | 重启 api-go | 1–3 分钟 |
| 6b | 完全停 Nest | 0 | compose/探针/C 类 | 需工程变更 + 用户决定 | **本批不可执行（C-1、C-5–C-9：live、vector diagnostics、DLQ、Swagger、Bull Board、根路径 404；C-2/C-3/C-4 已关闭；另加 `depends_on`/Web 探针）** |

> 说明：阶段 2 虽然只改 api-go 的读/写接管，但 46 个开关在 Nest 侧出现（附录 A：34 个有行为、11 个仅 schema、1 个未使用 getter），其中 34 个行为开关必须双侧同值；本手册把它们放在出现的最早阶段处理，后续阶段不再重复。
> 时间估计的依据仅限：`api-go` healthcheck `start_period 10s / interval 15s`（`docker-compose.yml:1690-1696`）、`api` healthcheck `start_period 300s / interval 15s`（`docker-compose.yml:664-669`）、Web 重建需要 `turbo run build`（`infra/docker/runtime.Dockerfile:51`）。**本批没有计时，均为保守估计。**

**默认部署不变（本批的硬约束）：** 不传本批的 `-f`/`--env-file` 时，行为与 `dcbe563b` 完全一致：131 个开关仍按 compose/config 默认（绝大多数 `legacy`；api-go 服务仍有 7 个写死 `go` 的 pilot 既有行为）、Web 仍指向 NestJS（`API_BASE_URL=http://api:4000`、`NEXT_PUBLIC_API_BASE_URL=http://localhost:4000/api`）、canary 仍为 0、api-go 仍只在 `api-go-pilot` profile 下启动。本批只新增样例文件，没有修改 `docker-compose.yml`、`infra/docker/.env.sample`、`config.go` 或任何默认值。

---

## 1. 角色与变更纪律

| 角色 | 职责 |
|---|---|
| 变更负责人 | 按本手册逐阶段执行；每次只切一个批次；记录开始/结束时间与开关值 |
| 观察人 | 盯 `/api/metrics`、日志、队列与错误率；有权叫停回退 |
| 业务验收人 | 按 §5 清单在真实浏览器/真实外部服务上验收；只有验收人签字才能进入下一阶段 |
| 决策人 | 阶段 6 / C 类项处理决定；未签字不得停 Nest |

纪律：
1. 一次只改一个阶段内的一个批次（2A/2B/…），批次之间至少观察 30 分钟。
2. 每次变更前保存 `docker compose config` 输出与 `.env` 备份；变更后记录差异。
3. **不允许**在同一个批次里同时改 `api` 与 `api-go` 的同一开关以外的变量。
4. 任何 5xx 比例、队列 failed 数、登录失败率异常，立即回退当前批次，不继续下一批次。
5. 回退只改环境变量与重启，不改数据库、不删队列；队列排空策略见 §3.4。

---

## 2. 前置检查（全部【未在本批执行】）

### 2.1 数据库迁移已完成

**为什么：** 迁移由 Nest 的 `api` 容器启动命令执行（`docker-compose.yml:409-413`：`pnpm --filter db run migrate` → `packages/db/src/scripts/migrate.ts:30-49` 的 `prisma migrate deploy`）。`api-go` 不执行迁移，只假设 schema 已是最新；api-go 先于迁移启动会让写入类接管直接失败。

**核对步骤【未在本批执行】：**

```bash
# 1) 迁移目录数量与最新迁移名（静态基线：63 个迁移目录）
ls packages/db/prisma/migrations | grep -c '^[0-9]'          # 预期 63
ls packages/db/prisma/migrations | grep '^[0-9]' | tail -1   # 预期 20260814141000_knowledge_graph_on_delete_cascade

# 2) 数据库已应用记录（在 mysql 容器内执行，使用容器自带环境变量）
docker compose exec -T mysql sh -c \
  'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" -e "
     SELECT COUNT(*) AS applied FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
     SELECT migration_name, finished_at FROM _prisma_migrations
      ORDER BY finished_at DESC LIMIT 5;"'

# 3) 最近一次 api 启动日志
docker compose logs api | grep -E 'Prisma migrations deployed successfully|Failed to run migrations'
```

**通过判据：** 已应用条数 = 63，最新迁移名一致；日志出现 `Prisma migrations deployed successfully`，且没有 `Failed to run migrations`。
**失败处理：** 停止切流；先修迁移，不允许带未应用迁移进入阶段 1。
**注意：** 迁移命令的输出与 `_prisma_migrations` 表在部署环境可能因历史环境不同而多于 63（例如额外热修迁移）；以「无 pending / 无 failed」为准，数量差异必须解释并记录。

### 2.2 api-go-pilot profile 已启动

**启动命令【未在本批执行；本批明确未在部署环境执行过该命令】：**

```bash
# 默认部署（不带切流文件；api-go 仍只在 api-go-pilot profile）
docker compose --profile api-go-pilot up -d api-go
# 或先在 .env 设 COMPOSE_PROFILES=api-go-pilot，再 docker compose up -d

# 切流演练（带 env 样例 + override；`cutover_compose` 函数定义见 §3 开头，或先在当前 shell 定义）
cutover_compose --profile api-go-pilot up -d api-go
```

**核对【未在本批执行】：**

```bash
docker compose --profile api-go-pilot ps api-go           # 期望 State=running, Health=healthy
docker compose logs --tail=100 api-go | grep 'api-go: listening on'   # main.go:3278
docker compose logs --tail=100 api-go | grep -E 'must be one of|is required when|requires'
curl -fsS http://127.0.0.1:4020/__go/healthz               # 网关自省（路由表/模式）
```

**通过判据：** 容器 healthy；日志有 `api-go: listening on :4020 (legacy=http://api:4000, canary=0%)`；`/__go/healthz` 返回 200 且路由表里能看到各开关的当前模式；没有启动校验错误。
**注意：**
- `api-go` 是 distroless 镜像，没有 shell/curl/wget（`infra/docker/api-go.Dockerfile:38-56`）；容器内只能执行 `/api-go healthcheck`。**因此 `docker compose exec api-go printenv ...` 不可用**；查环境变量请用宿主机 `docker inspect`（见下）。
- `api-go` 依赖 `api` healthy 才能创建；Nest 未就绪时 api-go 起不来，这是设计行为。

**凭据类变量必须真的进到 api-go 容器【未在本批执行】：**

`dcbe563b` 的 compose 已在 api-go 块注入 `MONGO_URI`、`SYSTEM_SETTINGS_ENCRYPTION_KEY`、`JWT_SECRET`、`REDIS_HOST`、`REDIS_PORT`、`REDIS_PASSWORD`、`REDIS_DB`（`docker-compose.yml:1601-1644`），但这些值来自 compose 插值；使用本批 override 时还要确认它们没有被 env_file/占位符破坏。验证命令（宿主机执行，替代 `printenv`）：

```bash
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' \
  $(docker compose --profile api-go-pilot ps -q api-go) \
  | grep -E '^(JWT_SECRET|MONGO_URI|REDIS_HOST|REDIS_PORT|REDIS_PASSWORD|REDIS_DB|SYSTEM_SETTINGS_ENCRYPTION_KEY|DATABASE_URL)=' \
  | sed -E 's#(://[^:]+:)[^@]+@#\1***@#'
```

**通过判据：** 7 个变量全部非空；`JWT_SECRET`/`SYSTEM_SETTINGS_ENCRYPTION_KEY` 不是 `<...>` 占位符；`MONGO_URI`/`DATABASE_URL` 的主机名是 `mongo`/`mysql`（compose 内网）。**失败处理：** 若为占位符或空，先修 `.env`/override 再启动；api-go 的 go 模式会在启动校验阶段直接失败（例如 `JWT_SECRET is required when ...=go`）。
> 注：`docker compose exec api-go printenv | grep -E 'JWT_SECRET|MONGO_URI|REDIS_HOST|SYSTEM_SETTINGS_ENCRYPTION_KEY'` 是期望的正向校验写法；但本仓库的 api-go 是 distroless 镜像（无 shell/printenv，`infra/docker/api-go.Dockerfile:38-56`），该命令会失败。请用上面的 `docker inspect` 作为等价校验；若部署环境使用带 shell 的自定义 api-go 镜像，可直接运行这条 `printenv` 命令并核对值与预期一致。

### 2.3 两个服务指向同一套 Redis / MySQL / Mongo

**同一 MySQL：** `api-go` 的 `DATABASE_URL` 在 compose 中由 `MYSQL_*` 派生（`docker-compose.yml:810`：`mysql://${MYSQL_USER}:${MYSQL_PASSWORD}@mysql:${MYSQL_PORT}/${MYSQL_DB}`）；Nest 在未设置 `DATABASE_URL` 时也由同一组 `MYSQL_*` 派生（`apps/api/src/modules/config/env.schema.ts` 的 `getMissingMysqlConnectionEnvVars` 校验分支，约 1415-1421 行）。
**同一 Redis：** compose 的 api-go 块已显式注入 `REDIS_HOST=redis`、`REDIS_PORT=${REDIS_PORT:-6379}`、`REDIS_PASSWORD=${REDIS_PASSWORD:?...}`、`REDIS_DB=${REDIS_DB:-0}`（`docker-compose.yml:1640-1644`）。使用本批 override 后，`env_file` 还会再注入一份同名值；由于 `environment` 优先，实际以 compose 插值为准。**核对时必须确认两处值一致**（见下方命令）。
**同一 Mongo：** 两个服务使用同一 `MONGO_URI`（Nest 经 `env_file: ./.env`；api-go 经 compose 显式映射，`docker-compose.yml:1601`），用于 dashboard/stats、war-map、items、graphql 等单元。

**核对命令【未在本批执行】：**

```bash
# 1) 宿主机侧读两个容器的解析后 env（掩码密码）
for svc in api api-go; do
  echo "=== $svc ==="
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' \
    $(docker compose --profile api-go-pilot ps -q $svc) \
    | grep -E '^(DATABASE_URL|REDIS_HOST|REDIS_PORT|REDIS_PASSWORD|MONGO_URI|LEGACY_API_URL)=' \
    | sed -E 's#(://[^:]+:)[^@]+@#\1***@#'
done

# 2) MySQL：实例身份 + 连接来源
docker compose exec -T mysql sh -c \
  'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "
     SELECT @@server_uuid, @@hostname, @@port, DATABASE();
     SELECT user, host, db, command FROM information_schema.processlist
      WHERE user NOT IN (\"system user\",\"event_scheduler\");"'

# 3) Redis：run_id 与客户端来源
docker compose exec -T redis sh -c 'redis-cli -a "$REDIS_PASSWORD" INFO server | grep -E "run_id|tcp_port"'
docker compose exec -T redis sh -c 'redis-cli -a "$REDIS_PASSWORD" CLIENT LIST' | head -50

# 4) Mongo：实例主机名与 ping
docker compose exec -T mongo sh -c \
  'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" \
     --authenticationDatabase admin --eval "db.adminCommand({ping:1}).ok; db.serverStatus().host"'

# 5) api-go 到 Nest 的回落链路：从宿主机打 api-go 的 shadow 路径
curl -i -fsS http://127.0.0.1:4020/api/healthz/live
```

**通过判据：**
- 两个容器的 `DATABASE_URL` 指向同一 host/port/db（掩码后比较），`MONGO_URI` 指向同一 host/db。
- MySQL `@@server_uuid` 只有一个值；`processlist` 中同时出现 `api` 与 `api-go` 容器 IP 的连接。
- Redis `run_id` 唯一；`CLIENT LIST` 中同时出现两个容器 IP（`addr=`）。
- Mongo `serverStatus().host` 唯一。
- `curl http://127.0.0.1:4020/api/healthz/live` 返回 200 且响应带 `x-trace-id`（Nest 经 api-go 代理；见 `httpx/middleware.go:28-53`）。
**失败处理：** 任一不一致即停止；先统一 `.env` 的 `MYSQL_*`/`MONGO_URI`/`REDIS_*` 并重启两侧，再重新核对。

### 2.4 外部服务可达

> **全部需要用户在部署环境执行；本批未执行任何一项，也没有把任何一项写成「已验证」。**

| 外部服务 | 相关变量（真实名） | 检查方法【未执行】 | 成功判据 | 失败时 |
|---|---|---|---|---|
| crawl4ai | `CRAWL4AI_BASE_URL`（默认 `http://crawl4ai:11235`）、`CRAWL4AI_API_KEY` | `docker compose ps crawl4ai`；`curl -fsS http://127.0.0.1:8082/dashboard/`（compose healthcheck 同款，`docker-compose.yml:344-356`）；`docker compose logs crawl4ai | grep -iE 'error|exception'` | HTTP 200 且容器 healthy | 阶段 4B 不开 `CRAWL_WORKER_MODE`；阶段 2B 采集写仍可回退 |
| LiteLLM | `LITELLM_API_BASE`（默认 `http://litellm:4000`）、`LITELLM_MASTER_KEY`（缺失时容器拒绝启动，`docker-compose.yml:255-260`）、`LITELLM_API_KEY` | `curl -fsS http://127.0.0.1:4001/health/liveliness`；`docker compose logs litellm | grep -iE 'error|traceback'` | 200 `"I'm alive!"` | 不切 `GRAPHQL_RSS_TRANSLATION`、`PUBLIC_PORTAL`、`NEWSNOW_HOTTEST`，阶段 2C/2E 回退 |
| model-service | `MODEL_SERVICE_BASE_URL`、`MODEL_SERVICE_INTERNAL_TOKEN` | `curl -fsS http://127.0.0.1:8090/healthz` | 200 | 经济异常规则回退本地检测；不切相关写 |
| SMTP | `SMTP_HOST`、`SMTP_PORT`、`SMTP_USER`、`SMTP_PASS`、`SMTP_FROM` | 无健康检查；以真实发信验证（§5 第 2 项） | 收件箱收到邮件；日志无 `authlogin: login code delivery failed` | 不切 `AUTH_LOGIN`、`IDENTITY_ONBOARDING`、`ALERT_WORKER`、`USER_DIGEST_DELIVERY` |
| Telegram | `SITUATION_MONITOR_TELEGRAM_ENABLED`、`SITUATION_MONITOR_TELEGRAM_API_ID`、`..._API_HASH` | 以真实登录与轮询验证（§5 第 1 项）；检查 Nest 日志无 `AUTH_KEY_DUPLICATED` | Telegram feed 有消息；Redis 租约键存在且 TTL 正常 | 不切 `SITUATION_SIGNALS_WORKER_MODE`；`SITUATION_REFRESH_MODE` 同步不开 |
| Oref | `SITUATION_MONITOR_OREF_ENABLED`、`..._OREF_PROXY_AUTH`、`..._ALERTS_URL`、`..._HISTORY_URL` | 在部署网络内 `curl -fsS "$SITUATION_MONITOR_OREF_ALERTS_URL"`（注意该站点可能按区域/UA 限制） | 返回 JSON 数组（可为空）且 HTTP 200 | 关 `SITUATION_MONITOR_OREF_ENABLED`；不切信号 worker |
| AkShare | `AKSHARE_ENABLED`、`AKSHARE_HTTP_BASE_URL`（默认 `http://akshare:8081`）、`AKSHARE_ADMIN_TOKEN` | `curl -fsS http://127.0.0.1:8081/healthz`；`docker compose logs akshare | grep -iE 'error|traceback'` | 200 | 不切 `ECONOMIC_DATA_MODE` / `ECONOMIC_DATA_WORKER_MODE` |
| 对象存储（MinIO/S3） | `S3_ENDPOINT`（默认 `http://minio:9000`）、`S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`、`S3_PUBLIC_BASE_URL` | `curl -fsS http://127.0.0.1:9000/minio/health/live`；`curl -fsS http://127.0.0.1:9001`（控制台）；真实上传见 §5 第 4 项 | 健康 200；上传后对象可读 | 不切 `STORAGE_DIAGNOSTICS`、`AVATAR_UPLOAD`、`CRAWL_READ_TELEMETRY`（媒体签名） |
| Nominatim | `GEO_NOMINATIM_BASE_URL`（默认 `https://nominatim.openstreetmap.org`）、`GEO_NOMINATIM_USER_AGENT`、`GEO_NOMINATIM_EMAIL` | `curl -A "$GEO_NOMINATIM_USER_AGENT" "https://nominatim.openstreetmap.org/search?q=Moscow&format=json&limit=1"`（遵守速率限制） | HTTP 200 + JSON | 不切 `GEOCODING_MODE`；war-map news-markers 的外部地理调用为 best-effort（`go-migration-adr.md` War Map 段） |
| OpenSky | `REALTIME_SIGNALS_OPENSKY_ENABLED`、`..._CLIENT_ID`、`..._CLIENT_SECRET`、`..._TOKEN_URL` | `curl -fsS "$REALTIME_SIGNALS_OPENSKY_TOKEN_URL" -d grant_type=client_credentials -d client_id=... -d client_secret=...`（或用 `/api/system-settings/realtime-signals/runtime` 看额度） | token 获取成功、额度未耗尽 | 关 OpenSky；不切 `REALTIME_SIGNALS_MODE` |
| Elasticsearch（可选） | `ELASTICSEARCH_ENABLED`、`ELASTICSEARCH_NODE` | `curl -fsS http://127.0.0.1:9200/_cluster/health?pretty` | status green/yellow | `SEARCH_REINDEX` 仍可切（禁用分支 indexed=0） |
| Qdrant（可选） | `VECTOR_SERVICE_BASE_URL`、Qdrant 端口 6333 | `curl -fsS http://127.0.0.1:6333/healthz` | 200 | 不切 vector 相关（本批不涉及 vector-go 切流） |
| ais-relay（可选） | `AIS_RELAY_SHARED_SECRET`、`REALTIME_SIGNALS_RELAY_*` | `curl -fsS http://127.0.0.1:3004/healthz`（端口见 `docker-compose.yml:375-390`） | 200 | 关 AIS 采集 |

**统一失败处理：** 任一外部服务不可用时，禁止进入依赖它的阶段；已经切换的按 §7 回退到 legacy，并记录失败时间与错误码。**不要把「端口能连」当成「业务可用」**——真实业务验证见 §5。

### 2.5 观测与告警就绪

- 指标端点：`GET /api/metrics`，由 `API_GO_METRICS_MODE` 决定归属。Go 侧 handler 要求 Bearer 身份具备 `metrics.read` 且是平台管理员（`apps/api-go/internal/metrics/handler.go:20-30`、`64-80`；`cmd/api/nest_residual_duties.go:243-255`）。
- 已存在的指标 family（`apps/api-go/internal/metrics/families.go:28-55`）：`http_request_duration_seconds`、`background_job_duration_seconds`、`integration_events_total`、`scheduler_runs_total`、`pipeline_metric_value`；进程指标（`processmetrics.go:5-19`）：`go_*`、`process_cpu_seconds_total`、`process_start_time_seconds`。
- **诚实说明：** 本批静态核对发现，除 `scheduler_runs_total` 在 `classificationalert` 有记录点（`internal/classificationalert/scheduler.go:373-381`）外，其余 family 在 Go 代码中没有记录调用点。切 `API_GO_METRICS_MODE=go` 后，`/api/metrics` 会输出这些 family 的 `# HELP/# TYPE`，但**没有 series**。监控面板不能假设有数据；nodejs_* 系列也不会存在（`processmetrics.go:11-25` 的映射表）。
- 日志：全部走标准 `log` 包，前缀是 `api-go: ` 或各包前缀（如 `itempipeline: `、`situationsignalsworker: `、`economicqueue: `、`newssourcescheduler: `、`userdigest: `）。Nest 侧有对应的 `Skipped ... because Go owns ...` 日志（附录 B），可用于证明消费者已让位。
- 回落指标 `api_go_legacy_proxy_requests_total{route_prefix}` 已在本批实现并提交（未部署、未运行、未验证），详见 §4.1/§6；`/api/metrics` 的实际 series 仍未实跑核对。

### 2.6 回退准备

```bash
# 备份（部署环境执行；未在本批执行）
cp infra/docker/.env infra/docker/.env.bak.$(date +%Y%m%d%H%M%S)
docker compose config > /tmp/compose.before.$(date +%Y%m%d%H%M%S).yml
```
还要准备：数据库快照（至少 MySQL）、当前队列积压快照（附录 C 的命令）、当前 `API_GO_*` 生效值清单。回退目标：能在 10 分钟内把当前批次全部改回 legacy/shadow 并恢复流量。

### 2.7 探针与编排依赖（停 Nest 前必须处理）

`/api/healthz/live` 是 C-1，且被编排硬依赖；**只要 Nest 还在，这些探针都能工作；一旦停 Nest 就会失败**：

| 位置 | 当前行为 | 影响 |
|---|---|---|
| `docker-compose.yml:665`（api 服务 healthcheck） | `curl -fsS http://localhost:4000/api/healthz/live`（Nest 自己） | 若把 api 容器作为只读旁路保留，健康检查仍正常；若停 api 容器则无意义 |
| `docker-compose.yml:1717-1723`（web 启动等待） | 等待 `${API_BASE_URL}/api/healthz/live`；`API_BASE_URL=http://api-go:4020` 时经 Go shadow 落到 Nest | **Nest 停止后 Web 重启会等待 300s 后退出**；运行中的 Web 不受影响 |
| 外部 ingress/监控探针（部署环境自有） | 未知，可能也打 `/api/healthz/live` | 停 Nest 后会 502；必须改到 `/__go/healthz`（Go 内部端点，`proxy.go:148`、`522`）或 Go 接管后的 `/api/healthz/live`（需 C-1 选项 1/2） |

**核对命令【未在本批执行】：**

```bash
docker inspect -f '{{json .Config.Healthcheck}}'   $(docker compose ps -q api) $(docker compose --profile api-go-pilot ps -q api-go)
docker compose config | grep -n 'healthz/live'   # 确认 web command / api healthcheck
# 部署环境还需检查 ingress/monitoring 的探针目标（不在本仓库）
```

**判定：** 只要还有任何探针目标指向 `/api/healthz/live`，6b 就不能执行；6a（停业务流量）不受影响，因为 Nest 仍在。

---

## 3. 分阶段切换

> 通用前提：每一阶段开始前完成 §2.1–§2.7；每一批次只改一个分组；每次改完都按本节验证并记录。
> 通用回退：把本批次改过的开关改回 `legacy`（shadow 语义的按原值），重启对应服务；不需要改数据。回退耗时见各阶段。

**本手册统一使用的 compose 前缀**（在仓库根目录定义一次；两个 `--env-file` + 两个 `-f` 缺一不可。`--env-file` 会替代默认 `.env`，所以必须同时给 `infra/docker/.env`；override 只影响 api-go）：

```bash
# 【未在本批执行】仅定义 shell 函数，不启动任何服务
cutover_compose() {
  docker compose \
    --env-file infra/docker/.env \
    --env-file infra/docker/api-go-cutover.env.sample \
    -f infra/docker/docker-compose.yml \
    -f infra/docker/docker-compose.api-go-cutover.sample.yml "$@"
}
# 例：cutover_compose --profile api-go-pilot up -d api-go
#     cutover_compose --profile api-go-pilot build web
#     cutover_compose up -d web
```

> 若部署环境的 `.env` 路径不同，请同步替换第一个 `--env-file`；若不想用 env 样例，请把 override 里的 `env_file` 改成你的文件（或复制一份 override）。本批没有执行过上述命令。

### 阶段 0：Web 入口指向 api-go（开关仍 legacy / shadow）

**目标：** 让 Web 的请求路径先经过 api-go，但 api-go 把全部业务流量原样代理回 NestJS。用于验证入口、透明代理、CORS、trace 与健康检查。

**0A 只切服务端入口（无需重建镜像）**

1. 在 `.env` 设 `API_BASE_URL=http://api-go:4020`；`NEXT_PUBLIC_API_BASE_URL` 暂不改（浏览器仍直连 Nest 的 4000）。**若走严格全 legacy，先按 0C 生成 phase0 env，并用 `--env-file .../phase0.env` 替代 sample。**
2. 确认 api-go 已启动（§2.2；启动命令用 `cutover_compose --profile api-go-pilot up -d api-go`）。
3. `cutover_compose up -d web`【未在本批执行】。
4. 验证：
   - `curl -fsS http://127.0.0.1:3000/api/healthz` → `{"ok":true}`（Web 自身健康路由，`apps/web/app/api/healthz/route.ts`）。
   - `curl -i http://127.0.0.1:4020/api/healthz/live` → 200 + `x-trace-id`（经 api-go shadow 到 Nest）。
   - `cutover_compose logs web | grep '\[web\] api ready'`（启动等待成功）。
   - 打开首页/登录页，确认 SSR 正常。
5. **验证局限（重要）：** api-go 当前没有任何请求级访问日志（§6），无法从日志证明「每个请求都经过 api-go」。演练环境可在低峰做破坏性验证：`cutover_compose stop api-go`，观察 Web 的 SSR 请求是否立即 502/超时；恢复后确认恢复。**不要在生产做这个实验。**

**0B 浏览器入口也走 api-go（需要重建 Web）**

1. 在 `.env` 设 `NEXT_PUBLIC_API_BASE_URL=http://localhost:4020/api`（`API_GO_HOST_PORT` 保持 4020；浏览器地址按实际发布主机改写）。
2. 重建：`cutover_compose --profile api-go-pilot build web && cutover_compose up -d web`【未在本批执行】。**构建期参数会被内联进 bundle**（`infra/docker/runtime.Dockerfile:6-10`、`29-32`；`docker-compose.yml:1703-1711`），只重启不重建无效。`API_BASE_URL`（服务端）只需重启，不需要重建。
3. 验证：浏览器 DevTools → Network，XHR/WS 的 host 应为 `localhost:4020`；`curl -i -X OPTIONS http://127.0.0.1:4020/api/...`（带 `Origin`、`Access-Control-Request-Method`）应返回 CORS 预检（Nest 代理应答或 Go 预检，取决于开关）。
4. 观察 10 分钟无 5xx 后进入阶段 1。

**0C 严格「业务全 legacy」的做法（阶段 0 推荐）**

问题：env 样例是 **all-go 终态**；而 compose 的 7 个开关写死 `go`，另外 10 个未注入。只把 sample 原样传给 `--env-file` 会让 pilot 在阶段 0 就接管 user-settings、public portal、dashboard 等，不符合「阶段 0 只改入口」。做法是**生成一份阶段 0 的 env**（仍使用同一个 override，无需改 override）：

```bash
# 【未在本批执行】生成 phase0.env：全部开关先改 legacy，再修正三个结构性例外
sed -E 's/^(API_GO_[A-Z0-9_]+_MODE)=go$/\1=legacy/' \
  infra/docker/api-go-cutover.env.sample > infra/docker/api-go-cutover.phase0.env
# ONBOARDING_MODE 不接受 legacy，只能是 shadow（H2）
sed -i.bak 's/^API_GO_ONBOARDING_MODE=legacy$/API_GO_ONBOARDING_MODE=shadow/' \
  infra/docker/api-go-cutover.phase0.env
# USER_SETTINGS_READ_MODE 不接受 legacy；写成空 = 兼容语义（H2）
sed -i.bak 's/^API_GO_USER_SETTINGS_READ_MODE=legacy$/API_GO_USER_SETTINGS_READ_MODE=/' \
  infra/docker/api-go-cutover.phase0.env
rm -f infra/docker/api-go-cutover.phase0.env.bak
# 复核：131 行开关，除 ONBOARDING/READ 两个例外外全部 legacy
grep -cE '^API_GO_[A-Z0-9_]+_MODE=' infra/docker/api-go-cutover.phase0.env   # 131
grep -E '^API_GO_[A-Z0-9_]+_MODE=' infra/docker/api-go-cutover.phase0.env | grep -v '=legacy$'
# 预期只剩：API_GO_ONBOARDING_MODE=shadow 与 API_GO_USER_SETTINGS_READ_MODE=
```

然后阶段 0 的启动命令把第二个 `--env-file` 换成 `infra/docker/api-go-cutover.phase0.env`：

```bash
# 【未在本批执行】
docker compose \
  --env-file infra/docker/.env \
  --env-file infra/docker/api-go-cutover.phase0.env \
  -f infra/docker/docker-compose.yml \
  -f infra/docker/docker-compose.api-go-cutover.sample.yml \
  --profile api-go-pilot up -d
```

**为什么这样就够：** override 里 59 个开关都写成 `${VAR:-legacy}`，`phase0.env` 提供 `legacy`，因此 49 个 compose 写死项（含 7 个 `go`）和 10 个未注入项全部变 `legacy`；其余 71 个在 base compose 里本来就是 `${VAR:-legacy}`。**注意：** `phase0.env` 是演练临时文件，不提交；阶段 0 结束后切到阶段 1 时，改用 sample 并逐批把当前批次的开关改 `go`（不要直接全量 sample，否则会跳过阶段顺序）。

**回退：** `.env` 改回 `API_BASE_URL=http://api:4000`，`NEXT_PUBLIC_API_BASE_URL` 改回 `http://localhost:4000/api`；重启 web；若改过浏览器入口需重建 web。耗时：重启 1–2 分钟；重建 5–15 分钟（未实测）。数据风险：无。

### 阶段 1：只读 HTTP 与 GraphQL 读（36 个开关）

**分组与顺序**（对应 `api-go-cutover.env.sample` 的 1A–1D）：

| 批次 | 开关 |
|---|---|
| 1A 低风险只读 | `API_GO_METRICS_MODE`、`API_GO_PUBLIC_PORTAL_MODE`、`API_GO_ITEMS_READING_MODE`、`API_GO_PIPELINE_RECOVERY_MODE`、`API_GO_SITUATION_INSIGHTS_MODE`、`API_GO_QUALITY_OVERVIEW_MODE`、`API_GO_ADMIN_LOGS_MODE`、`API_GO_LLM_LOGS_MODE`、`API_GO_RUNTIME_DIAGNOSTICS_MODE`、`API_GO_GEOCODING_MODE` |
| 1B 仪表盘/态势读 | `API_GO_DASHBOARD_STATS_MODE`、`API_GO_DASHBOARD_CHARTS_MODE`、`API_GO_DASHBOARD_WAR_MAP_MODE`、`API_GO_DASHBOARD_WAR_MAP_TRANSPORT_MODE`、`API_GO_DASHBOARD_WAR_MAP_LAYERS_MODE`、`API_GO_DASHBOARD_SPACETIME_GEO_MODE`、`API_GO_DASHBOARD_SPACETIME_PROPAGATION_MODE`、`API_GO_DASHBOARD_STREAM_MODE` |
| 1C 个人/设置/采集/存储读 | `API_GO_USER_SETTINGS_READ_MODE`、`API_GO_ARCHIVE_READING_MODE`、`API_GO_ANALYSIS_EXPORT_MODE`、`API_GO_NEWS_SOURCE_PREVIEW_MODE`、`API_GO_NEWSNOW_SOURCES_MODE`、`API_GO_CRAWL_METADATA_MODE`、`API_GO_ONBOARDING_MODE`、`API_GO_SITUATION_MONITOR_SIGNALS_MODE`、`API_GO_USER_DATA_EXPORT_MODE` |
| 1D GraphQL 读 | `API_GO_GRAPHQL_READ_MODE`、`API_GO_GRAPHQL_WORKSPACE_READ_MODE`、`API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE`、`API_GO_GRAPHQL_KG_IMPACT_MODE`、`API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE`、`API_GO_GRAPHQL_NEWS_EVENTS_MODE`、`API_GO_GRAPHQL_NEWS_EVENT_BRIEF_MODE`、`API_GO_GRAPHQL_ITEMS_LIST_MODE`、`API_GO_GRAPHQL_CRAWL_METADATA_MODE` |

**依赖与顺序理由：**
- 先切 `API_GO_METRICS_MODE=go` 是为了让后续阶段能读 `/api/metrics`；但它要求 JWT/MySQL/Redis（`config.go:5500` 附近），且指标本身大多没有 series（§2.5），**不要把它当作验证依据**。
- 1D 必须在 1A–1C 之后：GraphQL 读依赖 `API_GO_GRAPHQL_READ_MODE=go`，且 `ITEMS_LIST` 还依赖 `API_GO_ITEMS_READING_MODE=go`（`config.go:5821-5826`），`CRAWL_METADATA` 依赖 `GRAPHQL_READ`（`config.go:5747-5748`），`NEWS_EVENT_BRIEF` 依赖 `GRAPHQL_READ` + `NEWS_EVENTS`（`config.go:4421-4422`）。先开子开关会启动失败。
- `GRAPHQL_NEWS_EVENTS_MODE`、`GRAPHQL_READ_MODE`、`GRAPHQL_KNOWLEDGE_GRAPH_MODE` 在 compose 中**没有注入**（H1），必须 override；否则无论 env 怎么设都不会生效（`GRAPHQL_KNOWLEDGE_GRAPH_MODE` 缺失意味着知识图谱 root 永远不登记）。

**执行步骤【未在本批执行】：**
1. 在 `.env`/override 里把 1A 的 10 个设为 `go`。
2. `cutover_compose --profile api-go-pilot up -d api-go`（只重启 api-go；命令前缀见 §3 开头）。
3. 验证 1A（见下）。
4. 依次 1B → 1C → 1D，每批重复 1–3。

**验证方法：**

| 批次 | 日志关键字 | 接口验证（curl 示例，需真实 token） | 数据/缓存 |
|---|---|---|---|
| 1A | `api-go: Prometheus metrics endpoint owned by Go`（`nest_residual_duties.go:255`）、`api-go: public portal home, channel, and story detail under go takeover`（`main.go:1513`）、`api-go: item reading REST routes under go takeover`（`main.go:2633`）、`api-go: GET /api/healthz under go takeover`（阶段 6a）、`api-go: GraphQL ... registered`（1D） | `curl -fsS -H "Authorization: Bearer <token>" http://127.0.0.1:4020/api/metrics`（需 `metrics.read` + 平台管理员）；公开门户：`curl -fsS http://127.0.0.1:4020/api/public-portal/home`；条目：`curl -fsS -H "Authorization: Bearer <token>" 'http://127.0.0.1:4020/api/items?limit=1'` | 公开门户缓存 key；条目读模型 Mongo `itemreadmodels`；无写入 |
| 1B | `api-go: GET /api/dashboard/stats under go takeover`（`main.go:1539`）、`dashboard chart GETs under go takeover`（1565）、`war map events and news-markers under go takeover`（1632）、`spacetime ... under go takeover`（1683/1689）、`GET /api/dashboard/stream under go takeover`（1711） | `curl -fsS -H "Authorization: Bearer <token>" http://127.0.0.1:4020/api/dashboard/stats`；charts 三条；war-map 两条；`curl -N` 订阅 `/api/dashboard/stream` 观察 SSE 心跳 | 允许 200；SSE 有事件或心跳；无 5xx |
| 1C | `api-go: user-settings read GET(s) under go takeover`（`main.go:1492`）；archive/analysis 无专属日志，可看无代理错误 | `curl -fsS -H "Authorization: Bearer <token>" http://127.0.0.1:4020/api/user-settings/ui/onboarding`；`.../api/archive/...`；`POST /api/crawl-tasks/metadata`（只读预览）；`GET /api/admin/news-sources/:id/preview` | MySQL `UserSetting` 未变化；ONBOARDING 仍是 shadow（H2），响应来自 Nest 但 Go 做差分；`/api/healthz/live` 仍 shadow |
| 1D | `api-go: GraphQL read pilot under go (16 queries; ...)`（`main.go:2492`）以及各 `registered/not registered` 分支（`main.go:2495-2540`） | `curl -fsS -H "Authorization: Bearer <token>" -H 'content-type: application/json' http://127.0.0.1:4020/graphql -d '{"query":"query { me { id email } }"}'`；再测 items 连接、newsEvents、knowledge graph、settings/crawl 读 | 响应 200 且 `data` 非空；未注册的 operation 仍整体回退 Nest（对比同请求打 4000 端口结果） |

**回退：** 把本批次的开关改回 `legacy`，重启 api-go。1D 回退只改对应子开关即可（例如只回退 `GRAPHQL_ITEMS_LIST_MODE`），不必关闭整个 GraphQL 读。耗时 1–3 分钟。数据风险：无。
**已知行为差异：** 只读路径的差异见 §8 第 5/7 条（缓存读取路径、REST/GraphQL 语义）；回退后按 Nest 原语义。

### 阶段 2：写入类 HTTP 与 GraphQL Mutation（61 个开关）

**分组与顺序**（对应 sample 2A–2E）：

| 批次 | 开关（数量） | 建议节奏 |
|---|---|---|
| 2A 设置/治理/诊断写 | `DATA_RUNTIME_SETTINGS`、`EMAIL_SETTINGS`、`RUNTIME_SETTINGS`、`PLATFORM_GOVERNANCE_SETTINGS`、`INFRASTRUCTURE_SETTINGS`、`MODEL_ACCESS_SETTINGS`、`LLM_GATEWAY_PROFILES`、`LLM_GATEWAY_OPS`、`PROXY_LOAD_BALANCING`、`SITUATION_SETTINGS`、`EXCEPTION_INGEST`、`STORAGE_DIAGNOSTICS`、`SITUATION_REFRESH`（13） | 每次 3–4 个；每组后回读设置 |
| 2B 采集写 | `CRAWL_TASK_WRITE`、`CRAWL_QUEUE_OPS`、`CRAWL_TEMPLATES`、`CRAWL_PROFILES`、`CRAWL_WORKFLOWS`、`CRAWL_WORKFLOW_TRIAL`、`CRAWL_FRONTIER_RUNS`、`CRAWL_FRONTIER_WRITES`、`CRAWL_READ_TELEMETRY`、`SEARCH_REINDEX`、`GDELT_SNAPSHOT_REFRESH`、`NEWS_SOURCES`、`NEWS_SOURCE_OPS`（13） | 每次 3–4 个；先只读后写 |
| 2C 业务对象写 | `ITEMS_INGEST`、`RBAC`、`USER_SETTINGS_WRITE`、`USER_DIGEST`、`USER_NEWS_BEHAVIOR`、`CONTENT_SUBSCRIPTIONS`、`ANALYSIS_VIEWS`、`ANALYSIS_BOARDS`、`ANALYSIS_THREADS`、`NEWS_INDICATORS`、`NEWSNOW_HOTTEST`、`NEWSNOW_CLUSTERING_OPS`、`ECONOMIC_DATA`、`CLASSIFICATION_RSS_OPS`、`CLASSIFICATION_REPORTS`、`SITUATION_MONITORS`、`PIPELINE_RECOVERY_WRITE`、`NEWS_CLUSTERING_LLM_BACKFILL`、`AVATAR_UPLOAD`（19） | 每次 3–5 个；每批观察 30 分钟 |
| 2D 身份/登录写 | `IDENTITY_ONBOARDING`、`AUTH_FACTORS`、`ACCOUNT_SECURITY`、`OIDC_LOGIN`、`SITUATION_TELEGRAM_AUTH`、`AUTH_LOGIN`（6） | **一次只切 1 个**；先完成 §5 第 2/10 项 |
| 2E GraphQL Mutation | `GRAPHQL_ORG_ACCESS_WRITE`、`GRAPHQL_WORKSPACE_WRITE`、`GRAPHQL_SETTINGS_WRITE`、`GRAPHQL_SOURCE_POLICY_WRITE`、`GRAPHQL_ALERT_RULES`、`GRAPHQL_RSS_TRANSLATION`、`GRAPHQL_KNOWLEDGE_REVIEW`、`GRAPHQL_ASSISTANT_WRITE`、`GRAPHQL_NEWS_INDICATOR_REFRESH`、`ANALYSIS_RUNS`（10） | 每次 2–3 个 |

**依赖与顺序理由：**
- `API_GO_USER_SETTINGS_WRITE_MODE=go` 要求 `API_GO_USER_SETTINGS_READ_MODE=go`（`config.go:3428-3430`）：阶段 1C 必须先完成。
- `GRAPHQL_ALERT_RULES` / `CLASSIFICATION_REPORTS` / `NEWS_CLUSTERING_LLM_BACKFILL` 会写 BullMQ 队列；消费者在阶段 4 仍由 Nest 承担，切换期间不会丢任务（Nest 的 Queue 仍存在，只是 worker 归属未变）。
- 2D 放最后：登录/会话写一旦出错影响所有用户；先完成 SMTP、OIDC、Telegram 的真实发信/登录验证（§5）。
- `SITUATION_MONITOR_SIGNALS`/`ONBOARDING`/`GEOCODING`/`USER_DATA_EXPORT`/`RUNTIME_DIAGNOSTICS` 按 T3 矩阵归入阶段 1（只读或轻量诊断）；阶段 2 的 `SITUATION_REFRESH` 有硬依赖例外：`config.go:6177/6180` 要求 `SITUATION_SIGNALS_WORKER_MODE=go` 且 `NEWS_SOURCE_SCHEDULER_MODE=go`，因此它虽然在阶段 2 分组，**实际必须等到阶段 3D 与 4D 完成后再执行**。
- `API_GO_CRAWL_FRONTIER_WRITES_MODE` 必须与 `API_GO_CRAWL_FRONTIER_RUNS_MODE` 同侧（创建/重试返回同一个 run-detail payload，config 强制要求 RUNS=go）；回退到 legacy 后节点重试恢复 Nest 语义，若两侧存在既有行为差异会重新出现。

**验证方法（每个批次都要做）：**

1. 日志：无 `api-go: ... failed`、无 `must be one of`；Nest 日志无 500 激增。
2. 业务接口：对刚切换的写接口做一次「读旧值 → 写 → 回读」；示例：
   ```bash
   curl -fsS -H "Authorization: Bearer <token>" http://127.0.0.1:4020/api/system-settings/rate-limits
   curl -fsS -X PUT -H "Authorization: Bearer <token>" -H 'content-type: application/json' \
     http://127.0.0.1:4020/api/system-settings/rate-limits -d '<原值回写>'
   ```
3. MySQL：检查对应表 `updatedAt`/`updatedBy` 与行数（如 `SystemSetting`、`ItemMeta`、`CrawlTask`、`UserSetting`、`AuditLog`）。
4. Redis：缓存键被更新（如 `settings:*`、`auth_profile_cache:*`），锁按预期释放。
5. MongoDB（涉及时）：`processeditems`、`tasklogs`、`assistantruns`、`llmrequestlogs`、`exceptionevents` 有新文档且字段完整。
6. 队列（涉及写入时）：`bull:itemPipeline:wait`、`bull:alerts:wait`、`bull:classification_quality:wait` 的积压不持续增长（附录 C）。
7. 审计：写操作应产生 `AuditLog` 或 `AuditLogOutbox`（失败回退），不出现两者都失败。

**回退：** 改回 `legacy` 并重启 api-go；若该开关在附录 A.1 的 34 个行为开关中（Nest 同读），先改 api-go 再改 api。耗时 2–6 分钟。数据风险：已写入的数据不会回滚（Go 与 Nest 写同一库表）；如写入格式异常，必须按 §7 的数据处置流程处理，不能只改开关。

### 阶段 3：Cron / Interval / 启动任务 / 后台调度（18 个开关）

**分组与顺序**（sample 3A–3D）：

| 批次 | 开关 | 周期/说明 |
|---|---|---|
| 3A | `STARTUP_RECONCILE`、`BULLMQ_CLEANUP`、`AUDIT_LOG_RETENTION`、`CRAWL_MAINTENANCE` | 启动一次 / 每小时 / 每日 / 采集维护 |
| 3B | `AUDIT_OUTBOX`、`RAW_ITEM_OUTBOX`、`PROCESSED_ITEM_OUTBOX` | 每分钟 / 每分钟 / 每 5 分钟（`docker-compose.yml:475-489`） |
| 3C | `KNOWLEDGE_GRAPH_INGESTION`、`NEWS_EVENTS_INGESTION`、`NEWS_EVENTS_TIMELINE`、`SENTIMENT_SNAPSHOT`、`NEWS_INDICATOR_ASSOCIATION_CRON` | 5 分钟 / 5 分钟 / 10 分钟 / 1 小时 / 6 小时（`docker-compose.yml:503-507`、`586-592`） |
| 3D | `NEWS_SOURCE_SCHEDULER`、`REALTIME_SIGNALS`、`NEWSNOW_BACKGROUND`、`GDELT_SNAPSHOT`、`USER_DIGEST_DELIVERY`、`CLASSIFICATION_QUALITY_ALERT` | 1 分钟 / 1 分钟 / 10 分钟+1 分钟 / 15 分钟 / 1 分钟 tick（每日时区） / 5 分钟 / 事件流 |

**关键顺序：**
- 3B/3C/3D 中凡在附录 A.1 的 34 个行为开关（Nest 同读），启用顺序是**先 `api` 设 `go` 并重启，再 `api-go` 设 `go` 并重启**；回退顺序相反（先 api-go 回 legacy，再 api 回 legacy）。理由：Nest 在 go 模式下会在领取时间片/创建 Worker 前退出（例如 `apps/api/src/modules/audit/audit-log-outbox.service.ts:60-65`、`apps/api/src/modules/news-events/news-events-ingestion.service.ts:54`、`apps/api/src/modules/user-digest/user-digest-delivery-scheduler.service.ts:39`），如果顺序反过来会出现短暂双 owner。
- 3D 的 `NEWS_SOURCE_SCHEDULER_MODE` 是 `SITUATION_REFRESH_MODE` 的前置（`config.go:6180`），必须在阶段 4D 之前完成。
- `CLASSIFICATION_REVIEW_SEED_MODE` 按 T3 矩阵归入阶段 4（依赖 `itemPipeline` 事件流）；若阶段 4A 还未接管 worker，事件流仍由 Nest 产生，Go 只读取，不会重复入队（jobId 幂等）。

**验证方法：**

| 检查 | 命令/位置【未执行】 | 通过判据 |
|---|---|---|
| Nest 让位日志 | `docker compose logs api | grep -E 'Skipped (audit log outbox|raw-item outbox|news event ingestion|news event timeline|sentiment snapshot|user digest delivery|knowledge graph ingestion|news indicator association)'`（附录 B） | 出现对应 `because Go owns ...`，每个开关一行 |
| Go 调度日志 | `docker compose logs api-go | grep -E 'owned by Go|scheduler enabled|scheduler under go'`（如 `main.go:3071`、`3104`、`3112`、`3166`；`nest_residual_duties.go:255` 不是调度） | 出现对应启动日志；没有 `close` 相关错误 |
| Redis tick gate / 锁 | `redis-cli -a "$REDIS_PASSWORD" --scan --pattern 'cron:*'`；`--scan --pattern 'lock:cron:*'`；`TTL` 检查 | 键存在、TTL 在合理区间；同一时刻只有一个实例持有锁（值/时间戳可判断） |
| 任务产出 | MySQL `TaskLog`/`ProcessedItem`/`NewsEvent`；Mongo `tasklogs`；Redis `bull:itemPipeline:wait` | 每周期有新记录；积压不持续增长；failed 不增加 |
| 摘要投递 | 日志 `userdigest: delivery tick completed orgCount=... completed=... failed=...`；`redis-cli GET cron:user-digest-delivery:tick-gate`；`lock:cron:user-digest-delivery:org:<orgId>` | completed 增长、failed 为 0；SMTP 真实送达（§5 第 2 项） |
| 新闻源调度 | `newssourcescheduler: ...` 日志；`lock:cron:news-source-scheduler`；`bull:itemPipeline:wait` 不爆炸 | 每分钟有 dispatch 记录、无 ERROR |

**回退：** 先 api-go 回 legacy 并重启，再 api 回 legacy 并重启。耗时 2–6 分钟（两侧重启 + Nest 就绪）。数据风险：同一周期内最多重复执行一次（两侧都可能在切换窗口领取同一 tick），业务应幂等；若发现重复写，按 §7 记录并让业务验收人决定是否人工清理。

### 阶段 4：BullMQ worker（14 个开关；4E 是队列运维与统计，不消费业务队列）

**分组与顺序**（sample 4A–4D，遵循 BRIEF：条目流水线 → 爬取/Frontier LLM → 其余）：

| 批次 | 开关 | 队列（真实名称） |
|---|---|---|
| 4A | `ITEM_PIPELINE_WORKER_MODE` | `itemPipeline`（DLQ `itemPipelineDlq`） |
| 4B | `CRAWL_WORKER_MODE`、`CRAWL_FRONTIER_LLM_WORKER_MODE` | `crawl4ai`、`crawl4ai-hot`、`crawl4ai-normal`；`frontier-llm-judge`、`frontier-llm-learn` |
| 4C | `ANALYSIS_WORKER_MODE`、`ASSISTANT_WORKER_MODE`、`ALERT_WORKER_MODE`、`ECONOMIC_DATA_WORKER_MODE`、`ARCHIVE_PREPARATION_WORKER_MODE`、`CLASSIFICATION_QUALITY_WORKER_MODE`、`NEWS_CLUSTERING_RECOVERY_WORKER_MODE`、`CLASSIFICATION_REVIEW_SEED_MODE` | `analysis`、`assistant`、`alerts`、`akshare-data`、`archivePreparation`、`classification_quality`、`news_event_clustering_recovery` |
| 4D | `SITUATION_SIGNALS_WORKER_MODE` | `situationMonitorSignals`；`SITUATION_REFRESH` 在阶段 2 分组，但必须等本组与 3D 完成后才执行（`config.go:6177/6180`） |

**切换前检查【未在本批执行】：**
1. 队列排空/低水位：`LLEN bull:itemPipeline:wait`、`LLEN bull:itemPipeline:active`、`ZCARD bull:itemPipeline:failed`（附录 C）。建议 `active=0` 或接近 0 再切，避免在飞任务跨 owner。
2. 记录当前 owner：用 §4.3 的 CLIENT LIST 方法确认当前消费者来自 `api` 容器 IP。
3. `BULLMQ_WORKERS_ENABLED=true`（默认；false 时两侧都不消费，`config.go:2364` 附近注释）。切换期间不要改它。

**执行步骤【未在本批执行】：**
1. `api` 侧先设 `go` 并重启（Nest 跳过创建 Worker，日志见附录 B）。
2. 等 Nest 的 in-flight 任务结束（`active=0`，爬取任务最长 30 分钟，`CRAWL_TASK_RUNNING_TIMEOUT_MS=1800000`，`docker-compose.yml:581`）。
3. `api-go` 侧设 `go` 并重启。
4. 验证（见下）。

**验证方法：**

| 检查 | 方法【未执行】 | 通过判据 |
|---|---|---|
| Nest 让位 | 日志 `Skipped item pipeline worker because Go owns the consumer`（`apps/api/src/modules/queue/queue.processor.ts:102`）、`Skipped archive preparation worker...`（`apps/api/src/modules/archive/archive-preparation.processor.ts:47`）、`alerts queue ownership moved to api-go`（`apps/api/src/modules/alerts/alerts.processor.ts:39`）、`Assistant worker runs in api-go...`（`apps/api/src/modules/assistant/assistant.processor.ts:40`） | 对应日志出现 |
| Go 接管 | `docker compose logs api-go | grep -E 'item pipeline worker|archive preparation|alert worker|crawl worker|assistant worker|analysis worker'` | 对应 worker 启动日志；无 `close`/`failed` |
| 队列消费者 | §4.3 的 CLIENT LIST 方法：`bull:<q>` 的阻塞连接只来自 api-go 容器 IP | 无 api 容器 IP 的 bull 连接 |
| 吞吐 | `LLEN bull:<q>:wait` 下降；`LLEN bull:<q>:active` 合理；`ZCARD bull:<q>:failed` 不增长 | 任务持续完成 |
| 任务结果 | `bull:<q>:<jobId>` hash 的 `finishedOn`/`returnvalue`；MySQL `TaskLog`；Mongo `tasklogs` | 结果写入完整、无重复副作用 |
| 爬取专属 | `bull:crawl4ai:meta` 的 `concurrency`；`bull:crawl4ai:limiter`；`crawl:worker-concurrency:v1` 广播 | 并发数与设置一致；无内存压力冷却循环 |

**回退（含排空）：**
1. 先把 `api-go` 侧改回 `legacy` 并重启（停止领取新任务）；**不要**先改 api。
2. 等待 `bull:<q>:active` 归零或达到可接受窗口（爬取最长 30 分钟；如无法等待，记录 in-flight jobId，交由 Nest 的 stalled 恢复接管，不 flush 队列）。
3. 再把 `api` 侧改回 `legacy` 并重启；Nest 重新创建 Worker，继续消费同一队列。
4. 观察 failed 不增加。
耗时估计：普通队列 2–6 分钟；爬取队列 5–30 分钟（取决于 in-flight）。数据风险：任务可能被重试一次（BullMQ 至少一次语义），业务需幂等；**禁止** `DEL bull:<q>:*` 或 flushall。

#### 4E：队列运维控制台与按组织的队列计数（`refactor/go-queue-ops`）

**目标：** 停掉 Nest 之后队列仍然可观察、可处置，组织的 itemPipeline 计数不再失真。两个开关互不依赖，都放在阶段 4 是因为它们替代的运维面（Bull Board、`QueueOrgStatsTracker`）在 Nest 停用后才会消失。

##### 4E-1 `API_GO_QUEUE_OPS_MODE`（队列运维 REST + Web 控制台）

- **是什么**：api-go 新增的 Go 独有接口 `/api/admin/queue-ops/*`（12 条：队列列表与计数、按状态分页 job、job 详情、重试/删除/提升单个 job、批量重试某队列 failed、按状态清理、暂停/恢复队列、itemPipelineDlq 重放与删除）与 `apps/web` 的 `admin/ops/queue-ops` 页面。Nest 从来没有这些路由。
- **鉴权**：登录 + `queue.manage` + 平台管理员。**这是相对 Bull Board 的有意收紧**：Bull Board 只校验组织级 `queue.manage`（`apps/api/src/modules/queue/bull-board-auth.middleware.ts:22-60`），而该权限是组织级 manager 的默认权限（`packages/config/src/rbac.ts:94`），所以任何组织的 manager 都能看到全部租户的 job 数据。Go 控制台要求平台管理员，平台管理员判定复用 `internal/platformgovernance`。
- **启用【未执行】**：
  1. 设 `API_GO_QUEUE_OPS_MODE=go` 并重启 `api-go`（Nest 不读该值，不需要重启 `api`）。
  2. 用一个**平台管理员并且拥有 `queue.manage`** 的账号打开 `/admin/ops/queue-ops`；入口只在满足条件时显示。
  3. 验证：队列列表能列出 `bullmqcleanup` 全量清单（含 Bull Board 没有注册的队列与 `itemPipelineDlq`）；计数与 `redis-cli` 的 `LLEN/ZCARD bull:<q>:*` 一致；暂停/恢复/重试/删除各做一次并检查 `AuditLog`（`resource="queue"`，action `job_retry`/`job_delete`/`job_promote`/`queue_retry_failed`/`queue_clean`/`queue_pause`/`queue_resume`/`dlq_replay`/`dlq_delete`）。
  4. 页面若显示「队列运维需要 api-go 的 API_GO_QUEUE_OPS_MODE=go」，说明请求落到了 Nest 并返回 404，即开关仍为 `legacy` 或请求没经过 api-go。
- **注意**：`crawl4ai`、`crawl4ai-hot`、`crawl4ai-normal` 三队列的暂停/恢复在本控制台**被拒绝**（HTTP 409），必须继续使用专用接口 `/api/admin/crawl4ai/queue/pause|resume` —— 那三个队列的暂停带自适应并发、meta concurrency 与 C2 广播等附加语义，本批不复制。
- **回退**：改回 `legacy` 并重启 `api-go`；页面立刻显示提示而不是报错。已执行的队列状态变更（重试/删除/清理/暂停）与 `AuditLog` 行不回滚。
- **Bull Board**：`/admin/queues` 的代理规则仍归 `refactor/go-ops-entrypoints`，本批不改；Bull Board 模块也不删。

##### 4E-2 `API_GO_QUEUE_ORG_STATS_MODE`（按组织的 itemPipeline 计数）

- **是什么**：把 Nest 的 `QueueOrgStatsTracker`（监听 itemPipeline 的 waiting/delayed/active/completed/failed/removed）迁到 api-go 的 `internal/queueorgstats`。Redis 键名（`queue:itemPipeline:job:<id>:meta`、`queue:itemPipeline:org:<orgId>:counts`）、字段、TTL（7 天 / 30 天）与三段 Lua 与 Nest 完全一致，dashboard 与 GraphQL 读取方不需要改动。
- **单一所有者**：事件流是 XREAD（不是消费组，每个实例都会收到每条事件），所以 Go 侧用 Redis 租约 `lock:queue:itemPipeline:orgstats` 只让一个实例读取；租约丢失即停止读取，接手者从当前流尾（`$`）继续。相比 Nest 现状（多实例同时 apply，靠 Lua 的相等判断兜底），把「同一状态重复应用」和「滞后实例写回旧状态」的窗口降为单实例无竞争。
- **切换顺序（必须严格）**：
  1. `api` 侧设 `go` 并重启 —— Nest 的 tracker 不再注册那 6 个 QueueEvents 监听。
  2. 确认 Nest 日志无 tracker 错误、`queue-org-stats` 不再出现新事件处理。
  3. `api-go` 侧设 `go` 并重启 —— Go 抢租约并开始读事件流。
- **两步之间会漏记**：从 Nest 停止监听到 Go 拿到租约之间产生的事件不会被任何一侧应用，计数可能短暂偏差。偏差会随 meta（7 天）与 counts（30 天）TTL 自然收敛；偏差不可接受时用下面的校正方法。
- **一次性校正（手工，本批未执行/未验证）**：
  1. 先把 `api-go` 设为 `go` 并确认租约已被 Go 持有（`GET lock:queue:itemPipeline:orgstats` 有值且 `TTL` 在 30 秒内被持续刷新）。
  2. 暂停写入侧（`API_GO_ITEM_PIPELINE_WORKER_MODE` 已在 go 时可直接做；否则先停 Nest 的 itemPipeline worker），让 `bull:itemPipeline:wait` 与 `:active` 不再变化。
  3. 从 `bull:itemPipeline:wait|active|delayed|priorities|completed|failed` 枚举 job id，读每个 job hash 的 `data` 取 `orgId`、按状态归类，然后 `DEL queue:itemPipeline:org:<orgId>:counts` 并用 `HSET queue:itemPipeline:org:<orgId>:counts <status> <n>` 重建，最后 `EXPIRE` 设 30 天。
  4. 恢复写入侧，观察 dashboard 的队列统计与 `bull:itemPipeline:*` 的实时计数是否一致。
  5. 注意：`completed`/`failed` 是历史累计计数器（Nest 也是累计语义），重建值只代表当前保留窗口内的任务数，与累计值不可比；只重建 `waiting`/`active`/`delayed` 往往就够了。
- **回退（反向顺序）**：先把 `api-go` 改回 `legacy` 并重启（释放租约、停止读事件流），再把 `api` 改回 `legacy` 并重启（Nest tracker 重新注册监听）。回退期间的窗口同样会漏记，处置同上。

##### 4E-3 Bull Board 关闭建议

- 若部署里 `BULL_BOARD_ENABLED=true`（默认 `false`，`apps/api/src/modules/config/env.schema.ts:28`），说明 `/admin/queues` 正暴露跨租户的 job 数据与重试/删除操作（B1）。
- 本批完成后建议：**改用 `/admin/ops/queue-ops`，并把 `BULL_BOARD_ENABLED` 设为 `false`**（或至少限制到内网）。Bull Board 本批不删，仍可临时打开排障，但它不再是被迫依赖。
- 关闭 Bull Board 只影响 `/admin/queues` 面板本身；`/admin/queues` 的代理规则仍按现状代理到 Nest。

### 阶段 5：实时推送（3 个开关 + 重建 Web）

**目标：** GraphQL Subscription 与两个独立 Socket.IO 路径由 Go 提供，浏览器改用新路径。

**前置：**
- `GRAPHQL_SUBSCRIPTION_BUS=redis`（`config.go:4213`）。
- `WS_REDIS_ADAPTER_ENABLED=true`（`config.go:6008`）；`WS_REDIS_ADAPTER_KEY=socket.io` 两侧一致。
- 阶段 2D 的登录写路径已稳定（浏览器需要真实会话）。

**执行步骤【未在本批执行】：**
1. `api` 与 `api-go` 同时设 `API_GO_GRAPHQL_SUBSCRIPTIONS_MODE=go`、`API_GO_NOTIFICATIONS_SOCKET_MODE=go`、`API_GO_REALTIME_SOCKET_MODE=go`（附录 A.1：Nest 同读后两个）。
2. 重启 `api`，再重启 `api-go`。
3. 验证 Go 端点直接可用：
   ```bash
   # Engine.IO 握手（polling）
   curl -i 'http://127.0.0.1:4020/socket.io-notifications/?EIO=4&transport=polling'
   curl -i 'http://127.0.0.1:4020/socket.io-realtime/?EIO=4&transport=polling'
   # GraphQL WS upgrade 由 Go 处理（connection_init 需要真实 token）
   ```
   日志：`api-go: notifications Socket.IO transport under go (...)`（`main.go:2690`）、`api-go: realtime Socket.IO transport under go (...)`（`main.go:2707`）、`api-go: GraphQL subscriptions under go (...)`（`main.go:2660`）。
4. **重建 Web**：`.env` 设 `NEXT_PUBLIC_NOTIFICATIONS_SOCKET_PATH=/socket.io-notifications`、`NEXT_PUBLIC_REALTIME_SOCKET_PATH=/socket.io-realtime`；`cutover_compose --profile api-go-pilot build web && cutover_compose up -d web`。**只重启不重建无效**（构建期内联，`infra/docker/runtime.Dockerfile:29-32`）。
5. 浏览器验证：DevTools → Network → WS，连接路径应为 `/socket.io-notifications` 与 `/socket.io-realtime`；通知、队列事件、态势事件能实时到达；服务端日志无 split-brain（Nest 仍可能发 relay，但不应再直接推浏览器）。
6. **阶段 5 完成判据（与 6a 联动）：** 所有浏览器/客户端都不再连 `/socket.io`。只要 Nest 还在运行且 `/socket.io` 仍有活跃 Web 连接，阶段 5 就不算完成，更不能进入 6b。检查方法：在 Redis `CLIENT LIST` 中看 `/socket.io` 相关连接/Engine.IO 会话，或在网关/ingress 侧看 `/socket.io` 的握手计数；Nest 侧 WebSocket gateway 的活跃连接数也应归零。

**回退（顺序很重要）：**
1. 先把 Web 构建参数改回 `/socket.io` 并**重建 web**（浏览器回到 Nest 传输；此时 api-go 的 `/socket.io/` 是 legacy 代理，仍可用）。
2. 验证浏览器实时功能恢复。
3. 再把 `API_GO_*_SOCKET_MODE` 与 `API_GO_GRAPHQL_SUBSCRIPTIONS_MODE` 改回 `legacy`，重启 api-go 与 api。
耗时：重建 5–15 分钟 + 重启 2–4 分钟（未实测）。数据风险：实时消息可能丢失少量（best-effort，不重放）；数据库持久化不受影响。

### 阶段 6：停 Nest 收尾（6a / 6b / 6c）

> **实施基线：`refactor/go-ops-entrypoints`（origin/main `ed436ead` 之后）。** C-1/C-5/C-7/C-9 已由本批四个开关关闭（`API_GO_HEALTHZ_LIVE_MODE`、`API_GO_VECTOR_DIAGNOSTICS_MODE`、`API_GO_DOCS_MODE`、`API_GO_LEGACY_FALLBACK_MODE`），阶段 6 不再被这四项阻塞。仍阻塞 6c 的是其它窗口的 C 类：C-2…C-4（crawl-frontier 三条写 HTTP）与 C-8（`/admin/queues`）。以下步骤是操作手册，**本批未在部署环境执行、未启动任何服务、未切换任何开关**。

#### 6a. 停业务流量（可在本批合入后执行）

1. **开关状态：** 阶段 1–5 的全部业务开关均为 `go`；`API_GO_HEALTHZ_MODE=go`；建议同时 `API_GO_VECTOR_DIAGNOSTICS_MODE=go`（只读诊断，无写入、无队列副作用）。
2. **Nest 仍运行：** 不停止 `api` 容器。它的 worker/cron/subscription 已由阶段 3–5 的开关让位，但仍保留 C-2…C-4、C-6、C-8 的入口（C-1/C-5/C-7/C-9 现已可由 Go 接管）。
3. **验证：**
   - `sum(increase(api_go_legacy_proxy_requests_total{route_prefix!="/api/healthz",route_prefix!="/docs",route_prefix!="/admin"}[24h])) == 0` 且连续 72 小时（§4.1）。
   - 认证版 `/api/healthz` 由 Go 响应；公开 `/api/healthz/live` 仍 `shadow`（默认），这是预期，6b 再切。
   - 浏览器 WS 路径已是 `/socket.io-notifications` / `/socket.io-realtime`（阶段 5 收尾条件）。
4. **回退：** 按 §7 逐批回退；6a 本身没有数据变更，回退只改开关并重启 api-go。

#### 6b. 把 Go 运维入口切到 go，并把 legacy 回落切到 reject

> 前置：6a 完成；本批代码已部署到 `api-go`（含 `internal/nestnotfound`、`internal/apidocs`、`internal/vectorclient.Health`）。四个开关都只被 `api-go` 读取，Nest 不读，切换不需要双侧同步。

**步骤 1：`API_GO_HEALTHZ_LIVE_MODE=go`**

- 操作：设置后重启 api-go。compose 的 api healthcheck 与 Web 启动等待此时仍打 `http://api:4000/api/healthz/live`（Nest）——**先不要停 Nest**，两边都可用。
- 验证：`curl -fsS http://127.0.0.1:4020/api/healthz/live` → `200`，响应体与 Nest 一致（`{"status":"ok"}`）；Nest 访问日志不再出现该路径；`/__go/healthz` 的 routes 中该规则为 `go`。若仍出现 Nest 日志，检查 `API_GO_HEALTHZ_LIVE_MODE` 拼写、进程是否重启、规则是否被其他 exact 规则遮蔽。
- 回退：改回 `shadow` 重启 api-go，立即恢复「Nest 应答 + Go 差分」。
- 说明：这是唯一默认 `shadow`（而非 `legacy`）的开关，原因见 `config.go` 的 `HealthzLiveMode` 注释；不要把 `shadow` 写成 `legacy` 来回退。

**步骤 2：`API_GO_DOCS_MODE=go`**

- 操作：设置后重启 api-go。是否实际提供文档仍由 `SWAGGER_ENABLED` 决定（未设置时 `NODE_ENV=production` 为 false、否则 true；显式 false 时 `/docs*` 一律返回与 C-9 相同的 404）。注意：compose 的 api-go 服务当前**没有注入** `SWAGGER_ENABLED` 且把 `NODE_ENV` 写死为 `production`，所以只设置 `API_GO_DOCS_MODE=go` 会得到「404 的 /docs」；停 Nest 后要真正提供文档，必须同时给 api-go 注入 `SWAGGER_ENABLED=true`（属部署 env/override 改动，不在本批代码内）。
- 验证：`curl -fsS http://127.0.0.1:4020/docs` 返回 Swagger UI HTML；`curl -fsS http://127.0.0.1:4020/docs/json > /tmp/openapi.json` 后与 `apps/api/tests/contract/openapi.snapshot.json` 做 `sha256sum` 对比（应逐字节一致）；`swagger-ui.css` / `swagger-ui-bundle.js` / `swagger-ui-standalone-preset.js` / `/docs/swagger-ui-init.js` 返回 200；`/docs/nope` 与 `/docs/LICENSE` 返回 404。
- 回退：改回 `legacy` 重启 api-go（`/docs` 重新代理 Nest，需 Nest 仍在运行）。
- 已知差异：Nest 默认还提供 `/docs-yaml`（YAML 序列化）；本批只提供 `/docs/json`，reject 后 `/docs-yaml` 返回 404。

**步骤 3：`API_GO_LEGACY_FALLBACK_MODE=reject`**

- **前置校验：** `config.Load` 用反射要求所有以 `Mode` 结尾的字段为 `go`（唯一豁免是本开关自身）；任一开关不是 `go`，api-go **启动失败**并列出不满足的开关名。因此先把阶段 1–5 与本批三个入口开关全部置 `go`。
- 操作：设置后重启 api-go。`LEGACY_API_URL` 可以留空（空值仍按历史默认填充，但 reject 不建立任何上游连接）。
- 验证：
  - `curl -i http://127.0.0.1:4020/admin/queues` → `404`；body 字段顺序 `statusCode/message/error/traceId/path/timestamp`；`message=Cannot GET /admin/queues`；响应头含 `x-trace-id`。
  - `curl -i 'http://127.0.0.1:4020/unknown?x=1'` → 404，且 body 的 `path` 与 `message` 都包含 `?x=1`。
  - `curl -i -X OPTIONS -H 'Origin: http://console.example' -H 'Access-Control-Request-Method: GET' http://127.0.0.1:4020/unknown` → `204`（CORS 预检先应答，与 Nest 的 cors 中间件顺序一致）；不带预检头的 OPTIONS → `404`。
  - `api_go_legacy_proxy_requests_total` 不再增长；`api_go_legacy_rejected_requests_total{route_prefix}` 开始按 `/admin`、`/`、`/api` 等标签增长——用它确认停 Nest 后还有哪些旧入口在被访问。目标：业务前缀为 0，只剩已记录的 C 类前缀。
  - 回退演练：在演练环境把任一开关改成 `legacy` 后重启，应启动失败并在错误中列出该开关名，确认校验生效。
- 回退：改回 `proxy` 重启 api-go，**前提是 Nest 仍在运行**；reject 期间被拒绝的请求不会补发或 drain。
- 注意：reject 模式下 shadow 规则无法成立（没有 Nest 响应）。本批的启动校验要求所有 `*Mode` 为 `go`，因此不会出现 shadow + reject 组合；即使手工绕过校验，shadow 规则也会经 `proxyLegacy` 返回 404（单一出口的预期行为）。

#### 6c. 停 Nest 进程（待剩余 C 类关闭后执行）

> 前置：6a、6b 完成并稳定运行 ≥72 小时；C-2…C-4（crawl-frontier 写）与 C-8（`/admin/queues`）已有书面处理决定（保留边车 / 迁移 / 下线）。**本批不解除这两组阻塞，也不修改 `docker-compose.yml`。**

1. **编排依赖改法（部署环境 override，不入库）：**
   - api 服务 healthcheck：从 `http://localhost:4000/api/healthz/live`（`docker-compose.yml:665`）改为 `http://api-go:4020/api/healthz/live`（依赖 6b 步骤 1 的 go 模式）或 Go 内部端点 `http://api-go:4020/__go/healthz`；前者与 Web/探针语义一致，后者不经过路由表。
   - web 启动等待（`docker-compose.yml:1714-1724`）：把 `API_BASE_URL` 指向 `http://api-go:4020`，等待地址改为 `${API_BASE_URL}/api/healthz/live`（go 模式）或 `/__go/healthz`；`depends_on: api: service_healthy` 必须删除或改为 api-go。
   - 若使用 compose v2.24+：用 `!reset []` 覆盖 `depends_on`；否则 `docker compose up -d --no-deps web api-go` 跳过依赖检查。旧的 override 片段示例见 `ownership-audit.md` §6.9 与 §3.6（本批未创建文件、未执行）。
2. **停进程：** `docker compose stop api`（或按 C-2/C-8 决定只保留只读边车）。
3. **验证：**
   - `curl -fsS http://api-go:4020/api/healthz/live` 200；`/docs`、`/docs/json` 正常；认证版 `/api/healthz` 正常。
   - `api_go_legacy_rejected_requests_total` 的业务前缀为 0；停 Nest 后不应出现新的业务前缀。
   - Web 页面、SSE、两个 Socket.IO 路径、登录与 GraphQL 读写抽查（见 §5）。
4. **回退：** 重启 `api` 容器 + 把 `API_GO_LEGACY_FALLBACK_MODE` 改回 `proxy` 重启 api-go（顺序：先恢复 Nest，再放开 reject）。
5. **`/socket.io` 旧客户端提醒：** 阶段 5 之后仍可能有旧标签页/未刷新浏览器连默认 `/socket.io`。`socket.io-client@4.8.1` 默认 `reconnection: true`、`reconnectionAttempts: Infinity`、`reconnectionDelay: 1000`、`reconnectionDelayMax: 5000`（`apps/web` 只有 situation-monitor 覆盖为 8 次 / 10 秒）。停 Nest 后这些客户端会以 ≤5 秒的抖动间隔**持续**收到 404 并重连，形成稳定的低速率 `/socket.io` 拒绝流量，不会自愈。建议：6c 前完成阶段 5 的 Web 重建并强制用户刷新；停 Nest 后观察 `api_go_legacy_rejected_requests_total{route_prefix="/socket.io"}`，长期非 0 说明仍有旧客户端，需在 ingress 层提示或等待其自然退出。

---

## 4. 停掉 Nest 的判定条件

> 本节是「允许停 Nest」的**必要条件**，不是执行步骤。H2/H3 未解决前，即使全部条件成立也不能停（§3.6）。

### 4.1 代理到 `LEGACY_API_URL` 的请求数为 0，且持续足够长

**指标（`refactor/go-ops-entrypoints` 之后有两组；未部署、未运行、未验证）：**
- `api_go_legacy_proxy_requests_total{route_prefix}`：真正代理到 NestJS 的请求。
- `api_go_legacy_rejected_requests_total{route_prefix}`：`API_GO_LEGACY_FALLBACK_MODE=reject` 下被 Go 直接拒绝（Nest 等价 404）的请求，标签函数与上者相同。**6b 切到 reject 后，代理计数恒为 0，本条判据改用 rejected 计数。**
- 类型：counter；所有转发到 NestJS 的出口都统一走 `legacyproxy.Gateway.proxyLegacy` 并 +1（`apps/api-go/internal/legacyproxy/proxy.go` 的 `proxyLegacy`；`ServeHTTPWithShadow` 的 legacy/canary 回落、`serveShadow` 的 shadow 代理、`ServeLegacy` 都调用它）。
- 标签 `route_prefix` 的实际取值（`legacyRoutePrefix`，已由 Lead 的测试 `apps/api-go/internal/legacyproxy/cutover_legacy_metric_test.go` 固定）：`/api/<第一段>`（如 `/api/auth`、`/api/items`、`/api/dashboard`、`/api/crawl`、`/api/system-settings`、`/api/healthz`）、`/graphql`、`/socket.io`、`/docs`、`/admin`、`/api`、`/`。**不是完整 path**，所以不要用 `/api/healthz/live` 或 `/admin/queues` 过滤。
- 为什么必须新增：在此之前 `legacyproxy` 包没有任何日志/指标（代理构造见 `proxy.go:482-507`，仅 `ErrorHandler` 返回 502 JSON）；没有它就无法量化回落。现在这个 counter 是 §4.1 判据的唯一直接数据源。
- 重要语义：shadow 规则（含默认 shadow 的 `/api/healthz/live`）也走 `proxyLegacy`，因此 **也会计数**；6b 之前 live 仍是 shadow，所以 `/api/healthz` 前缀必然非 0，必须显式排除。6b 之后 live 走 Go handler，该前缀的代理计数应归零；reject 模式下被拒绝的 live 也不会出现，因为 exact GET 由 Go 接管。

**PromQL 示例：**

```promql
# 按前缀看当前回落速率（5 分钟）
sum by (route_prefix) (rate(api_go_legacy_proxy_requests_total[5m]))

# 全局回落速率（排除已知 C 类/结构性 shadow：live 的 /api/healthz、/docs、/admin）
sum(rate(api_go_legacy_proxy_requests_total{
  route_prefix!="/api/healthz", route_prefix!="/docs", route_prefix!="/admin"
}[5m]))

# 24 小时内是否还有任何回落（停 Nest 的核心判据）
sum(increase(api_go_legacy_proxy_requests_total{
  route_prefix!="/api/healthz", route_prefix!="/docs", route_prefix!="/admin"
}[24h]))

# 按业务周期看（72 小时）
sum(increase(api_go_legacy_proxy_requests_total{
  route_prefix!="/api/healthz", route_prefix!="/docs", route_prefix!="/admin"
}[72h]))
```

**阈值与持续时长建议：**
- **最低 24 小时**：覆盖每日摘要（每天一次）、夜间爬取/入库、每小时情绪快照、6 小时指标关联。
- **推荐 72 小时**：覆盖完整业务周期 + 一个周末/跨时区调度差异，降低「恰好没流量所以是 0」的误判。
- **判据（6b 之前）：** 上面的 72 小时 `increase == 0`，且 5 分钟 `rate` 在观察窗口内每个采样点都为 0；同时 `api_go_legacy_proxy_requests_total{route_prefix="/api/healthz"}` 仍有值（说明 live shadow 探针仍在工作，证明代理链路没有被误关）。
- **判据（6b 切 reject 之后）：** 改用 `api_go_legacy_rejected_requests_total`。要求除已书面保留的 C 类前缀（`/admin`、`/socket.io` 旧客户端等）外，72 小时 `increase == 0`；同时 `api_go_legacy_proxy_requests_total` 全域为 0（reject 不再代理，出现非 0 说明仍有 Go handler 主动调用 `ServeLegacy` 的路径，需查明）。
- **必须注意的前缀（C-1/C-7 已关闭，但 6b 之前仍有结构性流量）：**
  - `/api/healthz`：6b 之前 `/api/healthz/live` 仍 shadow（默认），与认证版共享同一标签；6b 之后应由 Go 回答，代理计数归零。
  - `/docs`：6b 之前只有 Nest 提供；6b 之后由 Go 提供，代理计数归零。
  - `/admin`：Bull Board `/admin/queues`（C-8，队列运维窗口）；reject 后该前缀会出现在 rejected 计数中，直到 C-8 有决定。注意 `/api/admin/*` 走 `/api/admin` 标签，不在此列。
- **按前缀的期望（6a 结束时）：** 除上述三个前缀外，其余 `/api/*`、`/graphql`、`/socket.io` 都应为 0；三个前缀属于尚未关闭的 C 类或本批待切入口，必须有 §4.2 的书面处理决定。

**业务周期证据（用于解释 24/72 小时）：**

| 周期 | 任务 | 证据 |
|---|---|---|
| 1 分钟 | 新闻源调度、实时信号采集、摘要投递 tick、outbox 重放 | `docker-compose.yml:476`、`480`、`558-559`、`593-594`；`docs/refactor/go-digest-delivery.md:30` |
| 5 分钟 | 新闻事件入库、processed_item 补偿、分类质检告警评估 | `docker-compose.yml:483`、`503-507`、`451` |
| 10 分钟 | 新闻事件时间线重建 | `docker-compose.yml:586-592` |
| 15 分钟 | GDELT 快照重建 | `apps/api-go/internal/config/config.go:2677`；`internal/gdeltsnapshot/model.go:12-13` |
| 1 小时 | 情绪快照重建、BullMQ 保留清理 | `docker-compose.yml:586-592`、`1135` |
| 6 小时 | 新闻—指标关联刷新 | `docker-compose.yml:515-517`（注释：6 小时 cron） |
| 每天 | 用户摘要投递、审计日志保留、采集维护 | `docker-compose.yml:475-479`、`578-579`；`docs/refactor/go-digest-delivery.md:3-4` |

### 4.2 C 类项已有处理决定

C 类 = 只能由 Nest 提供、Go 没有等价实现的入口/能力。**本批审计（`ownership-audit.md` §0.2）确认 C-1–C-9，其中 C-2/C-3/C-4 已由 `refactor/go-crawl-frontier-writes` 关闭**；其余每一项都必须由用户选定「保留 / 迁移 / 下线」并签字，未签字不得停 Nest。

| 编号（审计 §0.2） | C 类项 | 为什么是 C / 证据 | 选项（必须选一个并记录） |
|---|---|---|---|
| C-1 | `GET /api/healthz/live` | **已关闭**：`API_GO_HEALTHZ_LIVE_MODE`（默认 shadow，可 legacy/go）+ `WithHealthzLive` exact GET 规则；6b 步骤 1 | ①已实现（本批）；②无需直接改 ModeGo；③保留 `/__go/healthz` 作为备选探针 |
| C-2 | `POST /api/admin/crawl-frontier/runs` | 已迁移（`refactor/go-crawl-frontier-writes`）：`WithCrawlFrontierWrites` exact POST 规则 + `crawl.write` + `API_GO_CRAWL_FRONTIER_WRITES_MODE` | —（已在 refactor/go-crawl-frontier-writes 关闭，无需决策） |
| C-3 | `POST /api/admin/crawl-frontier/nodes/retry` | 已迁移（同上）：exact POST 规则 + handler（`internal/crawlfrontierruns/`） | —（已在 refactor/go-crawl-frontier-writes 关闭，无需决策） |
| C-4 | `POST /api/admin/crawl-frontier/nodes/:id/retry` | 已迁移（同上）：动态段 exact POST 规则 + handler | —（已在 refactor/go-crawl-frontier-writes 关闭，无需决策） |
| C-5 | `GET /api/system-settings/vector-service/diagnostics` | **已关闭**：`API_GO_VECTOR_DIAGNOSTICS_MODE`（默认 legacy）+ 进程级共享 `vectorclient.Health`；鉴权为登录 + `settings.manage` | ①已实现（本批）；②无需下线；③不需要 Nest 边车 |
| C-6 | `itemPipelineDlq` 无消费者 | Nest 与 Go 都只生产；唯一人工入口是 Nest Bull Board（`ownership-audit.md` §5 的 1.1 主表与「4. 真实缺口」） | ①保留 Nest Bull Board 只读运维面；②后续给 Go 增加只读 DLQ 列表/重放端点；③文档化 Redis 手工处理并接受无 UI |
| C-7 | Swagger `/docs` | **已关闭**：`API_GO_DOCS_MODE`（默认 legacy）；go 时嵌入 OpenAPI 快照 + swagger-ui-dist 5.29.4 资源，`SWAGGER_ENABLED` 决定是否提供 | ①已实现（本批，保留 `/docs/json`）；②不需要独立文档站；③生产仍可用 `SWAGGER_ENABLED=false` 关闭 |
| C-8 | Bull Board `/admin/queues` | 只有 Nest 提供（`legacyproxy/proxy.go:147`） | ①保留 Nest 只读旁路；②外部 Bull Board/队列监控；③Redis/CLI 运维并下线页面 |
| C-9 | 根路径与未匹配 404 | **已关闭**：`API_GO_LEGACY_FALLBACK_MODE`（默认 proxy，可 reject）；reject 时 Go 返回 Nest 等价 404 并记录异常事件 | ①已实现（本批）；②不再需要接受 502；③不需要 ingress catch-all |

**判定：**
- C-1/C-5/C-7/C-9 已由 `refactor/go-ops-entrypoints` 关闭，C-2–C-4 已由 `refactor/go-crawl-frontier-writes` 迁入 Go 并关闭，均不再是 6b/6c 的阻塞项；6b 的步骤 1–3 是它们的切换与回退手册。
- 若 C-6/C-8 选「保留 Nest 旁路」，则 Nest 进程不能完全停止——只能停业务流量与后台职责（worker/cron/subscription），保留 `/admin/queues` 与 DLQ 人工入口。
- 剩余阻塞只有 C-6（`itemPipelineDlq` 人工入口）与 C-8（`/admin/queues`）；**没有书面决定 = 不能进入 6c（停 Nest 进程）。** 6a/6b 不受此限。

### 4.3 所有 BullMQ 队列只有 Go 在消费

**队列与 owner 对照（真实队列名来自 Go 常量）：**

| 队列 | Go owner 开关 | 证据 |
|---|---|---|
| `itemPipeline`（DLQ `itemPipelineDlq` 无消费者，见 C-6） | `API_GO_ITEM_PIPELINE_WORKER_MODE` | `internal/itempipeline/protocol.go:38-40` |
| `crawl4ai`、`crawl4ai-hot`、`crawl4ai-normal` | `API_GO_CRAWL_WORKER_MODE` | `internal/crawlqueue/model.go`（`QueueHot/QueueNormal/QueueLegacy`）、`internal/crawlworker/doc.go:29` |
| `frontier-llm-judge`、`frontier-llm-learn` | `API_GO_CRAWL_FRONTIER_LLM_WORKER_MODE` | `internal/crawlfrontierllm/protocol.go:43-44` |
| `analysis` | `API_GO_ANALYSIS_WORKER_MODE` | `internal/analysisqueue/protocol.go:39-40` |
| `assistant` | `API_GO_ASSISTANT_WORKER_MODE` | `internal/assistantqueue/types.go:20` |
| `alerts` | `API_GO_ALERT_WORKER_MODE` | `internal/alertqueue/queue.go:56` |
| `akshare-data` | `API_GO_ECONOMIC_DATA_WORKER_MODE` | `internal/economicqueue/job.go:10` |
| `archivePreparation` | `API_GO_ARCHIVE_PREPARATION_WORKER_MODE` | `internal/archivepreparationworker/protocol.go:34` |
| `classification_quality` | `API_GO_CLASSIFICATION_QUALITY_WORKER_MODE` | `internal/qualityqueue/keys.go:7` |
| `news_event_clustering_recovery` | `API_GO_NEWS_CLUSTERING_RECOVERY_WORKER_MODE` | `internal/clusteringrecoveryqueue/protocol.go:41` |
| `situationMonitorSignals` | `API_GO_SITUATION_SIGNALS_WORKER_MODE` | `internal/situationsignalsworker/job.go:9` |

**判定方法（三步，全部【未在本批执行】）：**

**步骤 1：拿到两个容器的 IP。**

```bash
docker inspect -f '{{.Name}} {{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
  $(docker compose ps -q api) \
  $(docker compose --profile api-go-pilot ps -q api-go)
# 输出示例：/newwei-api-1 172.18.0.5   /newwei-api-go-1 172.18.0.7（示例，非真实）
```

**步骤 2：在 Redis 里看谁持有 BullMQ 的阻塞连接。**

BullMQ worker 的取任务连接会阻塞在 `wait`/`delayed` 上，`CLIENT LIST` 里表现为 `flags=b` 且 `cmd` 为 `brpoplpush`、`blmove` 或 `bzpopmin`。用 `addr=` 的 IP 区分进程：

```bash
docker compose exec -T redis sh -c 'redis-cli -a "$REDIS_PASSWORD" CLIENT LIST' \
  | grep -E 'cmd=(brpoplpush|blmove|bzpopmin)' \
  | grep -E 'addr=<api-go-IP>|<api-IP>'   # 用步骤 1 的 IP 替换
```

**通过判据：** 所有 BullMQ 阻塞连接的 `addr` 都来自 **api-go 容器 IP**；api 容器 IP 没有任何 `cmd=brpoplpush|blmove|bzpopmin` 连接。连续观察至少 24 小时、每天至少 3 个采样点。

**步骤 3：队列水位与 owner 证据交叉验证。**

```bash
for q in itemPipeline crawl4ai crawl4ai-hot crawl4ai-normal frontier-llm-judge frontier-llm-learn \
         analysis assistant alerts akshare-data archivePreparation classification_quality \
         news_event_clustering_recovery situationMonitorSignals; do
  echo "== $q"
  redis-cli -a "$REDIS_PASSWORD" LLEN "bull:$q:wait"
  redis-cli -a "$REDIS_PASSWORD" LLEN "bull:$q:active"
  redis-cli -a "$REDIS_PASSWORD" ZCARD "bull:$q:delayed"
  redis-cli -a "$REDIS_PASSWORD" ZCARD "bull:$q:failed"
  redis-cli -a "$REDIS_PASSWORD" HGETALL "bull:$q:meta"
done
```

- `bull:<queue>:meta` 的 `concurrency` 会被 Go 的爬取 worker 写入（`internal/crawlworker/doc.go:29`），可作为「Go 已接管」的辅助证据，但 Nest 也可能写，不能单独作为判据。
- 判定以 **步骤 2 的连接来源 IP** 为准；步骤 3 用于发现「队列没人消费」或「failed 增长」。
- Nest 侧日志可作交叉证据：`Skipped item pipeline worker because Go owns the consumer`（`apps/api/src/modules/queue/queue.processor.ts:102`）、`alerts queue ownership moved to api-go`（`apps/api/src/modules/alerts/alerts.processor.ts:39`）、`Assistant worker runs in api-go`（`apps/api/src/modules/assistant/assistant.processor.ts:40`）、`Skipped archive preparation worker...`（`apps/api/src/modules/archive/archive-preparation.processor.ts:47`）。**日志只证明 Nest 不创建 worker，不能证明 Go 在消费**，两者都要看。
- 注意：`bull:<queue>:events` 是 Redis Stream（`internal/realtimeevents/queues.go:34`），不是消费证据；不要用 `XLEN` 判断 owner。

### 4.4 其它门槛与签字

1. 连续 72 小时：5xx 比例不高于切流前基线；登录成功率、摘要送达率、爬取成功率无下降。
2. 所有队列 `failed` 无持续增长；`wait` 无持续积压。
3. 已完成一次「演练回退」：把最后一阶段改回 legacy，确认 10 分钟内恢复，再切回 go。
4. §5 的 12 项真实外部验证全部通过并有记录。
5. **阶段 5 收尾：** 浏览器/客户端不再连接 `/socket.io`（Nest 传输）；Web 使用 `/socket.io-notifications` 与 `/socket.io-realtime`；只要 Nest 还在跑且 `/socket.io` 仍有活跃 Web 连接，就不能算完成阶段 5（详见 §3 阶段 6a）。
6. `ownership-audit.md` 的 C-1、C-5–C-9 决定（C-2/C-3/C-4 已关闭）、`switch-matrix.md` 的阶段状态、本手册的回退记录三者齐备，变更负责人/业务验收人/决策人签字。

---

## 5. 需要用户在部署环境亲自完成的真实验证清单

> **本批未执行以下任何一项验证，也没有把任何一项写成「通过」。** 每项都需要真实账号、真实外部服务或真实浏览器；操作人必须回填时间、结果、证据（截图/日志/邮件 ID）。

| # | 验证项 | 操作步骤 | 成功判据 | 失败/回退 |
|---:|---|---|---|---|
| 1 | Telegram 登录与轮询 | 配置 `SITUATION_MONITOR_TELEGRAM_ENABLED=true`、`..._API_ID`、`..._API_HASH`；在设置页完成 Telegram 登录；把 `API_GO_SITUATION_SIGNALS_WORKER_MODE=go` 设到 api 与 api-go；重启；观察 5 分钟 | 设置页显示已登录；态势页 `telegram-feed` 有消息；Redis 租约键存在且 TTL 合理；Nest 日志无 `AUTH_KEY_DUPLICATED`；Go 日志 `situationsignalsworker:` 无 `lease lost` | 两侧改回 `legacy` 并重启，Nest 恢复轮询；若已出现 `AUTH_KEY_DUPLICATED`，先停 Go worker，等 Nest 重新持有会话 |
| 2 | SMTP 发信 | 触发登录验证码、邀请/审批邮件、告警邮件、每日摘要各一次（可用测试账号） | 四个场景都真实收到邮件；日志无 `authlogin: login code delivery failed`、`userdigest: notify ... failed`；摘要主题/收件人正确 | 不切 `AUTH_LOGIN`/`IDENTITY_ONBOARDING`/`ALERT_WORKER`/`USER_DIGEST_DELIVERY`；已切的按 §7 回退 |
| 3 | crawl4ai 抓取 | 在采集管理台新建一个真实 RSS/网页任务并执行；观察任务状态 | `CrawlTask` 进入 completed；`CrawlResult`/内容写入；Go 日志无 `crawlexecution: ... failed`；crawl4ai 容器无异常 | 回退 `CRAWL_TASK_WRITE`/`CRAWL_WORKER`/`CRAWL_QUEUE_OPS` 到 legacy；任务留在队列由 Nest 消费 |
| 4 | 对象存储上传 | 上传头像或调用 `POST /api/admin/settings/storage/test`（mode=s3）；再从页面获取签名 URL | 上传 2xx；对象在 MinIO bucket 可见；签名 URL 可下载；诊断返回 `ok:true`（或各步骤明确失败原因） | 回退 `STORAGE_DIAGNOSTICS`/`AVATAR_UPLOAD`/`CRAWL_READ_TELEMETRY`；检查 `S3_*` |
| 5 | LiteLLM 调用 | 触发一次真实模型调用（RSS 翻译、新闻简报、Assistant 任一）；查 `llmrequestlogs` | 返回真实模型结果；Mongo `llmrequestlogs` 有 `feature` 记录；LiteLLM 日志无 401/429 | 回退 `GRAPHQL_RSS_TRANSLATION`/`GRAPHQL_NEWS_EVENT_BRIEF`/`ASSISTANT_WORKER` 等为 legacy；检查 `LITELLM_MASTER_KEY`/`LITELLM_API_KEY` |
| 6 | Oref 警报 | `SITUATION_MONITOR_OREF_ENABLED=true`；保持 `SITUATION_SIGNALS_WORKER_MODE=go`；等待至少一个轮询周期（默认 5 分钟） | 态势页 `oref-alerts`/`oref-history` 有数据；Redis 缓存键更新；无连续 fetch 错误 | 关 `SITUATION_MONITOR_OREF_ENABLED` 或回退信号 worker；不要伪造数据 |
| 7 | AkShare 经济数据 | 配置 `AKSHARE_*`；`API_GO_ECONOMIC_DATA_WORKER_MODE=go`；触发一次手动抓取 | `akshare-data` 队列被消费；`EconomicDataPoint`/fetch config 更新；无持续 failed | 回退 `ECONOMIC_DATA_WORKER_MODE`/`ECONOMIC_DATA_MODE`；检查 akshare healthz |
| 8 | Nominatim 地理编码 | 调用 `GET/PUT /api/system-settings/geo/nominatim` 的测试入口（或触发 war-map news-markers） | 返回坐标；无 429；日志无 `geocoding: nominatim request failed` | 回退 `GEOCODING_MODE`；检查 UA/email 与速率限制 |
| 9 | OpenSky 实时信号 | 配置 `REALTIME_SIGNALS_OPENSKY_*`；`API_GO_REALTIME_SIGNALS_MODE=go`；观察 runtime 状态 | 额度查询正常；有航班数据或明确的空结果；无 token 失败 | 回退 `REALTIME_SIGNALS_MODE` 或关闭 OpenSky；检查 token URL/凭据 |
| 10 | OIDC 登录 | 配置组织 OIDC（IdP、client、redirect URI）；走 start → callback → handoff | 完整登录成功，会话可用；`NEXTAUTH_URL`/`API_BASE_URL` 回调地址与 IdP 配置一致 | 回退 `OIDC_LOGIN_MODE`；恢复 Nest 回调；检查 redirect_uri |
| 11 | BullMQ 跨端互操作 | 在 Nest 侧生产一个任务（如 itemPipeline），由 Go 消费；反向由 Go 生产、Nest 消费（在测试环境切回 legacy） | 两个方向都只完成一次，无重复副作用；job hash 的 `finishedOn`/`returnvalue` 正常；failed 不增长 | 回退对应 worker 开关；检查 BullMQ 协议版本（两端 5.63.2） |
| 12 | 实时推送（浏览器） | 阶段 5 后打开浏览器：通知中心、队列事件、态势事件；DevTools 看 WS 路径 | WS 连接到 `/socket.io-notifications` 与 `/socket.io-realtime`；事件实时到达；刷新后重连正常；无 401/403 | 按 §3.5 回退顺序：先重建 Web 回 `/socket.io`，再把开关改 legacy |

**可选补充（不作为停 Nest 门槛）：** Elasticsearch reindex（`SEARCH_REINDEX`，ES 禁用时 indexed=0）、Qdrant/vector 连通性、WebSocket 多副本 adapter（`WS_REDIS_ADAPTER_ENABLED`）压力测试。

---

## 6. 切流过程中如何观察 legacy 回落

### 6.1 现有手段：本批之前没有直接手段

【静态核对，基线 `dcbe563b`】`apps/api-go/internal/legacyproxy/` 包内没有任何 `log.`/`metrics.` 调用；`Gateway` 只构造 `httputil.ReverseProxy`（`proxy.go:482-507`），除 502 错误 JSON（`proxy.go:493-500`）外不记录请求。`shadow-diff` 日志只覆盖 shadow 规则（`internal/shadow/runner.go:305-308`），不覆盖 legacy 代理。Nest 侧默认也不逐请求打日志。因此：
- 阶段 0–5 期间**无法**用基线日志/指标精确统计「哪些请求回落到 Nest」；
- 能做的只有：对比接口响应、看 Nest 的业务副作用（DB/队列）、看 api-go 是否 5xx、用 §5 的真实业务验证；
- 本批新增的 counter（下节）是后续阶段量化回落的唯一直接来源。

### 6.2 本批新增指标（Lead 已在 worktree 实现）

`api_go_legacy_proxy_requests_total{route_prefix}`（counter）：
- 注册与暴露：`apps/api-go/internal/metrics/families.go` 新增 `legacyProxyRequests` family 与 `RecordLegacyProxyRequest`；随 `/api/metrics` 输出（`API_GO_METRICS_MODE=go` 时由 Go handler 输出）。
- 记录点：`apps/api-go/internal/legacyproxy/proxy.go` 新增 `proxyLegacy`/`legacyRoutePrefix`；所有转发到 NestJS 的出口（`ServeLegacy`、`ServeHTTPWithShadow` 的 legacy/canary 回落、`serveShadow` 的代理分支）统一计数。
- 标签：`route_prefix` = `/api/<第一段>`、`/graphql`、`/socket.io`、`/docs`、`/admin`、`/api`、`/`（由 `legacyRoutePrefix` 收敛，测试 `apps/api-go/internal/legacyproxy/cutover_legacy_metric_test.go` 固定了这些值）。
- 语义：shadow 规则产生的「Nest 响应 + Go 差分」也计入（`/api/healthz/live` 会计入 `/api/healthz`）；Go 直接处理的请求不计入。
- 不记录 query、header、body、token；基数只受顶层路由族限制。
- 可选增强（未实现）：`api_go_legacy_proxy_duration_seconds` histogram，用于发现回落的慢请求。
- **状态：本批已写代码并提交（未运行 `go test`、未部署、未验证）。** 指标名/标签如与最终实现不同，以代码为准并同步 `switch-matrix.md`。

`api_go_legacy_rejected_requests_total{route_prefix}`（counter，`refactor/go-ops-entrypoints` 新增）：
- 注册与暴露：`apps/api-go/internal/metrics/families.go` 的 `legacyRejectedRequests` family 与 `RecordLegacyRejectedRequest`；与代理计数同一 `route_prefix` 标签函数。
- 记录点：`legacyproxy.Gateway.proxyLegacy` 的 reject 分支（`API_GO_LEGACY_FALLBACK_MODE=reject`），覆盖 ModeLegacy 规则、未匹配路径、`/api/` 兜底、canary 回落与 handler 主动调用的 `ServeLegacy`。
- 用途：6b 切 reject 后，代理计数恒为 0；本 counter 是「停 Nest 后还有哪些旧入口在被访问」的唯一直接来源。

### 6.3 操作顺序与阈值建议

| 时点 | 操作 | 观察/阈值 |
|---|---|---|
| 阶段 0 前 | 部署指标；记录 30 分钟基线 | 基线应接近「全部业务请求」，因为阶段 0 所有请求都经 api-go 代理；记下各前缀速率作为对照 |
| 阶段 0 后 | 观察 30 分钟 | 全局速率与基线同量级；`/api/healthz`（live shadow）稳定有值；Web 入口验证通过 |
| 阶段 1 每批后 | 观察 30 分钟 | 本批接管的前缀速率应显著下降（理想为 0）；未接管前缀不变；若某前缀**上升**，立即回退并排查（可能是子开关依赖或路由匹配问题） |
| 阶段 2–4 每批后 | 同上，至少 30 分钟；阶段 4 观察 1 个业务周期 | 对应前缀为 0；全局回落单调下降；`/graphql` 在 GraphQL 写全部接管后除未注册 operation 外应为 0 |
| 阶段 5 后 | 观察 30 分钟 + 浏览器验证 | `/socket.io` 的 legacy 速率应下降；`/socket.io-notifications`、`/socket.io-realtime` 不计入 legacy（Go 直接处理） |
| 6a 完成前 / 6b 前 | 连续 72 小时 | 除 `/docs`、`/admin`、`/api/healthz` 外全部为 0；见 §4.1 |
| 6b 步骤 1–2 后 | 观察 30 分钟 | `/api/healthz` 与 `/docs` 的代理计数降为 0（改由 Go 回答）；其余不变 |
| 6b 步骤 3（reject）后 | 连续 72 小时 | `api_go_legacy_proxy_requests_total` 全域为 0；`api_go_legacy_rejected_requests_total` 只剩书面保留的 C 类前缀 |

**告警建议（Prometheus）：**

```promql
# 6a/6b 门槛：任何非例外前缀出现回落 → 警告
sum by (route_prefix) (increase(api_go_legacy_proxy_requests_total{
  route_prefix!="/api/healthz",
  route_prefix!="/docs",
  route_prefix!="/admin"
}[1h])) > 0

# 回退/故障快速发现：1 分钟内回落速率突增（相对前 1 小时）
sum(rate(api_go_legacy_proxy_requests_total[1m]))
  > 3 * sum(rate(api_go_legacy_proxy_requests_total[1h] offset 1m))

# 6b reject 后：业务前缀出现拒绝 → 警告（把 <C 类前缀> 替换为书面保留的列表）
sum by (route_prefix) (increase(api_go_legacy_rejected_requests_total{
  route_prefix!="/admin", route_prefix!="/socket.io"
}[1h])) > 0
```

**注意：** 指标代码已在本批落地并提交（未运行测试、未部署）；如果最终命名/标签不同，以代码为准并同步更新本节与 `switch-matrix.md`。**本批没有部署、没有验证该指标。**

---

## 7. 回退速查与数据处置

| 阶段 | 回退动作 | 预期耗时 | 数据风险/处置 |
|---|---|---|---|
| 0 | `API_BASE_URL=http://api:4000`；浏览器入口改回 `http://localhost:4000/api` 并重建 web | 重启 1–2 分钟；重建 5–15 分钟 | 无 |
| 1 | 本批开关改回 `legacy`，重启 api-go | 1–3 分钟 | 无（只读） |
| 2 | 本批开关改回 `legacy`；附录 A.1 的 34 个行为开关先改 api-go 再改 api；重启 | 2–6 分钟 | 已写入的数据不回滚；若格式异常，按业务表人工核对/修复，禁止删除 |
| 3 | 先 api-go 回 legacy，再 api 回 legacy；重启 | 2–6 分钟 | 同一周期可能重复执行一次；确认业务幂等，重复写按业务规则处理 |
| 4 | 先 api-go 回 legacy 停领取；等 `bull:<q>:active` 归零或记录 in-flight；再 api 回 legacy 重启 | 普通队列 2–6 分钟；爬取 5–30 分钟 | 任务可能重试一次；**禁止** flush 队列；in-flight 由 Nest stalled 恢复接管 |
| 5 | 先重建 Web 回 `/socket.io`；再把 3 个开关回 legacy；重启两侧 | 重建 5–15 分钟 + 重启 2–4 分钟 | 实时消息 best-effort 丢失；DB 不受影响 |
| 6a | `API_GO_HEALTHZ_MODE=legacy` + 重启 api-go；业务开关按 §7 批次回退 | 1–3 分钟 | 无 |
| 6b | 本批不可执行；回退 = 恢复 Nest 启动并重建 Web/探针到 `/api/healthz/live` | 取决于 C 类工程变更 | 无（未执行） |

**通用数据处置：** 回退只改开关与重启，不删除任何表/集合/队列；已写入的数据由业务方按迁移中「两侧同修」的语义核对（§8）。如果发现 Go 写入的字段与 Nest 不一致，保留样本、记录 jobId/请求 traceId、暂停该开关，不要手工批量改数据。

---

## 8. 已知行为差异（回退后可能重现）

> 只列「Go 侧有意修正/有意保留」且与 Nest 不同的项。**「回退后是否重现」= 是** 表示该差异只在 Go 侧修过，切回 Nest 会恢复旧行为；**否** 表示 Nest 同批也修了，回退不会重现。PR 号只在文档明确记录时给出，查不到的写「未核实」。

| # | 行为差异 | 证据（file:line） | 回退后是否重现 | 影响/处理 |
|---:|---|---|---|---|
| 1 | 每日摘要投递：未领取 slot 的失败写改为旧 slot 条件更新；到期扫描改为固定 cutoff + 稳定游标分页 | `docs/refactor/go-digest-delivery.md:91`（PR 未核实） | **是** | 回退后 Nest 的旧实现可能重复/漏投递；观察 `userdigest:` 日志与重复邮件 |
| 2 | `GET /me` 追加 `accessTokenId`/`accessTokenExpiresAt`；`PATCH /profile` **有意不追加** | `docs/refactor/go-account-security.md:74-79`（PR #60，见文档） | **是** | 前端若依赖 PATCH 返回 token 元数据会退化；回退前确认前端用法 |
| 3 | LLM 网关治理：机器令牌审计 actor 写 NULL（Nest 写 `machine:<id>` 触发外键失败）；`/team/new` 失败返回 503（Nest 500）；传输错误措辞/`lastSyncedAt` 解析更严格 | `docs/refactor/go-llm-gateway-ops.md:197-211`（PR 未核实） | **是** | 回退后管理端可能出现 500/外键错误；审计 actor 形态变化 |
| 4 | 态势信号：重复 `channel` 参数返回未配置分支 200（Nest 500）；畸形缓存元素更宽容（Nest 500） | `docs/refactor/go-situation-monitor-signals.md:96-104`（PR 未核实） | **是** | 回退后异常输入会恢复 500；前端容错需复测 |
| 5 | GraphQL 设置/采集读：读路径不读 Redis 设置缓存（直接读 MySQL 并按同一归一化返回） | `docs/refactor/go-graphql-settings-crawl-read.md:105-112`、`171-176`（PR #50，见文档） | **是**（行为等价，但缓存路径/时序不同） | 回退后读取可能命中旧缓存；一致性验证需重做 |
| 6 | 组织访问写：审计写 `AuditLog` 与 `AuditLogOutbox` 都失败时只记日志，不回滚已提交的组织写入（Nest 会重抛并回滚 `createOrg`） | `docs/refactor/go-graphql-org-access-write.md:102`（PR 未核实） | **是** | 回退后组织创建可能在审计失败时整体失败；需业务确认可接受性 |
| 7 | REST 与 GraphQL 的 items 语义差异：缺失语义（404 vs null）、processed 选择（最新 vs 状态优先）、形状/错误 envelope | `docs/refactor/go-items-reading.md:366-373` | 不适用（这是 Go 内部两协议差异；回退后按 Nest 原语义） | 前端切换前需确认使用哪条协议 |
| 8 | 经济数据：省略 `repeatCron` 不再清空已保存 cron | `docs/refactor/go-economic-data.md:49-53` | **否**（Nest 同批已修） | 回退不会重现旧行为 |
| 9 | 分类质量/RSS 运维 4 个缺陷（ObjectId 500、`///` 绕过、停用成员收告警、机器令牌审计外键） | `docs/refactor/go-classification-rss-ops.md:59-64` | **否**（Nest 与 Go 两侧同修） | 回退不重现 |
| 10 | 采集画像/模板/读遥测/管理日志的跨租户与脱敏修复 | `docs/refactor/go-crawl-profiles.md:45-56`、`go-crawl-templates.md:36-42`、`go-crawl-read-telemetry.md:61-63`、`go-admin-logs.md:55-59` | **否**（两侧同修） | 回退不重现 |
| 11 | War Map 日期解析：`2026-02-31`/带时间字符串按 JS `Date` 溢出（Nest 200，Go 原 400，已对齐） | `docs/refactor/go-migration-adr.md:350` | **否**（对齐 Nest 语义） | 回退不重现 |
| 12 | 账户安全 AS1–AS4（机器令牌轮换原子性、并发改密覆盖、profile null、createdById 外键） | `docs/refactor/bug-ledger.md:63-66` | **否**（Nest 与 Go 两侧已修复） | 回退不重现 |

**另需注意：** 回退到 Nest 后，之前由 Go 接管期间产生的缓存/锁/队列状态仍存在；Nest 读取同一 Redis/MySQL/Mongo 时按 §2.3 核对，不要清空缓存。若 Go 侧写入过新的缓存 key（例如设置缓存），回退后 Nest 可能读到「Go 写入的同一份归一化结果」——按上表第 5 条验证一致性。

---

## 9. 未核实事项（本批未执行/未验证）

1. **所有命令与验证步骤**：本批没有运行任何 docker、curl、Redis/MySQL/Mongo 查询、重启或重建；本手册不声称通过。
2. **compose 多 `--env-file` 行为**：`docker compose v2.24+` 的多 `--env-file` 与「`--env-file` 替代默认 `.env`」是依据 Compose 文档的写法，本批未执行验证；旧版本可能不支持。
3. **override 的有效性**：只做了 PyYAML 解析与 49/59 静态计数，未运行 `docker compose config`（本批禁止）；`env_file` 与 `environment` 的合并/优先级未在真实 compose 版本验证。
4. **49 vs 30 名单差异**：规划窗口临时名单只有 30 条（未随仓库提交），实测 compose 为 49 个写死（见 §0.2 的 19 个差异名单）；以实测为准。
5. **重启/重建耗时**：全部是保守估计，未计时；Nest 的 healthcheck `start_period 300s` 只是上限，不代表实际启动时间。
6. **`/api/metrics` 的实际输出**：静态结论是多数 family 没有 series（仅 `scheduler_runs_total` 有记录点），未实跑验证。
7. **legacy 回落指标**：`api_go_legacy_proxy_requests_total` 已在本批实现并提交（`metrics/families.go`、`legacyproxy/proxy.go`），但**未运行 go test、未部署、未实跑**；PromQL 中的标签值以 `legacyRoutePrefix` 的实现与测试为准，部署后需用真实 `/api/metrics` 输出核对。
8. **C 类清单**：本手册按 `ownership-audit.md` §0.2 列 C-1–C-9（`/api/healthz/live`、crawl-frontier 三条写（C-2/C-3/C-4 已由 `refactor/go-crawl-frontier-writes` 关闭）、vector diagnostics、`itemPipelineDlq`、Swagger、Bull Board、根路径 404）；DLQ 细节见 `ownership-audit.md` §5 的 1.1 主表与「4. 真实缺口」。本批只关闭 C-2/C-3/C-4，未实现 C-1、C-5–C-9 的处理。
9. **阶段归属**：本手册的阶段分组是 T4/T5 的编排建议；若与 `switch-matrix.md`（T3）不一致，以 T3 为准。
10. **外部服务**：crawl4ai、LiteLLM、SMTP、Telegram、Oref、AkShare、MinIO/S3、Nominatim、OpenSky、OIDC 全部未验证。
11. **身份/网络细节**：`API_BASE_URL` 同时被 web（服务端）与 api-go（OIDC redirect_uri）读取；切到 `http://api-go:4020` 后 IdP 回调是否可接受未核实。TLS、反向代理、CORS_ORIGIN、`TRUST_PROXY` 的真实配置未核对。
12. **同实例核对命令**：MySQL `@@server_uuid`、Redis `run_id`、Mongo `serverStatus().host` 的检查未执行；容器 IP 也依赖具体 compose 网络，示例值不可照抄。
13. **Nest 侧涉及的 46 个开关**（附录 A：34 行为 + 11 仅 schema + 1 未使用 getter）：来自 `apps/api/src` 的静态 grep，未逐个运行验证；其中 `RAW_ITEM_OUTBOX_MODE`（行为）与 `USER_DIGEST_MODE`（仅 schema）未在 compose 的 api 服务显式映射，依赖 `.env` 注入。
14. **PR 号**：多数 Go 文档页没有记录合并 PR 号；表中标「未核实」的条目，回退前需按 `git log`/GitHub 核对。
15. **性能/容量**：Go 与 Nest 的吞吐、内存、连接数对比未测；`bull:<q>:meta` 并发参数的实际效果未验证。
16. **停 Nest 的工程变更**：C-1、C-5–C-9 处理（C-2/C-3/C-4 已关闭）、`depends_on` 解除（`!reset`/`!override` 版本行为未验证）、Web 启动等待改 `/__go/healthz`、外部探针迁移均未实施；`/api/healthz/live` 停 Nest 后会 502。

---

## 10. 变更记录

| 日期 | 变更 | 作者/来源 |
|---|---|---|
| 2026-10-21 | 初版：阶段 0–6、前置检查、停 Nest 判定、12 项用户验证、legacy 回落观测、行为差异 | runbook-config（T5） |
| 2026-10-21 | 按 Lead 审阅修正：env 样例去掉行内注释；新增 compose override（59 个未插值开关 + 凭据）；更新切流命令为双 `--env-file` + 双 `-f`；阶段 0 增加 phase0 生成方法 | runbook-config（T5） |
| 2026-10-21 | 按 Lead 决策修正：阶段 6 拆为 6a（停业务流量）/6b（完全停 Nest，本批不可执行）；C-1–C-9 与选项；`/api/healthz/live` 不新增开关、不计入 131；补充探针/`depends_on` 工程变更与 `/__go/healthz` 迁移；确认凭据类 env 已由 compose 注入（正向校验保留） | runbook-config（T5） |
| 2026-10-21 | `refactor/go-crawl-frontier-writes`：C-2/C-3/C-4 三条 crawl-frontier 管理写迁入 Go（`API_GO_CRAWL_FRONTIER_WRITES_MODE`，要求 RUNS=go；开关总数 130→131、阶段 2 60→61）；本手册回填 C 类状态并补阶段 2 依赖说明 | docs-cutover（T5） |

---

## 附录 A：Nest 侧涉及的 46 个开关（34 行为 + 11 仅 schema + 1 未使用 getter）

> **口径说明（与 `switch-matrix.md` 的「Nest 同读」列一致）：** 131 = **34 个有行为分支**（`是`：Nest 在 go 时返回/不建 Worker/不订阅，必须与 api-go 同值）+ **11 个仅在 `apps/api/src/modules/config/env.schema.ts` 声明**（zod 校验用，无行为分支）+ **86 个 Nest 完全不读**（其中 85 个完全无引用，1 个是 `API_GO_ANALYSIS_RUNS_MODE`：有未使用 getter、无行为分支）。因此「Nest 侧涉及」的集合 = 34 + 11 + 1 = **46**（`grep` 能命中的数量），但真正需要双侧同值的只有 **34** 个。
>
> 来源：`grep -rho 'API_GO_[A-Z0-9_]*' apps/api/src --include=*.ts | sort -u`（46 个，静态核对）。**只有 34 个行为开关必须双侧同值**；11 个 schema-only 只需保证 compose 不注入非法值；1 个未使用 getter 不影响 Nest 行为。启用顺序：先 `api` 设 `go` 并重启，再 `api-go` 设 `go` 并重启；回退顺序相反。

**A.1 34 个有行为分支（必须双侧同值；顺序：先 api 后 api-go，回退反向）**

```
API_GO_ALERT_WORKER_MODE
API_GO_ANALYSIS_WORKER_MODE
API_GO_ARCHIVE_PREPARATION_WORKER_MODE
API_GO_ASSISTANT_WORKER_MODE
API_GO_AUDIT_LOG_RETENTION_MODE
API_GO_AUDIT_OUTBOX_MODE
API_GO_BULLMQ_CLEANUP_MODE
API_GO_CLASSIFICATION_QUALITY_ALERT_MODE
API_GO_CLASSIFICATION_QUALITY_WORKER_MODE
API_GO_CLASSIFICATION_REVIEW_SEED_MODE
API_GO_CRAWL_FRONTIER_LLM_WORKER_MODE
API_GO_CRAWL_MAINTENANCE_MODE
API_GO_CRAWL_WORKER_MODE
API_GO_ECONOMIC_DATA_WORKER_MODE
API_GO_GDELT_SNAPSHOT_MODE
API_GO_ITEM_PIPELINE_WORKER_MODE
API_GO_KNOWLEDGE_GRAPH_INGESTION_MODE
API_GO_NEWSNOW_BACKGROUND_MODE
API_GO_NEWSNOW_SOURCES_MODE
API_GO_NEWS_CLUSTERING_RECOVERY_WORKER_MODE
API_GO_NEWS_EVENTS_INGESTION_MODE
API_GO_NEWS_EVENTS_TIMELINE_MODE
API_GO_NEWS_INDICATOR_ASSOCIATION_CRON_MODE
API_GO_NEWS_SOURCE_OPS_MODE
API_GO_NEWS_SOURCE_SCHEDULER_MODE
API_GO_NOTIFICATIONS_SOCKET_MODE
API_GO_PROCESSED_ITEM_OUTBOX_MODE
API_GO_RAW_ITEM_OUTBOX_MODE
API_GO_REALTIME_SIGNALS_MODE
API_GO_REALTIME_SOCKET_MODE
API_GO_SENTIMENT_SNAPSHOT_MODE
API_GO_SITUATION_SIGNALS_WORKER_MODE
API_GO_STARTUP_RECONCILE_MODE
API_GO_USER_DIGEST_DELIVERY_MODE
```

**A.2 11 个仅 schema 声明（无 Nest 行为；只需避免非法值）**

```
API_GO_CLASSIFICATION_REPORTS_MODE
API_GO_ECONOMIC_DATA_MODE
API_GO_GRAPHQL_NEWS_INDICATOR_REFRESH_MODE
API_GO_METRICS_MODE
API_GO_NEWSNOW_HOTTEST_MODE
API_GO_NEWS_CLUSTERING_LLM_BACKFILL_MODE
API_GO_PIPELINE_RECOVERY_MODE
API_GO_PIPELINE_RECOVERY_WRITE_MODE
API_GO_SITUATION_REFRESH_MODE
API_GO_SITUATION_TELEGRAM_AUTH_MODE
API_GO_USER_DIGEST_MODE
```

**A.3 1 个有未使用 getter（无行为，不需要双侧切换）**

```
API_GO_ANALYSIS_RUNS_MODE   # apps/api/src/modules/config/config.service.ts:1300-1310 的 getter 未被行为分支使用
```

---

## 附录 B：Nest 让位日志关键字

| 开关/域 | 日志关键字 | 证据 |
|---|---|---|
| itemPipeline | `Skipped item pipeline worker because Go owns the consumer (API_GO_ITEM_PIPELINE_WORKER_MODE=go)` | `apps/api/src/modules/queue/queue.processor.ts:102` |
| archivePreparation | `Skipped archive preparation worker because Go owns the consumer (...)` | `apps/api/src/modules/archive/archive-preparation.processor.ts:47` |
| alerts | `alerts queue ownership moved to api-go (API_GO_ALERT_WORKER_MODE=go)` | `apps/api/src/modules/alerts/alerts.processor.ts:39` |
| assistant | `Assistant worker runs in api-go (...); keeping the queue and queue events only` | `apps/api/src/modules/assistant/assistant.processor.ts:40` |
| knowledge graph ingestion | `Skipped knowledge graph ingestion because Go owns the chain (...)` | `apps/api/src/modules/knowledge-graph/knowledge-graph.ingestion.service.ts:51` |
| user digest delivery | `Skipped user digest delivery scheduler because Go owns delivery (...)` | `apps/api/src/modules/user-digest/user-digest-delivery-scheduler.service.ts:39` |
| news events ingestion | `Skipped news event ingestion because Go owns the chain (...)` | `apps/api/src/modules/news-events/news-events-ingestion.service.ts:54` |
| news events timeline | `Skipped news event timeline rebuild because Go owns the cron (...)` | `apps/api/src/modules/news-events/news-events-timeline.service.ts:192` |
| sentiment snapshot | `Skipped sentiment snapshot rebuild because Go owns the cron (...)` | `apps/api/src/modules/sentiment/sentiment-snapshot.ingestion.service.ts:66` |
| news indicator association | `Skipped news indicator association refresh because Go owns the cron (...)` | `apps/api/src/modules/news-indicator/news-indicator-association.ingestion.service.ts:46` |
| audit outbox | `Skipped audit log outbox batch because Go owns delivery (...)` | `apps/api/src/modules/audit/audit-log-outbox.service.ts:65` |
| raw item outbox | `Skipped raw-item outbox batch because Go owns scheduled delivery (...)` | `apps/api/src/modules/items/raw-item-outbox.service.ts:162` |
| classification alert | `Skipping classification quality alert scheduler tick: evaluation is owned by api-go (...)` | `apps/api/src/modules/observability/classification-quality-alert-scheduler.service.ts:55` |
| news clustering recovery | `Skipped news event clustering recovery scheduler/worker because Go owns ...` | `apps/api/src/modules/news-events/news-event-clustering-recovery-scheduler.service.ts:34`、`apps/api/src/modules/news-events/news-event-clustering-recovery.processor.ts:40` |

---

## 附录 C：队列与 Redis 检查速查

**BullMQ key 形态**（`internal/crawlqueue/model.go:145-190`；`internal/alertqueue/queue.go:13-20`；`internal/qualityqueue/doc.go:14-20`）：
- `bull:<queue>:wait`（list）、`:active`（list）、`:delayed`（zset）、`:completed`（zset）、`:failed`（zset）、`:paused`（list）、`:meta`（hash）、`:events`（stream）、`:marker`（string）、`:<jobId>`（hash）。
- 队列名前缀是 `bull:`，不是 `BULLMQ_NAMESPACE`（`internal/bullmqcleanup/keys.go:5-9`：BULLMQ_NAMESPACE 是缓存命名空间，不是队列前缀）。

**命令【未在本批执行】：**

```bash
# 全部队列水位（示例，q 逐个替换）
redis-cli -a "$REDIS_PASSWORD" LLEN  "bull:$q:wait"
redis-cli -a "$REDIS_PASSWORD" LLEN  "bull:$q:active"
redis-cli -a "$REDIS_PASSWORD" ZCARD "bull:$q:delayed"
redis-cli -a "$REDIS_PASSWORD" ZCARD "bull:$q:failed"
redis-cli -a "$REDIS_PASSWORD" ZCARD "bull:$q:completed"
redis-cli -a "$REDIS_PASSWORD" HGETALL "bull:$q:meta"
redis-cli -a "$REDIS_PASSWORD" XLEN  "bull:$q:events"

# 某个 job 的状态字段
redis-cli -a "$REDIS_PASSWORD" HGETALL "bull:itemPipeline:<jobId>"
```

**排队积压判据：** `wait` 持续增长而 `active` 为 0 → 没有消费者（检查 owner 与 CLIENT LIST）；`failed` 持续增长 → 看 job hash 的 `failedReason`；`delayed` 长期不降 → 检查 limiter/backoff 与系统时间。

---

## 附录 D：锁与 tick gate 键

| 键 | 用途 | 证据 |
|---|---|---|
| `cron:news-source-scheduler`（物理键 `lock:` 前缀） | 新闻源调度租约 | `internal/newssourcescheduler/scheduler.go:113`、`model.go:16` |
| `cron:news-events-timeline:tick-gate` / `lock:cron:news-events-timeline:org:<orgId>` | 新闻事件时间线 | `docker-compose.yml:1655-1661` 注释；`internal` 未逐行核对（未核实） |
| `cron:sentiment-snapshot:tick-gate` / `lock:cron:sentiment-snapshot:org:<orgId>` | 情绪快照 | `internal/sentimentsnapshot/model.go:20`、`doc.go:7-10` |
| `cron:realtime-signals:tick-gate` / `lock:cron:realtime-signals:org:<orgId>` | 实时信号采集 | `internal/realtimesignals/constants.go:55`、`service.go:229` |
| `lock:cron:processed-item-outbox` | processed_item 补偿 | `internal/processeditemoutbox/scheduler.go:13-14`、`doc.go:5` |
| `cron:user-digest-delivery:tick-gate` / `lock:cron:user-digest-delivery:org:<orgId>` | 摘要投递 | `internal/userdigest/delivery_scheduler.go:17-25` |
| `lock:startup:reconcile` | 启动对齐 | `internal/startupreconcile/reconcile.go:31` |
| `lock:search:reindex:org:<orgId>` | 搜索重建 | `internal/searchreindex/lock.go:17-19` |
| `cron:situation-monitor-oref-default-rules:tick-gate` | OREF 默认规则 | `internal/situationsignalsworker/alerts.go:26` |
| `lock:cron:bullmq-retained-cleanup` | BullMQ 保留清理 | `docker-compose.yml:1133-1138`（注释） |
| `observability-snapshot:<orgId>:<scope>:<variantKey>`（物理 `lock:` 前缀） | 质量快照锁 | `internal/qualityoverview/snapshot.go:19-20` |

**检查方法：** `redis-cli --scan --pattern 'cron:*'`、`--scan --pattern 'lock:*'`，配合 `TTL`/`GET` 看是否只有一个实例持有（值通常是 JSON 或 token）。

---

## 附录 E：指标与日志前缀

**指标 family（`internal/metrics/families.go:28-55`）：**

| 指标 | 类型 | 标签 | 本批是否有记录点 |
|---|---|---|---|
| `http_request_duration_seconds` | histogram | `method,route,status_code` | **无**（只有 family 注册） |
| `background_job_duration_seconds` | histogram | `queue,job,status` | **无** |
| `integration_events_total` | counter | `integration,operation,status` | **无** |
| `scheduler_runs_total` | counter | `scheduler,status` | 有（`internal/classificationalert/scheduler.go:373-381`） |
| `pipeline_metric_value` | gauge | `org_id,metric` | **无** |
| `go_*`、`process_cpu_seconds_total`、`process_start_time_seconds` | gauge/counter | — | 有（`processmetrics.go`，随渲染输出） |

**日志前缀（`log` 标准库）：** `api-go: `（`cmd/api/main.go`、`cmd/api/nest_residual_duties.go`）、`itempipeline: `、`crawlworker`（集成测试用 `[crawlworker-it]`；运行时错误在 `crawlexecution: `）、`crawlfrontierllm: `、`archive-preparation: `、`economicqueue: `、`situationsignals: `、`situationsignalsworker: `、`newssourcescheduler: `、`userdigest: `、`geocoding: `、`vectorclient: `、`shadow-diff `、`authlogin: `、`authz: `、`authn: `。
