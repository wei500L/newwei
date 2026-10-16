package crawlprofile

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
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

func loadProfileByID(ctx context.Context, q dbtx, id string) (profileRow, error) {
	row := q.QueryRowContext(ctx, "SELECT "+profileSelect+" FROM CrawlSiteProfile WHERE id = ?", id)
	return scanProfile(row)
}

// ListProfiles 对齐 listProfiles：只查该 orgId；search trim 后非空时
// name/matchHost contains（数据库默认排序规则）；updatedAt desc、
// createdAt desc；响应是数组（不包 items）。
func (s *Service) ListProfiles(ctx context.Context, orgID, search string) ([]profileDocument, error) {
	where := []string{"orgId = ?"}
	args := []any{orgID}
	trimmed := strings.TrimSpace(search)
	if trimmed != "" {
		pattern := likeContains(trimmed)
		where = append(where, "(name LIKE ? OR matchHost LIKE ?)")
		args = append(args, pattern, pattern)
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT "+profileSelect+" FROM CrawlSiteProfile WHERE "+strings.Join(where, " AND ")+
			" ORDER BY updatedAt DESC, createdAt DESC", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	scanned := []profileRow{}
	for rows.Next() {
		row, err := scanProfile(rows)
		if err != nil {
			return nil, err
		}
		scanned = append(scanned, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]profileDocument, 0, len(scanned))
	for _, row := range scanned {
		document, err := mapProfile(row)
		if err != nil {
			return nil, err
		}
		out = append(out, document)
	}
	return out, nil
}

// GetProfile 对齐 getProfile：先按主键查，再看 orgId；不存在或跨组织
// 都是 404 Crawl site profile not found。
func (s *Service) GetProfile(ctx context.Context, orgID, id string) (profileDocument, error) {
	profile, err := loadProfileByID(ctx, s.db, id)
	if err != nil {
		return profileDocument{}, err
	}
	if profile.OrgID != orgID {
		return profileDocument{}, errProfileMissing
	}
	return mapProfile(profile)
}

// CreateProfile 对齐 createProfile（含缺陷 1 与缺陷 2 修复）：
//   - name trim 后空 → 400 name is required；matchHost 走 normalizeMatchHost；
//   - workflowId / workflowVersionId 非空时必须存在且属于本组织，否则
//     400 Invalid workflowId / Invalid workflowVersionId（清空 null 允许）；
//   - 画像插入与第一条 version 快照在同一事务；version 用数据库默认 1；
//   - (orgId, name) 唯一冲突对齐 NestJS 现有失败（500 Internal server error）。
func (s *Service) CreateProfile(ctx context.Context, orgID, actorID string, input createInput) (profileDocument, error) {
	name := strings.TrimSpace(input.Name)
	if name == "" {
		return profileDocument{}, &inputError{Message: "name is required"}
	}
	matchHost, err := normalizeMatchHost(input.MatchHost)
	if err != nil {
		return profileDocument{}, err
	}
	isActive := true
	if input.IsActive != nil {
		isActive = *input.IsActive
	}
	executionMode := "layered"
	if input.ExecutionMode != nil {
		executionMode = *input.ExecutionMode
	}
	workflowID := trimmedOrNil(input.WorkflowID)
	workflowVersionID := trimmedOrNil(input.WorkflowVersionID)
	workflowBindingMode := "published"
	if input.WorkflowBindingMode != nil {
		workflowBindingMode = *input.WorkflowBindingMode
	}
	config, err := normalizeCrawlSiteProfileConfig(input.Config)
	if err != nil {
		return profileDocument{}, err
	}
	if workflowID != nil {
		if err := s.assertWorkflowInOrg(ctx, orgID, *workflowID); err != nil {
			return profileDocument{}, err
		}
	}
	if workflowVersionID != nil {
		if err := s.assertWorkflowVersionInOrg(ctx, orgID, *workflowVersionID); err != nil {
			return profileDocument{}, err
		}
	}
	configJSON, err := json.Marshal(config)
	if err != nil {
		return profileDocument{}, err
	}
	id, err := newRowID()
	if err != nil {
		return profileDocument{}, err
	}
	now := nowMillis()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return profileDocument{}, err
	}
	defer func() { _ = tx.Rollback() }()

	_, err = tx.ExecContext(ctx, `
INSERT INTO CrawlSiteProfile (id, orgId, name, description, matchHost, isActive, executionMode, workflowId, workflowVersionId, workflowBindingMode, config, createdById, updatedById, publishedAt, createdAt, updatedAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, orgID, name, nullableString(input.Description), matchHost, boolArg(isActive), executionMode,
		nullableString(workflowID), nullableString(workflowVersionID), workflowBindingMode,
		[]byte(configJSON), actorID, actorID, now, now, now)
	if err != nil {
		if uniqueConflict(err) {
			return profileDocument{}, errMirroredServerError
		}
		return profileDocument{}, err
	}
	created, err := loadProfileByID(ctx, tx, id)
	if err != nil {
		return profileDocument{}, err
	}
	if err := insertProfileVersion(ctx, tx, created, actorID, now, configJSON); err != nil {
		return profileDocument{}, err
	}
	if err := tx.Commit(); err != nil {
		return profileDocument{}, err
	}
	return mapProfile(created)
}

// UpdateProfile 对齐 updateProfile（含缺陷 1 与缺陷 2 修复）：
//   - 单事务；第一条是 SELECT id ... FOR UPDATE，没有行 → 404；
//   - 只更新 body 里出现的字段；name trim 后空 → 400 name is required；
//   - config 出现时归一化写入；未出现时版本快照仍用现有 config 归一化值；
//   - version 加 1、updatedById/publishedAt 更新后，同一事务插快照；
//   - UPDATE 的 WHERE 同时包含 id 与 orgId。
func (s *Service) UpdateProfile(ctx context.Context, orgID, actorID, id string, input updateInput) (profileDocument, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return profileDocument{}, err
	}
	defer func() { _ = tx.Rollback() }()

	var lockedID string
	err = tx.QueryRowContext(ctx, "SELECT id FROM CrawlSiteProfile WHERE id = ? AND orgId = ? FOR UPDATE", id, orgID).Scan(&lockedID)
	if errors.Is(err, sql.ErrNoRows) {
		return profileDocument{}, errProfileMissing
	}
	if err != nil {
		return profileDocument{}, err
	}

	var existingConfigRaw []byte
	if err := tx.QueryRowContext(ctx, "SELECT config FROM CrawlSiteProfile WHERE id = ? AND orgId = ?", id, orgID).Scan(&existingConfigRaw); err != nil {
		return profileDocument{}, err
	}
	existingConfig, err := normalizeCrawlSiteProfileConfig(existingConfigRaw)
	if err != nil {
		return profileDocument{}, err
	}

	sets := []string{}
	args := []any{}
	if input.NameSet {
		if input.Name == nil {
			// 镜像 NestJS：input.name === null 时的 null.trim() TypeError → 500。
			return profileDocument{}, errMirroredServerError
		}
		name := strings.TrimSpace(*input.Name)
		if name == "" {
			return profileDocument{}, &inputError{Message: "name is required"}
		}
		sets = append(sets, "name = ?")
		args = append(args, name)
	}
	if input.DescriptionSet {
		sets = append(sets, "description = ?")
		args = append(args, normalizeOptionalStringArg(input.Description))
	}
	if input.MatchHostSet {
		if input.MatchHost == nil {
			// 镜像 NestJS：input.matchHost === null 时的 null.trim() TypeError → 500。
			return profileDocument{}, errMirroredServerError
		}
		matchHost, err := normalizeMatchHost(*input.MatchHost)
		if err != nil {
			return profileDocument{}, err
		}
		sets = append(sets, "matchHost = ?")
		args = append(args, matchHost)
	}
	if input.IsActiveSet {
		if input.IsActive == nil {
			// 镜像 NestJS：Prisma 拒绝为不可空 Boolean 写 null → 500。
			return profileDocument{}, errMirroredServerError
		}
		sets = append(sets, "isActive = ?")
		args = append(args, boolArg(*input.IsActive))
	}
	if input.ExecutionModeSet {
		if input.ExecutionMode == nil {
			return profileDocument{}, errMirroredServerError
		}
		sets = append(sets, "executionMode = ?")
		args = append(args, *input.ExecutionMode)
	}
	if input.WorkflowIDSet {
		// 缺陷 1：非空值必须存在且属于本组织；null（含空白 trim 后）清空允许。
		workflowID := trimmedOrNil(input.WorkflowID)
		if workflowID != nil {
			if err := s.assertWorkflowInOrg(ctx, orgID, *workflowID); err != nil {
				return profileDocument{}, err
			}
		}
		sets = append(sets, "workflowId = ?")
		args = append(args, nullableString(workflowID))
	}
	if input.WorkflowVersionIDSet {
		workflowVersionID := trimmedOrNil(input.WorkflowVersionID)
		if workflowVersionID != nil {
			if err := s.assertWorkflowVersionInOrg(ctx, orgID, *workflowVersionID); err != nil {
				return profileDocument{}, err
			}
		}
		sets = append(sets, "workflowVersionId = ?")
		args = append(args, nullableString(workflowVersionID))
	}
	if input.WorkflowBindingModeSet {
		if input.WorkflowBindingMode == nil {
			return profileDocument{}, errMirroredServerError
		}
		sets = append(sets, "workflowBindingMode = ?")
		args = append(args, *input.WorkflowBindingMode)
	}
	versionConfig := existingConfig
	if input.ConfigSet {
		config, err := normalizeCrawlSiteProfileConfig(input.Config)
		if err != nil {
			return profileDocument{}, err
		}
		configJSON, err := json.Marshal(config)
		if err != nil {
			return profileDocument{}, err
		}
		sets = append(sets, "config = ?")
		args = append(args, []byte(configJSON))
		versionConfig = config
	}
	now := nowMillis()
	sets = append(sets, "version = version + 1", "updatedById = ?", "publishedAt = ?", "updatedAt = ?")
	args = append(args, actorID, now, now)
	query := "UPDATE CrawlSiteProfile SET " + strings.Join(sets, ", ") + " WHERE id = ? AND orgId = ?"
	args = append(args, id, orgID)
	if _, err := tx.ExecContext(ctx, query, args...); err != nil {
		if uniqueConflict(err) {
			return profileDocument{}, errMirroredServerError
		}
		return profileDocument{}, err
	}
	updated, err := loadProfileByID(ctx, tx, id)
	if err != nil {
		return profileDocument{}, err
	}
	versionConfigJSON, err := json.Marshal(versionConfig)
	if err != nil {
		return profileDocument{}, err
	}
	if err := insertProfileVersion(ctx, tx, updated, actorID, now, versionConfigJSON); err != nil {
		return profileDocument{}, err
	}
	if err := tx.Commit(); err != nil {
		return profileDocument{}, err
	}
	return mapProfile(updated)
}

// ListVersions 对齐 listVersions：画像必须属于本组织；返回该 orgId 和
// profileId 的全部版本行（不是 mapProfile），version desc、createdAt desc。
func (s *Service) ListVersions(ctx context.Context, orgID, profileID string) ([]versionDocument, error) {
	var existingOrgID string
	err := s.db.QueryRowContext(ctx, "SELECT orgId FROM CrawlSiteProfile WHERE id = ?", profileID).Scan(&existingOrgID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && existingOrgID != orgID) {
		return nil, errProfileMissing
	}
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT "+versionSelect+" FROM CrawlSiteProfileVersion WHERE orgId = ? AND profileId = ? ORDER BY version DESC, createdAt DESC",
		orgID, profileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []versionRow{}
	for rows.Next() {
		version, err := scanProfileVersion(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, version)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return mapProfileVersions(out), nil
}

// RollbackProfile 对齐 rollbackProfile（含缺陷 2 修复）：
//   - version 来自控制器的 Number.parseInt(version, 10)；NaN（versionValid
//     为 false）按「找不到版本」处理；
//   - 单事务；第一条 SELECT id ... FOR UPDATE，没有行 → 404 profile not found；
//   - 快照 where 是 orgId + profileId + version；没有 → 404 version not found；
//   - 快照的 name/description/matchHost/isActive/executionMode/workflowId/
//     workflowVersionId/workflowBindingMode/config（再归一化）写回画像；
//   - version 加 1、updatedById/publishedAt 更新，同一事务插新快照。
func (s *Service) RollbackProfile(ctx context.Context, orgID, actorID, profileID string, version int, versionValid bool) (profileDocument, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return profileDocument{}, err
	}
	defer func() { _ = tx.Rollback() }()

	var lockedID string
	err = tx.QueryRowContext(ctx, "SELECT id FROM CrawlSiteProfile WHERE id = ? AND orgId = ? FOR UPDATE", profileID, orgID).Scan(&lockedID)
	if errors.Is(err, sql.ErrNoRows) {
		return profileDocument{}, errProfileMissing
	}
	if err != nil {
		return profileDocument{}, err
	}
	if !versionValid {
		return profileDocument{}, errProfileVersionMissing
	}
	snapshot, err := scanProfileVersion(tx.QueryRowContext(ctx,
		"SELECT "+versionSelect+" FROM CrawlSiteProfileVersion WHERE orgId = ? AND profileId = ? AND version = ?",
		orgID, profileID, version))
	if err != nil {
		return profileDocument{}, err
	}
	config, err := normalizeCrawlSiteProfileConfig(snapshot.Config)
	if err != nil {
		return profileDocument{}, err
	}
	configJSON, err := json.Marshal(config)
	if err != nil {
		return profileDocument{}, err
	}
	now := nowMillis()
	_, err = tx.ExecContext(ctx, `
UPDATE CrawlSiteProfile SET name = ?, description = ?, matchHost = ?, isActive = ?, executionMode = ?, workflowId = ?, workflowVersionId = ?, workflowBindingMode = ?, config = ?, version = version + 1, updatedById = ?, publishedAt = ?, updatedAt = ? WHERE id = ? AND orgId = ?`,
		snapshot.Name, nullStringArg(snapshot.Description), snapshot.MatchHost, boolArg(snapshot.IsActive),
		snapshot.ExecutionMode, nullStringArg(snapshot.WorkflowID), nullStringArg(snapshot.WorkflowVersionID),
		snapshot.WorkflowBindingMode, []byte(configJSON), actorID, now, now, profileID, orgID)
	if err != nil {
		if uniqueConflict(err) {
			return profileDocument{}, errMirroredServerError
		}
		return profileDocument{}, err
	}
	updated, err := loadProfileByID(ctx, tx, profileID)
	if err != nil {
		return profileDocument{}, err
	}
	if err := insertProfileVersion(ctx, tx, updated, actorID, now, configJSON); err != nil {
		return profileDocument{}, err
	}
	if err := tx.Commit(); err != nil {
		return profileDocument{}, err
	}
	return mapProfile(updated)
}

// MatchProfileForURL 对齐 matchProfileForUrl：url 必须能解析成绝对 URL；
// 只取本组织 isActive 的画像，updatedAt desc、createdAt desc，用
// matchHostPattern 过滤；响应 { url, host, match, candidates }，url 用
// 请求原始字符串，host 是解析出的 hostname。
func (s *Service) MatchProfileForURL(ctx context.Context, orgID, urlText string) (matchResult, error) {
	parsed, err := parseProfileURL(urlText)
	if err != nil {
		return matchResult{}, err
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT "+profileSelect+" FROM CrawlSiteProfile WHERE orgId = ? AND isActive = 1 ORDER BY updatedAt DESC, createdAt DESC",
		orgID)
	if err != nil {
		return matchResult{}, err
	}
	defer rows.Close()
	scanned := []profileRow{}
	for rows.Next() {
		row, err := scanProfile(rows)
		if err != nil {
			return matchResult{}, err
		}
		scanned = append(scanned, row)
	}
	if err := rows.Err(); err != nil {
		return matchResult{}, err
	}
	matches := []profileDocument{}
	for _, row := range scanned {
		if !matchHostPattern(row.MatchHost, parsed.hostname) {
			continue
		}
		document, err := mapProfile(row)
		if err != nil {
			return matchResult{}, err
		}
		matches = append(matches, document)
	}
	var matched *profileDocument
	if len(matches) > 0 {
		first := matches[0]
		matched = &first
	}
	return matchResult{URL: urlText, Host: parsed.hostname, Match: matched, Candidates: matches}, nil
}

// PreviewProfileDraft 对齐 previewProfileDraft：不写数据库。draft 的
// id/createdById 是 "draft"、version 0、updatedById/publishedAt 为 null、
// createdAt/updatedAt 是 Unix 纪元；draftMatchReason 两句英文原样拼接。
func (s *Service) PreviewProfileDraft(ctx context.Context, orgID string, input previewInput) (previewResult, error) {
	parsed, err := parseProfileURL(input.URL)
	if err != nil {
		return previewResult{}, err
	}
	activeMatch, err := s.MatchProfileForURL(ctx, orgID, input.URL)
	if err != nil {
		return previewResult{}, err
	}
	matchHost, err := normalizeMatchHost(input.MatchHost)
	if err != nil {
		return previewResult{}, err
	}
	name := "Draft profile"
	if input.Name != nil {
		if trimmed := strings.TrimSpace(*input.Name); trimmed != "" {
			name = trimmed
		}
	}
	isActive := true
	if input.IsActive != nil {
		isActive = *input.IsActive
	}
	executionMode := "layered"
	if input.ExecutionMode != nil {
		executionMode = *input.ExecutionMode
	}
	workflowID := trimmedOrNil(input.WorkflowID)
	workflowVersionID := trimmedOrNil(input.WorkflowVersionID)
	bindingMode := "published"
	if input.WorkflowBindingMode != nil {
		bindingMode = *input.WorkflowBindingMode
	}
	config, err := normalizeCrawlSiteProfileConfig(input.Config)
	if err != nil {
		return previewResult{}, err
	}
	epoch := time.Unix(0, 0).UTC()
	draft := draftDocument{
		ID:                  "draft",
		OrgID:               orgID,
		Name:                name,
		Description:         nil,
		MatchHost:           matchHost,
		IsActive:            isActive,
		ExecutionMode:       executionMode,
		WorkflowID:          workflowID,
		WorkflowVersionID:   workflowVersionID,
		WorkflowBindingMode: bindingMode,
		Version:             0,
		Config:              config,
		CreatedByID:         "draft",
		UpdatedByID:         nil,
		PublishedAt:         nil,
		CreatedAt:           nestFromTime(epoch),
		UpdatedAt:           nestFromTime(epoch),
	}
	draftMatches := matchHostPattern(draft.MatchHost, parsed.hostname)
	reason := "draft host pattern " + draft.MatchHost + " does not match " + parsed.hostname
	if draftMatches {
		reason = "draft host pattern " + draft.MatchHost + " matches " + parsed.hostname
	}
	return previewResult{
		URL:              input.URL,
		Host:             parsed.hostname,
		Draft:            draft,
		DraftMatches:     draftMatches,
		DraftMatchReason: reason,
		ActiveMatch:      activeMatch.Match,
		ActiveCandidates: activeMatch.Candidates,
	}, nil
}

// insertProfileVersion 在事务里插入一条 CrawlSiteProfileVersion 快照。
// version 用画像更新之后的数字（@@unique([profileId, version]) 冲突时
// 与 NestJS 现有失败对齐：500 Internal server error，不引入新文案）。
func insertProfileVersion(ctx context.Context, tx dbtx, profile profileRow, actorID string, createdAt time.Time, configJSON []byte) error {
	id, err := newRowID()
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO CrawlSiteProfileVersion (id, profileId, orgId, version, name, description, matchHost, isActive, executionMode, workflowId, workflowVersionId, workflowBindingMode, config, createdById, createdAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, profile.ID, profile.OrgID, profile.Version, profile.Name, nullStringArg(profile.Description),
		profile.MatchHost, boolArg(profile.IsActive), profile.ExecutionMode,
		nullStringArg(profile.WorkflowID), nullStringArg(profile.WorkflowVersionID),
		profile.WorkflowBindingMode, []byte(configJSON), actorID, createdAt)
	if err != nil {
		if uniqueConflict(err) {
			return errMirroredServerError
		}
		return err
	}
	return nil
}

// assertWorkflowInOrg 对齐 news-source.service.ts 的 assertWorkflowInOrg
// （缺陷 1）：不存在或跨组织都是 400 Invalid workflowId。
func (s *Service) assertWorkflowInOrg(ctx context.Context, orgID, workflowID string) error {
	var owner string
	err := s.db.QueryRowContext(ctx, "SELECT orgId FROM CrawlStrategyWorkflow WHERE id = ?", workflowID).Scan(&owner)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && owner != orgID) {
		return &inputError{Message: "Invalid workflowId"}
	}
	return err
}

// assertWorkflowVersionInOrg 对齐 assertWorkflowVersionInOrg（缺陷 1）：
// 不存在或跨组织都是 400 Invalid workflowVersionId。
func (s *Service) assertWorkflowVersionInOrg(ctx context.Context, orgID, workflowVersionID string) error {
	var owner string
	err := s.db.QueryRowContext(ctx, "SELECT orgId FROM CrawlStrategyWorkflowVersion WHERE id = ?", workflowVersionID).Scan(&owner)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && owner != orgID) {
		return &inputError{Message: "Invalid workflowVersionId"}
	}
	return err
}

// AuthenticateMachine 与 newssources/crawlworkflow 相同：SHA-256 十六进制
// 查 MachineAccessToken.tokenHash，连 Org.isActive；查不到、已撤销、
// 已过期、组织停用 → 401 Invalid machine token；查到更新 lastUsedAt。
// 权限只解析令牌行 permissions JSON 里的字符串数组；orgId 只用令牌行的。
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

// ---- profileURL（近似 WHATWG new URL 的解析） ----

var profileURLSchemePattern = regexp.MustCompile(`^([a-zA-Z][a-zA-Z0-9+\-.]*):`)

// profileURL 只需要 hostname（响应的 host 与 matchHostPattern 的输入）。
type profileURL struct {
	hostname string
}

// parseProfileURL 用 new URL(value) 的规则解析绝对 URL：
// 必须有 scheme；特殊 scheme（http/https/ws/wss/ftp）忽略任意个前导
// / 与 \ 后要求非空主机；hostname 小写（IPv6 保留方括号）。失败 → 400
// url must be a valid absolute URL。
//
// 有意不逐位复刻的边角（HTTP 路径上先被 @IsUrl 拦截，不会到达这里）：
// IDN 主机名的 punycode 转换、孤立百分号校验、端口数字与范围校验。
func parseProfileURL(value string) (profileURL, error) {
	invalid := func() (profileURL, error) {
		return profileURL{}, &inputError{Message: "url must be a valid absolute URL"}
	}
	trimmed := strings.TrimSpace(value)
	match := profileURLSchemePattern.FindStringSubmatch(trimmed)
	if match == nil {
		return invalid()
	}
	scheme := strings.ToLower(match[1])
	rest := trimmed[len(match[0]):]
	switch scheme {
	case "http", "https", "ws", "wss", "ftp":
		rest = strings.TrimLeft(rest, "/\\")
		if rest == "" {
			return invalid()
		}
		authority := rest
		if idx := strings.IndexAny(authority, "/\\?#"); idx >= 0 {
			authority = authority[:idx]
		}
		if authority == "" {
			return invalid()
		}
		hostname := hostFromAuthority(authority)
		if hostname == "" {
			return invalid()
		}
		return profileURL{hostname: strings.ToLower(hostname)}, nil
	case "file":
		if strings.HasPrefix(rest, "//") {
			authority := strings.TrimPrefix(rest, "//")
			if idx := strings.IndexAny(authority, "/\\?#"); idx >= 0 {
				authority = authority[:idx]
			}
			return profileURL{hostname: strings.ToLower(hostFromAuthority(authority))}, nil
		}
		return profileURL{}, nil
	default:
		if strings.HasPrefix(rest, "//") {
			authority := strings.TrimPrefix(rest, "//")
			if idx := strings.IndexAny(authority, "/\\?#"); idx >= 0 {
				authority = authority[:idx]
			}
			return profileURL{hostname: strings.ToLower(hostFromAuthority(authority))}, nil
		}
		return profileURL{}, nil
	}
}

// hostFromAuthority 去掉 userinfo 与端口；IPv6 主机保留方括号。
func hostFromAuthority(authority string) string {
	host := authority
	if idx := strings.LastIndex(host, "@"); idx >= 0 {
		host = host[idx+1:]
	}
	if strings.HasPrefix(host, "[") {
		if end := strings.Index(host, "]"); end >= 0 {
			return host[:end+1]
		}
		return host
	}
	if idx := strings.LastIndex(host, ":"); idx >= 0 {
		return host[:idx]
	}
	return host
}

// ---- 小工具 ----

// normalizeMatchHost 对齐 service 的 normalizeMatchHost：trim + lowerCase；
// 为空 → 400 matchHost is required。
func normalizeMatchHost(value string) (string, error) {
	trimmed := strings.ToLower(strings.TrimSpace(value))
	if trimmed == "" {
		return "", &inputError{Message: "matchHost is required"}
	}
	return trimmed, nil
}

// trimmedOrNil 对齐 `value?.trim() || null`：nil/空白 → nil。
func trimmedOrNil(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// normalizeOptionalStringArg 对齐 normalizeOptionalString（写库参数形态）：
// null/空白 → NULL；其余写 trim 值。
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

func nullStringArg(value sql.NullString) any {
	if !value.Valid {
		return nil
	}
	return value.String
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
