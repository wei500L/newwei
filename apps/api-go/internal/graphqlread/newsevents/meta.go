package newsevents

import (
	"encoding/json"
	"math"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

type timelineBag struct {
	CategoryDistribution json.RawMessage `json:"categoryDistribution"`
	PhaseSummaries       json.RawMessage `json:"phaseSummaries"`
	SubEvents            json.RawMessage `json:"subEvents"`
	TopicDriftWarning    json.RawMessage `json:"topicDriftWarning"`
	TopicDriftSummary    json.RawMessage `json:"topicDriftSummary"`
	Entries              json.RawMessage `json:"entries"`
}

func metadataValue(raw json.RawMessage) any {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	return json.RawMessage(append([]byte(nil), raw...))
}

func timelineFromMetadata(raw json.RawMessage) timelineBag {
	if len(raw) == 0 || string(raw) == "null" {
		return timelineBag{}
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal(raw, &root); err != nil || root == nil {
		return timelineBag{}
	}
	timeline := root["timeline"]
	if len(timeline) == 0 || string(timeline) == "null" || timeline[0] != '{' {
		return timelineBag{}
	}
	var bag timelineBag
	if err := json.Unmarshal(timeline, &bag); err != nil {
		return timelineBag{}
	}
	return bag
}

func jsonArray(raw json.RawMessage) any {
	if len(raw) == 0 || string(raw) == "null" || raw[0] != '[' {
		return nil
	}
	return json.RawMessage(append([]byte(nil), raw...))
}

func jsonBool(raw json.RawMessage) *bool {
	if string(raw) == "true" {
		value := true
		return &value
	}
	if string(raw) == "false" {
		value := false
		return &value
	}
	return nil
}

func jsonString(raw json.RawMessage) *string {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return nil
	}
	return &text
}

func driftFields(bag timelineBag) (distribution any, warning *bool, summary *string, phases any, subEvents any) {
	distribution = jsonArray(bag.CategoryDistribution)
	warning = jsonBool(bag.TopicDriftWarning)
	summary = jsonString(bag.TopicDriftSummary)
	phases = jsonArray(bag.PhaseSummaries)
	subEvents = jsonArray(bag.SubEvents)
	if subEvents == nil {
		subEvents = phases
	}
	return distribution, warning, summary, phases, subEvents
}

type entryMeta struct {
	CategoryPath       *string
	CategoryConfidence *float64
	Tentative          *bool
	Anchor             *bool
}

func timelineEntryMeta(bag timelineBag, bucket time.Time) entryMeta {
	if len(bag.Entries) == 0 || string(bag.Entries) == "null" || bag.Entries[0] != '{' {
		return entryMeta{}
	}
	var entries map[string]json.RawMessage
	if err := json.Unmarshal(bag.Entries, &entries); err != nil {
		return entryMeta{}
	}
	raw := entries[contract.FormatDateTime(bucket.UTC())]
	if len(raw) == 0 || string(raw) == "null" || raw[0] != '{' {
		return entryMeta{}
	}
	var record map[string]any
	if err := json.Unmarshal(raw, &record); err != nil {
		return entryMeta{}
	}
	out := entryMeta{}
	if text, ok := record["categoryPath"].(string); ok && strings.TrimSpace(text) != "" {
		trimmed := strings.TrimSpace(text)
		out.CategoryPath = &trimmed
	}
	if number, ok := record["categoryConfidence"].(float64); ok && !math.IsNaN(number) && !math.IsInf(number, 0) {
		clamped := number
		if clamped < 0 {
			clamped = 0
		}
		if clamped > 1 {
			clamped = 1
		}
		out.CategoryConfidence = &clamped
	}
	if value, ok := record["tentative"].(bool); ok {
		out.Tentative = &value
	}
	if value, ok := record["anchor"].(bool); ok {
		out.Anchor = &value
	}
	return out
}

var legacyCategories = map[string]struct{}{
	"politics": {},
	"tech":     {},
	"finance":  {},
	"gov":      {},
	"ai":       {},
	"intel":    {},
}

func normalizeLegacyCategory(value string) *string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" {
		return nil
	}
	if _, ok := legacyCategories[normalized]; !ok {
		return nil
	}
	return &normalized
}

func normalizeCategoryPath(value string) *string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	normalized = strings.ReplaceAll(normalized, "\\", "/")
	normalized = strings.Join(strings.Fields(normalized), "-")
	for strings.Contains(normalized, "//") {
		normalized = strings.ReplaceAll(normalized, "//", "/")
	}
	normalized = strings.Trim(normalized, "/")
	if normalized == "" {
		return nil
	}
	return &normalized
}

type categoryEntry struct {
	CategoryPath   string  `json:"categoryPath"`
	LegacyCategory *string `json:"legacyCategory"`
	Count          int     `json:"count"`
	Share          float64 `json:"share"`
}
