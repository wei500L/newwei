package newsclassifier

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"

	"github.com/redis/go-redis/v9"
)

const (
	settingsCacheKeyPrefix  = "newsClassification:settings:"
	settingsCacheTTL        = 60 * time.Second
	settingsSystemKeyPrefix = "news_classification_settings:"

	defaultTaxonomyVersion = "news-taxonomy-v1"

	maxTaxonomyNodes      = 512
	maxTaxonomyPathLength = 160
	maxTaxonomyTextLength = 500
	maxListSize           = 50
	maxListItemLength     = 80
	minTopK               = 1
	maxTopK               = 100
	minTopN               = 1
	maxTopN               = 30
	minConfidence         = 0
	maxConfidence         = 1
	minCacheTTLSeconds    = 0
	maxCacheTTLSeconds    = 3600
)

var legacyCategories = map[string]struct{}{
	"politics": {}, "tech": {}, "finance": {}, "gov": {}, "ai": {}, "intel": {},
}

// defaultTaxonomy is DEFAULT_TAXONOMY in the same order.
var defaultTaxonomy = []TaxonomyNode{
	{
		Path: "tech/ai/model-release", DisplayName: "AI Model Release",
		Description:    "Announcements, launches, benchmarks, pricing, or capability updates for AI/LLM models.",
		LegacyCategory: "ai",
		Keywords:       []string{"model", "release", "llm", "gpt", "benchmark", "inference"},
		Synonyms:       []string{"model launch", "foundation model", "large language model"},
	},
	{
		Path: "tech/ai/policy-governance", DisplayName: "AI Policy",
		Description:    "Regulatory or governance developments specifically focused on AI deployment and safety.",
		LegacyCategory: "gov",
		Keywords:       []string{"ai act", "regulation", "safety", "governance", "compliance"},
		Synonyms:       []string{"ai regulation", "ai policy"},
	},
	{
		Path: "tech/cyber/security-incident", DisplayName: "Cyber Incident",
		Description:    "Cybersecurity breaches, ransomware, malware campaigns, data leaks, and incident response.",
		LegacyCategory: "intel",
		Keywords:       []string{"breach", "ransomware", "malware", "vulnerability", "exploit"},
		Synonyms:       []string{"cyber attack", "security incident", "data breach"},
	},
	{
		Path: "tech/semiconductor/supply-chain", DisplayName: "Semiconductor Supply Chain",
		Description:    "Chip manufacturing capacity, export controls, fab expansion, and upstream/downstream impacts.",
		LegacyCategory: "tech",
		Keywords:       []string{"semiconductor", "chip", "foundry", "fab", "export control"},
		Synonyms:       []string{"chip supply chain", "semiconductor policy"},
	},
	{
		Path: "finance/markets/equities", DisplayName: "Equity Markets",
		Description:    "Stock market moves, earnings reactions, analyst actions, and equity volatility events.",
		LegacyCategory: "finance",
		Keywords:       []string{"stock", "equity", "earnings", "nasdaq", "dow", "s&p"},
		Synonyms:       []string{"equity market", "stock market"},
	},
	{
		Path: "finance/macro/monetary-policy", DisplayName: "Monetary Policy",
		Description:    "Central bank decisions, rate guidance, inflation indicators, and macro policy interpretation.",
		LegacyCategory: "finance",
		Keywords:       []string{"fed", "fomc", "rate", "inflation", "cpi", "yield"},
		Synonyms:       []string{"interest rate policy", "central bank policy"},
	},
	{
		Path: "finance/crypto/market-move", DisplayName: "Crypto Market Move",
		Description:    "Major cryptocurrency price shocks, market structure events, and policy-driven crypto repricing.",
		LegacyCategory: "finance",
		Keywords:       []string{"bitcoin", "ethereum", "crypto", "token", "exchange"},
		Synonyms:       []string{"digital asset", "crypto market"},
	},
	{
		Path: "gov/regulation/enforcement", DisplayName: "Regulatory Enforcement",
		Description:    "Government enforcement actions, investigations, penalties, and compliance mandates.",
		LegacyCategory: "gov",
		Keywords:       []string{"sec", "doj", "investigation", "penalty", "enforcement"},
		Synonyms:       []string{"regulatory action", "compliance enforcement"},
	},
	{
		Path: "politics/geopolitics/conflict", DisplayName: "Geopolitical Conflict",
		Description:    "Armed conflict developments, sanctions escalation, ceasefire talks, and regional tensions.",
		LegacyCategory: "politics",
		Keywords:       []string{"conflict", "sanction", "ceasefire", "war", "airstrike"},
		Synonyms:       []string{"geopolitical tension", "regional conflict"},
	},
	{
		Path: "politics/election/domestic", DisplayName: "Election Dynamics",
		Description:    "Election campaigns, polling shifts, coalition changes, and institutional political dynamics.",
		LegacyCategory: "politics",
		Keywords:       []string{"election", "campaign", "parliament", "coalition", "vote"},
		Synonyms:       []string{"electoral politics", "political campaign"},
	},
	{
		Path: "intel/defense/military-operation", DisplayName: "Military Operation",
		Description:    "Defense operations, force movement, weapon system deployment, and military intelligence signals.",
		LegacyCategory: "intel",
		Keywords:       []string{"defense", "military", "drone", "missile", "operation"},
		Synonyms:       []string{"military activity", "defense intelligence"},
	},
	{
		Path: "intel/osint/analysis", DisplayName: "OSINT Signal",
		Description:    "Open-source intelligence findings and analytical assessments with security implications.",
		LegacyCategory: "intel",
		Keywords:       []string{"osint", "intelligence", "analysis", "satellite", "tracking"},
		Synonyms:       []string{"open-source intelligence", "intel assessment"},
	},
}

