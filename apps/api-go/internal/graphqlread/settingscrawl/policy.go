package settingscrawl

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

// Source policy storage keys and cache keys, byte-for-byte the NestJS literals.
const (
	sourcePolicySettingPrefix               = "news_event_source_policy:"
	sourcePolicyCategoryAuthorityPrefix     = "news_event_source_policy_category_authority:"
	sourcePolicyPresetPrefix                = "news_event_source_policy_preset:"
	sourcePolicyPresetCategoryAuthorityPref = "news_event_source_policy_preset_category_authority:"
	sourcePolicyCachePrefix                 = "newsEvents:sourcePolicy:"
	sourcePolicyCategoryAuthorityCachePref  = "newsEvents:sourcePolicyCategoryAuthority:"
	sourcePolicyPresetCachePrefix           = "newsEvents:sourcePolicyPreset:"
	sourcePolicyPresetCategoryCachePrefix   = "newsEvents:sourcePolicyPresetCategoryAuthority:"
	// sourcePolicyHistoryLimit is the revision count the GraphQL query requests.
	sourcePolicyHistoryLimit = 30
	// sourcePolicyMaxListSize is the normalizeStringArray / normalizeUnique cap.
	sourcePolicyMaxListSize = 1000
	// sourcePolicyRevisionRetention caps the retained revision history.
	sourcePolicyRevisionRetention = 60
	// sourcePolicyCategoryAuthorityMaxRules and
	// sourcePolicyCategoryAuthorityMaxBoosts are the normalizeSourceCategoryAuthority
	// caps the write path reuses.
	sourcePolicyCategoryAuthorityMaxRules  = 200
	sourcePolicyCategoryAuthorityMaxBoosts = 100
)

// fallbackSourcePolicyUpdatedAt is getFallbackState().updatedAt, the epoch ISO
// string a missing or unrecognised policy state reports.
const fallbackSourcePolicyUpdatedAt = "1970-01-01T00:00:00.000Z"

// sourcePolicyStateRow is one SystemSetting read for the policy state.
type sourcePolicyStateRow struct {
	value     []byte
	updatedAt time.Time
	updatedBy sql.NullString
}

// sourcePolicyStateDocument is the persisted version 2 state document. Every
// field stays raw so the normalizers can reproduce the JavaScript type guards.
type sourcePolicyStateDocument struct {
	Version        json.RawMessage `json:"version"`
	ActiveRevision json.RawMessage `json:"activeRevision"`
	UpdatedAt      json.RawMessage `json:"updatedAt"`
	Delta          json.RawMessage `json:"delta"`
	Revisions      json.RawMessage `json:"revisions"`
}

// sourcePolicyDeltaDocument is one persisted delta snapshot: the eight add and
// remove lists.
type sourcePolicyDeltaDocument struct {
	AuthoritativeDomainsAdd    json.RawMessage `json:"authoritativeDomainsAdd"`
	AuthoritativeDomainsRemove json.RawMessage `json:"authoritativeDomainsRemove"`
	AuthoritativeLabelsAdd     json.RawMessage `json:"authoritativeLabelsAdd"`
	AuthoritativeLabelsRemove  json.RawMessage `json:"authoritativeLabelsRemove"`
	BlogDomainsAdd             json.RawMessage `json:"blogDomainsAdd"`
	BlogDomainsRemove          json.RawMessage `json:"blogDomainsRemove"`
	BlogLabelsAdd              json.RawMessage `json:"blogLabelsAdd"`
	BlogLabelsRemove           json.RawMessage `json:"blogLabelsRemove"`
}

// sourcePolicyRevisionDocument is one persisted revision entry.
type sourcePolicyRevisionDocument struct {
	Revision  json.RawMessage `json:"revision"`
	Operation json.RawMessage `json:"operation"`
	ActorID   json.RawMessage `json:"actorId"`
	CreatedAt json.RawMessage `json:"createdAt"`
	Note      json.RawMessage `json:"note"`
	Delta     json.RawMessage `json:"delta"`
}

// sourcePolicyRevision is the normalized revision. CreatedRaw keeps the stored
// string because the state's updatedAt fallback uses it verbatim.
type sourcePolicyRevision struct {
	Revision   int
	Operation  NewsEventSourcePolicyRevisionOperation
	ActorID    *string
	CreatedAt  time.Time
	CreatedRaw string
	Note       *string
	Delta      NewsEventSourcePolicyDeltaModel
}

// sourcePolicyState is the normalized version 2 state.
type sourcePolicyState struct {
	ActiveRevision int
	UpdatedAt      string
	Delta          NewsEventSourcePolicyDeltaModel
	Revisions      []sourcePolicyRevision
}

// sourcePolicyCategoryAuthorityDocument is one persisted category authority
// rule.
type sourcePolicyCategoryAuthorityDocument struct {
	CategoryPrefix     json.RawMessage `json:"categoryPrefix"`
	AuthoritativeBoost json.RawMessage `json:"authoritativeBoost"`
	BlogPenalty        json.RawMessage `json:"blogPenalty"`
	UnknownPenalty     json.RawMessage `json:"unknownPenalty"`
	MinConfidenceFloor json.RawMessage `json:"minConfidenceFloor"`
	MismatchPenalty    json.RawMessage `json:"mismatchPenalty"`
	DomainBoosts       json.RawMessage `json:"domainBoosts"`
}

// sourcePolicyDomainBoostDocument is one persisted domain boost.
type sourcePolicyDomainBoostDocument struct {
	Domain json.RawMessage `json:"domain"`
	Delta  json.RawMessage `json:"delta"`
}

// policyReader serves the three source-policy roots and the sync-status root.
type policyReader struct {
	s        *store
	settings *settingsReader
}

