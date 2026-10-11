package history

import (
	"encoding/json"
	"math"
	"strings"
	"unicode"
)

func jsTrim(value string) string {
	return strings.TrimFunc(value, jsTrimRune)
}

func jsTrimRune(r rune) bool {
	switch r {
	case '\u0009', '\u000A', '\u000B', '\u000C', '\u000D', '\u0020', '\u00A0', '\uFEFF', '\u2028', '\u2029':
		return true
	default:
		return unicode.Is(unicode.Zs, r)
	}
}

func utf16Len(value string) int {
	count := 0
	for _, r := range value {
		count++
		if r > 0xFFFF {
			count++
		}
	}
	return count
}

func jsTruthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case float64:
		return typed != 0 && !math.IsNaN(typed)
	case float32:
		return typed != 0 && !math.IsNaN(float64(typed))
	case int:
		return typed != 0
	case int32:
		return typed != 0
	case int64:
		return typed != 0
	case json.Number:
		parsed, err := typed.Float64()
		return err == nil && parsed != 0 && !math.IsNaN(parsed)
	default:
		return true
	}
}

func stringPtr(value string) *string {
	copied := value
	return &copied
}

func nonemptyPtr(value string) *string {
	if value == "" {
		return nil
	}
	return stringPtr(value)
}
