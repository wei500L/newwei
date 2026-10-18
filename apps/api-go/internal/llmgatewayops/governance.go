package llmgatewayops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"
)

// Audit action literals. They are the exact strings the NestJS service writes,
// so an operator searching the audit trail sees one action per governance verb.
const (
	// auditActionUpdate is written by an enable or a budget/concurrency change.
	auditActionUpdate = "litellm_proxy_governance_update"
	// auditActionDisable is written when governance is turned off.
	auditActionDisable = "litellm_proxy_governance_disable"
	// auditActionReset is written by DELETE /proxy-governance.
	auditActionReset = "litellm_proxy_governance_reset"
	// auditActionRotateKey is written by POST /proxy-governance/rotate-key.
	auditActionRotateKey = "litellm_proxy_governance_rotate_key"
)

// governanceHealthTimeout is the fixed per-endpoint deadline of the preflight
// health probe.
const governanceHealthTimeout = 10 * time.Second

// optionalNumber is one @Type(() => Number) DTO field. Present distinguishes
// "omitted" from "explicit null": the first inherits, the second is Number(null)
// === 0 and is then clamped by the field's own rule.
type optionalNumber struct {
	Present bool
	Null    bool
	Value   float64
}

// budgetValue resolves one budget field against the current value.
func (n optionalNumber) budgetValue(fallback float64) float64 {
	if !n.Present {
		return fallback
	}
	if n.Null {
		return 0
	}
	return clampBudget(n.Value)
}

// parallelValue resolves the concurrency field against the current value.
func (n optionalNumber) parallelValue(fallback int) int {
	if !n.Present {
		return fallback
	}
	if n.Null {
		return minParallelRequests
	}
	return clampParallel(n.Value)
}

// governanceUpdateInput is the PUT body after DTO validation.
type governanceUpdateInput struct {
	TargetProfileIDPresent bool
	TargetProfileID        *string

	EnabledPresent bool
	EnabledNull    bool
	Enabled        bool

	DailyBudgetUSD      optionalNumber
	MonthlyBudgetUSD    optionalNumber
	MaxParallelRequests optionalNumber
}

// governancePreflightInput is the preflight body after DTO validation.
type governancePreflightInput struct {
	TargetProfileIDPresent bool
	TargetProfileID        *string
}

// enabledValue mirrors asBoolean(input.enabled, current.enabled): an explicit
// null inherits instead of turning governance off.
func (i governanceUpdateInput) enabledValue(fallback bool) bool {
	if !i.EnabledPresent || i.EnabledNull {
		return fallback
	}
	return i.Enabled
}

// targetValue mirrors the targetProfileId branch: omitted keeps the current
// selection, an explicit null or a blank string clears it.
func (i governanceUpdateInput) targetValue(current *string) *string {
	if !i.TargetProfileIDPresent {
		return current
	}
	return i.TargetProfileID
}

// clampBudget rounds to four decimals and clamps to [0, 1000000].
func clampBudget(value float64) float64 {
	if value < 0 {
		value = 0
	}
	if value > maxBudgetUSD {
		value = maxBudgetUSD
	}
	return math.Round(value*1e4) / 1e4
}

// clampParallel truncates and clamps to [1, 1024].
func clampParallel(value float64) int {
	truncated := int64(value)
	if value < 0 {
		truncated = 0
	}
	if truncated < minParallelRequests {
		return minParallelRequests
	}
	if truncated > maxParallelRequests {
		return maxParallelRequests
	}
	return int(truncated)
}

// GetSettings serves GET /proxy-governance.
func (s *Service) GetSettings(ctx context.Context) (governanceSettingsPublic, error) {
	resolved, found, err := s.loadResolvedGovernance(ctx)
	if err != nil {
		return governanceSettingsPublic{}, err
	}
	source := governanceSourceDefault
	if found {
		source = governanceSourceDB
	}
	target, err := s.resolveTargetProfile(ctx, resolved.TargetProfileID)
	if err != nil {
		return governanceSettingsPublic{}, err
	}
	return s.toPublicSettings(source, resolved, target), nil
}

