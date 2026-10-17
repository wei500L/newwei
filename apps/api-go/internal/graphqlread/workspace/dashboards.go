package workspace

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// dashboards implements the dashboards root: the organization's dashboards in
// creation order, each with its widgets sorted by sortOrder ascending.
func (s *service) dashboards(ctx contract.Context) ([]DashboardModel, error) {
	if s == nil || s.db == nil {
		return nil, errDatabaseUnavailable
	}
	callCtx := s.call(ctx)
	rows, err := s.db.QueryContext(callCtx,
		"SELECT id, version, name, slug, description, theme, config, createdAt, updatedAt "+
			"FROM Dashboard WHERE orgId = ? ORDER BY createdAt ASC", ctx.Identity.OrgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	dashboards := make([]DashboardModel, 0)
	dashboardIDs := make([]string, 0)
	for rows.Next() {
		var dashboard DashboardModel
		var description, theme sql.NullString
		var config []byte
		if err := rows.Scan(&dashboard.ID, &dashboard.Version, &dashboard.Name, &dashboard.Slug,
			&description, &theme, &config, &dashboard.CreatedAt, &dashboard.UpdatedAt); err != nil {
			return nil, err
		}
		dashboard.CreatedAt = utcTime(dashboard.CreatedAt)
		dashboard.UpdatedAt = utcTime(dashboard.UpdatedAt)
		dashboard.Description = nullStringPtr(description)
		dashboard.Theme = nullStringPtr(theme)
		dashboard.Config = jsonScalar(config)
		dashboard.Widgets = []DashboardWidgetModel{}
		dashboards = append(dashboards, dashboard)
		dashboardIDs = append(dashboardIDs, dashboard.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(dashboards) == 0 {
		return dashboards, nil
	}
	widgets, err := s.loadDashboardWidgets(callCtx, dashboardIDs)
	if err != nil {
		return nil, err
	}
	for index := range dashboards {
		if list, ok := widgets[dashboards[index].ID]; ok {
			dashboards[index].Widgets = list
		}
	}
	return dashboards, nil
}

// loadDashboardWidgets loads the widgets of the given dashboards in
// sortOrder ascending order, keyed by dashboard id.
func (s *service) loadDashboardWidgets(ctx context.Context, dashboardIDs []string) (map[string][]DashboardWidgetModel, error) {
	out := make(map[string][]DashboardWidgetModel, len(dashboardIDs))
	list, ok := sqlIDList(dashboardIDs)
	if !ok {
		return out, nil
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT dashboardId, id, title, type, dataSource, dataConfig, layoutX, layoutY, layoutW, layoutH, sortOrder, options "+
			"FROM DashboardWidget WHERE dashboardId IN ("+list+") ORDER BY sortOrder ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var dashboardID string
		var widget DashboardWidgetModel
		var title sql.NullString
		var dataConfig, options []byte
		var layoutX, layoutY, layoutW, layoutH, sortOrder int
		if err := rows.Scan(&dashboardID, &widget.ID, &title, &widget.Type, &widget.DataSource,
			&dataConfig, &layoutX, &layoutY, &layoutW, &layoutH, &sortOrder, &options); err != nil {
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
		out[dashboardID] = append(out[dashboardID], widget)
	}
	return out, rows.Err()
}

// jsonScalar converts a nullable MySQL JSON column into a JSON scalar value.
// Empty and literal null columns become GraphQL null so the executor does not
// emit a quoted empty string.
func jsonScalar(raw []byte) *json.RawMessage {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil
	}
	message := json.RawMessage(append([]byte(nil), trimmed...))
	return &message
}
