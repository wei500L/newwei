package economicdata

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var macroPeriod = regexp.MustCompile(`^(1[89]|20|21)(\d{2})(0[1-9]|1[0-2])$`)

func parsePayload(config ParserConfig, payload any, slug string) ([]ParsedDataPoint, error) {
	switch config.Type {
	case ParserLatest:
		return parseLatest(config, payload, slug)
	case ParserTimeseries:
		return parseTimeseries(config, payload, slug)
	case ParserMacro:
		return parseMacro(config, payload, slug)
	case ParserYearMonth:
		return parseYearMonth(config, payload, slug)
	case ParserYieldCurve:
		return parseYieldCurve(config, payload, slug)
	default:
		return nil, fmt.Errorf("Unsupported Akshare parser type: %s for %s", config.Type, slug)
	}
}

func decodePayload(payload any) (any, error) {
	switch typed := payload.(type) {
	case json.RawMessage:
		var decoded any
		if err := json.Unmarshal(typed, &decoded); err != nil {
			return nil, err
		}
		return decoded, nil
	case []byte:
		var decoded any
		if err := json.Unmarshal(typed, &decoded); err != nil {
			return nil, err
		}
		return decoded, nil
	default:
		return payload, nil
	}
}

func recordArray(payload any) []map[string]any {
	switch typed := payload.(type) {
	case []any:
		out := make([]map[string]any, 0, len(typed))
		for _, item := range typed {
			if record, ok := item.(map[string]any); ok {
				out = append(out, record)
			}
		}
		return out
	case map[string]any:
		return []map[string]any{typed}
	default:
		return []map[string]any{}
	}
}

func assertFieldsExist(records []map[string]any, fields []string, slug string) error {
	if len(records) == 0 {
		return nil
	}
	missing := make([]string, 0)
	seen := map[string]bool{}
	for _, field := range fields {
		if field == "" || seen[field] {
			continue
		}
		seen[field] = true
		found := false
		for _, record := range records {
			if _, ok := record[field]; ok {
				found = true
				break
			}
		}
		if !found {
			missing = append(missing, field)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	suffix := ""
	if slug != "" {
		suffix = " for " + slug
	}
	return fmt.Errorf("Missing configured field(s) in payload%s: %s", suffix, strings.Join(missing, ", "))
}

func requiredField(record map[string]any, field, slug string) (any, error) {
	value, ok := record[field]
	if !ok {
		suffix := ""
		if slug != "" {
			suffix = " for " + slug
		}
		return nil, fmt.Errorf(`Missing required field "%s" in payload record%s`, field, suffix)
	}
	return value, nil
}

func normalizeNumber(value any) *float64 {
	switch typed := value.(type) {
	case nil:
		return nil
	case float64:
		if typed != typed || typed > 1.7976931348623157e308 || typed < -1.7976931348623157e308 {
			return nil
		}
		return &typed
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil {
			return nil
		}
		return &parsed
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" || trimmed == "--" || trimmed == "-" || trimmed == "NaN" || trimmed == "null" {
			return nil
		}
		sanitized := strings.ReplaceAll(strings.ReplaceAll(trimmed, ",", ""), "%", "")
		if sanitized == "" {
			return nil
		}
		parsed, err := strconv.ParseFloat(sanitized, 64)
		if err != nil {
			return nil
		}
		return &parsed
	default:
		return nil
	}
}

func sourceField(field string, category any) string {
	if truthy(category) {
		return fmt.Sprintf("%v:%s", category, field)
	}
	return field
}

func truthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case float64:
		return typed != 0 && typed == typed
	case int:
		return typed != 0
	default:
		return true
	}
}

func marshalRecord(record map[string]any) json.RawMessage {
	raw, err := json.Marshal(record)
	if err != nil {
		return nil
	}
	return raw
}

func dedupePoints(points []ParsedDataPoint) []ParsedDataPoint {
	seen := map[string]bool{}
	out := make([]ParsedDataPoint, 0, len(points))
	for _, point := range points {
		key := fmt.Sprintf("%d|%s", point.RecordedAt.UnixMilli(), point.SourceField)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, point)
	}
	return out
}

