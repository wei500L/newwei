package newsevents

import (
	"math"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

func optionalInt(args map[string]any, name string, fallback, min, max int) int {
	value, state := contract.Lookup(args, name)
	if state != contract.ArgValue {
		return clampInt(fallback, min, max)
	}
	number, ok := contract.AsInt(value)
	if !ok {
		return clampInt(fallback, min, max)
	}
	return clampInt(number, min, max)
}

// authorityWindowDays follows getEventAuthorityMap: a missing argument is 45,
// not the list window of 30.
func authorityWindowDays(args map[string]any) int {
	value, state := contract.Lookup(args, "windowDays")
	if state != contract.ArgValue {
		return 45
	}
	number, ok := contract.AsInt(value)
	if !ok {
		return 45
	}
	return clampInt(number, 1, 365)
}

func clampInt(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func floatArg(args map[string]any, name string) (float64, bool) {
	value, state := contract.Lookup(args, name)
	if state != contract.ArgValue {
		return 0, false
	}
	number, ok := contract.AsFloat(value)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
		return 0, false
	}
	return number, true
}

func boolArg(args map[string]any, name string) (bool, bool) {
	value, state := contract.Lookup(args, name)
	if state != contract.ArgValue {
		return false, false
	}
	typed, ok := value.(bool)
	return typed, ok
}

func stringListArg(args map[string]any, name string) []string {
	value, state := contract.Lookup(args, name)
	if state != contract.ArgValue {
		return nil
	}
	switch typed := value.(type) {
	case []string:
		return append([]string(nil), typed...)
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			text, ok := item.(string)
			if ok {
				out = append(out, text)
			}
		}
		return out
	default:
		return nil
	}
}

func clipUTF16(value string, limit int) string {
	if limit <= 0 || value == "" {
		return ""
	}
	units := utf16.Encode([]rune(value))
	if len(units) <= limit {
		return value
	}
	return string(utf16.Decode(units[:limit]))
}

func roundHalfAway(value float64) int {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	if value >= 0 {
		return int(math.Floor(value + 0.5))
	}
	return int(math.Ceil(value - 0.5))
}

func settingNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return 0, false
		}
		return typed, true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return 0, false
		}
		parsed, err := strconv.ParseFloat(trimmed, 64)
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

func clampSettingInt(value any, min, max, fallback int) int {
	number, ok := settingNumber(value)
	if !ok {
		return fallback
	}
	rounded := roundHalfAway(number)
	return clampInt(rounded, min, max)
}
