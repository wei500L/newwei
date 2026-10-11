package contentsubscriptions

import (
	"encoding/json"
	"regexp"
	"strings"
	"unicode/utf16"

	"github.com/wei500L/newwei/apps/api-go/internal/personalnews"
)

const (
	migrationSettingKey = "ai:content-subscription:migrated:v1"
	digestPreferenceKey = "ai:digest:preference:v1"
	legacyMonitorsKey   = "ui:situation-monitor:monitors:v1"

	catalogListLimit       = 200
	recommendationDefault  = 12
	relatedTopicDefault    = 8
	batchInputMax          = 100
	lookupInputMax         = 32
	maxManualMonitors      = 20
	maxKeywords            = 30
	maxApprovedTerms       = 36
	maxApprovedSuggestions = 24
	maxNameLen             = 64
	maxValueLen            = 128

	systemSyncMonitorName  = "Subscription Sync"
	systemSyncMonitorColor = "#9254de"

	lockTimeoutSeconds = 10
	requiredPermission = "items.read"
)

var (
	kindOrder = []string{
		personalnews.KindTopic,
		personalnews.KindEntity,
		personalnews.KindSource,
		personalnews.KindKeyword,
		personalnews.KindGeo,
	}
	sourceOrder = []string{
		personalnews.SourceManual,
		personalnews.SourceRecommendation,
		personalnews.SourceRelated,
		personalnews.SourceLegacy,
	}
	colorPattern = regexp.MustCompile(`(?i)^#[0-9a-f]{3}$|^#[0-9a-f]{6}$`)
	spacePattern = regexp.MustCompile(`\s+`)
)

type normalizedEntry struct {
	Kind            string
	NormalizedValue string
	DisplayValue    string
	Source          string
}

type counts struct {
	Topic   int `json:"topic"`
	Entity  int `json:"entity"`
	Source  int `json:"source"`
	Keyword int `json:"keyword"`
	Geo     int `json:"geo"`
}

func emptyCounts() counts { return counts{} }

func (c counts) get(kind string) int {
	switch kind {
	case personalnews.KindTopic:
		return c.Topic
	case personalnews.KindEntity:
		return c.Entity
	case personalnews.KindSource:
		return c.Source
	case personalnews.KindKeyword:
		return c.Keyword
	case personalnews.KindGeo:
		return c.Geo
	default:
		return 0
	}
}

func (c *counts) add(kind string, n int) {
	switch kind {
	case personalnews.KindTopic:
		c.Topic += n
	case personalnews.KindEntity:
		c.Entity += n
	case personalnews.KindSource:
		c.Source += n
	case personalnews.KindKeyword:
		c.Keyword += n
	case personalnews.KindGeo:
		c.Geo += n
	}
}

func (c *counts) set(kind string, n int) {
	switch kind {
	case personalnews.KindTopic:
		c.Topic = n
	case personalnews.KindEntity:
		c.Entity = n
	case personalnews.KindSource:
		c.Source = n
	case personalnews.KindKeyword:
		c.Keyword = n
	case personalnews.KindGeo:
		c.Geo = n
	}
}

type subscriptionItem struct {
	ID                  string          `json:"id"`
	Kind                string          `json:"kind"`
	NormalizedValue     string          `json:"normalizedValue"`
	DisplayValue        string          `json:"displayValue"`
	TaxonomyPath        *string         `json:"taxonomyPath"`
	TaxonomyDisplayName *string         `json:"taxonomyDisplayName"`
	TaxonomyLabels      []string        `json:"taxonomyLabels"`
	Source              string          `json:"source"`
	Metadata            json.RawMessage `json:"metadata"`
	CreatedAt           string          `json:"createdAt"`
	UpdatedAt           string          `json:"updatedAt"`
}

type ownedSubscriptionItem struct {
	subscriptionItem
	OwnerMonitorIds    []string `json:"ownerMonitorIds"`
	OwnerMonitorNames  []string `json:"ownerMonitorNames"`
	ManualMonitorOwned bool     `json:"manualMonitorOwned"`
	SystemSyncOwned    bool     `json:"systemSyncOwned"`
}

type listResponse struct {
	LimitPerKind    int    `json:"limitPerKind"`
	Counts          counts `json:"counts"`
	Items           []any  `json:"items"`
	TaxonomyVersion string `json:"taxonomyVersion"`
}

type batchItem struct {
	Kind                string   `json:"kind"`
	NormalizedValue     string   `json:"normalizedValue"`
	DisplayValue        string   `json:"displayValue"`
	TaxonomyPath        *string  `json:"taxonomyPath"`
	TaxonomyDisplayName *string  `json:"taxonomyDisplayName"`
	TaxonomyLabels      []string `json:"taxonomyLabels"`
	Status              string   `json:"status"`
}

type batchResponse struct {
	LimitPerKind int         `json:"limitPerKind"`
	Counts       counts      `json:"counts"`
	Items        []batchItem `json:"items"`
}

func subscriptionKey(kind, normalizedValue string) string {
	return kind + ":" + normalizedValue
}

func knownKind(kind string) bool {
	switch kind {
	case personalnews.KindTopic, personalnews.KindEntity, personalnews.KindSource, personalnews.KindKeyword, personalnews.KindGeo:
		return true
	default:
		return false
	}
}