// SettingsStore reads the org-scoped classification settings through the same
// 60 second Redis cache and database fallback as NewsClassificationSettingsService.
type SettingsStore struct {
	db    *sql.DB
	redis *redis.Client
	now   func() time.Time
}

// NewSettingsStore wires the shared MySQL pool and Redis client.
func NewSettingsStore(db *sql.DB, redisClient *redis.Client) *SettingsStore {
	return &SettingsStore{db: db, redis: redisClient, now: time.Now}
}

// Get returns the effective settings. Like NestJS, a read failure degrades to
// the defaults instead of failing classification.
func (s *SettingsStore) Get(ctx context.Context, orgID string) Settings {
	defaults := fallbackSettings()
	key := settingsCacheKeyPrefix + orgID
	if s != nil && s.redis != nil {
		if raw, err := s.redis.Get(ctx, key).Bytes(); err == nil {
			var stored rawSettings
			if json.Unmarshal(raw, &stored) == nil {
				return normalizeSettings(stored, defaults)
			}
		}
	}
	settings := defaults
	if s != nil && s.db != nil {
		var raw []byte
		err := s.db.QueryRowContext(ctx, "SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", settingsSystemKeyPrefix+orgID).Scan(&raw)
		if err == nil {
			var stored rawSettings
			if json.Unmarshal(raw, &stored) == nil {
				settings = normalizeSettings(stored, defaults)
			}
		} else if !errors.Is(err, sql.ErrNoRows) {
			settings = defaults
		}
	}
	if s != nil && s.redis != nil {
		if encoded, err := json.Marshal(settings); err == nil {
			_ = s.redis.Set(ctx, key, encoded, settingsCacheTTL).Err()
		}
	}
	return settings
}

// rawSettings keeps every member raw so a wrong stored type degrades exactly
// like the NestJS normalize helpers.
type rawSettings struct {
	Enabled         json.RawMessage `json:"enabled"`
	StrictFail      json.RawMessage `json:"strictFail"`
	EnableLlm       json.RawMessage `json:"enableLlm"`
	EnableEmbedding json.RawMessage `json:"enableEmbedding"`
	EnableRerank    json.RawMessage `json:"enableRerank"`
	LLMModel        json.RawMessage `json:"llmModel"`
	MinConfidence   json.RawMessage `json:"minConfidence"`
	EmbeddingTopK   json.RawMessage `json:"embeddingTopK"`
	RerankTopN      json.RawMessage `json:"rerankTopN"`
	CacheTTLSeconds json.RawMessage `json:"cacheTtlSeconds"`
	TaxonomyVersion json.RawMessage `json:"taxonomyVersion"`
	Taxonomy        json.RawMessage `json:"taxonomy"`
}

