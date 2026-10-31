# GO-NODE-RETIRE-001 · 删除 Node 后端并完成构建与 CI 收尾

- 状态：`merged`；2026-11-01 核实 [#154](https://github.com/wei500L/newwei/pull/154) 实际 merge `e04fc4d8bb54596afd302a309ebc852c7676d958`，最终源 head `44caf2e8e977e39fbe66f5ae8773336d6d1f5f08` 已是 main 祖先；[源 head 普通 CI 41221870780](https://github.com/wei500L/newwei/actions/runs/41221870780) 三主要 job success，两个 regen skipped。
- 最新 main [CI 41242463081](https://github.com/wei500L/newwei/actions/runs/41242463081) 核对时尚未完成，不能拿源 head 替代。源码/编排/CI 退役范围已落地，未部署、未实网验证。
- 规划基线：`fcf1e5334acb0350ea36535c48c4131df7c9698a`；开工须刷新 main。
- 前置：[GO-CONTRACT-TOOLING-001](GO-CONTRACT-TOOLING-001.md) + [GO-ONLY-RUNTIME-001](GO-ONLY-RUNTIME-001.md) 均实际合入，相关源码与普通 CI 通过。
- 提示词：[GO-NODE-RETIRE-001.prompt.md](GO-NODE-RETIRE-001.prompt.md)；规划 PR #149。
- 分支：`codex/retire-node-backends`；实际 worktree `/Users/oo/project/newwei-retire-node-backends`。退役资产/验证去向见 [实际清单](../../node-retirement-inventory.md) 与 [收口记录](../GO-MIGRATION-CLOSEOUT.md)，不再按原 planned 重复派发。
- 所有权：三项 Node app 删除、根/package/锁文件、Docker 镜像/compose、dev 启动器/legacy 回退、既有 CI/workflow、测试搬迁与运行说明。不删 Web、Prisma/seed、共享 Mongo/配置/工具包或 Go 协议夹具。
- 目标：源码与默认构建/开发/CI 均不再依赖三个 Node 后端；Node 与 Go 差分检查改为保留相同业务约束的 Go 单端验证，不能只删 job 让 CI 变绿。

验收：已迁契约/工具/夹具不依赖旧目录；Node-only 单测逐项分类迁移或按实现退役；向量三接口、鉴权/租户、BullMQ/Redis/MySQL/Mongo 与 Web coverage 保留有效门禁；没有遗留不可运行的 workflow、命令或模板路径。

最终交付 Ready PR 与普通 CI、业务等价约束/测试去向表、残留清单。源码删除不代表已部署或实网通过；Prisma/seed 与 Node 工具继续保留，是否 Go 化另定。删除后版本回退依靠正常版本回滚，不保留空壳 legacy 服务。

## 实际落地与交接

- 三个 Node app、旧镜像/legacy profile、回退样例和 dev:legacy、38 个旧手工差分 workflow 已删除。root/compose/dev/CI 对旧 app 不再有可执行依赖；Go 纯路由包保留旧名。
- Web/Prisma/migrations/seed、共享 Mongo CLI、锁定 BullMQ fixture、Go SDL/OpenAPI/鉴权基线继续保留；CI 向量检查改为 Go handler + 真实 CI Qdrant，既有数据库/队列集成与 Web coverage 继续运行。
- 手工差分退役与 Go 单端检查不是全部场景的逐条等价替代；真实外部与多进程组合未验证。异常记录残留不因源码删除关闭。
- 下一检查点为最终 merge head CI 结果与规划 PR #149 文档回填是否合入；不自动启动部署或新一轮迁移。
