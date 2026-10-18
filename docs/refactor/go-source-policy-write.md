# SOURCE-POLICY-WRITE-001 · 来源策略版本管理四 Mutation 迁入 Go

本批把 NestJS `SettingsResolver` 的来源策略四个写入口迁入 `apps/api-go`，并补齐 GAP-GQL-001 在 `cmd/api/main.go` 仍缺的两处旧设置写条件。NestJS 实现保留，生产 Web 入口仍指向 NestJS，canary 关闭。

## 精确范围

新增并仅新增以下 `POST /graphql` Mutation，`input` 均为非空：

| root | input | 返回 |
|---|---|---|
| `updateNewsEventSourcePolicy` | `UpdateNewsEventSourcePolicyInput!` | `NewsEventSourcePolicySettingsModel!` |
| `updateNewsEventSourcePolicyPresets` | `UpdateNewsEventSourcePolicyPresetInput!` | `NewsEventSourcePolicyPresetSettingsModel!` |
| `rollbackNewsEventSourcePolicy` | `RollbackNewsEventSourcePolicyInput!` | `NewsEventSourcePolicySettingsModel!` |
| `resetNewsEventSourcePolicy` | `ResetNewsEventSourcePolicyInput!` | `NewsEventSourcePolicySettingsModel!` |

四个 root 的根权限均为 `settings.manage`，并复用 `settingscrawl.AssertSystemAdmin`：只接受调用者本组织 `isSystem=true`、名称大小写不敏感为 `admin` 的内置角色。缺角色/缺 membership 为 403 `Unauthenticated`，非系统 admin 为 403 `Admin access required`。身份、orgId 与权限全部由 Go 侧从 MySQL/Redis 重推导，不信任客户端或 JWT 自报值。

语义按 `NewsEventSourcePolicyService` 实现：

- update：按内置默认策略生成八组 add/remove 差量，加载完整 v2 state，校验可选 `expectedRevision`，追加 `update` revision 后保存并审计/刷新缓存；只有显式传入 `categoryAuthority`（含 `null`/`[]`）才写 active 分类权重，`null`/`[]` 清空，未传保留。
- rollback：先校验 `expectedRevision`，在保留历史中找目标 revision，创建新的 `rollback` revision 并恢复目标 delta；`activeRevision` 只增不减，分类权重不回滚。
- reset：校验 `expectedRevision` 后追加 `reset` revision，delta 八组置空，从而回到内置默认四名单；历史、分类权重与 preset 均保留。
- preset：可选 `expectedUpdatedAt` 与数据库行 `updatedAt` 精确比较（未传不比较，显式 `null` 仍比较），保存独立 preset 文档并回读真实数据库 `updatedAt`，按显式 presence 写 preset 分类权重；保存 preset 不应用到 active policy，也不追加 policy revision。

差量应用顺序为默认保序→追加尚未出现的 add→最后 remove；持久化保留最新 60 条 revision（升序），Mutation 返回最新 20 条（倒序），已有 Query 仍请求 30 条。`createdAt`/`updatedAt` 使用 UTC 毫秒 ISO；preset 的 `updatedAt` 取自实际 `SystemSetting` 行。

## 数据、缓存与审计

MySQL `SystemSetting` 键与 Redis 键均追加服务端 orgId：

| 内容 | SystemSetting 前缀 | Redis 前缀 | TTL |
|---|---|---|---|
| v2 策略 state | `news_event_source_policy:` | `newsEvents:sourcePolicy:` | 60s |
| active 分类权重 | `news_event_source_policy_category_authority:` | `newsEvents:sourcePolicyCategoryAuthority:` | 60s |
| preset 文档 | `news_event_source_policy_preset:` | `newsEvents:sourcePolicyPreset:` | 30s |
| preset 分类权重 | `news_event_source_policy_preset_category_authority:` | `newsEvents:sourcePolicyPresetCategoryAuthority:` | 30s |

写入顺序为主文档 DB → best-effort 审计 → cache，再按需分类 DB → 分类 cache；各 upsert 不是总事务，分类 DB 失败按源在状态已保存后传播。Redis 失败不抹去已保存结果，返回 `syncWarnings: ["CACHE_WRITE_FAILED"]`；未配置 Redis 不再静默成功。审计 `resource=system_settings`，动作为 `news_event_source_policy_update`/`rollback`/`reset`/`preset_update`，直接审计失败沿用现有 `AuditLogOutbox` pending 格式，重放消费者仍是 NestJS。分类权重没有额外审计动作。无 Mongo、模型、队列、worker、cron 或外部 HTTP 调用。

## 开关与接线

新增 `API_GO_GRAPHQL_SOURCE_POLICY_WRITE_MODE`：空串/`legacy` 为 legacy，`go` 为 Go，非法值启动失败；独立于 READ、SETTINGS_CRAWL_READ、SETTINGS_WRITE、ORG_ACCESS_WRITE、WORKSPACE_WRITE。`go` 只要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`，不要求 `MONGO_URI`，不初始化任何只读 Mongo service。legacy 时四 root 不注册，含未支持 root/字段的整份 operation 在任何副作用前回退 NestJS。

本批同时修复 GAP-GQL-001 在 `main.go` 的两处剩余条件：`graphqlRouteMode` 与无效 `DATABASE_URL` 的 go 接管判断都补上旧 `GraphQLSettingsWriteMode`，并接上新的 `GraphQLSourcePolicyWriteMode`；`needsCredentialedGo` 与 handler 既有旧设置写条件保留并追加新条件。旧 13 个设置写业务与算法不变。

共享装配保留并行批次并集：`config.Load`、`main` 路由/资源/模型注册、`.env.sample`、`docker-compose.yml` 与 `apps/api-go/README.md` 仅追加本批增量。回滚只把新变量改回 `legacy`；已存 v2/legacy 策略、preset 与共享缓存仍可由 NestJS 读取。

## 复用与边界

- `internal/graphqlread/settingscrawl/policywritesupport.go`：导出默认四名单/preset 默认值、domain/label/分类归一化、差量、revision/state 追加、序列化与投影；读算法仍由 `policy.go` 单一实现。
- `internal/graphqlread/settingswrite/sourcepolicy_*.go`：四 root 的具名 input、状态机、MySQL/Redis 持久化与审计适配；复用现有 `upsertSettingForceDescription`、`writeAuditLogBestEffort`、`graphqlFailure` 与错误映射。
- `settingscrawl.RegisterSourcePolicyModelTypes` 只注册 policy 返回所需的 7 个嵌套模型，不打开 Query，也不注册 crawl/Mongo 对象。

## 验证与未验证

本机未安装依赖，未运行 build/test/Docker/服务；仅做静态核对、`gofmt` 与 `git diff --check`。新增少量纯函数契约用例覆盖：update→rollback→reset 版本链、60/20 历史边界、分类权重归一化、`categoryAuthority` omitted/null/`[]`、`expectedRevision` 0/null、`expectedUpdatedAt` null/UTC/非法值、缺失 Redis 的 warning 边界、四 root 注册表与嵌套模型注册。未验证项：真实 MySQL/Redis 跨进程读写、NestJS 与 Go 双端在同一数据库上的联调、生产启用与 canary 切流；这些不能由静态检查或 CI 推断。
