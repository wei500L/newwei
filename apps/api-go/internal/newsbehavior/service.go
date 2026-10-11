package newsbehavior

import (
	"database/sql"
	"errors"

	"github.com/redis/go-redis/v9"
	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/personalnews"
)

// 失败分层与 Nest 全局过滤器对齐，不收成同一种 500：
//   - Redis 传输/解析失败 → 500（非 HttpException）
//   - MySQL 约束、数据、普通查询失败 → 500
//   - MySQL 连不上或表/列不存在（Prisma 初始化 / P2021 / P2022 一类）→ 503
//
// 里程碑去重的 Redis 失败不走这些哨兵：那一层是 fail-open。
var (
	errRedis         = errors.New("newsbehavior redis")
	errDB            = errors.New("newsbehavior mysql")
	errDBUnavailable = errors.New("newsbehavior mysql unavailable")
)

// Service 持有画像读写需要的 MySQL 与 Redis。两者都可以是 nil：
// 调用时按 Nest 的失败分层返回，不在构造函数里 panic。
type Service struct {
	db  *sql.DB
	rdb *redis.Client
}

// NewService 构造行为服务。db 与 rdb 由 main 注入，本包不读配置。
func NewService(db *sql.DB, rdb *redis.Client) *Service {
	return &Service{db: db, rdb: rdb}
}

// 编译期确认推荐域能直接拿这个服务当 BehaviorAPI。
var _ personalnews.BehaviorAPI = (*Service)(nil)

// Handler 是三条用户行为路由的 HTTP 入口。
type Handler struct {
	auth *authhttp.Authenticator
	svc  *Service
}

// NewHandler 构造 HTTP 入口。auth 为 nil 时请求 fail-closed（503），
// 不把未鉴权流量放进业务。
func NewHandler(auth *authhttp.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}
