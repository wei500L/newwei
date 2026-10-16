package crawltemplate

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// Service 承载 SQL 与响应构造。handler 只做路由与鉴权。
type Service struct {
	db *sql.DB
}

func NewService(db *sql.DB) *Service {
	return &Service{db: db}
}

func nowMillis() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// newRowID 写入 Prisma cuid 列（MySQL 没有客户端默认值，必须显式插入;
// 形状与既有 Go 批次一致：c + 24 位十六进制）。
func newRowID() (string, error) {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buf[:]), nil
}

// load 按 id + orgId 读一行；不存在或跨组织 → 404 Crawl template not found。
func (s *Service) load(ctx context.Context, orgID, id string) (templateRow, error) {
	row := s.db.QueryRowContext(ctx,
		"SELECT "+templateSelect+" FROM CrawlTemplate WHERE id = ? AND orgId = ?", id, orgID)
	return scanTemplate(row)
}

// ListTemplates 对齐 listTemplates：只查该 orgId；search trim 后非空时
// 只对 name 做 contains（数据库默认排序规则，不搜 description）；
// updatedAt desc、createdAt desc；响应是数组（不包 items）。
func (s *Service) ListTemplates(ctx context.Context, orgID, search string) ([]templateDocument, error) {
	where := []string{"orgId = ?"}
	args := []any{orgID}
	trimmed := strings.TrimSpace(search)
	if trimmed != "" {
		where = append(where, "name LIKE ?")
		args = append(args, likeContains(trimmed))
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT "+templateSelect+" FROM CrawlTemplate WHERE "+strings.Join(where, " AND ")+
			" ORDER BY updatedAt DESC, createdAt DESC", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	scanned := []templateRow{}
	for rows.Next() {
		row, err := scanTemplate(rows)
		if err != nil {
			return nil, err
		}
		scanned = append(scanned, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return mapTemplates(scanned), nil
}

// CreateTemplate 对齐 createTemplate：
//   - name 服务端 trim 后空 → 400 name is required；
//   - description 按 normalizeOptionalNullableString（空/空白 → NULL）；
//   - isActive 缺省 true；
//   - crawlOptions 缺省或 null → 数据库 NULL（不写 {}）；对象先过两个
//     守卫，失败 400 不落库；
//   - (orgId, name) 唯一冲突对齐 NestJS 现有失败（500 Internal server error）。
func (s *Service) CreateTemplate(ctx context.Context, orgID string, input createInput) (templateDocument, error) {
	name := strings.TrimSpace(input.Name)
	if name == "" {
		return templateDocument{}, &inputError{Message: "name is required"}
	}
	isActive := true
	if input.IsActive != nil {
		isActive = *input.IsActive
	}
	optionsArg, err := validatedCrawlOptionsArg(input.CrawlOptions)
	if err != nil {
		return templateDocument{}, err
	}
	id, err := newRowID()
	if err != nil {
		return templateDocument{}, err
	}
	now := nowMillis()
	_, err = s.db.ExecContext(ctx, `
INSERT INTO CrawlTemplate (id, orgId, name, description, isActive, crawlOptions, createdAt, updatedAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		id, orgID, name, normalizeOptionalStringArg(input.Description), boolArg(isActive), optionsArg, now, now)
	if err != nil {
		if uniqueConflict(err) {
			return templateDocument{}, errMirroredServerError
		}
		return templateDocument{}, err
	}
	row, err := s.load(ctx, orgID, id)
	if err != nil {
		return templateDocument{}, err
	}
	return mapTemplate(row), nil
}

// UpdateTemplate 对齐 updateTemplate（含 WHERE 缺陷修复）：
//   - 先确认本组织存在（不存在/跨组织 → 404），与 NestJS 先 findUnique
//     再比较 orgId 同序（空白 name 的 400 也排在这之后）；
//   - 只更新 body 里出现的字段；
//   - name 出现时 trim，空 → 400 name is required；null → 镜像 500；
//   - isActive 出现时按布尔值；null → 镜像 500；
//   - crawlOptions null → 数据库 NULL；对象先过两个守卫再写；省略不改；
//   - UPDATE 的 WHERE 同时包含 id 与 orgId。
func (s *Service) UpdateTemplate(ctx context.Context, orgID, id string, input updateInput) (templateDocument, error) {
	var existingID string
	err := s.db.QueryRowContext(ctx, "SELECT id FROM CrawlTemplate WHERE id = ? AND orgId = ?", id, orgID).Scan(&existingID)
	if errors.Is(err, sql.ErrNoRows) {
		return templateDocument{}, errTemplateMissing
	}
	if err != nil {
		return templateDocument{}, err
	}

	sets := []string{}
	args := []any{}
	if input.NameSet {
		if input.Name == nil {
			// 镜像 NestJS：input.name === null 时的 null.trim() TypeError → 500。
			return templateDocument{}, errMirroredServerError
		}
		name := strings.TrimSpace(*input.Name)
		if name == "" {
			return templateDocument{}, &inputError{Message: "name is required"}
		}
		sets = append(sets, "name = ?")
		args = append(args, name)
	}
	if input.DescriptionSet {
		sets = append(sets, "description = ?")
		args = append(args, normalizeOptionalStringArg(input.Description))
	}
	if input.IsActiveSet {
		if input.IsActive == nil {
			// 镜像 NestJS：Prisma 拒绝为不可空 Boolean 写 null → 500。
			return templateDocument{}, errMirroredServerError
		}
		sets = append(sets, "isActive = ?")
		args = append(args, boolArg(*input.IsActive))
	}
	if input.CrawlOptionsSet {
		optionsArg, err := validatedCrawlOptionsArg(input.CrawlOptions)
		if err != nil {
			return templateDocument{}, err
		}
		sets = append(sets, "crawlOptions = ?")
		args = append(args, optionsArg)
	}
	now := nowMillis()
	// Prisma 的 @updatedAt 在每次 update 都写新时间。
	sets = append(sets, "updatedAt = ?")
	args = append(args, now)
	query := "UPDATE CrawlTemplate SET " + strings.Join(sets, ", ") + " WHERE id = ? AND orgId = ?"
	args = append(args, id, orgID)
	if _, err := s.db.ExecContext(ctx, query, args...); err != nil {
		if uniqueConflict(err) {
			return templateDocument{}, errMirroredServerError
		}
		return templateDocument{}, err
	}
	row, err := s.load(ctx, orgID, id)
	if err != nil {
		return templateDocument{}, err
	}
	return mapTemplate(row), nil
}

// DeleteTemplate 对齐 deleteTemplate（含 WHERE 缺陷修复）：不存在或跨组织
// → 404；成功不返回行（handler 写 {ok:true}）。被新闻源引用时按数据库现有
// 外键行为失败，不先清引用（Nest 的 deleteTemplate 也不清理 newsSources）。
func (s *Service) DeleteTemplate(ctx context.Context, orgID, id string) error {
	res, err := s.db.ExecContext(ctx, "DELETE FROM CrawlTemplate WHERE id = ? AND orgId = ?", id, orgID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return errTemplateMissing
	}
	return nil
}

// validatedCrawlOptionsArg 对齐 normalizeOptionalObject 的写库形态：
// nil（缺省/null）→ NULL；对象先过 assertNoUnsupportedProxy 再
// assertNoCrawl4aiLlmOptions（顺序与 NestJS 一致），否则 400；
// 通过后按原文写 JSON 列。
func validatedCrawlOptionsArg(raw json.RawMessage) (any, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	if !jsonIsObjectRaw(raw) {
		return nil, &inputError{Message: "crawlOptions must be an object"}
	}
	if err := assertNoUnsupportedProxy(raw, "crawlOptions"); err != nil {
		return nil, err
	}
	if err := assertNoCrawl4aiLlmOptions(raw, "crawlOptions"); err != nil {
		return nil, err
	}
	return []byte(raw), nil
}

// AuthenticateMachine 与 newssources/crawlprofile/crawlworkflow 相同：
// SHA-256 十六进制查 MachineAccessToken.tokenHash，连 Org.isActive；
// 查不到、已撤销、已过期、组织停用 → 401 Invalid machine token；查到更新
// lastUsedAt。权限只解析令牌行 permissions JSON 里的字符串数组；orgId 只用
// 令牌行的。
func (s *Service) AuthenticateMachine(ctx context.Context, token string) (*authhttp.Identity, error) {
	sum := sha256.Sum256([]byte(token))
	var id, orgID string
	var permissions []byte
	var expires, revoked sql.NullTime
	var active int
	err := s.db.QueryRowContext(ctx, `
SELECT t.id, t.orgId, t.permissions, t.expiresAt, t.revokedAt, o.isActive
FROM MachineAccessToken t
JOIN Org o ON o.id = t.orgId
WHERE t.tokenHash = ?`, hex.EncodeToString(sum[:]),
	).Scan(&id, &orgID, &permissions, &expires, &revoked, &active)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, newStatus(401, "Invalid machine token")
	}
	if err != nil {
		return nil, err
	}
	if revoked.Valid || active == 0 || (expires.Valid && !expires.Time.After(time.Now())) {
		return nil, newStatus(401, "Invalid machine token")
	}
	_, _ = s.db.ExecContext(ctx, `UPDATE MachineAccessToken SET lastUsedAt = ? WHERE id = ?`, nowMillis(), id)
	return authhttp.NewIdentity("machine:"+id, orgID, permissionList(permissions)), nil
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

// normalizeOptionalStringArg 对齐 normalizeOptionalNullableString 的写库
// 形态：null/空白 → NULL；其余写 trim 值。
func normalizeOptionalStringArg(value *string) any {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return trimmed
}

func boolArg(value bool) int {
	if value {
		return 1
	}
	return 0
}

// likeContains 转义 LIKE 通配符（与 Prisma contains 的转义语义一致）。
func likeContains(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return "%" + replacer.Replace(value) + "%"
}
