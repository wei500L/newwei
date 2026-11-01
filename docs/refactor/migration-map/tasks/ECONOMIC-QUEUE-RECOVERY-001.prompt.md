你在 newwei 的独立编码窗口执行 `ECONOMIC-QUEUE-RECOVERY-001`。完成经济数据 akshare-data 队列的暂停/恢复与崩溃恢复，贯通生产 worker、repeat、终态和现有 UI，提交并 push，创建 Ready PR。不要停在调查/方案，不合并、不启用 auto-merge。此前 #158/#159 与迁移退役已完成，不重做或恢复 Node 后端。

先读仓库 AGENTS.md、`docs/refactor/migration-map/README.md`、`PLANNING.md` 与本 task。fetch 最新 main，检查开放 PR/worktree/认领；复用匹配独立工作树，否则创建，分支建议 `codex/fix-economic-queue-recovery`。基线 `9ebce09c4fb72f9318443266b295c9501364de3f` 普通 CI 41317912036 三主 job success、两个 regen skipped。记录当前真实 head/CI，不沿用旧结论。规划分支 `codex/plan-go-functional-next` / #157 未合 main 时，只取本 task/prompt，不合并整条规划分支。

已确认事实与范围：

- `internal/economicqueue/worker.go` 的 Run 直接 BRPopLPush wait→active，不读 meta.paused，也没有 stalled 恢复；producer.AddManual 和 promoteDue 直接写 wait。仅依靠控制台移动 wait/paused 无法保证后续新任务/到期任务遵守暂停。对应 EA-02 / EA-03 / GAP-ECONOMIC-QUEUE-001。
- claim 写限时锁，但 finishCompleted/finishFailed 当前直接删锁/写终态。新增恢复后必须一起核对锁续期、失锁、旧执行者与新执行者的终态所有权，不能只把 active 搬回 wait。
- ScheduleNextRepeat 在领取后推进，storeRepeat 无 repeat 存活守卫；删除调度后在途/恢复任务可能将其重新写回，对应 EA-补-A1。本次一起处理这个直接相关问题，不扩成所有 cron/TZ/P3 差异重写。
- 生产接线在 `cmd/api/economic_data.go`：handler 解 JobData 后调用经济数据 FetchAndPersist，worker 独立 Redis client 与现有资源/生命周期保持。协议参考仓库锁定的 BullMQ 5.63.2、已有 archivepreparationworker/qualityqueue 等实现和 CI 夹具；不从记忆臆造 Lua/锁协议，也不新增依赖。

完成同一条产品链：

