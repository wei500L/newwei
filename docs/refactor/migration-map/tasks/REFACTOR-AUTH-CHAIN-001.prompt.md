# 执行提示词 · REFACTOR-AUTH-CHAIN-001 · 鉴权链单一实现、机器令牌统一、强制 jti

你在仓库 `wei500L/newwei`（本地 `/Users/oo/project/newwei`）工作。先完整读 `docs/refactor/migration-map/tasks/REFACTOR-COMMON.md` 并遵守其中全部纪律，再读本任务文件 `tasks/REFACTOR-AUTH-CHAIN-001.md`。worktree slug：`refactor-auth-chain`。前置：无。

## 问题（规划基线 18c41879858d 已核实）

### 1. 用户 JWT 鉴权链有 6 份以上手写副本

- `internal/authhttp/middleware.go` 里，`Identify`（约第 74 行起）和 `Authenticate`（约第 141 行起）几乎逐行重复：都是 Bearer 提取 → `verifier.Verify` → 黑名单 → `authz.Authorize`。
- `internal/accountsecurity/auth.go` 的 `authorizeHuman`（约第 136 行）自己承认是 "reproduces authhttp.Authenticate"，原因只是需要额外保留 `jti`/`exp`/`ClaimOrgID`。
- `internal/notificationssocket/auth.go:48`、`internal/socketio/auth.go:70`、`internal/realtimesocket/auth.go` 与 `runtime.go:276` 各自又实现了一遍验签加黑名单。
- `cmd/api` 里 `authn.NewVerifier` / `authn.NewRedisBlacklist` 被重复构造了 6 次：`main.go:335`、`main.go:1442`、`account_data.go:78`、`analysis_export.go:57`、`account_security.go:54`、`archive_reading.go:54`、`realtime_socket.go:131`。

### 2. 没有 jti 的 token 无法吊销（逻辑缺陷，沿袭自 Nest）

- 上面每一份副本都写着 `if token.JTI != "" { 查黑名单 }`，`internal/authn/jwt.go:76` 的注释说"空时按 NestJS 语义跳过 blacklist"。
- 结果是：只要 token 没有 `jti`，登出或吊销都对它无效，在过期之前一直可用。
- 本仓库唯一的签发点是 `internal/authlogin/tokens.go:84-98`，它总会生成 UUIDv4 `jti`。所以合法 token 都带 jti，强制要求 jti 不会影响正常用户。

### 3. 机器令牌（`mtk_`）鉴权约有 22 份副本

`authn.ExtractBearerToken` 会直接拒绝 `mtk_` 前缀（`internal/authn/jwt.go` 约第 65 行），于是每个允许机器令牌的包都自己写了一遍：

> SHA-256 → `SELECT ... FROM MachineAccessToken t JOIN Org o ... WHERE t.tokenHash = ?` → 吊销/过期/Org 停用检查 → 回写 `lastUsedAt` → 解析 permissions JSON → `authhttp.NewIdentity("machine:"+id, orgID, perms)`

副本位置（重新 grep `tokenHash = ?` 核对）：

`accountsecurity/auth.go`、`adminlogs/service.go`、`authfactors/auth.go`、`crawlfrontierruns/auth.go`、`crawlmetadata/machine.go`、`crawlprofile/store.go`、`crawlreadtelemetry/service_auth.go`、`crawltemplate/store.go`、`crawlworkflow/store.go`、`dataruntimesettings/auth.go`、`gdeltsnapshot/handler.go`、`health/machine.go`、`infrastructuresettings/auth.go`、`itemsreading/handler.go`、`llmgatewayprofiles/auth.go`、`llmlogs/store.go`、`metrics/handler.go`（两处）、`modelaccesssettings/store.go`、`newsindicator/store.go`、`newsnowclusteringops/machine.go`、`newsnowhottest/handler.go`、`newssources/store.go`、`platformgovernance/auth.go`、`rbacapi/service.go`、`runtimesettings/auth.go`、`situationsignals/auth.go`。

**不要动**：`authlogin/passwordreset.go`、`identityonboarding/*` 里的 `tokenHash`，它们是重置令牌和邀请令牌，不是机器令牌。`accountsecurity/machine_tokens.go` 是机器令牌的增删查管理，也不在本任务范围。

已经观察到的副本差异：

- `lastUsedAt` 写入值各不相同，有 `time.Now().UTC().Truncate(time.Millisecond)`、`nowMillis()`、`at.UTC()`；
- 有的读取 permissions，有的不读（`health/machine.go`）；
- 错误类型各自定义（`httpError`、`machineError`、`errInvalidMachineToken`……）。

## 方案

### A. `authn`：强制 jti（有意行为变更）

`Verify` 在 `jti` 为空或全空白时返回错误，最终对外表现为 401 `Unauthorized`（与其他验签失败相同）。删除所有 `if token.JTI != ""` 分支，改为无条件查黑名单。同时更新 `jwt.go:76` 的注释。

### B. `authhttp`：单一核心

