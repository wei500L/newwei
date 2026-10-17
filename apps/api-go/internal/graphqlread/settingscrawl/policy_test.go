package settingscrawl

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// TestEffectiveFromDeltaPreservesOrderAndAppliesRemovals pins the delta merge
// semantics: classifier default order is preserved, adds are appended in delta
// order and removals win because they are applied last.
func TestEffectiveFromDeltaPreservesOrderAndAppliesRemovals(t *testing.T) {
	defaults := defaultEffectiveSourcePolicy()
	delta := emptyDelta()
	delta.BlogDomainsAdd = []string{"example.com", "example.com", ""}
	delta.BlogDomainsRemove = []string{"reddit.com"}
	effective := effectiveFromDelta(delta)

	if len(effective.BlogDomains) != len(defaults.BlogDomains)-1+1 {
		t.Fatalf("blog domain count = %d", len(effective.BlogDomains))
	}
	if effective.BlogDomains[0] != defaults.BlogDomains[0] {
		t.Fatalf("default order not preserved: %q", effective.BlogDomains[0])
	}
	for _, entry := range effective.BlogDomains {
		if entry == "reddit.com" {
			t.Fatal("removed domain is still present")
		}
	}
	last := effective.BlogDomains[len(effective.BlogDomains)-1]
	if last != "example.com" {
		t.Fatalf("added domain should be appended, got %q", last)
	}
}

// TestBuildConflictWarningsUsesBlogOrderAndExactMatch pins the NestJS conflict
// rule. The pre-existing service compares exact strings and reports the
// blog-side spelling in blog-list order; there is no comparison-time case
// folding.
func TestBuildConflictWarningsUsesBlogOrderAndExactMatch(t *testing.T) {
	policy := effectiveSourcePolicy{
		AuthoritativeDomains: []string{"reuters.com", "shared.com"},
		BlogDomains:          []string{"shared.com", "second.com", "first.com"},
		AuthoritativeLabels:  []string{"Reuters"},
		BlogLabels:           []string{"Reuters", "reuters", "blog"},
	}
	warnings := buildConflictWarnings(policy)
	if !warnings.HasConflicts {
		t.Fatal("expected conflicts")
	}
	if len(warnings.DomainConflicts) != 1 || warnings.DomainConflicts[0] != "shared.com" {
		t.Fatalf("domain conflicts = %v", warnings.DomainConflicts)
	}
	// The exact-match rule keeps "Reuters" and drops the lowercase "reuters",
	// and the order follows the blog list.
	if len(warnings.LabelConflicts) != 1 || warnings.LabelConflicts[0] != "Reuters" {
		t.Fatalf("label conflicts = %v", warnings.LabelConflicts)
	}
}

// TestBuildConflictWarningsWithoutOverlap reports no conflicts.
func TestBuildConflictWarningsWithoutOverlap(t *testing.T) {
	warnings := buildConflictWarnings(effectiveSourcePolicy{
		AuthoritativeDomains: []string{"reuters.com"},
		BlogDomains:          []string{"substack.com"},
		AuthoritativeLabels:  []string{"reuters"},
		BlogLabels:           []string{"blog"},
	})
	if warnings.HasConflicts || len(warnings.DomainConflicts) != 0 || len(warnings.LabelConflicts) != 0 {
		t.Fatalf("unexpected warnings: %+v", warnings)
	}
}

// TestDiffAddKeepsTargetOrder checks the revision diff primitive.
func TestDiffAddKeepsTargetOrder(t *testing.T) {
	got := diffAdd([]string{"b", "c"}, []string{"a", "c", "a", "d", ""})
	want := []string{"a", "d"}
	if len(got) != len(want) {
		t.Fatalf("diffAdd = %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("diffAdd = %v, want %v", got, want)
		}
	}
}