func parseLatest(config ParserConfig, payload any, slug string) ([]ParsedDataPoint, error) {
	decoded, err := decodePayload(payload)
	if err != nil {
		return nil, err
	}
	records := recordArray(decoded)
	fields := []string{config.TimestampField, config.CategoryField}
	for _, field := range config.ValueFields {
		fields = append(fields, field.Field)
	}
	if err := assertFieldsExist(records, fields, slug); err != nil {
		return nil, err
	}
	now := time.Now()
	points := make([]ParsedDataPoint, 0)
	for _, record := range records {
		for _, field := range config.ValueFields {
			recordedAt := now
			if config.TimestampField != "" {
				value, err := requiredField(record, config.TimestampField, slug)
				if err != nil {
					return nil, err
				}
				recordedAt, err = parseRequiredDate(value, config.TimestampField, slug)
				if err != nil {
					return nil, err
				}
			}
			var category any
			if config.CategoryField != "" {
				category, err = requiredField(record, config.CategoryField, slug)
				if err != nil {
					return nil, err
				}
			}
			value := normalizeNumber(record[field.Field])
			if value == nil {
				continue
			}
			dataType := field.DataType
			if dataType == "" {
				dataType = ValueTypePrice
			}
			points = append(points, ParsedDataPoint{
				RecordedAt:  recordedAt,
				Value:       *value,
				Unit:        optionalUnit(field.Unit),
				DataType:    dataType,
				SourceField: sourceField(field.Field, category),
				Meta:        marshalRecord(record),
			})
		}
	}
	return dedupePoints(points), nil
}

func parseTimeseries(config ParserConfig, payload any, slug string) ([]ParsedDataPoint, error) {
	decoded, err := decodePayload(payload)
	if err != nil {
		return nil, err
	}
	records := recordArray(decoded)
	fields := []string{config.TimestampField, config.CategoryField}
	for _, field := range config.ValueFields {
		fields = append(fields, field.Field)
	}
	if err := assertFieldsExist(records, fields, slug); err != nil {
		return nil, err
	}
	points := make([]ParsedDataPoint, 0)
	for _, record := range records {
		rawTime, err := requiredField(record, config.TimestampField, slug)
		if err != nil {
			return nil, err
		}
		recordedAt, err := parseRequiredDate(rawTime, config.TimestampField, slug)
		if err != nil {
			return nil, err
		}
		for _, field := range config.ValueFields {
			var category any
			if config.CategoryField != "" {
				category, err = requiredField(record, config.CategoryField, slug)
				if err != nil {
					return nil, err
				}
			}
			value := normalizeNumber(record[field.Field])
			if value == nil {
				continue
			}
			dataType := field.DataType
			if dataType == "" {
				dataType = ValueTypePrice
			}
			points = append(points, ParsedDataPoint{
				RecordedAt:  recordedAt,
				Value:       *value,
				Unit:        optionalUnit(field.Unit),
				DataType:    dataType,
				SourceField: sourceField(field.Field, category),
				Meta:        marshalRecord(record),
			})
		}
	}
	return dedupePoints(points), nil
}

func parseMacro(config ParserConfig, payload any, slug string) ([]ParsedDataPoint, error) {
	decoded, err := decodePayload(payload)
	if err != nil {
		return nil, err
	}
	records := recordArray(decoded)
	fields := []string{config.PeriodField, config.CategoryField}
	for _, field := range config.ValueFields {
		fields = append(fields, field.Field)
	}
	if err := assertFieldsExist(records, fields, slug); err != nil {
		return nil, err
	}
	points := make([]ParsedDataPoint, 0)
	for _, record := range records {
		rawPeriod, err := requiredField(record, config.PeriodField, slug)
		if err != nil {
			return nil, err
		}
		recordedAt, err := parseRequiredDate(normalizeMacroPeriod(rawPeriod), config.PeriodField, slug)
		if err != nil {
			return nil, err
		}
		for _, field := range config.ValueFields {
			var category any
			if config.CategoryField != "" {
				category, err = requiredField(record, config.CategoryField, slug)
				if err != nil {
					return nil, err
				}
			}
			value := normalizeNumber(record[field.Field])
			if value == nil {
				continue
			}
			dataType := field.DataType
			if dataType == "" {
				dataType = ValueTypeIndex
			}
			points = append(points, ParsedDataPoint{
				RecordedAt:  recordedAt,
				Value:       *value,
				Unit:        optionalUnit(field.Unit),
				DataType:    dataType,
				SourceField: sourceField(field.Field, category),
				Meta:        marshalRecord(record),
			})
		}
	}
	return dedupePoints(points), nil
}

