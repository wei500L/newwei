package settingswrite

import (
	"context"
	"database/sql"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
)

// RegisterSourcePolicy adds the four source-policy version mutations and their
// root permission. It is a separate entry point from Register so the legacy
// thirteen settings mutations keep their own switch and are never widened by
// this batch.
//
// The caller must register the source-policy object types through
// settingscrawl.RegisterSourcePolicyModelTypes unless the settings/crawl read
// registration already did it. RegisterSourcePolicy never registers a type on
// its own, because a duplicate registration must not hide a missing model.
func RegisterSourcePolicy(reg *contract.Registry, db *sql.DB, redisClient *redis.Client) {
	if reg == nil {
		panic("graphqlread: settingswrite.RegisterSourcePolicy requires a registry")
	}
	svc := &service{db: db, redis: redisClient}
	reg.RegisterMutation(contract.Root{
		Name:       "updateNewsEventSourcePolicy",
		Permission: permissionSettingsManage,
		Resolve:    contract.Bind(svc.updateNewsEventSourcePolicyResolver),
	})
	reg.RegisterMutation(contract.Root{
		Name:       "updateNewsEventSourcePolicyPresets",
		Permission: permissionSettingsManage,
		Resolve:    contract.Bind(svc.updateNewsEventSourcePolicyPresetResolver),
	})
	reg.RegisterMutation(contract.Root{
		Name:       "rollbackNewsEventSourcePolicy",
		Permission: permissionSettingsManage,
		Resolve:    contract.Bind(svc.rollbackNewsEventSourcePolicyResolver),
	})
	reg.RegisterMutation(contract.Root{
		Name:       "resetNewsEventSourcePolicy",
		Permission: permissionSettingsManage,
		Resolve:    contract.Bind(svc.resetNewsEventSourcePolicyResolver),
	})
}

// SourcePolicyRegisteredMutations lists the mutation names RegisterSourcePolicy
// adds. The startup log uses it.
var SourcePolicyRegisteredMutations = []string{
	"updateNewsEventSourcePolicy",
	"updateNewsEventSourcePolicyPresets",
	"rollbackNewsEventSourcePolicy",
	"resetNewsEventSourcePolicy",
}

// ---- resolver adapters ----

func (s *service) updateNewsEventSourcePolicyResolver(ctx contract.Context) (settingscrawl.NewsEventSourcePolicySettingsModel, error) {
	input, err := parseUpdateNewsEventSourcePolicyInput(ctx.Args)
	if err == nil {
		var model settingscrawl.NewsEventSourcePolicySettingsModel
		if model, err = s.updateNewsEventSourcePolicy(callContext(ctx), ctx.Identity, input); err == nil {
			return model, nil
		}
	}
	return settingscrawl.NewsEventSourcePolicySettingsModel{}, graphqlFailure(err)
}

func (s *service) updateNewsEventSourcePolicyPresetResolver(ctx contract.Context) (settingscrawl.NewsEventSourcePolicyPresetSettingsModel, error) {
	input, err := parseUpdateNewsEventSourcePolicyPresetInput(ctx.Args)
	if err == nil {
		var model settingscrawl.NewsEventSourcePolicyPresetSettingsModel
		if model, err = s.updateNewsEventSourcePolicyPreset(callContext(ctx), ctx.Identity, input); err == nil {
			return model, nil
		}
	}
	return settingscrawl.NewsEventSourcePolicyPresetSettingsModel{}, graphqlFailure(err)
}

func (s *service) rollbackNewsEventSourcePolicyResolver(ctx contract.Context) (settingscrawl.NewsEventSourcePolicySettingsModel, error) {
	input, err := parseRollbackNewsEventSourcePolicyInput(ctx.Args)
	if err == nil {
		var model settingscrawl.NewsEventSourcePolicySettingsModel
		if model, err = s.rollbackNewsEventSourcePolicy(callContext(ctx), ctx.Identity, input); err == nil {
			return model, nil
		}
	}
	return settingscrawl.NewsEventSourcePolicySettingsModel{}, graphqlFailure(err)
}

func (s *service) resetNewsEventSourcePolicyResolver(ctx contract.Context) (settingscrawl.NewsEventSourcePolicySettingsModel, error) {
	input, err := parseResetNewsEventSourcePolicyInput(ctx.Args)
	if err == nil {
		var model settingscrawl.NewsEventSourcePolicySettingsModel
		if model, err = s.resetNewsEventSourcePolicy(callContext(ctx), ctx.Identity, input); err == nil {
			return model, nil
		}
	}
	return settingscrawl.NewsEventSourcePolicySettingsModel{}, graphqlFailure(err)
}

