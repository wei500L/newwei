# 3D 地球 G1：GEV 服务端作为数据代理旁车

> **一句话目标**：
> - 让 GEV 自带的服务端（Vite 中间件形式的数据代理，持有各家 API 密钥）作为独立的「旁车」服务运行；
> - 浏览器访问 `/globe` 时，GEV 引擎发出的 `/api/flights`、`/api/celestrak`、`/models/...` 等请求经 Next rewrites 转发到旁车；
> - 不该暴露的路径（密钥设置、语音）不转发。
>
> **依赖**：G0 已合入。**开工前必读**：README 全文；`vendor/gods-eye-view/Dockerfile`、`compose.yaml`、`.env.example`、`build/allowedHosts.js`、`server/standalone/` 目录。

## 背景

GEV 的服务端就是它的 Vite 开发服务器。它的浏览器代码用**相对路径**请求自己的服务端，下面这些路径是从源码里扫描出来的完整清单：

```
/api/google /api/transit /api/route /api/tomtom /api/terrain /api/vessels /api/cctv /api/weather
/api/ghostmaps /api/geocode /api/fire-perimeters /api/radio /api/overpass /api/military-installations
/api/military /api/mapillary /api/gbfs /api/flights /api/celestrak /api/wind /api/weather-effects
/api/regional-brief /api/map /api/local-receivers /api/launches /api/gnss-integrity /api/firms
/api/cyclones /api/adsbdb
/api/setup /api/openai /api/gemini /api/realtime          ← 这四个不转发
静态资源：/models/  /events/  /scene-assets/
```

我们 web 现有的 Next API 路由是 `/api/auth`、`/api/crawl4ai`、`/api/healthz`、`/api/logout`、`/api/organizations`、`/api/situation-monitor`，与上表没有冲突。

## 任务

### 1.1 compose 服务（`infra/docker/docker-compose.yml`）

新增 `globe-sidecar` 服务：

- `build.context: ../../vendor/gods-eye-view`（相对路径按 compose 文件的实际位置调整），使用它自带的 Dockerfile。
- `ports: ["${DOCKER_PUBLISH_HOST:-127.0.0.1}:4173:4173"]`，与本仓库其它服务的发布写法保持一致。
- 环境变量映射：

  | GEV 变量 | 来源（根 `.env`） |
  |---|---|
  | `GOOGLE_MAPS_API_KEY` | `GLOBE_GOOGLE_MAPS_API_KEY` |
  | `GOOGLE_MAPS_SERVER_API_KEY` | `GLOBE_GOOGLE_MAPS_SERVER_API_KEY` |
  | `AISSTREAM_API_KEY` | `GLOBE_AISSTREAM_API_KEY`（默认留空，原因见 1.5） |
  | `OPENSKY_AUTH_MODE` / `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` | `GLOBE_OPENSKY_*`（默认留空，原因见 1.5） |
  | `FIRMS_MAP_KEY` | `GLOBE_FIRMS_MAP_KEY`（可选） |
  | `GEV_ALLOWED_HOSTS` | 固定为 `globe-sidecar`（Next 在容器网络里会用这个主机名访问它；先读 `build/allowedHosts.js` 确认这个变量的格式） |
  | `OPENAI_API_KEY`、`GEMINI_API_KEY` | **不设置** |

- 健康检查沿用它 Dockerfile 里的 `HEALTHCHECK`，不要重复定义。
- `web` 服务追加环境变量 `GLOBE_SIDECAR_URL=http://globe-sidecar:4173`，并加 `depends_on: globe-sidecar`，条件为 `service_started`，**不要**用 `service_healthy`：旁车挂掉时，控制台其它页面必须照常工作。
- GEV 的 compose 会把源码目录挂载进容器（这样在设置页里填的密钥会写回宿主机的 `.env`）。我们**不挂载**源码：镜像是只读构建产物，密钥只来自环境变量。在服务旁边用注释说明这一点。

### 1.2 本地开发脚本

在 `infra/scripts/src/dev.mts` 里，按 `ais-relay` 的写法新增一个 `globe` 目标，根目录 `package.json` 加 `"dev:globe": "tsx infra/scripts/src/dev.mts globe"`。行为：

- 在 `vendor/gods-eye-view` 目录执行 `npm run dev`，环境变量按 1.1 的表从根 `.env` 映射，`PORT=4173`，`HOST=127.0.0.1`。
- 启动前检查 `node --version` 的主版本号 ≥ 24，不满足就打印清晰的提示并退出，**不要**自动安装。
- 检查 `vendor/gods-eye-view/node_modules` 是否存在；不存在就提示 `cd vendor/gods-eye-view && npm ci`，然后退出，**不要**自动执行。
- 默认的 `pnpm dev` **不启动**旁车；用户需要 3D 地球时，另开一个终端运行 `pnpm dev:globe`。

### 1.3 Next rewrites（`apps/web/next.config.mjs`）

