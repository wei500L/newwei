你在 newwei 的独立编码窗口执行 `ORG-APPROVAL-RECOVERY-001`。完成新组织审批的可靠持久化、失败续办和受控邀请重发，贯通 API/数据库/投递结果/设置 UI，提交并 push，创建 Ready PR。不要停在方案，不合并、不启用 auto-merge。此前迁移退役和 #158/#159 已完成，不重复实施。

先读仓库 AGENTS.md、`docs/refactor/migration-map/README.md`、`PLANNING.md` 与本 task。fetch 最新 main，检查开放 PR/worktree/认领；复用匹配独立工作树，否则创建，分支建议 `codex/fix-org-approval-recovery`。基线 `9ebce09c4fb72f9318443266b295c9501364de3f` 普通 CI 41317912036 三主 job success、两个 regen skipped；重新记录当前精确 head/CI。文档在 `codex/plan-go-functional-next` / 规划 #157，未合 main 时只取本 task/prompt，不合并整条规划分支。

已确认根因与入口：

- IDENT-03 / GAP-ORG-APPROVAL-001：`internal/identityonboarding/application_store.go` 只读取 pending，claim 立即置 approved；ApproveNewOrg 创建组织后，只有 CreateOrg 失败会释放 claim，后续角色、邀请、邮件或关联写失败均可能留下半完成记录，再次 approve-org 因 pending 过滤失败。
- `invite.go` 的 insertAndDeliverInvite 先保存邀请，发信成功后才返回；ApproveNewOrg 随后才 linkGeneratedInvite。因此邮件失败时邀请可能已存在，但申请没有指向它。简单捕获错误再把申请置 pending 会重复创建/撞 slug，不能作为修复。
- 真实入口是 GET `/api/auth/admin/registration-applications`、POST `/api/auth/admin/registration-applications/:id/approve-org`；handler 先认证，Service 再 assertPlatformAdmin。普通邀请/重发在 `/api/auth/admin/invites`，ResendInvite 要求组织管理员；平台管理员可能不是刚创建组织的成员，不能直接套用该权限路径。
- 组织创建复用 `internal/graphqlread/orgaccesswrite.OrgBootstrap`，默认角色/权限/必要审计与缓存行为不得因审批恢复而丢失。Prisma RegistrationApplication 已有 orgId、generatedInviteId、metadata；优先评估这些字段，不从内存或 slug 猜测关联。

完成一条可操作的产品链：

1. 明确并实现最小审批进度模型：申请审核决定、已创建组织、已保存邀请、邮件投递结果分别可识别。数据库阶段对组织/bootstrap、申请组织关联、邀请及其申请关联采用可靠原子提交或足以续办的持久进度；不能在独立创建组织提交后仍留下不可定位的崩溃窗口。需要跨 bootstrap 事务时提供窄复用，保持原 GraphQL 创建组织行为，不复制一套默认角色初始化。
2. 把外部邮件放在事务外，在发信前可靠保存申请→组织→邀请的关联。数据库失败能正确回滚或按可信进度恢复，邮件失败不能抹去已提交结果；响应和读模型能让 UI 区分“审批数据库已完成、邀请投递失败/未知”与审批未完成。不要宣称 SMTP exactly-once，也不持事务等网络、不引入通用邮件 outbox/重试框架。
3. 提供完整失败续办入口，优先复用现有 approve-org/邀请操作；确需新的平台管理员恢复或重发操作时，将 handler、Go 路由注册、权限/OpenAPI 预期及 UI 一并交付。重复/并发请求不重复创建组织或邀请，已完成请求可稳定识别；已接受/撤销/过期邀请分支明确。自动续办不等于自动反复发信，显式重发沿用必要 token 轮换/有效期规则，旧 token 不能仍被误认为有效。
4. 涵盖历史半完成申请：有可信组织/邀请关联的可续办；approved 但无可靠关联的不能按 requestedOrgSlug/email 静默绑定现存组织。给平台管理员可操作的诊断与必要的显式确认/补关联流程，服务端核验申请类型/状态、目标组织、申请邮箱与现存邀请关系，审计记录目标与原因；遇到不一致拒绝，不能靠手工 SQL、删除组织重建或仅记录“需人工处理”结束任务。不得为恢复改已有组织成员/角色、接管无关组织。
5. 保持安全边界：所有新组织审批/恢复/受控重发均在服务端验证平台管理员；actor、admin 角色和邀请归属从服务器可信状态推导。普通 CreateInvite/ResendInvite 的组织成员/可分配角色限制不放宽；平台管理员专用恢复能力不能从普通邀请请求进入。不提前给申请人/操作者创建成员关系来绕过校验，不把原 join-org 审批、公共申请或接受邀请流程改坏。
6. 完成 Web `components/settings/access-settings-content.tsx` 及相关类型/子组件：半完成申请即使 status=approved 也能在可恢复列表出现；展示真实组织/邀请进度、投递失败及下一步；用户可续办/显式重发，成功后刷新关联与状态，重复点击正确处理。权限不满足不展示管理入口，服务端仍强制校验；原正常批准/拒绝/入组织与邀请接受流程继续可用，不把已提交审批显示成全部回滚。
7. 用真实 CI MySQL/Redis 与可失败 MailSender 做必要集成：正常链；组织/bootstrap 数据库失败；邀请保存/关联失败；邮件保存后发送失败再续办/重发；重复/并发请求不增组织/邀请；历史半完成记录恢复与不可信关联拒绝；非平台管理员/跨组织/客户端伪造角色被拒绝。Web 用行为测试覆盖半完成记录可见、继续/重发、成功刷新与失败信息，不能只测 helper 或断言源码文本。保持与真实 Prisma 字段/FK 约束一致，不用假 DDL 掩盖生产结构差异。

