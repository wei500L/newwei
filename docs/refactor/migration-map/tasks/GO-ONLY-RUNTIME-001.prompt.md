# 第二步：Go 运行时去掉 legacy/shadow/canary 分流

执行 `wei500L/newwei` 的 **GO-ONLY-RUNTIME-001**。目标是 Go 后端直接拥有所有已实现入口与异步执行，不再含面向 Nest 的反代、旁路比对、小流量分流或 operation 回退。**本批保留 Node 后端源码与尚需它们的对照 CI，删除在第三步做。**

## 1. 必须从已落地前置继续

读 AGENTS、迁移地图 README/PLANNING/GAPS/任务索引、当前 task，以及 `GO-CONTRACT-TOOLING-001` 的实际 PR/交付。规划任务在 PR #149，未合入时只读取得，不合并规划分支来代替业务前置。

fetch main，核对精确 SHA、开放 PR/认领/worktree/普通 CI。规划基线 `fcf1e533` 已有 #150/#151，但还没有第一步：**GO-CONTRACT-TOOLING-001 必须真正合入，契约/工具/fixture 与新 Go 检查已接通并通过普通 CI**。未满足时只读核实缺项，不并开抢文件。不要用 planned/Ready 或分支存在当作完成。

在届时最新 main 建独立 worktree，分支 `codex/go-only-runtime`。只改本任务范围，正常 merge 必要增量，不重置其他会话工作。先读当前生产注册与全部 wire 的依赖，再改，不能按旧 switch 数量机械删段落。

## 2. 已确认的迁移结构

- `apps/api-go/internal/legacyproxy/proxy.go` 同时承担路由优先级、Go handler 注册、CORS/404/指标标签以及 `httputil.ReverseProxy`。`ModeLegacy/Shadow/Canary/Go`、`New(legacyURL, rules)`、`ServeLegacy`、`ServeHTTPWithShadow` 是过渡 API。
- `cmd/api/main.go` 的 `dispatcher`、Executant、shadowRunner/canaryRouter、约 137 个 mode 的路由/wire 条件与 `LEGACY_API_URL` 是共享核心。不能删 proxy 目录后用空成功/固定 404 代替现有 Go handler。
- GraphQL `handler.go`、`exec` 与 `graphqlsubscriptions/connection.go` 仍有 `KindLegacy`/整份 operation 回退；WS namespace/订阅也有迁移期所有权条件。
- 第一批已经迁出契约与工具，必须继续使用其实际 Go 注册对照；不能为删旧路由测试取消 HTTP/root 覆盖门禁。

## 3. 实际改为 Go 独立路由

用明确的 Go 路由/dispatcher 替代旧网关中的**运行能力**，只保留真实需要的匹配、handler 注册与请求处理。保留 METHOD+完整路径、exact/prefix/动态段优先级、URL/编码、尾斜杠、HEAD/OPTIONS、CORS、公开探针、Swagger开关/静态资源、metrics/内部鉴权和未知路径语义。不能用通用 `/api/` 成功 handler 掩盖遗漏。

未知方法/路由按当前 Go-only/reject 契约返回；既有 nestnotfound 代码若继续承担现行错误格式/trace/异常记录，可以按现行职责改名复用，**不能因名字含 Nest 就删掉必要错误行为**。路由标签保持有界，与已有 HTTP histogram 一致，不暴露 ID/token/query；删掉迁移专用指标不能误删业务指标。

删除真正的 `httputil`→Nest 请求路径、shadow/canary 包与分派器、legacy URL/代理健康依赖，不能仅改目录名或保留永远不应触发的旧 proxy 作为隐蔽后门。保留正常业务向 LiteLLM/crawl4ai/vector/AIS 等上游 HTTP/WebSocket 调用；它们不属于 Nest 回退。

### GraphQL 与实时链

全部已实现 Query/Mutation/Subscription 通过实际 Registry/Schema 注册；删除执行期整包回 Nest、旧 schema authority 和 legacy transport。未知/未注册 root 在**任何 mutation/入队/外部调用前**按正确协议拒绝，不能先执行已识别字段再因另一字段失败回退或伪造成功。

