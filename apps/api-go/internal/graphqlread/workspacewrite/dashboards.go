package workspacewrite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/workspace"
)

const dashboardSelect = "SELECT `id`, `version`, `name`, `slug`, `description`, `theme`, `config`, `createdAt`, `updatedAt` " +
	"FROM `Dashboard` WHERE `id` = ? AND `orgId` = ? LIMIT 1"

const dashboardWidgetSelect = "SELECT `id`, `title`, `type`, `dataSource`, `dataConfig`, `layoutX`, `layoutY`, " +
	"`layoutW`, `layoutH`, `sortOrder`, `options` FROM `DashboardWidget` WHERE `dashboardId` = ? ORDER BY `sortOrder` ASC"

// dashboardWidgetRecord is one DashboardWidget row loaded for the diff.
type dashboardWidgetRecord struct {
	ID         string
	Title      *string
	Type       string
	DataSource string
	DataConfig json.RawMessage
	LayoutX    int
	LayoutY    int
	LayoutW    int
	LayoutH    int
	SortOrder  int
	Options    json.RawMessage
}

// widgetWrite is the normalized field set one widget write applies.
type widgetWrite struct {
	ID         string
	Title      *string
	TitleSet   bool
	Type       string
	DataSource string
	DataConfig json.RawMessage
	LayoutX    int
	LayoutY    int
	LayoutW    int
	LayoutH    int
	SortOrder  int
	Options    json.RawMessage
}

// widgetPlan is the create/update/delete plan for one dashboard save.
type widgetPlan struct {
	Create []widgetWrite
	Update []widgetWrite
	Delete []string
}

// planWidgetWrites mirrors DashboardService.upsertDashboard's widget handling
// and adds the changed-widget filter: an existing widget whose normalized
// target fields equal the stored row is left out of Update, so the save skips
// the UPDATE entirely and keeps the stored updatedAt.
//
// An input id that is not on the dashboard is reported as "Widget not found on
// dashboard". Existing widgets the input does not mention are deleted. JSON
// comparisons ignore object key order and keep array order significant.
func planWidgetWrites(existing []dashboardWidgetRecord, inputs []dashboardWidgetInput) (widgetPlan, error) {
	index := make(map[string]dashboardWidgetRecord, len(existing))
	for _, record := range existing {
		index[record.ID] = record
	}
	seen := make(map[string]struct{}, len(inputs))
	plan := widgetPlan{Create: []widgetWrite{}, Update: []widgetWrite{}, Delete: []string{}}
	for position, input := range inputs {
		sortOrder := position
		if input.SortOrder != nil {
			sortOrder = *input.SortOrder
		}
		write := widgetWrite{
			Title:      input.Title,
			TitleSet:   input.TitleSet,
			Type:       input.Type,
			DataSource: input.DataSource,
			DataConfig: input.DataConfig,
			LayoutX:    input.LayoutX,
			LayoutY:    input.LayoutY,
			LayoutW:    input.LayoutW,
			LayoutH:    input.LayoutH,
			SortOrder:  sortOrder,
			Options:    input.Options,
		}
		if input.ID == nil || *input.ID == "" {
			plan.Create = append(plan.Create, write)
			continue
		}
		record, ok := index[*input.ID]
		if !ok {
			return widgetPlan{}, badRequest("Widget not found on dashboard")
		}
		seen[*input.ID] = struct{}{}
		if widgetChanged(record, write) {
			write.ID = *input.ID
			plan.Update = append(plan.Update, write)
		}
	}
	for _, record := range existing {
		if _, ok := seen[record.ID]; !ok {
			plan.Delete = append(plan.Delete, record.ID)
		}
	}
	return plan, nil
}

// widgetChanged reports whether the write would change the stored row.
func widgetChanged(record dashboardWidgetRecord, write widgetWrite) bool {
	if write.TitleSet {
		if (write.Title == nil) != (record.Title == nil) {
			return true
		}
		if write.Title != nil && *write.Title != *record.Title {
			return true
		}
	}
	if write.Type != record.Type || write.DataSource != record.DataSource {
		return true
	}
	if write.LayoutX != record.LayoutX || write.LayoutY != record.LayoutY ||
		write.LayoutW != record.LayoutW || write.LayoutH != record.LayoutH ||
		write.SortOrder != record.SortOrder {
		return true
	}
	if !jsonEqual(write.DataConfig, record.DataConfig) {
		return true
	}
	return !jsonEqual(write.Options, record.Options)
}

