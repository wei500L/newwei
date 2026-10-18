# 目标

在 wei500L/newwei 的 apps/api-go 完整迁移“注册申请→审核→邮件邀请→接受邀请入组”链路，任务 ID：IDENTITY-ONBOARDING-001。本批14条HTTP，覆盖新组织申请和加入已有组织两种路径，包含默认角色/组织初始化、权限范围校验、真实邮件、邀请单次消费与membership角色落地。不要拆成只保存申请/邀请配置的半批交付。

这是后端编码窗口：直接完成实现、提交、推送并创建Ready PR。专注迁移和必要功能，不做全仓审计，不堆防御性编程，不新造锁/重试/幂等平台/通用审批引擎。不机械要求修若干bug。保留已有鉴权、租户隔离、权限范围、业务校验、必要事务和单次消费；本批明确修复下文已核实的新组织审批阻断。

源码新增/修改注释使用英文，解释审批领取与补偿、受控admin初始化、邀请消费和角色替换的原因，不逐行复述。文档、提交和PR描述使用中文。

## 基线、分支和独立目录

仓库 /Users/oo/project/newwei 的checkout可能停在旧分支。规划基线为fetch后的origin/main：c39f282f11952b487c3ef6fefb14882db265ed9e。#70–#76已由integration PR #77合入，该SHA的普通CI成功（Actions run 39142523834）；规划时开放PR为空。

开始读取适用AGENTS.md，fetch origin main，记录最新SHA，查开放PR、main最近五次CI及git worktree list；只核对本链增量和认领，不重扫全仓。使用最新origin/main创建：
- 分支 refactor/go-identity-onboarding
- worktree /Users/oo/project/newwei-go-identity-onboarding

不切换、清理或提交其他窗口目录；同名目录/分支存在时先核归属，不覆盖。只读地图README/PLANNING/tasks索引/GAPS/BACKLOG，展开identity域及对应AUDIT/DEPENDENCIES；地图可能保留旧pr_open，不能因此重迁刚合并六批。

## 精确14条HTTP与权限

共同前缀 /api/auth。除表中特别注明200的两个公开提交外，所有POST成功均为Nest默认201；GET成功200。

| METHOD + 路径后缀 | 根权限及服务约束 | 返回 |
| --- | --- | --- |
| GET /admin/invites | users.write；重查当前org membership具备users.write | 当前org邀请列表 |
| POST /admin/invites | 同上；角色同org、禁止普通路径授系统admin、权限不得超actor | 创建的邀请 |
| POST /admin/invites/:id/resend | users.write及当前org membership | 换token后的邀请 |
| POST /admin/invites/:id/revoke | users.write及当前org membership | 撤回后的邀请标量 |
| GET /admin/registration-applications | AllowAuthenticated；handler按users.write或全局platform_admin决定两组可见性 | {orgApplications,platformApplications} |
| POST /admin/registration-applications/:id/approve-join | users.write及目标当前org membership；角色授予范围校验 | 审批后的join申请 |
| POST /admin/registration-applications/:id/reject-join | users.write及当前org membership | 驳回后的join申请 |
| POST /admin/registration-applications/:id/approve-org | AllowAuthenticated；服务查GlobalRoleAssignment的platform_admin | 审批后的new_org申请标量 |
| POST /admin/registration-applications/:id/reject-org | AllowAuthenticated；服务查platform_admin | 驳回后的new_org申请标量 |
| POST /register/applications | Public，200 | 新组织申请标量 |
| POST /register/join-applications | Public，200 | join申请及org |
| GET /invitations/:token | Public，凭token校验pending/有效期/组织活动 | 邀请预览投影 |
| POST /invitations/:token/accept | Public；已有账户必须先登录，新账户需密码和姓名 | membership及org |
| POST /invitations/:token/accept-authenticated | AllowAuthenticated；当前用户邮箱必须匹配邀请 | membership及org |

不得整段接管/api/auth。精确方法/动态段匹配，不吞尾斜杠、类似路径或更深子路径；OPTIONS按已有CORS约定，普通OPTIONS仍legacy。权限/DTO/业务失败不能再转Nest重放副作用。