// emptyDelta returns the all-empty delta snapshot. A fresh copy is returned so
// callers can never alias a shared slice.
func emptyDelta() NewsEventSourcePolicyDeltaModel {
	return NewsEventSourcePolicyDeltaModel{
		AuthoritativeDomainsAdd:    []string{},
		AuthoritativeDomainsRemove: []string{},
		AuthoritativeLabelsAdd:     []string{},
		AuthoritativeLabelsRemove:  []string{},
		BlogDomainsAdd:             []string{},
		BlogDomainsRemove:          []string{},
		BlogLabelsAdd:              []string{},
		BlogLabelsRemove:           []string{},
	}
}

// cloneDelta copies all eight lists so a caller cannot alias persisted state.
func cloneDelta(delta NewsEventSourcePolicyDeltaModel) NewsEventSourcePolicyDeltaModel {
	return NewsEventSourcePolicyDeltaModel{
		AuthoritativeDomainsAdd:    append([]string{}, delta.AuthoritativeDomainsAdd...),
		AuthoritativeDomainsRemove: append([]string{}, delta.AuthoritativeDomainsRemove...),
		AuthoritativeLabelsAdd:     append([]string{}, delta.AuthoritativeLabelsAdd...),
		AuthoritativeLabelsRemove:  append([]string{}, delta.AuthoritativeLabelsRemove...),
		BlogDomainsAdd:             append([]string{}, delta.BlogDomainsAdd...),
		BlogDomainsRemove:          append([]string{}, delta.BlogDomainsRemove...),
		BlogLabelsAdd:              append([]string{}, delta.BlogLabelsAdd...),
		BlogLabelsRemove:           append([]string{}, delta.BlogLabelsRemove...),
	}
}

// fallbackSourcePolicyState is getFallbackState(): revision 0, the epoch
// updatedAt and no history.
func fallbackSourcePolicyState() sourcePolicyState {
	return sourcePolicyState{
		ActiveRevision: 0,
		UpdatedAt:      fallbackSourcePolicyUpdatedAt,
		Delta:          emptyDelta(),
		Revisions:      []sourcePolicyRevision{},
	}
}

// normalizeSourcePolicyDelta reproduces normalizeDelta: each of the eight keys
// is trimmed, de-duplicated, capped at 1000 entries and never case-folded.
func normalizeSourcePolicyDelta(raw json.RawMessage) NewsEventSourcePolicyDeltaModel {
	var document sourcePolicyDeltaDocument
	if len(bytes.TrimSpace(raw)) > 0 {
		_ = json.Unmarshal(raw, &document)
	}
	return NewsEventSourcePolicyDeltaModel{
		AuthoritativeDomainsAdd:    normalizeSourcePolicyStringArray(document.AuthoritativeDomainsAdd),
		AuthoritativeDomainsRemove: normalizeSourcePolicyStringArray(document.AuthoritativeDomainsRemove),
		AuthoritativeLabelsAdd:     normalizeSourcePolicyStringArray(document.AuthoritativeLabelsAdd),
		AuthoritativeLabelsRemove:  normalizeSourcePolicyStringArray(document.AuthoritativeLabelsRemove),
		BlogDomainsAdd:             normalizeSourcePolicyStringArray(document.BlogDomainsAdd),
		BlogDomainsRemove:          normalizeSourcePolicyStringArray(document.BlogDomainsRemove),
		BlogLabelsAdd:              normalizeSourcePolicyStringArray(document.BlogLabelsAdd),
		BlogLabelsRemove:           normalizeSourcePolicyStringArray(document.BlogLabelsRemove),
	}
}

// normalizeSourcePolicyStringArray trims string entries, drops empties, keeps
// the first occurrence of each value and stops at 1000 entries.
func normalizeSourcePolicyStringArray(raw json.RawMessage) []string {
	entries, ok := settingStringList(raw)
	if !ok {
		return []string{}
	}
	seen := make(map[string]struct{}, len(entries))
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" {
			continue
		}
		if _, exists := seen[trimmed]; exists {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
		if len(out) >= sourcePolicyMaxListSize {
			break
		}
	}
	return out
}

// parseStoredTime parses a stored ISO-8601 timestamp. NestJS passes the string
// to new Date(); an unparsable value would throw during serialization. The Go
// reader reports ok=false so callers can fall back instead of failing.
func parseStoredTime(value string) (time.Time, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return time.Time{}, false
	}
	parsed, err := time.Parse(time.RFC3339Nano, trimmed)
	if err != nil {
		return time.Time{}, false
	}
	return parsed, true
}

// normalizeSourcePolicyRevision reproduces normalizeRevision. A revision number
// below 1 or a non-numeric value drops the entry.
func normalizeSourcePolicyRevision(raw json.RawMessage) (sourcePolicyRevision, bool) {
	if !settingIsObject(raw) {
		return sourcePolicyRevision{}, false
	}
	var document sourcePolicyRevisionDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		return sourcePolicyRevision{}, false
	}
	revision := 0
	if number, ok := settingFloatOnly(document.Revision); ok {
		// Math.max(1, Math.round(value)): a finite revision below 1 clamps up
		// to 1, while a missing or non-numeric revision drops the entry.
		revision = int(math.Max(1, jsRound(number)))
	}
	if revision == 0 {
		return sourcePolicyRevision{}, false
	}
	operation := NewsEventSourcePolicyRevisionOperationUpdate
	if text, ok := settingString(document.Operation); ok {
		switch text {
		case string(NewsEventSourcePolicyRevisionOperationRollback):
			operation = NewsEventSourcePolicyRevisionOperationRollback
		case string(NewsEventSourcePolicyRevisionOperationReset):
			operation = NewsEventSourcePolicyRevisionOperationReset
		}
	}
	var actorID *string
	if text, ok := settingString(document.ActorID); ok {
		trimmed := strings.TrimSpace(text)
		if trimmed != "" {
			actorID = &trimmed
		}
	}
	createdRaw := ""
	createdAt := time.Time{}
	if text, ok := settingString(document.CreatedAt); ok && strings.TrimSpace(text) != "" {
		createdRaw = text
		if parsed, ok := parseStoredTime(text); ok {
			createdAt = parsed
		}
	}
	var note *string
	if text, ok := settingString(document.Note); ok {
		trimmed := strings.TrimSpace(text)
		if trimmed != "" {
			clipped := truncateRunes(trimmed, 500)
			note = &clipped
		}
	}
	return sourcePolicyRevision{
		Revision:   revision,
		Operation:  operation,
		ActorID:    actorID,
		CreatedAt:  createdAt,
		CreatedRaw: createdRaw,
		Note:       note,
		Delta:      normalizeSourcePolicyDelta(document.Delta),
	}, true
}

