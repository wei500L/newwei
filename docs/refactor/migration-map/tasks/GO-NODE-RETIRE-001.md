# GO-NODE-RETIRE-001 · 删除 Node 后端并完成构建与 CI 收尾

- 状态：`planned`；2026-10-31 预先给出提示词，前置未完成，不占用编码文件。
- 规划基线：`fcf1e5334acb0350ea36535c48c4131df7c9698a`；开工须刷新 main。
- 前置：[GO-CONTRACT-TOOLING-001](GO-CONTRACT-TOOLING-001.md) + [GO-ONLY-RUNTIME-001](GO-ONLY-RUNTIME-001.md) 均实际合入，相关源码与普通 CI 通过。
- 提示词：[GO-NODE-RETIRE-001.prompt.md](GO-NODE-RETIRE-001.prompt.md)；规划 PR #149。
- 分支：`codex/retire-node-backends`；建议 worktree `/Users/oo/project/newwei-retire-node-backends`，未创建；业务 PR/head/merge/CI：无。
- 所有权：三项 Node app 删除、根/package/锁文件、Docker 镜像/compose、dev 启动器/legacy 回退、既有 CI/workflow、测试搬迁与运行说明。不删 Web、Prisma/seed、共享 Mongo/配置/工具包或 Go 协议夹具。
- 目标：源码与默认构建/开发/CI 均不再依赖三个 Node 后端；Node 与 Go 差分检查改为保留相同业务约束的 Go 单端验证，不能只删 job 让 CI 变绿。

验收：已迁契约/工具/夹具不依赖旧目录；Node-only 单测逐项分类迁移或按实现退役；向量三接口、鉴权/租户、BullMQ/Redis/MySQL/Mongo 与 Web coverage 保留有效门禁；没有遗留不可运行的 workflow、命令或模板路径。

最终交付 Ready PR 与普通 CI、业务等价约束/测试去向表、残留清单。源码删除不代表已部署或实网通过；Prisma/seed 与 Node 工具继续保留，是否 Go 化另定。删除后版本回退依靠正常版本回滚，不保留空壳 legacy 服务。
