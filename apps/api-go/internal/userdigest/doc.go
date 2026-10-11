// Package userdigest 实现每日摘要的偏好、事件聚合和投递日程设置。
//
// 只提供五个 HTTP 读/写端点。不发送邮件，不写通知，不启动 cron，
// 也不移植 runDueDeliveries。订阅表通过注入的 personalnews.SubscriptionAPI
// 访问，避免 import contentsubscriptions / contentcatalog。
package userdigest

// 发行版镜像（distroless）没有系统 tzdata。投递日程要 LoadLocation，
// 必须把时区数据库打进二进制。
import _ "time/tzdata"
