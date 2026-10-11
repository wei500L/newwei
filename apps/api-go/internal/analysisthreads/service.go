package analysisthreads

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/analysiscollab"
)

const (
	// DTO 已经按未 trim 的长度拒绝。这里仍把同一上限交给 normalize，
	// 空白才会收成 nil 或「必填」。
	noteMaxLength = 20000
	bodyMaxLength = 5000
)

// Service 读写 AnalysisThread / AnalysisComment。orgId 只由调用方传入。
type Service struct {
	store *analysiscollab.Store
}

func NewService(store *analysiscollab.Store) *Service {
	return &Service{store: store}
}

// GetThread 确认主体可读后返回讨论。没有行时返回 nil，由 HTTP 写成 JSON null。
func (s *Service) GetThread(ctx context.Context, orgID, userID, subjectType, subjectID string) (*analysiscollab.Thread, error) {
	q, err := s.querier()
	if err != nil {
		return nil, err
	}
	if err := analysiscollab.AssertSubjectReadable(ctx, q, orgID, userID, subjectType, subjectID); err != nil {
		return nil, err
	}
	row, found, err := findThread(ctx, q, orgID, subjectType, subjectID, false)
	if err != nil || !found {
		return nil, err
	}
	comments, err := listComments(ctx, q, orgID, row.ID)
	if err != nil {
		return nil, err
	}
	thread, err := assembleThread(ctx, q, row, comments)
	if err != nil {
		return nil, err
	}
	return &thread, nil
}

