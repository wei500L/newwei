package dashboardwarmap

import (
	"context"
	"math"
	"sort"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/wei500L/newwei/apps/api-go/internal/dashboardcharts"
)

const (
	transportStateCollection = "maptransportobjectstates"
	transportTrackCollection = "maptransporttrackpoints"
)

type transportReader interface {
	FindTransportState(ctx context.Context, orgID, kind, objectKey string) (map[string]any, bool, error)
	FindTransportTracks(ctx context.Context, orgID, kind, objectKey string, start, end *time.Time, limit int) ([]map[string]any, error)
}

type transportQuery struct {
	warQuery
	kind      stringField
	objectKey stringField
	limit     stringField
}

func parseTransportQuery(raw string) transportQuery {
	var query transportQuery
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
		case "kind":
			query.kind.add(value)
		case "objectKey":
			query.objectKey.add(value)
		case "limit":
			query.limit.add(value)
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

func (q transportQuery) validation() string {
	var parts []string
	if q.start.set && (q.start.multi || !dashboardcharts.ISO8601(q.start.value)) {
		parts = append(parts, "start must be a valid ISO 8601 date string")
	}
	if q.end.set && (q.end.multi || !dashboardcharts.ISO8601(q.end.value)) {
		parts = append(parts, "end must be a valid ISO 8601 date string")
	}
	if !q.kind.set || q.kind.multi {
		parts = append(parts, "kind must be a string")
	}
	if !q.objectKey.set || q.objectKey.multi {
		parts = append(parts, "objectKey must be a string")
	}
	if q.limit.multi {
		parts = append(parts, "limit must be a string")
	}
	for _, key := range q.unknown {
		parts = append(parts, "property "+key+" should not exist")
	}
	return strings.Join(parts, "; ")
}

func parseTransportKind(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "aircraft", "vessel":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return ""
	}
}

func parseTransportLimit(value string, set bool) int {
	if !set {
		return 20
	}
	parsed, ok := jsParseInt(value)
	if !ok {
		return 20
	}
	if parsed < 5 {
		return 5
	}
	if parsed > 50 {
		return 50
	}
	return parsed
}

func jsParseInt(value string) (int, bool) {
	value = strings.TrimLeft(value, " \t\n\r\v\f")
	if value == "" {
		return 0, false
	}
	sign := 1
	i := 0
	if value[0] == '+' || value[0] == '-' {
		if value[0] == '-' {
			sign = -1
		}
		i++
	}
	if i >= len(value) || value[i] < '0' || value[i] > '9' {
		return 0, false
	}
	n := 0
	for i < len(value) && value[i] >= '0' && value[i] <= '9' {
		n = n*10 + int(value[i]-'0')
		i++
	}
	return sign * n, true
}

func (s *Service) TransportDetail(ctx context.Context, orgID, kind, objectKey string, start, end time.Time, limit int) (map[string]any, error) {
	objectKey = strings.TrimSpace(objectKey)
	if objectKey == "" {
		return nil, errTransportKey
	}
	if s.tracks == nil {
		return nil, errMongoUnavailable
	}
	state, ok, err := s.tracks.FindTransportState(ctx, orgID, kind, objectKey)
	if err != nil {
		return nil, err
	}
	if !ok {
		return map[string]any{"detail": nil}, nil
	}
	ranged, err := s.tracks.FindTransportTracks(ctx, orgID, kind, objectKey, &start, &end, limit)
	if err != nil {
		return nil, err
	}
	docs := ranged
	if len(docs) == 0 {
		docs, err = s.tracks.FindTransportTracks(ctx, orgID, kind, objectKey, nil, nil, limit)
		if err != nil {
			return nil, err
		}
	}
	points := make([]any, 0, len(docs))
	for _, doc := range docs {
		points = append(points, transportPoint(doc))
	}
	detail := map[string]any{
		"kind":        kind,
		"objectKey":   objectKey,
		"title":       transportTitle(kind, objectKey, state),
		"latestState": transportLatest(state),
		"trackPoints": points,
		"summary":     transportSummary(docs),
	}
	if subtitle := transportSubtitle(kind, state); subtitle != "" {
		detail["subtitle"] = subtitle
	}
	return map[string]any{"detail": detail}, nil
}

