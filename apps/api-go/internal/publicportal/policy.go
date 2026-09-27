package publicportal

import (
	"encoding/json"
	"net/url"
	"strings"
	"unicode/utf8"
)

const maxPolicyList = 1000

// matcher 是来源分类用的四张名单（域名/标签，权威与博客）。
// 分类只使用这四张表；categoryAuthority 不参与
// classifySourceByLabelAndUrl，与 Nest 相同。
type matcher struct {
	authoritativeDomains map[string]struct{}
	authoritativeLabels  map[string]struct{}
	blogDomains          map[string]struct{}
	blogLabels           map[string]struct{}
}

type policyLists struct {
	authoritativeDomains []string
	authoritativeLabels  []string
	blogDomains          []string
	blogLabels           []string
}

var (
	defaultLists policyLists
	compoundPS   map[string]struct{}
)

func init() {
	defaultLists = policyLists{
		authoritativeDomains: normalizeUnique(rawAuthoritativeDomains, normalizeDomain),
		authoritativeLabels:  normalizeUnique(rawAuthoritativeLabels, normalizeLabel),
		blogDomains:          normalizeUnique(rawBlogDomains, normalizeDomain),
		blogLabels:           normalizeUnique(rawBlogLabels, normalizeLabel),
	}
	compoundPS = make(map[string]struct{}, len(rawCompoundSuffixes))
	for _, suffix := range rawCompoundSuffixes {
		compoundPS[suffix] = struct{}{}
	}
}

func defaultMatcher() matcher {
	return matcherFromLists(defaultLists)
}

func matcherFromLists(lists policyLists) matcher {
	return matcher{
		authoritativeDomains: setOf(lists.authoritativeDomains),
		authoritativeLabels:  setOf(lists.authoritativeLabels),
		blogDomains:          setOf(lists.blogDomains),
		blogLabels:           setOf(lists.blogLabels),
	}
}

func setOf(values []string) map[string]struct{} {
	out := make(map[string]struct{}, len(values))
	for _, value := range values {
		if value != "" {
			out[value] = struct{}{}
		}
	}
	return out
}

func normalizeDomain(value string) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(strings.ToLower(value)) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '.' || r == '-' {
			b.WriteRune(r)
		}
	}
	normalized := b.String()
	normalized = strings.TrimPrefix(normalized, "www.")
	normalized = strings.Trim(normalized, ".")
	return normalized
}

func normalizeLabel(value string) string {
	var b strings.Builder
	prevSpace := false
	for _, r := range strings.TrimSpace(strings.ToLower(value)) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || (r >= 0x4e00 && r <= 0x9fff) {
			b.WriteRune(r)
			prevSpace = false
			continue
		}
		if !prevSpace && b.Len() > 0 {
			b.WriteByte(' ')
			prevSpace = true
		}
	}
	return strings.TrimSpace(b.String())
}

func normalizeUnique(values []string, normalizer func(string) string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, raw := range values {
		normalized := normalizer(raw)
		if normalized == "" {
			continue
		}
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		out = append(out, normalized)
		if len(out) >= maxPolicyList {
			break
		}
	}
	return out
}

// parseSourcePolicy 把 SystemSetting 里的来源策略还原成有效名单。
// 读失败或形状不认识时调用方改用默认名单（对齐 Nest getState 的 catch）。
// 支持 v2 delta 与 legacy 四列表。
func parseSourcePolicy(raw []byte) matcher {
	if len(raw) == 0 || string(raw) == "null" {
		return defaultMatcher()
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err != nil || probe == nil {
		return defaultMatcher()
	}
	if isStateV2(probe) {
		delta := normalizeDelta(probe["delta"])
		return matcherFromLists(applyDelta(defaultLists, delta))
	}
	if looksLikeLegacyPolicy(probe) {
		legacy := normalizeLegacyPolicy(probe)
		return matcherFromLists(applyDelta(defaultLists, deltaFromEffective(legacy)))
	}
	return defaultMatcher()
}

func isStateV2(probe map[string]json.RawMessage) bool {
	raw, ok := probe["version"]
	if !ok {
		return false
	}
	if _, hasDelta := probe["delta"]; !hasDelta {
		return false
	}
	var version float64
	if err := json.Unmarshal(raw, &version); err != nil || version != 2 {
		return false
	}
	return true
}

func looksLikeLegacyPolicy(probe map[string]json.RawMessage) bool {
	_, a := probe["authoritativeDomains"]
	_, b := probe["authoritativeLabels"]
	_, c := probe["blogDomains"]
	_, d := probe["blogLabels"]
	return a || b || c || d
}

type policyDelta struct {
	authoritativeDomainsAdd    []string
	authoritativeDomainsRemove []string
	authoritativeLabelsAdd     []string
	authoritativeLabelsRemove  []string
	blogDomainsAdd             []string
	blogDomainsRemove          []string
	blogLabelsAdd              []string
	blogLabelsRemove           []string
}

func normalizeDelta(raw json.RawMessage) policyDelta {
	var record map[string]json.RawMessage
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &record)
	}
	return policyDelta{
		authoritativeDomainsAdd:    normalizeStringArray(record["authoritativeDomainsAdd"]),
		authoritativeDomainsRemove: normalizeStringArray(record["authoritativeDomainsRemove"]),
		authoritativeLabelsAdd:     normalizeStringArray(record["authoritativeLabelsAdd"]),
		authoritativeLabelsRemove:  normalizeStringArray(record["authoritativeLabelsRemove"]),
		blogDomainsAdd:             normalizeStringArray(record["blogDomainsAdd"]),
		blogDomainsRemove:          normalizeStringArray(record["blogDomainsRemove"]),
		blogLabelsAdd:              normalizeStringArray(record["blogLabelsAdd"]),
		blogLabelsRemove:           normalizeStringArray(record["blogLabelsRemove"]),
	}
}