- 新增内部核心函数，例如 `func (a *Authenticator) resolve(ctx context.Context, raw string) (*Identity, *AuthFailure)`，包含验签、黑名单和 authz。`Identify` 和 `Authenticate` 都改为调用它，`Authenticate` 只负责把 `AuthFailure` 映射为现有的 `WriteUnauthorized` / `WriteRedisFailure` / `WriteDatabaseFailure` 响应。
- 映射关系保持不变：401（含 `"Access token revoked"` 和 authz Rejection 的 message）、500（Redis）、503（MySQL）。
- `Identity` 增加只读访问器：`TokenID()`、`TokenExpiresAt()`、`ClaimOrgID()`，机器身份返回零值。这样 `accountsecurity` 不再需要自己的副本。
- 给 socket 握手提供一个不依赖 `*http.Request` 的入口，例如 `ResolveToken(ctx, raw)`。`notificationssocket` / `socketio` / `realtimesocket` 改为调用它；它们各自的错误映射（握手拒绝格式）保留在各自包里。

### C. 机器令牌：一个解析器

- 在 `authhttp` 内（或新的 `internal/machineauth` 包，二选一，避免循环依赖即可）实现 `MachineResolver{db *sql.DB, now func() time.Time}`，提供 `Resolve(ctx, raw) (*Identity, error)`，语义取现有多数副本：
  - SHA-256 hex 匹配 `tokenHash`，JOIN `Org`；
  - `revokedAt` 非空、`Org.isActive=0`、`expiresAt` 存在且 `!expiresAt.After(now)` → `ErrInvalidMachineToken`；
  - `lastUsedAt` 写入 `now().UTC().Truncate(time.Millisecond)`，失败不影响请求，只记日志；
  - permissions 只接受 JSON 字符串数组，其他形状授予空权限，永不当通配；
  - 身份为 `UserID="machine:<id>"`，`OrgID` 取令牌所属行。
- 同时提供只查行、不做权限转换的 `Lookup(ctx, raw) (MachineToken, error)`，给 `metrics.resolvePlatformMetricsAccess`（需要 `createdById` 判定平台管理员）和 `health/machine.go`（只需有效性）使用。这两处保留各自的决策逻辑，只把 SQL 和有效性判断换成共享实现。
- `Authenticator` 增加统一入口，例如 `AuthenticateWithMachine(w, r, permission)`：`mtk_` 前缀走 MachineResolver，否则走 resolve；之后统一检查权限，不满足时调用 `WriteForbidden`。逐个替换上面列出的包。
- 各包原本写出的 401 文案都是 `"Invalid machine token"`（全仓库共 56 处，一致），保持不变。

### D. `cmd/api`

只构造一次 verifier、blacklist、`Authenticator` 和 MachineResolver，传给所有需要的地方。删除另外 6 处重复构造。只做这些构造参数级的改动，不重排其他装配（那属于 REFACTOR-RUNTIME-WIRING-001）。

## 等价陷阱

1. `ExtractBearerToken` 对 `Bearer` 大小写不敏感，并拒绝 `mtk_`。不允许机器令牌的路由必须继续以同样的 401 拒绝 `mtk_`；只有原来接受机器令牌的路由才能走新入口。逐路由核对，不能扩大接受机器令牌的范围。
2. 401 先于 403：认证失败不能被当作权限不足。
3. `NullableActorID` / `machine:` 前缀会在审计行里投影成 NULL，这个约定保持不变。
4. `accountsecurity` 在 profile、修改密码中使用的是 `ClaimOrgID`（原始 claim），不是 membership 推导出的 `OrgID`。替换后这几个调用点必须仍然拿到原始 claim。
5. 过期判断是 `!After(now)`，即“等于 now 也算过期”，不要写成 `Before`。
6. 黑名单查询失败必须 fail-closed（500），不能当作“未吊销”。
7. 机器令牌查询的 `sql.ErrNoRows` → 401；其他数据库错误保持各包原来的映射（多数是 503/500）。如果副本之间映射不一致，在差异表里记录统一后的选择。

## 测试

- `authn`：缺少 jti → 拒绝。
- `authhttp`：`Identify` 和 `Authenticate` 对同一组输入（缺 token、坏签名、已吊销、authz 拒绝、DB 错误）结论一致；机器令牌的过期边界（等于 now）、吊销、Org 停用、非数组 permissions。
- 各包原有测试的断言不改；只因构造函数签名变化而调整装配代码。

## 前端

强制 jti 不需要改前端。其余部分无契约变化，不改 `apps/web`。

## 交付范围

- 允许修改：`internal/authn`、`internal/authhttp`（以及可选的新增 `internal/machineauth`）、上面列出的各包里的鉴权文件、三个 socket 包的 auth 文件、`cmd/api` 中与 verifier/blacklist/authenticator 构造相关的行。
- PR 必须包含差异处理表，逐个副本说明它原来的 `lastUsedAt` 写法、错误映射、权限解析方式，以及统一后的结果。