// TestNormalizeSourcePolicyStringArrayTrimsAndDedupes pins the delta list
// normalization: entries are trimmed, empties dropped, duplicates collapsed and
// the value is never case folded.
func TestNormalizeSourcePolicyStringArrayTrimsAndDedupes(t *testing.T) {
	raw := json.RawMessage(`[" Reuters ", "reuters", "Reuters", "", 5, null, "BBC"]`)
	got := normalizeSourcePolicyStringArray(raw)
	want := []string{"Reuters", "reuters", "BBC"}
	if len(got) != len(want) {
		t.Fatalf("normalized = %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("normalized = %v, want %v", got, want)
		}
	}
	// A non-array payload yields the empty list, not nil.
	if list := normalizeSourcePolicyStringArray(json.RawMessage(`{"a":1}`)); list == nil || len(list) != 0 {
		t.Fatalf("non-array payload = %v", list)
	}
}

// TestNormalizeSourcePolicyRevisionClampsAndFilters covers the revision
// normalization guards.
func TestNormalizeSourcePolicyRevisionClampsAndFilters(t *testing.T) {
	if _, ok := normalizeSourcePolicyRevision(json.RawMessage(`{"revision":"2"}`)); ok {
		t.Fatal("a non-numeric revision must be dropped")
	}
	if _, ok := normalizeSourcePolicyRevision(json.RawMessage(`[]`)); ok {
		t.Fatal("a non-object revision must be dropped")
	}
	revision, ok := normalizeSourcePolicyRevision(json.RawMessage(`{"revision":0,"operation":"rollback","note":"  x  ","actorId":" u1 ","createdAt":"2026-10-17T14:03:21.123Z"}`))
	if !ok {
		t.Fatal("revision 0 must clamp up to 1")
	}
	if revision.Revision != 1 {
		t.Fatalf("revision = %d", revision.Revision)
	}
	if revision.Operation != NewsEventSourcePolicyRevisionOperationRollback {
		t.Fatalf("operation = %q", revision.Operation)
	}
	if revision.Note == nil || *revision.Note != "x" {
		t.Fatalf("note = %v", revision.Note)
	}
	if revision.ActorID == nil || *revision.ActorID != "u1" {
		t.Fatalf("actorId = %v", revision.ActorID)
	}
	unknown, ok := normalizeSourcePolicyRevision(json.RawMessage(`{"revision":3,"operation":"nonsense"}`))
	if !ok || unknown.Operation != NewsEventSourcePolicyRevisionOperationUpdate {
		t.Fatalf("unknown operation should map to update, got %q", unknown.Operation)
	}
}

// TestNormalizeSourcePolicyStateRetainsNewestRevisions checks the 60-revision
// retention window, the ascending order and the activeRevision promotion.
func TestNormalizeSourcePolicyStateRetainsNewestRevisions(t *testing.T) {
	entries := make([]string, 0, 65)
	for revision := 65; revision >= 1; revision-- {
		entries = append(entries, `{"revision":`+itoa(revision)+`,"createdAt":"2026-01-01T00:00:00.000Z"}`)
	}
	document := sourcePolicyStateDocument{
		Version:        json.RawMessage("2"),
		ActiveRevision: json.RawMessage("1"),
		UpdatedAt:      json.RawMessage(`"2026-01-01T00:00:00.000Z"`),
		Delta:          json.RawMessage("{}"),
		Revisions:      json.RawMessage("[" + strings.Join(entries, ",") + "]"),
	}
	state := normalizeSourcePolicyState(document)
	if len(state.Revisions) != sourcePolicyRevisionRetention {
		t.Fatalf("retained %d revisions", len(state.Revisions))
	}
	if state.Revisions[0].Revision != 6 {
		t.Fatalf("oldest retained revision = %d", state.Revisions[0].Revision)
	}
	if state.Revisions[len(state.Revisions)-1].Revision != 65 {
		t.Fatalf("newest retained revision = %d", state.Revisions[len(state.Revisions)-1].Revision)
	}
	if state.ActiveRevision != 65 {
		t.Fatalf("activeRevision = %d", state.ActiveRevision)
	}
}

