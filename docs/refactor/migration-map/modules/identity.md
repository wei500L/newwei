# identity · 身份、组织与访问控制

最近核对：2026-10-18 13:51 MSK（UTC+03:00）；`origin/main 7fc17faa3dc5043537bad4038299d11fdba4758d`。返回[地图入口](../README.md) / [规划规则](../PLANNING.md)。

## 范围与实施状态

登录、验证码、refresh、OIDC 登录回调、邀请和注册审批仍由 Nest 承担。已迁移的是账户/登出/机器令牌、已认证 MFA 配置及 RBAC/组织管理子链，不能把整个 auth 标成迁完。

关键数据与副作用：MySQL User/Membership/Role/Permission/Organization/MachineAccessToken；Redis 撤销名单与权限缓存；邮件、OIDC、头像 S3；Go 审计失败可写 AuditLogOutbox，消费仍由 Nest 承担（见异步域）。令牌 claim 不能替代服务端 membership 重推导。

真实剩余缺口：完整登录与会话链、邀请/审批、头像与导出见下表 Nest 行；登录挑战与 MFA 管理是不同范围。GraphQL 8 个组织访问 Mutation 已合入，不再分配。

状态分层：下表“Go”仅表示该 SHA 已有生产注册、接线及已有业务实现，完整性须看本页具体缺口；“Nest”表示该入口尚无 Go 接管注册。已注册代码已在 main，历史 PR 见证据表。契约完整性、实网验证和部署另行核对；没有业务完成百分比。

