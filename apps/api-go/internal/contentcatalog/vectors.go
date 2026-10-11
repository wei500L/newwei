package contentcatalog

import (
	"encoding/json"
	"math"
	"time"
)

func normalizeVector(vector []float64) []float64 {
	var sum float64
	for _, value := range vector {
		sum += value * value
	}
	magnitude := math.Sqrt(sum)
	if math.IsNaN(magnitude) || math.IsInf(magnitude, 0) || magnitude <= 0 {
		return nil
	}
	out := make([]float64, len(vector))
	for i, value := range vector {
		out[i] = value / magnitude
	}
	return out
}

func dot(a, b []float64) float64 {
	limit := len(a)
	if len(b) < limit {
		limit = len(b)
	}
	var total float64
	for i := 0; i < limit; i++ {
		total += a[i] * b[i]
	}
	return total
}

func parseVector(raw []byte) []float64 {
	if len(raw) == 0 {
		return nil
	}
	var items []any
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil
	}
	out := make([]float64, 0, len(items))
	for _, item := range items {
		number, ok := item.(float64)
		if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
			continue
		}
		out = append(out, number)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func parseMetadata(raw []byte) (map[string]any, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, false
	}
	record, ok := value.(map[string]any)
	if !ok || record == nil {
		return nil, false
	}
	return record, true
}

func isoTime(value time.Time) string {
	if value.IsZero() {
		value = time.Now()
	}
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

func mysqlTime(value time.Time) string {
	if value.IsZero() {
		value = time.Now()
	}
	return value.UTC().Format("2006-01-02 15:04:05.000")
}

func toPositiveInt(value any) int {
	switch typed := value.(type) {
	case int:
		if typed > 0 {
			return typed
		}
	case int32:
		if typed > 0 {
			return int(typed)
		}
	case int64:
		if typed > 0 {
			return int(typed)
		}
	case float64:
		if typed > 0 && !math.IsNaN(typed) && !math.IsInf(typed, 0) {
			return int(math.Round(typed))
		}
	case float32:
		if typed > 0 {
			return int(math.Round(float64(typed)))
		}
	}
	return 0
}
