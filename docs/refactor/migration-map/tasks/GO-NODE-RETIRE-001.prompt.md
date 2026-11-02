# 第三步：删除三个 Node 后端，完成构建/编排/CI 收尾

执行 `wei500L/newwei` 的 **GO-NODE-RETIRE-001**。删除 `apps/api`、`apps/vector`、`apps/ais-relay`，把默认开发、镜像、运维与 CI 收口到 Go 后端；保留 Web 和必要 Node 工具。本阶段是仓库源码清理，不是生产部署或数据库迁移。

## 1. 严格核对前置与范围

读 AGENTS、迁移地图 README/PLANNING/GAPS/任务索引、本 task、前两任务实际 PR/交付/残留。规划文件在 PR #149，未合入时只读取得；业务仍从最新 main 开始。

fetch main，查精确 SHA、开放 PR/认领/worktree/普通 CI。**GO-CONTRACT-TOOLING-001 与 GO-ONLY-RUNTIME-001 均须已实际合入并有相应普通 CI 通过**；逐项核对契约/工具/fixture 已独立、Go 无迁移回退且实际路由/后台完整。规划基线 `fcf1e533` 只有默认切 Go，还不满足这两个前置，不能直接从旧基线删目录。

在届时最新 main 建独立 worktree，分支 `codex/retire-node-backends`。没有前置时先只读说明具体缺项，不抢共享文件；不 reset/stash/覆盖其他会话工作，正常 merge 必要增量。

## 2. 删除前逐项留住能力

复核前两批的“旧入口→新入口→真实消费者→验证”清单与剩余可执行依赖。扫描源码 import/ReadFile、生成器、package scripts、Docker build/COPY/command、compose、dev 启动器、CI/手工 smoke 与 fixture 模块解析；历史文档/注释里的 Nest 参考允许保留原 SHA，不等于运行依赖。

必须已经有独立去向：GraphQL SDL/Web codegen、OpenAPI/Swagger、权限/HTTP/root/订阅覆盖基线、邮件资源、Mongo 索引/裁剪/回填/reconcile 等被使用工具、BullMQ/Telegram/Socket.IO 的锁定 Node 协议夹具、vendor Lua 来源/许可证。发现仍依赖待删目录的活跃能力，先在本批最小补齐或明确真实阻塞，不直接删到 CI 不再运行。

**不删除** `apps/web`、`packages/db` 的 Prisma schema/migrations/seed、共享 Mongo/配置/工具/Web 依赖、Go 实现/业务协议夹具；不要求它们都 Go 化，不把这部分 Node 工具称为 Node 后端。

## 3. 源码、依赖与启动收尾

删除三项 Node 后端、其专属 Nest/Node HTTP 启动器与独有实现依赖，清理根 scripts/workspace/package 引用、锁文件相应 importer 和镜像/compose。第三方版本保持，复用第一步已有工具依赖；不能删除整个 pnpm-lock、升级全树、关闭 frozen-lockfile 或移除 Go module 漂移检查。无需本机安装，锁图精确变更由已有 CI 验证。

`infra/docker/runtime.Dockerfile` 不再生成 Nest SDL/构建三个旧 app，Web 与一次性 Prisma/Mongo 工具只消费它们真正需要的产物。默认 `migrate → mongo-indexes → api-go → web`（以当时实际依赖图为准）、初始化失败阻断与资源/密钥约束继续有效；不能通过移除迁移/index 来绕开旧镜像依赖。NEXTAUTH_SECRET 仍运行期，不引入 build ARG。

移除 legacy-node 服务/profile、旧 Dockerfile、legacy rollback env/override、pilot 切流命令与 `pnpm dev:legacy` 分支。`infra/scripts/src/dev-config.ts` 当前还从迁移样例加载137开关，清理后只保留实际 Go 资源/端口/调用地址/显式环境覆盖与 Go AIS 独立命令；不能让默认启动器因为删除样例而失败。

保留 #151 已补齐的根 `.env` 加载、cwd 独立、每进程端口、共享资源/密钥、数据库 URL 派生、信号与进程组关闭/错误码。删掉只有 legacy 计划需要的代码和测试，不重写整个进程管理器。Go 容器间与宿主地址、CORS、Socket.IO 两条路径、LiteLLM 回调继续正确。

