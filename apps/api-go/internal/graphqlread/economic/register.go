// Package economic serves the global economic-data GraphQL read roots.
// Rows are not org-scoped; authorization is the root permission only.
package economic

import (
	"database/sql"
	"net/http"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// Register wires the six economic Query roots and their object types.
func Register(reg *contract.Registry, db *sql.DB) {
	if reg == nil {
		panic("economic: nil registry")
	}
	reg.RegisterType("EconomicDataPointModel", EconomicDataPointModel{})
	reg.RegisterType("EconomicDataItemModel", EconomicDataItemModel{})
	reg.RegisterType("EconomicDataWithInsightsModel", EconomicDataWithInsightsModel{})
	reg.RegisterType("EconomicSeriesInsightModel", EconomicSeriesInsightModel{})
	reg.RegisterType("PaginatedEconomicDataPointsModel", PaginatedEconomicDataPointsModel{})
	reg.RegisterType("PaginationMetaModel", PaginationMetaModel{})
	reg.RegisterType("EconomicDataFetchConfigModel", EconomicDataFetchConfigModel{})
	reg.RegisterType("EconomicDataRefreshPresetStatusModel", EconomicDataRefreshPresetStatusModel{})

	reader := &reader{db: db}
	reg.RegisterRoot(contract.Root{
		Name:       "getEconomicData",
		Permission: "economicdata.read",
		Resolve:    reader.getEconomicData,
	})
	reg.RegisterRoot(contract.Root{
		Name:       "getEconomicDataWithInsights",
		Permission: "economicdata.read",
		Resolve:    reader.getEconomicDataWithInsights,
	})
	reg.RegisterRoot(contract.Root{
		Name:       "getEconomicDataInsights",
		Permission: "economicdata.read",
		Resolve:    reader.getEconomicDataInsights,
	})
	reg.RegisterRoot(contract.Root{
		Name:       "getEconomicDataPaginated",
		Permission: "economicdata.read",
		Resolve:    reader.getEconomicDataPaginated,
	})
	reg.RegisterRoot(contract.Root{
		Name:       "economicDataFetchConfigs",
		Permission: "economicdata.manage",
		Resolve:    reader.economicDataFetchConfigs,
	})
	reg.RegisterRoot(contract.Root{
		Name:       "economicDataRefreshPresetStatus",
		Permission: "economicdata.manage",
		Resolve:    reader.economicDataRefreshPresetStatus,
	})
}

// getEconomicData labels every point with the applied granularity, which is the
// request or the range default. The reader still buckets each series at the
// coarser of that granularity and the item frequency. WithInsights and the
// paginated root report that coarser value. Insights and paginated do not
// invent a granularity when the argument is omitted.
func (r *reader) getEconomicData(call contract.Context) (any, error) {
	result, applied, err := r.loadSeries(call, true, false)
	if err != nil {
		return nil, err
	}
	return mapPoints(result.points, applied, false), nil
}

func (r *reader) getEconomicDataWithInsights(call contract.Context) (any, error) {
	result, applied, err := r.loadSeries(call, true, false)
	if err != nil {
		return nil, err
	}
	return EconomicDataWithInsightsModel{
		Points:   mapPoints(result.points, applied, true),
		Insights: insightsFromDataPoints(result.points),
	}, nil
}

func (r *reader) getEconomicDataInsights(call contract.Context) (any, error) {
	result, _, err := r.loadSeries(call, false, false)
	if err != nil {
		return nil, err
	}
	return insightsFromDataPoints(result.points), nil
}

func (r *reader) getEconomicDataPaginated(call contract.Context) (any, error) {
	result, requested, err := r.loadSeries(call, false, true)
	if err != nil {
		return nil, err
	}
	return PaginatedEconomicDataPointsModel{
		Data: mapPoints(result.points, requested, true),
		Pagination: PaginationMetaModel{
			HasMore:    result.hasMore,
			NextCursor: result.nextCursor,
			TotalCount: result.totalCount,
		},
	}, nil
}

func (r *reader) economicDataFetchConfigs(call contract.Context) (any, error) {
	return r.listFetchConfigs(call.Ctx)
}

func (r *reader) economicDataRefreshPresetStatus(call contract.Context) (any, error) {
	preset, _ := contract.StringArg(call.Args, "preset")
	return r.presetStatus(call.Ctx, preset)
}

func (r *reader) loadSeries(call contract.Context, fillGranularity, paginate bool) (loadResult, string, error) {
	category, ok := contract.StringArg(call.Args, "category")
	if !ok {
		return loadResult{}, "", failure(http.StatusBadRequest, "category is required")
	}
	start, end, err := timeRange(call.Args)
	if err != nil {
		return loadResult{}, "", err
	}
	granularity, set, err := granularityArg(call.Args)
	if err != nil {
		return loadResult{}, "", err
	}
	if fillGranularity && !set {
		granularity = granularityForRange(start, end)
		set = true
	}
	if !set {
		granularity = ""
	}
	req := loadRequest{
		category:    category,
		start:       start,
		end:         end,
		granularity: granularity,
	}
	if paginate {
		page, err := paginationArg(call.Args)
		if err != nil {
			return loadResult{}, "", err
		}
		req.paginate = true
		req.cursor = page.cursor
		req.limit = page.limit
	}
	result, err := r.load(call.Ctx, req)
	return result, granularity, err
}

func mapPoints(points []dataPoint, requested string, perSeries bool) []EconomicDataPointModel {
	out := make([]EconomicDataPointModel, 0, len(points))
	for _, point := range points {
		label := requested
		if perSeries {
			label = resolveEffectiveGranularity(requested, point.item.defaultFrequency)
		}
		out = append(out, mapPoint(point, label))
	}
	return out
}

func mapPoint(point dataPoint, effective string) EconomicDataPointModel {
	var unit *string
	if point.unit.Valid {
		unit = stringPtr(point.unit.String)
	}
	var source *string
	if point.sourceField.Valid {
		source = stringPtr(point.sourceField.String)
	}
	return EconomicDataPointModel{
		Timestamp:            point.recordedAt,
		EffectiveGranularity: effective,
		Value:                point.value,
		Unit:                 unit,
		SourceField:          source,
		DataType:             point.dataType,
		Item:                 point.item.model(),
	}
}

type pageArgs struct {
	cursor string
	limit  int
}

func paginationArg(args map[string]any) (pageArgs, error) {
	out := pageArgs{limit: defaultPageLimit}
	raw, state := contract.Lookup(args, "pagination")
	if state != contract.ArgValue {
		return out, nil
	}
	object, ok := raw.(map[string]any)
	if !ok {
		return pageArgs{}, failure(http.StatusBadRequest, "pagination must be an object")
	}
	if cursor, state := contract.Lookup(object, "cursor"); state == contract.ArgValue {
		if text, ok := cursor.(string); ok {
			out.cursor = text
		}
	}
	if limit, state := contract.Lookup(object, "limit"); state == contract.ArgValue {
		number, ok := contract.AsInt(limit)
		if !ok {
			return pageArgs{}, failure(http.StatusBadRequest, "pagination.limit must be an integer")
		}
		if number > maxPageLimit {
			number = maxPageLimit
		}
		out.limit = number
	}
	return out, nil
}

func granularityArg(args map[string]any) (string, bool, error) {
	raw, state := contract.Lookup(args, "granularity")
	if state != contract.ArgValue {
		return "", false, nil
	}
	text, ok := raw.(string)
	if !ok || text == "" {
		return "", false, failure(http.StatusBadRequest, "granularity must be a TimeGranularity")
	}
	return text, true, nil
}

func timeRange(args map[string]any) (start, end time.Time, err error) {
	raw, state := contract.Lookup(args, "timeRange")
	if state != contract.ArgValue {
		return time.Time{}, time.Time{}, failure(http.StatusBadRequest, "timeRange is required")
	}
	object, ok := raw.(map[string]any)
	if !ok {
		return time.Time{}, time.Time{}, failure(http.StatusBadRequest, "timeRange is required")
	}
	start, err = requiredDate(object, "start")
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	end, err = requiredDate(object, "end")
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	return start, end, nil
}

func requiredDate(object map[string]any, name string) (time.Time, error) {
	raw, state := contract.Lookup(object, name)
	if state != contract.ArgValue {
		return time.Time{}, failure(http.StatusBadRequest, "Invalid date")
	}
	text, ok := raw.(string)
	if !ok {
		return time.Time{}, failure(http.StatusBadRequest, "Invalid date")
	}
	parsed, ok := parseDateTime(text)
	if !ok {
		return time.Time{}, failure(http.StatusBadRequest, "Invalid date: "+text)
	}
	return parsed, nil
}

func failure(status int, message string) error {
	return &contract.Failure{Status: status, Message: message}
}
