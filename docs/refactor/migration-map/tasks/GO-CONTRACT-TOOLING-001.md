# GO-CONTRACT-TOOLING-001 · 契约与运维工具迁出待删 Node 后端

- 状态：`reserved`；2026-10-31 提示词已发出，尚无编码/业务 PR 证据。
- 基线：`origin/main fcf1e5334acb0350ea36535c48c4131df7c9698a`，#151 已 merged；源 head `e48a2572` 普通 CI 41199618477 三主 job success；main CI 41200907795 核对时尚未完成。
- 提示词：[GO-CONTRACT-TOOLING-001.prompt.md](GO-CONTRACT-TOOLING-001.prompt.md)；规划发布 PR #149。
- 分支：`codex/go-contract-tooling`；建议 worktree `/Users/oo/project/newwei-go-contract-tooling`，未创建；业务 PR/head/merge/CI：无。
- 目标：在删除 `apps/api` / `apps/vector` / `apps/ais-relay` 前，保留其承载的契约、可运行运维工具、邮件资源与协议夹具，并接通面向实际 Go 实现的检查。
- 所有权：Web codegen、Go SDL/OpenAPI/鉴权与路由基线、依赖旧目录的 Go 测试/Node 夹具、Mongo/回填工具、根命令、相关镜像/compose 工具引用与现有 CI 最小增量。不删除 Node 后端，不移除迁移分流层。
- 前置：读 #151 最终源码与当前 main CI；未核实部署/流量，本任务只做静态与普通 CI。
- 后继：[GO-ONLY-RUNTIME-001](GO-ONLY-RUNTIME-001.md) 必须等本任务实际合入及 CI 后执行；不并开共享文件。

验收：Go SDL/Swagger/权限与 Web 生成链有可维护事实源；运维命令不再需要 Nest 应用模块；协议夹具能独立解析锁定依赖；Node 对照与现有集成暂时保留。不能把“复制静态快照再比较自身”当作 Go 契约门禁，也不能用工具目录重新安置整套 Nest 后端。

交付：Ready PR，不合并、不 auto-merge；普通 CI 精确 head/逐 job、纯静态反证、工具/夹具与旧测试的保留去向；编码更新本 task/PR，规划集中回填共享地图。未部署、真实依赖未验证。
