package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// Realtime signal metric slugs (REALTIME_SIGNAL_METRIC_SLUGS).
const (
	realtimeSignalSlugOpensky               = "realtime.opensky.military_flights"
	realtimeSignalSlugOpenskySnapshotHealth = "realtime.opensky.snapshot_health"
	realtimeSignalSlugADSB                  = "realtime.adsb.military_flights"
	realtimeSignalSlugADSBSnapshotHealth    = "realtime.adsb.snapshot_health"
	// realtimeSignalSeriesKeyPrefix is the seriesKey prefix visible in the
	// snapshot store: `realtime-signals:series:{orgId}:{metricSlug}`.
	realtimeSignalSeriesKeyPrefix = "realtime-signals:series:"
)

// realtimeSlugMissingContext is {error: "metric_slug_missing"}.
type realtimeSlugMissingContext struct {
	Error string `json:"error"`
}

// realtimeSeriesPoint is one decoded RealtimeSignalMetricPoint. Context keeps
// the raw JSON object so the provider can spread it into the event context.
type realtimeSeriesPoint struct {
	TS      string
	Value   float64
	Context json.RawMessage
}

// realtimeProvider is RealtimeSignalMetricProvider.
type realtimeProvider struct {
	deps Dependencies
}

// NewRealtimeSignal returns the realtime_signal metric provider.
func NewRealtimeSignal(deps Dependencies) Provider {
	return &realtimeProvider{deps: deps}
}

// Type is AlertMetricProvider.realtime_signal.
func (p *realtimeProvider) Type() string {
	return TypeRealtimeSignal
}

// Fetch mirrors RealtimeSignalMetricProvider.fetch: normalize the slug, read
// the Redis series, evaluate it, then apply the OpenSky snapshot override.
func (p *realtimeProvider) Fetch(ctx context.Context, rule Rule) (Evaluation, error) {
	metricSlug := normalizeRealtimeSignalMetricSlug(rule.MetricSlug)
	if metricSlug == "" {
		return realtimeEvaluation(realtimeSlugMissingContext{Error: "metric_slug_missing"})
	}
	points, err := p.getSeries(ctx, rule.OrgID, metricSlug)
	if err != nil {
		return Evaluation{}, err
	}
	return applyRealtimeSlugOverride(metricSlug, evaluateRealtimeSeries(points, rule.ChangeWindowMin, p.deps.now().UTC())), nil
}

// realtimeEvaluation returns a value-less evaluation that only carries context.
func realtimeEvaluation(payload any) (Evaluation, error) {
	raw, err := marshalProviderContext(payload)
	if err != nil {
		return Evaluation{}, err
	}
	return Evaluation{Context: raw}, nil
}

// normalizeRealtimeSignalMetricSlug mirrors
// normalizeRealtimeSignalMetricSlug from realtime-signals.constants.ts: trim,
// then the four alias entries (two are identity entries, two redirect ADSB to
// OpenSky).
//
// The same four aliases already exist in
// internal/graphqlread/alerts/convert.go; the two copies should be unified into
// one shared table later.
func normalizeRealtimeSignalMetricSlug(value string) string {
	aliases := map[string]string{
		realtimeSignalSlugOpensky:               realtimeSignalSlugOpensky,
		realtimeSignalSlugADSB:                  realtimeSignalSlugOpensky,
		realtimeSignalSlugOpenskySnapshotHealth: realtimeSignalSlugOpenskySnapshotHealth,
		realtimeSignalSlugADSBSnapshotHealth:    realtimeSignalSlugOpenskySnapshotHealth,
	}
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	if alias, ok := aliases[trimmed]; ok {
		return alias
	}
	return trimmed
}