func normalizeStringArray(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var values []any
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil
	}
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, entry := range values {
		text, ok := entry.(string)
		if !ok {
			continue
		}
		text = strings.TrimSpace(text)
		if text == "" {
			continue
		}
		if _, exists := seen[text]; exists {
			continue
		}
		seen[text] = struct{}{}
		out = append(out, text)
		if len(out) >= maxPolicyList {
			break
		}
	}
	return out
}

func normalizeLegacyPolicy(probe map[string]json.RawMessage) policyLists {
	return policyLists{
		authoritativeDomains: normalizeListOrFallback(probe["authoritativeDomains"], normalizeDomain, defaultLists.authoritativeDomains),
		authoritativeLabels:  normalizeListOrFallback(probe["authoritativeLabels"], normalizeLabel, defaultLists.authoritativeLabels),
		blogDomains:          normalizeListOrFallback(probe["blogDomains"], normalizeDomain, defaultLists.blogDomains),
		blogLabels:           normalizeListOrFallback(probe["blogLabels"], normalizeLabel, defaultLists.blogLabels),
	}
}

func normalizeListOrFallback(raw json.RawMessage, normalizer func(string) string, fallback []string) []string {
	if len(raw) == 0 {
		return append([]string{}, fallback...)
	}
	var values []any
	if err := json.Unmarshal(raw, &values); err != nil {
		return append([]string{}, fallback...)
	}
	texts := make([]string, 0, len(values))
	for _, entry := range values {
		if text, ok := entry.(string); ok {
			texts = append(texts, text)
		}
	}
	return normalizeUnique(texts, normalizer)
}

func deltaFromEffective(effective policyLists) policyDelta {
	return policyDelta{
		authoritativeDomainsAdd:    diffAdd(defaultLists.authoritativeDomains, effective.authoritativeDomains),
		authoritativeDomainsRemove: diffAdd(effective.authoritativeDomains, defaultLists.authoritativeDomains),
		authoritativeLabelsAdd:     diffAdd(defaultLists.authoritativeLabels, effective.authoritativeLabels),
		authoritativeLabelsRemove:  diffAdd(effective.authoritativeLabels, defaultLists.authoritativeLabels),
		blogDomainsAdd:             diffAdd(defaultLists.blogDomains, effective.blogDomains),
		blogDomainsRemove:          diffAdd(effective.blogDomains, defaultLists.blogDomains),
		blogLabelsAdd:              diffAdd(defaultLists.blogLabels, effective.blogLabels),
		blogLabelsRemove:           diffAdd(effective.blogLabels, defaultLists.blogLabels),
	}
}

func diffAdd(base, target []string) []string {
	have := setOf(base)
	out := make([]string, 0)
	seen := map[string]struct{}{}
	for _, entry := range target {
		if entry == "" {
			continue
		}
		if _, ok := have[entry]; ok {
			continue
		}
		if _, ok := seen[entry]; ok {
			continue
		}
		seen[entry] = struct{}{}
		out = append(out, entry)
	}
	return out
}