组织admin在这些服务里指users.write权限，不要求role.name==admin；manager也可操作。platform_admin必须从GlobalRoleAssignment查，不等于组织admin，不从请求或JWT权限字段推断。列表仅users.write时平台列表=[]，仅platform_admin时org列表=[]，两者都有则分别读取；两者皆无403 Insufficient permissions。用户对当前org的管理权限不可用于别的orgId。

保留Nest JwtAuthGuard支持的JWT和mtk_身份分支；机器权限只能来自其记录，后续需要真人membership/平台角色/邮箱匹配的服务检查照常执行，不能把机器token转换成真人actor。复用已有鉴权，不写第二套token验签。

## 最新源码依据与已有Go复用

限定深读：
- apps/api/src/modules/auth/auth.controller.ts：上述14个handler、装饰器、baseUrl和HTTP状态。
- 同目录org-invite.service.ts：全部invite读写/accept、normalizeRoleIds/readRoleIds、ensureRoleSet、assertRolesAssignable/assertOrgAdmin、邮件与token。
- 同目录registration-application.service.ts：submit/list/approve/reject全部分支与claim补偿。
- 同目录dto/identity-admin.dto.ts、auth-flow.utils.ts、platform-access.service.ts。
- apps/api/src/common/authz/membership-permissions.ts及common/guards/{jwt-auth,permissions}.guard.ts。
- apps/api/src/modules/org/org.service.ts的createOrg、active-org-registry.service.ts；默认角色定义与Go现有defaults对照。
- apps/api/src/modules/email/email.service.ts、modules/audit/audit-log.writer.ts、packages/db/prisma/schema.prisma的OrgInvite/RegistrationApplication/User/Org/Role/RolePermission/Membership/MembershipRole/GlobalRoleAssignment。
- apps/web/components/settings/access-settings-content.tsx的InviteListItem/RegistrationApplicationItem及调用；apps/web/app/(auth)/invite/[token]/page.tsx只作为返回契约消费者核对，不修改Web。

相对旧基线9d0462e1，上述Nest身份/组织服务与schema无业务变化；新增的Go登录基础已经在main，不依赖未合PR。现有Go精确路由仍把本14路留给Nest，不能从已有auth包存在推断本批已迁。

明确复用：
1. internal/authn/authz/authhttp及accountsecurity.Authenticator：JWT/blacklist、membership权限重推导、mtk_路径、HTTP错误。accountsecurity.NewAuthenticator/Authorize已导出；authfactors包装的authorize是私有，不能假定跨包可调用。
2. internal/accountsecurity/login_port.go：HashLoginPassword（Node bcrypt兼容/cost10）、IsUniqueConstraint、LoginStore/InvalidateProfileCache等已导出窄能力。接受邀请不签发JWT，不需要复制authlogin的session/refresh/MFA流程。
3. internal/authlogin/mailer.go已有真实SMTP标准库实现，SMTPConfig已导出，但mailer/newMailer/send是私有。新增一个窄的具名邮件端口（例如MailMessage、NewMailSender、Send）包装现有transport即可；不复制SMTP/TLS实现，不构造整个登录Service来发信，不新建邮件平台。保留原登录/验证码/密码重置发送行为。
4. internal/graphqlread/orgaccesswrite/org.go的createOrg/insertOrg及defaults.go：已有组织、三套默认角色、权限、创建者admin membership、MembershipRole与审计事务，提交后失效org:active:list:v1；service/helper私有。通过窄的具名bootstrap接口复用，必要时小范围抽取现有helper；不复制默认角色目录，不让业务HTTP依赖GraphQL注册开关，不改变已合8个组织mutation授权。
5. internal/rbacapi.ActorHasPermission已导出，严格按MembershipRole优先、无links时才回退legacy role的语义读取权限；授予范围校验仍需完整角色权限集合，不能仅调用一次布尔检查冒充覆盖。
6. authlogin/audit.go及orgaccesswrite审计可作协议依据，多数helper私有。复用窄能力或本包具名writer，保留AuditLog→失败写AuditLogOutbox协议，消费者仍Nest。