var errTransportKey = errString("Transport objectKey is required")

func transportTitle(kind, objectKey string, state map[string]any) string {
	if kind == "aircraft" {
		if value := cleanString(state["callsign"]); value != "" {
			return value
		}
		if value := cleanString(state["registration"]); value != "" {
			return value
		}
		if value := cleanString(state["icao24"]); value != "" {
			return strings.ToUpper(value)
		}
		return objectKey
	}
	if value := cleanString(state["name"]); value != "" {
		return value
	}
	if value := cleanString(state["mmsi"]); value != "" {
		return "MMSI " + value
	}
	return objectKey
}

func transportSubtitle(kind string, state map[string]any) string {
	var parts []string
	if kind == "aircraft" {
		parts = []string{firstString(state["displayCategoryZh"], state["displayCategory"]), firstString(state["roleZh"], state["role"])}
	} else {
		parts = []string{firstString(state["shipTypeLabelZh"], state["shipTypeLabel"]), firstString(state["roleZh"], state["role"])}
	}
	kept := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			kept = append(kept, part)
		}
	}
	return strings.Join(kept, " · ")
}

func firstString(values ...any) string {
	for _, value := range values {
		if text := cleanString(value); text != "" {
			return text
		}
	}
	return ""
}

func cleanString(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

func transportLatest(state map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range state {
		out[key] = jsonScalar(value)
	}
	if text, ok := isoAny(state["observedAt"]); ok {
		out["observedAt"] = text
	} else {
		delete(out, "observedAt")
	}
	if text, ok := isoAny(state["sourceUpdatedAt"]); ok {
		out["sourceUpdatedAt"] = text
	} else {
		delete(out, "sourceUpdatedAt")
	}
	return out
}

func transportPoint(doc map[string]any) map[string]any {
	id := cleanString(jsonScalar(doc["_id"]))
	if id == "" {
		id = cleanString(doc["id"])
	}
	if id == "" {
		observed, _ := isoAny(doc["observedAt"])
		key := cleanString(doc["objectKey"])
		if key == "" {
			key = "transport"
		}
		id = key + ":" + observed
	}
	observed, ok := isoAny(doc["observedAt"])
	if !ok {
		observed = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	}
	point := map[string]any{
		"id":         id,
		"lat":        numberValue(doc["lat"]),
		"lng":        numberValue(doc["lng"]),
		"observedAt": observed,
	}
	if text, ok := isoAny(doc["sourceUpdatedAt"]); ok {
		point["sourceUpdatedAt"] = text
	}
	if value, ok := finite(doc["heading"]); ok {
		point["heading"] = value
	}
	if value, ok := finite(doc["course"]); ok {
		point["course"] = value
	}
	if value, ok := finite(doc["speed"]); ok {
		point["speed"] = value
	}
	if value, ok := finite(doc["altitudeFt"]); ok {
		point["altitudeFt"] = value
	}
	if text := cleanString(doc["geoCell"]); text != "" {
		point["geoCell"] = text
	}
	return point
}

func transportSummary(docs []map[string]any) map[string]any {
	chronological := append([]map[string]any(nil), docs...)
	sort.SliceStable(chronological, func(i, j int) bool {
		return dateMillis(chronological[i]["observedAt"]) < dateMillis(chronological[j]["observedAt"])
	})
	var total float64
	var maxSpeed float64
	var maxAlt float64
	counts := map[string]int{}
	order := make([]string, 0)
	for index, point := range chronological {
		if speed, ok := finite(point["speed"]); ok {
			if speed > maxSpeed {
				maxSpeed = speed
			}
		}
		if alt, ok := finite(point["altitudeFt"]); ok {
			if alt > maxAlt {
				maxAlt = alt
			}
		}
		if cell := cleanString(point["geoCell"]); cell != "" {
			if counts[cell] == 0 {
				order = append(order, cell)
			}
			counts[cell]++
		}
		if index == 0 {
			continue
		}
		if km, ok := trackDistanceKm(chronological[index-1], point); ok {
			total += km
		}
	}
	sort.SliceStable(order, func(i, j int) bool {
		return counts[order[i]] > counts[order[j]]
	})
	if len(order) > 10 {
		order = order[:10]
	}
	if order == nil {
		order = []string{}
	}
	summary := map[string]any{
		"pointCount": len(chronological),
		"geoCells":   order,
	}
	if len(chronological) > 0 {
		if text, ok := isoAny(chronological[0]["observedAt"]); ok {
			summary["earliestObservedAt"] = text
		}
		if text, ok := isoAny(chronological[len(chronological)-1]["observedAt"]); ok {
			summary["latestObservedAt"] = text
		}
	}
	if total > 0 {
		summary["totalDistanceKm"] = jsFixed1(total)
	}
	if maxSpeed > 0 {
		summary["maxSpeed"] = jsRound(maxSpeed)
	}
	if maxAlt > 0 {
		summary["maxAltitudeFt"] = jsRound(maxAlt)
	}
	return summary
}

func trackDistanceKm(left, right map[string]any) (float64, bool) {
	leftLat, ok1 := finite(left["lat"])
	leftLng, ok2 := finite(left["lng"])
	rightLat, ok3 := finite(right["lat"])
	rightLng, ok4 := finite(right["lng"])
	if !ok1 || !ok2 || !ok3 || !ok4 {
		return 0, false
	}
	toRad := func(value float64) float64 { return value * math.Pi / 180 }
	const earth = 6371.0
	dLat := toRad(rightLat - leftLat)
	dLng := toRad(rightLng - leftLng)
	a := math.Sin(dLat/2)*math.Sin(dLat/2) + math.Cos(toRad(leftLat))*math.Cos(toRad(rightLat))*math.Sin(dLng/2)*math.Sin(dLng/2)
	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
	return earth * c, true
}

func finite(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return 0, false
		}
		return typed, true
	case float32:
		return finite(float64(typed))
	case int:
		return float64(typed), true
	case int32:
		return float64(typed), true
	case int64:
		return float64(typed), true
	default:
		return 0, false
	}
}

