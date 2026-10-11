package situationmonitors

import (
	"database/sql"
	"encoding/json"
	"math"
	"strings"
	"time"
)

type rejectedState struct {
	Topics       []string `json:"topics"`
	Entities     []string `json:"entities"`
	LexicalTerms []string `json:"lexicalTerms"`
}

type bounds struct {
	MinLat float64 `json:"minLat"`
	MaxLat float64 `json:"maxLat"`
	MinLng float64 `json:"minLng"`
	MaxLng float64 `json:"maxLng"`
}

type locationDTO struct {
	Name              string  `json:"name"`
	Lat               float64 `json:"lat"`
	Lng               float64 `json:"lng"`
	Bounds            *bounds `json:"bounds,omitempty"`
	CountryCodeAlpha2 string  `json:"countryCodeAlpha2,omitempty"`
}

type storedMonitor struct {
	ID                   string        `json:"id"`
	Kind                 string        `json:"kind"`
	Name                 string        `json:"name"`
	Enabled              bool          `json:"enabled"`
	Color                string        `json:"color,omitempty"`
	RawKeywords          []string      `json:"rawKeywords"`
	ApprovedTopics       []string      `json:"approvedTopics"`
	ApprovedEntities     []string      `json:"approvedEntities"`
	ApprovedSources      []string      `json:"approvedSources"`
	ApprovedGeos         []string      `json:"approvedGeos"`
	ApprovedLexicalTerms []string      `json:"approvedLexicalTerms"`
	RejectedSuggestions  rejectedState `json:"rejectedSuggestions"`
	Location             *locationDTO  `json:"location,omitempty"`
	QueryEmbeddingModel  string        `json:"queryEmbeddingModel,omitempty"`
	QueryEmbeddingVector []float64     `json:"queryEmbeddingVector,omitempty"`
	CreatedAt            string        `json:"createdAt"`
	UpdatedAt            string        `json:"updatedAt"`
	LastResolvedAt       string        `json:"lastResolvedAt,omitempty"`
}