删除过期的 API_GO mode/LEGACY_API_URL/SHADOW_*/CANARY_* 示例与环境校验字段，保留真实功能开关和资源；共享 Node 工具仍消费的业务配置不能一起删。删除后运行回退是正常版本回滚，不保留空壳代理、隐藏 Node 服务或“legacy”命令实际启动 Go 的假回退。

## 4. 用 Go 验证替换失去 Node 基线的 CI

在现有 `.github/workflows/ci.yml` 内调整，不新建每批 smoke、不改 runner。保留 lint/typecheck/Web 组件 coverage 与既定阈值、Go 两模块单测/build、真实 CI 服务的 Qdrant/MySQL/Redis/Mongo/BullMQ 集成与契约漂移检查。

旧默认 CI 中必须有具体替代：

- `@modular/api test` 的 SEC-01/API-01/权限/限流/路由等**业务约束**，列出原行为→现有/补充 Go 验证；纯 Nest 实现单测可随实现退役，不能把所有安全回归一并删掉。不要为保留 TS 测试把 Nest 后端重新搬进 tests/tools。
- `@modular/vector` Vitest 与 `apps/vector/src/integration/vector-go-diff.test.ts`：迁出并重写成真实 **Go 单端 + CI Qdrant** 的契约检查，覆盖 `/healthz`、`/v1/upsert`、`/v1/search`、内部 token、orgId 过滤、错误/返回等原有实际契约，不新增原服务没有的 API。预期来自已保存契约与独立断言，不能用 Go 请求结果生成同一次运行的预期再自比。
- 旧 OpenAPI/Auth/SDL 的 Nest 扫描/再生成与 contract-regen：改为第一步真实 Go 注册/契约来源的检查/再生成；保留确定性、实际源码/注册漂移和 Web generated.ts drift，不把命令删空或改为原样复制快照。
- Go 集成 job 的 `pnpm install --filter @modular/api...` 改为明确协议 fixture/tool 包，仍使用锁定 BullMQ 5.63.2 与已有 Node 互操作测试，不因删除 API 目录跳过测试。

逐项处理 `.github/workflows/*smoke*.yml`、vector pilot 与其它脚本：纯 legacy/shadow/canary 机制验证可明确退役；仍检查 Go REST/GraphQL/订阅/WS/worker/租户的断言迁到可运行 Go 检查或保留改写后的 workflow。不留下调用已删 `apps/api/dist`、关闭无关宿主进程或依赖已删目录的手工工作流，也不批量删所有 smoke 而不说明验证去向。

若某条旧检查事实上从未覆盖 Go，不夸大为“等价迁移”；如实列出补上的断言与剩余边界。脚本/测试需要变更时用实际返回/事件/API 行为断言，不做源码字符串测试，不恢复 API Jest/Nest e2e 体系。

## 5. 最后静态复核与交付

检查默认/开发/compose/CI/工具链对旧 app 的**可执行引用为零**；别用忽略旧路径/全局替换字符串伪造结果。核无悬挂 package/锁 importer、COPY/模板路径、生成/fixture cwd、缺资源与新版本启动误入旧模式。

复核类型/GraphQL、错误路径、orgId/权限与多实例/异步执行权；第一步契约与第二步 Go 路由、SSE/WS/auth/后台门控测试继续有效。#150 已知异常记录残留仍准确列出，不因大删源码统一关闭所有 GAP；不把代码注释中的历史 Nest 定位全改成当前已验证。

本机只静态阅读、diff、必要 gofmt；不装包或运行 build/test/lint/typecheck/vet/Docker/服务，不执行真实迁移/seed/index/回填、不部署、不连外部服务。由已有普通 CI 验证最终精确 head，失败按日志修原因；skipped 不算通过、不靠重跑掩盖不稳定。

源码注释英文、具名业务类型，中文文档/提交/PR。同步 README、AGENTS、实际命令/服务/端口/保留 Node 工具与测试/契约维护说明，历史快照按基线保留；编码更新本 task 和 PR，共享地图由规划窗口维护。

正常中文 emoji + type(scope) commit/push，创建 **Ready PR**，不合并/auto-merge/amend/rebase/force-push，只 stage 自己变更。交付删除范围、资产保留去向、旧 CI→新验证矩阵、精确 head/run/逐 job、静态反证与实际残留。准确称“仓库已移除 Node 后端与迁移过渡结构，源码/CI 完成”，不得称已部署/真实流量或外部调用已验证。