// getSeries mirrors RealtimeSignalsSnapshotStore.getSeries: a missing Redis key
// is an empty series, a malformed payload is an error.
func (p *realtimeProvider) getSeries(ctx context.Context, orgID, metricSlug string) ([]realtimeSeriesPoint, error) {
	if p.deps.Redis == nil {
		return nil, errors.New("alertworker/providers: realtime signal: redis is not configured")
	}
	key := realtimeSignalSeriesKeyPrefix + orgID + ":" + metricSlug
	payload, err := p.deps.Redis.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("alertworker/providers: realtime signal series: %w", err)
	}
	points, err := decodeRealtimeSeries(payload)
	if err != nil {
		return nil, fmt.Errorf("alertworker/providers: realtime signal series decode: %w", err)
	}
	return points, nil
}

// decodeRealtimeSeries decodes the cached
// {metricSlug, points:[{ts,value,context?}]} document, keeps the entries with a
// string ts and a finite numeric value, and sorts them by ts. The sort is
// stable because JavaScript's sort is stable: entries sharing a ts keep their
// stored order.
func decodeRealtimeSeries(payload []byte) ([]realtimeSeriesPoint, error) {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		// JSON.parse would succeed for an array or scalar; getSeries then finds
		// no points array and returns [].
		return nil, nil
	}
	var series struct {
		MetricSlug string          `json:"metricSlug"`
		Points     json.RawMessage `json:"points"`
	}
	if err := json.Unmarshal(trimmed, &series); err != nil {
		return nil, err
	}
	pointsJSON := bytes.TrimSpace(series.Points)
	if len(pointsJSON) == 0 || pointsJSON[0] != '[' {
		// `!Array.isArray(current.points)` also returns an empty series.
		return nil, nil
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(pointsJSON, &entries); err != nil {
		return nil, err
	}
	points := make([]realtimeSeriesPoint, 0, len(entries))
	for _, entry := range entries {
		point, ok := decodeRealtimeSeriesPoint(entry)
		if !ok {
			continue
		}
		points = append(points, point)
	}
	sort.SliceStable(points, func(i, j int) bool {
		// localeCompare on ISO-8601 strings is byte order for this alphabet.
		return points[i].TS < points[j].TS
	})
	return points, nil
}

// decodeRealtimeSeriesPoint applies the getSeries filter to one entry:
// `entry && typeof entry.ts === "string" && typeof entry.value === "number" &&
// Number.isFinite(entry.value)`, plus the object check on the optional context.
func decodeRealtimeSeriesPoint(entry json.RawMessage) (realtimeSeriesPoint, bool) {
	trimmed := bytes.TrimSpace(entry)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return realtimeSeriesPoint{}, false
	}
	var decoded struct {
		TS      json.RawMessage `json:"ts"`
		Value   json.RawMessage `json:"value"`
		Context json.RawMessage `json:"context"`
	}
	if err := json.Unmarshal(trimmed, &decoded); err != nil {
		return realtimeSeriesPoint{}, false
	}
	ts := bytes.TrimSpace(decoded.TS)
	if len(ts) == 0 || ts[0] != '"' {
		return realtimeSeriesPoint{}, false
	}
	var timestamp string
	if err := json.Unmarshal(ts, &timestamp); err != nil {
		return realtimeSeriesPoint{}, false
	}
	valueText := bytes.TrimSpace(decoded.Value)
	if len(valueText) == 0 || (valueText[0] != '-' && (valueText[0] < '0' || valueText[0] > '9')) {
		return realtimeSeriesPoint{}, false
	}
	value, err := strconv.ParseFloat(string(valueText), 64)
	if err != nil || !isFiniteMetricNumber(value) {
		return realtimeSeriesPoint{}, false
	}
	point := realtimeSeriesPoint{TS: timestamp, Value: value}
	contextJSON := bytes.TrimSpace(decoded.Context)
	if len(contextJSON) > 0 && contextJSON[0] == '{' {
		point.Context = json.RawMessage(contextJSON)
	}
	return point, true
}

