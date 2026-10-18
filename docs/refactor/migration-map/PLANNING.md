# 后续迁移规划规程

本文件是用户长期偏好的稳定入口。适用后端迁移规划、执行提示词、进度更新；代码事实仍以最新 main 为准。返回[入口](README.md)。

## 新对话恢复与增量刷新

1. 读 README、本文件、[任务索引](tasks/README.md)；不得只看历史聊天/旧工作目录。
2. 在实际仓库执行 `git fetch origin main`、`gh pr list --state open`、`gh run list --branch main --limit 5`、`git worktree list`；检查适用 AGENTS.md。禁止在旧 checkout 上据工作文件推断 main。
3. 取 `git rev-parse origin/main`，与地图记录 SHA 比较。查看 `git log <旧SHA>..origin/main`、`git diff --name-status <旧SHA>..origin/main -- apps/api apps/api-go apps/vector-go docs/refactor`；先核对期间新增合并与候选域变更，不每次全仓重扫。路径改名/契约生成变化必须跟踪。
4. 核对开放 PR 的精确 diff、head SHA、worktree 的 HEAD/状态与任务文件。原 PR 未显示 merged 时，查 integration PR、祖先关系与 main 实际实现；worktree 干净/存在都不代表完成/活跃。
5. 读候选域文档，再读最新 Nest Controller/Resolver/DTO/service、Go handler/业务服务、生产 Registry、main.go 和 legacyproxy/config。排除已实现、已合并、已预留、开放 PR 覆盖范围。
6. 选择完整产品链路，建立或更新一个独立 task 文件（见模板），明确精确入口、权限、文件所有权、依赖和排除项。正式发出提示词前再次核对认领。
7. 输出可直接执行的提示词，保存稳定路径；更新任务状态与模块占用。最后留交接：新基线、已核实事实、任务 ID/提示词、PR/CI、剩余问题、下一次检查点。

## 长期偏好（用户明确要求）

1. 目标是 `apps/api-go`；`apps/api` 暂时保留。生产 Web → NestJS 入口保持，canary 默认关闭。
2. 新迁移模块独立 `API_GO_*_MODE`：接受空串/legacy/go，默认 legacy，非法值启动失败，回滚通常改 legacy。已有 onboarding/UI-read 的 shadow 兼容语义按源码保留，不擅自统一。
3. 规划代理只看进度、选范围、维护记录、编写执行提示词，不直接修改业务代码。
4. 编码任务独立 worktree，创建 **Ready PR**；不合并、不启用 auto-merge，不 amend/rebase/force-push。提交中文 emoji + type(scope)，正常 push，只提交自己的改动。
5. 更重视迁移和功能：不堆防御性编程，不为凑任务增加锁/重试/框架/兼容层，不要求固定 bug 数。可以优化现有功能、查询、算法。批量适中偏大，通常 7–20 个相关入口，优先完整产品链路，不机械凑数。
6. 保留鉴权、租户隔离、业务校验、必要事务和已有安全约束；不随意改 Nest Controller/Resolver 装饰器与签名。
7. 不把大量测试建设当每批主体；不安装包，不在本机运行 go build/go test、Docker 或服务启动。本次建图也不运行本地 build/test。
8. 使用已有普通 GitHub Actions CI；不默认新增每批专用 smoke workflow。远端检查要记录精确 head SHA、结果和链接，skipped 不是通过。
9. Go 业务 DTO、返回模型、数据库 JSON、缓存、审计均用具名强类型；禁止 any/interface{}/map[string]any/[]any 承载业务数据。通用 GraphQL/驱动协议边界可沿用，扩展型 JSON 叶子可用 json.RawMessage。
10. 新增/修改源码注释用英文；提交、PR 描述和迁移文档用中文。
11. BullMQ worker、cron、入队和未验证外部服务单独识别。读接口也要检查 ensure coverage、准备任务、repeat 注册、同步和真实上游调用，禁止当普通本地 CRUD。
12. 不伪造 SMTP、LiteLLM、crawl4ai、Nominatim、Telegram/Oref、AkShare 等真实验证结果。
13. 不自动创建 Codex 新对话，不向其他对话发送消息，不创建定时任务。用户说“新开窗口执行”时默认提供提示词，另有明确授权才操作对话。

## 证据与统计