// GetPreflight serves POST /proxy-governance/preflight.
//
// The five checks run in the fixed order admin_key, target_profile,
// runtime_traffic, proxy_health, managed_runtime_key. The first four are
// required; an unreadable managed key is only a warning because enabling
// governance will re-create it.
func (s *Service) GetPreflight(ctx context.Context, input governancePreflightInput) (governancePreflightPublic, error) {
	resolved, _, err := s.loadResolvedGovernance(ctx)
	if err != nil {
		return governancePreflightPublic{}, err
	}
	targetID := resolved.TargetProfileID
	if input.TargetProfileIDPresent {
		// The preflight body replaces the stored target even with an explicit
		// null, so an operator can dry-run "no target" before saving it.
		targetID = input.TargetProfileID
	}
	target, err := s.resolveTargetProfile(ctx, targetID)
	if err != nil {
		return governancePreflightPublic{}, err
	}

	bindings, err := s.runtimeBindings(ctx, target)
	if err != nil {
		return governancePreflightPublic{}, err
	}

	var health *governanceHealthResult
	if target != nil {
		checked, checkErr := s.checkTargetProfileHealth(ctx, target)
		if checkErr != nil {
			return governancePreflightPublic{}, checkErr
		}
		health = &checked
	}
	healthOK := health != nil && health.Liveliness.OK && health.Readiness.OK
	hasTraffic := bindings.Completion || bindings.Embedding || bindings.Rerank
	adminKeyConfigured := s.hasAdminKey()

	checks := []governanceCheck{
		{
			Key:      "admin_key",
			OK:       adminKeyConfigured,
			Required: true,
			Message:  boolMessage(adminKeyConfigured, "LiteLLM admin key is configured.", "Configure LITELLM_MASTER_KEY before enabling governance."),
		},
		{
			Key:      "target_profile",
			OK:       target != nil,
			Required: true,
			Message:  targetMessage(target),
		},
		{
			Key:      "runtime_traffic",
			OK:       hasTraffic,
			Required: true,
			Message:  trafficMessage(bindings, hasTraffic),
		},
		{
			Key:      "proxy_health",
			OK:       healthOK,
			Required: true,
			Message:  healthMessage(health, healthOK),
		},
		{
			Key:      "managed_runtime_key",
			OK:       resolved.ManagedRuntimeKeyState != managedKeyUnreadable,
			Required: false,
			Message:  managedKeyMessage(resolved.ManagedRuntimeKeyState),
		},
	}

	blockingIssues := make([]string, 0, len(checks))
	warnings := make([]string, 0, len(checks))
	for _, check := range checks {
		if check.Required && !check.OK {
			blockingIssues = append(blockingIssues, check.Message)
			continue
		}
		if !check.Required && !check.OK {
			warnings = append(warnings, check.Message)
		}
	}

	result := governancePreflightPublic{
		TargetProfileID:        targetID,
		AdminKeyConfigured:     adminKeyConfigured,
		ManagedRuntimeKeyState: resolved.ManagedRuntimeKeyState,
		TrafficBindings:        bindings,
		Health:                 health,
		Checks:                 checks,
		CanEnable:              len(blockingIssues) == 0,
		BlockingIssues:         blockingIssues,
		Warnings:               warnings,
	}
	if target != nil {
		result.TargetProfileID = &target.ID
		result.TargetProfileName = &target.Name
		apiBase := target.APIBase
		result.APIBase = &apiBase
	}
	return result, nil
}