func applyDelta(base policyLists, delta policyDelta) policyLists {
	return policyLists{
		authoritativeDomains: applyDeltaList(base.authoritativeDomains, delta.authoritativeDomainsAdd, delta.authoritativeDomainsRemove),
		authoritativeLabels:  applyDeltaList(base.authoritativeLabels, delta.authoritativeLabelsAdd, delta.authoritativeLabelsRemove),
		blogDomains:          applyDeltaList(base.blogDomains, delta.blogDomainsAdd, delta.blogDomainsRemove),
		blogLabels:           applyDeltaList(base.blogLabels, delta.blogLabelsAdd, delta.blogLabelsRemove),
	}
}

func applyDeltaList(base, adds, removes []string) []string {
	next := append([]string{}, base...)
	index := make(map[string]struct{}, len(next)+len(adds))
	for _, entry := range next {
		index[entry] = struct{}{}
	}
	for _, entry := range adds {
		if entry == "" {
			continue
		}
		if _, ok := index[entry]; ok {
			continue
		}
		index[entry] = struct{}{}
		next = append(next, entry)
	}
	if len(removes) == 0 {
		return next
	}
	drop := make(map[string]struct{}, len(removes))
	for _, entry := range removes {
		if entry != "" {
			drop[entry] = struct{}{}
		}
	}
	out := next[:0]
	for _, entry := range next {
		if _, ok := drop[entry]; ok {
			continue
		}
		out = append(out, entry)
	}
	return out
}

func resolveSourceKey(sourceLabel, rawURL string) string {
	hostname := extractHostname(rawURL)
	if domain := registrableDomain(hostname); domain != "" {
		return clip(domain, 120)
	}
	if hostname != "" {
		return clip(hostname, 120)
	}
	if label := normalizeLabel(sourceLabel); label != "" {
		return clip(label, 120)
	}
	return "unknown"
}

func clip(value string, max int) string {
	if utf8.RuneCountInString(value) <= max {
		return value
	}
	count := 0
	for index := range value {
		if count == max {
			return value[:index]
		}
		count++
	}
	return value
}

func extractHostname(rawURL string) string {
	raw := strings.TrimSpace(rawURL)
	if raw == "" {
		return ""
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Hostname() == "" {
		return ""
	}
	return normalizeDomain(parsed.Hostname())
}

func registrableDomain(hostname string) string {
	if hostname == "" {
		return ""
	}
	normalized := normalizeDomain(hostname)
	if normalized == "" || !strings.Contains(normalized, ".") {
		return normalized
	}
	parts := make([]string, 0, 4)
	for _, part := range strings.Split(normalized, ".") {
		if part != "" {
			parts = append(parts, part)
		}
	}
	if len(parts) <= 2 {
		return normalized
	}
	tail2 := parts[len(parts)-2] + "." + parts[len(parts)-1]
	if _, ok := compoundPS[tail2]; ok && len(parts) >= 3 {
		return parts[len(parts)-3] + "." + tail2
	}
	return tail2
}

func classifySource(sourceLabel, rawURL string, policy matcher) string {
	label := normalizeLabel(sourceLabel)
	words := map[string]struct{}{}
	for _, word := range strings.Split(label, " ") {
		if word != "" {
			words[word] = struct{}{}
		}
	}
	hostname := extractHostname(rawURL)
	domain := registrableDomain(hostname)
	if hasDomainMatch(hostname, domain, policy.blogDomains) || hasLabelMatch(label, words, policy.blogLabels) {
		return "blog"
	}
	if hasDomainMatch(hostname, domain, policy.authoritativeDomains) || hasLabelMatch(label, words, policy.authoritativeLabels) {
		return "authoritative"
	}
	return "unknown"
}

func hasDomainMatch(hostname, registrable string, domains map[string]struct{}) bool {
	if hostname == "" && registrable == "" {
		return false
	}
	for domain := range domains {
		normalized := normalizeDomain(domain)
		if normalized == "" {
			continue
		}
		if registrable != "" && registrable == normalized {
			return true
		}
		if hostname != "" && (hostname == normalized || strings.HasSuffix(hostname, "."+normalized)) {
			return true
		}
	}
	return false
}

func hasLabelMatch(normalizedLabel string, words map[string]struct{}, labels map[string]struct{}) bool {
	if normalizedLabel == "" {
		return false
	}
	for label := range labels {
		normalized := normalizeLabel(label)
		if normalized == "" {
			continue
		}
		if strings.Contains(normalized, " ") {
			if strings.Contains(normalizedLabel, normalized) {
				return true
			}
			continue
		}
		if _, ok := words[normalized]; ok {
			return true
		}
	}
	return false
}
