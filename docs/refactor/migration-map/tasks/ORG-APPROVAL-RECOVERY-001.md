# ORG-APPROVAL-RECOVERY-001 · 新组织审批持久化与失败续办

- 状态：`reserved`；2026-11-01 已提供[执行提示词](ORG-APPROVAL-RECOVERY-001.prompt.md)，尚无编码 worktree/PR/head/CI。
- 缺口：`GAP-ORG-APPROVAL-001`，对应[身份复核 IDENT-03](../../review/identity-core.md)。用户已授权编写这项功能修复提示词，不再受原审查批“只记录”范围限制。
- 基线：main `9ebce09c4fb72f9318443266b295c9501364de3f`；[普通 CI 41317912036](https://github.com/wei500L/newwei/actions/runs/41317912036) 三主 job success，两个 regen skipped；开工刷新 main/CI/认领。
- 分支建议：`codex/fix-org-approval-recovery`；复用匹配独立工作树，否则创建。规划分支 `codex/plan-go-functional-next` / #157；未合 main 时只取自身 task/prompt，不合并整条规划分支。
- 当前证据：`apps/api-go/internal/identityonboarding/application_store.go:62,105` 只读取 pending 并提前 claim 为 approved；`application.go:325-378` 创建组织后缺少可靠申请关联，只在组织创建失败时释放 claim；`invite.go:42-56` 先保存邀请再发邮件，而申请关联在邮件成功返回后才写，失败可留下组织/邀请已存在、申请无法重试的半完成状态。
- 产品链：GET `/api/auth/admin/registration-applications` → 平台管理员 POST `.../:id/approve-org` → 组织/默认角色/邀请及申请关联 → 外部投递结果 → UI 可见进度、失败续办/受控重发；涵盖已发生的半完成申请，不靠手工 SQL。
- 所有权：`internal/identityonboarding`、必要的 `internal/graphqlread/orgaccesswrite` bootstrap 窄事务复用、相应 REST 注册/契约最小增量、Web `components/settings/access-settings-content.tsx` 及相关审批类型/行为；现有字段不足时才做最小 Prisma/schema/migration 与 CI 验证。
- CI 所有权：在现有 api-go-user-settings-integration job 的 user-settings MySQL/Redis 步骤之后，独立追加身份审批恢复集成，命中 `TestOrgApprovalRecoveryIntegration...`；不改靠后的经济队列/queue-ops 步骤或其它 job。
- 并行边界：可与 `ECONOMIC-QUEUE-RECOVERY-001` 分窗口执行；不改 economicqueue/economicdata/经济 UI。共享语言资源只追加自身 namespace；main/config 原则不动，CI 两个新增块各自独占。

验收：申请、实际组织、生成邀请具有持久可信关联；数据库阶段可靠提交/回滚，SMTP 在事务外；失败后从可信进度续办，不重复建组织/邀请，不将已创建组织的申请简单退回 pending。邮件失败与审批数据库结果可区分，显式重发按现有 token 轮换语义执行，平台管理员不因非组织成员而无法恢复，普通邀请的角色限制不放宽。

历史 approved 且缺关联的记录不能仅凭 slug/email 自动猜绑：可可靠识别的恢复，不能识别的提供平台管理员受控确认/绑定与服务端核验、审计。UI 能看到并处理半完成记录；已完成/已接受/已撤销邀请的分支明确，重试不自动重复发信，不承诺 SMTP exactly-once，不新增无关投递/锁/重试框架。

本机不安装/运行 build/test/lint/typecheck/vet/go run/迁移/Docker/服务；必要 schema/集成执行放在普通 CI 的真实 MySQL/Redis 与 fake MailSender，不访问真实 SMTP。本窗口只写业务与自身 task/PR，交付 Ready PR、精确 head 普通 CI、file:line 静态审查和未验证边界；正常提交/push，不合并/auto-merge/amend/rebase/force-push，不批量修生产记录。