// UpdateSettings serves PUT /proxy-governance.
//
// The order is the contract:
//  1. resolve the next configuration from the stored document;
//  2. when enabling, run the preflight (a blocked enable must not touch
//     LiteLLM), resolve the target and sync the team/key remotely;
//  3. persist the new document and invalidate the cache;
//  4. only then block the previous managed resources, best effort;
//  5. write the audit entry and project the saved state.
//
// Step 3 never runs before step 2 succeeded, so a failed remote call leaves the
// previous configuration intact instead of persisting a key LiteLLM never saw.
func (s *Service) UpdateSettings(ctx context.Context, orgID, actorID string, input governanceUpdateInput) (governanceSettingsPublic, error) {
	resolved, _, err := s.loadResolvedGovernance(ctx)
	if err != nil {
		return governanceSettingsPublic{}, err
	}
	current := resolved
	next := resolved
	next.Enabled = input.enabledValue(current.Enabled)
	next.DailyBudgetUSD = input.DailyBudgetUSD.budgetValue(current.DailyBudgetUSD)
	next.MonthlyBudgetUSD = input.MonthlyBudgetUSD.budgetValue(current.MonthlyBudgetUSD)
	next.MaxParallelRequests = input.MaxParallelRequests.parallelValue(current.MaxParallelRequests)
	next.TargetProfileID = input.targetValue(current.TargetProfileID)

	action := auditActionUpdate
	var previous *resolvedGovernance

	if next.Enabled {
		if err := s.assertEnablePreflight(ctx, next.TargetProfileID); err != nil {
			return governanceSettingsPublic{}, err
		}
		target, err := s.requireTargetProfile(ctx, next.TargetProfileID)
		if err != nil {
			return governanceSettingsPublic{}, err
		}
		switchInstance := s.isSwitchingManagedProxyInstance(ctx, current, target.APIBase)
		synced, err := s.syncEnabledSettings(ctx, next, target.APIBase)
		if err != nil {
			return governanceSettingsPublic{}, err
		}
		next.ManagedTeamID = &synced.ManagedTeamID
		next.ManagedRuntimeKey = synced.ManagedRuntimeKey
		next.ManagedRuntimeKeyState = managedKeyAvailable
		next.ManagedRuntimeKeyAlias = &synced.ManagedRuntimeKeyAlias
		syncedAt := s.nowUTC().Format("2006-01-02T15:04:05.000Z")
		next.LastSyncedAt = &syncedAt
		next.LastSyncError = nil
		if switchInstance {
			// The old key belongs to a DIFFERENT proxy instance; it is blocked
			// only after the new state is durable.
			previous = &current
		}
	} else {
		action = auditActionDisable
		// The stored key/team are cleared BEFORE the write, so a disable never
		// leaves a readable key that governance no longer owns.
		next.ManagedTeamID = nil
		next.ManagedRuntimeKey = ""
		next.ManagedRuntimeKeyState = managedKeyMissing
		next.ManagedRuntimeKeyAlias = nil
		next.LastSyncedAt = current.LastSyncedAt
		next.LastSyncError = nil
		previous = &current
	}

	if err := s.persistGovernance(ctx, actorID, next); err != nil {
		return governanceSettingsPublic{}, err
	}
	if previous != nil {
		s.disableManagedResourcesBestEffort(ctx, *previous)
	}

	apiBase := s.resolveGovernedAPIBase(ctx, next)
	metadata, err := json.Marshal(auditGovernanceUpdateMetadata{
		Enabled:                next.Enabled,
		APIBase:                stringPointerOrNil(apiBase),
		DailyBudgetUSD:         next.DailyBudgetUSD,
		MonthlyBudgetUSD:       next.MonthlyBudgetUSD,
		MaxParallelRequests:    next.MaxParallelRequests,
		TargetProfileID:        next.TargetProfileID,
		HasManagedRuntimeKey:   next.ManagedRuntimeKey != "",
		ManagedTeamID:          next.ManagedTeamID,
		ManagedRuntimeKeyAlias: next.ManagedRuntimeKeyAlias,
	})
	if err != nil {
		return governanceSettingsPublic{}, err
	}
	if err := s.writeGovernanceAudit(ctx, orgID, actorID, action, metadata); err != nil {
		return governanceSettingsPublic{}, err
	}
	return s.projectGovernance(ctx, governanceSourceDB, next, nil)
}

// ResetToDefaults serves DELETE /proxy-governance. The row and the cache entry go
// first, so a failing best-effort shutdown cannot resurrect a deleted policy.
func (s *Service) ResetToDefaults(ctx context.Context, orgID, actorID string) (governanceSettingsPublic, error) {
	resolved, _, err := s.loadResolvedGovernance(ctx)
	if err != nil {
		return governanceSettingsPublic{}, err
	}
	if err := s.deleteGovernance(ctx); err != nil {
		return governanceSettingsPublic{}, err
	}
	s.disableManagedResourcesBestEffort(ctx, resolved)

	apiBase := s.resolveGovernedAPIBase(ctx, resolved)
	metadata, err := json.Marshal(auditGovernanceResetMetadata{
		OK:              true,
		APIBase:         stringPointerOrNil(apiBase),
		TargetProfileID: resolved.TargetProfileID,
	})
	if err != nil {
		return governanceSettingsPublic{}, err
	}
	if err := s.writeGovernanceAudit(ctx, orgID, actorID, auditActionReset, metadata); err != nil {
		return governanceSettingsPublic{}, err
	}
	return s.GetSettings(ctx)
}

