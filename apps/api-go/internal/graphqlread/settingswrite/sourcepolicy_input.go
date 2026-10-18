package settingswrite

import (
	"strconv"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
)

// This file converts the executor's coerced argument map into the named source
// policy inputs. GraphQL already guarantees the scalar and list shapes of a
// non-null list of strings, so the checks below are the constraints the SDL
// cannot express: @ArrayMaxSize, @MaxLength({each}) and the numeric bounds of
// the nested category authority DTOs. Messages use the class-validator default
// wording and the same reverse-decorator order as validate.go.
//
// Presence is preserved: an omitted categoryAuthority keeps the stored rules, an
// explicit null or [] clears them, an omitted expectedRevision skips the version
// check while 0 is a real expectation, and an omitted expectedUpdatedAt skips
// the timestamp comparison while null still compares against "no timestamp".

// sourcePolicyListLimits are the four DTO list bounds.
const (
	sourcePolicyListMaxItems     = 1000
	sourcePolicyListMaxItemRunes = 180
)

// updateNewsEventSourcePolicyInput is a validated UpdateNewsEventSourcePolicyInput.
type updateNewsEventSourcePolicyInput struct {
	Lists                    settingscrawl.SourcePolicyLists
	CategoryAuthorityPresent bool
	CategoryAuthority        []settingscrawl.SourceCategoryAuthorityRule
	Note                     *string
	ExpectedRevisionPresent  bool
	ExpectedRevision         *int
}

// updateNewsEventSourcePolicyPresetInput is a validated
// UpdateNewsEventSourcePolicyPresetInput.
type updateNewsEventSourcePolicyPresetInput struct {
	Lists                    settingscrawl.SourcePolicyLists
	CategoryAuthorityPresent bool
	CategoryAuthority        []settingscrawl.SourceCategoryAuthorityRule
	Note                     *string
	ExpectedUpdatedAtPresent bool
	ExpectedUpdatedAt        *string
}

// rollbackNewsEventSourcePolicyInput is a validated
// RollbackNewsEventSourcePolicyInput.
type rollbackNewsEventSourcePolicyInput struct {
	Revision                int
	ExpectedRevisionPresent bool
	ExpectedRevision        *int
	Note                    *string
}

// resetNewsEventSourcePolicyInput is a validated ResetNewsEventSourcePolicyInput.
type resetNewsEventSourcePolicyInput struct {
	ExpectedRevisionPresent bool
	ExpectedRevision        *int
	Note                    *string
}

// parseUpdateNewsEventSourcePolicyInput validates and normalizes one update
// input. The four lists are normalized with the classifier rules (domain/label
// normalization, empties dropped, first occurrence kept) but are never replaced
// by defaults: an empty array clears the effective list.
func parseUpdateNewsEventSourcePolicyInput(args map[string]any) (updateNewsEventSourcePolicyInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return updateNewsEventSourcePolicyInput{}, err
	}
	messages := []string{}
	out := updateNewsEventSourcePolicyInput{
		Lists:            parseSourcePolicyLists(raw, &messages),
		Note:             optionalNote(raw, &messages),
		ExpectedRevision: optionalExpectedRevision(raw, &messages),
	}
	out.ExpectedRevisionPresent = propertyPresent(raw, "expectedRevision")
	out.CategoryAuthorityPresent = propertyPresent(raw, "categoryAuthority")
	if out.CategoryAuthorityPresent {
		out.CategoryAuthority = parseSourceCategoryAuthority(raw, &messages)
	}
	if len(messages) > 0 {
		return updateNewsEventSourcePolicyInput{}, newInputFailure(messages)
	}
	return out, nil
}

// parseUpdateNewsEventSourcePolicyPresetInput validates the preset input. The
// timestamp stays a string here: the service compares its normalized UTC
// millisecond form with the stored one.
func parseUpdateNewsEventSourcePolicyPresetInput(args map[string]any) (updateNewsEventSourcePolicyPresetInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return updateNewsEventSourcePolicyPresetInput{}, err
	}
	messages := []string{}
	expectedUpdatedAt, expectedUpdatedAtPresent := optionalStringMax(raw, "expectedUpdatedAt", 120, &messages)
	out := updateNewsEventSourcePolicyPresetInput{
		Lists:                    parseSourcePolicyLists(raw, &messages),
		Note:                     optionalNote(raw, &messages),
		ExpectedUpdatedAt:        expectedUpdatedAt,
		ExpectedUpdatedAtPresent: expectedUpdatedAtPresent,
	}
	out.CategoryAuthorityPresent = propertyPresent(raw, "categoryAuthority")
	if out.CategoryAuthorityPresent {
		out.CategoryAuthority = parseSourceCategoryAuthority(raw, &messages)
	}
	if len(messages) > 0 {
		return updateNewsEventSourcePolicyPresetInput{}, newInputFailure(messages)
	}
	return out, nil
}