// TestStateFromStoredValueMigratesLegacyPolicy checks the legacy migration path:
// the four-list document becomes revision 1 with the migrated-from-legacy note.
func TestStateFromStoredValueMigratesLegacyPolicy(t *testing.T) {
	raw := []byte(`{"authoritativeDomains":["example.com"],"authoritativeLabels":[],"blogDomains":[],"blogLabels":[]}`)
	state := stateFromStoredValue(raw, mustParseTime(t, "2026-01-02T03:04:05.000Z"), nullString("u9"))
	if state.ActiveRevision != 1 || len(state.Revisions) != 1 {
		t.Fatalf("state = %+v", state)
	}
	revision := state.Revisions[0]
	if revision.Operation != NewsEventSourcePolicyRevisionOperationUpdate {
		t.Fatalf("operation = %q", revision.Operation)
	}
	if revision.Note == nil || *revision.Note != "migrated-from-legacy" {
		t.Fatalf("note = %v", revision.Note)
	}
	if state.UpdatedAt != "2026-01-02T03:04:05.000Z" {
		t.Fatalf("updatedAt = %q", state.UpdatedAt)
	}
	if len(state.Delta.AuthoritativeDomainsAdd) != 1 || state.Delta.AuthoritativeDomainsAdd[0] != "example.com" {
		t.Fatalf("delta = %+v", state.Delta)
	}
}

// TestStateFromStoredValueFallsBackOnGarbage checks that an unrecognised payload
// reports the epoch state instead of failing.
func TestStateFromStoredValueFallsBackOnGarbage(t *testing.T) {
	state := stateFromStoredValue([]byte(`{"unexpected":true}`), mustParseTime(t, "2026-01-02T03:04:05.000Z"), nullString(""))
	if state.ActiveRevision != 0 || state.UpdatedAt != fallbackSourcePolicyUpdatedAt || len(state.Revisions) != 0 {
		t.Fatalf("state = %+v", state)
	}
}

// TestGetRevisionDiffReportsMissingRevision pins the 400 error surface: the
// clamped revision is interpolated, base is checked before target, and the
// failure carries HTTP 400 with no appCode.
func TestGetRevisionDiffReportsMissingRevision(t *testing.T) {
	reader := &policyReader{s: &store{}}
	_, err := reader.getRevisionDiff(context.Background(), "org-1", 0, 2)
	if err == nil {
		t.Fatal("expected an error")
	}
	failure, ok := asFailure(err)
	if !ok {
		t.Fatalf("error is not a contract.Failure: %v", err)
	}
	if failure.Message != "Revision 1 not found" {
		t.Fatalf("message = %q", failure.Message)
	}
	if failure.Status != 400 {
		t.Fatalf("status = %d", failure.Status)
	}
	if failure.AppCode != "" {
		t.Fatalf("appCode = %q", failure.AppCode)
	}
}

// TestClampRevisionMatchesNestJS checks the revision clamp.
func TestClampRevisionMatchesNestJS(t *testing.T) {
	cases := map[int]int{-5: 1, 0: 1, 1: 1, 7: 7}
	for input, want := range cases {
		if got := clampRevision(input); got != want {
			t.Fatalf("clampRevision(%d) = %d, want %d", input, got, want)
		}
	}
}