建议新internal/identityonboarding/**、cmd/api/identity_onboarding.go、legacyproxy独立规则。允许authlogin邮件端口、orgaccesswrite bootstrap端口及必要accountsecurity/rbac窄复用；不做通用服务层大搬家。

## DTO、默认值、null与错误

CreateInviteDto：email IsEmail；firstName/lastName可选字符串最长120；primaryRoleId仅IsString；roleIds必须非空数组。ApproveJoinApplicationDto同角色字段。源码没有roleIds逐项IsString装饰器，不凭空追加新DTO规则；畸形元素按原校验/业务异常边界处理，协议边界解析后业务层使用具名强类型，不将any数组散入业务。

AcceptInviteDto：password可选字符串MinLength8；firstName/lastName可选字符串，无新增长度/非空装饰器。缺失/null按IsOptional跳过，服务仍检查新用户密码trim后>=8、姓名最终非空。名字使用参数?.trim() ?? invite名字 ?? ""，显式空串不能误当缺省回退。原公共accept仅对新用户开放；既有邮箱返回要求登录的403。

SubmitNewOrgApplicationDto：email、firstName、lastName、orgName、orgSlug必需且按各装饰器验证；description可选字符串。SubmitJoinOrgApplicationDto为email/firstName/lastName/orgSlug。这里IsString不等于非空，不提前加创建组织阶段才有的slug格式校验。服务email trim/lowercase、slug trim/lowercase、其他字符串trim，description空值转null。

RejectApplicationDto：reason可选字符串；缺省/null/空白存null。params id/token无UUID约束，token查询前trim再SHA256。不要额外增加密码复杂度、邮箱验证要求、申请限流、邀请唯一规则或分页上限。

保留关键错误/status：
- 403 Organization admin access required
- 403 Platform admin access required
- 403 Actor is not a member of the organization
- 403 System administrator role cannot be granted via invitations（普通invite/approve-join）
- 403 Insufficient permission scope to grant the selected roles
- 400 One or more roles are invalid / Primary role must be included in roleIds
- 404 Invite not found / Registration application not found / Organization not found
- 400 Only pending invites can be resent
- 401 Invite is no longer valid / Invite organization is disabled
- 403 Signed-in user does not match invite email
- 403 Please sign in with the invited email to accept this invite
- 400 Password must be at least 8 characters / First and last name are required
- 409 Invitation has already been accepted or revoked
- 409 Registration application was already reviewed
- 提交时重复pending email、已占用slug、pending slug的原409文本；OrgService创建slug冲突原400。

错误顺序与原条件查询保持：审批/拒绝首先查pending application，不满足常为404，不把全部“已审批”都改409；只有读取后条件领取竞争失败才对应409。

## 返回模型与列表

采用具名强类型，所有时间按UTC毫秒ISO，可空字段保留null，空列表为[]，metadata叶子可用json.RawMessage。

对照Prisma include逐接口保持关系差异：
- invite list：OrgInvite标量+primaryRole，createdAt desc，当前org全部状态，无新分页。
- create/resend：OrgInvite标量+org+primaryRole；revoke仅标量，不伪造关系。
- public preview仅{id,email,firstName,lastName,org:{id,name,slug},primaryRole:{id,name},expiresAt,status}，不返回tokenHash/rawToken。
- accept：Membership标量+org，不返回登录session/token、[]role投影或{ok:true}代替membership。
- submit new-org：申请标量；submit join：标量+org。
- org申请列表：join_org全部状态，createdAt desc，含org/reviewedBy；平台列表：new_org全部状态，createdAt desc，含reviewedBy。
- approve-join返回org/reviewedBy；reject-join返回org；approve-org/reject-org返回申请标量。缺失关系不能随意补{}。

reviewedBy使用具名安全用户投影，保留原非凭据标量/null，不照搬Prisma reviewedBy:true暴露passwordHash；将这一具体响应收窄记录为迁移差异。既有Web使用的邀请、申请、组织和角色显示字段必须兼容。管理员邀请标量按源码契约处理，但rawToken只用于邮件，不能直接返回/日志输出。不要SELECT *后把任意User对象透传。

## 必须完成的业务链

### A. 邀请创建、重发、撤回与预览

- 以当前身份orgId+actorId重查membership及users.write。
- roleIds按原normalizeRoleIds组合primary并去重；注意原primaryRoleId自身不是统一trim后替换，不能静默改变空白ID错误。
- 所有Role必须属于当前org；权限从MembershipRole links读取，只有无links才回退legacy role，不将二者无条件合并。
- 普通createInvite和approve-join禁止系统admin（isSystem且name小写admin），即使actor是平台管理员也不放宽；所授每项权限必须包含于actor当前组织权限。
- token为安全随机32字节hex，DB只存SHA256，有效7天。first/lastName trim后空值存null；记录invitedById。
- DB创建后真实SMTP发送邀请，成功后写users/invite_create审计，返回invite。
- resend以id+orgId查pending邀请，过期但pending仍允许重发；替换tokenHash/expiresAt，旧链接立即失效，发送邮件、写invite_resend。按源码不新增授予角色重新审核步骤。
- revoke按id+orgId查后写revoked/revokedAt；源码不要求pending，也不删除已有membership，不擅加状态保护；写invite_revoke。
- 预览/accept以hash(token.trim())查；必须pending，expiresAt<now失效（边界按源码），组织必须活动。

邮件baseUrl来自NEXTAUTH_URL，缺省http://localhost:3000，邀请链接/invite/<rawToken>。保留Invitation to join <org.name>标题与组织/角色信息，文本+HTML真实投递。SMTP失败按源码传播，不能返回{ok:true}，不能伪装数据库已回滚：create/resend的写入早于发送。

### B. 接受邀请入组

- 先校验invite和当前role set仍存在/属于邀请org。
- 已认证入口：以当前userId查User，规范化email必须等于邀请email。
- 公共入口：如果邮箱已有User，403要求登录；新用户校验trim密码及姓名，使用现有HashLoginPassword，创建活动User，emailVerified保持null，不因持有邀请链接标已验证。
- 保留源边界：Nest在membership事务前创建新User，不声称源链所有操作原本都在一个事务；本批不扩展成账户补偿平台。
- 一个MySQL事务内先条件领取pending邀请，影响行数必须1，再创建或更新唯一(userId,orgId) membership、roleId=primaryRoleId、isActive=true；删除旧MembershipRole，再插入这次role集合，最后返回membership+org。
- 领取失败409并回滚该membership事务，不能重复授角色或改成幂等成功；acceptedById/acceptedAt落地。
- 现有membership会被重新激活和替换角色，不能只“已存在则跳过”。
- commit后复用既有profile缓存失效能力，清该用户default及各org缓存，避免已有账户入组/换角色后/me继续返回旧权限；这是本批明确的功能一致性改善。不加新缓存层，不在缓存失败时重放数据库事务。
- 接受成功不自动登录、不发新JWT、不写源码没有的accept审计/通知；Web后续正常登录使用已合AUTH-LOGIN-001。

### C. 两类公开注册申请

new_org：检查同email的pending new_org、Org已占用slug、pending new_org的requestedOrgSlug，分别按原409返回；保存申请身份、requestedOrgName/Slug/Description。不能提前创建Org/User/Invite。

join_org：按规范化slug找Org，不存在404；检查同org+email的pending join_org，再创建含orgId的申请。源码没有提前检查org活动性或已有membership，不新增产品规则。提交不自动发邮件，不创建token/用户。

### D. 列表与入组申请审批

- 列表按handler的两种权限分别查，两数组分开返回；组织列表服务仍重查users.write，平台列表服务查GlobalRoleAssignment。
- approve-join：先组织权限与角色授予范围，再按id+orgId+type=join_org+pending读取；条件UPDATE pending→approved，保存reviewer/time，领取失败409。
- 领取后调用同一普通invite链，真实创建/发信/审计；失败按原条件仅在approved且generatedInviteId=null时将status返还pending，保留原补偿字段/失败传播，不制造通用重试。
- 成功将generatedInviteId连接到申请，写registration_application/approve_join审计，返回含org/reviewedBy的申请。
- reject-join：当前org pending申请→rejected，reason.trim||null、reviewer/time；真实发送Registration application update邮件，写reject_join审计，返回含org的申请。reason保存但邮件按源模板，不擅自把reason插入正文。

### E. 新组织审批与具体阻断修复

已核实的源码问题：RegistrationApplicationService.approveNewOrgApplication创建组织后取系统admin角色，再调用普通OrgInviteService.createInvite；而普通assertRolesAssignable必然拒绝系统admin，所以流程会在组织已经创建后403，不能完成申请人接入。不要原样复制这个阻断，也不能为修它全局放宽邀请授权。

Go必须实现受控的新组织初始化邀请路径：
- 仅平台角色校验通过、且当前pending new_org申请被本次条件领取后可调用。
- 组织、申请人email和admin role全部由服务端已领取的申请/本次创建组织推导。
- 允许该内部路径给该新组织申请人发admin邀请；不能使用客户端skipChecks/allowSystemAdmin字段，不能让普通createInvite或approve-join进入该路径。
- 复用已有组织bootstrap：Org、默认admin/manager/analyst角色、RolePermission、审批actor的admin Membership/MembershipRole、原create审计在事务中落地，提交后失效org:active:list:v1；admin获得数据库全部Permission，其他角色按原目录子集及missing warning。
- 不用actor当前活动org的org.write替代平台审批资格，也不能要求调用GraphQL createOrg root；业务helper不受GRAPHQL_ORG_ACCESS_WRITE开关控制。
- 记录并保留原语义：新org的创建者membership属于审批actor，申请人仍通过邀请后入组，不能直接给申请人建已验证账户。
- 创建组织失败按原条件补偿申请status；后续步骤按实际持久化边界处理，不假称Org/SMTP/申请是一个总事务，不另起孤儿资源清理任务。
- 内部邀请仍执行角色存在/同组织校验、token、真实邮件、invite_create审计；随后写org/registration_application_approved并连接generatedInviteId，返回申请标量。
- reject-org：平台角色校验→pending new_org→rejected/reviewer/time/reason，真实发送Organization application update邮件，返回标量。源码没有该分支审计，不擅自补一套事件。

这项受控admin路径修复是本批必要功能工作，不是泛化安全重构。

## 数据、缓存和执行所有权

MySQL表：OrgInvite、RegistrationApplication、User、Org、Role、Permission、RolePermission、Membership、MembershipRole、GlobalRoleAssignment、AuditLog/AuditLogOutbox。保持现有唯一/复合外键及NULL/JSON语义，不新增schema/migration；客户端生成ID按已有Go方式，updatedAt等Prisma自动字段须显式正确更新。

Redis仅已有鉴权/blacklist/profile缓存及org:active:list:v1失效，无新业务队列或锁。

审计沿原users邀请三事件、registration_application入组审批/驳回、org创建及建组织审批事件；metadata具名化，HTTP源码未传IP则保持null，不从body编造IP。best-effort直写失败进入既有Outbox，消费者仍Nest，双写失败记录结果但不把已应用业务改失败。

SMTP是请求中的真实外部调用，必须保留上述成功/失败顺序；复用SMTP_*现有TLS/from/连接与greeting/socket timeout、证书配置和Pool差异，不复制transport。本机不真实调用、不宣称投递已验证，不打印密码、rawToken或邮件凭据。

本批无BullMQ/cron/worker、OIDC/SSO、Mongo、S3、LLM依赖，不增加邮件队列或定时补偿执行器。

## 开关、公共接线与回滚

新增API_GO_IDENTITY_ONBOARDING_MODE，接受空串/legacy/go，默认legacy，非法值启动失败。不要混用已有API_GO_ONBOARDING_MODE。

必须可在AUTH_LOGIN、ACCOUNT_SECURITY、AUTH_FACTORS、GraphQL及其他迁移模式均legacy时独立工作。复用代码不等于依赖其他模块的路由开关。

main/config/legacyproxy只增加本批14路规则、key、DB无效DSN判断、needsCredentialedGo、共享MySQL/Redis/auth初始化及wireIdentityOnboarding。复用已有连接池，邮件端口只需SMTPConfig，不初始化会话签发或MFA资源。

go模式按既有appendAuthRequirements校验DB/JWT/Redis，并校验SMTP_HOST/PORT/USER/PASS；复用现有SMTP解析，legacy不额外要求这些资源。不要求Mongo/对象存储/模型/IdP或仅签发token才用的资源；不发送启动邮件、不探测真实上游。

env/compose默认legacy；Web→NestJS与canary默认不变。只改本批语义段，保留#77已合并的开关/注册/模型并集，不整理整个main/config或替别的域修接线缺口。

回滚API_GO_IDENTITY_ONBOARDING_MODE=legacy。邀请tokenHash、状态、申请、membership与Nest兼容；受控新org邀请落地后Nest可按现有accept逻辑消费。无schema回滚，不撤回用户已接受的membership或邮件。

## 允许范围、并行边界与实现约束

主要允许internal/identityonboarding/**、cmd/api/identity_onboarding.go、legacyproxy新规则；authlogin邮件窄端口、orgaccesswrite bootstrap窄端口、必要accountsecurity/rbac复用及相关测试；main/config/README/env/compose最小接线增量。不要重迁已有登录11路、账户8路、MFA管理7路、组织GraphQL8写。

规划时没有开放业务PR；#70工作台、#72简报、#73S3、#74items、#75登录、#76metadata均已通过#77进入main，不再视为活动占用，也不能因旧worktree存在重迁。若编码开始后有新认领/PR触碰authlogin邮件或orgaccesswrite bootstrap，先核实际diff和所有权；只协调真实重叠，不自动抢整个auth域。

排除OIDC start/callback/handoff三路、头像presign、个人数据导出、全局角色管理、来源策略、GraphQL引擎/模型注册、其他worker/cron。未来OIDC任务不应同时修改本批邮件/组织bootstrap端口；不修改其他worktree，不创建或通知其他对话。

具名强类型覆盖DTO、返回、数据库JSON、角色集合、缓存、审计metadata。禁止any/interface{}/map[string]any/[]any承载业务数据；通用协议边界沿现有实践，扩展JSON叶子可用json.RawMessage。权限集合map[string]bool、ID索引map[string]具名类型可按实际使用，不引入无类型业务包。

真实查询优化仅做本链所需：角色/权限和列表关联批量读取，避免逐邀请/逐申请查org、primaryRole、reviewer的N+1；保持createdAt排序、字段/权限和副作用顺序。不加分页产品限制、通用缓存或新业务算法，不删除跨阶段必要复核。

## 精简验证

本机不安装依赖，不运行build/test、Docker、服务或真实SMTP；允许gofmt、git diff --check、只读静态检查。预计无需新依赖。仅用现有普通GitHub Actions CI，不新增专用smoke/Nest/Jest测试体系。

少量有价值的Go测试交普通CI：
- 14路精确方法、默认legacy/非法值、独立开关及与登录/MFA/account/GraphQL同开不覆盖。
- users.write与platform_admin可见性/管理范围；manager可管理、跨org拒绝；linked roles优先语义。
- 普通邀请/approve-join仍拒绝系统admin与超范围角色；受控new_org审批可完整发admin邀请，客户端不能开启绕过。
- 新用户不自动emailVerified；已有账户必须登录匹配邮箱；accept返回membership并替换角色；邀请/审批条件领取失败不重复授予或发孤儿邀请。
- resend旧token失效、expired pending可重发、revoke不撤销membership；邮件失败与申请claim补偿/DB已提交边界。
- 返回关系/null/日期和reviewedBy不含passwordHash；必要profile/active-org缓存失效。

不搭大测试框架，不镜像实现写大量测试。静态复核SQL条件/事务、角色集合、API返回和新admin内部入口可达性，给本次SHA+文件/符号证据。真实MySQL/Redis/SMTP及跨Nest/Go消费未运行验证就明确写未验证，CI通过不等于真实投递验证。

## 记录、提交和Ready PR

规划窗口维护共享地图/BACKLOG/任务索引和认领。编码窗口不修改这些共享文件，不另写规划文档；在PR描述（必要时一份简短docs/refactor/go-identity-onboarding.md）记录14路实际完成、系统admin阻断修复、返回收窄、复用端口、开关/资源、必要副作用、最终head/普通CI链接、未验证外部行为与回滚方法，供规划窗口回填IDENTITY-ONBOARDING-001与identity域。

未合并只能pr_open，不提前增加main覆盖或宣称启用。提交前重新fetch，必要时正常merge origin/main并保留公共接线并集；不rebase。

只暂存本批改动，中文emoji+type(scope)提交，正常push，创建Ready PR（非Draft），不合并、不auto-merge、不amend/rebase/force-push。查看本次精确head的普通CI，修复本批失败；skipped不算通过，不无限重复无变化检查。

最终交付PR URL、分支/worktree、基线和最终head、14路及必要副作用完成情况、具体行为改善/差异、普通CI结果/链接、外部验证边界、回滚方式，以及需规划窗口更新的事实。不要用只保存文档、空壳注册、未发邮件或待实现列表代替完整业务交付。