// parseRollbackNewsEventSourcePolicyInput validates the rollback input. revision
// has a lower bound only, so no upper bound is invented here.
func parseRollbackNewsEventSourcePolicyInput(args map[string]any) (rollbackNewsEventSourcePolicyInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return rollbackNewsEventSourcePolicyInput{}, err
	}
	messages := []string{}
	out := rollbackNewsEventSourcePolicyInput{
		Revision:         requiredIntAtLeast(raw, "revision", 1, &messages),
		ExpectedRevision: optionalExpectedRevision(raw, &messages),
		Note:             optionalNote(raw, &messages),
	}
	out.ExpectedRevisionPresent = propertyPresent(raw, "expectedRevision")
	if len(messages) > 0 {
		return rollbackNewsEventSourcePolicyInput{}, newInputFailure(messages)
	}
	return out, nil
}

// parseResetNewsEventSourcePolicyInput validates the reset input.
func parseResetNewsEventSourcePolicyInput(args map[string]any) (resetNewsEventSourcePolicyInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return resetNewsEventSourcePolicyInput{}, err
	}
	messages := []string{}
	out := resetNewsEventSourcePolicyInput{
		ExpectedRevision: optionalExpectedRevision(raw, &messages),
		Note:             optionalNote(raw, &messages),
	}
	out.ExpectedRevisionPresent = propertyPresent(raw, "expectedRevision")
	if len(messages) > 0 {
		return resetNewsEventSourcePolicyInput{}, newInputFailure(messages)
	}
	return out, nil
}

// parseSourcePolicyLists reads and normalizes the four non-null lists.
func parseSourcePolicyLists(raw map[string]any, messages *[]string) settingscrawl.SourcePolicyLists {
	return settingscrawl.SourcePolicyLists{
		AuthoritativeDomains: settingscrawl.NormalizeSourcePolicyDomainList(
			requiredPolicyList(raw, "authoritativeDomains", messages)),
		AuthoritativeLabels: settingscrawl.NormalizeSourcePolicyLabelList(
			requiredPolicyList(raw, "authoritativeLabels", messages)),
		BlogDomains: settingscrawl.NormalizeSourcePolicyDomainList(
			requiredPolicyList(raw, "blogDomains", messages)),
		BlogLabels: settingscrawl.NormalizeSourcePolicyLabelList(
			requiredPolicyList(raw, "blogLabels", messages)),
	}
}

// requiredPolicyList reads one [String!]! property with @ArrayMaxSize(1000) and
// @MaxLength({each}, 180). The messages are emitted in the reverse decorator
// order used across this package: the per-element length, the element type and
// finally the array size.
func requiredPolicyList(input map[string]any, name string, messages *[]string) []string {
	value, state := contract.Lookup(input, name)
	if state != contract.ArgValue {
		// The GraphQL type is non-null, so this is unreachable through the
		// executor; the messages mirror the DTO failing validation.
		*messages = append(*messages, eachMaxLengthMessage(name, sourcePolicyListMaxItemRunes))
		*messages = append(*messages, "each value in "+name+" must be a string")
		return []string{}
	}
	items, ok := value.([]any)
	if !ok {
		*messages = append(*messages, eachMaxLengthMessage(name, sourcePolicyListMaxItemRunes))
		*messages = append(*messages, "each value in "+name+" must be a string")
		return []string{}
	}
	out := make([]string, 0, len(items))
	tooLong := false
	invalid := false
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			invalid = true
			continue
		}
		if jsMaxLengthLen(text) > sourcePolicyListMaxItemRunes {
			tooLong = true
			continue
		}
		out = append(out, text)
	}
	if tooLong {
		*messages = append(*messages, eachMaxLengthMessage(name, sourcePolicyListMaxItemRunes))
	}
	if invalid {
		*messages = append(*messages, "each value in "+name+" must be a string")
	}
	if len(items) > sourcePolicyListMaxItems {
		*messages = append(*messages, arrayMaxSizeMessage(name, sourcePolicyListMaxItems))
	}
	return out
}

