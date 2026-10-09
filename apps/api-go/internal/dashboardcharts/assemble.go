package dashboardcharts

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"math"
	"strconv"
	"time"
)

type samplePoint struct {
	RecordedAt time.Time
	Value      float64
	Unit       sql.NullString
}

type sectorItem struct {
	ID          string
	Slug        string
	DisplayName string
	DefaultUnit sql.NullString
	Metadata    json.RawMessage
}

type rawPoint struct {
	RecordedAt  time.Time
	Value       float64
	Unit        sql.NullString
	SourceField string
}

type candleItem struct {
	ID               string
	DisplayName      string
	DefaultFrequency string
	DefaultUnit      sql.NullString
	Metadata         json.RawMessage
}

type heatmapCell struct {
	X           int     `json:"x"`
	Y           int     `json:"y"`
	Name        string  `json:"name"`
	Value       float64 `json:"value"`
	Change      float64 `json:"change"`
	Unit        *string `json:"unit"`
	SourceField string  `json:"sourceField"`
}

type heatmapWarning struct {
	Code                  string   `json:"code"`
	ItemID                string   `json:"itemId"`
	Slug                  string   `json:"slug"`
	DisplayName           string   `json:"displayName"`
	PreferredSourceFields []string `json:"preferredSourceFields"`
	AvailableSourceFields []string `json:"availableSourceFields"`
	SelectedSourceField   string   `json:"selectedSourceField"`
}

type heatmapBody struct {
	XLabels   []string          `json:"xLabels"`
	YLabels   []string          `json:"yLabels"`
	Cells     []heatmapCell     `json:"cells"`
	UpdatedAt *string           `json:"updatedAt,omitempty"`
	Warnings  []heatmapWarning  `json:"warnings,omitempty"`
}

func heatmapXLabels() []string {
	return []string{"Group A", "Group B", "Group C", "Group D"}
}

func heatmapYLabels(cellCount int, noItems bool) []string {
	full := []string{"Row 1", "Row 2"}
	if noItems {
		return full
	}
	rows := 1
	if cellCount > 0 {
		rows = (cellCount + heatmapColumns - 1) / heatmapColumns
	}
	if rows > len(full) {
		rows = len(full)
	}
	return full[:rows]
}

func buildHeatmap(items []sectorItem, fields map[string][]string, lookup func(itemID, field string) (samplePoint, samplePoint, bool, error)) (heatmapBody, error) {
	body := heatmapBody{
		XLabels: heatmapXLabels(),
		Cells:   []heatmapCell{},
	}
	if len(items) == 0 {
		body.YLabels = heatmapYLabels(0, true)
		return body, nil
	}
	var updated time.Time
	var hasUpdated bool
	var warnings []heatmapWarning
	for _, item := range items {
		available := fields[item.ID]
		if len(available) == 0 {
			continue
		}
		fieldKey, usedFallback, preferred := chooseHeatmapField(available, decodeMetadata(item.Metadata))
		if fieldKey == "" {
			continue
		}
		sortedAvailable := append([]string(nil), available...)
		sortLocale(sortedAvailable)
		if usedFallback {
			warnings = append(warnings, heatmapWarning{
				Code:                  fallbackWarning,
				ItemID:                item.ID,
				Slug:                  item.Slug,
				DisplayName:           item.DisplayName,
				PreferredSourceFields: preferred,
				AvailableSourceFields: sortedAvailable,
				SelectedSourceField:   fieldKey,
			})
		}
		first, last, ok, err := lookup(item.ID, fieldKey)
		if err != nil {
			return heatmapBody{}, err
		}
		if !ok {
			continue
		}
		firstValue := first.Value
		lastValue := last.Value
		change := 0.0
		if firstValue != 0 {
			change = ((lastValue - firstValue) / math.Abs(firstValue)) * 100
		}
		index := len(body.Cells)
		body.Cells = append(body.Cells, heatmapCell{
			X:           index % heatmapColumns,
			Y:           index / heatmapColumns,
			Name:        item.DisplayName,
			Value:       jsFixed(lastValue, 2),
			Change:      jsFixed(change, 2),
			Unit:        coalesceUnit(last.Unit, item.DefaultUnit),
			SourceField: fieldKey,
		})
		if !hasUpdated || last.RecordedAt.After(updated) {
			updated = last.RecordedAt
			hasUpdated = true
		}
		if len(body.Cells) >= maxSectorCells {
			break
		}
	}
	body.YLabels = heatmapYLabels(len(body.Cells), false)
	if hasUpdated {
		text := toISO(updated)
		body.UpdatedAt = &text
	}
	if len(warnings) > 0 {
		body.Warnings = warnings
	}
	return body, nil
}

