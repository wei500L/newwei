# IDENTITY-ONBOARDING-001 · 注册审批与邮件邀请入组

- 当前状态merged；[PR #79](https://github.com/wei500L/newwei/pull/79)实际merge f35ec572ccdf607b9224d88d1962cf792f9915be已验证为origin/main 90765633祖先。已核14路规则、wire和main/config资源OR落地，原head e105b3abdb3fa084356918cb29f8385cb5fb4ddb；业务worktree保留不等于仍占用。main普通CI39149114456运行中，不推断通过/生产启用/SMTP实测；不打断编码窗口或重做其文档。
- 原始认领：2026-10-18用户确认全部合并后要求下一批迁移量更大，选择14条同链HTTP并发出提示词；本窗口不实施业务/操作编码对话。下文无业务PR/未创建目录是发出时快照。
- 基线origin/main c39f282f11952b487c3ef6fefb14882db265ed9e；#70–#76由[PR #77](https://github.com/wei500L/newwei/pull/77)合入，开放PR为空；该SHA[普通CI 39142523834](https://github.com/wei500L/newwei/actions/runs/39142523834)成功。
- 分支refactor/go-identity-onboarding；worktree /Users/oo/project/newwei-go-identity-onboarding，规划时未创建。
- [完整提示词](IDENTITY-ONBOARDING-001.prompt.md)，记录在本次独立规划PR发布；业务PR尚无。

## 范围

/api/auth下GET/POST admin/invites及resend/revoke四路；admin/registration-applications列表和approve/reject join/org五路；register/applications、register/join-applications两路；invitations/:token预览和accept/accept-authenticated三路。3GET+11POST=14；GET200，公开提交两POST200，其他POST201。组织权限users.write、平台审批GlobalRoleAssignment.platform_admin、公开token消费各自独立。

新internal/identityonboarding及独立wire/legacyproxy；新API_GO_IDENTITY_ONBOARDING_MODE默认legacy且独立于登录/账户/MFA/GraphQL。MySQL/Redis/JWT/SMTP，无Mongo/S3/队列/worker/cron。复用已合authlogin SMTP窄端口、accountsecurity密码/profile缓存、orgaccesswrite组织bootstrap及rbac权限。排除OIDC/头像/导出等其他身份支线，不重复六个已合批次。

## 限定源码核实

按c39f282f读完OrgInviteService(567行)、RegistrationApplicationService(526行)、identity-admin DTO/14个AuthController handler、PlatformAccessService、membership-permissions、OrgService bootstrap、Prisma表、Web邀请/申请消费字段；对照Go private/public helper、鉴权/机器身份、SMTP、密码、默认角色/组织事务/active-org缓存与实际main/wire。候选Nest源码及schema相对9d0462e1无改动；Go本14路仍未接管。

已核实具体阻断：approveNewOrgApplication创建组织/默认system admin后调用普通createInvite，而assertRolesAssignable禁止系统admin，导致403。Go本批增加仅平台审批已领取申请可达的受控新组织admin邀请路径；不开放普通invite/approve-join的admin授予、不增加客户端绕过参数。另明确接受邀请后旧profile缓存失效，reviewedBy具名投影不透传passwordHash。

源事务/失败边界明确：审批pending条件领取与补偿、邀请accept条件领取+membership角色替换事务；新User在源membership事务前创建；create/resend数据库早于SMTP。不得宣称跨DB/邮件总事务，也不另起补偿平台。审计直写/Outbox消费者仍Nest，真实SMTP未验证。

## 占用与记录

六个旧业务worktree均只读核对为干净，auth/metadata相关main接线已确认落地；合并事实不等于对其他域全量重审或生产启用。业务文件无开放PR占用，公共main/config保留#77并集。编码窗口只交业务与PR说明，规划窗口维护共享地图。无本批业务实现/注册/合并/外部验证新增。
