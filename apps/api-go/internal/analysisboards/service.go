package analysisboards

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/analysiscollab"
)

// Service 是看板和列的读写。GetBoard 是 analysiscollab.BoardReader。
type Service struct {
	store *analysiscollab.Store
}

var _ analysiscollab.BoardReader = (*Service)(nil)

// NewService 使用四个分析域共用的连接池。
func NewService(store *analysiscollab.Store) *Service {
	return &Service{store: store}
}

const insertBoardSQL = "INSERT INTO `AnalysisBoard` (" +
	"`id`, `orgId`, `createdById`, `updatedById`, `title`, `description`, `archivedAt`, `createdAt`, `updatedAt`" +
	") VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)"

const insertColumnSQL = "INSERT INTO `AnalysisBoardColumn` (" +
	"`id`, `orgId`, `boardId`, `title`, `color`, `sortOrder`, `isDone`, `createdAt`, `updatedAt`" +
	") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"

// ListBoards 先确保组织有一块未归档看板，再按更新时间返回未归档看板。
// 不按创建者过滤。
func (s *Service) ListBoards(ctx context.Context, orgID string, actor analysiscollab.Actor) ([]analysiscollab.BoardSummary, error) {
	db, err := s.db()
	if err != nil {
		return nil, err
	}
	if err := s.ensureDefaultBoard(ctx, orgID, actor); err != nil {
		return nil, err
	}
	return loadBoardSummaries(ctx, db, orgID)
}

// GetBoard 先确保默认看板，再读取未归档详情。没有这块看板时是 404。
func (s *Service) GetBoard(ctx context.Context, orgID string, actor analysiscollab.Actor, boardID string) (analysiscollab.BoardDetail, error) {
	db, err := s.db()
	if err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	if err := s.ensureDefaultBoard(ctx, orgID, actor); err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	return loadBoardDetail(ctx, db, orgID, boardID)
}

// CreateBoard 插入看板和五列默认列，不锁组织。提交后再读详情。
func (s *Service) CreateBoard(ctx context.Context, orgID string, actor analysiscollab.Actor, body analysiscollab.Body) (analysiscollab.BoardDetail, error) {
	title, err := analysiscollab.NormalizeRequired(body.String("title"), 120, "title")
	if err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	description, err := analysiscollab.NormalizeOptional(body.StringPtr("description"), 1000, "description")
	if err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	if _, err := s.db(); err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	var boardID string
	err = s.store.WithTx(ctx, func(tx *sql.Tx) error {
		id, err := insertBoardWithColumns(ctx, tx, orgID, actor.ID, title, description, analysiscollab.Now())
		if err != nil {
			return err
		}
		boardID = id
		return nil
	})
	if err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	return s.GetBoard(ctx, orgID, actor, boardID)
}

// UpdateBoard 先规范化，再锁看板。显式 null 或空白 description 清空。
// 空对象也更新 updatedById 和 updatedAt。
func (s *Service) UpdateBoard(ctx context.Context, orgID string, actor analysiscollab.Actor, boardID string, body analysiscollab.Body) (analysiscollab.BoardDetail, error) {
	patch, err := normalizeBoardPatch(body)
	if err != nil {
		return analysiscollab.BoardDetail{}, err
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
		return applyBoardPatch(ctx, tx, orgID, boardID, actor.ID, patch, analysiscollab.Now())
	})
	if err != nil {
		return analysiscollab.BoardDetail{}, err
	}
	return s.GetBoard(ctx, orgID, actor, boardID)
}

// ArchiveBoard 不是物理删除。先锁组织再锁看板。最后一块未归档看板不能归档。
func (s *Service) ArchiveBoard(ctx context.Context, orgID string, actor analysiscollab.Actor, boardID string) error {
	if _, err := s.db(); err != nil {
		return err
	}
	return s.store.WithTx(ctx, func(tx *sql.Tx) error {
		if err := analysiscollab.LockOrg(ctx, tx, orgID); err != nil {
			return err
		}
		lock, err := analysiscollab.LockBoard(ctx, tx, orgID, boardID)
		if err != nil {
			return err
		}
		if !lock.Active() {
			return analysiscollab.NotFound(analysiscollab.MsgBoardNotFound)
		}
		var active int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM `AnalysisBoard` WHERE `orgId` = ? AND `archivedAt` IS NULL", orgID).Scan(&active); err != nil {
			return err
		}
		if active <= 1 {
			return analysiscollab.BadRequest(analysiscollab.MsgLastBoard)
		}
		now := analysiscollab.Now()
		res, err := tx.ExecContext(ctx, "UPDATE `AnalysisBoard` SET `archivedAt` = ?, `updatedById` = ?, `updatedAt` = ? WHERE `id` = ? AND `orgId` = ? AND `archivedAt` IS NULL", now, actor.ID, now, boardID, orgID)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return analysiscollab.BadRequest(analysiscollab.MsgBoardArchived)
		}
		return nil
	})
}