func coalesceUnit(pointUnit, defaultUnit sql.NullString) *string {
	if pointUnit.Valid {
		value := pointUnit.String
		return &value
	}
	if defaultUnit.Valid {
		value := defaultUnit.String
		return &value
	}
	return nil
}

func jsFixed(value float64, digits int) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return value
	}
	pow := math.Pow10(digits)
	rounded := math.Round(value*pow) / pow
	text := strconv.FormatFloat(rounded, 'f', digits, 64)
	parsed, err := strconv.ParseFloat(text, 64)
	if err != nil {
		return rounded
	}
	return parsed
}

type candlePoint struct {
	Timestamp string
	Open      float64
	Close     float64
	High      float64
	Low       float64
}

type candleSuccess struct {
	Symbol                 string
	Interval               string
	Points                 []candlePoint
	IncludeUnit            bool
	Unit                   *string
	SourceFields           []sourceFieldPair
	UpdatedAt              string
	LatestObservedAt       string
	SkippedIncompleteCount int
}

type sourceFieldPair struct {
	Field  string
	Source string
}

type candleMismatch struct {
	Item      candleItem
	Aliases   map[string][]string
	Available []string
}

func buildCandle(item *candleItem, matched []rawPoint, total int, available []string) (candleSuccess, *candleMismatch) {
	if item == nil {
		return candleSuccess{
			Symbol:   candlestickSlug,
			Interval: "daily",
			Points:   []candlePoint{},
		}, nil
	}
	aliases := expandOHLC(decodeMetadata(item.Metadata))
	if len(matched) == 0 && total > 0 {
		sorted := append([]string(nil), available...)
		sortLocale(sorted)
		return candleSuccess{}, &candleMismatch{Item: *item, Aliases: aliases, Available: sorted}
	}
	return assembleCandle(*item, aliases, matched), nil
}

func assembleCandle(item candleItem, aliases map[string][]string, points []rawPoint) candleSuccess {
	index := indexAliases(aliases)
	type bucket struct {
		timestamp time.Time
		values    map[string]float64
		ranks     map[string]int
	}
	order := make([]int64, 0)
	grouped := map[int64]*bucket{}
	sourceOrder := make([]sourceFieldPair, 0)
	sourcePos := map[string]int{}
	sourceRank := map[string]int{}
	var unit *string
	for _, point := range points {
		if unit == nil && point.Unit.Valid && point.Unit.String != "" {
			value := point.Unit.String
			unit = &value
		}
		normalized := normalizeSourceFieldKey(point.SourceField)
		field, ok := index.fieldByNorm[normalized]
		if !ok {
			continue
		}
		rank, ok := index.rank[field][normalized]
		if !ok {
			rank = int(^uint(0) >> 1)
		}
		key := point.RecordedAt.UTC().UnixMilli()
		entry := grouped[key]
		if entry == nil {
			entry = &bucket{
				timestamp: point.RecordedAt,
				values:    map[string]float64{},
				ranks:     map[string]int{},
			}
			grouped[key] = entry
			order = append(order, key)
		}
		if previous, exists := entry.ranks[field]; !exists || rank < previous {
			entry.values[field] = point.Value
			entry.ranks[field] = rank
		}
		if previous, exists := sourceRank[field]; !exists || rank < previous {
			if _, seen := sourcePos[field]; !seen {
				sourcePos[field] = len(sourceOrder)
				sourceOrder = append(sourceOrder, sourceFieldPair{Field: field, Source: point.SourceField})
			} else {
				sourceOrder[sourcePos[field]].Source = point.SourceField
			}
			sourceRank[field] = rank
		}
	}
	// SQL 已按 recordedAt 升序。同一毫秒的合并不改变组顺序。
	sortMillis(order)
	result := candleSuccess{
		Symbol:      item.DisplayName,
		Interval:    item.DefaultFrequency,
		Points:      []candlePoint{},
		IncludeUnit: true,
		Unit:        unit,
	}
	if result.Unit == nil && item.DefaultUnit.Valid {
		value := item.DefaultUnit.String
		result.Unit = &value
	}
	if len(sourceOrder) > 0 {
		result.SourceFields = sourceOrder
	}
	skipped := 0
	var updated time.Time
	var hasUpdated bool
	for _, key := range order {
		entry := grouped[key]
		missing := false
		for _, field := range ohlcOrder {
			if _, ok := entry.values[field]; !ok {
				missing = true
				break
			}
		}
		if missing {
			skipped++
			continue
		}
		result.Points = append(result.Points, candlePoint{
			Timestamp: toISO(entry.timestamp),
			Open:      entry.values["open"],
			Close:     entry.values["close"],
			High:      entry.values["high"],
			Low:       entry.values["low"],
		})
		updated = entry.timestamp
		hasUpdated = true
	}
	if len(order) > 0 {
		result.LatestObservedAt = toISO(grouped[order[len(order)-1]].timestamp)
	}
	if hasUpdated {
		result.UpdatedAt = toISO(updated)
	}
	result.SkippedIncompleteCount = skipped
	return result
}

