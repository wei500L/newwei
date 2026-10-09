package dashboardcharts

import (
	"encoding/json"
	"strings"
	"sync"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

const (
	sectorCategory     = "economic-short"
	candlestickSlug    = "sp500_index"
	heatmapColumns     = 4
	maxSectorCells     = 8
	fallbackWarning    = "SOURCE_FIELD_FALLBACK"
	candlestickCode    = "DASHBOARD_CANDLESTICK_FIELD_MAPPING_MISMATCH"
	candlestickDetail  = "No OHLC sourceField matched for this item in the requested range. Configure EconomicDataItem.metadata.dataViz.candlestick.ohlc."
	geoJSONErrorCode   = "GEOJSON_LOAD_FAILED"
	geoJSONErrorDetail = "Invalid GeoJSON payload"
)

var preferredSourceFields = []string{
	"close",
	"收盘价",
	"value",
	"current_value",
	"今值",
	"最新值",
	"latest_price",
	"最新价",
	"现价",
	"current_price",
	"最新",
	"美元",
}

var ohlcOrder = []string{"open", "high", "low", "close"}

var ohlcDefaults = map[string][]string{
	"open":  {"open", "开盘价", "今开"},
	"high":  {"high", "最高价", "最高"},
	"low":   {"low", "最低价", "最低"},
	"close": {"close", "收盘价", "最新价"},
}

var (
	localeCollator = collate.New(language.English)
	localeMu       sync.Mutex
)

type dataVizConfig struct {
	heatmapPreferred []string
	ohlc             map[string][]string
}

func decodeMetadata(raw json.RawMessage) any {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return value
}

func asObject(value any) (map[string]any, bool) {
	object, ok := value.(map[string]any)
	return object, ok && object != nil
}

func getDataViz(metadata any) dataVizConfig {
	object, ok := asObject(metadata)
	if !ok {
		return dataVizConfig{}
	}
	dataViz, ok := asObject(object["dataViz"])
	if !ok {
		return dataVizConfig{}
	}
	config := dataVizConfig{}
	if heatmap, ok := asObject(dataViz["heatmap"]); ok {
		config.heatmapPreferred = parseStringList(heatmap["preferredSourceFields"])
	}
	candlestick, ok := asObject(dataViz["candlestick"])
	if !ok {
		return config
	}
	ohlc, ok := asObject(candlestick["ohlc"])
	if !ok {
		return config
	}
	parsed := map[string][]string{}
	for _, field := range ohlcOrder {
		if list := parseStringList(ohlc[field]); len(list) > 0 {
			parsed[field] = list
		}
	}
	if len(parsed) > 0 {
		config.ohlc = parsed
	}
	return config
}

func parseStringList(value any) []string {
	switch typed := value.(type) {
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return nil
		}
		return []string{trimmed}
	case []any:
		var result []string
		for _, entry := range typed {
			text, ok := entry.(string)
			if !ok {
				continue
			}
			text = strings.TrimSpace(text)
			if text != "" {
				result = append(result, text)
			}
		}
		if len(result) == 0 {
			return nil
		}
		return result
	default:
		return nil
	}
}

func buildLabelMap(metadata any) map[string]string {
	labels := map[string]string{}
	object, ok := asObject(metadata)
	if !ok {
		return labels
	}
	parser, ok := asObject(object["parser"])
	if !ok {
		return labels
	}
	var entries []any
	if fields, ok := parser["valueFields"].([]any); ok {
		entries = append(entries, fields...)
	}
	if fields, ok := parser["seriesFields"].([]any); ok {
		entries = append(entries, fields...)
	}
	for _, entry := range entries {
		record, ok := asObject(entry)
		if !ok {
			continue
		}
		field, ok := record["field"].(string)
		if !ok {
			continue
		}
		field = strings.TrimSpace(field)
		if field == "" {
			continue
		}
		putLabel(labels, field, field)
		if label, ok := record["label"].(string); ok {
			label = strings.TrimSpace(label)
			if label != "" {
				putLabel(labels, label, field)
			}
		}
	}
	return labels
}

func putLabel(labels map[string]string, key, field string) {
	labels[key] = field
	labels[normalizeSourceFieldKey(key)] = field
}

