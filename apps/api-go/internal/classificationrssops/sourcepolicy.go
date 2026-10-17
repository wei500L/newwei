package classificationrssops

import (
	"encoding/json"
	"net/url"
	"strings"
)

// maxPolicyListSize mirrors MAX_LIST_SIZE in news-event-source-classifier.ts.
const maxPolicyListSize = 1000

// compoundPublicSuffixes mirrors COMPOUND_PUBLIC_SUFFIXES: the registrable
// domain of a host under these suffixes keeps three labels.
var compoundPublicSuffixes = map[string]bool{
	"co.uk": true, "org.uk": true, "gov.uk": true, "ac.uk": true,
	"com.au": true, "net.au": true, "org.au": true, "co.nz": true,
	"com.br": true, "com.mx": true, "com.tr": true, "com.cn": true,
	"com.hk": true, "com.tw": true, "com.sg": true, "co.jp": true,
	"co.kr": true, "co.in": true, "co.id": true, "co.il": true,
	"com.ar": true, "com.sa": true, "com.ng": true,
}

// newsEventSourcePolicy mirrors NewsEventSourcePolicy. Only the four lists that
// classifySourceByLabelAndUrl consults are carried: the optional
// categoryAuthority rules tune a scoring path the migrated endpoints never call.
type newsEventSourcePolicy struct {
	AuthoritativeDomains []string
	AuthoritativeLabels  []string
	BlogDomains          []string
	BlogLabels           []string
}

// newsEventSourcePolicyDelta mirrors the version-2 delta form stored in MySQL.
type newsEventSourcePolicyDelta struct {
	AuthoritativeDomainsAdd    *[]string `json:"authoritativeDomainsAdd"`
	AuthoritativeDomainsRemove *[]string `json:"authoritativeDomainsRemove"`
	AuthoritativeLabelsAdd     *[]string `json:"authoritativeLabelsAdd"`
	AuthoritativeLabelsRemove  *[]string `json:"authoritativeLabelsRemove"`
	BlogDomainsAdd             *[]string `json:"blogDomainsAdd"`
	BlogDomainsRemove          *[]string `json:"blogDomainsRemove"`
	BlogLabelsAdd              *[]string `json:"blogLabelsAdd"`
	BlogLabelsRemove           *[]string `json:"blogLabelsRemove"`
}

// newsEventSourcePolicyRecord is the SystemSetting / Redis payload holding the
// organization source policy. Slice fields are pointers so an explicit empty
// array is distinguishable from an absent key, exactly like the TypeScript
// Array.isArray checks.
type newsEventSourcePolicyRecord struct {
	Version              *float64                    `json:"version"`
	Delta                *newsEventSourcePolicyDelta `json:"delta"`
	AuthoritativeDomains *[]string                   `json:"authoritativeDomains"`
	AuthoritativeLabels  *[]string                   `json:"authoritativeLabels"`
	BlogDomains          *[]string                   `json:"blogDomains"`
	BlogLabels           *[]string                   `json:"blogLabels"`
}

// defaultSourcePolicy mirrors DEFAULT_POLICY: the shipped lists normalized and
// deduplicated once at init time.
var defaultSourcePolicy = newsEventSourcePolicy{
	AuthoritativeDomains: normalizeUnique(defaultAuthoritativeDomains, normalizeDomain, maxPolicyListSize),
	AuthoritativeLabels:  normalizeUnique(defaultAuthoritativeLabels, normalizeLabel, maxPolicyListSize),
	BlogDomains:          normalizeUnique(defaultBlogDomains, normalizeDomain, maxPolicyListSize),
	BlogLabels:           normalizeUnique(defaultBlogLabels, normalizeLabel, maxPolicyListSize),
}

// getDefaultNewsEventSourcePolicy returns a copy of the shipped policy, matching
// the defensive copy the TypeScript getter performs.
func getDefaultNewsEventSourcePolicy() newsEventSourcePolicy {
	return newsEventSourcePolicy{
		AuthoritativeDomains: append([]string{}, defaultSourcePolicy.AuthoritativeDomains...),
		AuthoritativeLabels:  append([]string{}, defaultSourcePolicy.AuthoritativeLabels...),
		BlogDomains:          append([]string{}, defaultSourcePolicy.BlogDomains...),
		BlogLabels:           append([]string{}, defaultSourcePolicy.BlogLabels...),
	}
}

// normalizeDomain mirrors the private normalizeDomain helper.
func normalizeDomain(value string) string {
	trimmed := strings.ToLower(strings.TrimSpace(value))
	var builder strings.Builder
	builder.Grow(len(trimmed))
	for _, char := range trimmed {
		switch {
		case char >= 'a' && char <= 'z':
		case char >= '0' && char <= '9':
		case char == '.' || char == '-':
		default:
			continue
		}
		builder.WriteRune(char)
	}
	normalized := builder.String()
	normalized = strings.TrimPrefix(normalized, "www.")
	return strings.Trim(normalized, ".")
}

