package assistantruns

import (
	"bytes"
	"encoding/json"
	"math"
	"unicode/utf16"
)

// planKind is the discriminated-union member.
type planKind string

const (
	planNewsNegativeList   planKind = "news_negative_list"
	planCorrelationGoldUSD planKind = "correlation_gold_usd"
	planCorrelationTwo     planKind = "correlation_two_series"
	planUnsupported        planKind = "unsupported"
)

// queryPlan is the validated AssistantQueryPlan. Only the fields of the active
// kind are meaningful; the parser clears the others.
type queryPlan struct {
	Kind         planKind
	Topic        string
	LookbackDays *int
	Limit        *int
	Transform    *string
	SeriesA      *string
	SeriesB      *string
	Reason       *string
}

type rawQueryPlan struct {
	Kind         json.RawMessage `json:"kind"`
	Topic        json.RawMessage `json:"topic"`
	LookbackDays json.RawMessage `json:"lookbackDays"`
	Limit        json.RawMessage `json:"limit"`
	Transform    json.RawMessage `json:"transform"`
	SeriesA      json.RawMessage `json:"seriesA"`
	SeriesB      json.RawMessage `json:"seriesB"`
	Reason       json.RawMessage `json:"reason"`
}

// parseQueryPlan mirrors AssistantQueryPlanSchema.safeParse: a variant whose
// required field is missing, whose type is wrong or whose bound is exceeded
// fails the WHOLE parse, and the caller falls back to {kind:"unsupported"}.
func parseQueryPlan(raw json.RawMessage) queryPlan {
	unsupported := queryPlan{Kind: planUnsupported}
	if len(bytes.TrimSpace(raw)) == 0 {
		return unsupported
	}
	var decoded rawQueryPlan
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return unsupported
	}
	kind, ok := rawRequiredString(decoded.Kind)
	if !ok {
		return unsupported
	}
	switch planKind(kind) {
	case planNewsNegativeList:
		topic, ok := rawRequiredString(decoded.Topic)
		if !ok {
			return unsupported
		}
		lookback, ok := rawOptionalIntRange(decoded.LookbackDays, 1, 90)
		if !ok {
			return unsupported
		}
		limit, ok := rawOptionalIntRange(decoded.Limit, 1, 50)
		if !ok {
			return unsupported
		}
		return queryPlan{Kind: planNewsNegativeList, Topic: topic, LookbackDays: lookback, Limit: limit}
	case planCorrelationGoldUSD:
		lookback, ok := rawOptionalIntRange(decoded.LookbackDays, 7, 3650)
		if !ok {
			return unsupported
		}
		transform, ok := rawOptionalTransform(decoded.Transform)
		if !ok {
			return unsupported
		}
		return queryPlan{Kind: planCorrelationGoldUSD, LookbackDays: lookback, Transform: transform}
	case planCorrelationTwo:
		seriesA, ok := rawRequiredString(decoded.SeriesA)
		if !ok {
			return unsupported
		}
		seriesB, ok := rawRequiredString(decoded.SeriesB)
		if !ok {
			return unsupported
		}
		lookback, ok := rawOptionalIntRange(decoded.LookbackDays, 7, 3650)
		if !ok {
			return unsupported
		}
		transform, ok := rawOptionalTransform(decoded.Transform)
		if !ok {
			return unsupported
		}
		return queryPlan{Kind: planCorrelationTwo, SeriesA: &seriesA, SeriesB: &seriesB, LookbackDays: lookback, Transform: transform}
	case planUnsupported:
		reason := ""
		if len(bytes.TrimSpace(decoded.Reason)) > 0 && string(bytes.TrimSpace(decoded.Reason)) != "null" {
			value, ok := rawString(decoded.Reason)
			if !ok {
				return unsupported
			}
			reason = value
		}
		return queryPlan{Kind: planUnsupported, Reason: optionalString(reason)}
	default:
		return unsupported
	}
}

// rawRequiredString mirrors z.string().min(1) for a required field: a missing
// or null value fails, and the JS length is counted in UTF-16 code units.
func rawRequiredString(raw json.RawMessage) (string, bool) {
	value, ok := rawString(raw)
	if !ok {
		return "", false
	}
	if len(utf16.Encode([]rune(value))) < 1 {
		return "", false
	}
	return value, true
}

func rawString(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return "", false
	}
	var value string
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return "", false
	}
	return value, true
}

// rawOptionalIntRange mirrors z.number().int().min(a).max(b).optional(): an
// absent or null value is allowed, anything else must be an integral JSON
// number inside the inclusive bounds.
func rawOptionalIntRange(raw json.RawMessage, minimum, maximum int) (*int, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil, true
	}
	var number float64
	if err := json.Unmarshal(trimmed, &number); err != nil {
		return nil, false
	}
	if math.IsNaN(number) || math.IsInf(number, 0) || number != math.Trunc(number) {
		return nil, false
	}
	if number < float64(minimum) || number > float64(maximum) {
		return nil, false
	}
	value := int(number)
	return &value, true
}

func rawOptionalTransform(raw json.RawMessage) (*string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil, true
	}
	value, ok := rawString(trimmed)
	if !ok || (value != "return" && value != "level") {
		return nil, false
	}
	return &value, true
}

func optionalString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// parseCorrelationFieldSelection mirrors CorrelationFieldSelectionSchema.
func parseCorrelationFieldSelection(raw string) (fieldA, fieldB string, ok bool) {
	var decoded struct {
		FieldA json.RawMessage `json:"fieldA"`
		FieldB json.RawMessage `json:"fieldB"`
	}
	if json.Unmarshal([]byte(raw), &decoded) != nil {
		return "", "", false
	}
	fieldA, okA := rawRequiredString(decoded.FieldA)
	fieldB, okB := rawRequiredString(decoded.FieldB)
	if !okA || !okB {
		return "", "", false
	}
	return fieldA, fieldB, true
}

// parseCorrelationSeriesSelection mirrors CorrelationSeriesSelectionSchema.
func parseCorrelationSeriesSelection(raw string) (slugA, slugB string, ok bool) {
	var decoded struct {
		SlugA json.RawMessage `json:"slugA"`
		SlugB json.RawMessage `json:"slugB"`
	}
	if json.Unmarshal([]byte(raw), &decoded) != nil {
		return "", "", false
	}
	slugA, okA := rawRequiredString(decoded.SlugA)
	slugB, okB := rawRequiredString(decoded.SlugB)
	if !okA || !okB {
		return "", "", false
	}
	return slugA, slugB, true
}
