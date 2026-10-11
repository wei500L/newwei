package analysisboards

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/analysiscollab"
)

type columnRef struct {
	id      string
	boardID string
}

// CreateColumn 把新列放在当前最大 sortOrder 之后 1000。没有列时从 1000 开始。
func (s *Service) CreateColumn(ctx context.Context, orgID string, actor analysiscollab.Actor, boardID string, body analysiscollab.Body) (analysiscollab.BoardDetail, error) {
	title, err := analysiscollab.NormalizeRequired(body.String("title"), 80, "title")
	if err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	color, err := analysiscollab.NormalizeOptional(body.StringPtr("color"), 32, "color")
	if err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	isDone := false
	if body.Has("isDone") && !body.Null("isDone") {
		isDone = body.Bool("isDone")
	}
	if _, err := s.db(); err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	err = s.store.WithTx(ctx, func(tx *sql.Tx) error {
		lock, err := analysiscollab.LockBoard(ctx, tx, orgID, boardID)
		if err != nil {
			return err
		}
		if !lock.Active() {
			return analysiscollab.NotFound(analysiscollab.MsgBoardNotFound)
		}
		sortOrder, err := nextColumnSort(ctx, tx, orgID, boardID)
		if err != nil {
			return err
		}
		now := analysiscollab.Now()
		if err := insertColumn(ctx, tx, orgID, boardID, title, analysiscollab.NullString(color), sortOrder, isDone, now); err != nil {
			return err
		}
		return touchBoard(ctx, tx, orgID, boardID, actor.ID, now)
	})
	if err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	return s.GetBoard(ctx, orgID, actor, boardID)
}

// UpdateColumn 规范化后锁该列所在看板，并复查列仍在未归档看板上。
func (s *Service) UpdateColumn(ctx context.Context, orgID string, actor analysiscollab.Actor, columnID string, body analysiscollab.Body) (analysiscollab.BoardDetail, error) {
	patch, err := normalizeColumnPatch(body)
	if err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	db, err := s.db()
	if err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	// 看板 id 在池上解析，事务的第一条语句才是 LockBoard。
	// 锁前的普通读会冻住可重复读快照，锁内复查就看不到并发删除。
	existing, err := lookupActiveColumn(ctx, db, orgID, columnID)
	if err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	err = s.store.WithTx(ctx, func(tx *sql.Tx) error {
		if _, err := analysiscollab.LockBoard(ctx, tx, orgID, existing.boardID); err != nil {
			return err
		}
		locked, err := lookupActiveColumn(ctx, tx, orgID, columnID)
		if err != nil {
			return err
		}
		if locked.boardID != existing.boardID {
			return analysiscollab.NotFound(analysiscollab.MsgColumnNotFound)
		}
		now := analysiscollab.Now()
		if err := applyColumnPatch(ctx, tx, orgID, locked.boardID, locked.id, patch, now); err != nil {
			return err
		}
		return touchBoard(ctx, tx, orgID, locked.boardID, actor.ID, now)
	})
	if err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	return s.GetBoard(ctx, orgID, actor, existing.boardID)
}