func numberValue(value any) float64 {
	n, _ := finite(value)
	return n
}

func dateMillis(value any) int64 {
	if parsed := parseAnyTime(value); parsed != nil {
		return parsed.UnixMilli()
	}
	return 0
}

func isoAny(value any) (string, bool) {
	parsed := parseAnyTime(value)
	if parsed == nil {
		return "", false
	}
	return parsed.UTC().Format("2006-01-02T15:04:05.000Z"), true
}

func jsonScalar(value any) any {
	switch typed := value.(type) {
	case bson.ObjectID:
		return typed.Hex()
	case time.Time:
		if typed.IsZero() {
			return nil
		}
		return typed.UTC().Format("2006-01-02T15:04:05.000Z")
	case bson.DateTime:
		return typed.Time().UTC().Format("2006-01-02T15:04:05.000Z")
	case bson.M:
		out := map[string]any{}
		for key, entry := range typed {
			out[key] = jsonScalar(entry)
		}
		return out
	case map[string]any:
		out := map[string]any{}
		for key, entry := range typed {
			out[key] = jsonScalar(entry)
		}
		return out
	case bson.A:
		out := make([]any, 0, len(typed))
		for _, entry := range typed {
			out = append(out, jsonScalar(entry))
		}
		return out
	case []any:
		out := make([]any, 0, len(typed))
		for _, entry := range typed {
			out = append(out, jsonScalar(entry))
		}
		return out
	case int32:
		return int(typed)
	case int64:
		return typed
	default:
		return value
	}
}

func jsRound(value float64) int {
	return int(math.Floor(value + 0.5))
}

func jsFixed1(value float64) float64 {
	return math.Round(value*10) / 10
}