// ---- business flows ----

// updateNewsEventSourcePolicy mirrors NewsEventSourcePolicyService.updatePolicy:
// normalize the effective lists, derive the delta against the classifier
// defaults, load the full previous state, check the optional revision, append a
// new update revision, persist the state, and only then persist category rules
// when the caller explicitly supplied categoryAuthority.
func (s *service) updateNewsEventSourcePolicy(
	ctx context.Context,
	identity contract.Identity,
	input updateNewsEventSourcePolicyInput,
) (settingscrawl.NewsEventSourcePolicySettingsModel, error) {
	if err := s.assertAdmin(ctx, identity); err != nil {
		return settingscrawl.NewsEventSourcePolicySettingsModel{}, err
	}
	if s.db == nil {
		return settingscrawl.NewsEventSourcePolicySettingsModel{}, errDatabaseUnavailable
	}
	previous, err := settingscrawl.LoadSourcePolicyState(ctx, s.db, identity.OrgID)
	if err != nil {
		return settingscrawl.NewsEventSourcePolicySettingsModel{}, err
	}
	if err := checkSourcePolicyExpectedRevision(input.ExpectedRevisionPresent, input.ExpectedRevision, previous.ActiveRevision); err != nil {
		return settingscrawl.NewsEventSourcePolicySettingsModel{}, err
	}
	next := nextSourcePolicyUpdate(previous, input.Lists, identity.UserID, input.Note, nowMillis())
	warnings, err := s.persistSourcePolicyState(ctx, identity, next, sourcePolicyActionUpdate)
	if err != nil {
		return settingscrawl.NewsEventSourcePolicySettingsModel{}, err
	}

	rules := settingscrawl.NormalizeSourceCategoryAuthorityRules(input.CategoryAuthority)
	if input.CategoryAuthorityPresent {
		categoryWarnings, err := s.persistSourcePolicyCategoryAuthority(ctx, identity, rules, false)
		if err != nil {
			return settingscrawl.NewsEventSourcePolicySettingsModel{}, err
		}
		warnings = append(warnings, categoryWarnings...)
	} else {
		rules, err = settingscrawl.LoadSourceCategoryAuthority(ctx, s.db, identity.OrgID, false)
		if err != nil {
			return settingscrawl.NewsEventSourcePolicySettingsModel{}, err
		}
		s.warmSourcePolicyCategoryAuthorityCache(ctx, identity, rules, false)
	}
	return settingscrawl.BuildSourcePolicySettingsModel(next, rules, warnings), nil
}

// rollbackNewsEventSourcePolicy restores one retained revision's delta as a new
// rollback revision. The active revision advances; it never moves backwards.
// Category rules are stored separately and remain untouched by a policy
// rollback.
func (s *service) rollbackNewsEventSourcePolicy(
	ctx context.Context,
	identity contract.Identity,
	input rollbackNewsEventSourcePolicyInput,
) (settingscrawl.NewsEventSourcePolicySettingsModel, error) {
	if err := s.assertAdmin(ctx, identity); err != nil {
		return settingscrawl.NewsEventSourcePolicySettingsModel{}, err
	}
	if s.db == nil {
		return settingscrawl.NewsEventSourcePolicySettingsModel{}, errDatabaseUnavailable
	}
	previous, err := settingscrawl.LoadSourcePolicyState(ctx, s.db, identity.OrgID)
	if err != nil {
		return settingscrawl.NewsEventSourcePolicySettingsModel{}, err
	}
	if err := checkSourcePolicyExpectedRevision(input.ExpectedRevisionPresent, input.ExpectedRevision, previous.ActiveRevision); err != nil {
		return settingscrawl.NewsEventSourcePolicySettingsModel{}, err
	}
	target, found := findSourcePolicyRevision(previous.Revisions, input.Revision)
	if !found {
		return settingscrawl.NewsEventSourcePolicySettingsModel{}, badRequest(sourcePolicyRevisionNotFoundMessage(input.Revision))
	}
	next := nextSourcePolicyRollback(previous, target, identity.UserID, input.Note, nowMillis())
	warnings, err := s.persistSourcePolicyState(ctx, identity, next, sourcePolicyActionRollback)
	if err != nil {
		return settingscrawl.NewsEventSourcePolicySettingsModel{}, err
	}
	rules, err := settingscrawl.LoadSourceCategoryAuthority(ctx, s.db, identity.OrgID, false)
	if err != nil {
		return settingscrawl.NewsEventSourcePolicySettingsModel{}, err
	}
	s.warmSourcePolicyCategoryAuthorityCache(ctx, identity, rules, false)
	return settingscrawl.BuildSourcePolicySettingsModel(next, rules, warnings), nil
}