// DeleteColumn 把卡片挪到同一看板的另一列，再删列并重排目标列。
// moveCardsToColumnId 与当前列相同则在写入前拒绝。
func (s *Service) DeleteColumn(ctx context.Context, orgID string, actor analysiscollab.Actor, columnID, moveTo string) (analysiscollab.BoardDetail, error) {
	if columnID == moveTo {
		return analysiscollab.BoardDetail{}, analysiscollab.BadRequest(analysiscollab.MsgSameColumn)
	}
	db, err := s.db()
	if err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	existing, err := lookupActiveColumn(ctx, db, orgID, columnID)
	if err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	var boardID string
	err = s.store.WithTx(ctx, func(tx *sql.Tx) error {
		if _, err := analysiscollab.LockBoard(ctx, tx, orgID, existing.boardID); err != nil {
			return err
		}
		locked, err := lookupActiveColumn(ctx, tx, orgID, columnID)
		if err != nil {
			return err
		}
		if locked.boardID != existing.boardID {
			return analysiscollab.NotFound(analysiscollab.MsgColumnNotFound)
		}
		var columnCount int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM `AnalysisBoardColumn` WHERE `orgId` = ? AND `boardId` = ?", orgID, locked.boardID).Scan(&columnCount); err != nil {
			return err
		}
		// 只剩一列时，同一看板上不存在另一列，所以先返回最后一列，而不是目标列不存在。
		if columnCount <= 1 {
			return analysiscollab.BadRequest(analysiscollab.MsgLastColumn)
		}
		var targetID string
		scanErr := tx.QueryRowContext(ctx, "SELECT `id` FROM `AnalysisBoardColumn` WHERE `orgId` = ? AND `boardId` = ? AND `id` = ?", orgID, locked.boardID, moveTo).Scan(&targetID)
		if errors.Is(scanErr, sql.ErrNoRows) {
			return analysiscollab.NotFound(analysiscollab.MsgTargetColumnNotFound)
		}
		if scanErr != nil {
			return scanErr
		}
		now := analysiscollab.Now()
		if _, err := tx.ExecContext(ctx, "UPDATE `AnalysisTaskCard` SET `columnId` = ?, `updatedById` = ?, `updatedAt` = ? WHERE `orgId` = ? AND `boardId` = ? AND `columnId` = ?", targetID, actor.ID, now, orgID, locked.boardID, locked.id); err != nil {
			return err
		}
		// 外键是 ON DELETE CASCADE。先挪走卡片，再删列，否则卡片会被一起删掉。
		res, err := tx.ExecContext(ctx, "DELETE FROM `AnalysisBoardColumn` WHERE `id` = ? AND `orgId` = ? AND `boardId` = ?", locked.id, orgID, locked.boardID)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return analysiscollab.NotFound(analysiscollab.MsgColumnNotFound)
		}
		if err := reindexColumnTasks(ctx, tx, orgID, locked.boardID, targetID, now); err != nil {
			return err
		}
		if err := touchBoard(ctx, tx, orgID, locked.boardID, actor.ID, now); err != nil {
			return err
		}
		boardID = locked.boardID
		return nil
	})
	if err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	return s.GetBoard(ctx, orgID, actor, boardID)
}

// ReorderColumns 要求 columnIds 是该看板列的完整排列。不合法时不写 sortOrder。
func (s *Service) ReorderColumns(ctx context.Context, orgID string, actor analysiscollab.Actor, boardID string, body analysiscollab.Body) (analysiscollab.BoardDetail, error) {
	columnIDs := body.Strings("columnIds")
	if _, err := s.db(); err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	err := s.store.WithTx(ctx, func(tx *sql.Tx) error {
		lock, err := analysiscollab.LockBoard(ctx, tx, orgID, boardID)
		if err != nil {
			return err
		}
		if !lock.Active() {
			return analysiscollab.NotFound(analysiscollab.MsgBoardNotFound)
		}
		existing, err := loadColumnIDs(ctx, tx, orgID, boardID)
		if err != nil {
			return err
		}
		if !analysiscollab.ValidColumnOrder(columnIDs, existing) {
			return analysiscollab.BadRequest(analysiscollab.MsgColumnOrder)
		}
		now := analysiscollab.Now()
		for index, id := range columnIDs {
			if _, err := tx.ExecContext(ctx, "UPDATE `AnalysisBoardColumn` SET `sortOrder` = ?, `updatedAt` = ? WHERE `id` = ? AND `orgId` = ? AND `boardId` = ?", analysiscollab.SortOrder(index), now, id, orgID, boardID); err != nil {
				return err
			}
		}
		return touchBoard(ctx, tx, orgID, boardID, actor.ID, now)
	})
	if err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	return s.GetBoard(ctx, orgID, actor, boardID)
}

func lookupActiveColumn(ctx context.Context, q analysiscollab.Querier, orgID, columnID string) (columnRef, error) {
	var ref columnRef
	err := q.QueryRowContext(ctx, "SELECT c.`id`, c.`boardId` FROM `AnalysisBoardColumn` c INNER JOIN `AnalysisBoard` b ON b.`id` = c.`boardId` AND b.`orgId` = c.`orgId` WHERE c.`orgId` = ? AND c.`id` = ? AND b.`archivedAt` IS NULL", orgID, columnID).Scan(&ref.id, &ref.boardID)
	if errors.Is(err, sql.ErrNoRows) {
		return columnRef{}, analysiscollab.NotFound(analysiscollab.MsgColumnNotFound)
	}
	if err != nil {
		return columnRef{}, err
	}
	return ref, nil
}

