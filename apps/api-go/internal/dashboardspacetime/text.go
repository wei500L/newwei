package dashboardspacetime

import (
	"math"
	"strconv"
	"strings"
	"sync"
	"unicode/utf16"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

var (
	localeOnce sync.Once
	localeColl *collate.Collator
	localeMu   sync.Mutex
)

// localeCompare 对齐 JavaScript 默认 localeCompare 的英文校对顺序。
// 快照键和候选排序都用它，保证 JSON.stringify 前的插入顺序一致。
func localeCompare(a, b string) int {
	localeOnce.Do(func() {
		localeColl = collate.New(language.English)
	})
	localeMu.Lock()
	defer localeMu.Unlock()
	return localeColl.CompareString(a, b)
}

func jsLen(value string) int {
	return len(utf16.Encode([]rune(value)))
}

func clipUnits(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	units := 0
	for index, r := range value {
		need := 1
		if r > 0xFFFF {
			need = 2
		}
		if units+need > limit {
			return value[:index]
		}
		units += need
	}
	return value
}

func jsRound(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return value
	}
	floor := math.Floor(value)
	diff := value - floor
	if diff >= 0.5 {
		return floor + 1
	}
	return floor
}

func clampFinite(value, min, max float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return min
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func roundToStep(value, step float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) || math.IsNaN(step) || math.IsInf(step, 0) || step <= 0 {
		return value
	}
	return jsRound(value/step) * step
}

func heatNumber(value float64) string {
	rounded := jsRound(value*10000) / 10000
	text := strconv.FormatFloat(rounded, 'f', 4, 64)
	text = strings.TrimRight(strings.TrimRight(text, "0"), ".")
	if text == "" || text == "-" || text == "-0" {
		return "0"
	}
	return text
}

func normalizeLocationCandidate(input string) string {
	input = strings.NewReplacer("\r", " ", "\n", " ", "\t", " ").Replace(strings.TrimSpace(input))
	return clipUnits(strings.Join(strings.Fields(input), " "), 200)
}

func normalizeLocationGroupKey(input string) string {
	trimmed := normalizeLocationCandidate(input)
	primary := trimmed
	if index := strings.IndexAny(trimmed, ",;/|"); index >= 0 {
		primary = strings.TrimSpace(trimmed[:index])
	}
	if primary == "" {
		primary = trimmed
	}
	return clipUnits(primary, 120)
}

func clusterKey(lat, lng float64) (string, float64, float64) {
	lat = roundToStep(clampFinite(lat, -90, 90), clusterStep)
	lng = roundToStep(clampFinite(lng, -180, 180), clusterStep)
	if lat == 0 {
		lat = math.Abs(lat)
	}
	if lng == 0 {
		lng = math.Abs(lng)
	}
	return strconv.FormatFloat(lat, 'f', 3, 64) + ":" + strconv.FormatFloat(lng, 'f', 3, 64), lat, lng
}

func jsNumber(raw string) (float64, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, true
	}
	parsed, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, false
	}
	return parsed, true
}

func normalizePointID(raw string) (string, bool) {
	parts := strings.Split(raw, ":")
	if len(parts) != 2 {
		return "", false
	}
	lat, okLat := jsNumber(parts[0])
	lng, okLng := jsNumber(parts[1])
	if !okLat || !okLng {
		return "", false
	}
	key, _, _ := clusterKey(lat, lng)
	return key, true
}