func fallbackSettings() Settings {
	taxonomy := make([]TaxonomyNode, len(defaultTaxonomy))
	copy(taxonomy, defaultTaxonomy)
	return Settings{
		Enabled: true, StrictFail: true, EnableLlm: true, EnableEmbedding: true, EnableRerank: true,
		MinConfidence: 0.35, EmbeddingTopK: 12, RerankTopN: 6, CacheTTLSeconds: 60,
		TaxonomyVersion: defaultTaxonomyVersion, Taxonomy: taxonomy,
	}
}

func normalizeSettings(raw rawSettings, fallback Settings) Settings {
	return Settings{
		Enabled:         asBoolean(raw.Enabled, fallback.Enabled),
		StrictFail:      asBoolean(raw.StrictFail, fallback.StrictFail),
		EnableLlm:       asBoolean(raw.EnableLlm, fallback.EnableLlm),
		EnableEmbedding: asBoolean(raw.EnableEmbedding, fallback.EnableEmbedding),
		EnableRerank:    asBoolean(raw.EnableRerank, fallback.EnableRerank),
		LLMModel:        cleanNullableString(raw.LLMModel, 120, fallback.LLMModel),
		MinConfidence:   clampFloat(raw.MinConfidence, minConfidence, maxConfidence, fallback.MinConfidence),
		EmbeddingTopK:   clampInt(raw.EmbeddingTopK, minTopK, maxTopK, fallback.EmbeddingTopK),
		RerankTopN:      clampInt(raw.RerankTopN, minTopN, maxTopN, fallback.RerankTopN),
		CacheTTLSeconds: clampInt(raw.CacheTTLSeconds, minCacheTTLSeconds, maxCacheTTLSeconds, fallback.CacheTTLSeconds),
		TaxonomyVersion: firstNonEmpty(cleanString(raw.TaxonomyVersion, 64), fallback.TaxonomyVersion),
		Taxonomy:        normalizeTaxonomy(raw.Taxonomy, fallback.Taxonomy),
	}
}

// normalizeTaxonomy is normalizeTaxonomy: dedupe by normalized path, require a
// known legacy category, sort by path and fall back only when nothing valid
// survives.
func normalizeTaxonomy(raw json.RawMessage, fallback []TaxonomyNode) []TaxonomyNode {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return append([]TaxonomyNode{}, fallback...)
	}
	var entries []json.RawMessage
	if json.Unmarshal(trimmed, &entries) != nil || len(entries) == 0 {
		return append([]TaxonomyNode{}, fallback...)
	}
	dedup := make(map[string]TaxonomyNode, len(entries))
	order := make([]string, 0, len(entries))
	for _, entry := range entries {
		var record struct {
			Path           json.RawMessage `json:"path"`
			DisplayName    json.RawMessage `json:"displayName"`
			Description    json.RawMessage `json:"description"`
			LegacyCategory json.RawMessage `json:"legacyCategory"`
			Keywords       json.RawMessage `json:"keywords"`
			Synonyms       json.RawMessage `json:"synonyms"`
		}
		if json.Unmarshal(entry, &record) != nil {
			continue
		}
		path := normalizeTaxonomyPath(record.Path)
		if path == "" {
			continue
		}
		legacy := normalizeLegacyCategory(record.LegacyCategory)
		if legacy == "" {
			continue
		}
		displayName := firstNonEmpty(cleanString(record.DisplayName, maxTaxonomyTextLength), path)
		node := TaxonomyNode{
			Path:           path,
			DisplayName:    displayName,
			Description:    cleanString(record.Description, maxTaxonomyTextLength),
			LegacyCategory: legacy,
			Keywords:       normalizeStringList(record.Keywords),
			Synonyms:       normalizeStringList(record.Synonyms),
		}
		if _, exists := dedup[path]; !exists {
			order = append(order, path)
		}
		dedup[path] = node
		if len(dedup) >= maxTaxonomyNodes {
			break
		}
	}
	if len(dedup) == 0 {
		return append([]TaxonomyNode{}, fallback...)
	}
	out := make([]TaxonomyNode, 0, len(dedup))
	for _, path := range order {
		out = append(out, dedup[path])
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

func normalizeTaxonomyPath(raw json.RawMessage) string {
	value := stringValueRaw(raw)
	if value == "" {
		return ""
	}
	trimmed := strings.ToLower(jsTrim(value))
	var builder strings.Builder
	previousWhitespace := false
	for _, r := range trimmed {
		if r == '\\' {
			builder.WriteByte('/')
			previousWhitespace = false
			continue
		}
		if isJSWhitespace(r) {
			if !previousWhitespace {
				builder.WriteByte('-')
				previousWhitespace = true
			}
			continue
		}
		builder.WriteRune(r)
		previousWhitespace = false
	}
	normalized := builder.String()
	for strings.Contains(normalized, "//") {
		normalized = strings.ReplaceAll(normalized, "//", "/")
	}
	normalized = strings.Trim(normalized, "/")
	if normalized == "" || utf16Length(normalized) > maxTaxonomyPathLength {
		return ""
	}
	return normalized
}

func normalizeLegacyCategory(raw json.RawMessage) string {
	value := strings.ToLower(strings.TrimSpace(stringValueRaw(raw)))
	if _, ok := legacyCategories[value]; !ok {
		return ""
	}
	return value
}

// normalizeStringList is normalizeStringList: clean each entry, dedupe in first
// seen order and stop at the list cap.
func normalizeStringList(raw json.RawMessage) []string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return []string{}
	}
	var values []json.RawMessage
	if json.Unmarshal(trimmed, &values) != nil {
		return []string{}
	}
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		cleaned := cleanString(value, maxListItemLength)
		if cleaned == "" {
			continue
		}
		if _, ok := seen[cleaned]; ok {
			continue
		}
		seen[cleaned] = struct{}{}
		out = append(out, cleaned)
		if len(out) >= maxListSize {
			break
		}
	}
	return out
}