在 G0 的基础上追加 `async rewrites()`。如果已经存在 `rewrites`，就合并它返回的数组。

```js
const GLOBE_API_PREFIXES = [
  "google", "transit", "route", "tomtom", "terrain", "vessels", "cctv", "weather", "ghostmaps",
  "geocode", "fire-perimeters", "radio", "overpass", "military-installations", "military",
  "mapillary", "gbfs", "flights", "celestrak", "wind", "weather-effects", "regional-brief", "map",
  "local-receivers", "launches", "gnss-integrity", "firms", "cyclones", "adsbdb",
];
const GLOBE_STATIC_PREFIXES = ["models", "events", "scene-assets"];
const globeSidecarUrl = process.env.GLOBE_SIDECAR_URL ?? "http://127.0.0.1:4173";

async rewrites() {
  return [
    ...GLOBE_API_PREFIXES.map((p) => ({ source: `/api/${p}/:path*`, destination: `${globeSidecarUrl}/api/${p}/:path*` })),
    ...GLOBE_STATIC_PREFIXES.map((p) => ({ source: `/${p}/:path*`, destination: `${globeSidecarUrl}/${p}/:path*` })),
  ];
},
```

- 先确认 `:path*` 能匹配不带子路径的 `/api/flights`。如果不能，就为每个前缀再加一条不带 `/:path*` 的规则。
- 在常量上方用注释写清楚：这份清单来自 GEV 源码扫描；`setup`、`openai`、`gemini`、`realtime` **故意不转发**；升级 GEV 后要用 `grep -rhoE "['\`\"]/api/[a-zA-Z0-9_-]+" vendor/gods-eye-view/src` 重新核对。
- 先读 `vendor/gods-eye-view/src/data/aisLiveVessels.js` 和 `server/providers/live.js`，确认 `/api/vessels` 的传输方式：
  - 如果是 SSE 或长轮询，Next rewrites 可以正常代理；
  - 如果是 **WebSocket**，Next rewrites 不支持升级连接。这种情况下在报告里说明，并让船舶图层在 G2 的图层目录里默认关闭（G3 的图层面板显示「本环境不可用」）。**不要**为此另写一个 WebSocket 代理。

### 1.4 环境变量样例

在根 `.env.example` 和 `infra/docker/.env.sample` 中**追加**一个「3D 地球（gods-eye-view 旁车）」小节，列出：

- `GLOBE_SIDECAR_URL`
- `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`（浏览器端，用于加载 Google 3D 瓦片；**必须在 Google Cloud 控制台按 HTTP referrer 限制**）
- `GLOBE_GOOGLE_MAPS_API_KEY`、`GLOBE_GOOGLE_MAPS_SERVER_API_KEY`
- `GLOBE_AISSTREAM_API_KEY`、`GLOBE_OPENSKY_AUTH_MODE`、`GLOBE_OPENSKY_CLIENT_ID`、`GLOBE_OPENSKY_CLIENT_SECRET`
- `GLOBE_FIRMS_MAP_KEY`

每项一行注释。

如果 `pnpm --filter infra-scripts run env:check`（`infra/scripts/src/check-env.ts`）有必填项清单，这些变量全部登记为**可选**。

### 1.5 两个资源冲突（写进 `.env.example` 的注释和 README）

- **OpenSky**：我们后端的 `realtimesignals` 有一份每日额度账本（`REALTIME_SIGNALS_OPENSKY_DAILY_CREDIT_BUDGET`），GEV 不认这份账本。同一个账号给两边共用会抢额度。所以 `GLOBE_OPENSKY_*` **默认留空**，这时 GEV 自动改用免密钥的 adsb.lol。用户有第二个 OpenSky 账号时再填。
- **AISStream**：同一个密钥建立两条 websocket 连接，上游可能限流。所以 `GLOBE_AISSTREAM_API_KEY` **默认留空**，船舶图层显示「需要密钥」。用户愿意试时，可以填与 ais-relay-go 相同的密钥。

### 1.6 文档

- 根目录 `README.md` 和 `AGENTS.md` 的端口 / 服务说明里，追加 `globe-sidecar`（4173，只绑定本机）和 `pnpm dev:globe`。
- `AGENTS.md` 的 compose 服务列表里补上 `globe-sidecar`。

---

## 禁止事项

- 不修改 vendor 源码。
- 不转发 `/api/setup`、`/api/openai`、`/api/gemini`、`/api/realtime`。
- 不在 web 或 api-go 中保存 GEV 的服务端密钥。

## 验证

- README §6 全部命令通过。
- 静态自查：
  - `docker compose -f infra/docker/docker-compose.yml config` 能通过解析。如果本机不能运行 docker，就在报告里写明「未运行」，由用户执行。
  - rewrites 的数组里不包含那四个禁止转发的前缀。

## 提交

`🔌 feat(infra): 3D 地球 G1 gods-eye-view 旁车服务与 Next 代理`