// RotateManagedRuntimeKey serves POST /proxy-governance/rotate-key.
//
// The previous key is blocked only after the new key is durable: a crash between
// the two leaves a working new key plus an orphaned old one, which is recoverable
// by rotating again, whereas blocking first could leave no usable key at all.
func (s *Service) RotateManagedRuntimeKey(ctx context.Context, orgID, actorID string) (governanceSettingsPublic, error) {
	resolved, _, err := s.loadResolvedGovernance(ctx)
	if err != nil {
		return governanceSettingsPublic{}, err
	}
	if !resolved.Enabled {
		return governanceSettingsPublic{}, badRequest("LiteLLM proxy governance must be enabled before rotating runtime key")
	}
	if resolved.ManagedTeamID == nil {
		return governanceSettingsPublic{}, badRequest("Managed LiteLLM team is not configured")
	}

	target, err := s.requireTargetProfile(ctx, resolved.TargetProfileID)
	if err != nil {
		return governanceSettingsPublic{}, err
	}
	client, err := s.adminClient(target.APIBase)
	if err != nil {
		return governanceSettingsPublic{}, err
	}
	oldKey := resolved.ManagedRuntimeKey
	nextAlias := s.buildRuntimeKeyAlias()
	generated, err := s.generateRuntimeKey(ctx, client, keyGeneratePayload{
		KeyAlias:            nextAlias,
		TeamID:              *resolved.ManagedTeamID,
		MaxBudget:           resolved.DailyBudgetUSD,
		BudgetDuration:      managedKeyBudgetDuration,
		MaxParallelRequests: resolved.MaxParallelRequests,
		Metadata:            newGovernanceMetadata(),
	})
	if err != nil {
		return governanceSettingsPublic{}, err
	}
	previousRuntimeKey := ""
	if oldKey != "" && oldKey != generated.Key {
		previousRuntimeKey = oldKey
	}

	next := resolved
	next.ManagedRuntimeKey = generated.Key
	next.ManagedRuntimeKeyState = managedKeyAvailable
	next.ManagedRuntimeKeyAlias = &generated.KeyAlias
	syncedAt := s.nowUTC().Format("2006-01-02T15:04:05.000Z")
	next.LastSyncedAt = &syncedAt
	next.LastSyncError = nil

	if err := s.persistGovernance(ctx, actorID, next); err != nil {
		return governanceSettingsPublic{}, err
	}
	if previousRuntimeKey != "" {
		s.blockRuntimeKeyBestEffort(ctx, client, previousRuntimeKey)
	}

	apiBase := s.resolveGovernedAPIBase(ctx, next)
	metadata, err := json.Marshal(auditGovernanceRotateMetadata{
		APIBase:                stringPointerOrNil(apiBase),
		TargetProfileID:        next.TargetProfileID,
		ManagedTeamID:          next.ManagedTeamID,
		ManagedRuntimeKeyAlias: next.ManagedRuntimeKeyAlias,
	})
	if err != nil {
		return governanceSettingsPublic{}, err
	}
	if err := s.writeGovernanceAudit(ctx, orgID, actorID, auditActionRotateKey, metadata); err != nil {
		return governanceSettingsPublic{}, err
	}
	return s.projectGovernance(ctx, governanceSourceDB, next, nil)
}

// ---- shared helpers ----

// loadResolvedGovernance reads and resolves the stored document.
func (s *Service) loadResolvedGovernance(ctx context.Context) (resolvedGovernance, bool, error) {
	raw, found, err := s.loadGovernanceRaw(ctx)
	if err != nil {
		return resolvedGovernance{}, false, err
	}
	return s.resolveGovernanceDocument(raw), found, nil
}

