package dashboardwarmap

import (
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/dashboardcharts"
)

const defaultRangeDays = 30

type stringField struct {
	value string
	set   bool
	multi bool
}

func (f *stringField) add(value string) {
	if f.set {
		f.multi = true
		return
	}
	f.value = value
	f.set = true
}

type warQuery struct {
	start      stringField
	end        stringField
	translate  stringField
	bbox       stringField
	zoom       stringField
	cluster    stringField
	flightMode stringField
	aisMode    stringField
	unknown    []string
}

type viewOptions struct {
	Translate  bool
	BBox       *[4]float64
	Zoom       *float64
	Cluster    bool
	FlightMode string
	AisMode    string
}

func parseWarQuery(r *http.Request) warQuery {
	var query warQuery
	raw := r.URL.RawQuery
	if raw == "" {
		return query
	}
	seenUnknown := map[string]struct{}{}
	for _, part := range strings.Split(raw, "&") {
		if part == "" {
			continue
		}
		keyPart, valuePart, hasValue := strings.Cut(part, "=")
		key := decodeQueryComponent(keyPart)
		value := ""
		if hasValue {
			value = decodeQueryComponent(valuePart)
		}
		switch key {
		case "start":
			query.start.add(value)
		case "end":
			query.end.add(value)
		case "translate":
			query.translate.add(value)
		case "bbox":
			query.bbox.add(value)
		case "zoom":
			query.zoom.add(value)
		case "cluster":
			query.cluster.add(value)
		case "flightMode":
			query.flightMode.add(value)
		case "aisMode":
			query.aisMode.add(value)
		default:
			if key == "" {
				continue
			}
			if _, ok := seenUnknown[key]; ok {
				continue
			}
			seenUnknown[key] = struct{}{}
			query.unknown = append(query.unknown, key)
		}
	}
	return query
}

func decodeQueryComponent(value string) string {
	decoded, err := url.QueryUnescape(strings.ReplaceAll(value, "+", " "))
	if err != nil {
		return value
	}
	return decoded
}

func (q warQuery) validation() string {
	var parts []string
	if q.start.set && (q.start.multi || !dashboardcharts.ISO8601(q.start.value)) {
		parts = append(parts, "start must be a valid ISO 8601 date string")
	}
	if q.end.set && (q.end.multi || !dashboardcharts.ISO8601(q.end.value)) {
		parts = append(parts, "end must be a valid ISO 8601 date string")
	}
	if q.translate.multi {
		parts = append(parts, "translate must be a string")
	}
	if q.bbox.multi {
		parts = append(parts, "bbox must be a string")
	}
	if q.zoom.multi {
		parts = append(parts, "zoom must be a string")
	}
	if q.cluster.multi {
		parts = append(parts, "cluster must be a string")
	}
	if q.flightMode.multi {
		parts = append(parts, "flightMode must be a string")
	}
	if q.aisMode.multi {
		parts = append(parts, "aisMode must be a string")
	}
	for _, key := range q.unknown {
		parts = append(parts, "property "+key+" should not exist")
	}
	return strings.Join(parts, "; ")
}

// ResolveOpenRange 是 War Map 与 SSE 战争地图窗口，不按 UTC 整日对齐。
func ResolveOpenRange(start, end string, startSet, endSet bool, now time.Time) (time.Time, time.Time, string) {
	var query warQuery
	if startSet {
		query.start.add(start)
	}
	if endSet {
		query.end.add(end)
	}
	return resolveInstant(query, now)
}

