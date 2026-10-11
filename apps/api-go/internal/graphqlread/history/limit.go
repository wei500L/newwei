package history

import (
	"encoding/json"
	"errors"
	"math"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

func runLimit(args map[string]any) (int, error) {
	limit, err := limitOrDefault(args, 50, true)
	if err != nil {
		return 0, err
	}
	if limit > 100 {
		limit = 100
	}
	if limit < 1 {
		limit = 1
	}
	return limit, nil
}

func suggestionLimit(args map[string]any) (int, error) {
	limit, err := limitOrDefault(args, 8, false)
	if err != nil {
		return 0, err
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 20 {
		limit = 20
	}
	return limit, nil
}

// notificationTake matches NotificationResolver: Math.min(limit ?? 20, 50).
// Null and omission are 20. Values above 50 become 50. Zero and negatives are
// passed through; Prisma findMany treats a negative take as the tail of the
// requested order. This path must not invent a 400 for those values.
func notificationTake(args map[string]any) (int, error) {
	value, state := contract.Lookup(args, "limit")
	if state != contract.ArgValue || value == nil {
		return 20, nil
	}
	limit, ok := contract.AsInt(value)
	if !ok {
		return 0, errors.New("limit must be an integer")
	}
	if limit > 50 {
		limit = 50
	}
	return limit, nil
}

func limitOrDefault(args map[string]any, fallback int, trunc bool) (int, error) {
	value, state := contract.Lookup(args, "limit")
	if state != contract.ArgValue {
		return fallback, nil
	}
	if trunc {
		number, ok := truncInt(value)
		if !ok {
			return 0, errors.New("limit must be an integer")
		}
		return number, nil
	}
	number, ok := contract.AsInt(value)
	if !ok {
		return 0, errors.New("limit must be an integer")
	}
	return number, nil
}

func truncInt(value any) (int, bool) {
	if number, ok := contract.AsInt(value); ok {
		return number, true
	}
	var parsed float64
	switch typed := value.(type) {
	case float64:
		parsed = typed
	case float32:
		parsed = float64(typed)
	case json.Number:
		var err error
		parsed, err = typed.Float64()
		if err != nil {
			return 0, false
		}
	default:
		return 0, false
	}
	if math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, false
	}
	parsed = math.Trunc(parsed)
	if parsed > float64(math.MaxInt) || parsed < float64(math.MinInt) {
		return 0, false
	}
	return int(parsed), true
}
