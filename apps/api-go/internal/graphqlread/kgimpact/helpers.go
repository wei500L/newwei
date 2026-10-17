package kgimpact

import (
	"errors"
	"math"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

var (
	errMongoUnavailable    = errors.New("kgimpact: mongo database unavailable")
	errDatabaseUnavailable = errors.New("kgimpact: mysql unavailable")
)

func inputDate(input map[string]any, name string) (time.Time, bool) {
	value, state := contract.Lookup(input, name)
	if state != contract.ArgValue {
		return time.Time{}, false
	}
	text, ok := value.(string)
	if !ok {
		return time.Time{}, false
	}
	parsed, err := time.Parse(time.RFC3339Nano, text)
	if err != nil {
		return time.Time{}, false
	}
	return parsed, true
}

func inputFloatDefault(input map[string]any, name string, fallback float64) float64 {
	value, state := contract.Lookup(input, name)
	if state != contract.ArgValue {
		return fallback
	}
	if parsed, ok := contract.AsFloat(value); ok {
		return parsed
	}
	return fallback
}

func inputIntDefault(input map[string]any, name string, fallback int) int {
	value, state := contract.Lookup(input, name)
	if state != contract.ArgValue {
		return fallback
	}
	if parsed, ok := contract.AsInt(value); ok {
		return parsed
	}
	return fallback
}

func inputStringList(input map[string]any, name string) []string {
	value, state := contract.Lookup(input, name)
	if state != contract.ArgValue {
		return nil
	}
	list, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(list))
	for _, entry := range list {
		if text, ok := entry.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

func clampUnitInterval(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0.5
	}
	if value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}

// truncInt mirrors Math.trunc for an already-integer GraphQL Int.
func truncInt(value int) int {
	return value
}