// normalizeLabel mirrors the private normalizeLabel helper. Characters outside
// [a-z0-9] and the CJK unified ideographs range become spaces.
func normalizeLabel(value string) string {
	trimmed := strings.ToLower(strings.TrimSpace(value))
	var builder strings.Builder
	builder.Grow(len(trimmed))
	for _, char := range trimmed {
		switch {
		case char >= 'a' && char <= 'z':
		case char >= '0' && char <= '9':
		case char >= 0x4E00 && char <= 0x9FFF:
		default:
			builder.WriteRune(' ')
			continue
		}
		builder.WriteRune(char)
	}
	return strings.Join(strings.Fields(builder.String()), " ")
}

// normalizeUnique mirrors the private normalizeUnique helper: normalize, drop
// empties, deduplicate preserving order and cap the result.
func normalizeUnique(values []string, normalizer func(string) string, maxSize int) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, raw := range values {
		normalized := normalizer(raw)
		if normalized == "" || seen[normalized] {
			continue
		}
		seen[normalized] = true
		out = append(out, normalized)
		if len(out) >= maxSize {
			break
		}
	}
	return out
}

// normalizeListOrFallback mirrors the private normalizeListOrFallback helper: a
// missing array falls back to the defaults, an explicit array (even empty) is
// normalized as-is.
func normalizeListOrFallback(value *[]string, normalizer func(string) string, fallback []string) []string {
	if value == nil {
		return append([]string{}, fallback...)
	}
	return normalizeUnique(*value, normalizer, maxPolicyListSize)
}

// normalizeSourcePolicy mirrors the exported normalizeSourcePolicy helper for
// the four lists the classifier consults.
func normalizeSourcePolicy(record newsEventSourcePolicyRecord, fallback newsEventSourcePolicy) newsEventSourcePolicy {
	return newsEventSourcePolicy{
		AuthoritativeDomains: normalizeListOrFallback(record.AuthoritativeDomains, normalizeDomain, fallback.AuthoritativeDomains),
		AuthoritativeLabels:  normalizeListOrFallback(record.AuthoritativeLabels, normalizeLabel, fallback.AuthoritativeLabels),
		BlogDomains:          normalizeListOrFallback(record.BlogDomains, normalizeDomain, fallback.BlogDomains),
		BlogLabels:           normalizeListOrFallback(record.BlogLabels, normalizeLabel, fallback.BlogLabels),
	}
}

// readStringArray mirrors the private readStringArray helper.
func readStringArray(value *[]string) []string {
	if value == nil {
		return []string{}
	}
	seen := make(map[string]bool, len(*value))
	out := make([]string, 0, len(*value))
	for _, entry := range *value {
		normalized := strings.TrimSpace(entry)
		if normalized == "" || seen[normalized] {
			continue
		}
		seen[normalized] = true
		out = append(out, normalized)
		if len(out) >= 1000 {
			break
		}
	}
	return out
}

// applyDeltaList mirrors the private applyDeltaList helper. Additions and
// removals are applied to the raw strings before normalization, exactly like
// the TypeScript Set arithmetic.
func applyDeltaList(base []string, adds []string, removes []string) []string {
	set := make(map[string]bool, len(base)+len(adds))
	order := make([]string, 0, len(base)+len(adds))
	for _, entry := range base {
		if entry == "" || set[entry] {
			continue
		}
		set[entry] = true
		order = append(order, entry)
	}
	for _, entry := range adds {
		if entry == "" || set[entry] {
			continue
		}
		set[entry] = true
		order = append(order, entry)
	}
	for _, entry := range removes {
		if entry == "" {
			continue
		}
		if !set[entry] {
			continue
		}
		delete(set, entry)
	}
	out := make([]string, 0, len(order))
	for _, entry := range order {
		if set[entry] {
			out = append(out, entry)
		}
	}
	return out
}

// parseSourcePolicyRecord mirrors the private parseSourcePolicyRecord helper.
// raw is the SystemSetting value or the cached Redis payload; malformed input
// falls back to the shipped defaults.
func parseSourcePolicyRecord(raw []byte, fallback newsEventSourcePolicy) newsEventSourcePolicy {
	if len(raw) == 0 {
		return fallback
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return fallback
	}
	var record newsEventSourcePolicyRecord
	if err := json.Unmarshal([]byte(trimmed), &record); err != nil {
		return fallback
	}
	if record.Version != nil && *record.Version == 2 && record.Delta != nil {
		delta := record.Delta
		return normalizeSourcePolicy(newsEventSourcePolicyRecord{
			AuthoritativeDomains: pointerTo(applyDeltaList(fallback.AuthoritativeDomains,
				readStringArray(delta.AuthoritativeDomainsAdd), readStringArray(delta.AuthoritativeDomainsRemove))),
			AuthoritativeLabels: pointerTo(applyDeltaList(fallback.AuthoritativeLabels,
				readStringArray(delta.AuthoritativeLabelsAdd), readStringArray(delta.AuthoritativeLabelsRemove))),
			BlogDomains: pointerTo(applyDeltaList(fallback.BlogDomains,
				readStringArray(delta.BlogDomainsAdd), readStringArray(delta.BlogDomainsRemove))),
			BlogLabels: pointerTo(applyDeltaList(fallback.BlogLabels,
				readStringArray(delta.BlogLabelsAdd), readStringArray(delta.BlogLabelsRemove))),
		}, fallback)
	}
	return normalizeSourcePolicy(record, fallback)
}