// resetNewsEventSourcePolicy appends a new revision whose delta is empty, which
// restores the built-in default lists while retaining the encoded history,
// category rules and the preset document.
func (s *service) resetNewsEventSourcePolicy(
	ctx context.Context,
	identity contract.Identity,
	input resetNewsEventSourcePolicyInput,
) (settingscrawl.NewsEventSourcePolicySettingsModel, error) {
	if err := s.assertAdmin(ctx, identity); err != nil {
		return settingscrawl.NewsEventSourcePolicySettingsModel{}, err
	}
	if s.db == nil {
		return settingscrawl.NewsEventSourcePolicySettingsModel{}, errDatabaseUnavailable
	}
	previous, err := settingscrawl.LoadSourcePolicyState(ctx, s.db, identity.OrgID)
	if err != nil {
		return settingscrawl.NewsEventSourcePolicySettingsModel{}, err
	}
	if err := checkSourcePolicyExpectedRevision(input.ExpectedRevisionPresent, input.ExpectedRevision, previous.ActiveRevision); err != nil {
		return settingscrawl.NewsEventSourcePolicySettingsModel{}, err
	}
	next := nextSourcePolicyReset(previous, identity.UserID, input.Note, nowMillis())
	warnings, err := s.persistSourcePolicyState(ctx, identity, next, sourcePolicyActionReset)
	if err != nil {
		return settingscrawl.NewsEventSourcePolicySettingsModel{}, err
	}
	rules, err := settingscrawl.LoadSourceCategoryAuthority(ctx, s.db, identity.OrgID, false)
	if err != nil {
		return settingscrawl.NewsEventSourcePolicySettingsModel{}, err
	}
	s.warmSourcePolicyCategoryAuthorityCache(ctx, identity, rules, false)
	return settingscrawl.BuildSourcePolicySettingsModel(next, rules, warnings), nil
}

// updateNewsEventSourcePolicyPreset mirrors updatePolicyPreset. The preset is a
// separate document: saving it never appends a policy revision and never
// applies it to the active policy. Its updatedAt comes from the row the upsert
// actually wrote, because the next expectedUpdatedAt comparison reads that row.
func (s *service) updateNewsEventSourcePolicyPreset(
	ctx context.Context,
	identity contract.Identity,
	input updateNewsEventSourcePolicyPresetInput,
) (settingscrawl.NewsEventSourcePolicyPresetSettingsModel, error) {
	if err := s.assertAdmin(ctx, identity); err != nil {
		return settingscrawl.NewsEventSourcePolicyPresetSettingsModel{}, err
	}
	if s.db == nil {
		return settingscrawl.NewsEventSourcePolicyPresetSettingsModel{}, errDatabaseUnavailable
	}
	if input.ExpectedUpdatedAtPresent {
		// NestJS wraps the current-preset read in catch(() => null updatedAt):
		// a failed read therefore compares as "no timestamp" rather than
		// silently skipping the check.
		current, err := settingscrawl.LoadSourcePolicyPresetUpdatedAt(ctx, s.db, identity.OrgID)
		if err != nil {
			current = nil
		}
		expected := normalizeSourcePolicyExpectedUpdatedAt(input.ExpectedUpdatedAt)
		if !sourcePolicyTimestampsEqual(expected, current) {
			return settingscrawl.NewsEventSourcePolicyPresetSettingsModel{}, badRequest(sourcePolicyStalePresetMessage(expected, current))
		}
	}

	rules := settingscrawl.NormalizeSourceCategoryAuthorityRules(input.CategoryAuthority)
	// The main preset document omits categoryAuthority when the caller omitted
	// it; the separately keyed rules document owns the applied preset rules.
	documentRules := []settingscrawl.NewsEventSourceCategoryAuthorityRuleModel{}
	if input.CategoryAuthorityPresent {
		documentRules = rules
	}
	payload, err := settingscrawl.MarshalSourcePolicyPresetDocument(input.Lists, documentRules)
	if err != nil {
		return settingscrawl.NewsEventSourcePolicyPresetSettingsModel{}, err
	}
	updatedAt, err := s.upsertSourcePolicyPreset(
		ctx,
		sourcePolicyPresetKey(identity.OrgID),
		payload,
		sourcePolicyPresetDescription(identity.OrgID),
		nullableActorID(identity.UserID),
	)
	if err != nil {
		return settingscrawl.NewsEventSourcePolicyPresetSettingsModel{}, err
	}
	updatedAtISO := contract.FormatDateTime(updatedAt)
	note := normalizeSourcePolicyNote(input.Note)
	writeSourcePolicyAudit(s.db, ctx, identity, sourcePolicyActionPresetUpdate, sourcePolicyPresetAuditMetadata{
		UpdatedAt: updatedAtISO,
		Note:      note,
		Preset:    settingscrawl.NewSourcePolicyPresetDocument(input.Lists, documentRules),
	})

	warnings := []string{}
	cachePayload, err := settingscrawl.MarshalSourcePolicyPresetCache(input.Lists, documentRules, updatedAtISO)
	if err != nil {
		return settingscrawl.NewsEventSourcePolicyPresetSettingsModel{}, err
	}
	if err := s.setSourcePolicyCache(ctx, sourcePolicyPresetCachePrefix+identity.OrgID, cachePayload, sourcePolicyPresetCacheTTLSeconds); err != nil {
		warnings = append(warnings, sourcePolicyWarningCacheWriteFailed)
	}

	if input.CategoryAuthorityPresent {
		categoryWarnings, err := s.persistSourcePolicyCategoryAuthority(ctx, identity, rules, true)
		if err != nil {
			return settingscrawl.NewsEventSourcePolicyPresetSettingsModel{}, err
		}
		warnings = dedupeSourcePolicyWarnings(append(warnings, categoryWarnings...))
		return settingscrawl.BuildSourcePolicyPresetSettingsModel(input.Lists, rules, updatedAtISO, warnings), nil
	}
	rules, err = settingscrawl.LoadSourceCategoryAuthority(ctx, s.db, identity.OrgID, true)
	if err != nil {
		return settingscrawl.NewsEventSourcePolicyPresetSettingsModel{}, err
	}
	s.warmSourcePolicyCategoryAuthorityCache(ctx, identity, rules, true)
	return settingscrawl.BuildSourcePolicyPresetSettingsModel(input.Lists, rules, updatedAtISO, warnings), nil
}