func normalizeMacroPeriod(value any) any {
	text, ok := value.(string)
	if !ok {
		return value
	}
	trimmed := strings.TrimSpace(text)
	match := macroPeriod.FindStringSubmatch(trimmed)
	if match == nil {
		return value
	}
	return match[1] + match[2] + "-" + match[3] + "-01"
}

func parseYearMonth(config ParserConfig, payload any, slug string) ([]ParsedDataPoint, error) {
	decoded, err := decodePayload(payload)
	if err != nil {
		return nil, err
	}
	records := recordArray(decoded)
	fields := []string{config.YearField, config.MonthField, config.DayField, config.CategoryField}
	for _, field := range config.ValueFields {
		fields = append(fields, field.Field)
	}
	if err := assertFieldsExist(records, fields, slug); err != nil {
		return nil, err
	}
	points := make([]ParsedDataPoint, 0)
	for _, record := range records {
		year, err := requiredField(record, config.YearField, slug)
		if err != nil {
			return nil, err
		}
		month, err := requiredField(record, config.MonthField, slug)
		if err != nil {
			return nil, err
		}
		var day any
		if config.DayField != "" {
			day, err = requiredField(record, config.DayField, slug)
			if err != nil {
				return nil, err
			}
		}
		recordedAt, ok := parseYearMonthDate(year, month, day)
		if !ok {
			suffix := ""
			if slug != "" {
				suffix = " for " + slug
			}
			return nil, fmt.Errorf(`Invalid year/month date fields "%s/%s"%s`, config.YearField, config.MonthField, suffix)
		}
		for _, field := range config.ValueFields {
			var category any
			if config.CategoryField != "" {
				category, err = requiredField(record, config.CategoryField, slug)
				if err != nil {
					return nil, err
				}
			}
			value := normalizeNumber(record[field.Field])
			if value == nil {
				continue
			}
			dataType := field.DataType
			if dataType == "" {
				dataType = ValueTypeIndex
			}
			points = append(points, ParsedDataPoint{
				RecordedAt:  recordedAt,
				Value:       *value,
				Unit:        optionalUnit(field.Unit),
				DataType:    dataType,
				SourceField: sourceField(field.Field, category),
				Meta:        marshalRecord(record),
			})
		}
	}
	return dedupePoints(points), nil
}

func parseYieldCurve(config ParserConfig, payload any, slug string) ([]ParsedDataPoint, error) {
	decoded, err := decodePayload(payload)
	if err != nil {
		return nil, err
	}
	records := recordArray(decoded)
	fields := []string{config.DateField}
	for _, field := range config.SeriesFields {
		fields = append(fields, field.Field)
	}
	if err := assertFieldsExist(records, fields, slug); err != nil {
		return nil, err
	}
	points := make([]ParsedDataPoint, 0)
	for _, record := range records {
		rawDate, err := requiredField(record, config.DateField, slug)
		if err != nil {
			return nil, err
		}
		recordedAt, err := parseRequiredDate(rawDate, config.DateField, slug)
		if err != nil {
			return nil, err
		}
		for _, field := range config.SeriesFields {
			value := normalizeNumber(record[field.Field])
			if value == nil {
				continue
			}
			unit := field.Unit
			if unit == "" {
				unit = "%"
			}
			dataType := field.DataType
			if dataType == "" {
				dataType = ValueTypeYield
			}
			points = append(points, ParsedDataPoint{
				RecordedAt:  recordedAt,
				Value:       *value,
				Unit:        optionalUnit(unit),
				DataType:    dataType,
				SourceField: field.Field,
				Meta:        marshalRecord(record),
			})
		}
	}
	return dedupePoints(points), nil
}

func optionalUnit(unit string) *string {
	if unit == "" {
		return nil
	}
	return &unit
}
