# Go 后端迁移源码阶段收口 · 2026-11-01

## 核对基线与完成范围

本次核对 `origin/main = e04fc4d8bb54596afd302a309ebc852c7676d958`，仅复核三项退役任务、关键生产入口和 CI 去向，不冒充全量业务/安全审查。三个源 head 均已通过 `git merge-base --is-ancestor <head> origin/main` 确认可达。

| 任务 | 实际 PR / merge | 最终源 head | 源 head 普通 CI |
|---|---|---|---|
| GO-CONTRACT-TOOLING-001 | [#152](https://github.com/wei500L/newwei/pull/152) → `f22e36ae6fabf72c501ae2ad573eb3323fa0db35` | `eff23a09f59b67220496be6cb1f50a0537e6ea82` | [41205126554](https://github.com/wei500L/newwei/actions/runs/41205126554) success |
| GO-ONLY-RUNTIME-001 | [#153](https://github.com/wei500L/newwei/pull/153) → `e72440e186acbdf671be904cc98d1dd2f9858cbf` | `fd571dac7a09630985af85c12c7b1aa45f5c6773` | [41213872179](https://github.com/wei500L/newwei/actions/runs/41213872179) success |
| GO-NODE-RETIRE-001 | [#154](https://github.com/wei500L/newwei/pull/154) → `e04fc4d8bb54596afd302a309ebc852c7676d958` | `44caf2e8e977e39fbe66f5ae8773336d6d1f5f08` | [41221870780](https://github.com/wei500L/newwei/actions/runs/41221870780) success |

三个源 CI 的 `verify`、`vector-integration`、`api-go-user-settings-integration` 均 success；两个 label 门控 regen job skipped，不算通过。#152 / #153 的 main merge CI（41206440581 / 41217516053）也已 success。

**最新 main merge CI**：[41242463081](https://github.com/wei500L/newwei/actions/runs/41242463081)，精确 head `e04fc4d8bb54596afd302a309ebc852c7676d958`，2026-11-01 后续核对已 completed/success：verify、vector-integration、api-go-user-settings-integration 均 success；go-modules-regen、contract-baseline-regen skipped。这是 merge head 的独立证据，不以源 PR CI 代替。

## 已静态确认的当前事实

- `apps/api`、`apps/vector`、`apps/ais-relay` 已不在 main 的 Git tree；`internal/canary`、`internal/shadow`、`internal/shadowidentity` 已移除。
- `apps/api-go/internal/legacyproxy` **保留了旧包名，但已是纯 Go HTTP 路由器**。`proxy.go` 的 `New(rules)` / `ServeHTTP` / `Reject` 只分派已注册 Go handler 或生成 404，无 `httputil.ReverseProxy`、legacy URL、模式状态或旁路执行；不能只看目录名判为仍有 Nest 回退。
- `internal/config/config.go` 不再读取 137 个迁移 mode；GraphQL 无 `KindLegacy`/整包代理，后台保留真实业务/资源与 `SCHEDULE_ENABLED`、`BULLMQ_WORKERS_ENABLED` 等第二道门。旧注释或错误文案提及 mode 不是运行开关。
- Web codegen 使用 Go 所有 SDL；Swagger/OpenAPI、鉴权矩阵、协议 fixture 与 Mongo 索引/回填入口已有独立归属。主命令/compose 不再包含三个旧 app 或 `dev:legacy`/legacy-node。Prisma schema/migrations/seed、Web 与必要 Node 工具仍保留，未要求工具链全部 Go 化。
- 普通 CI 保留 Web coverage、Go 两模块测试/build、Go 注册/契约检查与 MySQL/Redis/Mongo/BullMQ 集成。向量验证已改为 Go handler + CI Qdrant 的 `TestVectorContractIntegration`，对健康、token、upsert/search、orgId 与错误响应作独立断言。

资产保留与旧检查去向见 [契约/工具清单](../contract-tooling-inventory.md) 和 [Node 退役清单](../node-retirement-inventory.md)。旧 38 个手工差分 workflow 已退役；Go 单端验证不宣称逐条等价替代所有原多进程/真实外部依赖组合。

## 保留边界与后续检查点

- 三项 task 均可标 `merged`；这表示源码/仓库退役目标已落地，不代表没有任何业务缺陷或所有已知 GAP 均关闭。
- GAP-EXCEPTION-WIRING-001 的部分 handler 自写 500、unknown/stack 记录残留继续保留；GAP-ASYNC-001 的真实多实例/外部运行证据仍未完成。契约门禁核真实注册覆盖与权限表结构，不是全量运行期鉴权证明。
- **未部署、未承接真实流量、未连接真实业务外部服务**；CI 测试容器不等于生产或实网验收。此口径符合本轮约定，不据此自动安排部署或新增工具 Go 化任务。
- 本次仅静态源码/配置/任务与 GitHub 证据核对；本机未安装或运行 build/test/lint/typecheck/vet/Docker/服务，没有修改业务或真实 `.env`。
- 规划 PR #149 尚未合并，负责发布本记录和任务事实回填；旧 main 迁移地图的 dcbe563b 覆盖数是历史快照，不应继续当作当前默认或任务占用。

最新 merge SHA 的普通 CI 结果已回填；规划文档仍由 #149 发布。用户后续要求继续提示词，已根据当前源码预留 [CRAWL-TABLE-NORMALIZATION-001](tasks/CRAWL-TABLE-NORMALIZATION-001.md) 与 [MONITOR-GEOCODING-001](tasks/MONITOR-GEOCODING-001.md)，下一检查点是两项实际编码 PR/head/普通 CI，不重新派发三项退役，也不自动部署。