// persistGovernance writes the document derived from resolved. The managed
// runtime key is re-encoded through the shared secret policy on every write, so
// a plaintext key in a non-production deployment becomes an envelope as soon as
// encryption is configured.
func (s *Service) persistGovernance(ctx context.Context, actorID string, resolved resolvedGovernance) error {
	document := storedGovernance{
		Enabled:                resolved.Enabled,
		DailyBudgetUSD:         resolved.DailyBudgetUSD,
		MonthlyBudgetUSD:       resolved.MonthlyBudgetUSD,
		MaxParallelRequests:    resolved.MaxParallelRequests,
		TargetProfileID:        resolved.TargetProfileID,
		ManagedTeamID:          resolved.ManagedTeamID,
		ManagedRuntimeKeyAlias: resolved.ManagedRuntimeKeyAlias,
		LastSyncedAt:           resolved.LastSyncedAt,
		LastSyncError:          resolved.LastSyncError,
	}
	if resolved.ManagedRuntimeKey != "" {
		if s.profiles == nil {
			return errors.New("llmgatewayops: profile port is not configured")
		}
		encoded, err := s.profiles.EncodeSecretForStorage(ctx, resolved.ManagedRuntimeKey)
		if err != nil {
			return err
		}
		document.ManagedRuntimeKey = encoded
	}
	payload, err := json.Marshal(document)
	if err != nil {
		return err
	}
	return s.saveGovernance(ctx, payload, actorID)
}

// resolveTargetProfile resolves one profile id into a governance target. A
// profile that exists but is disabled is not a target: governance must never
// point at a profile the runtime refuses to use.
func (s *Service) resolveTargetProfile(ctx context.Context, profileID *string) (*governanceTargetProfile, error) {
	if profileID == nil || *profileID == "" {
		return nil, nil
	}
	if s.profiles == nil {
		return nil, errors.New("llmgatewayops: profile port is not configured")
	}
	profile, found, err := s.profiles.RuntimeProfileConfig(ctx, *profileID)
	if err != nil {
		return nil, err
	}
	if !found || !profile.Enabled {
		return nil, nil
	}
	return &governanceTargetProfile{ID: profile.ID, Name: profile.Name, APIBase: profile.APIBase}, nil
}

// requireTargetProfile is resolveTargetProfile plus the 400 an enable needs.
func (s *Service) requireTargetProfile(ctx context.Context, profileID *string) (*governanceTargetProfile, error) {
	target, err := s.resolveTargetProfile(ctx, profileID)
	if err != nil {
		return nil, err
	}
	if target == nil {
		return nil, badRequest("Select an enabled LiteLLM gateway profile before enabling managed governance")
	}
	return target, nil
}

// resolveGovernedAPIBase returns the apiBase of the CURRENT target profile, or ""
// when the target is missing. It resolves through the profile document instead of
// trusting the stored apiBase, so a profile that moved to another host disables
// the previous instance correctly.
func (s *Service) resolveGovernedAPIBase(ctx context.Context, settings resolvedGovernance) string {
	target, err := s.resolveTargetProfile(ctx, settings.TargetProfileID)
	if err != nil || target == nil {
		return ""
	}
	return target.APIBase
}

// runtimeBindings compares the current runtime bindings against the target.
func (s *Service) runtimeBindings(ctx context.Context, target *governanceTargetProfile) (trafficBindings, error) {
	if s.profiles == nil {
		return trafficBindings{}, errors.New("llmgatewayops: profile port is not configured")
	}
	snapshot, err := s.profiles.RuntimeBindings(ctx)
	if err != nil {
		return trafficBindings{}, err
	}
	if target == nil {
		return trafficBindings{}, nil
	}
	return trafficBindings{
		Completion: bindingMatches(snapshot.CompletionProfileID, target.ID),
		Embedding:  bindingMatches(snapshot.EmbeddingProfileID, target.ID),
		Rerank:     bindingMatches(snapshot.RerankProfileID, target.ID),
	}, nil
}

// bindingMatches reports whether a resolved binding points at the target.
func bindingMatches(binding *string, targetID string) bool {
	return binding != nil && *binding == targetID
}

// assertEnablePreflight rejects an enable whose preflight has blocking issues,
// with the same joined message the NestJS service throws.
func (s *Service) assertEnablePreflight(ctx context.Context, targetID *string) error {
	preflight, err := s.GetPreflight(ctx, governancePreflightInput{TargetProfileIDPresent: true, TargetProfileID: targetID})
	if err != nil {
		return err
	}
	if preflight.CanEnable {
		return nil
	}
	return badRequest(strings.Join(preflight.BlockingIssues, " "))
}

