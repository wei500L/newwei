# REFACTOR 系列通用执行纪律

每个 REFACTOR-* 提示词都引用本文件；执行前必须完整读完并遵守。总计划见 [BACKEND-REFACTOR-PLAN](../BACKEND-REFACTOR-PLAN.md)。

## 开工

1. `git fetch origin main`，从最新 `origin/main` 开始。先读 `AGENTS.md`、`docs/refactor/migration-map/README.md`、`PLANNING.md`、`BACKEND-REFACTOR-PLAN.md`、本文件和自己的任务文件。
2. 核对前置：任务文件“前置”列出的任务必须已实际 merge 进 main（`gh pr view <n> --json state,mergeCommit`），且其 head 的普通 CI 成功。未满足就停止，并报告原因。
3. `gh pr list --state open`：如果有其他 REFACTOR-* PR 改到你计划改的文件，先读它的 diff。你的改动要能和它合并，而不是覆盖它。
4. 独立 worktree：`git worktree add /Users/oo/project/newwei-<slug> -b codex/<slug> origin/main`，`<slug>` 用任务文件给出的值。只在这个目录改动，不碰其他工作目录。
5. 提示词里的文件/行号/数量是规划基线 `18c41879858d` 时的事实。开工后先用 grep 重新核对；如果事实已变（文件改名、问题已被修、数量不同），以真实源码为准，并在 PR 中说明差异。

## 改动原则

- **这是重构**：对外 HTTP/GraphQL/Socket 响应体、状态码、Redis key 名、Mongo/MySQL 存储格式、BullMQ wire 格式保持不变。只有任务明确列为“有意变更”的行为可以改，并在 PR 里逐条写出。
- 保留鉴权、`orgId` 租户过滤、业务校验与必要事务。合并重复实现时，如果副本之间存在差异，先判断哪一份是正确语义（以业务意图和安全为准，不以“多数派”为准），在 PR 的“差异处理表”里逐条记录：副本位置 → 原行为 → 统一后行为 → 理由。
- 删除重复实现时整段删除旧副本，直接改调用点；不留只做转发的 wrapper，也不留“兼容旧名”的别名。
- 不做防御性堆砌：不为“以防万一”新增锁、重试、开关、兼容层或配置项。只加任务要求的东西。
- 业务数据用具名强类型，不新增 `map[string]any`/`interface{}` 承载业务字段（驱动/协议边界除外，扩展 JSON 叶子用 `json.RawMessage`）。
- 新增或修改的 Go 注释用**英文**，写职责、契约与原因，不逐行复述代码。被你改动的代码附近如果有已失效的注释（“NestJS 等价”“shadow”“legacy”“开关为 go 时”“回落 Nest”等），顺手改成当前事实或删除；不要大面积改无关文件的注释（那是 HTTP-ROUTER 任务的范围）。
- 被删副本的单元测试：断言有价值的迁到新共享包的测试里；调用方测试的断言保持不变，这是等价性的主要证据。不要新增源文本扫描或快照类测试。
- 本任务是纯后端重构，不需要改 `apps/web`。如果任务里有“有意变更”影响前端，按任务说明处理。

## 验证

- 本机**不**安装依赖，**不**运行 `go build` / `go test` / `go vet`、Docker 或任何服务。允许运行 `gofmt -l` / `gofmt -w`（只格式化自己改过的文件；`cmd/api/main_test.go` 原本就不符合 gofmt，不要格式化它），以及 grep/find 等静态核对。
- 交付前自查：
  - 每个删除的符号都 `grep -rn` 确认没有残留引用；
  - import 没有未使用或缺失；
  - 所有 `go` 语句、`defer`、错误分支都读过一遍；
  - 对照“等价陷阱”清单逐条确认。
- push 后用普通 CI（`.github/workflows/ci.yml`）在**精确 head SHA** 上的结果作为唯一的运行证据。先 `gh run watch <id>`，然后**必须**再执行 `gh run view <id> --json conclusion,headSha,jobs` 确认结论（watch 的退出码不可信）。skipped 不算通过。CI 失败就修，修完再看新 head 的结果。

## 提交与交付

- 提交信息用中文 emoji + `type(scope)`，例如 `♻️ refactor(api-go): 统一机器令牌鉴权`、`🐛 fix(api-go): ...`。可以分多个逻辑提交。只 stage 自己的改动，不提交 `.env` 等密钥文件或无关文件。
- 正常 push，创建 **Ready PR**（不是 draft）。PR 描述用中文，包含：动机、改动清单、差异处理表、有意行为变更、等价性论证、未验证项（如实写“未在本机构建/测试，未连接真实服务”）。
- 不合并、不开启 auto-merge、不 amend、不 rebase、不 force-push。main 前进时用 `git merge origin/main`，提交信息 `🔀 chore(api-go): 合并 origin/main（保留 X 与 Y）`，冲突逐块保留双方。
- 交付后在自己的 `tasks/<ID>.md` 末尾“交付记录”里填写：分支、PR 链接、最终 head SHA、CI run 链接与结论、实际范围与排除项、剩余问题。不改 README/GAPS/BACKLOG 等共享地图，由规划窗口统一回填。

## 自主空间

提示词里的方案是规划窗口读源码后给出的，方向和陷阱已经核过。你可以在这个基础上自主补充优化（比如发现了第 N+1 份副本，或者更简单的接口），底线是上面的契约等价和差异记录。没有证据的“优化”不要做。
