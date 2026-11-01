# ECONOMIC-QUEUE-RECOVERY-001 · 经济数据队列暂停与崩溃恢复

- 状态：`reserved`；2026-11-01 已提供[执行提示词](ECONOMIC-QUEUE-RECOVERY-001.prompt.md)，尚无编码 worktree/PR/head/CI。
- 缺口：`GAP-ECONOMIC-QUEUE-001`，对应[态势/经济复核 EA-02、EA-03 与 EA-补-A1](../../review/situation-realtime.md)：暂停后仍可能领取新/到期任务、崩溃遗留 active 无恢复、已删除 repeat 被在途领取复活。
- 基线：main `9ebce09c4fb72f9318443266b295c9501364de3f`；[普通 CI 41317912036](https://github.com/wei500L/newwei/actions/runs/41317912036) 三主 job success，两个 regen skipped。开工刷新 main/CI/认领。
- 分支建议：`codex/fix-economic-queue-recovery`；复用匹配独立工作树，否则创建。文档在规划分支 `codex/plan-go-functional-next` / 规划 #157；未合 main 时只取自身 task/prompt，不合并整条规划分支。
- 当前证据：`apps/api-go/internal/economicqueue/worker.go:78` 直接 BRPopLPush(wait, active)，Run 无 stalled 恢复；`producer.go:67` 和 worker 的 promoteDue 直接写 wait；`ScheduleNextRepeat` 调 storeRepeat 无 repeat 存活守卫。生产入口为 `cmd/api/economic_data.go:168`。
- 产品链：经济数据手工/定时入队 → 暂停/恢复 → 领取/锁续期/处理/终态 → 崩溃后受限恢复 → 经济数据状态与队列运维 UI；沿用 BullMQ 5.63.2 固定协议/夹具。
- 所有权：`internal/economicqueue`、必要的 `internal/economicdata` 与 `cmd/api/economic_data.go`、经济数据/akshare 的既有队列注册与投影最小增量、Web `components/settings/akshare-gateway-settings-panel.tsx` / 必要 queue-ops 行为；不重写其它 worker。
- CI 所有权：在既有 api-go-user-settings-integration job 的 queue-ops 区域前，独立追加经济队列 Redis 集成步骤，命中 `TestEconomicQueueIntegration...`；不改组织审批新增步骤或其它 job。另一任务在靠前 user-settings 区域后追加自身步骤，合并时保留并集。
- 并行边界：可与 `ORG-APPROVAL-RECOVERY-001` 分窗口执行；不改 identityonboarding/org bootstrap/审批 UI/Prisma。共享语言资源只追加自身 namespace，不排序或覆盖其它键；main/config 原则不动。

验收：暂停时已有 active 可按协议结束，手工/到期/恢复入队不被继续领取；恢复后正常处理；有效锁不误回收，过期/丢失锁的 active 按 BullMQ 语义受限恢复，超限终态可见；旧领取者不能删除新锁或覆盖新终态；恢复/重领不重复生成下一轮，删除 repeat 后在途作业不复活调度。停机取消/排空不挂住，新恢复任务不绕过 BULLMQ_WORKERS_ENABLED。

队列状态与最近一次供应商抓取结果分别保持真实语义，不把 stalled 伪装成抓取成功或用旧失败覆盖较新结果。保持既有鉴权/数据归属/队列可见性与失败保留规则，不强加不存在的 orgId，不扩大为 TZ/排序等全部历史差异。

仅补已知协议缺口，不造通用 worker/锁/重试框架，不新增依赖、迁移 mode 或专用 workflow。本机不安装/运行 build/test/lint/typecheck/vet/Docker/服务，测试由普通 CI 的真实 Redis 与受控 handler/供应商 fixture 执行。编码窗口仅更新自身 task/PR，交付 Ready PR、精确 head CI、file:line 静态审查与未验证边界，正常提交/push，不合并/auto-merge/amend/rebase/force-push，不访问真实供应商。
