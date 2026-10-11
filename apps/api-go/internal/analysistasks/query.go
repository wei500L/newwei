package analysistasks

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/analysiscollab"
)

type taskRef struct {
	id       string
	boardID  string
	columnID string
}

type taskRow struct {
	id          string
	boardID     string
	columnID    string
	title       string
	body        sql.NullString
	priority    string
	assigneeID  sql.NullString
	linkedType  sql.NullString
	linkedID    sql.NullString
	dueAt       sql.NullTime
	sortOrder   int
	createdAt   time.Time
	updatedAt   time.Time
	createdByID string
	updatedByID string
}

func findActiveTask(ctx context.Context, q analysiscollab.Querier, orgID, taskID string) (taskRef, error) {
	var ref taskRef
	err := q.QueryRowContext(ctx, "SELECT t.`id`, t.`boardId`, t.`columnId` FROM `AnalysisTaskCard` t INNER JOIN `AnalysisBoard` b ON b.`id` = t.`boardId` AND b.`orgId` = t.`orgId` WHERE t.`orgId` = ? AND t.`id` = ? AND b.`archivedAt` IS NULL", orgID, taskID).Scan(&ref.id, &ref.boardID, &ref.columnID)
	if errors.Is(err, sql.ErrNoRows) {
		return taskRef{}, analysiscollab.NotFound(analysiscollab.MsgTaskNotFound)
	}
	if err != nil {
		return taskRef{}, err
	}
	return ref, nil
}

func findActiveColumn(ctx context.Context, q analysiscollab.Querier, orgID, boardID, columnID string) (string, error) {
	var id string
	err := q.QueryRowContext(ctx, "SELECT c.`id` FROM `AnalysisBoardColumn` c INNER JOIN `AnalysisBoard` b ON b.`id` = c.`boardId` AND b.`orgId` = c.`orgId` WHERE c.`orgId` = ? AND c.`id` = ? AND c.`boardId` = ? AND b.`archivedAt` IS NULL", orgID, columnID, boardID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", analysiscollab.NotFound(analysiscollab.MsgColumnNotFound)
	}
	if err != nil {
		return "", err
	}
	return id, nil
}

func findFirstColumn(ctx context.Context, q analysiscollab.Querier, orgID, boardID string) (string, error) {
	var id string
	err := q.QueryRowContext(ctx, "SELECT c.`id` FROM `AnalysisBoardColumn` c INNER JOIN `AnalysisBoard` b ON b.`id` = c.`boardId` AND b.`orgId` = c.`orgId` WHERE c.`orgId` = ? AND c.`boardId` = ? AND b.`archivedAt` IS NULL ORDER BY c.`sortOrder` ASC, c.`createdAt` ASC LIMIT 1", orgID, boardID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", analysiscollab.BadRequest(analysiscollab.MsgNoColumns)
	}
	if err != nil {
		return "", err
	}
	return id, nil
}

func lastTaskSort(ctx context.Context, q analysiscollab.Querier, orgID, columnID string) (int, error) {
	var sortOrder int
	err := q.QueryRowContext(ctx, "SELECT `sortOrder` FROM `AnalysisTaskCard` WHERE `orgId` = ? AND `columnId` = ? ORDER BY `sortOrder` DESC, `createdAt` DESC LIMIT 1", orgID, columnID).Scan(&sortOrder)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return sortOrder, nil
}

func loadColumnTaskIDs(ctx context.Context, q analysiscollab.Querier, orgID, columnID string) ([]string, error) {
	rows, err := q.QueryContext(ctx, "SELECT `id` FROM `AnalysisTaskCard` WHERE `orgId` = ? AND `columnId` = ? ORDER BY `sortOrder` ASC, `createdAt` ASC", orgID, columnID)
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

func loadTask(ctx context.Context, q analysiscollab.Querier, orgID, taskID string) (taskRow, error) {
	var row taskRow
	err := q.QueryRowContext(ctx, "SELECT `id`, `boardId`, `columnId`, `title`, `bodyMarkdown`, `priority`, `assigneeId`, `linkedSubjectType`, `linkedSubjectId`, `dueAt`, `sortOrder`, `createdAt`, `updatedAt`, `createdById`, `updatedById` FROM `AnalysisTaskCard` WHERE `orgId` = ? AND `id` = ?", orgID, taskID).Scan(
		&row.id,
		&row.boardID,
		&row.columnID,
		&row.title,
		&row.body,
		&row.priority,
		&row.assigneeID,
		&row.linkedType,
		&row.linkedID,
		&row.dueAt,
		&row.sortOrder,
		&row.createdAt,
		&row.updatedAt,
		&row.createdByID,
		&row.updatedByID,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return taskRow{}, fmt.Errorf("analysis: task %s is missing", taskID)
	}
	if err != nil {
		return taskRow{}, err
	}
	return row, nil
}

func insertTask(ctx context.Context, tx *sql.Tx, orgID string, row taskRow) error {
	_, err := tx.ExecContext(ctx, "INSERT INTO `AnalysisTaskCard` (`id`, `orgId`, `boardId`, `columnId`, `createdById`, `updatedById`, `assigneeId`, `title`, `bodyMarkdown`, `priority`, `linkedSubjectType`, `linkedSubjectId`, `dueAt`, `sortOrder`, `createdAt`, `updatedAt`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		row.id,
		orgID,
		row.boardID,
		row.columnID,
		row.createdByID,
		row.updatedByID,
		row.assigneeID,
		row.title,
		row.body,
		row.priority,
		row.linkedType,
		row.linkedID,
		row.dueAt,
		row.sortOrder,
		row.createdAt,
		row.updatedAt,
	)
	return err
}

func updateTaskColumn(ctx context.Context, tx *sql.Tx, orgID, taskID, columnID, actorID string, now time.Time) error {
	_, err := tx.ExecContext(ctx, "UPDATE `AnalysisTaskCard` SET `columnId` = ?, `updatedById` = ?, `updatedAt` = ? WHERE `id` = ? AND `orgId` = ?", columnID, actorID, now, taskID, orgID)
	return err
}

func setTaskSortOrder(ctx context.Context, tx *sql.Tx, orgID, columnID string, ids []string, now time.Time) error {
	for index, id := range ids {
		if _, err := tx.ExecContext(ctx, "UPDATE `AnalysisTaskCard` SET `sortOrder` = ?, `updatedAt` = ? WHERE `id` = ? AND `orgId` = ? AND `columnId` = ?", analysiscollab.SortOrder(index), now, id, orgID, columnID); err != nil {
			return err
		}
	}
	return nil
}

func reindexColumnTasks(ctx context.Context, tx *sql.Tx, orgID, columnID string, now time.Time) error {
	ids, err := loadColumnTaskIDs(ctx, tx, orgID, columnID)
	if err != nil {
		return err
	}
	return setTaskSortOrder(ctx, tx, orgID, columnID, ids, now)
}

func deleteTaskCard(ctx context.Context, tx *sql.Tx, orgID, taskID string) error {
	res, err := tx.ExecContext(ctx, "DELETE FROM `AnalysisTaskCard` WHERE `id` = ? AND `orgId` = ?", taskID, orgID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return analysiscollab.NotFound(analysiscollab.MsgTaskNotFound)
	}
	return nil
}

func touchBoard(ctx context.Context, tx *sql.Tx, orgID, boardID, actorID string, now time.Time) error {
	_, err := tx.ExecContext(ctx, "UPDATE `AnalysisBoard` SET `updatedById` = ?, `updatedAt` = ? WHERE `id` = ? AND `orgId` = ?", actorID, now, boardID, orgID)
	return err
}