// TestNormalizeCategoryPrefixAndUnitClamps pins the category authority
// normalization rules.
func TestNormalizeCategoryPrefixAndUnitClamps(t *testing.T) {
	prefix := normalizeCategoryPrefix(json.RawMessage(`" Tech//AI // "`))
	if prefix == nil || *prefix != "tech/ai" {
		t.Fatalf("prefix = %v", prefix)
	}
	if prefix := normalizeCategoryPrefix(json.RawMessage(`"///"`)); prefix != nil {
		t.Fatalf("expected nil prefix, got %v", *prefix)
	}
	if prefix := normalizeCategoryPrefix(json.RawMessage(`42`)); prefix != nil {
		t.Fatalf("non-string prefix should be nil, got %v", *prefix)
	}
	// clampUnit rounds to four decimals and THEN clamps to [0, 1], so a value
	// above 1 collapses to 1 while a fraction keeps the rounded precision.
	if got := clampUnit(json.RawMessage(`1.23456`), 0); got != 1 {
		t.Fatalf("clampUnit above 1 = %v", got)
	}
	if got := clampUnit(json.RawMessage(`0.123456`), 0); got != 0.1235 {
		t.Fatalf("clampUnit fraction = %v", got)
	}
	if got := clampUnit(json.RawMessage(`"0.5"`), 0.25); got != 0.25 {
		t.Fatalf("string must not be parsed, got %v", got)
	}
	if got := clampSignedUnit(json.RawMessage(`-2`), 0); got != -1 {
		t.Fatalf("clampSignedUnit = %v", got)
	}
}

// TestNormalizeListOrFallbackKeepsRawFallback pins the preset rule: a value that
// is not an array returns the fallback WITHOUT normalizing it, so the mixed-case
// preset defaults survive.
func TestNormalizeListOrFallbackKeepsRawFallback(t *testing.T) {
	fallback := []string{"Reuters", "Associated Press"}
	got := normalizeListOrFallback(json.RawMessage(`"nope"`), func(string) string { return "" }, fallback)
	if len(got) != 2 || got[0] != "Reuters" {
		t.Fatalf("fallback = %v", got)
	}
	// An empty array overrides the fallback.
	if got := normalizeListOrFallback(json.RawMessage(`[]`), func(string) string { return "" }, fallback); len(got) != 0 {
		t.Fatalf("empty array should override, got %v", got)
	}
}

// TestCanonicalStoredTimeNormalizesToMillisecondUTC checks the sync-status
// timestamp canonicalization.
func TestCanonicalStoredTimeNormalizesToMillisecondUTC(t *testing.T) {
	got := canonicalStoredTime("2026-10-17T14:03:21Z")
	if got == nil || *got != "2026-10-17T14:03:21.000Z" {
		t.Fatalf("canonicalStoredTime = %v", got)
	}
	if got := canonicalStoredTime("   "); got != nil {
		t.Fatalf("blank value should be nil, got %v", *got)
	}
	if got := canonicalStoredTime("not-a-date"); got != nil {
		t.Fatalf("unparsable value should be nil, got %v", *got)
	}
}

// TestIsReviewedEvidenceMatchesTheWhitelist pins the in-memory review filter.
func TestIsReviewedEvidenceMatchesTheWhitelist(t *testing.T) {
	reviewed := []string{
		`{"review":{"status":"approved"}}`,
		`{"review":{"status":" approved "}}`,
		`{"review":{"status":"rejected"}}`,
		`{"review":{"status":"corrected"}}`,
	}
	for _, raw := range reviewed {
		if !isReviewedEvidence([]byte(raw)) {
			t.Fatalf("expected reviewed: %s", raw)
		}
	}
	unreviewed := []string{
		`{}`,
		`{"review":null}`,
		`{"review":{}}`,
		`{"review":{"status":""}}`,
		`{"review":{"status":"   "}}`,
		`{"review":{"status":"APPROVED"}}`,
		`{"review":{"status":"pending"}}`,
		`{"review":{"status":7}}`,
		`{"review":[]}`,
		`[]`,
		``,
		`null`,
	}
	for _, raw := range unreviewed {
		if isReviewedEvidence([]byte(raw)) {
			t.Fatalf("expected unreviewed: %s", raw)
		}
	}
}