// checkTargetProfileHealth probes /health/liveliness and /health/readiness of the
// target in parallel with a fixed 10 second deadline.
//
// It deliberately sends no credential: the source preflight resolves the
// profile_key mode with an empty fallback key, and a health endpoint that needs a
// key is itself a misconfiguration worth reporting.
func (s *Service) checkTargetProfileHealth(ctx context.Context, target *governanceTargetProfile) (governanceHealthResult, error) {
	baseURL := normalizeAPIBase(target.APIBase)
	checkedAt := s.nowUTC().Format("2006-01-02T15:04:05.000Z")
	if baseURL == "" {
		message := "Target profile apiBase is not a valid OpenAI-compatible base URL."
		return governanceHealthResult{
			APIBase:    target.APIBase,
			CheckedAt:  checkedAt,
			Liveliness: endpointCheck{OK: false, Message: &message},
			Readiness:  endpointCheck{OK: false, Message: &message},
		}, nil
	}
	client := newUpstreamClient(s.http, baseURL, "", governanceHealthTimeout)
	type result struct {
		check endpointCheck
	}
	livelinessCh := make(chan result, 1)
	readinessCh := make(chan result, 1)
	go func() {
		livelinessCh <- result{check: checkGovernanceEndpoint(ctx, client, "/health/liveliness")}
	}()
	go func() {
		readinessCh <- result{check: checkGovernanceEndpoint(ctx, client, "/health/readiness")}
	}()
	liveliness := <-livelinessCh
	readiness := <-readinessCh
	return governanceHealthResult{
		APIBase:    baseURL,
		CheckedAt:  checkedAt,
		Liveliness: liveliness.check,
		Readiness:  readiness.check,
	}, nil
}

// checkGovernanceEndpoint performs one health GET. Unlike the diagnostic health
// route, preflight keeps the raw 2xx status even for an HTML body: it only asks
// "is the proxy answering".
func checkGovernanceEndpoint(ctx context.Context, client upstreamClient, path string) endpointCheck {
	response, err := client.get(ctx, path)
	if err != nil {
		check := endpointCheck{OK: false}
		var upstream *upstreamError
		if errors.As(err, &upstream) {
			if upstream.status != 0 {
				status := upstream.status
				check.Status = &status
			}
			message := strings.TrimSpace(upstream.detail)
			if message == "" {
				message = strings.TrimSpace(upstream.message)
			}
			if message == "" {
				message = "Proxy health check failed"
			}
			check.Message = &message
			return check
		}
		message := "Proxy health check failed"
		if err != nil {
			message = err.Error()
		}
		check.Message = &message
		return check
	}
	status := response.status
	return endpointCheck{OK: status >= http.StatusOK && status < http.StatusMultipleChoices, Status: &status}
}

// toPublicSettings projects one resolved configuration.
func (s *Service) toPublicSettings(source governanceSource, resolved resolvedGovernance, target *governanceTargetProfile) governanceSettingsPublic {
	projection := governanceSettingsPublic{
		Source:                 source,
		Enabled:                resolved.Enabled,
		DailyBudgetUSD:         resolved.DailyBudgetUSD,
		MonthlyBudgetUSD:       resolved.MonthlyBudgetUSD,
		MaxParallelRequests:    resolved.MaxParallelRequests,
		TargetProfileID:        resolved.TargetProfileID,
		AdminKeyConfigured:     s.hasAdminKey(),
		HasManagedRuntimeKey:   resolved.hasManagedRuntimeKey(),
		ManagedRuntimeKeyState: resolved.ManagedRuntimeKeyState,
		ManagedTeamID:          resolved.ManagedTeamID,
		ManagedRuntimeKeyAlias: resolved.ManagedRuntimeKeyAlias,
		LastSyncedAt:           resolved.LastSyncedAt,
		LastSyncError:          resolved.LastSyncError,
	}
	if target != nil {
		apiBase := target.APIBase
		name := target.Name
		projection.APIBase = &apiBase
		projection.TargetProfileName = &name
		projection.TargetProfileEnabled = true
	}
	// A stale target (deleted or disabled) and an unreadable key both have to
	// override whatever lastSyncError the document carries: they describe the
	// CURRENT state, not the last successful sync.
	if resolved.Enabled && resolved.TargetProfileID != nil && target == nil {
		message := "Managed governance target profile is missing or disabled"
		projection.LastSyncError = &message
	} else if resolved.ManagedRuntimeKeyState == managedKeyUnreadable {
		message := "Managed runtime key is unreadable because secret decryption failed"
		projection.LastSyncError = &message
	}
	return projection
}

