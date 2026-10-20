package newsclassifier

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

const (
	sourcePolicySystemKeyPrefix            = "news_event_source_policy:"
	sourcePolicyCategoryAuthorityKeyPrefix = "news_event_source_policy_category_authority:"
	sourcePolicyCacheKeyPrefix             = "newsClassification:sourcePolicy:"
	sourcePolicyCacheTTL                   = 60 * time.Second
)

type categoryAuthorityDomainBoost struct {
	Domain string  `json:"domain"`
	Delta  float64 `json:"delta"`
}

type categoryAuthorityRule struct {
	CategoryPrefix     string                         `json:"categoryPrefix"`
	AuthoritativeBoost float64                        `json:"authoritativeBoost"`
	BlogPenalty        float64                        `json:"blogPenalty"`
	UnknownPenalty     float64                        `json:"unknownPenalty"`
	MinConfidenceFloor float64                        `json:"minConfidenceFloor"`
	MismatchPenalty    float64                        `json:"mismatchPenalty"`
	DomainBoosts       []categoryAuthorityDomainBoost `json:"domainBoosts"`
}

type sourcePolicy struct {
	AuthoritativeDomains []string
	AuthoritativeLabels  []string
	BlogDomains          []string
	BlogLabels           []string
	CategoryAuthority    []categoryAuthorityRule
}

type storedSourcePolicy struct {
	AuthoritativeDomains []string                `json:"authoritativeDomains"`
	AuthoritativeLabels  []string                `json:"authoritativeLabels"`
	BlogDomains          []string                `json:"blogDomains"`
	BlogLabels           []string                `json:"blogLabels"`
	CategoryAuthority    []categoryAuthorityRule `json:"categoryAuthority,omitempty"`
}

// SourcePolicyStore resolves the combined classification source policy. It
// mirrors NewsClassifierService.getSourcePolicy: Redis cache first, then the
// policy row plus the category-authority row, with the default four lists as the
// fallback.
type SourcePolicyStore struct {
	db    *sql.DB
	redis *redis.Client
}

// NewSourcePolicyStore wires the shared MySQL pool and Redis client.
func NewSourcePolicyStore(db *sql.DB, redisClient *redis.Client) *SourcePolicyStore {
	return &SourcePolicyStore{db: db, redis: redisClient}
}

func defaultSourcePolicy() sourcePolicy {
	domains, labels, blogs, blogLabels := publicportal.DefaultSourcePolicyLists()
	return sourcePolicy{
		AuthoritativeDomains: domains,
		AuthoritativeLabels:  labels,
		BlogDomains:          blogs,
		BlogLabels:           blogLabels,
	}
}

// Get returns the effective policy for one organization.
func (s *SourcePolicyStore) Get(ctx context.Context, orgID string) (sourcePolicy, error) {
	cacheKey := sourcePolicyCacheKeyPrefix + orgID
	if s != nil && s.redis != nil {
		if raw, err := s.redis.Get(ctx, cacheKey).Bytes(); err == nil {
			var stored storedSourcePolicy
			if json.Unmarshal(raw, &stored) == nil {
				return normalizePolicy(stored, defaultSourcePolicy()), nil
			}
		}
	}
	base := defaultSourcePolicy()
	if s == nil || s.db == nil {
		return base, nil
	}
	policyRaw, err := s.readSetting(ctx, sourcePolicySystemKeyPrefix+orgID)
	if err != nil {
		return sourcePolicy{}, err
	}
	base = parsePolicyValue(policyRaw)
	authorityRaw, err := s.readSetting(ctx, sourcePolicyCategoryAuthorityKeyPrefix+orgID)
	if err != nil {
		return sourcePolicy{}, err
	}
	authority := normalizeCategoryAuthority(authorityRaw, base.CategoryAuthority)
	if len(authority) > 0 {
		base.CategoryAuthority = authority
	}
	if s.redis != nil {
		if encoded, err := json.Marshal(toStoredPolicy(base)); err == nil {
			_ = s.redis.Set(ctx, cacheKey, encoded, sourcePolicyCacheTTL).Err()
		}
	}
	return base, nil
}

