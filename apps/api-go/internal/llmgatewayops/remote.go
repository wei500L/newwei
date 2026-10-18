package llmgatewayops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// LiteLLM management protocol constants. Each literal is part of the remote
// contract, not a local preference.
const (
	// managementTimeoutMs is the axios timeout of every management call.
	managementTimeoutMS = 60_000
	// managedTeamAlias is the team_alias written on /team/update and /team/new.
	managedTeamAlias = "Modular Runtime Governance"
	// managedTeamBudgetDuration is the team budget window (monthly budget).
	managedTeamBudgetDuration = "30d"
	// managedKeyBudgetDuration is the key budget window (daily budget).
	managedKeyBudgetDuration = "1d"
	// managedByValue and managementScopeValue identify the resources this batch
	// owns inside LiteLLM metadata.
	managedByValue       = "modular"
	managementScopeValue = "runtime_governance"
	// runtimeKeyAliasPrefix prefixes a generated runtime key alias.
	runtimeKeyAliasPrefix = "modular-runtime-"
	// runtimeKeyAliasLength is the truncated ISO timestamp length.
	runtimeKeyAliasLength = 19
	// teamIDPrefix prefixes a generated LiteLLM team id.
	teamIDPrefix = "modular-runtime-"
)

// governanceMetadata is the metadata object written on every managed team/key.
type governanceMetadata struct {
	ManagedBy string `json:"managed_by"`
	Scope     string `json:"scope"`
}

// newGovernanceMetadata builds the fixed metadata object.
func newGovernanceMetadata() governanceMetadata {
	return governanceMetadata{ManagedBy: managedByValue, Scope: managementScopeValue}
}

// teamPayload is the /team/update and /team/new body.
type teamPayload struct {
	TeamID         string             `json:"team_id"`
	TeamAlias      string             `json:"team_alias"`
	MaxBudget      float64            `json:"max_budget"`
	BudgetDuration string             `json:"budget_duration"`
	Blocked        bool               `json:"blocked"`
	Metadata       governanceMetadata `json:"metadata"`
}

// keyUpdatePayload is the /key/update body of an enable or disable.
type keyUpdatePayload struct {
	Key                 string             `json:"key"`
	KeyAlias            string             `json:"key_alias"`
	TeamID              string             `json:"team_id"`
	MaxBudget           float64            `json:"max_budget"`
	BudgetDuration      string             `json:"budget_duration"`
	MaxParallelRequests int                `json:"max_parallel_requests"`
	Blocked             bool               `json:"blocked"`
	Metadata            governanceMetadata `json:"metadata"`
}

// keyGeneratePayload is the /key/generate body.
type keyGeneratePayload struct {
	KeyAlias            string             `json:"key_alias"`
	TeamID              string             `json:"team_id"`
	MaxBudget           float64            `json:"max_budget"`
	BudgetDuration      string             `json:"budget_duration"`
	MaxParallelRequests int                `json:"max_parallel_requests"`
	Metadata            governanceMetadata `json:"metadata"`
}

// blockedKeyPayload is the best-effort shutdown of one runtime key. It carries
// only the four fields the source sends: blocking must not re-state a budget
// window that the caller did not intend.
type blockedKeyPayload struct {
	Key            string  `json:"key"`
	Blocked        bool    `json:"blocked"`
	MaxBudget      float64 `json:"max_budget"`
	BudgetDuration string  `json:"budget_duration"`
}

// blockedTeamPayload is the best-effort shutdown of one managed team.
type blockedTeamPayload struct {
	TeamID         string  `json:"team_id"`
	Blocked        bool    `json:"blocked"`
	MaxBudget      float64 `json:"max_budget"`
	BudgetDuration string  `json:"budget_duration"`
}

// generatedKey is one /key/generate result.
type generatedKey struct {
	Key      string
	KeyAlias string
}