// ---- state-machine helpers ----

func nextSourcePolicyUpdate(previous settingscrawl.SourcePolicyState, lists settingscrawl.SourcePolicyLists, actorID string, note *string, now time.Time) settingscrawl.SourcePolicyState {
	delta := settingscrawl.SourcePolicyDeltaFromLists(lists)
	revision := settingscrawl.NewSourcePolicyRevision(
		previous.ActiveRevision+1,
		settingscrawl.NewsEventSourcePolicyRevisionOperationUpdate,
		sourcePolicyActorID(actorID),
		now,
		normalizeSourcePolicyNote(note),
		delta,
	)
	return settingscrawl.AppendSourcePolicyState(previous, revision)
}

func nextSourcePolicyRollback(previous settingscrawl.SourcePolicyState, target settingscrawl.SourcePolicyRevision, actorID string, note *string, now time.Time) settingscrawl.SourcePolicyState {
	normalizedNote := normalizeSourcePolicyNote(note)
	if normalizedNote == nil {
		defaultNote := sourcePolicyDefaultRollbackNote(target.Revision)
		normalizedNote = &defaultNote
	}
	revision := settingscrawl.NewSourcePolicyRevision(
		previous.ActiveRevision+1,
		settingscrawl.NewsEventSourcePolicyRevisionOperationRollback,
		sourcePolicyActorID(actorID),
		now,
		normalizedNote,
		settingscrawl.CloneSourcePolicyDelta(target.Delta),
	)
	return settingscrawl.AppendSourcePolicyState(previous, revision)
}

func nextSourcePolicyReset(previous settingscrawl.SourcePolicyState, actorID string, note *string, now time.Time) settingscrawl.SourcePolicyState {
	revision := settingscrawl.NewSourcePolicyRevision(
		previous.ActiveRevision+1,
		settingscrawl.NewsEventSourcePolicyRevisionOperationReset,
		sourcePolicyActorID(actorID),
		now,
		normalizeSourcePolicyNote(note),
		settingscrawl.EmptySourcePolicyDelta(),
	)
	return settingscrawl.AppendSourcePolicyState(previous, revision)
}

func checkSourcePolicyExpectedRevision(present bool, expected *int, current int) error {
	if !present || expected == nil {
		return nil
	}
	if *expected != current {
		return badRequest(sourcePolicyStaleRevisionMessage(*expected, current))
	}
	return nil
}