func normalizeSourceFieldKey(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func uniqStrings(values []string) []string {
	seen := map[string]struct{}{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		result = append(result, trimmed)
	}
	return result
}

func sortLocale(values []string) {
	if len(values) < 2 {
		return
	}
	localeMu.Lock()
	defer localeMu.Unlock()
	// 比较器持有锁；sort 回调不能再加锁。
	for i := 1; i < len(values); i++ {
		current := values[i]
		j := i
		for j > 0 && localeCollator.CompareString(values[j-1], current) > 0 {
			values[j] = values[j-1]
			j--
		}
		values[j] = current
	}
}

func resolvePreferred(fields []string, preferred []string, labels map[string]string) string {
	exact := make(map[string]struct{}, len(fields))
	normalized := map[string]string{}
	for _, field := range fields {
		exact[field] = struct{}{}
		key := normalizeSourceFieldKey(field)
		if _, ok := normalized[key]; !ok {
			normalized[key] = field
		}
	}
	for _, key := range preferred {
		if _, ok := exact[key]; ok {
			return key
		}
		mapped := labels[key]
		if mapped == "" {
			mapped = labels[normalizeSourceFieldKey(key)]
		}
		if mapped != "" {
			if _, ok := exact[mapped]; ok {
				return mapped
			}
			if actual, ok := normalized[normalizeSourceFieldKey(mapped)]; ok {
				return actual
			}
		}
		if actual, ok := normalized[normalizeSourceFieldKey(key)]; ok {
			return actual
		}
	}
	return ""
}

func resolveFallback(fields []string, labels map[string]string) string {
	if len(fields) == 0 {
		return ""
	}
	if match := resolvePreferred(fields, preferredSourceFields, labels); match != "" {
		return match
	}
	sorted := append([]string(nil), fields...)
	sortLocale(sorted)
	return sorted[0]
}

func chooseHeatmapField(available []string, metadata any) (string, bool, []string) {
	sorted := append([]string(nil), available...)
	sortLocale(sorted)
	config := getDataViz(metadata)
	preferred := config.heatmapPreferred
	if len(preferred) == 0 {
		preferred = append([]string(nil), preferredSourceFields...)
	} else {
		preferred = uniqStrings(preferred)
	}
	labels := buildLabelMap(metadata)
	if field := resolvePreferred(sorted, preferred, labels); field != "" {
		return field, false, preferred
	}
	field := resolveFallback(sorted, labels)
	return field, field != "", preferred
}

func expandOHLC(metadata any) map[string][]string {
	config := getDataViz(metadata)
	labels := buildLabelMap(metadata)
	expanded := make(map[string][]string, len(ohlcOrder))
	for _, field := range ohlcOrder {
		merged := ohlcDefaults[field]
		if configured := config.ohlc[field]; len(configured) > 0 {
			merged = configured
		}
		var aliases []string
		for _, alias := range merged {
			aliases = append(aliases, alias)
			if mapped, ok := labels[alias]; ok {
				aliases = append(aliases, mapped)
			}
		}
		expanded[field] = uniqStrings(aliases)
	}
	return expanded
}

func flatOHLC(aliases map[string][]string) []string {
	var flat []string
	for _, field := range ohlcOrder {
		flat = append(flat, aliases[field]...)
	}
	return uniqStrings(flat)
}

type aliasIndex struct {
	fieldByNorm map[string]string
	rank        map[string]map[string]int
}

func indexAliases(aliases map[string][]string) aliasIndex {
	index := aliasIndex{
		fieldByNorm: map[string]string{},
		rank:        map[string]map[string]int{},
	}
	for _, field := range ohlcOrder {
		index.rank[field] = map[string]int{}
		for position, alias := range aliases[field] {
			normalized := normalizeSourceFieldKey(alias)
			if normalized == "" {
				continue
			}
			if _, ok := index.fieldByNorm[normalized]; !ok {
				index.fieldByNorm[normalized] = field
			}
			if _, ok := index.rank[field][normalized]; !ok {
				index.rank[field][normalized] = position
			}
		}
	}
	return index
}
