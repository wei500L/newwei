package crawlworkflow

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

// dbtx 让读路径在连接池与事务之间复用同一批查询函数。
type dbtx interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
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

func (s *Service) loadWorkflow(ctx context.Context, q dbtx, id string) (workflowRow, error) {
	row := q.QueryRowContext(ctx, "SELECT "+workflowSelect+" FROM CrawlStrategyWorkflow WHERE id = ?", id)
	return scanWorkflow(row)
}

func loadVersionByID(ctx context.Context, q dbtx, id string) (versionRow, error) {
	row := q.QueryRowContext(ctx, "SELECT "+versionSelect+" FROM CrawlStrategyWorkflowVersion WHERE id = ?", id)
	return scanVersion(row)
}

func loadVersionsByWorkflow(ctx context.Context, q dbtx, workflowID string, limit int) ([]versionRow, error) {
	query := "SELECT " + versionSelect + " FROM CrawlStrategyWorkflowVersion WHERE workflowId = ? ORDER BY version DESC"
	args := []any{workflowID}
	if limit > 0 {
		query += " LIMIT ?"
		args = append(args, limit)
	}
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []versionRow{}
	for rows.Next() {
		row, err := scanVersion(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// loadWorkflowDocument 组装详情/列表共用的 include 语义：
// publishedVersion 单条 + versions 最近 10 条（version desc）。
func (s *Service) loadWorkflowDocument(ctx context.Context, q dbtx, row workflowRow) (workflowDocument, error) {
	var published *versionRow
	if row.PublishedVersionID.Valid {
		version, err := loadVersionByID(ctx, q, row.PublishedVersionID.String)
		switch {
		case err == nil:
			published = &version
		case isMissingRow(err):
			published = nil
		default:
			return workflowDocument{}, err
		}
	}
	versions, err := loadVersionsByWorkflow(ctx, q, row.ID, 10)
	if err != nil {
		return workflowDocument{}, err
	}
	return mapWorkflow(row, published, versions), nil
}

func isMissingRow(err error) bool {
	var status *statusError
	return errors.As(err, &status) && status.status == 404
}

// ListWorkflows 对齐 listWorkflows：只查该 orgId；search trim 后非空时
// name/description contains；updatedAt desc、createdAt desc；
// 每条带 publishedVersion 与最近 10 个版本；响应是数组。
func (s *Service) ListWorkflows(ctx context.Context, orgID, search string) ([]workflowDocument, error) {
	where := []string{"orgId = ?"}
	args := []any{orgID}
	trimmed := strings.TrimSpace(search)
	if trimmed != "" {
		pattern := likeContains(trimmed)
		where = append(where, "(name LIKE ? OR description LIKE ?)")
		args = append(args, pattern, pattern)
	}
	query := "SELECT " + workflowSelect + " FROM CrawlStrategyWorkflow WHERE " +
		strings.Join(where, " AND ") + " ORDER BY updatedAt DESC, createdAt DESC"
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	scanned := []workflowRow{}
	for rows.Next() {
		row, err := scanWorkflow(rows)
		if err != nil {
			return nil, err
		}
		scanned = append(scanned, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]workflowDocument, 0, len(scanned))
	for _, row := range scanned {
		document, err := s.loadWorkflowDocument(ctx, s.db, row)
		if err != nil {
			return nil, err
		}
		out = append(out, document)
	}
	return out, nil
}

// GetWorkflow 对齐 getWorkflow：先按主键查，再看 orgId；不存在或跨组织
// 都是 404 Workflow not found。
func (s *Service) GetWorkflow(ctx context.Context, orgID, id string) (workflowDocument, error) {
	row, err := s.loadWorkflow(ctx, s.db, id)
	if err != nil {
		return workflowDocument{}, err
	}
	if row.OrgID != orgID {
		return workflowDocument{}, errWorkflowMissing
	}
	return s.loadWorkflowDocument(ctx, s.db, row)
}

// CreateWorkflow 对齐 createWorkflow（含缺陷 2 的服务端 trim 检查）。
func (s *Service) CreateWorkflow(ctx context.Context, orgID, actorID string, input createInput) (workflowDocument, error) {
	name := strings.TrimSpace(input.Name)
	if name == "" {
		return workflowDocument{}, &inputError{Message: "name is required"}
	}
	definition := normalizeDefinition(input.DraftDefinition)
	if err := assertSupportedWorkflowDefinition(definition, "draftDefinition"); err != nil {
		return workflowDocument{}, err
	}
	definitionJSON, err := json.Marshal(definition)
	if err != nil {
		return workflowDocument{}, err
	}
	id, err := newRowID()
	if err != nil {
		return workflowDocument{}, err
	}
	now := nowMillis()
	_, err = s.db.ExecContext(ctx, `
INSERT INTO CrawlStrategyWorkflow (id, orgId, name, description, draftDefinition, createdById, updatedById, createdAt, updatedAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, orgID, name, nullableString(input.Description), []byte(definitionJSON), actorID, actorID, now, now)
	if err != nil {
		return workflowDocument{}, err
	}
	row := workflowRow{
		ID:              id,
		OrgID:           orgID,
		Name:            name,
		Description:     sqlNullString(input.Description),
		DraftDefinition: definitionJSON,
		CreatedByID:     actorID,
		UpdatedByID:     sqlNullString(&actorID),
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	return mapWorkflow(row, nil, nil), nil
}

// UpdateDraft 对齐 updateDraft + 缺陷 2 修复：
//   - name 出现但 trim 后为空 → 400 name is required，不执行 UPDATE；
//   - name 省略不改原名；
//   - name 为 null 时镜像 NestJS 的 null.trim() TypeError（500）；
//   - WHERE 同时包含 id 与 orgId。
func (s *Service) UpdateDraft(ctx context.Context, orgID, actorID, id string, input updateDraftInput) (workflowDocument, error) {
	row, err := s.loadWorkflow(ctx, s.db, id)
	if err != nil {
		return workflowDocument{}, err
	}
	if row.OrgID != orgID {
		return workflowDocument{}, errWorkflowMissing
	}
	definition := normalizeDefinition(input.DraftDefinition)
	if err := assertSupportedWorkflowDefinition(definition, "draftDefinition"); err != nil {
		return workflowDocument{}, err
	}
	if input.NameIsNull {
		return workflowDocument{}, errMirroredServerError
	}
	definitionJSON, err := json.Marshal(definition)
	if err != nil {
		return workflowDocument{}, err
	}
	now := nowMillis()
	sets := []string{"draftDefinition = ?", "updatedById = ?", "updatedAt = ?"}
	args := []any{[]byte(definitionJSON), actorID, now}
	if input.NamePresent {
		name := strings.TrimSpace(input.Name)
		if name == "" {
			return workflowDocument{}, &inputError{Message: "name is required"}
		}
		sets = append(sets, "name = ?")
		args = append(args, name)
	}
	if input.DescriptionSet {
		sets = append(sets, "description = ?")
		args = append(args, nullableString(input.Description))
	}
	query := "UPDATE CrawlStrategyWorkflow SET " + strings.Join(sets, ", ") + " WHERE id = ? AND orgId = ?"
	args = append(args, id, orgID)
	result, err := s.db.ExecContext(ctx, query, args...)
	if err != nil {
		return workflowDocument{}, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return workflowDocument{}, err
	}
	if affected != 1 {
		return workflowDocument{}, errWorkflowMissing
	}
	updated, err := s.loadWorkflow(ctx, s.db, id)
	if err != nil {
		return workflowDocument{}, err
	}
	return s.loadWorkflowDocument(ctx, s.db, updated)
}

// ListVersions 对齐 listVersions：工作流必须属于该 org；
// 返回全部版本（不只 10 条），version desc、createdAt desc。
func (s *Service) ListVersions(ctx context.Context, orgID, workflowID string) ([]versionDocument, error) {
	row, err := s.loadWorkflow(ctx, s.db, workflowID)
	if err != nil {
		return nil, err
	}
	if row.OrgID != orgID {
		return nil, errWorkflowMissing
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT "+versionSelect+" FROM CrawlStrategyWorkflowVersion WHERE orgId = ? AND workflowId = ? ORDER BY version DESC, createdAt DESC",
		orgID, workflowID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []versionRow{}
	for rows.Next() {
		version, err := scanVersion(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, version)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return mapWorkflowVersions(out), nil
}

// GetVersion 对齐 getVersion：按主键查，orgId 不同或不存在都是
// 404 Workflow version not found。
func (s *Service) GetVersion(ctx context.Context, orgID, versionID string) (versionDocument, error) {
	row, err := loadVersionByID(ctx, s.db, versionID)
	if err != nil {
		return versionDocument{}, err
	}
	if row.OrgID != orgID {
		return versionDocument{}, errVersionMissing
	}
	return mapWorkflowVersion(row), nil
}

// CompareVersions 对齐 compareVersions：两个版本都按 getVersion 规则取，
// 任一不在本组织即 404；diff 结构见 compare.go。
func (s *Service) CompareVersions(ctx context.Context, orgID string, input compareInput) (compareResult, error) {
	left, err := s.GetVersion(ctx, orgID, input.LeftVersionID)
	if err != nil {
		return compareResult{}, err
	}
	right, err := s.GetVersion(ctx, orgID, input.RightVersionID)
	if err != nil {
		return compareResult{}, err
	}
	settingsDiff := buildSettingsDiff(left.Definition.Settings, right.Definition.Settings)
	nodesDiff := buildNodeDiff(left.Definition.Nodes, right.Definition.Nodes)
	edgesDiff := buildEdgeDiff(left.Definition.Edges, right.Definition.Edges)
	bindingImpact, err := s.buildBindingImpact(ctx, orgID, left, right)
	if err != nil {
		return compareResult{}, err
	}

	definitionDiff := definitionDiff{
		LeftSettings:  left.Definition.Settings,
		RightSettings: right.Definition.Settings,
		LeftNodeIDs:   nodeIDs(left.Definition.Nodes),
		RightNodeIDs:  nodeIDs(right.Definition.Nodes),
		Settings:      settingsDiff,
		Nodes:         nodesDiff,
		Edges:         edgesDiff,
	}
	return compareResult{
		Left:  left,
		Right: right,
		Summary: versionCompareSummary{
			NodeCountDelta:       len(right.Definition.Nodes) - len(left.Definition.Nodes),
			EdgeCountDelta:       len(right.Definition.Edges) - len(left.Definition.Edges),
			ChangedSettingsCount: len(settingsDiff),
			AddedNodeCount:       len(nodesDiff.Added),
			RemovedNodeCount:     len(nodesDiff.Removed),
			ChangedNodeCount:     len(nodesDiff.Changed),
			AddedEdgeCount:       len(edgesDiff.Added),
			RemovedEdgeCount:     len(edgesDiff.Removed),
		},
		DefinitionDiff: definitionDiff,
		BindingImpact:  bindingImpact,
	}, nil
}

func nodeIDs(nodes []WorkflowNode) []string {
	out := make([]string, 0, len(nodes))
	for _, node := range nodes {
		out = append(out, node.ID)
	}
	return out
}

// ProfileBridge 对齐 buildLegacyProfileBridge：profile 不存在或 org 不同
// 都是 404 Crawl site profile not found；config 走 normalizeCrawlSiteProfileConfig
// 的 bridge 子集（含断言）。
func (s *Service) ProfileBridge(ctx context.Context, orgID, profileID, seedURL string) (WorkflowDefinition, error) {
	var name string
	var description sql.NullString
	var executionMode string
	var config []byte
	var rowOrgID string
	err := s.db.QueryRowContext(ctx,
		"SELECT orgId, name, description, executionMode, config FROM CrawlSiteProfile WHERE id = ?",
		profileID).Scan(&rowOrgID, &name, &description, &executionMode, &config)
	if errors.Is(err, sql.ErrNoRows) {
		return WorkflowDefinition{}, newStatus(404, "Crawl site profile not found")
	}
	if err != nil {
		return WorkflowDefinition{}, err
	}
	if rowOrgID != orgID {
		return WorkflowDefinition{}, newStatus(404, "Crawl site profile not found")
	}
	normalized, err := normalizeProfileConfig(config)
	if err != nil {
		return WorkflowDefinition{}, err
	}
	return buildWorkflowFromProfile(profileBridgeInput{
		Name:          name,
		Description:   nullString(description),
		ExecutionMode: executionMode,
	}, normalized, seedURL), nil
}

// NewsSourceBridge 对齐 buildLegacyNewsSourceBridge：news source 不存在或
// org 不同都是 404 News source not found；模板查询不带 orgId（与 NestJS
// 现有 include 相同，本批不改）。crawlOptions 只在模板 isActive 且是
// 对象时带上。
func (s *Service) NewsSourceBridge(ctx context.Context, orgID, sourceID string) (WorkflowDefinition, error) {
	var rowOrgID, rawURL string
	var config []byte
	var crawlTemplateID sql.NullString
	err := s.db.QueryRowContext(ctx,
		"SELECT orgId, url, config, crawlTemplateId FROM NewsSource WHERE id = ?",
		sourceID).Scan(&rowOrgID, &rawURL, &config, &crawlTemplateID)
	if errors.Is(err, sql.ErrNoRows) {
		return WorkflowDefinition{}, newStatus(404, "News source not found")
	}
	if err != nil {
		return WorkflowDefinition{}, err
	}
	if rowOrgID != orgID {
		return WorkflowDefinition{}, newStatus(404, "News source not found")
	}

	var crawlOptions json.RawMessage
	if crawlTemplateID.Valid {
		var templateID string
		var isActive bool
		var options []byte
		err := s.db.QueryRowContext(ctx,
			"SELECT id, isActive, crawlOptions FROM CrawlTemplate WHERE id = ?",
			crawlTemplateID.String).Scan(&templateID, &isActive, &options)
		if err == nil {
			if isActive && jsonIsObjectRaw(options) {
				crawlOptions = cloneRaw(options)
			}
		} else if !errors.Is(err, sql.ErrNoRows) {
			return WorkflowDefinition{}, err
		}
	}
	configRaw := json.RawMessage(nil)
	if jsonIsObjectRaw(config) {
		configRaw = cloneRaw(config)
	}
	return buildWorkflowFromNewsSource(rawURL, configRaw, crawlOptions), nil
}

// AuthenticateMachine 与 newssources.AuthenticateMachine 相同：
// SHA-256 十六进制查 MachineAccessToken.tokenHash，连 Org.isActive；
// 查不到、已撤销、已过期、组织停用 → 401 Invalid machine token；
// 查到就更新 lastUsedAt。权限只解析令牌行 permissions JSON 里的字符串
// 数组；orgId 只用令牌行的 orgId。
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

func placeholders(n int) string {
	parts := make([]string, n)
	for i := range parts {
		parts[i] = "?"
	}
	return strings.Join(parts, ",")
}

func stringsToArgs(values []string) []any {
	out := make([]any, len(values))
	for i, value := range values {
		out[i] = value
	}
	return out
}

func likeContains(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return "%" + replacer.Replace(value) + "%"
}

func sqlNullString(value *string) sql.NullString {
	if value == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *value, Valid: true}
}