// normalizeSourcePolicyState reproduces normalizeState: the delta is normalized,
// the active revision is a non-negative rounded integer raised to the highest
// retained revision, the revisions are sorted ascending and only the newest 60
// are kept, and updatedAt prefers the stored string verbatim.
func normalizeSourcePolicyState(document sourcePolicyStateDocument) sourcePolicyState {
	out := fallbackSourcePolicyState()
	out.Delta = normalizeSourcePolicyDelta(document.Delta)
	if number, ok := settingFloatOnly(document.ActiveRevision); ok {
		out.ActiveRevision = int(math.Max(0, jsRound(number)))
	}
	revisions := make([]sourcePolicyRevision, 0)
	var rawRevisions []json.RawMessage
	if raw := bytes.TrimSpace(document.Revisions); len(raw) > 0 && raw[0] == '[' {
		if err := json.Unmarshal(raw, &rawRevisions); err == nil {
			for _, entry := range rawRevisions {
				if revision, ok := normalizeSourcePolicyRevision(entry); ok {
					revisions = append(revisions, revision)
				}
			}
		}
	}
	sort.SliceStable(revisions, func(i, j int) bool { return revisions[i].Revision < revisions[j].Revision })
	if len(revisions) > sourcePolicyRevisionRetention {
		revisions = revisions[len(revisions)-sourcePolicyRevisionRetention:]
	}
	out.Revisions = revisions
	if len(revisions) > 0 {
		highest := revisions[len(revisions)-1].Revision
		if highest > out.ActiveRevision {
			out.ActiveRevision = highest
		}
	}
	stored, ok := settingString(document.UpdatedAt)
	if ok && strings.TrimSpace(stored) != "" {
		out.UpdatedAt = stored
	} else if len(revisions) > 0 && revisions[len(revisions)-1].CreatedRaw != "" {
		out.UpdatedAt = revisions[len(revisions)-1].CreatedRaw
	} else {
		out.UpdatedAt = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return out
}

// stateFromStoredValue applies the parse gates: a version 2 object is
// normalized, a legacy four-list object is migrated to revision 1, and anything
// else falls back to the empty state.
func stateFromStoredValue(raw []byte, rowUpdatedAt time.Time, rowUpdatedBy sql.NullString) sourcePolicyState {
	if len(bytes.TrimSpace(raw)) == 0 {
		return fallbackSourcePolicyState()
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err != nil || probe == nil {
		return fallbackSourcePolicyState()
	}
	if isSourcePolicyStateV2(probe) {
		var document sourcePolicyStateDocument
		if err := json.Unmarshal(raw, &document); err != nil {
			return fallbackSourcePolicyState()
		}
		return normalizeSourcePolicyState(document)
	}
	if looksLikeLegacySourcePolicy(probe) {
		legacy := normalizeLegacySourcePolicy(probe)
		delta := deltaFromEffectivePolicy(legacy)
		createdAt := contract.FormatDateTime(rowUpdatedAt)
		var actorID *string
		if rowUpdatedBy.Valid && rowUpdatedBy.String != "" {
			actor := rowUpdatedBy.String
			actorID = &actor
		}
		note := "migrated-from-legacy"
		revision := sourcePolicyRevision{
			Revision:   1,
			Operation:  NewsEventSourcePolicyRevisionOperationUpdate,
			ActorID:    actorID,
			CreatedAt:  rowUpdatedAt,
			CreatedRaw: createdAt,
			Note:       &note,
			Delta:      delta,
		}
		return sourcePolicyState{
			ActiveRevision: 1,
			UpdatedAt:      createdAt,
			Delta:          delta,
			Revisions:      []sourcePolicyRevision{revision},
		}
	}
	return fallbackSourcePolicyState()
}

// isSourcePolicyStateV2 reproduces isStateV2: an object with version 2 and a
// delta key.
func isSourcePolicyStateV2(probe map[string]json.RawMessage) bool {
	version, ok := probe["version"]
	if !ok {
		return false
	}
	if _, hasDelta := probe["delta"]; !hasDelta {
		return false
	}
	number, ok := settingFloatOnly(version)
	return ok && number == 2
}

// looksLikeLegacySourcePolicy reports whether any of the four legacy policy
// lists is present.
func looksLikeLegacySourcePolicy(probe map[string]json.RawMessage) bool {
	for _, key := range []string{"authoritativeDomains", "authoritativeLabels", "blogDomains", "blogLabels"} {
		if _, ok := probe[key]; ok {
			return true
		}
	}
	return false
}

// effectiveSourcePolicy is the four effective source-policy lists.
type effectiveSourcePolicy struct {
	AuthoritativeDomains []string
	AuthoritativeLabels  []string
	BlogDomains          []string
	BlogLabels           []string
}

// defaultEffectiveSourcePolicy returns the classifier defaults shared with the
// public-portal HTTP reader.
func defaultEffectiveSourcePolicy() effectiveSourcePolicy {
	domains, labels, blogDomains, blogLabels := publicportal.DefaultSourcePolicyLists()
	return effectiveSourcePolicy{
		AuthoritativeDomains: domains,
		AuthoritativeLabels:  labels,
		BlogDomains:          blogDomains,
		BlogLabels:           blogLabels,
	}
}

// applyDeltaList reproduces applyDeltaList: the base order is preserved, each
// non-empty add is appended when absent, and the removes are applied last so a
// value present in both lists is removed.
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
		if _, exists := index[entry]; exists {
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
		if _, exists := drop[entry]; exists {
			continue
		}
		out = append(out, entry)
	}
	return out
}

// effectiveFromDelta reproduces toEffectivePolicy: the classifier defaults with
// the persisted delta applied.
func effectiveFromDelta(delta NewsEventSourcePolicyDeltaModel) effectiveSourcePolicy {
	defaults := defaultEffectiveSourcePolicy()
	return effectiveSourcePolicy{
		AuthoritativeDomains: applyDeltaList(defaults.AuthoritativeDomains, delta.AuthoritativeDomainsAdd, delta.AuthoritativeDomainsRemove),
		AuthoritativeLabels:  applyDeltaList(defaults.AuthoritativeLabels, delta.AuthoritativeLabelsAdd, delta.AuthoritativeLabelsRemove),
		BlogDomains:          applyDeltaList(defaults.BlogDomains, delta.BlogDomainsAdd, delta.BlogDomainsRemove),
		BlogLabels:           applyDeltaList(defaults.BlogLabels, delta.BlogLabelsAdd, delta.BlogLabelsRemove),
	}
}

// diffAdd reproduces diffAdd: every target entry absent from base, in target
// order.
func diffAdd(base, target []string) []string {
	have := make(map[string]struct{}, len(base))
	for _, entry := range base {
		have[entry] = struct{}{}
	}
	seen := make(map[string]struct{}, len(target))
	out := make([]string, 0, len(target))
	for _, entry := range target {
		if entry == "" {
			continue
		}
		if _, exists := have[entry]; exists {
			continue
		}
		if _, exists := seen[entry]; exists {
			continue
		}
		seen[entry] = struct{}{}
		out = append(out, entry)
	}
	return out
}

// deltaFromEffectivePolicy reproduces toDeltaFromEffectivePolicy using the
// classifier defaults as the base.
func deltaFromEffectivePolicy(policy effectiveSourcePolicy) NewsEventSourcePolicyDeltaModel {
	defaults := defaultEffectiveSourcePolicy()
	return NewsEventSourcePolicyDeltaModel{
		AuthoritativeDomainsAdd:    diffAdd(defaults.AuthoritativeDomains, policy.AuthoritativeDomains),
		AuthoritativeDomainsRemove: diffAdd(policy.AuthoritativeDomains, defaults.AuthoritativeDomains),
		AuthoritativeLabelsAdd:     diffAdd(defaults.AuthoritativeLabels, policy.AuthoritativeLabels),
		AuthoritativeLabelsRemove:  diffAdd(policy.AuthoritativeLabels, defaults.AuthoritativeLabels),
		BlogDomainsAdd:             diffAdd(defaults.BlogDomains, policy.BlogDomains),
		BlogDomainsRemove:          diffAdd(policy.BlogDomains, defaults.BlogDomains),
		BlogLabelsAdd:              diffAdd(defaults.BlogLabels, policy.BlogLabels),
		BlogLabelsRemove:           diffAdd(policy.BlogLabels, defaults.BlogLabels),
	}
}

// buildConflictWarnings reproduces buildConflictWarnings. The comparison is an
// exact, case-sensitive set membership test and the output follows the blog
// list order with the blog-side spelling, which is what the NestJS code does.
func buildConflictWarnings(policy effectiveSourcePolicy) NewsEventSourcePolicyConflictModel {
	authoritativeDomains := make(map[string]struct{}, len(policy.AuthoritativeDomains))
	for _, entry := range policy.AuthoritativeDomains {
		authoritativeDomains[entry] = struct{}{}
	}
	authoritativeLabels := make(map[string]struct{}, len(policy.AuthoritativeLabels))
	for _, entry := range policy.AuthoritativeLabels {
		authoritativeLabels[entry] = struct{}{}
	}
	domainConflicts := []string{}
	for _, entry := range policy.BlogDomains {
		if _, exists := authoritativeDomains[entry]; exists {
			domainConflicts = append(domainConflicts, entry)
		}
	}
	labelConflicts := []string{}
	for _, entry := range policy.BlogLabels {
		if _, exists := authoritativeLabels[entry]; exists {
			labelConflicts = append(labelConflicts, entry)
		}
	}
	return NewsEventSourcePolicyConflictModel{
		DomainConflicts: domainConflicts,
		LabelConflicts:  labelConflicts,
		HasConflicts:    len(domainConflicts) > 0 || len(labelConflicts) > 0,
	}
}

// normalizeListOrFallback reproduces normalizeListOrFallback: a value that is
// not an array returns the fallback WITHOUT normalizing it, so the mixed-case
// preset defaults survive; an array is normalized and de-duplicated.
func normalizeListOrFallback(raw json.RawMessage, normalize func(string) string, fallback []string) []string {
	if !settingIsArray(raw) {
		return append([]string{}, fallback...)
	}
	entries, _ := settingStringList(raw)
	seen := make(map[string]struct{}, len(entries))
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		normalized := normalize(entry)
		if normalized == "" {
			continue
		}
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		out = append(out, normalized)
		if len(out) >= sourcePolicyMaxListSize {
			break
		}
	}
	return out
}