// projectGovernance resolves the target of an already saved configuration and
// projects it. A pre-resolved target skips the second profile read.
func (s *Service) projectGovernance(ctx context.Context, source governanceSource, resolved resolvedGovernance, target *governanceTargetProfile) (governanceSettingsPublic, error) {
	if target == nil {
		resolvedTarget, err := s.resolveTargetProfile(ctx, resolved.TargetProfileID)
		if err != nil {
			return governanceSettingsPublic{}, err
		}
		target = resolvedTarget
	}
	return s.toPublicSettings(source, resolved, target), nil
}

// isSwitchingManagedProxyInstance reports whether the enable moves governance to
// a DIFFERENT proxy host. Only then are the previous managed resources blocked;
// a plain budget change must not disable the key it just updated.
func (s *Service) isSwitchingManagedProxyInstance(ctx context.Context, current resolvedGovernance, nextAPIBase string) bool {
	if !current.Enabled {
		return false
	}
	currentAPIBase := s.resolveGovernedAPIBase(ctx, current)
	normalizedCurrent := normalizeAPIBase(currentAPIBase)
	normalizedNext := normalizeAPIBase(nextAPIBase)
	if normalizedCurrent == "" || normalizedNext == "" {
		return false
	}
	return normalizedCurrent != normalizedNext
}

// writeGovernanceAudit writes one already-marshalled metadata document.
func (s *Service) writeGovernanceAudit(ctx context.Context, orgID, actorID, action string, metadata json.RawMessage) error {
	return s.writeAuditLogBestEffort(ctx, orgID, actorID, action, metadata)
}

// stringPointerOrNil collapses an empty string to nil so the projection keeps
// null instead of an empty apiBase.
func stringPointerOrNil(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// boolMessage picks one of two fixed messages.
func boolMessage(ok bool, whenTrue, whenFalse string) string {
	if ok {
		return whenTrue
	}
	return whenFalse
}

// targetMessage renders the target_profile check message.
func targetMessage(target *governanceTargetProfile) string {
	if target == nil {
		return "Select an enabled LiteLLM target profile before enabling governance."
	}
	return fmt.Sprintf("Target profile %s is enabled.", target.Name)
}

// trafficMessage renders the runtime_traffic check message.
func trafficMessage(bindings trafficBindings, hasTraffic bool) string {
	if !hasTraffic {
		return "Completion, embedding, and rerank are not currently bound to the selected target profile."
	}
	return fmt.Sprintf("Runtime traffic currently uses the target profile for %s.", describeTrafficBindings(bindings))
}

// healthMessage renders the proxy_health check message.
func healthMessage(health *governanceHealthResult, ok bool) string {
	if health == nil {
		return "LiteLLM health checks have not been run for the selected target profile."
	}
	if ok {
		return "LiteLLM liveliness and readiness checks are healthy."
	}
	return "LiteLLM liveliness/readiness checks are failing for the selected target profile."
}

// managedKeyMessage renders the managed_runtime_key check message.
func managedKeyMessage(state managedKeyState) string {
	switch state {
	case managedKeyAvailable:
		return "Stored managed runtime key is readable."
	case managedKeyMissing:
		return "Managed runtime key will be created when governance is enabled."
	default:
		return "Stored managed runtime key is unreadable. Runtime governance will fail closed until secret decryption is fixed."
	}
}

// describeTrafficBindings joins the bound traffic kinds in a fixed order.
func describeTrafficBindings(bindings trafficBindings) string {
	labels := make([]string, 0, 3)
	if bindings.Completion {
		labels = append(labels, "completion")
	}
	if bindings.Embedding {
		labels = append(labels, "embedding")
	}
	if bindings.Rerank {
		labels = append(labels, "rerank")
	}
	return strings.Join(labels, ", ")
}