func (s *SourcePolicyStore) readSetting(ctx context.Context, key string) ([]byte, error) {
	var raw []byte
	err := s.db.QueryRowContext(ctx, "SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return raw, nil
}

func toStoredPolicy(policy sourcePolicy) storedSourcePolicy {
	return storedSourcePolicy{
		AuthoritativeDomains: policy.AuthoritativeDomains,
		AuthoritativeLabels:  policy.AuthoritativeLabels,
		BlogDomains:          policy.BlogDomains,
		BlogLabels:           policy.BlogLabels,
		CategoryAuthority:    policy.CategoryAuthority,
	}
}

func normalizePolicy(stored storedSourcePolicy, fallback sourcePolicy) sourcePolicy {
	out := sourcePolicy{
		AuthoritativeDomains: normalizeOrFallback(stored.AuthoritativeDomains, publicportal.NormalizeSourcePolicyDomain, fallback.AuthoritativeDomains),
		AuthoritativeLabels:  normalizeOrFallback(stored.AuthoritativeLabels, publicportal.NormalizeSourcePolicyLabel, fallback.AuthoritativeLabels),
		BlogDomains:          normalizeOrFallback(stored.BlogDomains, publicportal.NormalizeSourcePolicyDomain, fallback.BlogDomains),
		BlogLabels:           normalizeOrFallback(stored.BlogLabels, publicportal.NormalizeSourcePolicyLabel, fallback.BlogLabels),
	}
	authority := normalizeCategoryAuthorityRules(stored.CategoryAuthority, fallback.CategoryAuthority)
	if len(authority) > 0 {
		out.CategoryAuthority = authority
	}
	return out
}

func normalizeOrFallback(values []string, normalizer func(string) string, fallback []string) []string {
	if values == nil {
		return append([]string{}, fallback...)
	}
	return normalizeUniqueStrings(values, normalizer)
}

func normalizeUniqueStrings(values []string, normalizer func(string) string) []string {
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		normalized := normalizer(value)
		if normalized == "" {
			continue
		}
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		out = append(out, normalized)
		if len(out) >= 1000 {
			break
		}
	}
	return out
}

// parsePolicyValue handles the v2 delta and legacy four-list document shapes.
func parsePolicyValue(raw []byte) sourcePolicy {
	base := defaultSourcePolicy()
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return base
	}
	var record map[string]json.RawMessage
	if json.Unmarshal(trimmed, &record) != nil || record == nil {
		return base
	}
	var version float64
	hasVersion := json.Unmarshal(record["version"], &version) == nil && version == 2
	deltaRaw, hasDelta := record["delta"]
	if hasVersion && hasDelta && len(bytes.TrimSpace(deltaRaw)) > 0 {
		var delta map[string]json.RawMessage
		_ = json.Unmarshal(deltaRaw, &delta)
		base.AuthoritativeDomains = applyDeltaList(base.AuthoritativeDomains,
			readStringArray(delta["authoritativeDomainsAdd"]), readStringArray(delta["authoritativeDomainsRemove"]))
		base.AuthoritativeLabels = applyDeltaList(base.AuthoritativeLabels,
			readStringArray(delta["authoritativeLabelsAdd"]), readStringArray(delta["authoritativeLabelsRemove"]))
		base.BlogDomains = applyDeltaList(base.BlogDomains,
			readStringArray(delta["blogDomainsAdd"]), readStringArray(delta["blogDomainsRemove"]))
		base.BlogLabels = applyDeltaList(base.BlogLabels,
			readStringArray(delta["blogLabelsAdd"]), readStringArray(delta["blogLabelsRemove"]))
		base.CategoryAuthority = nil
		return base
	}
	legacy := storedSourcePolicy{
		AuthoritativeDomains: readStringArray(record["authoritativeDomains"]),
		AuthoritativeLabels:  readStringArray(record["authoritativeLabels"]),
		BlogDomains:          readStringArray(record["blogDomains"]),
		BlogLabels:           readStringArray(record["blogLabels"]),
		CategoryAuthority:    normalizeCategoryAuthority(record["categoryAuthority"], nil),
	}
	if legacy.AuthoritativeDomains == nil && legacy.AuthoritativeLabels == nil &&
		legacy.BlogDomains == nil && legacy.BlogLabels == nil {
		if len(legacy.CategoryAuthority) > 0 {
			base.CategoryAuthority = legacy.CategoryAuthority
		}
		return base
	}
	return normalizePolicy(legacy, base)
}

