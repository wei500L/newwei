# AUTH-LOGIN-001 · 登录与会话签发主链

- 状态：reserved；2026-10-18按用户“再写个任务提示词，新开窗口”认领并发出。本规划窗口不实施业务，不启动或操作编码对话。
- 基线：origin/main 9d0462e16d88d146b8afbf67cdd58d8b7419ff29；#69 merged，#70 OPEN/Ready head adb765d0。main最近五次普通CI成功；相对地图3cedce9a仅文档/导航变化。
- 分支 / worktree：refactor/go-auth-login / /Users/oo/project/newwei-go-auth-login；规划时未创建。
- [完整执行提示词](AUTH-LOGIN-001.prompt.md)；记录随[Ready文档PR #71](https://github.com/wei500L/newwei/pull/71)发布，非业务PR。

## 范围与所有权

11个POST /api/auth：login、refresh、send-login-code、login-with-code、mfa/verify-login、mfa/enrollment/start、mfa/enrollment/complete、password/forgot、password/reset、send-verification、verify-email。后两条AllowAuthenticated，其他公开但服务端验证凭据；enrollment/start成功201，其余200。会话、challenge、验证码、真实SMTP、密码重置事务与审计副作用整体迁移。

建议新增internal/authlogin与cmd/api/auth_login.go，复用authn/authhttp/authz、accountsecurity、authfactors；只为本链小幅导出具名接口。main/config/精确legacyproxy/示例配置最小增量，新API_GO_AUTH_LOGIN_MODE默认legacy。MySQL、Redis、JWT、SMTP与既有MFA密钥配置；不依赖Mongo、其他迁移开关或尚未合并的#70邮件helper。

与#70工作台写、NEWS-BRIEF-001、STORAGE-MEDIA-001、ITEMS-LIST-001业务文件隔离；公共main/config/compose按语义段取并集，不取得GraphQL顶层接线所有权。BL-06后续OIDC/邀请不得并行改会话协议。已有账户/已认证MFA、OIDC/邀请/注册/头像/导出与worker/cron排除；Nest审计Outbox消费者继续执行。

## 只读核实事实与边界

按上述SHA深入读取AuthController/DTO、AuthService登录/签发/refresh/邮箱流程、MfaService挑战、PasswordResetService、OrgService组织选项、验证码/安全配置、CacheService.wrap、登录/重置限流、EmailService及模板、Prisma表；对照Go JWT/账户profile/密码/退出/审计与MFA enrollment/crypto/store/cache。核对#70实际文件diff，候选核心业务未被占用。没有扩大为全仓重审。

refresh黑名单在grace缓存前、条件领取在bcrypt比对前；登录无org可选最早活动membership，refresh不同。enrollment challenge领取在恢复码旋转前，登录challenge凭据验证后消费。send-login-code邮件失败吞掉并清理；forgot邮件失败传播；send-verification是邮箱变更。现有Go审计helper硬编码NULL IP，不能直接视作完整复用。真实SMTP/MySQL/Redis并发行为未运行验证；无生产切流证据。

## 轻量交接

用户希望现有编码窗口继续业务，不被地图文档工作打断。本批编码窗口不改共享地图/索引，仅PR说明或一份精简交付记录；规划窗口依据业务PR/head/CI回填状态和identity。新认领记录仅本task、稳定提示词和必要索引/占用增量，不重写前几批文档。当前无业务PR、业务实现/注册/合并/部署均未新增。