1. 修正入队、到期晋升和领取的暂停语义：手工、repeat/delayed、stalled 恢复都遵守既有 meta.paused/wait/paused 协议；暂停与领取并发时保证原子状态转换，已领取 active 不强行取消，恢复后正常消费。不能只在 Go 里先查 paused 再无条件 pop，也不能用新的局部暂停变量替代现有控制台状态。
2. 加入现有 BullMQ 语义下的 stalled 检测/受限恢复：有效锁与仍在处理的任务不回收；过期/无锁 active 可重新进入正确队列，超过允许恢复次数进入可观察 failed。处理重复扫描、多 worker 竞争、作业 hash 缺失等本链路状态，保留 Redis hash/set/list/事件/保留策略一致性，不靠启动时一次性清空 active 或人工重跑。
3. 把锁续期、领取 token 与完成/失败提交接通。失去所有权的旧执行者不能删除新锁、移除新 active 或覆盖终态；续期/扫描/阻塞领取能随 worker 生命周期结束，Close/Run 的取消与排空不挂住，资源由现有 owner 关闭。落实已有队列协议需要的锁，不新造通用分布式锁/重试/worker 框架，不改其它 worker 的行为。
4. 原子验证 repeat 仍存在及必要的迭代身份后再推进下一轮：删除或替换后的调度不被旧任务/恢复重领复活，重复领取不额外生成相同下一轮，正常抓取失败仍不无故停止有效调度。既有手工任务、frequency/config、失败保留与返回协议继续有效；不要借此改整个 cron 解析器或添加供应商自动重试层。
5. 核对生产接线、权限与可见状态。队列 paused/active/waiting/failed 和经济数据“最近抓取结果”语义分开：恢复后的正常抓取仍写真实数据/状态；终局 stalled 不伪装成抓取成功，确需回写时不能用旧任务失败覆盖较新成功。检查 akshare-data 是否已纳入既有 queue-ops 可见性；必要增量保持平台/队列管理权限，不把全局队列暴露给普通组织，不凭空补租户字段。
6. 核对 Web `components/settings/akshare-gateway-settings-panel.tsx`、现有经济数据状态与必要 queue-ops UI：暂停、恢复后的进展、最终失败/错误可按各自语义正确显示。已有 UI 足够时保留布局并补真实形状的行为覆盖；若有断链则补 API/类型/展示，不新建控制台或无关设置。不得只修 worker 却让页面继续误报完成。
7. 用真实 CI Redis 与受控 handler/供应商 fixture 做必要集成：暂停期间新增/到期任务不被领、恢复可消费；有效锁不误收、丢锁/过期 active 恢复、超限失败；旧 token 不得提交；重复扫描/多 worker 不重复推进 repeat；删除 repeat 后在途不复活；取消/排空可结束。复用固定 BullMQ fixture 交叉验证关键状态/事件兼容，避免只测 helper 或 Redis mock；不要访问真实 AkShare/FRED/Finnhub/Yahoo。

所有权与 CI：

- 拥有 economicqueue、必要 economicdata、economic_data.go、经济队列最小注册/投影及对应经济/queue-ops UI。另一窗口 `ORG-APPROVAL-RECOVERY-001` 拥有身份审批、组织 bootstrap、审批 UI 与必要 schema；不触及其路径。不改整个 main/config；共享语言资源只增加自身键，不整体重排或覆盖其它 namespace。
- 在现有 `.github/workflows/ci.yml` 的 api-go-user-settings-integration job 中、现有 queue-ops 注释块之前追加独立经济队列 Redis 集成步骤，选择 `./internal/economicqueue/ -run 'TestEconomicQueueIntegration' -tags=integration`；如跨到 economicdata 则让对应必要场景也实际命中。审批窗口只在靠前 user-settings 步骤后追加自身块，双方不得改/删除对方步骤；第二个合并者正常 merge 最新 main 保留并集，不 rebase。不要新建 workflow 或放过未执行/被 skip 的测试。
- 使用 CI 现有 Redis/MySQL/锁定夹具，测试隔离并清理自身数据，不 FLUSHALL、不改生产 queue 名协议。只维护本 task 与 PR，不改共享地图/GAPS/认领索引，不提交或清理他人的脏文件。
- 新增业务 DTO、任务/事件/缓存模型具名强类型；协议叶子可用 RawMessage，不能用 any/interface{}/map[string]any/[]any 新承载业务数据；不顺带全包改造既有协议边界。新增/修改源码注释用英文，提交/文档/PR 中文。

验证与交付：本机不安装依赖，不运行 build/test/lint/typecheck/vet/go run/Docker/服务，仅静态检查、diff 检查与必要格式化。对协议/类型、暂停/锁/取消/终态控制流、生产接线、权限与数据归属做纯静态审查并反向复核，保留 file:line，参照 `.workflow/reviews/static-audit.md`，修复本范围问题。只 stage 自己的文件，中文 emoji + type(scope) 正常 commit/push，不 amend/rebase/force-push。Ready PR 说明实际失败场景、修复后行为、协议与验证边界；等最终精确 head 普通 CI，修复本范围失败，记录 lint/typecheck、Web coverage、Go 单元与新增集成的实际结果/链接，skipped 不算通过，源 CI 不代替 merge CI。最终返回 PR/head/CI、静态审查与未验证事项并回填本 task；不合并、不部署、不声称实网或生产多实例验证。
