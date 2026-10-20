package newssources

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

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

const sourceSelect = `id, orgId, name, url, siteType, language, crawlTemplateId, workflowId, workflowVersionId, workflowBindingMode, frequencySeconds, priority, isActive, config, ` + "`group`" + `, lastRunAt, lastSuccessAt, lastFailureAt, consecutiveFailures, circuitOpenUntil, nextRunAt, createdAt, updatedAt`

type Service struct {
	db *sql.DB
	// redis carries the news-source list runtime state. It is optional: the
	// write routes work without it, and the list falls back to the empty
	// runtime block when Redis is not configured.
	redis *redis.Client
}

func NewService(db *sql.DB) *Service {
	return &Service{db: db}
}

// NewServiceWithRedis builds the service with the shared Redis client so the
// list response can include the runtime block the scheduler writes.
func NewServiceWithRedis(db *sql.DB, client *redis.Client) *Service {
	return &Service{db: db, redis: client}
}

func nowMillis() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

func newRowID() (string, error) {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buf[:]), nil
}

func (s *Service) find(ctx context.Context, orgID, id string) (sourceRow, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+sourceSelect+` FROM NewsSource WHERE id = ? AND orgId = ?`, id, orgID)
	return scanSource(row)
}

func scanSource(row interface{ Scan(dest ...any) error }) (sourceRow, error) {
	var out sourceRow
	var active int
	var config []byte
	err := row.Scan(
		&out.ID, &out.OrgID, &out.Name, &out.URL, &out.SiteType, &out.Language,
		&out.CrawlTemplateID, &out.WorkflowID, &out.WorkflowVersionID, &out.WorkflowBindingMode,
		&out.FrequencySeconds, &out.Priority, &active, &config, &out.Group,
		&out.LastRunAt, &out.LastSuccessAt, &out.LastFailureAt, &out.ConsecutiveFailures,
		&out.CircuitOpenUntil, &out.NextRunAt, &out.CreatedAt, &out.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return sourceRow{}, newStatus(404, "News source not found")
	}
	if err != nil {
		return sourceRow{}, err
	}
	out.IsActive = active != 0
	out.Config = config
	return out, nil
}

// ListDefault is List with the REST defaults (page 1, 10 per page, no filters).
// Other units use it to assert the read model round-trip without rebuilding the
// unexported query struct.
func (s *Service) ListDefault(ctx context.Context, orgID string) (map[string]any, error) {
	return s.List(ctx, orgID, listQuery{Page: 1, PageSize: 10})
}