// generatedKeyResponse is the tolerant decode of /key/generate.
type generatedKeyResponse struct {
	Key      json.RawMessage `json:"key"`
	KeyAlias json.RawMessage `json:"key_alias"`
}

// syncResult is the outcome of syncEnabledSettings.
type syncResult struct {
	ManagedTeamID          string
	ManagedRuntimeKey      string
	ManagedRuntimeKeyAlias string
}

// adminClient builds the management client. A missing LITELLM_MASTER_KEY is a
// 503 on the management call only: GET and preflight keep reporting
// adminKeyConfigured=false, and an ordinary profile_key probe is unaffected.
func (s *Service) adminClient(apiBase string) (upstreamClient, error) {
	key := normalizeSecret(s.cfg.MasterKey)
	if key == "" {
		return upstreamClient{}, serviceUnavailable("LITELLM_MASTER_KEY is required for LiteLLM proxy governance")
	}
	return newUpstreamClient(s.http, apiBase, key, time.Duration(managementTimeoutMS)*time.Millisecond), nil
}

// upsertTeam mirrors upsertTeam: /team/update first, then /team/new when (and
// only when) the update reported a missing team.
func (s *Service) upsertTeam(ctx context.Context, client upstreamClient, teamID string, monthlyBudgetUSD float64) error {
	payload := teamPayload{
		TeamID:         teamID,
		TeamAlias:      managedTeamAlias,
		MaxBudget:      monthlyBudgetUSD,
		BudgetDuration: managedTeamBudgetDuration,
		Blocked:        false,
		Metadata:       newGovernanceMetadata(),
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := client.postBody(ctx, "/team/update", body); err != nil {
		if shouldCreateManagedResource(err) {
			if _, createErr := client.postBody(ctx, "/team/new", body); createErr != nil {
				return toSyncError(createErr, "Failed to update LiteLLM managed team")
			}
			return nil
		}
		return toSyncError(err, "Failed to update LiteLLM managed team")
	}
	return nil
}

// updateRuntimeKey mirrors updateRuntimeKey.
func (s *Service) updateRuntimeKey(ctx context.Context, client upstreamClient, payload keyUpdatePayload) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := client.postBody(ctx, "/key/update", body); err != nil {
		return err
	}
	return nil
}

// generateRuntimeKey mirrors generateRuntimeKey: a 2xx without a usable key is a
// 503, and the returned alias falls back to the requested one.
func (s *Service) generateRuntimeKey(ctx context.Context, client upstreamClient, payload keyGeneratePayload) (generatedKey, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return generatedKey{}, err
	}
	response, err := client.postBody(ctx, "/key/generate", body)
	if err != nil {
		return generatedKey{}, toSyncError(err, "Failed to generate LiteLLM managed runtime key")
	}
	var decoded generatedKeyResponse
	if err := json.Unmarshal(response.body, &decoded); err != nil {
		return generatedKey{}, serviceUnavailable("LiteLLM did not return a managed runtime key")
	}
	key := normalizeSecret(strings.TrimSpace(rawString(decoded.Key)))
	if key == "" {
		return generatedKey{}, serviceUnavailable("LiteLLM did not return a managed runtime key")
	}
	alias := rawString(decoded.KeyAlias)
	if alias == "" {
		alias = payload.KeyAlias
	}
	return generatedKey{Key: key, KeyAlias: alias}, nil
}

