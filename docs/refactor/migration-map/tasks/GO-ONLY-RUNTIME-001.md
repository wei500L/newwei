# GO-ONLY-RUNTIME-001 · Go 运行时移除迁移分流

- 状态：`planned`；2026-10-31 预先给出提示词，前置未完成，不占用编码文件。
- 规划基线：`fcf1e5334acb0350ea36535c48c4131df7c9698a`；开工须刷新 main。
- 前置：[GO-CONTRACT-TOOLING-001](GO-CONTRACT-TOOLING-001.md) 实际合入与普通 CI。
- 提示词：[GO-ONLY-RUNTIME-001.prompt.md](GO-ONLY-RUNTIME-001.prompt.md)；规划 PR #149。
- 分支：`codex/go-only-runtime`；建议 worktree `/Users/oo/project/newwei-go-only-runtime`，未创建；业务 PR/head/merge/CI：无。
- 所有权：`apps/api-go` 的 main/config/路由/GraphQL/订阅及 wire、迁移专用测试与最小调用方适配；不删除 Node app 或它们的对照 CI。
- 目标：去掉 reverse proxy、shadow/canary/137 mode 路由门控与 GraphQL legacy operation 回退，保留实际 Go handler、鉴权/租户、CORS、404、SSE/WS、后台执行与资源校验。
- 后继：[GO-NODE-RETIRE-001](GO-NODE-RETIRE-001.md) 等本任务合入再做 Node/编排/CI 删除。中间阶段旧回退工具仅用于独立 Node 链，不承诺 Go 网关仍支持模式回退。

验收：真实 Go 路由元数据与前一批契约检查继续工作；无请求可转 Nest；未知 GraphQL root 在任何副作用前按协议拒绝；安全头、指标、异常、租户绑定和后台第二道门不被一起删掉。不能只重命名 legacyproxy 或把旧反代代码换目录保留。

只做静态与普通 CI，不本机运行/安装/部署；Ready PR 不合并，按精确 head 回填证据，历史基线与实际运行证据保持分层。