func knownSource(source string) bool {
	switch source {
	case personalnews.SourceManual, personalnews.SourceRecommendation, personalnews.SourceRelated, personalnews.SourceLegacy:
		return true
	default:
		return false
	}
}

func normalizeDisplayValue(value string) string {
	value = strings.TrimSpace(value)
	value = spacePattern.ReplaceAllString(value, " ")
	return clipUTF16(value, maxValueLen)
}

func normalizeTerm(value string) string {
	return stringsToLower(normalizeDisplayValue(value))
}

func normalizeName(value string) string {
	return clipUTF16(strings.TrimSpace(value), maxNameLen)
}

func clipUTF16(value string, limit int) string {
	encoded := utf16.Encode([]rune(value))
	if len(encoded) <= limit {
		return value
	}
	return string(utf16.Decode(encoded[:limit]))
}

func utf16Len(value string) int {
	return len(utf16.Encode([]rune(value)))
}

func stringsToLower(value string) string { return strings.ToLower(value) }
func stringsToUpper(value string) string { return strings.ToUpper(value) }

// normalizeValue 对齐 service.normalizeValue。source 保留大小写；
// geo 走国家典范；其余种类把规范化值转成小写。
func normalizeValue(value, kind string) (normalizedValue, displayValue string) {
	if kind == personalnews.KindGeo {
		geo := canonicalizeGeoValue(value)
		return geo.NormalizedValue, geo.DisplayValue
	}
	displayValue = normalizeDisplayValue(value)
	if displayValue == "" {
		return "", ""
	}
	if kind == personalnews.KindSource {
		return displayValue, displayValue
	}
	return stringsToLower(displayValue), displayValue
}

// normalizeInputEntries 稳定去重：同 kind+normalizedValue 保留第一条。
func normalizeInputEntries(entries []normalizedEntry) []normalizedEntry {
	seen := make(map[string]struct{}, len(entries))
	out := make([]normalizedEntry, 0, len(entries))
	for _, entry := range entries {
		if !knownKind(entry.Kind) {
			continue
		}
		normalizedValue, displayValue := normalizeValue(entry.DisplayValue, entry.Kind)
		if normalizedValue == "" {
			continue
		}
		key := subscriptionKey(entry.Kind, normalizedValue)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		source := entry.Source
		out = append(out, normalizedEntry{
			Kind:            entry.Kind,
			NormalizedValue: normalizedValue,
			DisplayValue:    displayValue,
			Source:          source,
		})
	}
	return out
}

// normalizeStringArray 对齐迁移用的 focusTopics/focusEntities 清洗（无 kind，故小写去重）。
func normalizeStringArray(value any, limit int) []string {
	items, ok := value.([]any)
	if !ok {
		return []string{}
	}
	out := make([]string, 0, len(items))
	seen := make(map[string]struct{})
	for _, entry := range items {
		text, ok := entry.(string)
		if !ok {
			continue
		}
		normalizedValue, displayValue := normalizeValue(text, "")
		if normalizedValue == "" {
			continue
		}
		if _, exists := seen[normalizedValue]; exists {
			continue
		}
		seen[normalizedValue] = struct{}{}
		out = append(out, displayValue)
		if len(out) >= limit {
			break
		}
	}
	return out
}

func normalizeStringList(values []string, limit int) []string {
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{})
	for _, entry := range values {
		displayValue := normalizeDisplayValue(entry)
		normalized := stringsToLower(displayValue)
		if displayValue == "" {
			continue
		}
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		out = append(out, displayValue)
		if len(out) >= limit {
			break
		}
	}
	return out
}

func normalizeKeywordList(values []string) []string {
	split := make([]string, 0, len(values))
	for _, entry := range values {
		for _, part := range strings.Split(entry, ",") {
			split = append(split, part)
		}
	}
	return normalizeStringList(split, maxKeywords)
}

func normalizeColor(value any) (string, bool) {
	text, ok := value.(string)
	if !ok {
		return "", false
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return "", false
	}
	if !strings.HasPrefix(trimmed, "#") {
		trimmed = "#" + trimmed
	}
	if !colorPattern.MatchString(trimmed) {
		return "", false
	}
	return stringsToLower(trimmed), true
}

func taxonomyLabels(path string) []string {
	if path == "" {
		return []string{}
	}
	parts := strings.Split(path, "/")
	labels := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			labels = append(labels, part)
		}
	}
	return labels
}

func taxonomyDisplayName(path *string, view personalnews.TaxonomyView) *string {
	if path == nil || *path == "" {
		return nil
	}
	if node, ok := view.ByPath[*path]; ok {
		name := node.DisplayName
		return &name
	}
	name := *path
	return &name
}

func nullablePath(value string, valid bool) *string {
	if !valid {
		return nil
	}
	path := value
	return &path
}

func metadataJSON(raw []byte) json.RawMessage {
	trimmed := bytesTrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' || !json.Valid(trimmed) {
		return json.RawMessage("null")
	}
	return json.RawMessage(append([]byte(nil), trimmed...))
}

func bytesTrimSpace(raw []byte) []byte {
	return []byte(strings.TrimSpace(string(raw)))
}

func kindList() string   { return strings.Join(kindOrder, ", ") }
func sourceList() string { return strings.Join(sourceOrder, ", ") }
