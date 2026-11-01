# ECONOMIC-QUEUE-RECOVERY-001 · 经济数据队列暂停与崩溃恢复

- 状态：`pr_open`；分支 `codex/fix-economic-queue-recovery`，从 main `9ebce09c4fb72f9318443266b295c9501364de3f`（普通 CI [41317912036](https://github.com/wei500L/newwei/actions/runs/41317912036) 三主 job success、两 regen skipped）新建独立 worktree。
- 缺口：`GAP-ECONOMIC-QUEUE-001`，对应[态势/经济复核 EA-02、EA-03 与 EA-补-A1](../../review/situation-realtime.md)：暂停后仍可能领取新/到期任务、崩溃遗留 active 无恢复、已删除 repeat 被在途领取复活。
- 分支建议：`codex/fix-economic-queue-recovery`；本文件由规划分支 `codex/plan-go-functional-next` / 规划 #157 的 task/prompt 复制而来，实现只落地本任务，不合并整条规划分支。
- 产品链：经济数据手工/定时入队 → 暂停/恢复 → 领取/锁续期/处理/终态 → 崩溃后受限恢复 → 经济数据状态与队列运维 UI；沿用 BullMQ 5.63.2 固定协议/夹具。

## 实现范围（本窗口）

- `internal/economicqueue`：worker 改用 vendored BullMQ 5.63.2 官方 Lua（moveToActive / extendLock / moveToFinished / moveStalledJobsToWait / addStandardJob），补齐 meta.paused 暂停语义、锁续期与失败领取取消、stalled 受限恢复（超限写 `defa` 进入可观察 failed）、终态所有权校验（旧 token 不能删除新锁/新 active/覆盖终态）；producer 手工入队走 addStandardJob（暂停时进 paused），`ScheduleNextRepeat` 增加「调度仍存在 + 迭代身份」守卫（`updateRepeat.lua`），删除/替换调度不被在途或恢复任务复活，重复领取不额外生成下一轮。
- `cmd/api/economic_data.go` + `cmd/api/main.go`：生产接线（handler 解 JobData 调 FetchAndPersist）保持；补齐 economicRuntime.Close 到有序 teardown，使锁续期/扫描/领取随 worker 生命周期结束、资源由现有 owner 关闭。
- 可见性：`akshare-data` 已在 `bullmqcleanup.Inventory` 与 queue-ops 控制台管理；Web `queue-ops` 增加 akshare-data 真实形状行为覆盖（计数/暂停标志/暂停恢复）；`akshare-gateway-settings-panel.tsx` 的「最近抓取结果」与队列状态语义保持分离。
- CI：`.github/workflows/ci.yml` 的 `api-go-user-settings-integration` job、queue-ops 注释块之前追加独立经济队列 Redis 集成步骤（`./internal/economicqueue/ -run 'TestEconomicQueueIntegration' -tags=integration`）。
- 测试：真实 CI Redis 7.2 + 受控 handler fixture 覆盖暂停/恢复、有效锁不误收、过期 active 恢复、旧 token 拒绝、超限终态、repeat 守卫与删除不复活、取消/排空；并用锁定 Node BullMQ 5.63.2 夹具双向验证生产/消费协议。不访问真实 AkShare/FRED/Finnhub/Yahoo。

## 交付记录

- PR / head / 普通 CI：见 PR 与最终回填（Ready，不合并、不 auto-merge）。
- 验证边界：本机未运行 build/test/lint/typecheck/vet/Docker/服务；结论以精确 head 普通 CI 的 Go 单元、Web coverage 与新增集成为准；skipped 不算通过；源 CI 不代替 merge CI。未验证真实供应商、生产 Redis 或多实例部署行为。
