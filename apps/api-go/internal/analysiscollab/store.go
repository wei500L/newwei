package analysiscollab

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

// Store 是四个域共用的连接池。事务回调里只使用回调参数，不再从池里另取连接。
type Store struct {
	DB *sql.DB
}

func NewStore(db *sql.DB) *Store {
	return &Store{DB: db}
}

// Querier 是 *sql.DB 与 *sql.Tx 的查询面。
type Querier interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// WithTx 在失败或 panic 时回滚。请求取消会传到 BeginTx 和回调里的查询。
func (s *Store) WithTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	if s == nil || s.DB == nil {
		return errors.New("analysis: database is not configured")
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	committed = true
	return nil
}

// IsDuplicateKey 只认 MySQL 1062。死锁、锁等待和其他错误必须继续上抛。
func IsDuplicateKey(err error) bool {
	var mysqlErr *mysql.MySQLError
	return errors.As(err, &mysqlErr) && mysqlErr.Number == 1062
}

// BoardLock 是看板行锁的结果。没找到时 Found 为 false，err 为 nil。
type BoardLock struct {
	ID         string
	ArchivedAt sql.NullTime
	Found      bool
}

func (b BoardLock) Active() bool {
	return b.Found && !b.ArchivedAt.Valid
}

// LockOrg 锁组织行。默认看板首建和最后看板归档必须先调用它。
func LockOrg(ctx context.Context, tx *sql.Tx, orgID string) error {
	var id string
	err := tx.QueryRowContext(ctx, "SELECT `id` FROM `Org` WHERE `id` = ? FOR UPDATE", orgID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("analysis: organization not found")
	}
	return err
}

// LockBoard 锁看板行。列和卡片的结构修改、归档和任务讨论写入使用它。
func LockBoard(ctx context.Context, tx *sql.Tx, orgID, boardID string) (BoardLock, error) {
	var row BoardLock
	err := tx.QueryRowContext(ctx, "SELECT `id`, `archivedAt` FROM `AnalysisBoard` WHERE `id` = ? AND `orgId` = ? FOR UPDATE", boardID, orgID).Scan(&row.ID, &row.ArchivedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return BoardLock{}, nil
	}
	if err != nil {
		return BoardLock{}, err
	}
	row.Found = true
	return row, nil
}

// SavedViewLock 是视图行锁。删除视图和 saved_view 讨论写入使用它。
type SavedViewLock struct {
	ID          string
	CreatedByID string
	Visibility  string
	Found       bool
}

func LockSavedView(ctx context.Context, tx *sql.Tx, orgID, viewID string) (SavedViewLock, error) {
	var row SavedViewLock
	err := tx.QueryRowContext(ctx, "SELECT `id`, `createdById`, `visibility` FROM `SavedAnalysisView` WHERE `id` = ? AND `orgId` = ? FOR UPDATE", viewID, orgID).Scan(&row.ID, &row.CreatedByID, &row.Visibility)
	if errors.Is(err, sql.ErrNoRows) {
		return SavedViewLock{}, nil
	}
	if err != nil {
		return SavedViewLock{}, err
	}
	row.Found = true
	return row, nil
}

// DeleteSubjectThread 在调用方的事务里删除讨论和评论。没有讨论不是错误。
func DeleteSubjectThread(ctx context.Context, tx *sql.Tx, orgID, subjectType, subjectID string) error {
	var threadID string
	err := tx.QueryRowContext(ctx, "SELECT `id` FROM `AnalysisThread` WHERE `orgId` = ? AND `subjectType` = ? AND `subjectId` = ? FOR UPDATE", orgID, subjectType, subjectID).Scan(&threadID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM `AnalysisComment` WHERE `orgId` = ? AND `threadId` = ?", orgID, threadID); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "DELETE FROM `AnalysisThread` WHERE `id` = ? AND `orgId` = ?", threadID, orgID)
	return err
}

// LoadTaskCommentCounts 按 analysis_task 讨论的真实评论数计数。没有讨论的任务不在 map 里。
func LoadTaskCommentCounts(ctx context.Context, q Querier, orgID string, taskIDs []string) (map[string]int, error) {
	out := map[string]int{}
	ids := uniqueIDs(taskIDs)
	if len(ids) == 0 {
		return out, nil
	}
	args := make([]any, 0, len(ids)+1)
	args = append(args, orgID)
	for _, id := range ids {
		args = append(args, id)
	}
	query := "SELECT t.`subjectId`, COUNT(c.`id`) FROM `AnalysisThread` t LEFT JOIN `AnalysisComment` c ON c.`threadId` = t.`id` AND c.`orgId` = t.`orgId` WHERE t.`orgId` = ? AND t.`subjectType` = 'analysis_task' AND t.`subjectId` IN (" + placeholders(len(ids)) + ") GROUP BY t.`subjectId`"
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var subjectID string
		var count int
		if err := rows.Scan(&subjectID, &count); err != nil {
			return nil, err
		}
		out[subjectID] = count
	}
	return out, rows.Err()
}

func placeholders(count int) string {
	parts := make([]string, count)
	for i := range parts {
		parts[i] = "?"
	}
	return strings.Join(parts, ",")
}

func uniqueIDs(ids []string) []string {
	if len(ids) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(ids))
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}

// NullString 把可选文本写成 SQL NULL。
func NullString(value *string) sql.NullString {
	if value == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *value, Valid: true}
}

// NullTime 把可选时间写成 SQL NULL。
func NullTime(value *time.Time) sql.NullTime {
	if value == nil {
		return sql.NullTime{}
	}
	return sql.NullTime{Time: value.UTC(), Valid: true}
}

// TextPtr 把 NULL 收成 JSON null。
func TextPtr(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	copied := value.String
	return &copied
}

// TimePtr 把 DATETIME 收成 ISO 字符串；NULL 为 JSON null。
func TimePtr(value sql.NullTime) *string {
	if !value.Valid {
		return nil
	}
	formatted := FormatISO(value.Time)
	return &formatted
}