// parseRealtimeTimestamp is Date.parse for the ISO-8601 strings stored in the
// series. A value Date.parse would reject returns ok=false, which the evaluation
// treats like NaN.
func parseRealtimeTimestamp(value string) (time.Time, bool) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, false
	}
	return parsed, true
}

// evaluateRealtimeSeries is the pure core of evaluateMetric: it needs the
// decoded series and the current time only.
func evaluateRealtimeSeries(points []realtimeSeriesPoint, changeWindowMin *int, now time.Time) Evaluation {
	if len(points) == 0 {
		return Evaluation{}
	}
	latestPoint := points[len(points)-1]
	latestTimestamp, latestParsed := parseRealtimeTimestamp(latestPoint.TS)

	windowMin := 60
	if changeWindowMin != nil {
		windowMin = *changeWindowMin
	}
	windowMin = realtimeWindowMinutes(windowMin)
	maxStaleMin := windowMin * 2
	if maxStaleMin < 5 {
		maxStaleMin = 5
	}
	if latestParsed && now.Sub(latestTimestamp) > time.Duration(maxStaleMin)*time.Minute {
		return Evaluation{Context: realtimeStaleContext(latestPoint.Context, latestPoint.TS, maxStaleMin)}
	}

	targetValid := latestParsed
	targetTimestamp := time.Time{}
	if targetValid {
		targetTimestamp = latestTimestamp.Add(-time.Duration(windowMin) * time.Minute)
	}
	var previousPoint *realtimeSeriesPoint
	if targetValid {
		for index := len(points) - 2; index >= 0; index-- {
			candidateTimestamp, ok := parseRealtimeTimestamp(points[index].TS)
			if !ok {
				continue
			}
			if !candidateTimestamp.After(targetTimestamp) {
				previousPoint = &points[index]
				break
			}
		}
	}
	if previousPoint == nil && len(points) > 1 {
		previousPoint = &points[len(points)-2]
	}

	var previous *float64
	if previousPoint != nil {
		previous = evaluationNumber(previousPoint.Value)
	}
	var changePercent *float64
	if previous != nil && *previous != 0 {
		computed := (latestPoint.Value - *previous) / *previous * 100
		if isFiniteMetricNumber(computed) {
			changePercent = evaluationNumber(computed)
		}
	}
	return Evaluation{
		Latest:        evaluationNumber(latestPoint.Value),
		Previous:      previous,
		ChangePercent: changePercent,
		Context:       latestPoint.Context,
	}
}

// realtimeWindowMinutes is Math.max(1, Math.trunc(changeWindowMin ?? 60)).
func realtimeWindowMinutes(value int) int {
	if value < 1 {
		return 1
	}
	return value
}

// applyRealtimeSlugOverride implements the OpenSky special case: a retained or
// explicitly stale snapshot is reported as stale so the alert pipeline does not
// treat the snapshot count as a live measurement.
func applyRealtimeSlugOverride(metricSlug string, evaluation Evaluation) Evaluation {
	if metricSlug != realtimeSignalSlugOpensky || len(evaluation.Context) == 0 {
		return evaluation
	}
	object := parseRealtimeContextObject(evaluation.Context)
	if object == nil {
		return evaluation
	}
	retained, _ := object.boolValue("snapshotRetainedPrevious")
	freshness, _ := object.stringValue("snapshotFreshness")
	if !retained && freshness != "stale" {
		return evaluation
	}

	object.set("stale", json.RawMessage("true"))
	if latest, ok := object.firstString("latestObservedAt", "snapshotUpdatedAt"); ok {
		object.set("latestTimestamp", latest)
	}
	if seconds, ok := object.numberValue("staleThresholdSec"); ok && isFiniteMetricNumber(seconds) {
		minutes := math.Round(seconds / 60)
		if minutes < 1 {
			minutes = 1
		}
		object.set("maxStaleMinutes", json.RawMessage(strconv.Itoa(int(minutes))))
	}
	return Evaluation{Context: object.marshal()}
}