// normalizeLegacySourcePolicy reproduces normalizeSourcePolicy.
func normalizeLegacySourcePolicy(probe map[string]json.RawMessage) effectiveSourcePolicy {
	fallback := defaultEffectiveSourcePolicy()
	return effectiveSourcePolicy{
		AuthoritativeDomains: normalizeListOrFallback(probe["authoritativeDomains"], publicportal.NormalizeSourcePolicyDomain, fallback.AuthoritativeDomains),
		AuthoritativeLabels:  normalizeListOrFallback(probe["authoritativeLabels"], publicportal.NormalizeSourcePolicyLabel, fallback.AuthoritativeLabels),
		BlogDomains:          normalizeListOrFallback(probe["blogDomains"], publicportal.NormalizeSourcePolicyDomain, fallback.BlogDomains),
		BlogLabels:           normalizeListOrFallback(probe["blogLabels"], publicportal.NormalizeSourcePolicyLabel, fallback.BlogLabels),
	}
}

// normalizeCategoryPrefix reproduces normalizeCategoryPrefix.
func normalizeCategoryPrefix(raw json.RawMessage) *string {
	text, ok := settingString(raw)
	if !ok {
		return nil
	}
	normalized := normalizeCategoryPrefixString(text)
	if normalized == "" {
		return nil
	}
	return &normalized
}