func asBoolean(raw json.RawMessage, fallback bool) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return fallback
	}
	var value bool
	if json.Unmarshal(trimmed, &value) != nil {
		return fallback
	}
	return value
}

func cleanString(raw json.RawMessage, maxLength int) string {
	if len(bytes.TrimSpace(raw)) == 0 || bytes.TrimSpace(raw)[0] != '"' {
		return ""
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return ""
	}
	trimmed := jsTrim(value)
	if trimmed == "" {
		return ""
	}
	return truncateUTF16(trimmed, maxLength)
}

func cleanNullableString(raw json.RawMessage, maxLength int, fallback string) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return fallback
	}
	if bytes.Equal(trimmed, []byte("null")) {
		return ""
	}
	cleaned := cleanString(raw, maxLength)
	if cleaned == "" {
		return fallback
	}
	return cleaned
}

func clampInt(raw json.RawMessage, minimum, maximum, fallback int) int {
	value, ok := numberValue(raw)
	if !ok || math.IsNaN(value) {
		return fallback
	}
	rounded := math.Round(value)
	if rounded < float64(minimum) {
		return minimum
	}
	if rounded > float64(maximum) {
		return maximum
	}
	return int(rounded)
}

func clampFloat(raw json.RawMessage, minimum, maximum, fallback float64) float64 {
	value, ok := numberValue(raw)
	if !ok || math.IsNaN(value) {
		return fallback
	}
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

func numberValue(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	var number float64
	if json.Unmarshal(trimmed, &number) == nil {
		return number, true
	}
	var text string
	if json.Unmarshal(trimmed, &text) == nil {
		parsed, err := json.Number(jsTrim(text)).Float64()
		if err != nil {
			return 0, false
		}
		return parsed, true
	}
	return 0, false
}

func stringValueRaw(raw json.RawMessage) string {
	if len(bytes.TrimSpace(raw)) == 0 || bytes.TrimSpace(raw)[0] != '"' {
		return ""
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return ""
	}
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// jsTrim reproduces String.prototype.trim: Unicode whitespace plus U+FEFF.
func jsTrim(value string) string {
	return strings.TrimFunc(value, func(r rune) bool {
		return r == '\uFEFF' || unicode.IsSpace(r)
	})
}

func isJSWhitespace(r rune) bool {
	return r == '\uFEFF' || unicode.IsSpace(r)
}

func utf16Length(value string) int {
	return len(utf16.Encode([]rune(value)))
}

func truncateUTF16(value string, limit int) string {
	units := utf16.Encode([]rune(value))
	if len(units) <= limit {
		return value
	}
	return string(utf16.Decode(units[:limit]))
}
