package analysisviews

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/analysiscollab"
)

const (
	viewColumns = "`id`, `createdById`, `updatedById`, `title`, `description`, `surface`, `routePath`, `queryState`, `visibility`, `createdAt`, `updatedAt`"

	selectViewByIDSQL = "SELECT " + viewColumns + " FROM `SavedAnalysisView` WHERE `orgId` = ? AND `id` = ?"

	insertViewSQL = "INSERT INTO `SavedAnalysisView` (" +
		"`id`, `orgId`, `createdById`, `updatedById`, `title`, `description`, `surface`, `routePath`, `queryState`, `visibility`, `createdAt`, `updatedAt`" +
		") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"

	deleteViewSQL = "DELETE FROM `SavedAnalysisView` WHERE `id` = ? AND `orgId` = ?"
)

// Service 是保存视图的读写。orgId 与 userId 只来自鉴权身份。
type Service struct {
	store *analysiscollab.Store
}

// NewService 使用四个分析域共用的连接池。
func NewService(store *analysiscollab.Store) *Service {
	return &Service{store: store}
}

type viewRow struct {
	ID          string
	CreatedByID string
	UpdatedByID string
	Title       string
	Description sql.NullString
	Surface     string
	RoutePath   string
	QueryState  []byte
	Visibility  string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type scanner interface {
	Scan(dest ...any) error
}

// ListViews 按 scope 与可选 surface 返回当前用户能读的视图。
// 未知 scope（含空字符串）是 all。surface 只在查询字段出现时过滤。
func (s *Service) ListViews(ctx context.Context, principal analysiscollab.Principal, rawQuery string) ([]analysiscollab.SavedView, error) {
	body, err := analysiscollab.ValidateRawQuery(rawQuery, analysiscollab.ListViewSpecs())
	if err != nil {
		return nil, err
	}
	q, err := s.querier()
	if err != nil {
		return nil, err
	}
	scope := analysiscollab.ListScope(body.String("scope"))
	surface := ""
	hasSurface := body.Has("surface") && !body.Null("surface")
	if hasSurface {
		surface = body.String("surface")
	}
	rows, err := listViews(ctx, q, principal.OrgID, principal.Actor.ID, scope, surface, hasSurface)
	if err != nil {
		return nil, err
	}
	return presentViews(ctx, q, rows, principal.Actor)
}

// GetView 读取一条视图。不存在或当前用户不能读时都是 404。
func (s *Service) GetView(ctx context.Context, principal analysiscollab.Principal, id string) (analysiscollab.SavedView, error) {
	q, err := s.querier()
	if err != nil {
		return analysiscollab.SavedView{}, err
	}
	row, err := readableView(ctx, q, principal.OrgID, principal.Actor.ID, id)
	if err != nil {
		return analysiscollab.SavedView{}, err
	}
	return presentOne(ctx, q, row, principal.Actor)
}

// CreateView 插入一条视图。visibility 缺失或 JSON null 时为 private。
func (s *Service) CreateView(ctx context.Context, principal analysiscollab.Principal, raw []byte) (analysiscollab.SavedView, error) {
	body, err := analysiscollab.ValidateBody(raw, analysiscollab.CreateViewSpecs())
	if err != nil {
		return analysiscollab.SavedView{}, err
	}
	title, err := analysiscollab.NormalizeRequired(body.String("title"), 120, "title")
	if err != nil {
		return analysiscollab.SavedView{}, err
	}
	description, err := analysiscollab.NormalizeOptional(body.StringPtr("description"), 1000, "description")
	if err != nil {
		return analysiscollab.SavedView{}, err
	}
	routePath, err := analysiscollab.NormalizeRoutePath(body.String("routePath"))
	if err != nil {
		return analysiscollab.SavedView{}, err
	}
	queryState, err := analysiscollab.BuildQueryState(queryStringInput(body))
	if err != nil {
		return analysiscollab.SavedView{}, err
	}
	id, err := analysiscollab.NewID()
	if err != nil {
		return analysiscollab.SavedView{}, err
	}
	q, err := s.querier()
	if err != nil {
		return analysiscollab.SavedView{}, err
	}
	now := analysiscollab.Now()
	_, err = q.ExecContext(ctx, insertViewSQL,
		id,
		principal.OrgID,
		principal.Actor.ID,
		principal.Actor.ID,
		title,
		analysiscollab.NullString(description),
		body.String("surface"),
		routePath,
		string(queryState),
		createVisibility(body),
		now,
		now,
	)
	if err != nil {
		return analysiscollab.SavedView{}, err
	}
	row, err := loadView(ctx, q, principal.OrgID, id)
	if err != nil {
		return analysiscollab.SavedView{}, err
	}
	return presentOne(ctx, q, row, principal.Actor)
}

// UpdateView 先确认可读，再确认 owner 或 users.write。
// 缺失字段不改；description 的 null 或空字符串清空；queryString 出现（含 null）重写 queryState。
// 即使正文是 {} 也更新 updatedById 与 updatedAt。
func (s *Service) UpdateView(ctx context.Context, principal analysiscollab.Principal, id string, raw []byte) (analysiscollab.SavedView, error) {
	body, err := analysiscollab.ValidateBody(raw, analysiscollab.UpdateViewSpecs())
	if err != nil {
		return analysiscollab.SavedView{}, err
	}
	q, err := s.querier()
	if err != nil {
		return analysiscollab.SavedView{}, err
	}
	existing, err := readableView(ctx, q, principal.OrgID, principal.Actor.ID, id)
	if err != nil {
		return analysiscollab.SavedView{}, err
	}
	if !principal.Actor.CanManageOwned(existing.CreatedByID) {
		return analysiscollab.SavedView{}, analysiscollab.Forbidden(analysiscollab.MsgEditResource)
	}

	sets := []string{"`updatedById` = ?", "`updatedAt` = ?"}
	args := []any{principal.Actor.ID, analysiscollab.Now()}
	if body.Has("title") {
		title, err := analysiscollab.NormalizeRequired(body.String("title"), 120, "title")
		if err != nil {
			return analysiscollab.SavedView{}, err
		}
		sets = append(sets, "`title` = ?")
		args = append(args, title)
	}
	if body.Has("description") {
		description, err := analysiscollab.NormalizeOptional(body.StringPtr("description"), 1000, "description")
		if err != nil {
			return analysiscollab.SavedView{}, err
		}
		sets = append(sets, "`description` = ?")
		args = append(args, analysiscollab.NullString(description))
	}
	if body.Has("routePath") {
		routePath, err := analysiscollab.NormalizeRoutePath(body.String("routePath"))
		if err != nil {
			return analysiscollab.SavedView{}, err
		}
		sets = append(sets, "`routePath` = ?")
		args = append(args, routePath)
	}
	if body.Has("queryString") {
		queryState, err := analysiscollab.BuildQueryState(queryStringInput(body))
		if err != nil {
			return analysiscollab.SavedView{}, err
		}
		sets = append(sets, "`queryState` = ?")
		args = append(args, string(queryState))
	}
	// 缺失不改列。显式 null 不是合法枚举，不能当成“不修改”。
	if body.Has("visibility") {
		if body.Null("visibility") {
			return analysiscollab.SavedView{}, analysiscollab.BadRequest("visibility must be one of the following values: private, org_shared")
		}
		sets = append(sets, "`visibility` = ?")
		args = append(args, body.String("visibility"))
	}
	args = append(args, id, principal.OrgID)
	query := "UPDATE `SavedAnalysisView` SET " + strings.Join(sets, ", ") + " WHERE `id` = ? AND `orgId` = ?"
	if _, err := q.ExecContext(ctx, query, args...); err != nil {
		return analysiscollab.SavedView{}, err
	}
	updated, err := loadView(ctx, q, principal.OrgID, id)
	if errors.Is(err, sql.ErrNoRows) {
		return analysiscollab.SavedView{}, analysiscollab.NotFound(analysiscollab.MsgViewNotFound)
	}
	if err != nil {
		return analysiscollab.SavedView{}, err
	}
	return presentOne(ctx, q, updated, principal.Actor)
}

// DeleteView 不要求调用者能读该视图。users.write 可以删除别人的私有视图。
// 同一事务里锁视图行、删除 saved_view 讨论，再删除视图。不删除关联任务卡。
func (s *Service) DeleteView(ctx context.Context, principal analysiscollab.Principal, id string) error {
	if s == nil || s.store == nil {
		return errDatabase
	}
	return s.store.WithTx(ctx, func(tx *sql.Tx) error {
		locked, err := analysiscollab.LockSavedView(ctx, tx, principal.OrgID, id)
		if err != nil {
			return err
		}
		if !locked.Found {
			return analysiscollab.NotFound(analysiscollab.MsgViewNotFound)
		}
		if !principal.Actor.CanManageOwned(locked.CreatedByID) {
			return analysiscollab.Forbidden(analysiscollab.MsgEditResource)
		}
		if err := analysiscollab.DeleteSubjectThread(ctx, tx, principal.OrgID, analysiscollab.SubjectSavedView, id); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, deleteViewSQL, id, principal.OrgID)
		if err != nil {
			return err
		}
		deleted, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if deleted == 0 {
			return analysiscollab.NotFound(analysiscollab.MsgViewNotFound)
		}
		return nil
	})
}