// normalizeCategoryPrefixString is the string half of normalizeCategoryPrefix,
// shared with the write path so a submitted prefix and a stored prefix go
// through one implementation.
func normalizeCategoryPrefixString(text string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(text)) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '/' || r == '_' || r == '-' {
			b.WriteRune(r)
		}
	}
	normalized := b.String()
	for strings.Contains(normalized, "//") {
		normalized = strings.ReplaceAll(normalized, "//", "/")
	}
	normalized = strings.Trim(normalized, "/")
	if normalized == "" {
		return ""
	}
	return truncateRunes(normalized, 160)
}

// clampSignedUnit reproduces clampSignedUnit: a finite number rounded to four
// decimals and clamped to [-1, 1]; anything else falls back.
func clampSignedUnit(raw json.RawMessage, fallback float64) float64 {
	number, ok := settingFloatOnly(raw)
	if !ok {
		return fallback
	}
	return math.Max(-1, math.Min(1, roundTo(number, 4)))
}

// clampUnit reproduces clampUnit: a finite number rounded to four decimals and
// clamped to [0, 1]; anything else falls back.
func clampUnit(raw json.RawMessage, fallback float64) float64 {
	number, ok := settingFloatOnly(raw)
	if !ok {
		return fallback
	}
	return math.Max(0, math.Min(1, roundTo(number, 4)))
}

// normalizeDomainBoosts reproduces normalizeDomainBoosts.
func normalizeDomainBoosts(raw json.RawMessage) []NewsEventSourceCategoryAuthorityDomainBoostModel {
	out := []NewsEventSourceCategoryAuthorityDomainBoostModel{}
	if !settingIsArray(raw) {
		return out
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return out
	}
	seen := map[string]struct{}{}
	for _, entry := range entries {
		if !settingIsObject(entry) {
			continue
		}
		var document sourcePolicyDomainBoostDocument
		if err := json.Unmarshal(entry, &document); err != nil {
			continue
		}
		domainText, ok := settingString(document.Domain)
		if !ok {
			continue
		}
		domain := publicportal.NormalizeSourcePolicyDomain(domainText)
		if domain == "" {
			continue
		}
		if _, exists := seen[domain]; exists {
			continue
		}
		seen[domain] = struct{}{}
		out = append(out, NewsEventSourceCategoryAuthorityDomainBoostModel{
			Domain: domain,
			Delta:  clampSignedUnit(document.Delta, 0),
		})
		if len(out) >= sourcePolicyCategoryAuthorityMaxBoosts {
			break
		}
	}
	return out
}