// upsertDashboard creates or updates one dashboard and its widgets inside a
// single MySQL transaction.
//
// The optimistic version check is preserved: an unknown id or a dashboard of
// another organization is "Dashboard not found" (404), an update without a
// version is "Dashboard version is required for update" (400), and a version
// mismatch is the conflict (409) raised before any widget is written. The
// dashboard row is resolved through its own id + orgId + version, then the
// widget plan is applied: batch create, changed-only update, set delete.
func (s *service) upsertDashboard(ctx contract.Context, input upsertDashboardInput) (workspace.DashboardModel, error) {
	if s == nil || s.db == nil {
		return workspace.DashboardModel{}, errDatabaseUnavailable
	}
	callCtx := callContext(ctx)
	orgID := ctx.Identity.OrgID
	now := nowMillis()
	configText, err := jsonText(input.Config)
	if err != nil {
		return workspace.DashboardModel{}, err
	}

	tx, err := s.db.BeginTx(callCtx, nil)
	if err != nil {
		return workspace.DashboardModel{}, err
	}
	defer func() { _ = tx.Rollback() }()

	dashboardID := ""
	existingWidgets := []dashboardWidgetRecord{}
	if input.ID != nil && *input.ID != "" {
		dashboardID = *input.ID
		var version int
		err := tx.QueryRowContext(callCtx, "SELECT `version` FROM `Dashboard` WHERE `id` = ? AND `orgId` = ? LIMIT 1",
			dashboardID, orgID).Scan(&version)
		if errors.Is(err, sql.ErrNoRows) {
			return workspace.DashboardModel{}, notFound("Dashboard not found")
		}
		if err != nil {
			return workspace.DashboardModel{}, err
		}
		if input.Version == nil {
			return workspace.DashboardModel{}, badRequest("Dashboard version is required for update")
		}
		existingWidgets, err = loadDashboardWidgets(callCtx, tx, dashboardID)
		if err != nil {
			return workspace.DashboardModel{}, err
		}

		assignments := []string{"`name` = ?", "`slug` = ?"}
		args := []any{input.Name, input.Slug}
		if input.DescSet {
			assignments = append(assignments, "`description` = ?")
			args = append(args, sqlNullableString(input.Description))
		}
		if input.ThemeSet {
			assignments = append(assignments, "`theme` = ?")
			args = append(args, sqlNullableString(input.Theme))
		}
		assignments = append(assignments, "`config` = CAST(? AS JSON)", "`createdById` = ?", "`version` = `version` + 1", "`updatedAt` = ?")
		args = append(args, configText, sqlNullableString(userIDPtr(ctx.Identity.UserID)), now, dashboardID, orgID, *input.Version)
		result, err := tx.ExecContext(callCtx,
			"UPDATE `Dashboard` SET "+strings.Join(assignments, ", ")+" WHERE `id` = ? AND `orgId` = ? AND `version` = ?", args...)
		if err != nil {
			return workspace.DashboardModel{}, err
		}
		changed, err := result.RowsAffected()
		if err != nil {
			return workspace.DashboardModel{}, err
		}
		if changed != 1 {
			return workspace.DashboardModel{}, conflict("Dashboard has been updated by another user. Please refresh and retry.")
		}
	} else {
		dashboardID, err = newRowID()
		if err != nil {
			return workspace.DashboardModel{}, err
		}
		if _, err := tx.ExecContext(callCtx,
			"INSERT INTO `Dashboard` (`id`, `orgId`, `name`, `slug`, `description`, `theme`, `config`, `createdById`, `version`, `createdAt`, `updatedAt`) "+
				"VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, 1, ?, ?)",
			dashboardID, orgID, input.Name, input.Slug, sqlNullableString(input.Description), sqlNullableString(input.Theme),
			configText, sqlNullableString(userIDPtr(ctx.Identity.UserID)), now, now); err != nil {
			return workspace.DashboardModel{}, err
		}
	}

	plan, err := planWidgetWrites(existingWidgets, input.Widgets)
	if err != nil {
		return workspace.DashboardModel{}, err
	}
	if err := applyWidgetPlan(callCtx, tx, dashboardID, plan, now); err != nil {
		return workspace.DashboardModel{}, err
	}
	if err := tx.Commit(); err != nil {
		return workspace.DashboardModel{}, err
	}
	model, err := s.loadDashboard(callCtx, orgID, dashboardID)
	if err != nil {
		return workspace.DashboardModel{}, err
	}
	if model == nil {
		return workspace.DashboardModel{}, errors.New("workspacewrite: saved dashboard could not be reloaded")
	}
	return *model, nil
}