func nextColumnSort(ctx context.Context, q analysiscollab.Querier, orgID, boardID string) (int, error) {
	var last int
	err := q.QueryRowContext(ctx, "SELECT `sortOrder` FROM `AnalysisBoardColumn` WHERE `orgId` = ? AND `boardId` = ? ORDER BY `sortOrder` DESC, `createdAt` DESC LIMIT 1", orgID, boardID).Scan(&last)
	if errors.Is(err, sql.ErrNoRows) {
		return analysiscollab.SortStep, nil
	}
	if err != nil {
		return 0, err
	}
	return last + analysiscollab.SortStep, nil
}

type columnPatch struct {
	title    string
	setTitle bool
	color    *string
	setColor bool
	isDone   bool
	setDone  bool
}

func normalizeColumnPatch(body analysiscollab.Body) (columnPatch, error) {
	var patch columnPatch
	if body.Has("title") {
		raw := ""
		if !body.Null("title") {
			raw = body.String("title")
		}
		title, err := analysiscollab.NormalizeRequired(raw, 80, "title")
		if err != nil {
			return columnPatch{}, err
		}
		patch.title = title
		patch.setTitle = true
	}
	if body.Has("color") {
		color, err := analysiscollab.NormalizeOptional(body.StringPtr("color"), 32, "color")
		if err != nil {
			return columnPatch{}, err
		}
		patch.color = color
		patch.setColor = true
	}
	if body.Has("isDone") {
		if body.Null("isDone") {
			return columnPatch{}, analysiscollab.BadRequest("isDone must be a boolean value")
		}
		patch.isDone = body.Bool("isDone")
		patch.setDone = true
	}
	return patch, nil
}

func applyColumnPatch(ctx context.Context, tx *sql.Tx, orgID, boardID, columnID string, patch columnPatch, now time.Time) error {
	sets := make([]string, 0, 4)
	args := make([]any, 0, 6)
	if patch.setTitle {
		sets = append(sets, "`title` = ?")
		args = append(args, patch.title)
	}
	if patch.setColor {
		sets = append(sets, "`color` = ?")
		args = append(args, analysiscollab.NullString(patch.color))
	}
	if patch.setDone {
		sets = append(sets, "`isDone` = ?")
		args = append(args, patch.isDone)
	}
	sets = append(sets, "`updatedAt` = ?")
	args = append(args, now, columnID, orgID, boardID)
	_, err := tx.ExecContext(ctx, "UPDATE `AnalysisBoardColumn` SET "+strings.Join(sets, ", ")+" WHERE `id` = ? AND `orgId` = ? AND `boardId` = ?", args...)
	return err
}

func loadColumnIDs(ctx context.Context, q analysiscollab.Querier, orgID, boardID string) ([]string, error) {
	rows, err := q.QueryContext(ctx, "SELECT `id` FROM `AnalysisBoardColumn` WHERE `orgId` = ? AND `boardId` = ?", orgID, boardID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return ids, nil
}

func reindexColumnTasks(ctx context.Context, tx *sql.Tx, orgID, boardID, columnID string, now time.Time) error {
	ids, err := loadTaskIDs(ctx, tx, orgID, boardID, columnID)
	if err != nil {
		return err
	}
	for index, id := range ids {
		if _, err := tx.ExecContext(ctx, "UPDATE `AnalysisTaskCard` SET `sortOrder` = ?, `updatedAt` = ? WHERE `id` = ? AND `orgId` = ? AND `boardId` = ? AND `columnId` = ?", analysiscollab.SortOrder(index), now, id, orgID, boardID, columnID); err != nil {
			return err
		}
	}
	return nil
}

func loadTaskIDs(ctx context.Context, q analysiscollab.Querier, orgID, boardID, columnID string) ([]string, error) {
	rows, err := q.QueryContext(ctx, "SELECT `id` FROM `AnalysisTaskCard` WHERE `orgId` = ? AND `boardId` = ? AND `columnId` = ? ORDER BY `sortOrder` ASC, `createdAt` ASC", orgID, boardID, columnID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return ids, nil
}