// realtimeStaleContext renders
// `{...context, stale: true, latestTimestamp, maxStaleMinutes}` (or the same
// object without the spread when the point has no context).
func realtimeStaleContext(base json.RawMessage, timestamp string, maxStaleMinutes int) json.RawMessage {
	object := parseRealtimeContextObject(base)
	if object == nil {
		object = &realtimeContextObject{values: map[string]json.RawMessage{}}
	}
	object.set("stale", json.RawMessage("true"))
	if encoded, err := json.Marshal(timestamp); err == nil {
		object.set("latestTimestamp", encoded)
	}
	object.set("maxStaleMinutes", json.RawMessage(strconv.Itoa(maxStaleMinutes)))
	return object.marshal()
}

// realtimeContextObject is an insertion-ordered JSON object. The NestJS stale
// branch spreads the stored point context and then sets three keys, and
// JSON.stringify keeps the original position of keys that already exist; a Go
// map would re-order every key.
type realtimeContextObject struct {
	keys   []string
	values map[string]json.RawMessage
}

// parseRealtimeContextObject decodes one JSON object, keeping its key order.
func parseRealtimeContextObject(raw json.RawMessage) *realtimeContextObject {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	if _, err := decoder.Token(); err != nil {
		return nil
	}
	object := &realtimeContextObject{values: map[string]json.RawMessage{}}
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil
		}
		object.set(key, value)
	}
	if _, err := decoder.Token(); err != nil {
		return nil
	}
	return object
}

// set inserts or replaces one key, keeping the original position on replace.
func (o *realtimeContextObject) set(key string, value json.RawMessage) {
	if _, exists := o.values[key]; !exists {
		o.keys = append(o.keys, key)
	}
	o.values[key] = value
}

// marshal renders the object with its insertion order preserved.
func (o *realtimeContextObject) marshal() json.RawMessage {
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	for index, key := range o.keys {
		if index > 0 {
			buffer.WriteByte(',')
		}
		encodedKey, err := json.Marshal(key)
		if err != nil {
			continue
		}
		buffer.Write(encodedKey)
		buffer.WriteByte(':')
		value := o.values[key]
		if len(value) == 0 {
			buffer.WriteString("null")
			continue
		}
		buffer.Write(value)
	}
	buffer.WriteByte('}')
	return buffer.Bytes()
}

// boolValue reads `context.key === true`.
func (o *realtimeContextObject) boolValue(key string) (bool, bool) {
	value, ok := o.values[key]
	if !ok {
		return false, false
	}
	return string(bytes.TrimSpace(value)) == "true", true
}

// stringValue reads `typeof context.key === "string"`.
func (o *realtimeContextObject) stringValue(key string) (string, bool) {
	value, ok := o.values[key]
	if !ok {
		return "", false
	}
	text := bytes.TrimSpace(value)
	if len(text) == 0 || text[0] != '"' {
		return "", false
	}
	var decoded string
	if err := json.Unmarshal(text, &decoded); err != nil {
		return "", false
	}
	return decoded, true
}

// numberValue reads `typeof context.key === "number"`.
func (o *realtimeContextObject) numberValue(key string) (float64, bool) {
	value, ok := o.values[key]
	if !ok {
		return 0, false
	}
	text := string(bytes.TrimSpace(value))
	if text == "" || (text[0] != '-' && (text[0] < '0' || text[0] > '9')) {
		return 0, false
	}
	number, err := strconv.ParseFloat(text, 64)
	if err != nil {
		return 0, false
	}
	return number, true
}

// firstString returns the JSON-encoded form of the first key whose value is a
// string, mirroring the nested typeof ternaries of the OpenSky override.
func (o *realtimeContextObject) firstString(keys ...string) (json.RawMessage, bool) {
	for _, key := range keys {
		if _, ok := o.stringValue(key); ok {
			return o.values[key], true
		}
	}
	return nil, false
}