// applyWidgetPlan runs the planned widget writes inside the caller's
// transaction: set delete, changed-only updates, then one batch insert.
func applyWidgetPlan(ctx context.Context, tx *sql.Tx, dashboardID string, plan widgetPlan, now time.Time) error {
	if len(plan.Delete) > 0 {
		args := make([]any, 0, len(plan.Delete)+1)
		args = append(args, dashboardID)
		for _, id := range plan.Delete {
			args = append(args, id)
		}
		if _, err := tx.ExecContext(ctx,
			"DELETE FROM `DashboardWidget` WHERE `dashboardId` = ? AND `id` IN ("+placeholders(len(plan.Delete))+")", args...); err != nil {
			return err
		}
	}
	for _, write := range plan.Update {
		dataConfig, err := jsonText(write.DataConfig)
		if err != nil {
			return err
		}
		options, err := jsonText(write.Options)
		if err != nil {
			return err
		}
		assignments := []string{"`type` = ?", "`dataSource` = ?", "`dataConfig` = CAST(? AS JSON)"}
		args := []any{write.Type, write.DataSource, dataConfig}
		assignments = append(assignments, "`layoutX` = ?", "`layoutY` = ?", "`layoutW` = ?", "`layoutH` = ?", "`sortOrder` = ?")
		args = append(args, write.LayoutX, write.LayoutY, write.LayoutW, write.LayoutH, write.SortOrder)
		assignments = append(assignments, "`options` = CAST(? AS JSON)")
		args = append(args, options)
		if write.TitleSet {
			assignments = append(assignments, "`title` = ?")
			args = append(args, sqlNullableString(write.Title))
		}
		assignments = append(assignments, "`updatedAt` = ?")
		args = append(args, now, write.ID, dashboardID)
		if _, err := tx.ExecContext(ctx,
			"UPDATE `DashboardWidget` SET "+strings.Join(assignments, ", ")+" WHERE `id` = ? AND `dashboardId` = ?", args...); err != nil {
			return err
		}
	}
	if len(plan.Create) == 0 {
		return nil
	}
	rows := make([]string, 0, len(plan.Create))
	args := make([]any, 0, len(plan.Create)*14)
	for _, write := range plan.Create {
		id, err := newRowID()
		if err != nil {
			return err
		}
		dataConfig, err := jsonText(write.DataConfig)
		if err != nil {
			return err
		}
		options, err := jsonText(write.Options)
		if err != nil {
			return err
		}
		rows = append(rows, "(?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?)")
		args = append(args, id, dashboardID, sqlNullableString(write.Title), write.Type, write.DataSource, dataConfig,
			write.LayoutX, write.LayoutY, write.LayoutW, write.LayoutH, write.SortOrder, options, now, now)
	}
	_, err := tx.ExecContext(ctx,
		"INSERT INTO `DashboardWidget` (`id`, `dashboardId`, `title`, `type`, `dataSource`, `dataConfig`, `layoutX`, `layoutY`, "+
			"`layoutW`, `layoutH`, `sortOrder`, `options`, `createdAt`, `updatedAt`) VALUES "+strings.Join(rows, ", "), args...)
	return err
}