func applyDeltaList(base []string, adds, removes []string) []string {
	next := make(map[string]struct{}, len(base)+len(adds))
	order := make([]string, 0, len(base)+len(adds))
	for _, value := range base {
		if _, ok := next[value]; ok {
			continue
		}
		next[value] = struct{}{}
		order = append(order, value)
	}
	for _, value := range adds {
		if value == "" {
			continue
		}
		if _, ok := next[value]; ok {
			continue
		}
		next[value] = struct{}{}
		order = append(order, value)
	}
	removed := make(map[string]struct{}, len(removes))
	for _, value := range removes {
		removed[value] = struct{}{}
	}
	out := order[:0]
	for _, value := range order {
		if _, gone := removed[value]; gone {
			continue
		}
		out = append(out, value)
	}
	return out
}

func readStringArray(raw json.RawMessage) []string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return nil
	}
	var values []json.RawMessage
	if json.Unmarshal(trimmed, &values) != nil {
		return nil
	}
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		text := strings.TrimSpace(stringValueRaw(value))
		if text == "" {
			continue
		}
		if _, ok := seen[text]; ok {
			continue
		}
		seen[text] = struct{}{}
		out = append(out, text)
		if len(out) >= 1000 {
			break
		}
	}
	return out
}

func normalizeCategoryAuthority(raw json.RawMessage, fallback []categoryAuthorityRule) []categoryAuthorityRule {
	trimmed := bytes.TrimSpace(raw)
	var entries []json.RawMessage
	if len(trimmed) > 0 && trimmed[0] == '[' && json.Unmarshal(trimmed, &entries) == nil {
		return normalizeCategoryAuthorityRulesRaw(entries)
	}
	if fallback != nil {
		return append([]categoryAuthorityRule{}, fallback...)
	}
	return nil
}

func normalizeCategoryAuthorityRules(rules []categoryAuthorityRule, fallback []categoryAuthorityRule) []categoryAuthorityRule {
	if rules == nil {
		return append([]categoryAuthorityRule{}, fallback...)
	}
	raw := make([]json.RawMessage, 0, len(rules))
	for _, rule := range rules {
		encoded, err := json.Marshal(rule)
		if err == nil {
			raw = append(raw, encoded)
		}
	}
	return normalizeCategoryAuthorityRulesRaw(raw)
}

func normalizeCategoryAuthorityRulesRaw(entries []json.RawMessage) []categoryAuthorityRule {
	if len(entries) == 0 {
		return nil
	}
	out := make([]categoryAuthorityRule, 0, len(entries))
	seen := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		var record struct {
			CategoryPrefix     json.RawMessage   `json:"categoryPrefix"`
			AuthoritativeBoost json.RawMessage   `json:"authoritativeBoost"`
			BlogPenalty        json.RawMessage   `json:"blogPenalty"`
			UnknownPenalty     json.RawMessage   `json:"unknownPenalty"`
			MinConfidenceFloor json.RawMessage   `json:"minConfidenceFloor"`
			MismatchPenalty    json.RawMessage   `json:"mismatchPenalty"`
			DomainBoosts       []json.RawMessage `json:"domainBoosts"`
		}
		if json.Unmarshal(entry, &record) != nil {
			continue
		}
		prefix := normalizeCategoryPrefix(record.CategoryPrefix)
		if prefix == "" {
			continue
		}
		if _, ok := seen[prefix]; ok {
			continue
		}
		seen[prefix] = struct{}{}
		out = append(out, categoryAuthorityRule{
			CategoryPrefix:     prefix,
			AuthoritativeBoost: clampSignedUnit(record.AuthoritativeBoost, 0),
			BlogPenalty:        clampSignedUnit(record.BlogPenalty, 0),
			UnknownPenalty:     clampSignedUnit(record.UnknownPenalty, 0),
			MinConfidenceFloor: clampUnit(record.MinConfidenceFloor, 0),
			MismatchPenalty:    clampUnit(record.MismatchPenalty, 0),
			DomainBoosts:       normalizeDomainBoosts(record.DomainBoosts),
		})
		if len(out) >= 200 {
			break
		}
	}
	return out
}

