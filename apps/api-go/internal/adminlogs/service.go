package adminlogs

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// Service 承载 MySQL / Mongo 查询与响应构造。handler 只做路由与鉴权。
type Service struct {
	db *sql.DB
	// logs 是 Mongo 的 tasklogs，events 是 exceptionevents（都由 main 注入
	// 同一条已打开的 Mongo 连接）。
	logs   *mongo.Collection
	events *mongo.Collection
}

// NewService 组装 7 条 GET 的三个只读来源。database 为 nil 时 Mongo 查询
// 一律失败（fail-closed，不降级成空结果）。
func NewService(db *sql.DB, database *mongo.Database) *Service {
	service := &Service{db: db}
	if database != nil {
		service.logs = database.Collection(taskLogsCollection)
		service.events = database.Collection(exceptionEventsCollection)
	}
	return service
}

// AuthenticateMachine 与 crawltemplate/crawlprofile 的同名方法一致：
// 经共享 authhttp.MachineResolver（SHA-256）查 MachineAccessToken.tokenHash，连 Org.isActive；查到
// 更新 lastUsedAt；权限只取令牌行 permissions，orgId 只用令牌行的。
func (s *Service) AuthenticateMachine(ctx context.Context, token string) (*authhttp.Identity, error) {
	identity, err := authhttp.NewMachineResolver(s.db, nil).Resolve(ctx, token)
	if errors.Is(err, authhttp.ErrInvalidMachineToken) {
		return nil, newStatus(401, "Invalid machine token")
	}
	return identity, err
}

func nowMillis() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

func permissionList(raw []byte) []string {
	var parsed []any
	if json.Unmarshal(raw, &parsed) != nil {
		return nil
	}
	out := make([]string, 0, len(parsed))
	for _, item := range parsed {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

// ---- 审计日志（MySQL AuditLog） ----

type auditFilters struct {
	search   string
	resource string
	action   string
	start    *time.Time
	end      *time.Time
}

// ListAuditLogs 对齐 listAuditLogs：where 恒含 orgId；resource / action 是
// contains；search 是 resource / action / actorId / ipAddress 四个字段的 OR
// contains；createdAt 落在 [start, end]；createdAt desc + skip/take。
func (s *Service) ListAuditLogs(ctx context.Context, orgID string, filters auditFilters, page, pageSize int) (paginatedAuditLogs, error) {
	if s.db == nil {
		return paginatedAuditLogs{}, errors.New("mysql is not configured")
	}
	normalizedPage, normalizedPageSize := normalizePagination(page, pageSize)

	clauses := []string{"orgId = ?"}
	args := []any{orgID}
	if filters.resource != "" {
		clauses = append(clauses, "resource LIKE ?")
		args = append(args, likeContains(filters.resource))
	}
	if filters.action != "" {
		clauses = append(clauses, "action LIKE ?")
		args = append(args, likeContains(filters.action))
	}
	if filters.start != nil {
		clauses = append(clauses, "createdAt >= ?")
		args = append(args, *filters.start)
	}
	if filters.end != nil {
		clauses = append(clauses, "createdAt <= ?")
		args = append(args, *filters.end)
	}
	if filters.search != "" {
		clauses = append(clauses,
			"(resource LIKE ? OR action LIKE ? OR actorId LIKE ? OR ipAddress LIKE ?)")
		pattern := likeContains(filters.search)
		args = append(args, pattern, pattern, pattern, pattern)
	}
	where := strings.Join(clauses, " AND ")

	var total int
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM AuditLog WHERE "+where, args...).Scan(&total); err != nil {
		return paginatedAuditLogs{}, err
	}

	skip := (normalizedPage - 1) * normalizedPageSize
	listArgs := append(append([]any{}, args...), normalizedPageSize, skip)
	rows, err := s.db.QueryContext(ctx,
		"SELECT id, orgId, actorId, resource, action, metadata, ipAddress, createdAt FROM AuditLog WHERE "+
			where+" ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?", listArgs...)
	if err != nil {
		return paginatedAuditLogs{}, err
	}
	defer rows.Close()

	items := []jsonObject{}
	for rows.Next() {
		var id, itemOrgID, resource, action string
		var actorID, ipAddress sql.NullString
		var metadata []byte
		var createdAt time.Time
		if err := rows.Scan(&id, &itemOrgID, &actorID, &resource, &action, &metadata, &ipAddress, &createdAt); err != nil {
			return paginatedAuditLogs{}, err
		}
		items = append(items, jsonObject{
			field("id", id),
			field("orgId", itemOrgID),
			field("actorId", nullableString(actorID)),
			field("resource", resource),
			field("action", action),
			field("metadata", rawJSONOrNull(metadata)),
			field("ipAddress", nullableString(ipAddress)),
			field("createdAt", formatJSTime(createdAt)),
		})
	}
	if err := rows.Err(); err != nil {
		return paginatedAuditLogs{}, err
	}

	return paginatedAuditLogs{
		Page:     normalizedPage,
		PageSize: normalizedPageSize,
		Total:    total,
		Items:    items,
	}, nil
}

func nullableString(value sql.NullString) any {
	if !value.Valid {
		return nil
	}
	return value.String
}

// rawJSONOrNull 让 AuditLog.metadata 原样输出（Prisma Json 读出来就是已解析
// 的 JSON 值）；SQL NULL 与非 JSON 内容都输出 null。
func rawJSONOrNull(value []byte) any {
	if len(value) == 0 || !json.Valid(value) {
		return nil
	}
	return json.RawMessage(value)
}

// likeContains 对齐 Prisma contains 的 LIKE 语义：转义 \ % _ 再包 %…%。
func likeContains(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return "%" + replacer.Replace(value) + "%"
}