保留 parse/validation/APQ/GET/POST/batch/depth/complexity/cache/null/default/error/trace 与现有权限 any/all/字段权限、HTTP 200+errors、subscription operation 错误/关闭。现行权限由 resolver 内联兑现的不能随 mode 逻辑一起删除。WebSocket upgrade、Engine.IO/Socket.IO 实际路径、认证与复核、org room、Redis 总线、多实例广播、SSE flush/deadline/取消与关闭顺序保持。

### 配置与后台执行

移除 API_GO 迁移 mode 的解析/枚举/交叉开关门槛与各 wire 的迁移所有权分支，改为明确注册实际 Go 能力。不要留下 137 个永远为 go 的空壳字段或新增“全 Go 总开关”假装完成清理。相关 fixture/测试应转成实际资源与行为约束，不能保留废配置以让测试编译。

**保留**资源/密钥校验、JWT/黑名单/机器令牌/MySQL 权限、orgId 范围、必要事务、真实业务开关，以及 `SCHEDULE_ENABLED`、`BULLMQ_WORKERS_ENABLED`、`WS_REDIS_ADAPTER_ENABLED`、`GRAPHQL_SUBSCRIPTION_BUS` 等现行第二道门。不要把“迁移模式删除”变成后台全部无条件启动。

逐链核生产者→消费者→repeat/cron/租约→outbox补偿→通知/事件桥，单实例与多实例生命周期明确；保留 sharedDB/Redis/Mongo 复用、阻塞连接区分、Start/Close 顺序和关停排空。不得删除原本由 mode 表达的**业务前置**而造成 nil 依赖/静默少注册。

本地/compose 若因本批删除 Go mode 字段需要最小适配，更新 Go 计划与配置校验。Node 独立回退链、其依赖的 legacy 样例与差分测试先留给第三步统一删除；中间阶段文档明确“Go 不再支持 mode 回退，Node 只可作为单独旧链启动”，不能默默破坏仍公开的命令。

## 4. 验证、残留与边界

主要改 `apps/api-go/cmd/api`、config、Go 路由层、GraphQL/订阅接线、迁移专用包与相应测试/必要调用方。HTTP handler 的领域算法/DTO/schema/数据库结构原则上不改；若清理暴露真实阻塞，以精确触发链修最小范围，不能用 stub 或吞错绕过。

保留第一步契约检查，迁移路由覆盖/权限行为测试到实际新路由；新增必要 unknown method/root、混合 operation 无副作用、认证/租户、CORS/404、SSE flush、真实 upgrade/关闭与后台门控测试。删纯 shadow/canary/proxy 机制测试有合理理由，其曾覆盖的 Go 请求契约必须另有实际测试，不能大删测试换绿。

#150 自写 500 异常记录等已知残留继续准确列出，不因旧网关删除而额外缩窄已接通的 REST/GraphQL 记录，不顺手扩成全仓日志重写。保留工具/夹具、BullMQ 协议与官方 Lua 字节约束。

本机只静态阅读、diff、必要 gofmt，不安装或执行 build/test/lint/typecheck/vet/Docker/服务。由现有普通 CI 验证，保持 Web coverage、vector/Go 单元与现有集成、旧 Node 对照尚可运行。只做现有 CI 必要最小适配，不弱化门禁、不新建 smoke、不改 runner。

做只读静态反证：类型/接口/GraphQL、权限/租户、控制流/错误、资源初始化与异步生命周期，成立问题给精确 file:line；必要英文职责/导出注释，具名业务类型，文档/提交/PR 中文。

正常中文 emoji + type(scope) commit/push，Ready PR；不合并/auto-merge/amend/rebase/force-push，只提交自己改动。更新本 task/PR 与直接运行说明，记录真实路由入口、删除的迁移结构、保留第二道门、残留与精确 head/run/逐 job（skipped 不算通过）。不声称部署或实网验证。

第三步 GO-NODE-RETIRE-001 仅在本批实际合入与 CI 后执行，不能提前删除 Node 基线。