func normalizeCategoryPrefix(raw json.RawMessage) string {
	value := stringValueRaw(raw)
	if value == "" {
		return ""
	}
	normalized := strings.ToLower(strings.TrimSpace(value))
	var builder strings.Builder
	for _, r := range normalized {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '/' || r == '_' || r == '-' {
			builder.WriteRune(r)
		}
	}
	normalized = builder.String()
	for strings.Contains(normalized, "//") {
		normalized = strings.ReplaceAll(normalized, "//", "/")
	}
	normalized = strings.Trim(normalized, "/")
	if normalized == "" {
		return ""
	}
	return truncateUTF16(normalized, 160)
}

func normalizeDomainBoosts(entries []json.RawMessage) []categoryAuthorityDomainBoost {
	if len(entries) == 0 {
		return []categoryAuthorityDomainBoost{}
	}
	out := make([]categoryAuthorityDomainBoost, 0, len(entries))
	seen := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		var record struct {
			Domain json.RawMessage `json:"domain"`
			Delta  json.RawMessage `json:"delta"`
		}
		if json.Unmarshal(entry, &record) != nil {
			continue
		}
		domain := publicportal.NormalizeSourcePolicyDomain(stringValueRaw(record.Domain))
		if domain == "" {
			continue
		}
		if _, ok := seen[domain]; ok {
			continue
		}
		seen[domain] = struct{}{}
		out = append(out, categoryAuthorityDomainBoost{Domain: domain, Delta: clampSignedUnit(record.Delta, 0)})
		if len(out) >= 100 {
			break
		}
	}
	return out
}

func clampUnit(raw json.RawMessage, fallback float64) float64 {
	value, ok := numberValue(raw)
	if !ok {
		return fallback
	}
	return math.Max(0, math.Min(1, roundTo4(value)))
}

func clampSignedUnit(raw json.RawMessage, fallback float64) float64 {
	value, ok := numberValue(raw)
	if !ok {
		return fallback
	}
	return math.Max(-1, math.Min(1, roundTo4(value)))
}

func roundTo4(value float64) float64 {
	return math.Round(value*1e4) / 1e4
}

func (p sourcePolicy) classifyJSON() []byte {
	encoded, err := json.Marshal(struct {
		AuthoritativeDomains []string `json:"authoritativeDomains"`
		AuthoritativeLabels  []string `json:"authoritativeLabels"`
		BlogDomains          []string `json:"blogDomains"`
		BlogLabels           []string `json:"blogLabels"`
	}{
		AuthoritativeDomains: p.AuthoritativeDomains,
		AuthoritativeLabels:  p.AuthoritativeLabels,
		BlogDomains:          p.BlogDomains,
		BlogLabels:           p.BlogLabels,
	})
	if err != nil {
		return nil
	}
	return encoded
}

func classifySource(label, rawURL string, policy sourcePolicy) string {
	class, _ := publicportal.ClassifyEventSource(label, rawURL, policy.classifyJSON())
	return class
}

func pathStartsWithPrefix(path, prefix string) bool {
	normalizedPath := strings.ToLower(strings.TrimSpace(path))
	normalizedPrefix := strings.TrimRight(strings.ToLower(strings.TrimSpace(prefix)), "/")
	if normalizedPrefix == "" {
		return false
	}
	return normalizedPath == normalizedPrefix || strings.HasPrefix(normalizedPath, normalizedPrefix+"/")
}

func hostnameMatchesDomain(hostname, domain string) bool {
	if hostname == "" {
		return false
	}
	return hostname == domain || strings.HasSuffix(hostname, "."+domain)
}

func extractHostname(rawURL string) string {
	trimmed := strings.TrimSpace(rawURL)
	if trimmed == "" {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	return publicportal.NormalizeSourcePolicyDomain(parsed.Hostname())
}