验证：基线[普通 CI](https://github.com/wei500L/newwei/actions/runs/39118934491) 的 verify 成功；真实 MySQL/Redis 集成仅覆盖 user-settings/authz，真实 Qdrant 差分仅覆盖 vector。其余域本次仅静态核对，历史报告的 smoke 声明未逐次复验；没有证据则额外集成验证为“未核实”。

启用：实际部署及生产切流均“未核实”。可见 compose 是可选 pilot，Web 默认仍指 Nest，CANARY_PERCENT=0；模块开关默认 legacy 的例外和当前注入见下文。

Nest 功能目录：[auth](../../../../apps/api/src/modules/auth)、[org](../../../../apps/api/src/modules/org)、[rbac](../../../../apps/api/src/modules/rbac)。Controller 装配入口见 [AppModule](../../../../apps/api/src/app.module.ts)；GraphQL providers 见 [ApiGraphqlModule](../../../../apps/api/src/graphql/graphql.module.ts)。

当前认领：未发现本域开放 PR；旧 worktree 不自动视为活动任务，后续按[认领核对记录](../tasks/README.md)增量检查。

## HTTP 开关、实现与生产接线

所有新迁移单元接受空串/legacy/go、空串视为 legacy、非法值启动失败；用户 UI 读历史兼容模式是例外。启动依赖以 [config.Load](../../../../apps/api-go/internal/config/config.go) 的对应校验为准，不能用配置样例代替启动校验。普通认证接管通常要求 JWT_SECRET、DATABASE_URL、REDIS_HOST；读取 Mongo 的域还要求 MONGO_URI。

| 路由组符号 | 开关（须 go 才接管） | Go 业务实现 | 可见 pilot 注入 |
|---|---|---|---|
| [WithAccountSecurity](../../../../apps/api-go/internal/legacyproxy/account_security_routes.go) | `API_GO_ACCOUNT_SECURITY_MODE` | [accountsecurity](../../../../apps/api-go/internal/accountsecurity) | `legacy` |
| [WithAuthFactors](../../../../apps/api-go/internal/legacyproxy/auth_factors_routes.go) | `API_GO_AUTH_FACTORS_MODE` | [authfactors](../../../../apps/api-go/internal/authfactors) | `${API_GO_AUTH_FACTORS_MODE:-legacy}` |
| [WithRbac](../../../../apps/api-go/internal/legacyproxy/rbac_routes.go) | `API_GO_RBAC_MODE` | [rbacapi](../../../../apps/api-go/internal/rbacapi) | `未注入；按 config 缺省` |

生产装配：[cmd/api](../../../../apps/api-go/cmd/api) 中 main.run 组合上述 With 路由规则，各域 wire* 或 main 中 RegisterGoHandler 注入本地 Handler/Service。业务包未发现通过 legacyproxy 回调 Nest 的实现；不支持的方法/路径与普通 OPTIONS 的代理不算业务迁移。默认回滚把对应模式改回 legacy；不要修改整段 /api 前缀。

## 精确 HTTP 清单

分母 51：当前 Nest Controller（含 @Sse）与 auth-matrix 快照交叉核对；METHOD + 完整路径去重，不含 CORS、/graphql、Socket.IO、Bull Board。源码链接保留 handler 符号；权限来自装饰器，平台与内部 token 校验另外标注。

| HTTP 入口 | 根权限 / 额外约束 | Nest 事实源与符号 | Go 接管组 / 缺口 |
|---|---|---|---|
| `GET /api/auth/admin/invites` | users.write | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `listInvites` | Nest；尚未接管 |
| `POST /api/auth/admin/invites` | users.write | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `createInvite` | Nest；尚未接管 |
| `POST /api/auth/admin/invites/:id/resend` | users.write | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `resendInvite` | Nest；尚未接管 |
| `POST /api/auth/admin/invites/:id/revoke` | users.write | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `revokeInvite` | Nest；尚未接管 |
| `GET /api/auth/admin/oidc-config` | settings.manage | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `getOidcConfig` | WithAuthFactors |
| `PUT /api/auth/admin/oidc-config` | settings.manage | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `updateOidcConfig` | WithAuthFactors |
| `GET /api/auth/admin/registration-applications` | 已认证；handler 平台管理员 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `listRegistrationApplications` | Nest；尚未接管 |
| `POST /api/auth/admin/registration-applications/:id/approve-join` | users.write | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `approveJoinApplication` | Nest；尚未接管 |
| `POST /api/auth/admin/registration-applications/:id/approve-org` | 已认证 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `approveNewOrgApplication` | Nest；尚未接管 |
| `POST /api/auth/admin/registration-applications/:id/reject-join` | users.write | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `rejectJoinApplication` | Nest；尚未接管 |
| `POST /api/auth/admin/registration-applications/:id/reject-org` | 已认证 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `rejectNewOrgApplication` | Nest；尚未接管 |
| `POST /api/auth/avatar/presigned-url` | 已认证 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `createAvatarPresignedUrl` | Nest；尚未接管 |
| `POST /api/auth/change-password` | 已认证 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `changePassword` | WithAccountSecurity |
| `GET /api/auth/data-export` | 已认证 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `exportUserData` | Nest；尚未接管 |
| `GET /api/auth/invitations/:token` | 公开 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `getInvitation` | Nest；尚未接管 |
| `POST /api/auth/invitations/:token/accept` | 公开 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `acceptInvitation` | Nest；尚未接管 |
| `POST /api/auth/invitations/:token/accept-authenticated` | 已认证 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `acceptInvitationAuthenticated` | Nest；尚未接管 |
| `POST /api/auth/login` | 公开 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `login` | Nest；尚未接管 |
| `POST /api/auth/login-with-code` | 公开 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `loginWithCode` | Nest；尚未接管 |
| `POST /api/auth/logout` | 已认证 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `logout` | WithAccountSecurity |
| `GET /api/auth/machine-tokens` | settings.manage | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `listMachineTokens` | WithAccountSecurity |
| `POST /api/auth/machine-tokens` | settings.manage | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `createMachineToken` | WithAccountSecurity |
| `DELETE /api/auth/machine-tokens/:tokenId` | settings.manage | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `revokeMachineToken` | WithAccountSecurity |
| `POST /api/auth/machine-tokens/:tokenId/rotate` | settings.manage | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `rotateMachineToken` | WithAccountSecurity |
| `GET /api/auth/me` | 已认证 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `profile` | WithAccountSecurity |
| `GET /api/auth/mfa` | 已认证 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `getMfaStatus` | WithAuthFactors |
| `POST /api/auth/mfa/disable` | 已认证 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `disableMfa` | WithAuthFactors |
| `POST /api/auth/mfa/enroll` | 已认证 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `beginMfaEnrollment` | WithAuthFactors |
| `POST /api/auth/mfa/enrollment/complete` | 公开 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `completeMfaEnrollmentChallenge` | Nest；尚未接管 |
| `POST /api/auth/mfa/enrollment/start` | 公开 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `beginMfaEnrollmentChallenge` | Nest；尚未接管 |
| `POST /api/auth/mfa/recovery/rotate` | 已认证 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `rotateRecoveryCodes` | WithAuthFactors |
| `POST /api/auth/mfa/verify-enroll` | 已认证 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `verifyMfaEnrollment` | WithAuthFactors |
| `POST /api/auth/mfa/verify-login` | 公开 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `completeMfaLogin` | Nest；尚未接管 |
| `GET /api/auth/oidc/callback` | 公开 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `handleOidcCallback` | Nest；尚未接管 |
| `POST /api/auth/password/forgot` | 公开 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `requestPasswordReset` | Nest；尚未接管 |
| `POST /api/auth/password/reset` | 公开 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `resetPassword` | Nest；尚未接管 |
| `PATCH /api/auth/profile` | 已认证 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `updateProfile` | WithAccountSecurity |
| `POST /api/auth/refresh` | 公开 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `refresh` | Nest；尚未接管 |
| `POST /api/auth/register/applications` | 公开 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `submitNewOrgApplication` | Nest；尚未接管 |
| `POST /api/auth/register/join-applications` | 公开 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `submitJoinOrgApplication` | Nest；尚未接管 |
| `POST /api/auth/send-login-code` | 公开 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `sendLoginCode` | Nest；尚未接管 |
| `POST /api/auth/send-verification` | 已认证 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `sendVerification` | Nest；尚未接管 |
| `POST /api/auth/sso/handoff/exchange` | 公开 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `exchangeHandoffToken` | Nest；尚未接管 |
| `GET /api/auth/sso/oidc/start` | 公开 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `startOidcLogin` | Nest；尚未接管 |
| `POST /api/auth/verify-email` | 已认证 | [auth.controller.ts](../../../../apps/api/src/modules/auth/auth.controller.ts) · `verifyEmail` | Nest；尚未接管 |
| `POST /api/rbac/assign` | roles.write | [rbac.controller.ts](../../../../apps/api/src/modules/rbac/rbac.controller.ts) · `assignRole` | WithRbac |
| `GET /api/rbac/audit-logs` | settings.manage | [rbac.controller.ts](../../../../apps/api/src/modules/rbac/rbac.controller.ts) · `auditLogs` | WithRbac |
| `GET /api/rbac/members` | users.read | [rbac.controller.ts](../../../../apps/api/src/modules/rbac/rbac.controller.ts) · `members` | WithRbac |
| `GET /api/rbac/permissions` | permissions.read | [rbac.controller.ts](../../../../apps/api/src/modules/rbac/rbac.controller.ts) · `permissions` | WithRbac |
| `GET /api/rbac/roles` | roles.read | [rbac.controller.ts](../../../../apps/api/src/modules/rbac/rbac.controller.ts) · `roles` | WithRbac |
| `POST /api/rbac/roles` | roles.write | [rbac.controller.ts](../../../../apps/api/src/modules/rbac/rbac.controller.ts) · `createRole` | WithRbac |

## GraphQL 精确 root 清单

所有 root 还受组织身份重推导及[传输与模型注册规则](graphql-runtime.md)约束。SDL 在 [apps/api/schema.gql](../../../../apps/api/schema.gql)，可执行注册仅计算生产 Register 调用，测试示例不计。多个权限用 OR 或 +（ALL）区分。

| 类型 / root | 根权限 | Nest 事实源与符号 | Go 实现 / 开关条件 |
|---|---|---|---|
| Mutation `assignRole` | roles.write | [rbac.resolver.ts](../../../../apps/api/src/graphql/resolvers/rbac.resolver.ts) · `assignRole` | [orgaccesswrite.Register](../../../../apps/api-go/internal/graphqlread/orgaccesswrite/register.go)；`API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE（独立）` |
| Mutation `createOrg` | org.write | [org.resolver.ts](../../../../apps/api/src/graphql/resolvers/org.resolver.ts) · `createOrg` | [orgaccesswrite.Register](../../../../apps/api-go/internal/graphqlread/orgaccesswrite/register.go)；`API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE（独立）` |
| Mutation `createRole` | roles.write | [rbac.resolver.ts](../../../../apps/api/src/graphql/resolvers/rbac.resolver.ts) · `createRole` | [orgaccesswrite.Register](../../../../apps/api-go/internal/graphqlread/orgaccesswrite/register.go)；`API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE（独立）` |
| Mutation `setOrgActive` | org.write | [org.resolver.ts](../../../../apps/api/src/graphql/resolvers/org.resolver.ts) · `setOrgActive` | [orgaccesswrite.Register](../../../../apps/api-go/internal/graphqlread/orgaccesswrite/register.go)；`API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE（独立）` |
| Mutation `setUserActive` | users.write | [user.resolver.ts](../../../../apps/api/src/graphql/resolvers/user.resolver.ts) · `setUserActive` | [orgaccesswrite.Register](../../../../apps/api-go/internal/graphqlread/orgaccesswrite/register.go)；`API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE（独立）` |
| Mutation `updateMembershipRoles` | users.write | [user.resolver.ts](../../../../apps/api/src/graphql/resolvers/user.resolver.ts) · `updateMembershipRoles` | [orgaccesswrite.Register](../../../../apps/api-go/internal/graphqlread/orgaccesswrite/register.go)；`API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE（独立）` |
| Mutation `updateOrg` | org.write | [org.resolver.ts](../../../../apps/api/src/graphql/resolvers/org.resolver.ts) · `updateOrg` | [orgaccesswrite.Register](../../../../apps/api-go/internal/graphqlread/orgaccesswrite/register.go)；`API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE（独立）` |
| Mutation `updateRole` | roles.write | [rbac.resolver.ts](../../../../apps/api/src/graphql/resolvers/rbac.resolver.ts) · `updateRole` | [orgaccesswrite.Register](../../../../apps/api-go/internal/graphqlread/orgaccesswrite/register.go)；`API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE（独立）` |
| Query `me` | 已认证 | [user.resolver.ts](../../../../apps/api/src/graphql/resolvers/user.resolver.ts) · `me` | [workspace.Register](../../../../apps/api-go/internal/graphqlread/workspace/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_WORKSPACE_READ_MODE` |
| Query `memberships` | users.read | [rbac.resolver.ts](../../../../apps/api/src/graphql/resolvers/rbac.resolver.ts) · `memberships` | [workspace.Register](../../../../apps/api-go/internal/graphqlread/workspace/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_WORKSPACE_READ_MODE` |
| Query `myOrganizations` | 已认证 | [org.resolver.ts](../../../../apps/api/src/graphql/resolvers/org.resolver.ts) · `myOrganizations` | [workspace.Register](../../../../apps/api-go/internal/graphqlread/workspace/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_WORKSPACE_READ_MODE` |
| Query `permissions` | permissions.read | [rbac.resolver.ts](../../../../apps/api/src/graphql/resolvers/rbac.resolver.ts) · `permissions` | [workspace.Register](../../../../apps/api-go/internal/graphqlread/workspace/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_WORKSPACE_READ_MODE` |
| Query `roles` | roles.read | [rbac.resolver.ts](../../../../apps/api/src/graphql/resolvers/rbac.resolver.ts) · `roles` | [workspace.Register](../../../../apps/api-go/internal/graphqlread/workspace/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_WORKSPACE_READ_MODE` |
| Query `userLoginRecords` | users.read | [user.resolver.ts](../../../../apps/api/src/graphql/resolvers/user.resolver.ts) · `userLoginRecords` | [workspace.Register](../../../../apps/api-go/internal/graphqlread/workspace/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_WORKSPACE_READ_MODE` |
| Query `users` | users.read | [user.resolver.ts](../../../../apps/api/src/graphql/resolvers/user.resolver.ts) · `users` | [workspace.Register](../../../../apps/api-go/internal/graphqlread/workspace/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_WORKSPACE_READ_MODE` |

## 合并、CI 与历史报告证据

PR 记录只作索引；实际功能状态已按本页 SHA 的源码/注册核对。下列实际 merge commit 均验证为 main 祖先；integration 合并包含在内。

| PR | 实际 merge commit | 说明 |
|---|---|---|
| [#17](https://github.com/wei500L/newwei/pull/17) | [4c105aaf0771](https://github.com/wei500L/newwei/commit/4c105aaf07710e8991ac8d2916b47281611be6e9) | feat(api-go): onboarding 接入 Go 鉴权并完成真实接管 |
| [#39](https://github.com/wei500L/newwei/pull/39) | [33650d245e07](https://github.com/wei500L/newwei/commit/33650d245e0751af995ae13646ef541e79333b37) | ✨ feat(api-go): RBAC 组织访问控制六条 HTTP 接管（默认 legacy） |
| [#48](https://github.com/wei500L/newwei/pull/48) | [11c4c8a826a6](https://github.com/wei500L/newwei/commit/11c4c8a826a655da7fa1a81d0ac4b5d6cff0afc6) | ✨ feat(graphqlread): 迁移 workspace 12 个 GraphQL 只读 Query（Go） |
| [#60](https://github.com/wei500L/newwei/pull/60) | [f5648fab7374](https://github.com/wei500L/newwei/commit/f5648fab7374bbd1a8ec97ba363f4e678d58549d) | 🔐 feat(api-go): 账户资料、会话退出与机器令牌 8 条接口迁入 Go（API_GO_ACCOUNT_SECURITY_MODE，默认 legacy）+ 修 AS1–AS4 |
| [#62](https://github.com/wei500L/newwei/pull/62) | [a7758f517db4](https://github.com/wei500L/newwei/commit/a7758f517db43d792e06c17d2f43c82226d21bae) | 🔐 feat(api-go): 已认证 MFA 管理与组织 OIDC 配置 7 条接口迁入 Go（API_GO_AUTH_FACTORS_MODE，默认 legacy）+ 修 AF1–AF5 |
| [#63](https://github.com/wei500L/newwei/pull/63) | [9008c02b381d](https://github.com/wei500L/newwei/commit/9008c02b381dc21ecc0bb4272e92faf3ac5c086c) | ✨ feat(api-go): 迁移组织/角色/成员管理 8 个 GraphQL mutation |
| [#67](https://github.com/wei500L/newwei/pull/67) | [7fc17faa3dc5](https://github.com/wei500L/newwei/commit/7fc17faa3dc5043537bad4038299d11fdba4758d) | 🔀 integration(api-go): 一次性落地 #59/#62/#63/#65/#66 五个迁移批次（冲突统一并集解决 + 全量验证） |

- [docs/refactor/go-account-security.md](../../go-account-security.md)

- [docs/refactor/go-auth-factors.md](../../go-auth-factors.md)

- [docs/refactor/go-rbac.md](../../go-rbac.md)

- [docs/refactor/go-graphql-org-access-write.md](../../go-graphql-org-access-write.md)

后续任务：只将上表 Nest 缺口作为候选；先查任务认领和最新代码，再按完整产品链路选批。未记录的部署配置、所有外部真实调用结果均不能推定。