func (s *Service) List(ctx context.Context, orgID string, query listQuery) (map[string]any, error) {
	where := []string{"orgId = ?"}
	args := []any{orgID}
	if query.Search != "" {
		pattern := likeContains(query.Search)
		where = append(where, "(name LIKE ? OR url LIKE ?)")
		args = append(args, pattern, pattern)
	}
	if query.GroupSet {
		if query.Group == nil {
			where = append(where, "`group` IS NULL")
		} else {
			where = append(where, "`group` = ?")
			args = append(args, *query.Group)
		}
	}
	clause := strings.Join(where, " AND ")
	var total int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM NewsSource WHERE `+clause, args...).Scan(&total); err != nil {
		return nil, err
	}
	listArgs := append(append([]any{}, args...), query.PageSize, (query.Page-1)*query.PageSize)
	rows, err := s.db.QueryContext(ctx, `SELECT `+sourceSelect+` FROM NewsSource WHERE `+clause+` ORDER BY updatedAt DESC, createdAt DESC LIMIT ? OFFSET ?`, listArgs...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var sources []sourceRow
	for rows.Next() {
		item, err := scanSource(rows)
		if err != nil {
			return nil, err
		}
		sources = append(sources, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	summaries, err := s.readSnapshots(ctx, orgID, sources)
	if err != nil {
		return nil, err
	}
	if err := s.applyRuntimeStates(ctx, sources, summaries); err != nil {
		return nil, err
	}
	items := make([]listItem, 0, len(sources))
	for _, source := range sources {
		summary := summaries[source.ID]
		if summary.LatestJob == nil {
			summary = emptyOps()
		}
		items = append(items, source.listItem(summary))
	}
	return map[string]any{
		"sources":  items,
		"total":    total,
		"page":     query.Page,
		"pageSize": query.PageSize,
	}, nil
}

func (s *Service) readSnapshots(ctx context.Context, orgID string, sources []sourceRow) (map[string]opsSummary, error) {
	out := map[string]opsSummary{}
	if len(sources) == 0 {
		return out, nil
	}
	ids := make([]any, len(sources))
	for i, source := range sources {
		ids[i] = source.ID
	}
	query := `SELECT sourceId, latestJob, latestCrawlTask, latestArticle, stats24h FROM NewsSourceOpsSnapshot WHERE orgId = ? AND sourceId IN (` + placeholders(len(ids)) + `)`
	args := append([]any{orgID}, ids...)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var sourceID string
		var job, task, article, stats []byte
		if err := rows.Scan(&sourceID, &job, &task, &article, &stats); err != nil {
			return nil, err
		}
		summary := emptyOps()
		summary.LatestJob = nullJSON(job)
		summary.LatestCrawlTask = nullJSON(task)
		summary.LatestArticle = nullJSON(article)
		if len(stats) > 0 {
			var parsed stats24h
			if json.Unmarshal(stats, &parsed) == nil {
				summary.Stats24h = parsed
			}
		}
		out[sourceID] = summary
	}
	return out, rows.Err()
}

func (s *Service) Options(ctx context.Context, orgID string) ([]map[string]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, url FROM NewsSource WHERE orgId = ? ORDER BY name ASC, url ASC`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]string{}
	for rows.Next() {
		var id, name, rawURL string
		if err := rows.Scan(&id, &name, &rawURL); err != nil {
			return nil, err
		}
		out = append(out, map[string]string{"id": id, "name": name, "url": rawURL})
	}
	return out, rows.Err()
}

func (s *Service) Groups(ctx context.Context, orgID string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT DISTINCT `group` FROM NewsSource WHERE orgId = ? AND `group` IS NOT NULL ORDER BY `group` ASC", orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var group string
		if err := rows.Scan(&group); err != nil {
			return nil, err
		}
		out = append(out, group)
	}
	return out, rows.Err()
}

