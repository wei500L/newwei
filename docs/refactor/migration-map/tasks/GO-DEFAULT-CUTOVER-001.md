# GO-DEFAULT-CUTOVER-001 · 仓库默认运行链切到 Go

- 状态：`planned`；提示词于 2026-10-27 预先给出，**有前置依赖，尚不认领编码文件**。
- 规划基线：`f15f598d4358b4c9823054ef5a355618e1480a4e`；开工必须刷新 main。
- 执行提示词：[GO-DEFAULT-CUTOVER-001.prompt.md](GO-DEFAULT-CUTOVER-001.prompt.md)。
- 前置：[GO-CUTOVER-PREREQS-001](GO-CUTOVER-PREREQS-001.md) 四项实际合入、对应源码复核与普通 CI 通过。
- 编码分支：`codex/go-default-cutover`；建议 worktree：`/Users/oo/project/newwei-go-default-cutover`，尚未创建。
- 编码 PR / head / merge SHA / CI：无；规划记录发布分支 `codex/plan-go-cutover-next`。
- 来源：用户贴出的“全部转 Go、静态审查 + CI、不上生产”阶段 3；前六批与整合 #148 已 merged。
- 默认 / 部署：本规划没有切任何默认值；后续任务只改变仓库配置，不操作真实部署或 `.env`。

## 完整链路与文件所有权

默认 API 全 Go + reject → Web REST/GraphQL/SSE/Socket.IO → vector-go / ais-relay-go；compose 的 migration/index 初始化与依赖图、开发命令、镜像参数、env 样例一并闭合。Node 后端源码与既有对照 CI 保留；Node Prisma/seed/index 工具可以保留为独立工具职责，不能借此默认启动 Nest 服务。

占用 `apps/api-go/internal/config`、必要 `cmd/api` 配置依赖、`apps/web/lib/env.ts` 与相关客户端连接配置、`infra/docker`、`infra/scripts/src/docker-up.js`、根 workspace 命令与文档。共享 main/httpx 在前置任务合入前不触碰。只修默认切换直接暴露的问题，不重做领域审查。

## 验收与交接

代码默认与 compose 解析结果必须全链一致：业务 mode 为 go、fallback 为 reject、canary 为 0；默认服务集合只运行 Go 后端，Web 不再等待 Nest；数据库迁移与 Mongo index 准备有明确独立执行者；显式 legacy 回退包含 Node profile、完整模式清单、地址/路径和执行所有权转换，不能仅改一个 URL。

本机保持纯静态、不安装/运行 build/test/Docker/服务；使用普通 CI 验证，保留本阶段 Nest 对照检查，不扩大既有真实外部服务验证。新默认测试只给资源占位值、不填写业务 mode，防止 all-go.env 显式开关遮蔽错误默认；同时检查 fixture 开关名完整性。

交付 Ready PR 与精确 CI，不合并。共享地图由规划窗口回填；编码窗口更新本任务、直接受影响的 README/AGENTS/运行说明及 PR。本任务合入后再规划删除 Node 后端、双轨代码与契约/CI 迁移，不能并行提前删除基线。