// parseSourceCategoryAuthority reads the nested rules. An explicit null and an
// empty array both yield an empty list: the caller decides from the presence
// flag whether the stored rules must be cleared.
func parseSourceCategoryAuthority(input map[string]any, messages *[]string) []settingscrawl.SourceCategoryAuthorityRule {
	value, state := contract.Lookup(input, "categoryAuthority")
	if state != contract.ArgValue {
		return []settingscrawl.SourceCategoryAuthorityRule{}
	}
	items, ok := value.([]any)
	if !ok {
		*messages = append(*messages, arrayMaxSizeMessage("categoryAuthority", 200))
		return []settingscrawl.SourceCategoryAuthorityRule{}
	}
	out := make([]settingscrawl.SourceCategoryAuthorityRule, 0, len(items))
	for index := range items {
		entry, ok := listAt(items, index)
		if !ok {
			*messages = append(*messages, "each value in categoryAuthority must be an object")
			continue
		}
		out = append(out, parseSourceCategoryAuthorityRule(entry, messages))
	}
	if len(items) > 200 {
		*messages = append(*messages, arrayMaxSizeMessage("categoryAuthority", 200))
	}
	return out
}

// parseSourceCategoryAuthorityRule reads one NewsEventSourceCategoryAuthorityRuleInput.
// minConfidenceFloor and mismatchPenalty are nullable and default to 0, exactly
// like the resolver's `?? 0`.
func parseSourceCategoryAuthorityRule(entry map[string]any, messages *[]string) settingscrawl.SourceCategoryAuthorityRule {
	rule := settingscrawl.SourceCategoryAuthorityRule{
		CategoryPrefix:     requiredStringMax(entry, "categoryPrefix", 160, messages),
		AuthoritativeBoost: requiredFloat(entry, "authoritativeBoost", -1, 1, messages),
		BlogPenalty:        requiredFloat(entry, "blogPenalty", -1, 1, messages),
		UnknownPenalty:     requiredFloat(entry, "unknownPenalty", -1, 1, messages),
		DomainBoosts:       parseSourceDomainBoosts(entry, messages),
	}
	if floor := optionalFloat(entry, "minConfidenceFloor", 0, 1, messages); floor != nil {
		rule.MinConfidenceFloor = *floor
	}
	if penalty := optionalFloat(entry, "mismatchPenalty", 0, 1, messages); penalty != nil {
		rule.MismatchPenalty = *penalty
	}
	return rule
}

// parseSourceDomainBoosts reads the optional domain boost list: at most 100
// entries, each with a domain of at most 180 characters and a delta in [-1, 1].
func parseSourceDomainBoosts(entry map[string]any, messages *[]string) []settingscrawl.SourceCategoryAuthorityDomainBoost {
	value, state := contract.Lookup(entry, "domainBoosts")
	if state != contract.ArgValue {
		return []settingscrawl.SourceCategoryAuthorityDomainBoost{}
	}
	items, ok := value.([]any)
	if !ok {
		*messages = append(*messages, arrayMaxSizeMessage("domainBoosts", 100))
		return []settingscrawl.SourceCategoryAuthorityDomainBoost{}
	}
	out := make([]settingscrawl.SourceCategoryAuthorityDomainBoost, 0, len(items))
	for index := range items {
		boost, ok := listAt(items, index)
		if !ok {
			*messages = append(*messages, "each value in domainBoosts must be an object")
			continue
		}
		out = append(out, settingscrawl.SourceCategoryAuthorityDomainBoost{
			Domain: requiredStringMax(boost, "domain", 180, messages),
			Delta:  requiredFloat(boost, "delta", -1, 1, messages),
		})
	}
	if len(items) > 100 {
		*messages = append(*messages, arrayMaxSizeMessage("domainBoosts", 100))
	}
	return out
}

// optionalNote reads the nullable note. The service trims it and maps an empty
// value to null.
func optionalNote(input map[string]any, messages *[]string) *string {
	note, _ := optionalStringMax(input, "note", sourcePolicyNoteMaxLength, messages)
	return note
}

// optionalExpectedRevision reads the nullable expectedRevision, which accepts 0
// as a real expectation. Absence and explicit null are both reported as a nil
// pointer; the presence flag is read separately because 0 must not be treated
// as missing.
func optionalExpectedRevision(input map[string]any, messages *[]string) *int {
	return optionalInt(input, "expectedRevision", 0, 1_000_000, messages)
}

// propertyPresent reports whether the argument map carries the property at all,
// regardless of an explicit null.
func propertyPresent(input map[string]any, name string) bool {
	_, state := contract.Lookup(input, name)
	return state != contract.ArgMissing
}