type monitorRow struct {
	ID               string
	Kind             string
	Name             string
	Enabled          bool
	Color            sql.NullString
	RawKeywords      []byte
	ApprovedTopics   []byte
	ApprovedEntities []byte
	ApprovedSources  []byte
	ApprovedGeos     []byte
	ApprovedLexical  []byte
	Rejected         []byte
	LocationName     sql.NullString
	LocationLat      sql.NullFloat64
	LocationLng      sql.NullFloat64
	LocationBounds   []byte
	LocationCountry  sql.NullString
	EmbeddingModel   sql.NullString
	EmbeddingVector  []byte
	LastResolved     sql.NullTime
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

func mapRow(row monitorRow) storedMonitor {
	color, _ := normalizeColor(row.Color.String)
	if !row.Color.Valid {
		color = ""
	}
	out := storedMonitor{
		ID:                   row.ID,
		Kind:                 row.Kind,
		Name:                 normalizeName(row.Name),
		Enabled:              row.Enabled,
		Color:                color,
		RawKeywords:          parseStringArray(row.RawKeywords, maxKeywords),
		ApprovedTopics:       parseStringArray(row.ApprovedTopics, maxApprovedSuggestions),
		ApprovedEntities:     parseStringArray(row.ApprovedEntities, maxApprovedSuggestions),
		ApprovedSources:      parseStringArray(row.ApprovedSources, maxApprovedSuggestions),
		ApprovedGeos:         parseStringArray(row.ApprovedGeos, maxApprovedSuggestions),
		ApprovedLexicalTerms: parseStringArray(row.ApprovedLexical, maxApprovedTerms),
		RejectedSuggestions:  parseRejected(row.Rejected),
		CreatedAt:            isoTime(row.CreatedAt),
		UpdatedAt:            isoTime(row.UpdatedAt),
	}
	if loc := parseLocation(row); loc != nil {
		out.Location = loc
	}
	if row.EmbeddingModel.Valid {
		if model := stringsTrim(row.EmbeddingModel.String); model != "" {
			out.QueryEmbeddingModel = model
		}
	}
	if vector := parseNumberArray(row.EmbeddingVector); len(vector) > 0 {
		out.QueryEmbeddingVector = vector
	}
	if row.LastResolved.Valid {
		out.LastResolvedAt = isoTime(row.LastResolved.Time)
	}
	return out
}

func stringsTrim(value string) string {
	return strings.TrimSpace(value)
}

func isoTime(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

func emptyRejected() rejectedState {
	return rejectedState{Topics: []string{}, Entities: []string{}, LexicalTerms: []string{}}
}

func parseStringArray(raw []byte, limit int) []string {
	values := asStrings(raw)
	if values == nil {
		return []string{}
	}
	return normalizeStringList(values, limit)
}

func parseRejected(raw []byte) rejectedState {
	record := asObject(raw)
	return rejectedState{
		Topics:       lowerList(asStringList(record["topics"]), maxApprovedSuggestions),
		Entities:     lowerList(asStringList(record["entities"]), maxApprovedSuggestions),
		LexicalTerms: lowerList(asStringList(record["lexicalTerms"]), maxApprovedTerms),
	}
}

func lowerList(values []string, limit int) []string {
	normalized := normalizeStringList(values, limit)
	out := make([]string, 0, len(normalized))
	for _, entry := range normalized {
		out = append(out, stringsToLower(entry))
	}
	if out == nil {
		out = []string{}
	}
	return out
}

func stringsToLower(value string) string { return normalizeTerm(value) }

func parseLocation(row monitorRow) *locationDTO {
	if !row.LocationName.Valid || !row.LocationLat.Valid || !row.LocationLng.Valid {
		return nil
	}
	name := normalizeName(row.LocationName.String)
	if name == "" || !finite(row.LocationLat.Float64) || !finite(row.LocationLng.Float64) {
		return nil
	}
	loc := &locationDTO{Name: name, Lat: row.LocationLat.Float64, Lng: row.LocationLng.Float64}
	if parsed := parseBounds(row.LocationBounds); parsed != nil {
		loc.Bounds = parsed
	}
	if row.LocationCountry.Valid {
		loc.CountryCodeAlpha2 = row.LocationCountry.String
	}
	return loc
}

func parseBounds(raw []byte) *bounds {
	record := asObject(raw)
	minLat, minOK := asFinite(record["minLat"])
	maxLat, maxOK := asFinite(record["maxLat"])
	minLng, minLngOK := asFinite(record["minLng"])
	maxLng, maxLngOK := asFinite(record["maxLng"])
	if !minOK || !maxOK || !minLngOK || !maxLngOK {
		return nil
	}
	return &bounds{MinLat: minLat, MaxLat: maxLat, MinLng: minLng, MaxLng: maxLng}
}

func parseNumberArray(raw []byte) []float64 {
	if len(raw) == 0 {
		return nil
	}
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil
	}
	return finiteNumbers(parsed)
}

func asObject(raw []byte) map[string]any {
	if len(raw) == 0 {
		return nil
	}
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil
	}
	record, _ := parsed.(map[string]any)
	return record
}

func asStrings(raw []byte) []string {
	if len(raw) == 0 {
		return nil
	}
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil
	}
	return asStringList(parsed)
}

func asStringList(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if ok {
			out = append(out, text)
		}
	}
	return out
}

func asFinite(value any) (float64, bool) {
	number, ok := value.(float64)
	if !ok || !finite(number) {
		return 0, false
	}
	return number, true
}

func finiteNumbers(value any) []float64 {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]float64, 0, len(items))
	for _, item := range items {
		number, ok := asFinite(item)
		if ok {
			out = append(out, number)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func finite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

func jsonArray(values []string) []byte {
	if values == nil {
		values = []string{}
	}
	encoded, err := json.Marshal(values)
	if err != nil {
		return []byte("[]")
	}
	return encoded
}

func mustJSON(value any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		return []byte("{}")
	}
	return encoded
}