// loadDashboardWidgets reads the dashboard's widgets in sortOrder ascending
// order for the diff.
func loadDashboardWidgets(ctx context.Context, q dbtx, dashboardID string) ([]dashboardWidgetRecord, error) {
	rows, err := q.QueryContext(ctx,
		"SELECT `id`, `title`, `type`, `dataSource`, `dataConfig`, `layoutX`, `layoutY`, `layoutW`, `layoutH`, `sortOrder`, `options` "+
			"FROM `DashboardWidget` WHERE `dashboardId` = ? ORDER BY `sortOrder` ASC", dashboardID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := make([]dashboardWidgetRecord, 0)
	for rows.Next() {
		var (
			record              dashboardWidgetRecord
			title               sql.NullString
			dataConfig, options []byte
		)
		if err := rows.Scan(&record.ID, &title, &record.Type, &record.DataSource, &dataConfig,
			&record.LayoutX, &record.LayoutY, &record.LayoutW, &record.LayoutH, &record.SortOrder, &options); err != nil {
			return nil, err
		}
		record.Title = nullStringPtr(title)
		record.DataConfig = json.RawMessage(dataConfig)
		record.Options = json.RawMessage(options)
		records = append(records, record)
	}
	return records, rows.Err()
}

// loadDashboard reads the dashboard and its widgets as the GraphQL model. A
// dashboard of another organization is reported as absent.
func (s *service) loadDashboard(ctx context.Context, orgID, dashboardID string) (*workspace.DashboardModel, error) {
	var (
		model                workspace.DashboardModel
		description, theme   sql.NullString
		config               []byte
		createdAt, updatedAt time.Time
	)
	err := s.db.QueryRowContext(ctx, dashboardSelect, dashboardID, orgID).Scan(
		&model.ID, &model.Version, &model.Name, &model.Slug, &description, &theme, &config, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	model.Description = nullStringPtr(description)
	model.Theme = nullStringPtr(theme)
	model.Config = jsonScalar(config)
	model.CreatedAt = createdAt.UTC()
	model.UpdatedAt = updatedAt.UTC()

	widgets, err := loadDashboardWidgetModels(ctx, s.db, dashboardID)
	if err != nil {
		return nil, err
	}
	model.Widgets = widgets
	return &model, nil
}

// loadDashboardWidgetModels reads the widgets as the GraphQL models, in
// sortOrder ascending order.
func loadDashboardWidgetModels(ctx context.Context, q dbtx, dashboardID string) ([]workspace.DashboardWidgetModel, error) {
	rows, err := q.QueryContext(ctx, dashboardWidgetSelect, dashboardID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	widgets := make([]workspace.DashboardWidgetModel, 0)
	for rows.Next() {
		var (
			widget              workspace.DashboardWidgetModel
			title               sql.NullString
			dataConfig, options []byte
			layoutX, layoutY    int
			layoutW, layoutH    int
			sortOrder           int
		)
		if err := rows.Scan(&widget.ID, &title, &widget.Type, &widget.DataSource, &dataConfig,
			&layoutX, &layoutY, &layoutW, &layoutH, &sortOrder, &options); err != nil {
			return nil, err
		}
		widget.Title = nullStringPtr(title)
		widget.DataConfig = jsonScalar(dataConfig)
		widget.Options = jsonScalar(options)
		widget.LayoutX = float64(layoutX)
		widget.LayoutY = float64(layoutY)
		widget.LayoutW = float64(layoutW)
		widget.LayoutH = float64(layoutH)
		widget.SortOrder = float64(sortOrder)
		widgets = append(widgets, widget)
	}
	return widgets, rows.Err()
}

// deleteDashboard removes one dashboard of the caller's organization. A missing
// or cross-organization id is reported as false. Widgets are removed by the
// DashboardWidget cascade; no other product object is touched.
func (s *service) deleteDashboard(ctx context.Context, orgID, id string) (bool, error) {
	if s == nil || s.db == nil {
		return false, errDatabaseUnavailable
	}
	var existing string
	err := s.db.QueryRowContext(ctx, "SELECT `id` FROM `Dashboard` WHERE `id` = ? AND `orgId` = ? LIMIT 1", id, orgID).Scan(&existing)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if _, err := s.db.ExecContext(ctx, "DELETE FROM `Dashboard` WHERE `id` = ? AND `orgId` = ?", id, orgID); err != nil {
		return false, err
	}
	return true, nil
}

// upsertDashboardResolver returns the complete saved dashboard model.
func (s *service) upsertDashboardResolver(ctx contract.Context) (workspace.DashboardModel, error) {
	input, err := parseUpsertDashboardInput(ctx.Args)
	if err == nil {
		var model workspace.DashboardModel
		if model, err = s.upsertDashboard(ctx, input); err == nil {
			return model, nil
		}
	}
	return workspace.DashboardModel{}, graphqlFailure(err)
}

// deleteDashboardResolver reads the id argument and reports whether a row was
// removed.
func (s *service) deleteDashboardResolver(ctx contract.Context) (bool, error) {
	id, err := requiredStringArg(ctx.Args, "id")
	if err == nil {
		var deleted bool
		if deleted, err = s.deleteDashboard(callContext(ctx), ctx.Identity.OrgID, id); err == nil {
			return deleted, nil
		}
	}
	return false, graphqlFailure(err)
}

// userIDPtr converts a non-empty identity user id to the nullable createdById
// parameter. The value is the real requester identity and is never derived from
// the mutation input.
func userIDPtr(userID string) *string {
	if userID == "" {
		return nil
	}
	return &userID
}