所有权与 CI：

- 拥有 identityonboarding、必要的 `internal/graphqlread/orgaccesswrite` bootstrap 窄事务支持、identity onboarding 路由/契约、审批 UI/共享类型。默认复用现有 schema；确有不足才做最小 Prisma/migration/fixture 变更并在现有 CI 验证，不在本机跑迁移/seed，不触真实数据库。新增业务进度/缓存/审计具名强类型，扩展 JSON 叶子可 RawMessage，不以 any/interface{}/map[string]any/[]any 新承载业务数据。
- 另一窗口 `ECONOMIC-QUEUE-RECOVERY-001` 拥有经济队列/经济 UI 与靠后 CI 块；不触及其路径。这里在既有 api-go-user-settings-integration job 的 user-settings MySQL/Redis 步骤之后、ITEMS-INGEST 注释之前追加独立组织审批恢复集成步骤，选择 `./internal/identityonboarding/ -run 'TestOrgApprovalRecoveryIntegration' -tags=integration`；保证新场景真正命中。不得改对方靠后 queue-ops 前的经济集成块或重写整个 job，第二个合并者正常 merge main 保留两块并集，不 rebase，不新增 workflow/测试依赖。
- main/config 原则不改；若确有必要接线，仅最小增量并说明证据。共享语言资源只加审批自己的 namespace，不整体排序或覆盖其它键；只更新自身 task/PR，不改共享地图/GAPS/认领索引，不清理或提交他人的脏文件。新增/修改源码注释英文，提交/文档/PR 中文。
- 不新增迁移 mode、后台自动修复/全库回填、分布式锁或通用重试框架；保持必要事务/CAS 与业务校验。新的恢复动作必须具体可用，不能用固定成功/空结果/待完善记录代替实现。

验证与交付：本机不安装依赖，不运行 build/test/lint/typecheck/vet/go run/迁移/Docker/服务，仅静态检查、diff 检查与必要格式化。执行验证在普通 CI。对类型/REST/必要契约、事务与持久关联、提交后投递/重发/取消、并发与幂等、平台管理员及 orgId/角色边界做纯静态审查并反向复核，保留 file:line，参照 `.workflow/reviews/static-audit.md`，修复本范围发现。只 stage 自己的文件，中文 emoji + type(scope) 正常 commit/push，不 amend/rebase/force-push。Ready PR 说明原失败步骤、恢复后具体用户行为、采用的进度/事务方案、历史兼容与投递限制；等最终精确 head 普通 CI，修复本范围失败，记录 lint/typecheck、Web coverage、Go 单元与新增集成实际结果/链接，skipped 不算通过、源 CI 不代替 merge CI。最终返回 PR/head/CI、静态审查和未验证边界，回填本 task；不合并、不部署、不发送真实邮件或批量处理真实申请。