// normalizeSourceCategoryAuthority reproduces normalizeSourceCategoryAuthority,
// including the 200-rule cap and the fallback list used when the value is not an
// array.
func normalizeSourceCategoryAuthority(raw json.RawMessage, fallback []NewsEventSourceCategoryAuthorityRuleModel) []NewsEventSourceCategoryAuthorityRuleModel {
	input := raw
	if !settingIsArray(input) {
		if len(fallback) == 0 {
			return []NewsEventSourceCategoryAuthorityRuleModel{}
		}
		encoded, err := json.Marshal(fallback)
		if err != nil {
			return []NewsEventSourceCategoryAuthorityRuleModel{}
		}
		input = encoded
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(input, &entries); err != nil {
		return []NewsEventSourceCategoryAuthorityRuleModel{}
	}
	out := []NewsEventSourceCategoryAuthorityRuleModel{}
	seen := map[string]struct{}{}
	for _, entry := range entries {
		if !settingIsObject(entry) {
			continue
		}
		var document sourcePolicyCategoryAuthorityDocument
		if err := json.Unmarshal(entry, &document); err != nil {
			continue
		}
		prefix := normalizeCategoryPrefix(document.CategoryPrefix)
		if prefix == nil {
			continue
		}
		if _, exists := seen[*prefix]; exists {
			continue
		}
		seen[*prefix] = struct{}{}
		out = append(out, NewsEventSourceCategoryAuthorityRuleModel{
			CategoryPrefix:     *prefix,
			AuthoritativeBoost: clampSignedUnit(document.AuthoritativeBoost, 0),
			BlogPenalty:        clampSignedUnit(document.BlogPenalty, 0),
			UnknownPenalty:     clampSignedUnit(document.UnknownPenalty, 0),
			MinConfidenceFloor: clampUnit(document.MinConfidenceFloor, 0),
			MismatchPenalty:    clampUnit(document.MismatchPenalty, 0),
			DomainBoosts:       normalizeDomainBoosts(document.DomainBoosts),
		})
		if len(out) >= sourcePolicyCategoryAuthorityMaxRules {
			break
		}
	}
	return out
}

// loadSourcePolicyState reads the state row directly, bypassing the service
// cache. A missing or unusable row reports the fallback state.
func (r *policyReader) loadSourcePolicyState(ctx context.Context, orgID string) (sourcePolicyState, error) {
	if r.s == nil || r.s.db == nil {
		return fallbackSourcePolicyState(), sql.ErrConnDone
	}
	var row sourcePolicyStateRow
	err := r.s.db.QueryRowContext(ctx,
		"SELECT value, updatedAt, updatedById FROM SystemSetting WHERE `key` = ? LIMIT 1",
		sourcePolicySettingPrefix+orgID,
	).Scan(&row.value, &row.updatedAt, &row.updatedBy)
	if errors.Is(err, sql.ErrNoRows) {
		return fallbackSourcePolicyState(), nil
	}
	if err != nil {
		return fallbackSourcePolicyState(), err
	}
	if len(bytes.TrimSpace(row.value)) == 0 || string(bytes.TrimSpace(row.value)) == "null" {
		return fallbackSourcePolicyState(), nil
	}
	return stateFromStoredValue(row.value, row.updatedAt, row.updatedBy), nil
}

// loadCategoryAuthority reads and normalizes one category authority document.
func (r *policyReader) loadCategoryAuthority(ctx context.Context, key string) []NewsEventSourceCategoryAuthorityRuleModel {
	raw, found, err := r.s.selectSetting(ctx, key)
	if err != nil || !found {
		return []NewsEventSourceCategoryAuthorityRuleModel{}
	}
	return normalizeSourceCategoryAuthority(raw, nil)
}

// getPolicyDetails reproduces getPolicyDetails with the GraphQL history limit.
func (r *policyReader) getPolicyDetails(ctx context.Context, orgID string) (NewsEventSourcePolicySettingsModel, error) {
	state, err := r.loadSourcePolicyState(ctx, orgID)
	if err != nil {
		// getState swallows a DB failure and falls back; the read root then
		// reports the epoch state rather than failing the whole query.
		log.Printf("settingscrawl: source policy state read failed for org %s: %v", orgID, err)
		state = fallbackSourcePolicyState()
	}
	effective := effectiveFromDelta(state.Delta)
	warnings := buildConflictWarnings(effective)
	categoryAuthority := r.loadCategoryAuthority(ctx, sourcePolicyCategoryAuthorityPrefix+orgID)

	revisions := make([]NewsEventSourcePolicyRevisionModel, 0, len(state.Revisions))
	for _, revision := range state.Revisions {
		revisions = append(revisions, revisionModel(revision))
	}
	// The GraphQL query requests the newest 30 revisions in descending order.
	sort.SliceStable(revisions, func(i, j int) bool { return revisions[i].Revision > revisions[j].Revision })
	if len(revisions) > sourcePolicyHistoryLimit {
		revisions = revisions[:sourcePolicyHistoryLimit]
	}

	return NewsEventSourcePolicySettingsModel{
		ActiveRevision:       state.ActiveRevision,
		AuthoritativeDomains: nonNilStrings(effective.AuthoritativeDomains),
		AuthoritativeLabels:  nonNilStrings(effective.AuthoritativeLabels),
		BlogDomains:          nonNilStrings(effective.BlogDomains),
		BlogLabels:           nonNilStrings(effective.BlogLabels),
		CategoryAuthority:    nonNilRules(categoryAuthority),
		Overrides:            cloneDelta(state.Delta),
		Revisions:            revisions,
		SyncWarnings:         []string{},
		UpdatedAt:            policyUpdatedAt(state.UpdatedAt),
		Warnings:             warnings,
	}, nil
}

// revisionModel maps a normalized revision to its GraphQL model.
func revisionModel(revision sourcePolicyRevision) NewsEventSourcePolicyRevisionModel {
	return NewsEventSourcePolicyRevisionModel{
		ActorID:   revision.ActorID,
		CreatedAt: revision.CreatedAt,
		Delta:     cloneDelta(revision.Delta),
		Note:      revision.Note,
		Operation: revision.Operation,
		Revision:  revision.Revision,
	}
}

// policyUpdatedAt converts the stored timestamp for the nullable DateTime
// field. An empty or unparsable value becomes GraphQL null, matching the
// truthiness check `details.updatedAt ? new Date(...) : null`.
func policyUpdatedAt(value string) *time.Time {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parsed, ok := parseStoredTime(value)
	if !ok {
		return nil
	}
	return &parsed
}

// nonNilStrings guarantees a non-null GraphQL list projects as [] rather than
// null when the underlying list is empty.
func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

// nonNilRules guarantees a non-null rule list projects as [].
func nonNilRules(values []NewsEventSourceCategoryAuthorityRuleModel) []NewsEventSourceCategoryAuthorityRuleModel {
	if values == nil {
		return []NewsEventSourceCategoryAuthorityRuleModel{}
	}
	return values
}

// getRevisionDiff reproduces getRevisionDiff. Each revision delta is a complete
// snapshot, so no chaining happens between them.
func (r *policyReader) getRevisionDiff(ctx context.Context, orgID string, baseRevision, targetRevision int) (NewsEventSourcePolicyRevisionDiffModel, error) {
	state, err := r.loadSourcePolicyState(ctx, orgID)
	if err != nil {
		log.Printf("settingscrawl: source policy state read failed for org %s: %v", orgID, err)
		state = fallbackSourcePolicyState()
	}
	normalizedBase := clampRevision(baseRevision)
	normalizedTarget := clampRevision(targetRevision)
	base, baseFound := findRevision(state.Revisions, normalizedBase)
	if !baseFound {
		return NewsEventSourcePolicyRevisionDiffModel{}, badRequest("Revision " + strconv.Itoa(normalizedBase) + " not found")
	}
	target, targetFound := findRevision(state.Revisions, normalizedTarget)
	if !targetFound {
		return NewsEventSourcePolicyRevisionDiffModel{}, badRequest("Revision " + strconv.Itoa(normalizedTarget) + " not found")
	}
	basePolicy := effectiveFromDelta(base.Delta)
	targetPolicy := effectiveFromDelta(target.Delta)
	return NewsEventSourcePolicyRevisionDiffModel{
		BaseRevision:               normalizedBase,
		TargetRevision:             normalizedTarget,
		AuthoritativeDomainsAdd:    nonNilStrings(diffAdd(basePolicy.AuthoritativeDomains, targetPolicy.AuthoritativeDomains)),
		AuthoritativeDomainsRemove: nonNilStrings(diffAdd(targetPolicy.AuthoritativeDomains, basePolicy.AuthoritativeDomains)),
		AuthoritativeLabelsAdd:     nonNilStrings(diffAdd(basePolicy.AuthoritativeLabels, targetPolicy.AuthoritativeLabels)),
		AuthoritativeLabelsRemove:  nonNilStrings(diffAdd(targetPolicy.AuthoritativeLabels, basePolicy.AuthoritativeLabels)),
		BlogDomainsAdd:             nonNilStrings(diffAdd(basePolicy.BlogDomains, targetPolicy.BlogDomains)),
		BlogDomainsRemove:          nonNilStrings(diffAdd(targetPolicy.BlogDomains, basePolicy.BlogDomains)),
		BlogLabelsAdd:              nonNilStrings(diffAdd(basePolicy.BlogLabels, targetPolicy.BlogLabels)),
		BlogLabelsRemove:           nonNilStrings(diffAdd(targetPolicy.BlogLabels, basePolicy.BlogLabels)),
	}, nil
}

// clampRevision reproduces clampInt(baseRevision, 1, Number.MAX_SAFE_INTEGER),
// so revision 0 or a negative value reports "Revision 1 not found".
func clampRevision(value int) int {
	if value < 1 {
		return 1
	}
	return value
}

// findRevision locates a revision by its exact number.
func findRevision(revisions []sourcePolicyRevision, revision int) (sourcePolicyRevision, bool) {
	for _, entry := range revisions {
		if entry.Revision == revision {
			return entry, true
		}
	}
	return sourcePolicyRevision{}, false
}

// presetPolicy is the normalized preset document.
type presetPolicy struct {
	AuthoritativeDomains []string
	AuthoritativeLabels  []string
	BlogDomains          []string
	BlogLabels           []string
	CategoryAuthority    []NewsEventSourceCategoryAuthorityRuleModel
}

// fallbackPresetPolicy returns the un-normalized DEFAULT_POLICY_PRESET lists.
func fallbackPresetPolicy() presetPolicy {
	return presetPolicy{
		AuthoritativeDomains: append([]string{}, defaultPolicyPresetAuthoritativeDomains...),
		AuthoritativeLabels:  append([]string{}, defaultPolicyPresetAuthoritativeLabels...),
		BlogDomains:          append([]string{}, defaultPolicyPresetBlogDomains...),
		BlogLabels:           append([]string{}, defaultPolicyPresetBlogLabels...),
	}
}

// normalizePresetPolicy reproduces normalizeSourcePolicy against the preset
// fallback. An empty category authority is dropped from the result.
func normalizePresetPolicy(probe map[string]json.RawMessage, fallback presetPolicy) presetPolicy {
	out := presetPolicy{
		AuthoritativeDomains: normalizeListOrFallback(probe["authoritativeDomains"], publicportal.NormalizeSourcePolicyDomain, fallback.AuthoritativeDomains),
		AuthoritativeLabels:  normalizeListOrFallback(probe["authoritativeLabels"], publicportal.NormalizeSourcePolicyLabel, fallback.AuthoritativeLabels),
		BlogDomains:          normalizeListOrFallback(probe["blogDomains"], publicportal.NormalizeSourcePolicyDomain, fallback.BlogDomains),
		BlogLabels:           normalizeListOrFallback(probe["blogLabels"], publicportal.NormalizeSourcePolicyLabel, fallback.BlogLabels),
	}
	rules := normalizeSourceCategoryAuthority(probe["categoryAuthority"], fallback.CategoryAuthority)
	if len(rules) > 0 {
		out.CategoryAuthority = rules
	}
	return out
}

// loadPreset reads the preset row. A present but unrecognised value is ignored
// while its database timestamp is still reported, exactly like loadPreset.
func (r *policyReader) loadPreset(ctx context.Context, orgID string) (presetPolicy, *time.Time, error) {
	fallback := fallbackPresetPolicy()
	if r.s == nil || r.s.db == nil {
		return fallback, nil, sql.ErrConnDone
	}
	var value []byte
	var updatedAt time.Time
	err := r.s.db.QueryRowContext(ctx,
		"SELECT value, updatedAt FROM SystemSetting WHERE `key` = ? LIMIT 1",
		sourcePolicyPresetPrefix+orgID,
	).Scan(&value, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return fallback, nil, nil
	}
	if err != nil {
		return fallback, nil, err
	}
	rowUpdatedAt := updatedAt
	if len(bytes.TrimSpace(value)) == 0 || string(bytes.TrimSpace(value)) == "null" {
		return fallback, nil, nil
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(value, &probe); err != nil || probe == nil || !looksLikeLegacySourcePolicy(probe) {
		return fallback, &rowUpdatedAt, nil
	}
	return normalizePresetPolicy(probe, fallback), &rowUpdatedAt, nil
}

// getPolicyPreset reproduces getPolicyPreset.
func (r *policyReader) getPolicyPreset(ctx context.Context, orgID string) (NewsEventSourcePolicyPresetSettingsModel, error) {
	preset, updatedAt, err := r.loadPreset(ctx, orgID)
	if err != nil {
		log.Printf("settingscrawl: source policy preset read failed for org %s: %v", orgID, err)
		preset = fallbackPresetPolicy()
		updatedAt = nil
	}
	categoryAuthority := r.loadCategoryAuthority(ctx, sourcePolicyPresetCategoryAuthorityPref+orgID)
	out := NewsEventSourcePolicyPresetSettingsModel{
		AuthoritativeDomains: nonNilStrings(preset.AuthoritativeDomains),
		AuthoritativeLabels:  nonNilStrings(preset.AuthoritativeLabels),
		BlogDomains:          nonNilStrings(preset.BlogDomains),
		BlogLabels:           nonNilStrings(preset.BlogLabels),
		CategoryAuthority:    nonNilRules(categoryAuthority),
		SyncWarnings:         []string{},
		UpdatedAt:            updatedAt,
	}
	return out, nil
}

// canonicalStoredTime reproduces normalizeExpectedUpdatedAt for a value already
// decoded into a Go string: a blank or unparsable value becomes null, otherwise
// the canonical ISO string (millisecond precision, UTC, Z suffix) is returned.
func canonicalStoredTime(value string) *string {
	parsed, ok := parseStoredTime(value)
	if !ok {
		return nil
	}
	canonical := contract.FormatDateTime(parsed)
	return &canonical
}

// getSyncStatus reproduces getSyncStatus. It compares the persisted state and
// preset timestamps with the cached ones and reports the warning codes sorted
// lexicographically, exactly like Array.prototype.sort without a comparator.
func (r *policyReader) getSyncStatus(ctx context.Context, identity contract.Identity) (NewsEventSourcePolicySyncStatusModel, error) {
	warnings := map[string]struct{}{}
	add := func(code string) { warnings[code] = struct{}{} }

	state, stateErr := r.loadSourcePolicyState(ctx, identity.OrgID)
	if stateErr != nil {
		log.Printf("settingscrawl: source policy state read failed for org %s: %v", identity.OrgID, stateErr)
		state = fallbackSourcePolicyState()
		add(string(sourcePolicyWarningPolicyDBReadFailed))
	}
	_, presetUpdatedAt, presetErr := r.loadPreset(ctx, identity.OrgID)
	if presetErr != nil {
		log.Printf("settingscrawl: source policy preset read failed for org %s: %v", identity.OrgID, presetErr)
		presetUpdatedAt = nil
		add(string(sourcePolicyWarningPresetDBReadFailed))
	}

	policyCacheReadFailed := false
	cachedStateRaw, found, cacheErr := r.s.redisGetBytes(ctx, sourcePolicyCachePrefix+identity.OrgID)
	if cacheErr != nil {
		log.Printf("settingscrawl: source policy cache read failed for org %s: %v", identity.OrgID, cacheErr)
		policyCacheReadFailed = true
		add(string(sourcePolicyWarningPolicyCacheReadFailed))
	}
	var cachedState *sourcePolicyState
	if found {
		if parsed, ok := parseCachedSourcePolicyState(cachedStateRaw); ok {
			cachedState = &parsed
		}
	}

	presetCacheReadFailed := false
	cachedPresetRaw, presetFound, presetCacheErr := r.s.redisGetBytes(ctx, sourcePolicyPresetCachePrefix+identity.OrgID)
	if presetCacheErr != nil {
		log.Printf("settingscrawl: source policy preset cache read failed for org %s: %v", identity.OrgID, presetCacheErr)
		presetCacheReadFailed = true
		add(string(sourcePolicyWarningPresetCacheReadFailed))
	}

	// Policy comparison: a missing cache entry for a persisted revision is a
	// miss, two unequal canonical timestamps are stale.
	policyCacheUpdatedAt := (*string)(nil)
	if cachedState != nil {
		policyCacheUpdatedAt = canonicalStoredTime(cachedState.UpdatedAt)
	}
	policyDBUpdatedAt := canonicalStoredTime(state.UpdatedAt)
	policyCacheStale := false
	if policyCacheUpdatedAt != nil && policyDBUpdatedAt != nil && *policyCacheUpdatedAt != *policyDBUpdatedAt {
		policyCacheStale = true
		add(string(sourcePolicyWarningPolicyCacheStale))
	}
	if !policyCacheReadFailed && cachedState == nil && state.ActiveRevision > 0 && policyDBUpdatedAt != nil {
		add(string(sourcePolicyWarningPolicyCacheMiss))
	}

	// Preset comparison.
	presetCacheUpdatedAt := (*string)(nil)
	if presetFound {
		var probe map[string]json.RawMessage
		if err := json.Unmarshal(cachedPresetRaw, &probe); err == nil && probe != nil {
			if text, ok := settingString(probe["updatedAt"]); ok {
				presetCacheUpdatedAt = canonicalStoredTime(text)
			}
		}
	}
	var presetDBUpdatedAt *string
	if presetUpdatedAt != nil {
		canonical := contract.FormatDateTime(*presetUpdatedAt)
		presetDBUpdatedAt = &canonical
	}
	presetCacheStale := false
	if presetCacheUpdatedAt != nil && presetDBUpdatedAt != nil && *presetCacheUpdatedAt != *presetDBUpdatedAt {
		presetCacheStale = true
		add(string(sourcePolicyWarningPresetCacheStale))
	}
	// A falsy cached preset means the Redis key was absent, matching the
	// `cachedPreset === null` check in getSyncStatus.
	if !presetCacheReadFailed && !presetFound && presetDBUpdatedAt != nil {
		add(string(sourcePolicyWarningPresetCacheMiss))
	}
	codes := make([]string, 0, len(warnings))
	for code := range warnings {
		codes = append(codes, code)
	}
	sort.Strings(codes)

	// The force* fields come from the news-event settings document; a failed
	// settings read yields false / 1 exactly like the resolver's catch.
	forceMode := false
	forceMin := 1
	if settings, err := r.settings.newsEventSettings(ctx, identity.OrgID); err == nil {
		forceMode = settings.ForceAuthoritativeMode
		forceMin = clampForceMinSources(settings.ForceMinAuthoritativeSources)
	}
	return NewsEventSourcePolicySyncStatusModel{
		Degraded:                     len(codes) > 0,
		ForceAuthoritativeMode:       forceMode,
		ForceMinAuthoritativeSources: forceMin,
		PolicyCacheStale:             policyCacheStale,
		PresetCacheStale:             presetCacheStale,
		WarningCodes:                 codes,
	}, nil
}

// clampForceMinSources reproduces the resolver clamp(value, 1, 10).
func clampForceMinSources(value int) int {
	if value < 1 {
		return 1
	}
	if value > 10 {
		return 10
	}
	return value
}

// parseCachedSourcePolicyState applies the cache gate parseStateFromCache: the
// cached payload must be a version 2 object, otherwise it is ignored.
func parseCachedSourcePolicyState(raw []byte) (sourcePolicyState, bool) {
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err != nil || probe == nil {
		return sourcePolicyState{}, false
	}
	if !isSourcePolicyStateV2(probe) {
		return sourcePolicyState{}, false
	}
	var document sourcePolicyStateDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		return sourcePolicyState{}, false
	}
	return normalizeSourcePolicyState(document), true
}