// requiredIntAtLeast reads an Int! property constrained by @Min only.
func requiredIntAtLeast(input map[string]any, name string, min int, messages *[]string) int {
	value, state := contract.Lookup(input, name)
	if state != contract.ArgValue {
		*messages = append(*messages, fmtRangeMin(name, min))
		return 0
	}
	number, ok := contract.AsInt(value)
	if !ok {
		*messages = append(*messages, fmtRangeMin(name, min))
		return 0
	}
	if number < min {
		*messages = append(*messages, fmtRangeMin(name, min))
	}
	return number
}

// normalizeSourcePolicyNote reproduces normalizeNote: trim, map empty to null and
// cap at 500 characters.
func normalizeSourcePolicyNote(note *string) *string {
	if note == nil {
		return nil
	}
	trimmed := jsTrim(*note)
	if trimmed == "" {
		return nil
	}
	if len([]rune(trimmed)) > sourcePolicyNoteMaxLength {
		trimmed = string([]rune(trimmed)[:sourcePolicyNoteMaxLength])
	}
	return &trimmed
}

// sourcePolicyTimestampLayouts are the date forms normalizeExpectedUpdatedAt
// accepts. A value without a zone is local time, which is what
// `new Date("2026-10-18T12:00:00")` does in the NestJS service.
var sourcePolicyTimestampLayouts = []string{
	time.RFC3339Nano,
	"2006-01-02T15:04:05.999999999",
	"2006-01-02 15:04:05.999999999",
}

// normalizeSourcePolicyExpectedUpdatedAt reproduces normalizeExpectedUpdatedAt:
// null, an empty string and an unparsable value become null; anything else
// becomes the UTC millisecond ISO string the stored timestamp uses. A plain
// date is UTC midnight in JavaScript, while a datetime without an offset is
// local time; both forms are handled explicitly.
func normalizeSourcePolicyExpectedUpdatedAt(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := jsTrim(*value)
	if trimmed == "" {
		return nil
	}
	if len(trimmed) == len("2006-01-02") {
		if parsed, err := time.ParseInLocation("2006-01-02", trimmed, time.UTC); err == nil {
			normalized := parsed.UTC().Format("2006-01-02T15:04:05.000Z")
			return &normalized
		}
	}
	for _, layout := range sourcePolicyTimestampLayouts {
		parsed, err := time.ParseInLocation(layout, trimmed, time.Local)
		if err != nil {
			continue
		}
		normalized := parsed.UTC().Format("2006-01-02T15:04:05.000Z")
		return &normalized
	}
	return nil
}

// sourcePolicyTimestampsEqual compares the two nullable canonical timestamps.
// Two nulls are equal, so an explicit null expectation matches a preset that has
// no stored document.
func sourcePolicyTimestampsEqual(expected, current *string) bool {
	if expected == nil || current == nil {
		return expected == nil && current == nil
	}
	return *expected == *current
}

// describeSourcePolicyTimestamp renders a nullable timestamp for the stale
// comparison messages: the quoted value or the literal null.
func describeSourcePolicyTimestamp(value *string) string {
	if value == nil {
		return "null"
	}
	return *value
}

// sourcePolicyStaleRevisionMessage is the NestJS BadRequestException text.
func sourcePolicyStaleRevisionMessage(expected, current int) string {
	return "Stale source policy revision: expected " + strconv.Itoa(expected) + ", current " + strconv.Itoa(current)
}

// sourcePolicyRevisionNotFoundMessage is the NestJS BadRequestException text.
func sourcePolicyRevisionNotFoundMessage(revision int) string {
	return "Revision " + strconv.Itoa(revision) + " not found"
}

// sourcePolicyStalePresetMessage is the NestJS BadRequestException text.
func sourcePolicyStalePresetMessage(expected, current *string) string {
	return "Stale source policy preset timestamp: expected " + describeSourcePolicyTimestamp(expected) +
		", current " + describeSourcePolicyTimestamp(current)
}

// sourcePolicyDefaultRollbackNote is the note a rollback without one records.
func sourcePolicyDefaultRollbackNote(targetRevision int) string {
	return "rollback->" + strconv.Itoa(targetRevision)
}

// dedupeSourcePolicyWarnings keeps the first occurrence of every warning code so
// the policy and category cache failures are reported once each.
func dedupeSourcePolicyWarnings(warnings []string) []string {
	seen := make(map[string]struct{}, len(warnings))
	out := make([]string, 0, len(warnings))
	for _, warning := range warnings {
		if _, exists := seen[warning]; exists {
			continue
		}
		seen[warning] = struct{}{}
		out = append(out, warning)
	}
	return out
}