优先级：origin/main 实现/注册/接线 > PR/commit/diff > Actions 精确 head SHA > 开放 PR/分支/worktree 实际差异 > docs/refactor 报告 > 历史提示词/聊天/分支名。每条源码定位保存仓库路径、符号及核对 SHA，必要时加行号。行号不能脱离提交独立使用。

HTTP 标识是 METHOD + 全局前缀 + Controller + 方法路径；核对 Controller 是否装配、Go handler、规则开关和 main 初始化，以及业务是否还转发 Nest。同一路由在文档/规则/测试/handler 只算一次。GraphQL 按 Query/Mutation/Subscription 分开，从 SDL、Resolver、生产 Registry、main 条件交叉核对；测试假 root 与重复模型不计。记录根/字段权限、总读开关与子开关组合、写开关独立性、返回模型依赖与整份 operation 回退。

只对已核对分母给精确数；标明来源与范围。分开统计注册覆盖、业务实现和部署启用；不发布“全后端迁移 X%”。部分迁移必须列出剩余入口。未知项写具体问题与补查位置，继续查可查事实，不能用“待完善”掩盖整个未迁移域。

## 状态定义与事实分层

| task 状态 | 定义 / 升级所需证据 |
|---|---|
| planned | 已保存具体范围，尚未占用；是否发出提示词另记 |
| reserved | 已认领或历史提示词已发出，但没有开工证据；占用有效 |
| in_progress | worktree 有对应范围的开发证据；执行器活跃与否另记 |
| pr_open | 已有开放业务 PR，保存 URL/head SHA；Ready 单独确认 |
| merged | 实际范围已在 origin/main，保存实际 merge SHA（可来自 integration） |
| cancelled | 明确取消并记录理由、残留分支/改动与释放范围；不能根据沉默自动取消 |

每个模块与任务分别记录：提示词发出、认领、开发、PR、合并、生产 Go 实现/注册、普通 CI、额外集成验证、默认/可见开关、实际部署和生产流量。merged 不自动意味着 CI 通过、开关 go 或已切流；legacy 不代表没有实现；引擎支持 Mutation 不代表业务 Mutation 已注册。

## 并行认领与接线冲突

- 一个任务一个稳定 ID、分支、worktree、task 文件。历史已发出但执行不明必须保留占用线索，不悄悄再分配。
- 新任务前读任务记录、开放 PR 与 worktree；无 PR 也不能忽略本地改动。记录是否提交/推送/所在 PR；本地未发布记录不视为其他机器可见。
- 多机器并行前将认领文档正常提交并推送到可见 PR，再刷新确认。Git 文档不是原子锁；若发现冲突认领，暂停冲突范围并按已有认领/依赖顺序处理，禁止引入数据库/分布式锁/机器人/定时协调服务。
- 核心业务文件重叠时改选任务或明确先后依赖。共享 `cmd/api/main.go`、`config.go`、legacyproxy、GraphQL 模型注册、compose/env 文档只允许任务所需最小增量，必须保留其他分支并集；禁止整段覆盖、删其他开关或假设只开本任务开关。
- 设置写与工作台写均需扩展 GraphQL 顶层接线：路由启用 OR 条件、sharedDB/auth/Redis 初始化、独立写开关和模型复用。合并顺序不固定，第二批必须在当时 main 上读懂第一批增量并正常合并，禁止 rebase。

## 执行提示词与完成交接

用 [模板](templates/migration-task.md)补齐具体目标、精确 root/权限、DTO/default/null/error 事实源、DB/缓存/副作用、实际优化、允许文件、共享接线、排除、开关、验证、地图更新与 Ready PR。模板只是结构，删掉不适用段落，不用空泛套话。

交付时更新自己的 task、域页具体入口、优化与缺口，保存 PR/head SHA/普通 CI/额外验证。PR 开着时仍 pr_open，main 页覆盖数不提前增加；可在域页附候选实现说明。只有确认 main 代码与实际 merge commit 才标 merged。CI、开关与部署各自独立更新。若 integration 合入多批，逐 root/路由核实其落地范围，不能机械沿用原 PR 状态。

交接必须让下一对话只读入口、相关域与任务，就能知道：哪些已经实现、哪些被占用、哪些是真缺口、哪些证据尚缺，以及下一条需要执行的 read-only 核对。不要要求重贴历史聊天。