func (s *Service) querier() (analysiscollab.Querier, error) {
	if s == nil || s.store == nil || s.store.DB == nil {
		return nil, errDatabase
	}
	return s.store.DB, nil
}

var errDatabase = errors.New("analysis views: database is not configured")

func listViews(ctx context.Context, q analysiscollab.Querier, orgID, userID, scope, surface string, hasSurface bool) ([]viewRow, error) {
	query, args := savedViewListQuery(orgID, userID, scope, surface, hasSurface)
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]viewRow, 0)
	for rows.Next() {
		row, err := scanView(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func savedViewListQuery(orgID, userID, scope, surface string, hasSurface bool) (string, []any) {
	var b strings.Builder
	b.WriteString("SELECT ")
	b.WriteString(viewColumns)
	b.WriteString(" FROM `SavedAnalysisView` WHERE `orgId` = ?")
	args := []any{orgID}
	if hasSurface {
		b.WriteString(" AND `surface` = ?")
		args = append(args, surface)
	}
	switch scope {
	case "mine":
		b.WriteString(" AND `createdById` = ?")
		args = append(args, userID)
	case "shared":
		b.WriteString(" AND `visibility` = ? AND `createdById` <> ?")
		args = append(args, analysiscollab.VisibilityOrgShared, userID)
	default:
		b.WriteString(" AND (`createdById` = ? OR `visibility` = ?)")
		args = append(args, userID, analysiscollab.VisibilityOrgShared)
	}
	b.WriteString(" ORDER BY `updatedAt` DESC, `createdAt` DESC")
	return b.String(), args
}

func readableView(ctx context.Context, q analysiscollab.Querier, orgID, userID, id string) (viewRow, error) {
	row, err := loadView(ctx, q, orgID, id)
	if errors.Is(err, sql.ErrNoRows) {
		return viewRow{}, analysiscollab.NotFound(analysiscollab.MsgViewNotFound)
	}
	if err != nil {
		return viewRow{}, err
	}
	if !analysiscollab.CanReadSavedView(row.CreatedByID, row.Visibility, userID) {
		return viewRow{}, analysiscollab.NotFound(analysiscollab.MsgViewNotFound)
	}
	return row, nil
}

func loadView(ctx context.Context, q analysiscollab.Querier, orgID, id string) (viewRow, error) {
	return scanView(q.QueryRowContext(ctx, selectViewByIDSQL, orgID, id))
}

func scanView(row scanner) (viewRow, error) {
	var view viewRow
	err := row.Scan(
		&view.ID,
		&view.CreatedByID,
		&view.UpdatedByID,
		&view.Title,
		&view.Description,
		&view.Surface,
		&view.RoutePath,
		&view.QueryState,
		&view.Visibility,
		&view.CreatedAt,
		&view.UpdatedAt,
	)
	if err != nil {
		return viewRow{}, err
	}
	return view, nil
}

func presentViews(ctx context.Context, q analysiscollab.Querier, rows []viewRow, actor analysiscollab.Actor) ([]analysiscollab.SavedView, error) {
	out := make([]analysiscollab.SavedView, 0, len(rows))
	if len(rows) == 0 {
		return out, nil
	}
	ids := make([]string, 0, len(rows)*2)
	for _, row := range rows {
		ids = append(ids, row.CreatedByID, row.UpdatedByID)
	}
	users, err := analysiscollab.LoadUsers(ctx, q, ids)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		createdBy, err := analysiscollab.MustUser(users, row.CreatedByID)
		if err != nil {
			return nil, err
		}
		updatedBy, err := analysiscollab.MustUser(users, row.UpdatedByID)
		if err != nil {
			return nil, err
		}
		out = append(out, analysiscollab.SavedView{
			ID:          row.ID,
			Title:       row.Title,
			Description: analysiscollab.TextPtr(row.Description),
			Surface:     row.Surface,
			RoutePath:   row.RoutePath,
			QueryState:  analysiscollab.ReadQueryState(row.QueryState),
			Visibility:  row.Visibility,
			CreatedAt:   analysiscollab.FormatISO(row.CreatedAt),
			UpdatedAt:   analysiscollab.FormatISO(row.UpdatedAt),
			CreatedBy:   createdBy,
			UpdatedBy:   updatedBy,
			CanEdit:     actor.CanManageOwned(row.CreatedByID),
		})
	}
	return out, nil
}

func presentOne(ctx context.Context, q analysiscollab.Querier, row viewRow, actor analysiscollab.Actor) (analysiscollab.SavedView, error) {
	views, err := presentViews(ctx, q, []viewRow{row}, actor)
	if err != nil {
		return analysiscollab.SavedView{}, err
	}
	return views[0], nil
}

func queryStringInput(body analysiscollab.Body) string {
	if body.Has("queryString") && !body.Null("queryString") {
		return body.String("queryString")
	}
	return ""
}

func createVisibility(body analysiscollab.Body) string {
	if body.Has("visibility") && !body.Null("visibility") {
		return body.String("visibility")
	}
	return analysiscollab.VisibilityPrivate
}
