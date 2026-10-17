package knowledgegraph

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"time"

	"github.com/redis/go-redis/v9"
)

type service struct {
	db    *sql.DB
	redis *redis.Client
	now   func() time.Time
}

func (s *service) clock() time.Time {
	if s != nil && s.now != nil {
		return s.now()
	}
	return time.Now()
}

func (s *service) call(ctx context.Context) context.Context {
	if ctx != nil {
		return ctx
	}
	return context.Background()
}

func (s *service) healthy() bool {
	return s != nil && s.db != nil
}

type entityRow struct {
	ID            string
	Type          string
	CanonicalName string
	Properties    []byte
}

func (row entityRow) node() KnowledgeGraphNodeModel {
	return KnowledgeGraphNodeModel{
		ID:         row.ID,
		Name:       row.CanonicalName,
		Type:       row.Type,
		Properties: decodeJSON(row.Properties),
	}
}

type edgeRow struct {
	ID         string
	From       string
	To         string
	Type       string
	Weight     float64
	Confidence float64
	Properties []byte
}

func (row edgeRow) model() KnowledgeGraphEdgeModel {
	return KnowledgeGraphEdgeModel{
		ID:         row.ID,
		From:       row.From,
		To:         row.To,
		Type:       row.Type,
		Weight:     row.Weight,
		Confidence: row.Confidence,
		Properties: decodeJSON(row.Properties),
	}
}

func decodeJSON(raw []byte) any {
	if len(raw) == 0 {
		return nil
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	return value
}

func decodeJSONObject(raw []byte) any {
	if len(raw) == 0 {
		return nil
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	if _, ok := value.(map[string]any); !ok {
		return nil
	}
	return value
}

func nullString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	copied := value.String
	return &copied
}

func nullFloat(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	copied := value.Float64
	return &copied
}

func nullTime(value sql.NullTime) *time.Time {
	if !value.Valid {
		return nil
	}
	copied := value.Time
	return &copied
}

// jsRound matches JavaScript Math.round (half rounds toward +Infinity).
func jsRound(value float64) float64 {
	return math.Floor(value + 0.5)
}

// clampIntArg mirrors KnowledgeGraphIntelligenceService.clampInteger.
func clampIntArg(value any, minimum, maximum, fallback int) int {
	number, ok := settingNumber(value)
	if !ok {
		return fallback
	}
	rounded := int(jsRound(number))
	if rounded < minimum {
		return minimum
	}
	if rounded > maximum {
		return maximum
	}
	return rounded
}

func placeholders(count int) string {
	if count <= 0 {
		return ""
	}
	out := make([]byte, 0, count*2-1)
	for i := 0; i < count; i++ {
		if i > 0 {
			out = append(out, ',')
		}
		out = append(out, '?')
	}
	return string(out)
}

func stringArgs(values []string) []any {
	out := make([]any, len(values))
	for i, value := range values {
		out[i] = value
	}
	return out
}