// syncEnabledSettings mirrors syncEnabledSettings: ensure the team, then reuse
// the stored key through /key/update, and only generate a new key when the
// update reported a missing or invalid key.
func (s *Service) syncEnabledSettings(ctx context.Context, settings resolvedGovernance, apiBase string) (syncResult, error) {
	client, err := s.adminClient(apiBase)
	if err != nil {
		return syncResult{}, err
	}
	teamID := ""
	if settings.ManagedTeamID != nil {
		teamID = *settings.ManagedTeamID
	}
	if teamID == "" {
		suffix, suffixErr := newShortID()
		if suffixErr != nil {
			return syncResult{}, suffixErr
		}
		teamID = teamIDPrefix + suffix
	}
	keyAlias := ""
	if settings.ManagedRuntimeKeyAlias != nil {
		keyAlias = *settings.ManagedRuntimeKeyAlias
	}
	if keyAlias == "" {
		keyAlias = s.buildRuntimeKeyAlias()
	}
	if err := s.upsertTeam(ctx, client, teamID, settings.MonthlyBudgetUSD); err != nil {
		return syncResult{}, err
	}

	if settings.ManagedRuntimeKey != "" {
		updateErr := s.updateRuntimeKey(ctx, client, keyUpdatePayload{
			Key:                 settings.ManagedRuntimeKey,
			KeyAlias:            keyAlias,
			TeamID:              teamID,
			MaxBudget:           settings.DailyBudgetUSD,
			BudgetDuration:      managedKeyBudgetDuration,
			MaxParallelRequests: settings.MaxParallelRequests,
			Blocked:             false,
			Metadata:            newGovernanceMetadata(),
		})
		if updateErr == nil {
			return syncResult{ManagedTeamID: teamID, ManagedRuntimeKey: settings.ManagedRuntimeKey, ManagedRuntimeKeyAlias: keyAlias}, nil
		}
		if !shouldRecreateManagedKey(updateErr) {
			return syncResult{}, toSyncError(updateErr, "Failed to update LiteLLM managed runtime key")
		}
	}

	generated, err := s.generateRuntimeKey(ctx, client, keyGeneratePayload{
		KeyAlias:            keyAlias,
		TeamID:              teamID,
		MaxBudget:           settings.DailyBudgetUSD,
		BudgetDuration:      managedKeyBudgetDuration,
		MaxParallelRequests: settings.MaxParallelRequests,
		Metadata:            newGovernanceMetadata(),
	})
	if err != nil {
		return syncResult{}, err
	}
	return syncResult{ManagedTeamID: teamID, ManagedRuntimeKey: generated.Key, ManagedRuntimeKeyAlias: generated.KeyAlias}, nil
}

// disableManagedResourcesBestEffort blocks the managed key and team of a
// previous configuration. A failure here is a warning: the new state is already
// durable, and the operator can rotate or disable again.
func (s *Service) disableManagedResourcesBestEffort(ctx context.Context, settings resolvedGovernance) {
	if settings.ManagedTeamID == nil && settings.ManagedRuntimeKey == "" {
		return
	}
	if !s.hasAdminKey() {
		return
	}
	apiBase := s.resolveGovernedAPIBase(ctx, settings)
	if apiBase == "" {
		return
	}
	client, err := s.adminClient(apiBase)
	if err != nil {
		log.Printf("llmgatewayops: cannot build the LiteLLM admin client to disable managed resources: %v", err)
		return
	}
	if settings.ManagedRuntimeKey != "" {
		s.blockRuntimeKeyBestEffort(ctx, client, settings.ManagedRuntimeKey)
	}
	if settings.ManagedTeamID != nil {
		s.blockTeamBestEffort(ctx, client, *settings.ManagedTeamID)
	}
}

// blockRuntimeKeyBestEffort blocks one key. Failure only warns.
func (s *Service) blockRuntimeKeyBestEffort(ctx context.Context, client upstreamClient, key string) {
	body, err := json.Marshal(blockedKeyPayload{
		Key:            key,
		Blocked:        true,
		MaxBudget:      0,
		BudgetDuration: managedKeyBudgetDuration,
	})
	if err != nil {
		log.Printf("llmgatewayops: cannot encode the block request of the managed runtime key: %v", err)
		return
	}
	if _, err := client.postBody(ctx, "/key/update", body); err != nil {
		log.Printf("llmgatewayops: failed to block the LiteLLM managed runtime key during the disable flow: %v", err)
	}
}