func sortMillis(values []int64) {
	for i := 1; i < len(values); i++ {
		current := values[i]
		j := i
		for j > 0 && values[j-1] > current {
			values[j] = values[j-1]
			j--
		}
		values[j] = current
	}
}

func (body candleSuccess) MarshalJSON() ([]byte, error) {
	buf := &bytes.Buffer{}
	buf.WriteString(`{"symbol":`)
	writeEncoded(buf, body.Symbol)
	buf.WriteString(`,"interval":`)
	writeEncoded(buf, body.Interval)
	buf.WriteString(`,"points":`)
	if body.Points == nil {
		body.Points = []candlePoint{}
	}
	buf.WriteByte('[')
	for i, point := range body.Points {
		if i > 0 {
			buf.WriteByte(',')
		}
		buf.WriteString(`{"timestamp":`)
		writeEncoded(buf, point.Timestamp)
		buf.WriteString(`,"open":`)
		writeEncoded(buf, point.Open)
		buf.WriteString(`,"close":`)
		writeEncoded(buf, point.Close)
		buf.WriteString(`,"high":`)
		writeEncoded(buf, point.High)
		buf.WriteString(`,"low":`)
		writeEncoded(buf, point.Low)
		buf.WriteByte('}')
	}
	buf.WriteByte(']')
	if body.IncludeUnit {
		buf.WriteString(`,"unit":`)
		writeEncoded(buf, body.Unit)
	}
	if len(body.SourceFields) > 0 {
		buf.WriteString(`,"sourceFields":{`)
		for i, pair := range body.SourceFields {
			if i > 0 {
				buf.WriteByte(',')
			}
			writeEncoded(buf, pair.Field)
			buf.WriteByte(':')
			writeEncoded(buf, pair.Source)
		}
		buf.WriteByte('}')
	}
	if body.UpdatedAt != "" {
		buf.WriteString(`,"updatedAt":`)
		writeEncoded(buf, body.UpdatedAt)
	}
	if body.LatestObservedAt != "" {
		buf.WriteString(`,"latestObservedAt":`)
		writeEncoded(buf, body.LatestObservedAt)
	}
	if body.SkippedIncompleteCount > 0 {
		buf.WriteString(`,"skippedIncompleteCount":`)
		writeEncoded(buf, body.SkippedIncompleteCount)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

func encodeJSON(value any) ([]byte, error) {
	buf := &bytes.Buffer{}
	if err := writeEncoded(buf, value); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func writeEncoded(buf *bytes.Buffer, value any) error {
	var raw bytes.Buffer
	encoder := json.NewEncoder(&raw)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return err
	}
	encoded := raw.Bytes()
	if len(encoded) > 0 && encoded[len(encoded)-1] == '\n' {
		encoded = encoded[:len(encoded)-1]
	}
	_, err := buf.Write(encoded)
	return err
}