func (s *Service) Create(ctx context.Context, orgID string, input createInput) (sourceDocument, error) {
	if err := s.assertRefs(ctx, orgID, input.CrawlTemplateID, input.WorkflowID, input.WorkflowVersionID); err != nil {
		return sourceDocument{}, err
	}
	id, err := newRowID()
	if err != nil {
		return sourceDocument{}, err
	}
	now := nowMillis()
	var next any
	if input.IsActive {
		next = now
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO NewsSource (
  id, orgId, name, url, siteType, language, crawlTemplateId, workflowId, workflowVersionId, workflowBindingMode,
  frequencySeconds, priority, isActive, config, `+"`group`"+`, consecutiveFailures, nextRunAt, createdAt, updatedAt
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
		id, orgID, input.Name, input.URL, input.SiteType, nullableString(input.Language),
		nullableString(input.CrawlTemplateID), nullableString(input.WorkflowID), nullableString(input.WorkflowVersionID),
		input.WorkflowBindingMode, input.FrequencySeconds, input.Priority, boolArg(input.IsActive),
		nullableJSON(input.Config), nullableString(input.Group), next, now, now,
	)
	if duplicateURL(err) {
		return sourceDocument{}, newStatus(409, "News source URL already exists")
	}
	if err != nil {
		return sourceDocument{}, err
	}
	row, err := s.find(ctx, orgID, id)
	if err != nil {
		return sourceDocument{}, err
	}
	return row.marshalFull(), nil
}

func (s *Service) Update(ctx context.Context, orgID, id string, input updateInput) (sourceDocument, error) {
	existing, err := s.find(ctx, orgID, id)
	if err != nil {
		return sourceDocument{}, err
	}
	if err := s.assertRefs(ctx, orgID, input.CrawlTemplateID, input.WorkflowID, input.WorkflowVersionID); err != nil {
		return sourceDocument{}, err
	}
	sets := []string{}
	args := []any{}
	add := func(column string, value any) {
		sets = append(sets, column+" = ?")
		args = append(args, value)
	}
	if input.NameSet {
		add("name", input.Name)
	}
	if input.URLSet {
		add("url", input.URL)
	}
	if input.SiteTypeSet {
		add("siteType", input.SiteType)
	}
	if input.LanguageSet {
		add("language", nullableString(input.Language))
	}
	if input.CrawlTemplateSet {
		add("crawlTemplateId", nullableString(input.CrawlTemplateID))
	}
	if input.WorkflowSet {
		add("workflowId", nullableString(input.WorkflowID))
	}
	if input.WorkflowVersionSet {
		add("workflowVersionId", nullableString(input.WorkflowVersionID))
	}
	if input.BindingSet {
		add("workflowBindingMode", input.WorkflowBindingMode)
	}
	if input.FrequencySet {
		add("frequencySeconds", input.FrequencySeconds)
	}
	if input.PrioritySet {
		add("priority", input.Priority)
	}
	if input.ActiveSet {
		add("isActive", boolArg(input.IsActive))
	}
	if input.ConfigSet {
		add("config", nullableJSON(input.Config))
	}
	if input.GroupSet {
		add("`group`", nullableString(input.Group))
	}
	now := nowMillis()
	activating := input.ActiveSet && input.IsActive && !existing.IsActive
	frequencyChanged := input.FrequencySet && input.FrequencySeconds != existing.FrequencySeconds
	if input.ActiveSet && !input.IsActive {
		sets = append(sets, "nextRunAt = NULL")
	} else if activating || frequencyChanged {
		add("nextRunAt", now)
	}
	if activating {
		sets = append(sets, "circuitOpenUntil = NULL")
		add("consecutiveFailures", 0)
	}
	add("updatedAt", now)
	row, err := s.writeWhere(ctx, orgID, id, sets, args)
	if duplicateURL(err) {
		return sourceDocument{}, newStatus(409, "News source URL already exists")
	}
	if err != nil {
		return sourceDocument{}, err
	}
	return row.marshalFull(), nil
}

func (s *Service) Delete(ctx context.Context, orgID, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM NewsSource WHERE id = ? AND orgId = ?`, id, orgID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return newStatus(404, "News source not found")
	}
	return nil
}

func (s *Service) RunNow(ctx context.Context, orgID, id string) (sourceDocument, error) {
	now := nowMillis()
	row, err := s.writeWhere(ctx, orgID, id, []string{
		"isActive = 1",
		"nextRunAt = ?",
		"circuitOpenUntil = NULL",
		"updatedAt = ?",
	}, []any{now, now})
	if err != nil {
		return sourceDocument{}, err
	}
	return row.marshalFull(), nil
}

func (s *Service) Schedule(ctx context.Context, orgID, id string, next time.Time) (sourceDocument, error) {
	if _, err := s.find(ctx, orgID, id); err != nil {
		return sourceDocument{}, err
	}
	now := nowMillis()
	row, err := s.writeWhere(ctx, orgID, id, []string{
		"isActive = 1",
		"nextRunAt = ?",
		"circuitOpenUntil = NULL",
		"updatedAt = ?",
	}, []any{next.UTC().Truncate(time.Millisecond), now})
	if err != nil {
		return sourceDocument{}, err
	}
	return row.marshalFull(), nil
}

func (s *Service) writeWhere(ctx context.Context, orgID, id string, sets []string, args []any) (sourceRow, error) {
	query := `UPDATE NewsSource SET ` + strings.Join(sets, ", ") + ` WHERE id = ? AND orgId = ?`
	args = append(args, id, orgID)
	res, err := s.db.ExecContext(ctx, query, args...)
	if err != nil {
		return sourceRow{}, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return sourceRow{}, err
	}
	if n != 1 {
		return sourceRow{}, newStatus(404, "News source not found")
	}
	return s.find(ctx, orgID, id)
}

func (s *Service) UpdateFrequency(ctx context.Context, orgID string, frequency int) (map[string]any, error) {
	if frequency < 60 {
		frequency = 60
	}
	if frequency > 2_592_000 {
		frequency = 2_592_000
	}
	now := nowMillis()
	next := now.Add(time.Duration(frequency) * time.Second)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	updated, err := tx.ExecContext(ctx, `UPDATE NewsSource SET frequencySeconds = ?, updatedAt = ? WHERE orgId = ?`, frequency, now, orgID)
	if err != nil {
		return nil, err
	}
	active, err := tx.ExecContext(ctx, `UPDATE NewsSource SET nextRunAt = ?, updatedAt = ? WHERE orgId = ? AND isActive = 1`, next, now, orgID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	updatedCount, _ := updated.RowsAffected()
	activeCount, _ := active.RowsAffected()
	return map[string]any{
		"orgId":                  orgID,
		"frequencySeconds":       frequency,
		"updatedCount":           int(updatedCount),
		"activeRescheduledCount": int(activeCount),
		"nextRunAt":              next.UTC().Format("2006-01-02T15:04:05.000Z"),
	}, nil
}

func (s *Service) UpdateGroup(ctx context.Context, orgID string, ids []string, group *string) (map[string]int, error) {
	n, err := s.execIDs(ctx, `UPDATE NewsSource SET `+"`group`"+` = ?, updatedAt = ? WHERE orgId = ? AND id IN (`, append([]any{nullableString(group), nowMillis(), orgID}, stringsToArgs(ids)...), len(ids))
	if err != nil {
		return nil, err
	}
	return map[string]int{"updatedCount": n, "requestedCount": len(ids)}, nil
}

func (s *Service) UpdateActive(ctx context.Context, orgID string, ids []string, active bool) (map[string]int, error) {
	now := nowMillis()
	var query string
	var args []any
	if active {
		query = `UPDATE NewsSource SET isActive = 1, nextRunAt = ?, circuitOpenUntil = NULL, consecutiveFailures = 0, updatedAt = ? WHERE orgId = ? AND id IN (`
		args = []any{now, now, orgID}
	} else {
		query = `UPDATE NewsSource SET isActive = 0, nextRunAt = NULL, updatedAt = ? WHERE orgId = ? AND id IN (`
		args = []any{now, orgID}
	}
	args = append(args, stringsToArgs(ids)...)
	n, err := s.execIDs(ctx, query, args, len(ids))
	if err != nil {
		return nil, err
	}
	return map[string]int{"updatedCount": n, "requestedCount": len(ids)}, nil
}

func (s *Service) DeleteMany(ctx context.Context, orgID string, ids []string) (map[string]int, error) {
	n, err := s.execIDs(ctx, `DELETE FROM NewsSource WHERE orgId = ? AND id IN (`, append([]any{orgID}, stringsToArgs(ids)...), len(ids))
	if err != nil {
		return nil, err
	}
	return map[string]int{"deletedCount": n, "requestedCount": len(ids)}, nil
}

func (s *Service) execIDs(ctx context.Context, prefix string, args []any, count int) (int, error) {
	res, err := s.db.ExecContext(ctx, prefix+placeholders(count)+`)`, args...)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	return int(n), err
}

func (s *Service) assertRefs(ctx context.Context, orgID string, templateID, workflowID, versionID *string) error {
	if templateID != nil {
		if err := s.assertOrgRow(ctx, `SELECT orgId FROM CrawlTemplate WHERE id = ?`, *templateID, orgID, "Invalid crawlTemplateId"); err != nil {
			return err
		}
	}
	if workflowID != nil {
		if err := s.assertOrgRow(ctx, `SELECT orgId FROM CrawlStrategyWorkflow WHERE id = ?`, *workflowID, orgID, "Invalid workflowId"); err != nil {
			return err
		}
	}
	if versionID != nil {
		if err := s.assertOrgRow(ctx, `SELECT orgId FROM CrawlStrategyWorkflowVersion WHERE id = ?`, *versionID, orgID, "Invalid workflowVersionId"); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) assertOrgRow(ctx context.Context, query, id, orgID, message string) error {
	var owner string
	err := s.db.QueryRowContext(ctx, query, id).Scan(&owner)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && owner != orgID) {
		return newStatus(400, message)
	}
	return err
}

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

func nullableString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableJSON(value []byte) any {
	if value == nil {
		return nil
	}
	return value
}

func boolArg(value bool) int {
	if value {
		return 1
	}
	return 0
}
