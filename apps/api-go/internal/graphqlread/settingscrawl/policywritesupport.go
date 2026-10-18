package settingscrawl

import (
	"context"
	"database/sql"
	"encoding/json"
	"sort"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

// This file is the narrow write-support surface of the source-policy aggregate.
// The four source-policy mutations live in
// internal/graphqlread/settingswrite; they must build revisions and persist
// documents that the Query roots (newsEventSourcePolicy,
// newsEventSourcePolicyPresets, newsEventSourcePolicyRevisionDiff,
// newsEventSourcePolicySyncStatus) and the NestJS readers observe as the same
// data. Exporting the defaults, normalizers, delta rules, serializers and
// projections from here keeps one implementation of the state machine instead
// of a second copy in the write package.
//
// Nothing in this file registers a root or owns cache state: the write package
// performs the writes and the audits.

// sourcePolicyMutationHistoryLimit is the number of revisions a mutation
// response carries. The Query roots keep their own 30 and the persisted
// document keeps 60, so the three limits must never be mixed.
const sourcePolicyMutationHistoryLimit = 20

// SourcePolicyState is the normalized version 2 state document. The write path
// loads the full persisted state instead of the Query projection, because the
// retained revisions and the internal delta are what the next write must
// preserve.
type SourcePolicyState struct {
	ActiveRevision int
	UpdatedAt      string
	Delta          NewsEventSourcePolicyDeltaModel
	Revisions      []SourcePolicyRevision
}

// SourcePolicyRevision is one normalized revision entry. CreatedAtRaw keeps the
// stored ISO string so a write does not rewrite the timestamps of older
// revisions; CreatedAt is the same instant for GraphQL projection.
type SourcePolicyRevision struct {
	Revision     int
	Operation    NewsEventSourcePolicyRevisionOperation
	ActorID      *string
	CreatedAt    time.Time
	CreatedAtRaw string
	Note         *string
	Delta        NewsEventSourcePolicyDeltaModel
}

// SourcePolicyLists is the four effective source-policy lists.
type SourcePolicyLists struct {
	AuthoritativeDomains []string
	AuthoritativeLabels  []string
	BlogDomains          []string
	BlogLabels           []string
}

// SourceCategoryAuthorityDomainBoost is one submitted domain boost after
// DTO validation.
type SourceCategoryAuthorityDomainBoost struct {
	Domain string
	Delta  float64
}

// SourceCategoryAuthorityRule is one submitted category-authority rule
// after DTO validation. minConfidenceFloor and mismatchPenalty are already
// defaulted to 0 by the resolver semantics, so they are plain numbers here.
type SourceCategoryAuthorityRule struct {
	CategoryPrefix     string
	AuthoritativeBoost float64
	BlogPenalty        float64
	UnknownPenalty     float64
	MinConfidenceFloor float64
	MismatchPenalty    float64
	DomainBoosts       []SourceCategoryAuthorityDomainBoost
}

// SourcePolicyDeltaDocument is the persisted and audited delta snapshot: the
// eight lists with their exact NestJS property names.
type SourcePolicyDeltaDocument struct {
	AuthoritativeDomainsAdd    []string `json:"authoritativeDomainsAdd"`
	AuthoritativeDomainsRemove []string `json:"authoritativeDomainsRemove"`
	AuthoritativeLabelsAdd     []string `json:"authoritativeLabelsAdd"`
	AuthoritativeLabelsRemove  []string `json:"authoritativeLabelsRemove"`
	BlogDomainsAdd             []string `json:"blogDomainsAdd"`
	BlogDomainsRemove          []string `json:"blogDomainsRemove"`
	BlogLabelsAdd              []string `json:"blogLabelsAdd"`
	BlogLabelsRemove           []string `json:"blogLabelsRemove"`
}

// SourcePolicyCategoryAuthorityDocument is one persisted category-authority
// rule.
type SourcePolicyCategoryAuthorityDocument struct {
	CategoryPrefix     string                            `json:"categoryPrefix"`
	AuthoritativeBoost float64                           `json:"authoritativeBoost"`
	BlogPenalty        float64                           `json:"blogPenalty"`
	UnknownPenalty     float64                           `json:"unknownPenalty"`
	MinConfidenceFloor float64                           `json:"minConfidenceFloor"`
	MismatchPenalty    float64                           `json:"mismatchPenalty"`
	DomainBoosts       []SourcePolicyDomainBoostDocument `json:"domainBoosts"`
}

// SourcePolicyDomainBoostDocument is one persisted domain boost.
type SourcePolicyDomainBoostDocument struct {
	Domain string  `json:"domain"`
	Delta  float64 `json:"delta"`
}

// SourcePolicyPresetDocument is the persisted preset document and the preset
// audit object. categoryAuthority is omitted when the caller supplied no rules;
// an explicit empty list clears the separately keyed rules and leaves the
// property absent, exactly like normalizeSourcePolicy in NestJS.
type SourcePolicyPresetDocument struct {
	AuthoritativeDomains []string                                `json:"authoritativeDomains"`
	AuthoritativeLabels  []string                                `json:"authoritativeLabels"`
	BlogDomains          []string                                `json:"blogDomains"`
	BlogLabels           []string                                `json:"blogLabels"`
	CategoryAuthority    []SourcePolicyCategoryAuthorityDocument `json:"categoryAuthority,omitempty"`
}

// NewFallbackSourcePolicyState returns the missing-state shape: revision 0,
// the epoch updatedAt and no history.
func NewFallbackSourcePolicyState() SourcePolicyState {
	return sourcePolicyStateFromPrivate(fallbackSourcePolicyState())
}

// DefaultSourcePolicyLists returns copies of the built-in default policy lists
// shared with the public-portal classifier.
func DefaultSourcePolicyLists() SourcePolicyLists {
	domains, labels, blogDomains, blogLabels := publicportal.DefaultSourcePolicyLists()
	return SourcePolicyLists{
		AuthoritativeDomains: domains,
		AuthoritativeLabels:  labels,
		BlogDomains:          blogDomains,
		BlogLabels:           blogLabels,
	}
}

// DefaultSourcePolicyPresetLists returns copies of DEFAULT_POLICY_PRESET. The
// preset defaults are deliberately not the active-policy defaults: the active
// defaults are the classifier's normalized 153/135/42/26 lists, while the
// preset keeps the smaller 15/15/12/10 editor seed lists.
func DefaultSourcePolicyPresetLists() SourcePolicyLists {
	return SourcePolicyLists{
		AuthoritativeDomains: append([]string{}, defaultPolicyPresetAuthoritativeDomains...),
		AuthoritativeLabels:  append([]string{}, defaultPolicyPresetAuthoritativeLabels...),
		BlogDomains:          append([]string{}, defaultPolicyPresetBlogDomains...),
		BlogLabels:           append([]string{}, defaultPolicyPresetBlogLabels...),
	}
}

// NormalizeSourcePolicyDomainList applies the classifier's domain normalizer to
// one submitted list: trimmed and lowercased, invalid characters dropped, empties
// removed, first occurrence kept and the 1000-entry cap applied.
func NormalizeSourcePolicyDomainList(values []string) []string {
	return normalizeSubmittedSourcePolicyList(values, publicportal.NormalizeSourcePolicyDomain)
}

// NormalizeSourcePolicyLabelList applies the classifier's label normalizer to
// one submitted list with the same dedupe and cap rules.
func NormalizeSourcePolicyLabelList(values []string) []string {
	return normalizeSubmittedSourcePolicyList(values, publicportal.NormalizeSourcePolicyLabel)
}

// normalizeSubmittedSourcePolicyList reproduces normalizeUnique / the
// normalizeListOrFallback loop for a list the caller always supplies.
func normalizeSubmittedSourcePolicyList(values []string, normalize func(string) string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, raw := range values {
		normalized := normalize(raw)
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

// EmptySourcePolicyDelta returns the all-empty delta snapshot with non-nil
// lists, so a persisted or projected empty list serializes as [] and never null.
func EmptySourcePolicyDelta() NewsEventSourcePolicyDeltaModel {
	return emptyDelta()
}

// CloneSourcePolicyDelta copies all eight lists so a caller cannot alias
// persisted or projected state.
func CloneSourcePolicyDelta(delta NewsEventSourcePolicyDeltaModel) NewsEventSourcePolicyDeltaModel {
	return cloneDelta(delta)
}

// SourcePolicyDeltaFromLists turns the four effective lists into the eight
// add/remove lists relative to the built-in defaults. The add lists follow the
// target order and the remove lists follow the default order, exactly like
// toDeltaFromEffectivePolicy.
func SourcePolicyDeltaFromLists(lists SourcePolicyLists) NewsEventSourcePolicyDeltaModel {
	return deltaFromEffectivePolicy(effectiveSourcePolicy{
		AuthoritativeDomains: lists.AuthoritativeDomains,
		AuthoritativeLabels:  lists.AuthoritativeLabels,
		BlogDomains:          lists.BlogDomains,
		BlogLabels:           lists.BlogLabels,
	})
}

// NewSourcePolicyRevision builds one revision entry. createdAt is stored both
// as a time.Time for projection and as the UTC millisecond ISO string that the
// persisted document keeps; the two must describe the same instant because a
// later state load uses updatedAt to compare cache freshness.
func NewSourcePolicyRevision(
	number int,
	operation NewsEventSourcePolicyRevisionOperation,
	actorID *string,
	createdAt time.Time,
	note *string,
	delta NewsEventSourcePolicyDeltaModel,
) SourcePolicyRevision {
	return SourcePolicyRevision{
		Revision:     number,
		Operation:    operation,
		ActorID:      actorID,
		CreatedAt:    createdAt,
		CreatedAtRaw: contract.FormatDateTime(createdAt),
		Note:         note,
		Delta:        cloneDelta(delta),
	}
}

// AppendSourcePolicyState returns the next state after one new revision: the
// active revision becomes the new revision number (never a smaller value, so a
// rollback cannot rewind history), updatedAt becomes that revision's timestamp
// and the retained history is sorted ascending and capped at 60 entries.
//
// The previous history is copied first: the caller's state may still be
// referenced by a cached document.
func AppendSourcePolicyState(previous SourcePolicyState, revision SourcePolicyRevision) SourcePolicyState {
	internal := sourcePolicyStateToPrivate(previous)
	revisions := make([]sourcePolicyRevision, 0, len(internal.Revisions)+1)
	revisions = append(revisions, internal.Revisions...)
	revisions = append(revisions, sourcePolicyRevisionToPrivate(revision))
	sort.SliceStable(revisions, func(i, j int) bool { return revisions[i].Revision < revisions[j].Revision })
	if len(revisions) > sourcePolicyRevisionRetention {
		revisions = revisions[len(revisions)-sourcePolicyRevisionRetention:]
	}
	createdAt := revision.CreatedAtRaw
	if createdAt == "" {
		createdAt = contract.FormatDateTime(revision.CreatedAt)
	}
	return sourcePolicyStateFromPrivate(sourcePolicyState{
		ActiveRevision: revision.Revision,
		UpdatedAt:      createdAt,
		Delta:          cloneDelta(revision.Delta),
		Revisions:      revisions,
	})
}

// NormalizeSourceCategoryAuthorityRules reproduces normalizeSourceCategoryAuthority
// for already validated input. The typed rules are encoded and passed through
// the reader's normalizer so the prefix filter, first-prefix-wins dedupe, the
// 200/100 caps, the four-decimal rounding and the clamps stay one
// implementation.
func NormalizeSourceCategoryAuthorityRules(rules []SourceCategoryAuthorityRule) []NewsEventSourceCategoryAuthorityRuleModel {
	documents := make([]SourcePolicyCategoryAuthorityDocument, 0, len(rules))
	for _, rule := range rules {
		boosts := make([]SourcePolicyDomainBoostDocument, 0, len(rule.DomainBoosts))
		for _, boost := range rule.DomainBoosts {
			boosts = append(boosts, SourcePolicyDomainBoostDocument{Domain: boost.Domain, Delta: boost.Delta})
		}
		documents = append(documents, SourcePolicyCategoryAuthorityDocument{
			CategoryPrefix:     rule.CategoryPrefix,
			AuthoritativeBoost: rule.AuthoritativeBoost,
			BlogPenalty:        rule.BlogPenalty,
			UnknownPenalty:     rule.UnknownPenalty,
			MinConfidenceFloor: rule.MinConfidenceFloor,
			MismatchPenalty:    rule.MismatchPenalty,
			DomainBoosts:       boosts,
		})
	}
	raw, err := json.Marshal(documents)
	if err != nil {
		return []NewsEventSourceCategoryAuthorityRuleModel{}
	}
	return normalizeSourceCategoryAuthority(raw, nil)
}

// NewSourcePolicyDeltaDocument converts a projected delta into its persisted
// and audited shape, ensuring the eight non-null lists serialize as [].
func NewSourcePolicyDeltaDocument(delta NewsEventSourcePolicyDeltaModel) SourcePolicyDeltaDocument {
	return SourcePolicyDeltaDocument{
		AuthoritativeDomainsAdd:    nonNilStrings(delta.AuthoritativeDomainsAdd),
		AuthoritativeDomainsRemove: nonNilStrings(delta.AuthoritativeDomainsRemove),
		AuthoritativeLabelsAdd:     nonNilStrings(delta.AuthoritativeLabelsAdd),
		AuthoritativeLabelsRemove:  nonNilStrings(delta.AuthoritativeLabelsRemove),
		BlogDomainsAdd:             nonNilStrings(delta.BlogDomainsAdd),
		BlogDomainsRemove:          nonNilStrings(delta.BlogDomainsRemove),
		BlogLabelsAdd:              nonNilStrings(delta.BlogLabelsAdd),
		BlogLabelsRemove:           nonNilStrings(delta.BlogLabelsRemove),
	}
}

// NewSourcePolicyPresetDocument builds the preset document and preset audit
// object. The category rules are emitted only when non-empty, matching the
// NestJS normalizeSourcePolicy object literal.
func NewSourcePolicyPresetDocument(lists SourcePolicyLists, rules []NewsEventSourceCategoryAuthorityRuleModel) SourcePolicyPresetDocument {
	document := SourcePolicyPresetDocument{
		AuthoritativeDomains: nonNilStrings(lists.AuthoritativeDomains),
		AuthoritativeLabels:  nonNilStrings(lists.AuthoritativeLabels),
		BlogDomains:          nonNilStrings(lists.BlogDomains),
		BlogLabels:           nonNilStrings(lists.BlogLabels),
	}
	if len(rules) > 0 {
		document.CategoryAuthority = categoryAuthorityDocumentsOf(rules)
	}
	return document
}

// categoryAuthorityDocumentsOf converts projected rules into the persisted
// shape; every nested domainBoosts list is non-nil.
func categoryAuthorityDocumentsOf(rules []NewsEventSourceCategoryAuthorityRuleModel) []SourcePolicyCategoryAuthorityDocument {
	out := make([]SourcePolicyCategoryAuthorityDocument, 0, len(rules))
	for _, rule := range rules {
		boosts := make([]SourcePolicyDomainBoostDocument, 0, len(rule.DomainBoosts))
		for _, boost := range rule.DomainBoosts {
			boosts = append(boosts, SourcePolicyDomainBoostDocument{Domain: boost.Domain, Delta: boost.Delta})
		}
		out = append(out, SourcePolicyCategoryAuthorityDocument{
			CategoryPrefix:     rule.CategoryPrefix,
			AuthoritativeBoost: rule.AuthoritativeBoost,
			BlogPenalty:        rule.BlogPenalty,
			UnknownPenalty:     rule.UnknownPenalty,
			MinConfidenceFloor: rule.MinConfidenceFloor,
			MismatchPenalty:    rule.MismatchPenalty,
			DomainBoosts:       boosts,
		})
	}
	return out
}

// sourcePolicyStatePersisted is the persisted version 2 state document.
type sourcePolicyStatePersisted struct {
	Version        int                             `json:"version"`
	ActiveRevision int                             `json:"activeRevision"`
	UpdatedAt      string                          `json:"updatedAt"`
	Delta          SourcePolicyDeltaDocument       `json:"delta"`
	Revisions      []sourcePolicyRevisionPersisted `json:"revisions"`
}

// sourcePolicyRevisionPersisted is one persisted revision. actorId and note are
// written as null when absent, matching the NestJS object literal.
type sourcePolicyRevisionPersisted struct {
	Revision  int                                    `json:"revision"`
	Operation NewsEventSourcePolicyRevisionOperation `json:"operation"`
	ActorID   *string                                `json:"actorId"`
	CreatedAt string                                 `json:"createdAt"`
	Note      *string                                `json:"note"`
	Delta     SourcePolicyDeltaDocument              `json:"delta"`
}

// sourcePolicyPresetCacheDocument is the cached preset document: the persisted
// preset plus the database timestamp and an empty syncWarnings list, which is
// the shape the NestJS cache holds.
type sourcePolicyPresetCacheDocument struct {
	AuthoritativeDomains []string                                `json:"authoritativeDomains"`
	AuthoritativeLabels  []string                                `json:"authoritativeLabels"`
	BlogDomains          []string                                `json:"blogDomains"`
	BlogLabels           []string                                `json:"blogLabels"`
	CategoryAuthority    []SourcePolicyCategoryAuthorityDocument `json:"categoryAuthority,omitempty"`
	UpdatedAt            string                                  `json:"updatedAt"`
	SyncWarnings         []string                                `json:"syncWarnings"`
}

// MarshalSourcePolicyState serializes the full version 2 document. The write
// path persists these exact bytes and caches the same bytes, so a Go or NestJS
// reader parses one document instead of two shapes.
func MarshalSourcePolicyState(state SourcePolicyState) ([]byte, error) {
	revisions := make([]sourcePolicyRevisionPersisted, 0, len(state.Revisions))
	for _, revision := range state.Revisions {
		createdAt := revision.CreatedAtRaw
		if createdAt == "" {
			createdAt = contract.FormatDateTime(revision.CreatedAt)
		}
		revisions = append(revisions, sourcePolicyRevisionPersisted{
			Revision:  revision.Revision,
			Operation: revision.Operation,
			ActorID:   revision.ActorID,
			CreatedAt: createdAt,
			Note:      revision.Note,
			Delta:     NewSourcePolicyDeltaDocument(revision.Delta),
		})
	}
	return json.Marshal(sourcePolicyStatePersisted{
		Version:        2,
		ActiveRevision: state.ActiveRevision,
		UpdatedAt:      state.UpdatedAt,
		Delta:          NewSourcePolicyDeltaDocument(state.Delta),
		Revisions:      revisions,
	})
}

// MarshalSourcePolicyPresetDocument serializes the preset document. The rules
// are written only when the caller supplied a non-empty list, because the
// separately keyed preset category-authority document owns the applied rules.
func MarshalSourcePolicyPresetDocument(lists SourcePolicyLists, rules []NewsEventSourceCategoryAuthorityRuleModel) ([]byte, error) {
	return json.Marshal(NewSourcePolicyPresetDocument(lists, rules))
}

// MarshalSourcePolicyPresetCache serializes the cached preset: the persisted
// document plus the database updatedAt and an empty syncWarnings list. The
// database timestamp is the comparison value a later preset update reads back,
// so it must be the value the row actually holds.
func MarshalSourcePolicyPresetCache(lists SourcePolicyLists, rules []NewsEventSourceCategoryAuthorityRuleModel, updatedAt string) ([]byte, error) {
	document := sourcePolicyPresetCacheDocument{
		AuthoritativeDomains: nonNilStrings(lists.AuthoritativeDomains),
		AuthoritativeLabels:  nonNilStrings(lists.AuthoritativeLabels),
		BlogDomains:          nonNilStrings(lists.BlogDomains),
		BlogLabels:           nonNilStrings(lists.BlogLabels),
		UpdatedAt:            updatedAt,
		SyncWarnings:         []string{},
	}
	if len(rules) > 0 {
		document.CategoryAuthority = categoryAuthorityDocumentsOf(rules)
	}
	return json.Marshal(document)
}

// MarshalSourceCategoryAuthorityDocument serializes the rules array that both
// the active and the preset category-authority keys store.
func MarshalSourceCategoryAuthorityDocument(rules []NewsEventSourceCategoryAuthorityRuleModel) ([]byte, error) {
	return json.Marshal(categoryAuthorityDocumentsOf(rules))
}

// BuildSourcePolicySettingsModel projects one policy state plus the current
// category authority and this write's cache warnings into the GraphQL model.
// The history is the newest 20 revisions (the Query roots keep 30), and every
// non-null list is emitted as [] rather than null.
func BuildSourcePolicySettingsModel(
	state SourcePolicyState,
	categoryAuthority []NewsEventSourceCategoryAuthorityRuleModel,
	syncWarnings []string,
) NewsEventSourcePolicySettingsModel {
	effective := effectiveFromDelta(state.Delta)
	revisions := make([]NewsEventSourcePolicyRevisionModel, 0, len(state.Revisions))
	for _, revision := range state.Revisions {
		revisions = append(revisions, sourcePolicyRevisionModel(revision))
	}
	sort.SliceStable(revisions, func(i, j int) bool { return revisions[i].Revision > revisions[j].Revision })
	if len(revisions) > sourcePolicyMutationHistoryLimit {
		revisions = revisions[:sourcePolicyMutationHistoryLimit]
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
		SyncWarnings:         nonNilStrings(syncWarnings),
		UpdatedAt:            policyUpdatedAt(state.UpdatedAt),
		Warnings:             buildConflictWarnings(effective),
	}
}

// BuildSourcePolicyPresetSettingsModel projects the saved preset. updatedAt is
// the database timestamp of the save; an empty or unparsable value becomes
// GraphQL null.
func BuildSourcePolicyPresetSettingsModel(
	lists SourcePolicyLists,
	categoryAuthority []NewsEventSourceCategoryAuthorityRuleModel,
	updatedAt string,
	syncWarnings []string,
) NewsEventSourcePolicyPresetSettingsModel {
	return NewsEventSourcePolicyPresetSettingsModel{
		AuthoritativeDomains: nonNilStrings(lists.AuthoritativeDomains),
		AuthoritativeLabels:  nonNilStrings(lists.AuthoritativeLabels),
		BlogDomains:          nonNilStrings(lists.BlogDomains),
		BlogLabels:           nonNilStrings(lists.BlogLabels),
		CategoryAuthority:    nonNilRules(categoryAuthority),
		SyncWarnings:         nonNilStrings(syncWarnings),
		UpdatedAt:            policyUpdatedAt(updatedAt),
	}
}

// sourcePolicyRevisionModel maps a write-side revision to the GraphQL model.
func sourcePolicyRevisionModel(revision SourcePolicyRevision) NewsEventSourcePolicyRevisionModel {
	return NewsEventSourcePolicyRevisionModel{
		ActorID:   revision.ActorID,
		CreatedAt: revision.CreatedAt,
		Delta:     cloneDelta(revision.Delta),
		Note:      revision.Note,
		Operation: revision.Operation,
		Revision:  revision.Revision,
	}
}

// ---- reads the write path needs before it appends ----

// LoadSourcePolicyState reads and normalizes the persisted state. Unlike the
// Query root, which falls back to the empty state when the row cannot be read,
// the write path receives the error: appending a revision to a fabricated empty
// state would drop the retained history.
func LoadSourcePolicyState(ctx context.Context, db *sql.DB, orgID string) (SourcePolicyState, error) {
	reader := &policyReader{s: &store{db: db}}
	state, err := reader.loadSourcePolicyState(ctx, orgID)
	if err != nil {
		return SourcePolicyState{}, err
	}
	return sourcePolicyStateFromPrivate(state), nil
}

// LoadSourceCategoryAuthority reads the stored rules of the active policy or
// the preset document. A missing row is an empty list; a failed read is an
// error so the response never reports rules it did not read.
func LoadSourceCategoryAuthority(ctx context.Context, db *sql.DB, orgID string, preset bool) ([]NewsEventSourceCategoryAuthorityRuleModel, error) {
	key := sourcePolicyCategoryAuthorityPrefix + orgID
	if preset {
		key = sourcePolicyPresetCategoryAuthorityPref + orgID
	}
	reader := &policyReader{s: &store{db: db}}
	raw, found, err := reader.s.selectSetting(ctx, key)
	if err != nil {
		return nil, err
	}
	if !found {
		return []NewsEventSourceCategoryAuthorityRuleModel{}, nil
	}
	return normalizeSourceCategoryAuthority(raw, nil), nil
}

// LoadSourcePolicyPresetUpdatedAt reports the stored preset timestamp as the
// canonical UTC millisecond ISO string, or nil when the row carries no preset
// document. The preset mutation compares its expectedUpdatedAt against exactly
// this value, so an absent document compares unequal to any non-null
// expectation.
func LoadSourcePolicyPresetUpdatedAt(ctx context.Context, db *sql.DB, orgID string) (*string, error) {
	reader := &policyReader{s: &store{db: db}}
	_, updatedAt, err := reader.loadPreset(ctx, orgID)
	if err != nil {
		return nil, err
	}
	if updatedAt == nil {
		return nil, nil
	}
	formatted := contract.FormatDateTime(*updatedAt)
	return &formatted, nil
}

// ---- private conversion helpers ----

func sourcePolicyStateFromPrivate(state sourcePolicyState) SourcePolicyState {
	revisions := make([]SourcePolicyRevision, 0, len(state.Revisions))
	for _, revision := range state.Revisions {
		revisions = append(revisions, sourcePolicyRevisionFromPrivate(revision))
	}
	return SourcePolicyState{
		ActiveRevision: state.ActiveRevision,
		UpdatedAt:      state.UpdatedAt,
		Delta:          cloneDelta(state.Delta),
		Revisions:      revisions,
	}
}

func sourcePolicyStateToPrivate(state SourcePolicyState) sourcePolicyState {
	revisions := make([]sourcePolicyRevision, 0, len(state.Revisions))
	for _, revision := range state.Revisions {
		revisions = append(revisions, sourcePolicyRevisionToPrivate(revision))
	}
	return sourcePolicyState{
		ActiveRevision: state.ActiveRevision,
		UpdatedAt:      state.UpdatedAt,
		Delta:          cloneDelta(state.Delta),
		Revisions:      revisions,
	}
}

func sourcePolicyRevisionFromPrivate(revision sourcePolicyRevision) SourcePolicyRevision {
	return SourcePolicyRevision{
		Revision:     revision.Revision,
		Operation:    revision.Operation,
		ActorID:      revision.ActorID,
		CreatedAt:    revision.CreatedAt,
		CreatedAtRaw: revision.CreatedRaw,
		Note:         revision.Note,
		Delta:        cloneDelta(revision.Delta),
	}
}

func sourcePolicyRevisionToPrivate(revision SourcePolicyRevision) sourcePolicyRevision {
	return sourcePolicyRevision{
		Revision:   revision.Revision,
		Operation:  revision.Operation,
		ActorID:    revision.ActorID,
		CreatedAt:  revision.CreatedAt,
		CreatedRaw: revision.CreatedAtRaw,
		Note:       revision.Note,
		Delta:      cloneDelta(revision.Delta),
	}
}