// blockTeamBestEffort blocks one team. Failure only warns.
func (s *Service) blockTeamBestEffort(ctx context.Context, client upstreamClient, teamID string) {
	body, err := json.Marshal(blockedTeamPayload{
		TeamID:         teamID,
		Blocked:        true,
		MaxBudget:      0,
		BudgetDuration: managedTeamBudgetDuration,
	})
	if err != nil {
		log.Printf("llmgatewayops: cannot encode the block request of the managed team: %v", err)
		return
	}
	if _, err := client.postBody(ctx, "/team/update", body); err != nil {
		log.Printf("llmgatewayops: failed to block the LiteLLM managed team during the disable flow: %v", err)
	}
}

// buildRuntimeKeyAlias mirrors buildRuntimeKeyAlias: the ISO timestamp with ":"
// and "." replaced by "-", truncated to 19 characters.
func (s *Service) buildRuntimeKeyAlias() string {
	stamp := s.nowUTC().Format("2006-01-02T15:04:05.000Z")
	replaced := strings.NewReplacer(":", "-", ".", "-").Replace(stamp)
	if len(replaced) > runtimeKeyAliasLength {
		replaced = replaced[:runtimeKeyAliasLength]
	}
	return runtimeKeyAliasPrefix + replaced
}

// notFoundBodyPattern detects the "not found" wording LiteLLM uses when the
// managed team or key does not exist yet.
var (
	notFoundPattern   = regexp.MustCompile(`(?i)not\s+found`)
	invalidKeyPattern = regexp.MustCompile(`(?i)invalid\s+key`)
)

// shouldCreateManagedResource mirrors shouldCreateManagedResource: only a 404, or
// a 400 whose body says "not found", means the team has to be created.
func shouldCreateManagedResource(err error) bool {
	var upstream *upstreamError
	if !errors.As(err, &upstream) {
		return false
	}
	if upstream.status == http.StatusNotFound {
		return true
	}
	return upstream.status == http.StatusBadRequest && notFoundPattern.Match(upstream.body)
}

// shouldRecreateManagedKey mirrors shouldRecreateManagedKey: a 404, or any
// response whose body says "not found" or "invalid key", means the stored key
// cannot be updated and a new one is generated.
func shouldRecreateManagedKey(err error) bool {
	var upstream *upstreamError
	if !errors.As(err, &upstream) {
		return false
	}
	if upstream.status == http.StatusNotFound {
		return true
	}
	return notFoundPattern.Match(upstream.body) || invalidKeyPattern.Match(upstream.body)
}

// toSyncError mirrors toSyncError: an upstream failure becomes a 503 carrying the
// HTTP status and the sanitized detail; an already coded error is preserved so a
// "did not return a key" 503 is not re-wrapped.
func toSyncError(err error, fallbackMessage string) error {
	var upstream *upstreamError
	if errors.As(err, &upstream) {
		detail := upstream.detail
		if detail == "" {
			detail = upstream.message
		}
		detail = strings.TrimSpace(detail)
		if detail == "" {
			detail = fallbackMessage
		}
		if upstream.status != 0 {
			return serviceUnavailable(fmt.Sprintf("%s: HTTP %d %s", fallbackMessage, upstream.status, detail))
		}
		return serviceUnavailable(fmt.Sprintf("%s: %s", fallbackMessage, detail))
	}
	var coded *httpError
	if errors.As(err, &coded) {
		return err
	}
	return serviceUnavailable(fallbackMessage)
}

// newShortID returns the eight character suffix of a generated team id, the same
// slice randomUUID() produces in the NestJS service.
func newShortID() (string, error) {
	id, err := newRowID()
	if err != nil {
		return "", err
	}
	// newRowID is 'c' plus 24 hex characters; take eight hex characters so the
	// shape matches randomUUID().slice(0, 8).
	if len(id) < 9 {
		return id, nil
	}
	return id[1:9], nil
}
