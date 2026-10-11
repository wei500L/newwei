package analysisboards

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/analysiscollab"
)

type boardRow struct {
	id          string
	title       string
	description sql.NullString
	archivedAt  sql.NullTime
	createdAt   time.Time
	updatedAt   time.Time
	createdByID string
	updatedByID string
	columnCount int
	taskCount   int
}

type columnRow struct {
	id        string
	title     string
	color     sql.NullString
	sortOrder int
	isDone    bool
	createdAt time.Time
	updatedAt time.Time
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

func loadBoardSummaries(ctx context.Context, q analysiscollab.Querier, orgID string) ([]analysiscollab.BoardSummary, error) {
	rows, err := q.QueryContext(ctx, "SELECT b.`id`, b.`title`, b.`description`, b.`archivedAt`, b.`createdAt`, b.`updatedAt`, b.`createdById`, b.`updatedById`, "+
		"(SELECT COUNT(*) FROM `AnalysisBoardColumn` c WHERE c.`orgId` = b.`orgId` AND c.`boardId` = b.`id`), "+
		"(SELECT COUNT(*) FROM `AnalysisTaskCard` t WHERE t.`orgId` = b.`orgId` AND t.`boardId` = b.`id`) "+
		"FROM `AnalysisBoard` b WHERE b.`orgId` = ? AND b.`archivedAt` IS NULL ORDER BY b.`updatedAt` DESC, b.`createdAt` DESC", orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	raw := make([]boardRow, 0)
	for rows.Next() {
		var row boardRow
		if err := rows.Scan(&row.id, &row.title, &row.description, &row.archivedAt, &row.createdAt, &row.updatedAt, &row.createdByID, &row.updatedByID, &row.columnCount, &row.taskCount); err != nil {
			return nil, err
		}
		raw = append(raw, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(raw)*2)
	for _, row := range raw {
		ids = append(ids, row.createdByID, row.updatedByID)
	}
	users, err := analysiscollab.LoadUsers(ctx, q, ids)
	if err != nil {
		return nil, err
	}
	out := make([]analysiscollab.BoardSummary, 0, len(raw))
	for _, row := range raw {
		createdBy, err := analysiscollab.MustUser(users, row.createdByID)
		if err != nil {
			return nil, err
		}
		updatedBy, err := analysiscollab.MustUser(users, row.updatedByID)
		if err != nil {
			return nil, err
		}
		out = append(out, analysiscollab.BoardSummary{
			ID:          row.id,
			Title:       row.title,
			Description: analysiscollab.TextPtr(row.description),
			ArchivedAt:  analysiscollab.TimePtr(row.archivedAt),
			CreatedAt:   analysiscollab.FormatISO(row.createdAt),
			UpdatedAt:   analysiscollab.FormatISO(row.updatedAt),
			CreatedBy:   createdBy,
			UpdatedBy:   updatedBy,
			ColumnCount: row.columnCount,
			TaskCount:   row.taskCount,
		})
	}
	return out, nil
}

func loadBoardDetail(ctx context.Context, q analysiscollab.Querier, orgID, boardID string) (analysiscollab.BoardDetail, error) {
	board, err := loadActiveBoard(ctx, q, orgID, boardID)
	if errors.Is(err, sql.ErrNoRows) {
		return analysiscollab.BoardDetail{}, analysiscollab.NotFound(analysiscollab.MsgBoardNotFound)
	}
	if err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	columns, err := loadColumns(ctx, q, orgID, boardID)
	if err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	tasks, err := loadTasks(ctx, q, orgID, boardID)
	if err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	return presentBoard(ctx, q, orgID, board, columns, tasks)
}

func loadActiveBoard(ctx context.Context, q analysiscollab.Querier, orgID, boardID string) (boardRow, error) {
	var row boardRow
	err := q.QueryRowContext(ctx, "SELECT `id`, `title`, `description`, `archivedAt`, `createdAt`, `updatedAt`, `createdById`, `updatedById` FROM `AnalysisBoard` WHERE `orgId` = ? AND `id` = ? AND `archivedAt` IS NULL", orgID, boardID).Scan(
		&row.id, &row.title, &row.description, &row.archivedAt, &row.createdAt, &row.updatedAt, &row.createdByID, &row.updatedByID,
	)
	if err != nil {
		return boardRow{}, err
	}
	return row, nil
}

func loadColumns(ctx context.Context, q analysiscollab.Querier, orgID, boardID string) ([]columnRow, error) {
	rows, err := q.QueryContext(ctx, "SELECT `id`, `title`, `color`, `sortOrder`, `isDone`, `createdAt`, `updatedAt` FROM `AnalysisBoardColumn` WHERE `orgId` = ? AND `boardId` = ? ORDER BY `sortOrder` ASC, `createdAt` ASC", orgID, boardID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]columnRow, 0)
	for rows.Next() {
		var row columnRow
		var done int
		if err := rows.Scan(&row.id, &row.title, &row.color, &row.sortOrder, &done, &row.createdAt, &row.updatedAt); err != nil {
			return nil, err
		}
		row.isDone = done != 0
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func loadTasks(ctx context.Context, q analysiscollab.Querier, orgID, boardID string) ([]taskRow, error) {
	rows, err := q.QueryContext(ctx, "SELECT `id`, `boardId`, `columnId`, `title`, `bodyMarkdown`, `priority`, `assigneeId`, `linkedSubjectType`, `linkedSubjectId`, `dueAt`, `sortOrder`, `createdAt`, `updatedAt`, `createdById`, `updatedById` FROM `AnalysisTaskCard` WHERE `orgId` = ? AND `boardId` = ? ORDER BY `sortOrder` ASC, `createdAt` ASC", orgID, boardID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]taskRow, 0)
	for rows.Next() {
		var row taskRow
		if err := rows.Scan(&row.id, &row.boardID, &row.columnID, &row.title, &row.body, &row.priority, &row.assigneeID, &row.linkedType, &row.linkedID, &row.dueAt, &row.sortOrder, &row.createdAt, &row.updatedAt, &row.createdByID, &row.updatedByID); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func presentBoard(ctx context.Context, q analysiscollab.Querier, orgID string, board boardRow, columns []columnRow, tasks []taskRow) (analysiscollab.BoardDetail, error) {
	columnIDs := make(map[string]struct{}, len(columns))
	for _, column := range columns {
		columnIDs[column.id] = struct{}{}
	}
	kept := make([]taskRow, 0, len(tasks))
	ids := []string{board.createdByID, board.updatedByID}
	taskIDs := make([]string, 0, len(tasks))
	for _, task := range tasks {
		if _, ok := columnIDs[task.columnID]; !ok {
			continue
		}
		kept = append(kept, task)
		ids = append(ids, task.createdByID, task.updatedByID)
		if task.assigneeID.Valid && task.assigneeID.String != "" {
			ids = append(ids, task.assigneeID.String)
		}
		taskIDs = append(taskIDs, task.id)
	}
	users, err := analysiscollab.LoadUsers(ctx, q, ids)
	if err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	counts, err := analysiscollab.LoadTaskCommentCounts(ctx, q, orgID, taskIDs)
	if err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	createdBy, err := analysiscollab.MustUser(users, board.createdByID)
	if err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	updatedBy, err := analysiscollab.MustUser(users, board.updatedByID)
	if err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	grouped := make(map[string][]analysiscollab.TaskCard, len(columns))
	for _, task := range kept {
		card, err := taskCard(task, users, counts)
		if err != nil {
			return analysiscollab.BoardDetail{}, err
		}
		grouped[task.columnID] = append(grouped[task.columnID], card)
	}
	detailColumns := make([]analysiscollab.BoardColumn, 0, len(columns))
	for _, column := range columns {
		columnTasks := grouped[column.id]
		if columnTasks == nil {
			columnTasks = []analysiscollab.TaskCard{}
		}
		detailColumns = append(detailColumns, analysiscollab.BoardColumn{
			ID:        column.id,
			Title:     column.title,
			Color:     analysiscollab.TextPtr(column.color),
			SortOrder: column.sortOrder,
			IsDone:    column.isDone,
			CreatedAt: analysiscollab.FormatISO(column.createdAt),
			UpdatedAt: analysiscollab.FormatISO(column.updatedAt),
			Tasks:     columnTasks,
		})
	}
	return analysiscollab.BoardDetail{
		ID:          board.id,
		Title:       board.title,
		Description: analysiscollab.TextPtr(board.description),
		ArchivedAt:  analysiscollab.TimePtr(board.archivedAt),
		CreatedAt:   analysiscollab.FormatISO(board.createdAt),
		UpdatedAt:   analysiscollab.FormatISO(board.updatedAt),
		CreatedBy:   createdBy,
		UpdatedBy:   updatedBy,
		Columns:     detailColumns,
	}, nil
}

func taskCard(row taskRow, users map[string]analysiscollab.UserSummary, counts map[string]int) (analysiscollab.TaskCard, error) {
	createdBy, err := analysiscollab.MustUser(users, row.createdByID)
	if err != nil {
		return analysiscollab.TaskCard{}, err
	}
	updatedBy, err := analysiscollab.MustUser(users, row.updatedByID)
	if err != nil {
		return analysiscollab.TaskCard{}, err
	}
	var assignee *analysiscollab.UserSummary
	if row.assigneeID.Valid && row.assigneeID.String != "" {
		user, err := analysiscollab.MustUser(users, row.assigneeID.String)
		if err != nil {
			return analysiscollab.TaskCard{}, err
		}
		assignee = &user
	}
	return analysiscollab.TaskCard{
		ID:                row.id,
		BoardID:           row.boardID,
		ColumnID:          row.columnID,
		Title:             row.title,
		BodyMarkdown:      analysiscollab.TextPtr(row.body),
		Priority:          row.priority,
		AssigneeID:        analysiscollab.TextPtr(row.assigneeID),
		Assignee:          assignee,
		LinkedSubjectType: analysiscollab.TextPtr(row.linkedType),
		LinkedSubjectID:   analysiscollab.TextPtr(row.linkedID),
		DueAt:             analysiscollab.TimePtr(row.dueAt),
		SortOrder:         row.sortOrder,
		CommentCount:      counts[row.id],
		CreatedAt:         analysiscollab.FormatISO(row.createdAt),
		UpdatedAt:         analysiscollab.FormatISO(row.updatedAt),
		CreatedBy:         createdBy,
		UpdatedBy:         updatedBy,
	}, nil
}