// TestRegisterRootPermissions pins the twenty root permissions, the multi
// permission review root and the absence of crawlMetadata.
func TestRegisterRootPermissions(t *testing.T) {
	registry := testRegistry()
	expected := map[string]string{
		"rateLimitSettings":                 permissionSettingsManage,
		"entityImpactGraphSettings":         permissionDashboardsRead,
		"knowledgeGraphSettings":            permissionDashboardsRead,
		"newsEventSettings":                 permissionDashboardsRead,
		"newsEventSourcePolicy":             permissionSettingsManage,
		"newsEventSourcePolicyPresets":      permissionSettingsManage,
		"newsEventSourcePolicyRevisionDiff": permissionSettingsManage,
		"newsClassificationSettings":        permissionSettingsManage,
		"classificationQualitySettings":     permissionSettingsManage,
		"newsDedupeSettings":                permissionSettingsManage,
		"newsIndicatorSettings":             permissionDashboardsRead,
		"authCacheSettings":                 permissionSettingsManage,
		"crawlClientSettings":               permissionSettingsManage,
		"auditLogRetention":                 permissionSettingsManage,
		"newsExtractionSettings":            permissionSettingsManage,
		"newsPromptConfig":                  permissionSettingsManage,
		"newsEventSourcePolicySyncStatus":   permissionItemsRead,
		"crawlTasks":                        permissionCrawlRead,
		"crawlTask":                         permissionCrawlRead,
	}
	if len(expected) != 19 {
		t.Fatalf("test table covers %d roots", len(expected))
	}
	for name, permission := range expected {
		root, ok := registry.Root(name)
		if !ok {
			t.Fatalf("root %s is not registered", name)
		}
		if root.Permission != permission {
			t.Fatalf("root %s permission = %q, want %q", name, root.Permission, permission)
		}
	}
	review, ok := registry.Root("knowledgeGraphEvidenceReviewQueue")
	if !ok {
		t.Fatal("review root is not registered")
	}
	if len(review.AnyPermissions) != 2 ||
		review.AnyPermissions[0] != permissionSettingsManage ||
		review.AnyPermissions[1] != permissionKnowledgeGraphApply {
		t.Fatalf("review AnyPermissions = %v", review.AnyPermissions)
	}
	if review.Permission != "" {
		t.Fatalf("review root must not set a single permission, got %q", review.Permission)
	}
	if _, ok := registry.Root("crawlMetadata"); ok {
		t.Fatal("crawlMetadata must not be migrated")
	}
	// Every registered object type must project its fields, so the executor can
	// own a document that selects them.
	for _, typeName := range []string{
		"RateLimitSettingsModel", "NewsEventSettingsModel", "NewsPromptConfigModel",
		"NewsEventSourcePolicySettingsModel", "NewsEventSourcePolicyRevisionDiffModel",
		"NewsEventSourcePolicySyncStatusModel", "KnowledgeGraphEvidenceReviewItemModel",
		"CrawlTaskConnection", "CrawlTaskModel", "CrawlResultModel", "PageInfo",
	} {
		if !registry.HasType(typeName) {
			t.Fatalf("type %s is not registered", typeName)
		}
	}
}

// testRegistry builds a registry with the twenty roots. Register only stores
// resolvers and type metadata, so a nil database is safe here: no resolver runs
// during registration.
func testRegistry() *contract.Registry {
	registry := contract.NewRegistry()
	Register(registry, nil, Options{})
	return registry
}

// itoa is a small local integer formatter used to build JSON fixtures.
func itoa(value int) string {
	return strconv.Itoa(value)
}

// mustParseTime parses a stored ISO timestamp for a fixture.
func mustParseTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		t.Fatalf("parse %q: %v", value, err)
	}
	return parsed
}

// nullString builds a valid nullable SQL string, or an invalid one for "".
func nullString(value string) sql.NullString {
	if value == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: value, Valid: true}
}

// asFailure extracts the contract failure from an error.
func asFailure(err error) (*contract.Failure, bool) {
	var failure *contract.Failure
	if errors.As(err, &failure) && failure != nil {
		return failure, true
	}
	return nil, false
}