// pointerTo takes the address of a slice value for the record fields.
func pointerTo(value []string) *[]string { return &value }

// extractHostname mirrors the private extractHostname helper. JavaScript's
// URL constructor throws for relative URLs, so a parse without a host yields nil.
func extractHostname(raw *string) *string {
	if raw == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*raw)
	if trimmed == "" {
		return nil
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Host == "" {
		return nil
	}
	normalized := normalizeDomain(parsed.Hostname())
	if normalized == "" {
		return nil
	}
	return &normalized
}

// toRegistrableDomain mirrors the private toRegistrableDomain helper.
func toRegistrableDomain(hostname *string) *string {
	if hostname == nil {
		return nil
	}
	normalized := normalizeDomain(*hostname)
	if normalized == "" {
		result := ""
		return &result
	}
	if !strings.Contains(normalized, ".") {
		return &normalized
	}
	parts := make([]string, 0, 4)
	for _, entry := range strings.Split(normalized, ".") {
		if entry != "" {
			parts = append(parts, entry)
		}
	}
	if len(parts) <= 2 {
		return &normalized
	}
	tail2 := parts[len(parts)-2] + "." + parts[len(parts)-1]
	if compoundPublicSuffixes[tail2] && len(parts) >= 3 {
		joined := parts[len(parts)-3] + "." + tail2
		return &joined
	}
	return &tail2
}

// tokenizeLabelWords mirrors the private tokenizeLabelWords helper.
func tokenizeLabelWords(label string) map[string]bool {
	words := make(map[string]bool, 8)
	for _, word := range strings.Split(label, " ") {
		if word != "" {
			words[word] = true
		}
	}
	return words
}

// hasDomainMatch mirrors the private hasDomainMatch helper. The sets are already
// normalized at construction, so the idempotent re-normalization the TypeScript
// version performs is skipped.
func hasDomainMatch(hostname, registrableDomain *string, domains map[string]bool) bool {
	if hostname == nil && registrableDomain == nil {
		return false
	}
	for domain := range domains {
		if domain == "" {
			continue
		}
		if registrableDomain != nil && *registrableDomain == domain {
			return true
		}
		if hostname != nil && (*hostname == domain || strings.HasSuffix(*hostname, "."+domain)) {
			return true
		}
	}
	return false
}

// hasLabelMatch mirrors the private hasLabelMatch helper: multi-word labels are
// substring matches, single-word labels are token matches.
func hasLabelMatch(normalizedLabel string, labelWords, labels map[string]bool) bool {
	if normalizedLabel == "" {
		return false
	}
	for label := range labels {
		if label == "" {
			continue
		}
		if strings.Contains(label, " ") {
			if strings.Contains(normalizedLabel, label) {
				return true
			}
			continue
		}
		if labelWords[label] {
			return true
		}
	}
	return false
}

// classifySourceByLabelAndURL mirrors the exported classifySourceByLabelAndUrl
// helper. The blog blacklist wins over the authoritative list so a spoofed label
// on a low-trust host cannot be promoted.
func classifySourceByLabelAndURL(sourceLabel, rawURL *string, policy newsEventSourcePolicy) ClassifiedSourceType {
	label := ""
	if sourceLabel != nil {
		label = *sourceLabel
	}
	normalizedLabel := normalizeLabel(label)
	labelWords := tokenizeLabelWords(normalizedLabel)
	hostname := extractHostname(rawURL)
	registrableDomain := toRegistrableDomain(hostname)

	blogDomains := stringSet(policy.BlogDomains)
	blogLabels := stringSet(policy.BlogLabels)
	if hasDomainMatch(hostname, registrableDomain, blogDomains) ||
		hasLabelMatch(normalizedLabel, labelWords, blogLabels) {
		return ClassifiedSourceBlog
	}

	authoritativeDomains := stringSet(policy.AuthoritativeDomains)
	authoritativeLabels := stringSet(policy.AuthoritativeLabels)
	if hasDomainMatch(hostname, registrableDomain, authoritativeDomains) ||
		hasLabelMatch(normalizedLabel, labelWords, authoritativeLabels) {
		return ClassifiedSourceAuthoritative
	}
	return ClassifiedSourceUnknown
}

// stringSet builds the lookup set used by the classifier.
func stringSet(values []string) map[string]bool {
	out := make(map[string]bool, len(values))
	for _, value := range values {
		out[value] = true
	}
	return out
}