func findSourcePolicyRevision(revisions []settingscrawl.SourcePolicyRevision, revision int) (settingscrawl.SourcePolicyRevision, bool) {
	for _, entry := range revisions {
		if entry.Revision == revision {
			return entry, true
		}
	}
	return settingscrawl.SourcePolicyRevision{}, false
}

func sourcePolicyActorID(actorID string) *string {
	if actorID == "" {
		return nil
	}
	return &actorID
}

// ---- persistence ----

// persistSourcePolicyState writes the document, then the audit, then the cache.
// A cache failure is a warning, not a rollback: the database write is already
// visible to NestJS and to the next Go read.
func (s *service) persistSourcePolicyState(
	ctx context.Context,
	identity contract.Identity,
	state settingscrawl.SourcePolicyState,
	action string,
) ([]string, error) {
	payload, err := settingscrawl.MarshalSourcePolicyState(state)
	if err != nil {
		return nil, err
	}
	if err := s.upsertSettingForceDescription(
		ctx,
		sourcePolicyStateKey(identity.OrgID),
		payload,
		sourcePolicyStateDescription(identity.OrgID),
		nullableActorID(identity.UserID),
	); err != nil {
		return nil, err
	}
	writeSourcePolicyAudit(s.db, ctx, identity, action, sourcePolicyStateAuditMetadata{
		ActiveRevision: state.ActiveRevision,
		UpdatedAt:      state.UpdatedAt,
		Delta:          settingscrawl.NewSourcePolicyDeltaDocument(state.Delta),
	})
	if err := s.setSourcePolicyCache(ctx, sourcePolicyCachePrefix+identity.OrgID, payload, sourcePolicyCacheTTLSeconds); err != nil {
		return []string{sourcePolicyWarningCacheWriteFailed}, nil
	}
	return nil, nil
}

// persistSourcePolicyCategoryAuthority writes one of the two independently
// keyed rules documents. It has no audit action of its own, matching the
// NestJS service: the parent update/preset audit already describes the change.
func (s *service) persistSourcePolicyCategoryAuthority(
	ctx context.Context,
	identity contract.Identity,
	rules []settingscrawl.NewsEventSourceCategoryAuthorityRuleModel,
	preset bool,
) ([]string, error) {
	payload, err := settingscrawl.MarshalSourceCategoryAuthorityDocument(rules)
	if err != nil {
		return nil, err
	}
	key := sourcePolicyCategoryAuthorityKey(identity.OrgID)
	cacheKey := sourcePolicyCategoryAuthorityCachePrefix + identity.OrgID
	description := sourcePolicyCategoryAuthorityDescription(identity.OrgID)
	ttl := sourcePolicyCacheTTLSeconds
	if preset {
		key = sourcePolicyPresetCategoryAuthorityKey(identity.OrgID)
		cacheKey = sourcePolicyPresetCategoryAuthorityCachePrefix + identity.OrgID
		description = sourcePolicyPresetCategoryAuthorityDescription(identity.OrgID)
		ttl = sourcePolicyPresetCacheTTLSeconds
	}
	if err := s.upsertSettingForceDescription(ctx, key, payload, description, nullableActorID(identity.UserID)); err != nil {
		return nil, err
	}
	if err := s.setSourcePolicyCache(ctx, cacheKey, payload, ttl); err != nil {
		return []string{sourcePolicyWarningCacheWriteFailed}, nil
	}
	return nil, nil
}

// warmSourcePolicyCategoryAuthorityCache mirrors the best-effort cache fill
// NestJS performs after a category-authority cache miss. The mutation's own
// syncWarnings never include this refresh: only the explicit category write
// path reports its cache failure.
func (s *service) warmSourcePolicyCategoryAuthorityCache(ctx context.Context, identity contract.Identity, rules []settingscrawl.NewsEventSourceCategoryAuthorityRuleModel, preset bool) {
	payload, err := settingscrawl.MarshalSourceCategoryAuthorityDocument(rules)
	if err != nil {
		return
	}
	cacheKey := sourcePolicyCategoryAuthorityCachePrefix + identity.OrgID
	ttl := sourcePolicyCacheTTLSeconds
	if preset {
		cacheKey = sourcePolicyPresetCategoryAuthorityCachePrefix + identity.OrgID
		ttl = sourcePolicyPresetCacheTTLSeconds
	}
	_ = s.setSourcePolicyCache(ctx, cacheKey, payload, ttl)
}
