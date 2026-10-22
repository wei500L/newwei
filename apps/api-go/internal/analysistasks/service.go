package analysistasks

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/analysiscollab"
)

var errServiceUnavailable = errors.New("analysis: task service is not configured")

// Service 写任务卡片。组织边界和未归档看板是唯一门闩，没有 owner 限制。
type Service struct {
	store  *analysiscollab.Store
	boards analysiscollab.BoardReader
}

func NewService(store *analysiscollab.Store, boards analysiscollab.BoardReader) *Service {
	return &Service{store: store, boards: boards}
}

type createInput struct {
	title      string
	body       *string
	dueAt      *time.Time
	linkedType *string
	linkedID   *string
	assigneeID *string
	priority   string
	columnID   string
	useColumn  bool
}

type taskUpdate struct {
	title       string
	hasTitle    bool
	body        *string
	hasBody     bool
	priority    string
	hasPriority bool
	assignee    *string
	hasAssignee bool
	linkedType  *string
	linkedID    *string
	hasLinked   bool
	due         *time.Time
	hasDue      bool
}

func (s *Service) CreateTask(ctx context.Context, orgID string, actor analysiscollab.Actor, boardID string, body analysiscollab.Body) (analysiscollab.TaskCard, error) {
	db, err := s.db()
	if err != nil {
		return analysiscollab.TaskCard{}, err
	}
	input, err := prepareCreate(ctx, db, orgID, actor, body)
	if err != nil {
		return analysiscollab.TaskCard{}, err
	}
	var row taskRow
	err = s.store.WithTx(ctx, func(tx *sql.Tx) error {
		lock, err := analysiscollab.LockBoard(ctx, tx, orgID, boardID)
		if err != nil {
			return err
		}
		if !lock.Active() {
			return analysiscollab.NotFound(analysiscollab.MsgBoardNotFound)
		}
		columnID, err := lockColumnID(ctx, tx, orgID, boardID, input)
		if err != nil {
			return err
		}
		last, err := lastTaskSort(ctx, tx, orgID, columnID)
		if err != nil {
			return err
		}
		id, err := analysiscollab.NewID()
		if err != nil {
			return err
		}
		now := analysiscollab.Now()
		created := taskRow{
			id:          id,
			boardID:     boardID,
			columnID:    columnID,
			title:       input.title,
			body:        analysiscollab.NullString(input.body),
			priority:    input.priority,
			assigneeID:  analysiscollab.NullString(input.assigneeID),
			linkedType:  analysiscollab.NullString(input.linkedType),
			linkedID:    analysiscollab.NullString(input.linkedID),
			dueAt:       analysiscollab.NullTime(input.dueAt),
			sortOrder:   last + analysiscollab.SortStep,
			createdAt:   now,
			updatedAt:   now,
			createdByID: actor.ID,
			updatedByID: actor.ID,
		}
		if err := insertTask(ctx, tx, orgID, created); err != nil {
			return err
		}
		if err := touchBoard(ctx, tx, orgID, boardID, actor.ID, now); err != nil {
			return err
		}
		loaded, err := loadTask(ctx, tx, orgID, id)
		if err != nil {
			return err
		}
		row = loaded
		return nil
	})
	if err != nil {
		return analysiscollab.TaskCard{}, err
	}
	return s.taskCard(ctx, orgID, row)
}

func (s *Service) UpdateTask(ctx context.Context, orgID string, actor analysiscollab.Actor, taskID string, body analysiscollab.Body) (analysiscollab.TaskCard, error) {
	db, err := s.db()
	if err != nil {
		return analysiscollab.TaskCard{}, err
	}
	existing, err := findActiveTask(ctx, db, orgID, taskID)
	if err != nil {
		return analysiscollab.TaskCard{}, err
	}
	patch, err := prepareUpdate(ctx, db, orgID, actor, body)
	if err != nil {
		return analysiscollab.TaskCard{}, err
	}
	var row taskRow
	err = s.store.WithTx(ctx, func(tx *sql.Tx) error {
		board, err := analysiscollab.LockBoard(ctx, tx, orgID, existing.boardID)
		if err != nil {
			return err
		}
		if !board.Active() {
			return analysiscollab.NotFound(analysiscollab.MsgTaskNotFound)
		}
		locked, err := lockTaskCard(ctx, tx, orgID, existing.boardID, existing.id)
		if err != nil {
			return err
		}
		now := analysiscollab.Now()
		if err := applyTaskUpdate(ctx, tx, orgID, locked.id, actor.ID, patch, now); err != nil {
			return err
		}
		if err := touchBoard(ctx, tx, orgID, locked.boardID, actor.ID, now); err != nil {
			return err
		}
		loaded, err := loadTask(ctx, tx, orgID, locked.id)
		if err != nil {
			return err
		}
		row = loaded
		return nil
	})
	if err != nil {
		return analysiscollab.TaskCard{}, err
	}
	return s.taskCard(ctx, orgID, row)
}