// UpsertThread 写入共享笔记。尚无讨论且笔记为空时不插入，返回 nil。
// analysis.write 没有 owner 限制；私有视图仍由 LockSubjectForWrite 拒绝。
func (s *Service) UpsertThread(ctx context.Context, orgID string, actor analysiscollab.Actor, subjectType, subjectID string, note *string) (*analysiscollab.Thread, error) {
	normalized, err := analysiscollab.NormalizeOptional(note, noteMaxLength, "noteMarkdown")
	if err != nil {
		return nil, err
	}
	if err := s.ready(); err != nil {
		return nil, err
	}
	var result *analysiscollab.Thread
	err = s.store.WithTx(ctx, func(tx *sql.Tx) error {
		if err := analysiscollab.LockSubjectForWrite(ctx, tx, orgID, actor.ID, subjectType, subjectID); err != nil {
			return err
		}
		existing, found, err := findThread(ctx, tx, orgID, subjectType, subjectID, false)
		if err != nil {
			return err
		}
		if !found {
			if normalized == nil {
				return nil
			}
			now := analysiscollab.Now()
			inserted, insErr := insertThread(ctx, tx, orgID, actor.ID, subjectType, subjectID, normalized, now)
			if insErr != nil {
				if !analysiscollab.IsDuplicateKey(insErr) {
					return insErr
				}
				winner, ok, selErr := findThread(ctx, tx, orgID, subjectType, subjectID, true)
				if selErr != nil {
					return selErr
				}
				if !ok {
					return insErr
				}
				existing = winner
			} else {
				thread, buildErr := assembleThread(ctx, tx, inserted, nil)
				if buildErr != nil {
					return buildErr
				}
				result = &thread
				return nil
			}
		}
		now := analysiscollab.Now()
		if err := updateThreadNote(ctx, tx, orgID, existing.ID, actor.ID, normalized, now); err != nil {
			return err
		}
		existing.UpdatedByID = actor.ID
		existing.UpdatedAt = now
		existing.Note = analysiscollab.NullString(normalized)
		comments, err := listComments(ctx, tx, orgID, existing.ID)
		if err != nil {
			return err
		}
		thread, err := assembleThread(ctx, tx, existing, comments)
		if err != nil {
			return err
		}
		result = &thread
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// CreateComment 在缺少讨论时先插入 noteMarkdown 为 NULL 的 thread。
// 本次请求自己建成的 thread 不再更新；原本就存在的才推进 updatedBy。
func (s *Service) CreateComment(ctx context.Context, orgID string, actor analysiscollab.Actor, subjectType, subjectID, bodyMarkdown string) (analysiscollab.Comment, error) {
	body, err := analysiscollab.NormalizeRequired(bodyMarkdown, bodyMaxLength, "bodyMarkdown")
	if err != nil {
		return analysiscollab.Comment{}, err
	}
	if err := s.ready(); err != nil {
		return analysiscollab.Comment{}, err
	}
	var result analysiscollab.Comment
	err = s.store.WithTx(ctx, func(tx *sql.Tx) error {
		if err := analysiscollab.LockSubjectForWrite(ctx, tx, orgID, actor.ID, subjectType, subjectID); err != nil {
			return err
		}
		thread, found, err := findThread(ctx, tx, orgID, subjectType, subjectID, false)
		if err != nil {
			return err
		}
		created := false
		if !found {
			now := analysiscollab.Now()
			inserted, insErr := insertThread(ctx, tx, orgID, actor.ID, subjectType, subjectID, nil, now)
			if insErr != nil {
				if !analysiscollab.IsDuplicateKey(insErr) {
					return insErr
				}
				winner, ok, selErr := findThread(ctx, tx, orgID, subjectType, subjectID, true)
				if selErr != nil {
					return selErr
				}
				if !ok {
					return insErr
				}
				thread = winner
			} else {
				thread = inserted
				created = true
			}
		}
		if !created {
			if err := touchThread(ctx, tx, orgID, thread.ID, actor.ID, analysiscollab.Now()); err != nil {
				return err
			}
		}
		now := analysiscollab.Now()
		comment, err := insertComment(ctx, tx, orgID, thread.ID, actor.ID, body, now)
		if err != nil {
			return err
		}
		author, err := loadAuthor(ctx, tx, actor.ID)
		if err != nil {
			return err
		}
		result = commentResponse(comment, author)
		return nil
	})
	if err != nil {
		return analysiscollab.Comment{}, err
	}
	return result, nil
}

// UpdateComment 只改评论正文。作者或 users.write 可以改；之后再次确认主体可读。
// 不推进所属 thread 的 updatedBy / updatedAt。
func (s *Service) UpdateComment(ctx context.Context, orgID string, actor analysiscollab.Actor, commentID, bodyMarkdown string) (analysiscollab.Comment, error) {
	if err := s.ready(); err != nil {
		return analysiscollab.Comment{}, err
	}
	var result analysiscollab.Comment
	err := s.store.WithTx(ctx, func(tx *sql.Tx) error {
		existing, found, err := findComment(ctx, tx, orgID, commentID)
		if err != nil {
			return err
		}
		if !found {
			return analysiscollab.NotFound(analysiscollab.MsgCommentNotFound)
		}
		if !actor.CanManageOwned(existing.CreatedByID) {
			return analysiscollab.Forbidden(analysiscollab.MsgEditComment)
		}
		if err := analysiscollab.LockSubjectForWrite(ctx, tx, orgID, actor.ID, existing.SubjectType, existing.SubjectID); err != nil {
			return err
		}
		body, err := analysiscollab.NormalizeRequired(bodyMarkdown, bodyMaxLength, "bodyMarkdown")
		if err != nil {
			return err
		}
		now := analysiscollab.Now()
		if err := updateCommentBody(ctx, tx, orgID, existing.ID, body, now); err != nil {
			return err
		}
		existing.Body = body
		existing.UpdatedAt = now
		author, err := loadAuthor(ctx, tx, existing.CreatedByID)
		if err != nil {
			return err
		}
		result = commentResponse(existing, author)
		return nil
	})
	if err != nil {
		return analysiscollab.Comment{}, err
	}
	return result, nil
}

// DeleteComment 只删除评论。不复查主体，也不删除 thread。
func (s *Service) DeleteComment(ctx context.Context, orgID string, actor analysiscollab.Actor, commentID string) error {
	q, err := s.querier()
	if err != nil {
		return err
	}
	existing, found, err := findComment(ctx, q, orgID, commentID)
	if err != nil {
		return err
	}
	if !found {
		return analysiscollab.NotFound(analysiscollab.MsgCommentNotFound)
	}
	if !actor.CanManageOwned(existing.CreatedByID) {
		return analysiscollab.Forbidden(analysiscollab.MsgEditComment)
	}
	_, err = q.ExecContext(ctx, deleteCommentSQL, existing.ID, orgID)
	return err
}

func (s *Service) ready() error {
	if s == nil || s.store == nil || s.store.DB == nil {
		return errors.New("analysis: database is not configured")
	}
	return nil
}

func (s *Service) querier() (analysiscollab.Querier, error) {
	if err := s.ready(); err != nil {
		return nil, err
	}
	return s.store.DB, nil
}

type threadRow struct {
	ID          string
	CreatedByID string
	UpdatedByID string
	SubjectType string
	SubjectID   string
	Note        sql.NullString
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type commentRow struct {
	ID          string
	CreatedByID string
	Body        string
	CreatedAt   time.Time
	UpdatedAt   time.Time
	SubjectType string
	SubjectID   string
}

const threadColumns = "`id`, `createdById`, `updatedById`, `subjectType`, `subjectId`, `noteMarkdown`, `createdAt`, `updatedAt`"

const findThreadSQL = "SELECT " + threadColumns + " FROM `AnalysisThread` WHERE `orgId` = ? AND `subjectType` = ? AND `subjectId` = ?"

const insertThreadSQL = "INSERT INTO `AnalysisThread` (`id`, `orgId`, `createdById`, `updatedById`, `subjectType`, `subjectId`, `noteMarkdown`, `createdAt`, `updatedAt`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"

const updateThreadNoteSQL = "UPDATE `AnalysisThread` SET `noteMarkdown` = ?, `updatedById` = ?, `updatedAt` = ? WHERE `id` = ? AND `orgId` = ?"

const touchThreadSQL = "UPDATE `AnalysisThread` SET `updatedById` = ?, `updatedAt` = ? WHERE `id` = ? AND `orgId` = ?"

const listCommentsSQL = "SELECT `id`, `createdById`, `bodyMarkdown`, `createdAt`, `updatedAt` FROM `AnalysisComment` WHERE `orgId` = ? AND `threadId` = ? ORDER BY `createdAt` ASC"

const insertCommentSQL = "INSERT INTO `AnalysisComment` (`id`, `orgId`, `threadId`, `createdById`, `bodyMarkdown`, `createdAt`, `updatedAt`) VALUES (?, ?, ?, ?, ?, ?, ?)"

const findCommentSQL = "SELECT c.`id`, c.`createdById`, c.`bodyMarkdown`, c.`createdAt`, c.`updatedAt`, t.`subjectType`, t.`subjectId` FROM `AnalysisComment` c INNER JOIN `AnalysisThread` t ON t.`id` = c.`threadId` AND t.`orgId` = c.`orgId` WHERE c.`id` = ? AND c.`orgId` = ?"

const updateCommentSQL = "UPDATE `AnalysisComment` SET `bodyMarkdown` = ?, `updatedAt` = ? WHERE `id` = ? AND `orgId` = ?"

const deleteCommentSQL = "DELETE FROM `AnalysisComment` WHERE `id` = ? AND `orgId` = ?"

func findThread(ctx context.Context, q analysiscollab.Querier, orgID, subjectType, subjectID string, forUpdate bool) (threadRow, bool, error) {
	query := findThreadSQL
	if forUpdate {
		// 普通 SELECT 沿用事务快照，看不见本事务开始后提交的胜者。
		// 只有 1062 才走这条锁定读，然后更新那一行。
		query += " FOR UPDATE"
	}
	var row threadRow
	err := q.QueryRowContext(ctx, query, orgID, subjectType, subjectID).Scan(
		&row.ID,
		&row.CreatedByID,
		&row.UpdatedByID,
		&row.SubjectType,
		&row.SubjectID,
		&row.Note,
		&row.CreatedAt,
		&row.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return threadRow{}, false, nil
	}
	if err != nil {
		return threadRow{}, false, err
	}
	return row, true, nil
}

func insertThread(ctx context.Context, tx *sql.Tx, orgID, userID, subjectType, subjectID string, note *string, now time.Time) (threadRow, error) {
	id, err := analysiscollab.NewID()
	if err != nil {
		return threadRow{}, err
	}
	noteValue := analysiscollab.NullString(note)
	_, err = tx.ExecContext(ctx, insertThreadSQL, id, orgID, userID, userID, subjectType, subjectID, noteValue, now, now)
	if err != nil {
		return threadRow{}, err
	}
	return threadRow{
		ID:          id,
		CreatedByID: userID,
		UpdatedByID: userID,
		SubjectType: subjectType,
		SubjectID:   subjectID,
		Note:        noteValue,
		CreatedAt:   now,
		UpdatedAt:   now,
	}, nil
}

func updateThreadNote(ctx context.Context, tx *sql.Tx, orgID, threadID, userID string, note *string, now time.Time) error {
	_, err := tx.ExecContext(ctx, updateThreadNoteSQL, analysiscollab.NullString(note), userID, now, threadID, orgID)
	return err
}

func touchThread(ctx context.Context, tx *sql.Tx, orgID, threadID, userID string, now time.Time) error {
	_, err := tx.ExecContext(ctx, touchThreadSQL, userID, now, threadID, orgID)
	return err
}

func listComments(ctx context.Context, q analysiscollab.Querier, orgID, threadID string) ([]commentRow, error) {
	rows, err := q.QueryContext(ctx, listCommentsSQL, orgID, threadID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]commentRow, 0)
	for rows.Next() {
		var row commentRow
		if err := rows.Scan(&row.ID, &row.CreatedByID, &row.Body, &row.CreatedAt, &row.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func insertComment(ctx context.Context, tx *sql.Tx, orgID, threadID, userID, body string, now time.Time) (commentRow, error) {
	id, err := analysiscollab.NewID()
	if err != nil {
		return commentRow{}, err
	}
	_, err = tx.ExecContext(ctx, insertCommentSQL, id, orgID, threadID, userID, body, now, now)
	if err != nil {
		return commentRow{}, err
	}
	return commentRow{
		ID:          id,
		CreatedByID: userID,
		Body:        body,
		CreatedAt:   now,
		UpdatedAt:   now,
	}, nil
}

func findComment(ctx context.Context, q analysiscollab.Querier, orgID, commentID string) (commentRow, bool, error) {
	var row commentRow
	err := q.QueryRowContext(ctx, findCommentSQL, commentID, orgID).Scan(
		&row.ID,
		&row.CreatedByID,
		&row.Body,
		&row.CreatedAt,
		&row.UpdatedAt,
		&row.SubjectType,
		&row.SubjectID,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return commentRow{}, false, nil
	}
	if err != nil {
		return commentRow{}, false, err
	}
	return row, true, nil
}

func updateCommentBody(ctx context.Context, tx *sql.Tx, orgID, commentID, body string, now time.Time) error {
	result, err := tx.ExecContext(ctx, updateCommentSQL, body, now, commentID, orgID)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return analysiscollab.NotFound(analysiscollab.MsgCommentNotFound)
	}
	return nil
}

func loadAuthor(ctx context.Context, q analysiscollab.Querier, userID string) (analysiscollab.UserSummary, error) {
	users, err := analysiscollab.LoadUsers(ctx, q, []string{userID})
	if err != nil {
		return analysiscollab.UserSummary{}, err
	}
	return analysiscollab.MustUser(users, userID)
}

func assembleThread(ctx context.Context, q analysiscollab.Querier, row threadRow, comments []commentRow) (analysiscollab.Thread, error) {
	ids := make([]string, 0, 2+len(comments))
	ids = append(ids, row.CreatedByID, row.UpdatedByID)
	for _, comment := range comments {
		ids = append(ids, comment.CreatedByID)
	}
	users, err := analysiscollab.LoadUsers(ctx, q, ids)
	if err != nil {
		return analysiscollab.Thread{}, err
	}
	createdBy, err := analysiscollab.MustUser(users, row.CreatedByID)
	if err != nil {
		return analysiscollab.Thread{}, err
	}
	updatedBy, err := analysiscollab.MustUser(users, row.UpdatedByID)
	if err != nil {
		return analysiscollab.Thread{}, err
	}
	outComments := make([]analysiscollab.Comment, 0, len(comments))
	for _, comment := range comments {
		author, err := analysiscollab.MustUser(users, comment.CreatedByID)
		if err != nil {
			return analysiscollab.Thread{}, err
		}
		outComments = append(outComments, commentResponse(comment, author))
	}
	return analysiscollab.Thread{
		ID:           row.ID,
		SubjectType:  row.SubjectType,
		SubjectID:    row.SubjectID,
		NoteMarkdown: analysiscollab.TextPtr(row.Note),
		CreatedAt:    analysiscollab.FormatISO(row.CreatedAt),
		UpdatedAt:    analysiscollab.FormatISO(row.UpdatedAt),
		CreatedBy:    createdBy,
		UpdatedBy:    updatedBy,
		Comments:     outComments,
	}, nil
}

func commentResponse(row commentRow, author analysiscollab.UserSummary) analysiscollab.Comment {
	return analysiscollab.Comment{
		ID:           row.ID,
		CreatedByID:  row.CreatedByID,
		BodyMarkdown: row.Body,
		CreatedAt:    analysiscollab.FormatISO(row.CreatedAt),
		UpdatedAt:    analysiscollab.FormatISO(row.UpdatedAt),
		CreatedBy:    author,
	}
}
