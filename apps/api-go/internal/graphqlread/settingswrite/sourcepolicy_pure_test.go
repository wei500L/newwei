package settingswrite

import (
	"context"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
)

// TestRegisterSourcePolicyAddsOnlyFourMutations pins the independent entry
// point: the four version roots are registered with settings.manage and the
// legacy settings mutation is not widened in.
func TestRegisterSourcePolicyAddsOnlyFourMutations(t *testing.T) {
	reg := contract.NewRegistry()
	RegisterSourcePolicy(reg, nil, nil)
	for _, name := range SourcePolicyRegisteredMutations {
		root, ok := reg.Mutation(name)
		if !ok {
			t.Fatalf("mutation %s is not registered", name)
		}
		if root.Permission != "settings.manage" {
			t.Fatalf("%s permission = %q", name, root.Permission)
		}
	}
	if _, ok := reg.Mutation("updateRateLimitSettings"); ok {
		t.Fatal("the source-policy entry point must not register the legacy settings mutations")
	}
}

// TestSourcePolicyUpdateRollbackResetChain pins the version chain: update
// appends revision 1, rollback appends revision 2 with the target delta and the
// default note, and reset appends revision 3 with an empty delta. The active
// revision advances at every step and no earlier revision is removed.
func TestSourcePolicyUpdateRollbackResetChain(t *testing.T) {
	previous := settingscrawl.NewFallbackSourcePolicyState()
	lists := sourcePolicyTestLists()
	start := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	note := "first"

	updated := nextSourcePolicyUpdate(previous, lists, "user-1", &note, start)
	if updated.ActiveRevision != 1 || len(updated.Revisions) != 1 {
		t.Fatalf("update active=%d revisions=%d", updated.ActiveRevision, len(updated.Revisions))
	}
	if updated.Revisions[0].Operation != settingscrawl.NewsEventSourcePolicyRevisionOperationUpdate {
		t.Fatalf("update operation = %q", updated.Revisions[0].Operation)
	}
	if updated.Revisions[0].Note == nil || *updated.Revisions[0].Note != "first" {
		t.Fatalf("update note = %v", updated.Revisions[0].Note)
	}

	target := updated.Revisions[0]
	rolledBack := nextSourcePolicyRollback(updated, target, "user-1", nil, start.Add(time.Second))
	if rolledBack.ActiveRevision != 2 || len(rolledBack.Revisions) != 2 {
		t.Fatalf("rollback active=%d revisions=%d", rolledBack.ActiveRevision, len(rolledBack.Revisions))
	}
	rollbackRevision := rolledBack.Revisions[1]
	if rollbackRevision.Operation != settingscrawl.NewsEventSourcePolicyRevisionOperationRollback {
		t.Fatalf("rollback operation = %q", rollbackRevision.Operation)
	}
	if rollbackRevision.Note == nil || *rollbackRevision.Note != "rollback->1" {
		t.Fatalf("rollback note = %v", rollbackRevision.Note)
	}
	if string(rollbackRevision.Delta.BlogDomainsAdd[0]) != "example.com" {
		t.Fatalf("rollback delta = %+v", rollbackRevision.Delta)
	}
	if rolledBack.Revisions[0].Revision != 1 {
		t.Fatalf("rollback dropped history: %+v", rolledBack.Revisions)
	}

	reset := nextSourcePolicyReset(rolledBack, "user-1", nil, start.Add(2*time.Second))
	if reset.ActiveRevision != 3 || len(reset.Revisions) != 3 {
		t.Fatalf("reset active=%d revisions=%d", reset.ActiveRevision, len(reset.Revisions))
	}
	resetRevision := reset.Revisions[2]
	if resetRevision.Operation != settingscrawl.NewsEventSourcePolicyRevisionOperationReset {
		t.Fatalf("reset operation = %q", resetRevision.Operation)
	}
	if len(resetRevision.Delta.AuthoritativeDomainsAdd) != 0 ||
		len(resetRevision.Delta.AuthoritativeDomainsRemove) != 0 ||
		len(resetRevision.Delta.BlogDomainsAdd) != 0 ||
		len(resetRevision.Delta.BlogDomainsRemove) != 0 {
		t.Fatalf("reset delta is not empty: %+v", resetRevision.Delta)
	}
	if len(reset.Revisions) != 3 || reset.Revisions[0].Revision != 1 {
		t.Fatalf("reset dropped history: %+v", reset.Revisions)
	}
}

