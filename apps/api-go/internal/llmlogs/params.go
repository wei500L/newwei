package llmlogs

import (
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// 与 apps/api/src/modules/news-pipeline/llm-request-log.controller.ts 和
// llm-request-log.service.ts 保持一致的常量。
const (
	defaultPage     = 1
	defaultPageSize = 20
	maxPageSize     = 100
	unknownOrgID    = "_unknown_"
)

// featureTokenPattern 与 service 的 normalizeFeatureToken 和控制器的
// normalizeFeature 使用的是同一个字符集。
var featureTokenPattern = regexp.MustCompile(`^[a-z0-9_:\-.]+$`)

// dateLayouts 是 parseDateQuery 接受的输入形态（ISO 8601；带时区、不带
// 时区、只有日期）。JS 的 new Date(value) 比这宽松（还接受 RFC 1123、
// 斜杠分隔等），本迁移只承诺文档里的 ISO 8601 形态与仅日期形态。
var dateLayouts = []string{
	time.RFC3339Nano,
	"2006-01-02T15:04:05.999999999",
	"2006-01-02T15:04:05",
	"2006-01-02 15:04:05",
	"2006-01-02",
}

// logFilter 是列表/导出的过滤条件。空字符串表示「该条件不参与过滤」，
// 与控制器 undefined 的语义一致。
type logFilter struct {
	OrgID       string
	Model       string
	Feature     string
	ProfileID   string
	RunID       string
	NodeID      string
	RequestType string
	Status      string
	Start       *time.Time
	End         *time.Time
}

// summaryFilter 只有 feature、profileId、runId、nodeId、start、end
// ——控制器不接收 model、requestType、status。
type summaryFilter struct {
	OrgID     string
	Feature   string
	ProfileID string
	RunID     string
	NodeID    string
	Start     *time.Time
	End       *time.Time
}

// parseListFilter 与控制器 list/export 的参数解析完全一致（参数与顺序：
// model、feature、profileId、runId、nodeId、requestType、status、
// start、end）。
func parseListFilter(values url.Values, orgID string) (logFilter, error) {
	start, end, err := parseDateRange(values)
	if err != nil {
		return logFilter{}, err
	}
	feature, err := normalizeFeature(values.Get("feature"))
	if err != nil {
		return logFilter{}, err
	}
	profileID, err := normalizeProfileID(values.Get("profileId"))
	if err != nil {
		return logFilter{}, err
	}
	runID, err := normalizeEntityID(values.Get("runId"), "runId")
	if err != nil {
		return logFilter{}, err
	}
	nodeID, err := normalizeEntityID(values.Get("nodeId"), "nodeId")
	if err != nil {
		return logFilter{}, err
	}
	requestType, err := normalizeRequestType(values.Get("requestType"))
	if err != nil {
		return logFilter{}, err
	}
	status, err := normalizeStatus(values.Get("status"))
	if err != nil {
		return logFilter{}, err
	}
	return logFilter{
		OrgID:       orgID,
		Model:       strings.TrimSpace(values.Get("model")),
		Feature:     feature,
		ProfileID:   profileID,
		RunID:       runID,
		NodeID:      nodeID,
		RequestType: requestType,
		Status:      status,
		Start:       start,
		End:         end,
	}, nil
}

// parseSummaryFilter 与控制器 summary 的参数解析一致。
func parseSummaryFilter(values url.Values, orgID string) (summaryFilter, error) {
	start, end, err := parseDateRange(values)
	if err != nil {
		return summaryFilter{}, err
	}
	feature, err := normalizeFeature(values.Get("feature"))
	if err != nil {
		return summaryFilter{}, err
	}
	profileID, err := normalizeProfileID(values.Get("profileId"))
	if err != nil {
		return summaryFilter{}, err
	}
	runID, err := normalizeEntityID(values.Get("runId"), "runId")
	if err != nil {
		return summaryFilter{}, err
	}
	nodeID, err := normalizeEntityID(values.Get("nodeId"), "nodeId")
	if err != nil {
		return summaryFilter{}, err
	}
	return summaryFilter{
		OrgID:     orgID,
		Feature:   feature,
		ProfileID: profileID,
		RunID:     runID,
		NodeID:    nodeID,
		Start:     start,
		End:       end,
	}, nil
}

// parsePagination 与 parsePositiveIntQuery 一致：空/空白取缺省值，
// 非正有限数 → 400，正小数用 Math.trunc。服务层再收口到 1..100。
func parsePagination(values url.Values) (int, int, error) {
	page, err := parsePositiveIntQuery(values, "page", defaultPage)
	if err != nil {
		return 0, 0, err
	}
	pageSize, err := parsePositiveIntQuery(values, "pageSize", defaultPageSize)
	if err != nil {
		return 0, 0, err
	}
	return page, pageSize, nil
}

func parseDateRange(values url.Values) (*time.Time, *time.Time, error) {
	start, err := parseDateQuery(values, "start")
	if err != nil {
		return nil, nil, err
	}
	end, err := parseDateQuery(values, "end")
	if err != nil {
		return nil, nil, err
	}
	if start != nil && end != nil && start.After(*end) {
		return nil, nil, &inputError{Message: "start must be earlier than or equal to end"}
	}
	return start, end, nil
}

func parseDateQuery(values url.Values, name string) (*time.Time, error) {
	raw := values.Get(name)
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	parsed, ok := parseDate(raw)
	if !ok {
		return nil, &inputError{Message: name + " must be a valid date"}
	}
	utc := parsed.UTC()
	return &utc, nil
}

func parseDate(value string) (time.Time, bool) {
	trimmed := strings.TrimSpace(value)
	for _, layout := range dateLayouts {
		if parsed, err := time.Parse(layout, trimmed); err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

func parsePositiveIntQuery(values url.Values, name string, fallback int) (int, error) {
	raw := values.Get(name)
	if strings.TrimSpace(raw) == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed <= 0 {
		return 0, &inputError{Message: name + " must be a positive number"}
	}
	return int(math.Trunc(parsed)), nil
}

func normalizeRequestType(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", nil
	}
	switch value {
	case "completion", "embedding", "rerank", "stream", "responses":
		return value, nil
	}
	return "", &inputError{Message: "requestType must be one of completion, embedding, rerank, stream, responses"}
}

func normalizeStatus(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", nil
	}
	if value == "success" || value == "error" {
		return value, nil
	}
	return "", &inputError{Message: "status must be one of success, error"}
}

func normalizeFeature(raw string) (string, error) {
	value := strings.ToLower(strings.TrimSpace(raw))
	if value == "" {
		return "", nil
	}
	if jsLength(value) > 64 || !featureTokenPattern.MatchString(value) {
		return "", &inputError{Message: "feature must be a lowercase token with [a-z0-9_:. -], max 64 chars"}
	}
	return value, nil
}

func normalizeProfileID(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", nil
	}
	if jsLength(value) > 128 {
		return "", &inputError{Message: "profileId must be 128 characters or fewer"}
	}
	return value, nil
}

func normalizeEntityID(raw, name string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", nil
	}
	if jsLength(value) > 128 {
		return "", &inputError{Message: name + " must be 128 characters or fewer"}
	}
	return value, nil
}

// jsLength 按 JS String.prototype.length 的语义计数（UTF-16 码元）：
// 增补平面字符算 2。
func jsLength(value string) int {
	count := 0
	for _, r := range value {
		if r > 0xFFFF {
			count += 2
			continue
		}
		count++
	}
	return count
}
