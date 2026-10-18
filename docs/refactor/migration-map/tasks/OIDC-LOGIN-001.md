# OIDC-LOGIN-001 · 组织SSO完整登录与一次性交接

本轮占用刷新（2026-10-18）：状态pr_open，Ready [#83](https://github.com/wei500L/newwei/pull/83)，head `2c52763ccbb6db95d5b84b3b5d57add3f13adfc5`；实际业务/端口/共享接线diff已核，main仍90765633。PR未合、真实IdP验证不能由PR推断；后续reserved/未创建文字为原发出快照。

- reserved，2026-10-18；基线origin/main90765633ac6ba2b1d97a89d0ec33be90cb69bcb7，普通CI39149114456成功；[完整提示词](OIDC-LOGIN-001.prompt.md)，认领在规划#80发布。
- 业务分支refactor/go-oidc-login，目录/Users/oo/project/newwei-go-oidc-login，规划未创建。2GET+1POST：/api/auth/sso/oidc/start、/api/auth/oidc/callback、/api/auth/sso/handoff/exchange；公开路由，302/302/200。
- 完整授权PKCE/state GETDEL、HTTPS/SSRF discovery/JWKS、公开算法真实验签、已有账户及组织成员校验、MFA/强制绑定、会话、加密策略兼容handoff。3入口内部协议工作量较大，不拼接头像/导出或重迁OIDC配置CRUD。

## 深入核实与具体修复

读完整OidcAuthService715行、Controller/DTO、AuthSecurity/opaque token/hash/SSRF、AuthService可信登录/MFA路径、Prisma挑战/OIDC模型及Web回调/NextAuthUA转发；对照Go authlogin/session/tokens/MFA和authfactors私有crypto/配置、newssources导出SSRF、main/config。候选相对3cedce9a到当前main无变化，无Go三路注册。

源码中exchangeHandoffToken先读后仅按id无条件update consumedAt，已确认Go需实现单次领取语义；本批用conditional UPDATE和RowsAffected，不添加锁/重试平台。仅保证Go入口并发一次消费，不宣称旧Nest混合消费原子，不扩改Nest。secret编码实际遵循策略，非生产或显式关闭可能明文，不能照注释声称无条件密文。

新oidclogin/wire/精确路由，authlogin可信结果小端口、authfactors secret小端口；复用既有会话/MFA/审计，独立API_GO_OIDC_LOGIN_MODE默认legacy/非法值启动失败，仅JWT/MySQL/Redis，不要求SMTP/Mongo/其他登录模式go。discovery/JWKS缓存与网络实际调用保留，无queue/worker/cron，真实IdP未验证。

## 并行边界

网关Ready #81 head0901ca15aa31d5c00e98aa5c0c3f94a201b27219实际diff已读，profiles/llmlogs/wire业务不重叠；来源策略已见settingscrawl及settingswrite新写支持开发，继续占用四root和GAP-GQL-001两处接线。本批只加自己的main/config/env条件并保留并集，不抢GraphQL修复，不改两批业务文件。

规划窗口只改任务/地图，不建业务worktree、不启动迁移、不消息其他对话。编码窗口只交业务和PR/短说明，地图集中维护；无本批Go实现/注册/合并/真实验证新增。