// resolveInstant 对齐 alignToUtcDay: false。缺省 end 是现在，缺省 start 是 end 往前 30 天。
func resolveInstant(q warQuery, now time.Time) (time.Time, time.Time, string) {
	var end time.Time
	if !q.end.set {
		end = now
	} else {
		parsed, ok := dashboardcharts.ParseJSDate(q.end.value)
		if !ok {
			return time.Time{}, time.Time{}, "Invalid date range"
		}
		end = parsed
	}
	var start time.Time
	if !q.start.set {
		start = end.Add(-defaultRangeDays * 24 * time.Hour)
	} else {
		parsed, ok := dashboardcharts.ParseJSDate(q.start.value)
		if !ok {
			return time.Time{}, time.Time{}, "Invalid date range"
		}
		start = parsed
	}
	if start.After(end) {
		return time.Time{}, time.Time{}, "Start must be before end"
	}
	return start, end, ""
}

func (q warQuery) view() viewOptions {
	opt := viewOptions{Translate: parseTranslate(q.translate.value), Cluster: parseCluster(q.cluster.value)}
	if q.bbox.set {
		if box, ok := parseBBox(q.bbox.value); ok {
			opt.BBox = &box
		}
	}
	if q.zoom.set {
		if zoom, ok := parseZoom(q.zoom.value); ok {
			opt.Zoom = &zoom
		}
	}
	return opt
}

func parseTranslate(value string) bool {
	normalized := strings.ToLower(strings.TrimSpace(value))
	return normalized == "zh-cn" || normalized == "zh"
}

func parseCluster(value string) bool {
	normalized := strings.ToLower(strings.TrimSpace(value))
	return normalized == "1" || normalized == "true" || normalized == "yes"
}

// ParseBBox 解析 minLng,minLat,maxLng,maxLat。非法范围返回 false，调用方省略该参数。
func ParseBBox(value string) ([4]float64, bool) {
	return parseBBox(value)
}

// ParseZoom 把缩放钳到 0.50–18.00，步长 0.01。
func ParseZoom(value string) (float64, bool) {
	return parseZoom(value)
}

func parseBBox(value string) ([4]float64, bool) {
	if strings.TrimSpace(value) == "" && !strings.Contains(value, ",") {
		return [4]float64{}, false
	}
	parts := strings.Split(value, ",")
	nums := make([]float64, 0, len(parts))
	for _, part := range parts {
		n, ok := parseFloatJS(part)
		if !ok {
			continue
		}
		nums = append(nums, n)
	}
	if len(nums) != 4 {
		return [4]float64{}, false
	}
	minLng, minLat, maxLng, maxLat := nums[0], nums[1], nums[2], nums[3]
	if minLng < -180 || maxLng > 180 || minLat < -90 || maxLat > 90 || minLng > maxLng || minLat > maxLat {
		return [4]float64{}, false
	}
	return [4]float64{minLng, minLat, maxLng, maxLat}, true
}

func parseZoom(value string) (float64, bool) {
	if value == "" {
		return 0, false
	}
	parsed, ok := parseFloatJS(value)
	if !ok {
		return 0, false
	}
	scaled := math.Round(parsed * 100)
	if scaled < 50 {
		scaled = 50
	}
	if scaled > 1800 {
		scaled = 1800
	}
	return scaled / 100, true
}

func parseFloatJS(value string) (float64, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, false
	}
	i := 0
	if value[0] == '+' || value[0] == '-' {
		i++
	}
	start := 0
	sawDigit := false
	sawDot := false
	for i < len(value) {
		ch := value[i]
		if ch >= '0' && ch <= '9' {
			sawDigit = true
			i++
			continue
		}
		if ch == '.' && !sawDot {
			sawDot = true
			i++
			continue
		}
		if (ch == 'e' || ch == 'E') && sawDigit {
			j := i + 1
			if j < len(value) && (value[j] == '+' || value[j] == '-') {
				j++
			}
			exp := j
			for exp < len(value) && value[exp] >= '0' && value[exp] <= '9' {
				exp++
			}
			if exp > j {
				i = exp
			}
		}
		break
	}
	if !sawDigit {
		return 0, false
	}
	n, err := strconv.ParseFloat(value[start:i], 64)
	if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
		return 0, false
	}
	return n, true
}