func (s *Service) DeleteTask(ctx context.Context, orgID string, actor analysiscollab.Actor, taskID string) error {
	db, err := s.db()
	if err != nil {
		return err
	}
	existing, err := findActiveTask(ctx, db, orgID, taskID)
	if err != nil {
		return err
	}
	return s.store.WithTx(ctx, func(tx *sql.Tx) error {
		board, err := analysiscollab.LockBoard(ctx, tx, orgID, existing.boardID)
		if err != nil {
			return err
		}
		if !board.Active() {
			return analysiscollab.NotFound(analysiscollab.MsgTaskNotFound)
		}
		locked, err := lockTaskCard(ctx, tx, orgID, existing.boardID, taskID)
		if err != nil {
			return err
		}
		if err := analysiscollab.DeleteSubjectThread(ctx, tx, orgID, analysiscollab.SubjectAnalysisTask, locked.id); err != nil {
			return err
		}
		if err := deleteTaskCard(ctx, tx, orgID, locked.id); err != nil {
			return err
		}
		now := analysiscollab.Now()
		if err := reindexColumnTasks(ctx, tx, orgID, locked.columnID, now); err != nil {
			return err
		}
		return touchBoard(ctx, tx, orgID, locked.boardID, actor.ID, now)
	})
}

func (s *Service) MoveTask(ctx context.Context, orgID string, actor analysiscollab.Actor, taskID string, body analysiscollab.Body) (analysiscollab.BoardDetail, error) {
	db, err := s.db()
	if err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	if s.boards == nil {
		return analysiscollab.BoardDetail{}, errors.New("analysis: board reader is not configured")
	}
	existing, err := findActiveTask(ctx, db, orgID, taskID)
	if err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	targetColumnID := body.String("targetColumnId")
	targetIndex := body.Int("targetIndex")
	var boardID string
	err = s.store.WithTx(ctx, func(tx *sql.Tx) error {
		board, err := analysiscollab.LockBoard(ctx, tx, orgID, existing.boardID)
		if err != nil {
			return err
		}
		if !board.Active() {
			return analysiscollab.NotFound(analysiscollab.MsgTaskNotFound)
		}
		locked, err := lockTaskCard(ctx, tx, orgID, existing.boardID, taskID)
		if err != nil {
			return err
		}
		var targetID string
		err = tx.QueryRowContext(ctx, "SELECT `id` FROM `AnalysisBoardColumn` WHERE `orgId` = ? AND `boardId` = ? AND `id` = ? FOR UPDATE", orgID, locked.boardID, targetColumnID).Scan(&targetID)
		if errors.Is(err, sql.ErrNoRows) {
			return analysiscollab.NotFound(analysiscollab.MsgColumnNotFound)
		}
		if err != nil {
			return err
		}
		ids, err := loadColumnTaskIDs(ctx, tx, orgID, targetID)
		if err != nil {
			return err
		}
		now := analysiscollab.Now()
		order := analysiscollab.PlanTaskMove(locked.id, ids, locked.columnID == targetID, targetIndex)
		if err := updateTaskColumn(ctx, tx, orgID, locked.id, targetID, actor.ID, now); err != nil {
			return err
		}
		if err := setTaskSortOrder(ctx, tx, orgID, targetID, order, now); err != nil {
			return err
		}
		if locked.columnID != targetID {
			if err := reindexColumnTasks(ctx, tx, orgID, locked.columnID, now); err != nil {
				return err
			}
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
	return s.boards.GetBoard(ctx, orgID, actor, boardID)
}

func lockColumnID(ctx context.Context, tx *sql.Tx, orgID, boardID string, input createInput) (string, error) {
	if input.useColumn {
		var id string
		err := tx.QueryRowContext(ctx, "SELECT `id` FROM `AnalysisBoardColumn` WHERE `orgId` = ? AND `boardId` = ? AND `id` = ? FOR UPDATE", orgID, boardID, input.columnID).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			return "", analysiscollab.NotFound(analysiscollab.MsgColumnNotFound)
		}
		return id, err
	}
	var id string
	err := tx.QueryRowContext(ctx, "SELECT `id` FROM `AnalysisBoardColumn` WHERE `orgId` = ? AND `boardId` = ? ORDER BY `sortOrder` ASC, `createdAt` ASC LIMIT 1 FOR UPDATE", orgID, boardID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", analysiscollab.BadRequest(analysiscollab.MsgNoColumns)
	}
	return id, err
}

func (input createInput) column(ctx context.Context, q analysiscollab.Querier, orgID, boardID string) (string, error) {
	if input.useColumn {
		return findActiveColumn(ctx, q, orgID, boardID, input.columnID)
	}
	return findFirstColumn(ctx, q, orgID, boardID)
}

// createTaskPriority ports `priority: input.priority ?? AnalysisTaskPriority.normal`
// from createTask. The DTO marks priority optional, so class-validator lets an
// explicit JSON null through (@IsOptional skips the enum check) and the service
// then falls back to normal. Go must accept that same body instead of rejecting
// it, otherwise a client that sends `"priority": null` on create gets a 400 that
// the NestJS controller never returned. An unknown enum value is rejected before
// this helper runs.
//
// The update path intentionally keeps rejecting an explicit null: the source
// writes it unchecked into a non-null column and fails deep in Prisma, so a clear
// 400 is the documented Go-side improvement rather than a behavior change.
func createTaskPriority(body analysiscollab.Body) string {
	if !body.Has("priority") || body.Null("priority") {
		return analysiscollab.PriorityNormal
	}
	return body.String("priority")
}

func prepareCreate(ctx context.Context, db analysiscollab.Querier, orgID string, actor analysiscollab.Actor, body analysiscollab.Body) (createInput, error) {
	title, err := analysiscollab.NormalizeRequired(body.String("title"), 160, "title")
	if err != nil {
		return createInput{}, err
	}
	markdown, err := analysiscollab.NormalizeOptional(optionalBodyString(body, "bodyMarkdown"), 10000, "bodyMarkdown")
	if err != nil {
		return createInput{}, err
	}
	dueAt, err := analysiscollab.ParseOptionalDate(optionalBodyString(body, "dueAt"), "dueAt")
	if err != nil {
		return createInput{}, err
	}
	linked, err := analysiscollab.ResolveLinkedSubject(ctx, db, orgID, actor.ID, optionalBodyString(body, "linkedSubjectType"), optionalBodyString(body, "linkedSubjectId"))
	if err != nil {
		return createInput{}, err
	}
	assigneeID, err := analysiscollab.ResolveAssignee(ctx, db, orgID, optionalBodyString(body, "assigneeId"))
	if err != nil {
		return createInput{}, err
	}
	input := createInput{
		title:      title,
		body:       markdown,
		dueAt:      dueAt,
		assigneeID: assigneeID,
		priority:   createTaskPriority(body),
	}
	if linked != nil {
		input.linkedType = stringPtr(linked.Type)
		input.linkedID = stringPtr(linked.ID)
	}
	if body.Has("columnId") && !body.Null("columnId") {
		input.columnID = body.String("columnId")
		input.useColumn = input.columnID != ""
	}
	return input, nil
}

func prepareUpdate(ctx context.Context, db analysiscollab.Querier, orgID string, actor analysiscollab.Actor, body analysiscollab.Body) (taskUpdate, error) {
	var patch taskUpdate
	if body.Has("title") {
		title, err := analysiscollab.NormalizeRequired(body.String("title"), 160, "title")
		if err != nil {
			return taskUpdate{}, err
		}
		patch.hasTitle = true
		patch.title = title
	}
	if body.Has("bodyMarkdown") {
		text, err := analysiscollab.NormalizeOptional(optionalBodyString(body, "bodyMarkdown"), 10000, "bodyMarkdown")
		if err != nil {
			return taskUpdate{}, err
		}
		patch.hasBody = true
		patch.body = text
	}
	if body.Has("priority") {
		if body.Null("priority") {
			// updateTask does not coalesce: the source assigns the null straight
			// into a non-null enum column and surfaces a Prisma failure. Answering
			// the same invalid input with a 400 keeps the field contract explicit.
			return taskUpdate{}, analysiscollab.BadRequest("priority must be one of the following values: low, normal, high, urgent")
		}
		patch.hasPriority = true
		patch.priority = body.String("priority")
	}
	if body.Has("assigneeId") {
		assignee, err := analysiscollab.ResolveAssignee(ctx, db, orgID, optionalBodyString(body, "assigneeId"))
		if err != nil {
			return taskUpdate{}, err
		}
		patch.hasAssignee = true
		patch.assignee = assignee
	}
	if body.Has("linkedSubjectType") || body.Has("linkedSubjectId") {
		linked, err := analysiscollab.ResolveLinkedSubject(ctx, db, orgID, actor.ID, optionalBodyString(body, "linkedSubjectType"), optionalBodyString(body, "linkedSubjectId"))
		if err != nil {
			return taskUpdate{}, err
		}
		patch.hasLinked = true
		if linked != nil {
			patch.linkedType = stringPtr(linked.Type)
			patch.linkedID = stringPtr(linked.ID)
		}
	}
	if body.Has("dueAt") {
		due, err := analysiscollab.ParseOptionalDate(optionalBodyString(body, "dueAt"), "dueAt")
		if err != nil {
			return taskUpdate{}, err
		}
		patch.hasDue = true
		patch.due = due
	}
	return patch, nil
}

func applyTaskUpdate(ctx context.Context, tx *sql.Tx, orgID, taskID, actorID string, patch taskUpdate, now time.Time) error {
	sets := make([]string, 0, 8)
	args := make([]any, 0, 12)
	add := func(column string, value any) {
		sets = append(sets, column+" = ?")
		args = append(args, value)
	}
	add("`updatedById`", actorID)
	add("`updatedAt`", now)
	if patch.hasTitle {
		add("`title`", patch.title)
	}
	if patch.hasBody {
		add("`bodyMarkdown`", analysiscollab.NullString(patch.body))
	}
	if patch.hasPriority {
		add("`priority`", patch.priority)
	}
	if patch.hasAssignee {
		add("`assigneeId`", analysiscollab.NullString(patch.assignee))
	}
	if patch.hasLinked {
		add("`linkedSubjectType`", analysiscollab.NullString(patch.linkedType))
		add("`linkedSubjectId`", analysiscollab.NullString(patch.linkedID))
	}
	if patch.hasDue {
		add("`dueAt`", analysiscollab.NullTime(patch.due))
	}
	args = append(args, taskID, orgID)
	_, err := tx.ExecContext(ctx, "UPDATE `AnalysisTaskCard` SET "+strings.Join(sets, ", ")+" WHERE `id` = ? AND `orgId` = ?", args...)
	return err
}

func (s *Service) taskCard(ctx context.Context, orgID string, row taskRow) (analysiscollab.TaskCard, error) {
	ids := []string{row.createdByID, row.updatedByID}
	if row.assigneeID.Valid && row.assigneeID.String != "" {
		ids = append(ids, row.assigneeID.String)
	}
	users, err := analysiscollab.LoadUsers(ctx, s.store.DB, ids)
	if err != nil {
		return analysiscollab.TaskCard{}, err
	}
	counts, err := analysiscollab.LoadTaskCommentCounts(ctx, s.store.DB, orgID, []string{row.id})
	if err != nil {
		return analysiscollab.TaskCard{}, err
	}
	return toTaskCard(row, users, counts)
}

func toTaskCard(row taskRow, users map[string]analysiscollab.UserSummary, counts map[string]int) (analysiscollab.TaskCard, error) {
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

func (s *Service) db() (*sql.DB, error) {
	if s == nil || s.store == nil || s.store.DB == nil {
		return nil, errors.New("analysis: database is not configured")
	}
	return s.store.DB, nil
}

func optionalBodyString(body analysiscollab.Body, name string) *string {
	if !body.Has(name) || body.Null(name) {
		return nil
	}
	return stringPtr(body.String(name))
}

func stringPtr(value string) *string {
	copied := value
	return &copied
}