// TestSourcePolicyStateRetainsSixtyAndProjectsTwenty pins the three history
// limits: 60 persisted revisions, 20 projected by a mutation, and a descending
// mutation response.
func TestSourcePolicyStateRetainsSixtyAndProjectsTwenty(t *testing.T) {
	state := settingscrawl.NewFallbackSourcePolicyState()
	lists := sourcePolicyTestLists()
	start := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	for index := 0; index < 65; index++ {
		state = nextSourcePolicyUpdate(state, lists, "user-1", nil, start.Add(time.Duration(index)*time.Millisecond))
	}
	if state.ActiveRevision != 65 || len(state.Revisions) != 60 {
		t.Fatalf("active=%d revisions=%d", state.ActiveRevision, len(state.Revisions))
	}
	if state.Revisions[0].Revision != 6 || state.Revisions[59].Revision != 65 {
		t.Fatalf("retained window = %d..%d", state.Revisions[0].Revision, state.Revisions[59].Revision)
	}

	model := settingscrawl.BuildSourcePolicySettingsModel(state, nil, nil)
	if len(model.Revisions) != 20 {
		t.Fatalf("projected revisions = %d", len(model.Revisions))
	}
	if model.Revisions[0].Revision != 65 || model.Revisions[19].Revision != 46 {
		t.Fatalf("projected window = %d..%d", model.Revisions[0].Revision, model.Revisions[19].Revision)
	}
	if model.SyncWarnings == nil || model.CategoryAuthority == nil {
		t.Fatalf("non-null lists must be [] not null: %+v", model)
	}
}

// TestSourcePolicyCategoryAuthorityUsesReaderRules checks that the write path
// reuses the reader's prefix sanitizer, first-prefix dedupe, four-decimal
// rounding and domain-boost dedupe.
func TestSourcePolicyCategoryAuthorityUsesReaderRules(t *testing.T) {
	rules := settingscrawl.NormalizeSourceCategoryAuthorityRules([]settingscrawl.SourceCategoryAuthorityRule{
		{
			CategoryPrefix:     " /News//World/ ",
			AuthoritativeBoost: 0.123456,
			BlogPenalty:        -2,
			UnknownPenalty:     2,
			MinConfidenceFloor: 0.55556,
			MismatchPenalty:    0.66666,
			DomainBoosts: []settingscrawl.SourceCategoryAuthorityDomainBoost{
				{Domain: "WWW.Example.com", Delta: 0.11111},
				{Domain: "example.com", Delta: 0.22222},
			},
		},
		{CategoryPrefix: "news/world", AuthoritativeBoost: 1},
	})
	if len(rules) != 1 {
		t.Fatalf("rules = %+v", rules)
	}
	rule := rules[0]
	if rule.CategoryPrefix != "news/world" {
		t.Fatalf("prefix = %q", rule.CategoryPrefix)
	}
	if rule.AuthoritativeBoost != 0.1235 || rule.BlogPenalty != -1 || rule.UnknownPenalty != 1 {
		t.Fatalf("clamps/rounding = %+v", rule)
	}
	if rule.MinConfidenceFloor != 0.5556 || rule.MismatchPenalty != 0.6667 {
		t.Fatalf("unit clamps/rounding = %+v", rule)
	}
	if len(rule.DomainBoosts) != 1 || rule.DomainBoosts[0].Domain != "example.com" || rule.DomainBoosts[0].Delta != 0.1111 {
		t.Fatalf("domain boosts = %+v", rule.DomainBoosts)
	}
}

// TestSourcePolicyInputPresenceDistinguishesOmittedNullAndEmpty pins the
// presence semantics that the resolver's `hasOwnProperty` checks implement.
func TestSourcePolicyInputPresenceDistinguishesOmittedNullAndEmpty(t *testing.T) {
	base := func() map[string]any {
		return map[string]any{
			"authoritativeDomains": []any{},
			"authoritativeLabels":  []any{},
			"blogDomains":          []any{},
			"blogLabels":           []any{},
		}
	}

	omittedInput := base()
	omitted, err := parseUpdateNewsEventSourcePolicyInput(map[string]any{"input": omittedInput})
	if err != nil {
		t.Fatal(err)
	}
	if omitted.CategoryAuthorityPresent {
		t.Fatal("omitted categoryAuthority must not be present")
	}

	nullInput := base()
	nullInput["categoryAuthority"] = nil
	nullParsed, err := parseUpdateNewsEventSourcePolicyInput(map[string]any{"input": nullInput})
	if err != nil {
		t.Fatal(err)
	}
	if !nullParsed.CategoryAuthorityPresent || len(nullParsed.CategoryAuthority) != 0 {
		t.Fatalf("null categoryAuthority = present:%v rules:%d", nullParsed.CategoryAuthorityPresent, len(nullParsed.CategoryAuthority))
	}

	emptyInput := base()
	emptyInput["categoryAuthority"] = []any{}
	emptyParsed, err := parseUpdateNewsEventSourcePolicyInput(map[string]any{"input": emptyInput})
	if err != nil {
		t.Fatal(err)
	}
	if !emptyParsed.CategoryAuthorityPresent || len(emptyParsed.CategoryAuthority) != 0 {
		t.Fatalf("empty categoryAuthority = present:%v rules:%d", emptyParsed.CategoryAuthorityPresent, len(emptyParsed.CategoryAuthority))
	}
}