// 池上的存在性检查不能放进事务：事务里的第一条语句必须是 LockOrg，
// 这样后面的普通 SELECT 才在锁内建立可重复读快照。
func (s *Service) ensureDefaultBoard(ctx context.Context, orgID string, actor analysiscollab.Actor) error {
	db, err := s.db()
	if err != nil {
		return err
	}
	found, err := activeBoardExists(ctx, db, orgID)
	if err != nil || found {
		return err
	}
	return s.store.WithTx(ctx, func(tx *sql.Tx) error {
		if err := analysiscollab.LockOrg(ctx, tx, orgID); err != nil {
			return err
		}
		found, err := activeBoardExists(ctx, tx, orgID)
		if err != nil || found {
			return err
		}
		_, err = insertBoardWithColumns(ctx, tx, orgID, actor.ID, analysiscollab.DefaultBoardTitle, nil, analysiscollab.Now())
		return err
	})
}

func activeBoardExists(ctx context.Context, q analysiscollab.Querier, orgID string) (bool, error) {
	var id string
	err := q.QueryRowContext(ctx, "SELECT `id` FROM `AnalysisBoard` WHERE `orgId` = ? AND `archivedAt` IS NULL ORDER BY `createdAt` ASC LIMIT 1", orgID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func insertBoardWithColumns(ctx context.Context, q analysiscollab.Querier, orgID, actorID, title string, description *string, now time.Time) (string, error) {
	boardID, err := analysiscollab.NewID()
	if err != nil {
		return "", err
	}
	_, err = q.ExecContext(ctx, insertBoardSQL, boardID, orgID, actorID, actorID, title, analysiscollab.NullString(description), now, now)
	if err != nil {
		return "", err
	}
	for index, column := range analysiscollab.DefaultColumns {
		if err := insertColumn(ctx, q, orgID, boardID, column.Title, sql.NullString{String: column.Color, Valid: true}, analysiscollab.SortOrder(index), column.IsDone, now); err != nil {
			return "", err
		}
	}
	return boardID, nil
}

func insertColumn(ctx context.Context, q analysiscollab.Querier, orgID, boardID, title string, color sql.NullString, sortOrder int, isDone bool, now time.Time) error {
	id, err := analysiscollab.NewID()
	if err != nil {
		return err
	}
	_, err = q.ExecContext(ctx, insertColumnSQL, id, orgID, boardID, title, color, sortOrder, isDone, now, now)
	return err
}

type boardPatch struct {
	title          string
	setTitle       bool
	description    *string
	setDescription bool
}

func normalizeBoardPatch(body analysiscollab.Body) (boardPatch, error) {
	var patch boardPatch
	if body.Has("title") {
		raw := ""
		if !body.Null("title") {
			raw = body.String("title")
		}
		title, err := analysiscollab.NormalizeRequired(raw, 120, "title")
		if err != nil {
			return boardPatch{}, err
		}
		patch.title = title
		patch.setTitle = true
	}
	if body.Has("description") {
		description, err := analysiscollab.NormalizeOptional(body.StringPtr("description"), 1000, "description")
		if err != nil {
			return boardPatch{}, err
		}
		patch.description = description
		patch.setDescription = true
	}
	return patch, nil
}

func applyBoardPatch(ctx context.Context, tx *sql.Tx, orgID, boardID, actorID string, patch boardPatch, now time.Time) error {
	sets := make([]string, 0, 4)
	args := make([]any, 0, 6)
	if patch.setTitle {
		sets = append(sets, "`title` = ?")
		args = append(args, patch.title)
	}
	if patch.setDescription {
		sets = append(sets, "`description` = ?")
		args = append(args, analysiscollab.NullString(patch.description))
	}
	sets = append(sets, "`updatedById` = ?", "`updatedAt` = ?")
	args = append(args, actorID, now, boardID, orgID)
	_, err := tx.ExecContext(ctx, "UPDATE `AnalysisBoard` SET "+strings.Join(sets, ", ")+" WHERE `id` = ? AND `orgId` = ? AND `archivedAt` IS NULL", args...)
	return err
}

func touchBoard(ctx context.Context, tx *sql.Tx, orgID, boardID, actorID string, now time.Time) error {
	_, err := tx.ExecContext(ctx, "UPDATE `AnalysisBoard` SET `updatedById` = ?, `updatedAt` = ? WHERE `id` = ? AND `orgId` = ?", actorID, now, boardID, orgID)
	return err
}

func (s *Service) db() (*sql.DB, error) {
	if s == nil || s.store == nil || s.store.DB == nil {
		return nil, errDatabase
	}
	return s.store.DB, nil
}