// TestSourcePolicyExpectedRevisionKeepsZero checks that 0 is a real expectation
// while omitted and explicit null both skip the comparison.
func TestSourcePolicyExpectedRevisionKeepsZero(t *testing.T) {
	base := map[string]any{
		"authoritativeDomains": []any{},
		"authoritativeLabels":  []any{},
		"blogDomains":          []any{},
		"blogLabels":           []any{},
	}
	zero := base
	zero["expectedRevision"] = 0
	parsed, err := parseResetNewsEventSourcePolicyInput(map[string]any{"input": zero})
	if err != nil {
		t.Fatal(err)
	}
	if !parsed.ExpectedRevisionPresent || parsed.ExpectedRevision == nil || *parsed.ExpectedRevision != 0 {
		t.Fatalf("expectedRevision 0 = present:%v value:%v", parsed.ExpectedRevisionPresent, parsed.ExpectedRevision)
	}
	if err := checkSourcePolicyExpectedRevision(parsed.ExpectedRevisionPresent, parsed.ExpectedRevision, 0); err != nil {
		t.Fatalf("0 must match current 0: %v", err)
	}
	if err := checkSourcePolicyExpectedRevision(parsed.ExpectedRevisionPresent, parsed.ExpectedRevision, 1); err == nil {
		t.Fatal("0 must not match current 1")
	}

	null := base
	null["expectedRevision"] = nil
	nullParsed, err := parseResetNewsEventSourcePolicyInput(map[string]any{"input": null})
	if err != nil {
		t.Fatal(err)
	}
	if !nullParsed.ExpectedRevisionPresent || nullParsed.ExpectedRevision != nil {
		t.Fatalf("expectedRevision null = present:%v value:%v", nullParsed.ExpectedRevisionPresent, nullParsed.ExpectedRevision)
	}
	if err := checkSourcePolicyExpectedRevision(nullParsed.ExpectedRevisionPresent, nullParsed.ExpectedRevision, 42); err != nil {
		t.Fatalf("null must skip the comparison: %v", err)
	}
}

// TestSourcePolicyExpectedUpdatedAtNormalization covers the three timestamp
// forms and the null/blank/invalid normalization used before comparison.
func TestSourcePolicyExpectedUpdatedAtNormalization(t *testing.T) {
	if got := normalizeSourcePolicyExpectedUpdatedAt(nil); got != nil {
		t.Fatalf("nil = %v", got)
	}
	blank := "  "
	if got := normalizeSourcePolicyExpectedUpdatedAt(&blank); got != nil {
		t.Fatalf("blank = %v", got)
	}
	invalid := "not-a-date"
	if got := normalizeSourcePolicyExpectedUpdatedAt(&invalid); got != nil {
		t.Fatalf("invalid = %v", got)
	}
	utc := "2026-10-18T12:00:00+03:00"
	if got := normalizeSourcePolicyExpectedUpdatedAt(&utc); got == nil || *got != "2026-10-18T09:00:00.000Z" {
		t.Fatalf("offset = %v", got)
	}
	date := "2026-10-18"
	if got := normalizeSourcePolicyExpectedUpdatedAt(&date); got == nil || *got != "2026-10-18T00:00:00.000Z" {
		t.Fatalf("date = %v", got)
	}
	if !sourcePolicyTimestampsEqual(nil, nil) {
		t.Fatal("two nulls must compare equal")
	}
	one := "2026-10-18T00:00:00.000Z"
	if sourcePolicyTimestampsEqual(nil, &one) {
		t.Fatal("null and a timestamp must compare unequal")
	}
}

// TestSourcePolicyCacheFailureBecomesWarningBoundary checks the no-Redis branch
// exposes an error to its caller instead of silently claiming the refresh.
func TestSourcePolicyCacheFailureBecomesWarningBoundary(t *testing.T) {
	svc := &service{}
	if err := svc.setSourcePolicyCache(context.Background(), "newsEvents:sourcePolicy:org", []byte(`{}`), 60); err == nil {
		t.Fatal("missing redis must not report a successful cache write")
	}
}

func sourcePolicyTestLists() settingscrawl.SourcePolicyLists {
	defaults := settingscrawl.DefaultSourcePolicyLists()
	return settingscrawl.SourcePolicyLists{
		AuthoritativeDomains: append(append([]string{}, defaults.AuthoritativeDomains[1:]...), "example.org"),
		AuthoritativeLabels:  append([]string{}, defaults.AuthoritativeLabels...),
		BlogDomains:          append(append([]string{}, defaults.BlogDomains...), "example.com"),
		BlogLabels:           append([]string{}, defaults.BlogLabels...),
	}
}
