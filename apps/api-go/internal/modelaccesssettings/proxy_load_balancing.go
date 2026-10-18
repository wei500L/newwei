package modelaccesssettings

import (
	"context"
	"encoding/json"
	"log"
	"math"
)

// This file implements LiteLLM proxy load balancing configuration management and
// distribution (four HTTP routes). The row is a global singleton, so every write
// runs behind the platform_admin gate and one MySQL session lock, re-reads the
// authoritative row inside it, and builds its response from the bytes it just
// wrote.
//
// Parsing is done ONCE per snapshot: every stored Anthropic key entry is
// classified a single time, and an encrypted entry is decrypted at most once even
// though three projections (resolved plaintext, public fingerprints, structural
// count) read it.

// parsedAnthropicKey is one classified stored Anthropic key entry projected onto
// the two values every caller needs. The entry is classified once, so an
// encrypted entry is decrypted at most once even when both projections read it.
type parsedAnthropicKey struct {
	// plaintext is the bearer-stripped usable key; empty when unresolvable.
	plaintext string
	// fingerprint is the projected fingerprint (a wrapped entry's stored value,
	// or the hash the legacy shapes derive); empty when it cannot be computed.
	fingerprint string
}

// anthropicKeySnapshot is the single decoded view of one anthropicApiKeys
// array: the resolved keys and the fingerprints, each in first-appearance order.
type anthropicKeySnapshot struct {
	keys         []string
	fingerprints []string
}

// effectiveProxyLBConfig is the resolved stored configuration both the public
// response and the internal snapshot read.
type effectiveProxyLBConfig struct {
	enabled               bool
	anthropicKeys         []string
	anthropicFingerprints []string
	routingStrategy       routingStrategy
	redisHost             string
	redisPort             int
	redisPassword         *string
	hasRedisPassword      bool
	deploymentRpm         *int
	deploymentTpm         *int
}

// proxyLBAnthropicWrite is the anthropicApiKeys fragment of a pending write plus
// the audit facts the NestJS metadata carries.
type proxyLBAnthropicWrite struct {
	raw         json.RawMessage
	storedCount int
	updated     bool
}

// proxyLBRedisPasswordWrite is the redisPassword fragment of a pending write.
type proxyLBRedisPasswordWrite struct {
	raw         secretValue
	hasPassword bool
	updated     bool
}

// resolveProxyLBSecretValue mirrors LiteLlmProxyLoadBalancingSettingsService
// .resolveSecret: a plaintext string or a decryptable envelope yields its
// JS-trimmed non-empty value; every failure mode is a soft miss (never a 500).
func (s *Service) resolveProxyLBSecretValue(value secretValue) (string, bool) {
	switch value.kind {
	case secretPlain:
		trimmed := jsTrimSpace(value.plain)
		if trimmed == "" {
			return "", false
		}
		return trimmed, true
	case secretEncrypted:
		key, present := s.settingsDecryptionKey()
		if !present {
			log.Printf("modelaccesssettings: SYSTEM_SETTINGS_ENCRYPTION_KEY is missing or invalid for the LiteLLM proxy LB secret")
			return "", false
		}
		decrypted, ok := value.decryptRaw(key)
		if !ok {
			log.Printf("modelaccesssettings: failed to decrypt a LiteLLM proxy LB secret")
			return "", false
		}
		trimmed := jsTrimSpace(decrypted)
		if trimmed == "" {
			return "", false
		}
		return trimmed, true
	default:
		return "", false
	}
}

// resolveProxyLBSecret is the raw-JSON entry point of resolveProxyLBSecretValue.
func (s *Service) resolveProxyLBSecret(raw json.RawMessage) (string, bool) {
	return s.resolveProxyLBSecretValue(secretValueFromRaw(raw))
}

// parseAnthropicKeyEntries classifies the stored array exactly once, in stored
// order. Predicate order matches the reference: {fingerprint, value}, then a
// legacy plaintext string, then a bare system-settings:v1 envelope. Entries
// matching none of the three shapes are skipped by every projection.
func (s *Service) parseAnthropicKeyEntries(raw json.RawMessage) []parsedAnthropicKey {
	trimmed := trimJSON(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return nil
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(trimmed, &entries); err != nil {
		return nil
	}

	parsed := make([]parsedAnthropicKey, 0, len(entries))
	for _, rawEntry := range entries {
		entry := trimJSON(rawEntry)
		if !jsonTruthyJSON(entry) {
			continue
		}

		if entry[0] == '{' {
			var wrapper struct {
				Fingerprint json.RawMessage `json:"fingerprint"`
				Value       json.RawMessage `json:"value"`
			}
			if err := json.Unmarshal(entry, &wrapper); err == nil &&
				jsonIsString(wrapper.Fingerprint) && wrapper.Value != nil {
				value := secretValueFromRaw(wrapper.Value)
				plaintext := ""
				if secret, ok := s.resolveProxyLBSecretValue(value); ok {
					plaintext = stripBearerPrefix(secret)
				}
				fingerprint := ""
				if text, ok := jsonString(wrapper.Fingerprint); ok {
					fingerprint = jsTrimSpace(text)
				}
				parsed = append(parsed, parsedAnthropicKey{
					plaintext:   plaintext,
					fingerprint: fingerprint,
				})
				continue
			}
		}

		if jsonIsString(entry) {
			text, ok := jsonString(entry)
			if !ok {
				continue
			}
			parsed = append(parsed, parsedAnthropicKey{
				plaintext: stripBearerPrefix(text),
				// A legacy plaintext entry is hashed even when its stripped form
				// is empty; that asymmetry against the plaintext projection is
				// intentional.
				fingerprint: fingerprintKey(text),
			})
			continue
		}

		value := secretValueFromRaw(entry)
		if value.kind != secretEncrypted {
			continue
		}
		// One decryption feeds both the plaintext and the fingerprint of this
		// bare legacy envelope.
		secret, ok := s.resolveProxyLBSecretValue(value)
		plaintext := ""
		fingerprint := ""
		if ok {
			plaintext = stripBearerPrefix(secret)
			fingerprint = fingerprintKey(secret)
		}
		parsed = append(parsed, parsedAnthropicKey{
			plaintext:   plaintext,
			fingerprint: fingerprint,
		})
	}

	return parsed
}

// buildAnthropicKeySnapshot builds both projections from one parse pass.
func (s *Service) buildAnthropicKeySnapshot(raw json.RawMessage) anthropicKeySnapshot {
	parsed := s.parseAnthropicKeyEntries(raw)

	keys := make([]string, 0, len(parsed))
	fingerprints := make([]string, 0, len(parsed))

	for _, entry := range parsed {
		if entry.plaintext != "" {
			keys = append(keys, entry.plaintext)
		}
		if entry.fingerprint != "" {
			fingerprints = append(fingerprints, entry.fingerprint)
		}
	}

	return anthropicKeySnapshot{
		keys:         uniqueStrings(keys),
		fingerprints: uniqueStrings(fingerprints),
	}
}

// countStoredAnthropicKeys mirrors countStoredKeys: a purely structural count
// that never decrypts, so a retained stored list can be counted in the audit
// without decrypting or re-encrypting it.
func countStoredAnthropicKeys(raw json.RawMessage) int {
	trimmed := trimJSON(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return 0
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(trimmed, &entries); err != nil {
		return 0
	}

	count := 0
	for _, rawEntry := range entries {
		entry := trimJSON(rawEntry)
		if !jsonTruthyJSON(entry) {
			continue
		}
		if jsonIsString(entry) {
			count++
			continue
		}
		if _, ok := isEncryptedSecretShape(entry); ok {
			count++
			continue
		}
		if entry[0] != '{' {
			continue
		}
		var wrapper struct {
			Fingerprint json.RawMessage `json:"fingerprint"`
			Value       json.RawMessage `json:"value"`
		}
		if err := json.Unmarshal(entry, &wrapper); err != nil {
			continue
		}
		if !jsonIsString(wrapper.Fingerprint) || wrapper.Value == nil {
			continue
		}
		if secretValueFromRaw(wrapper.Value).truthy() {
			count++
		}
	}
	return count
}

// storedRoutingStrategy mirrors normalizeRoutingStrategy for a stored value: a
// JS-trimmed string that is one of the four accepted strategies, or a miss.
func storedRoutingStrategy(raw json.RawMessage) (routingStrategy, bool) {
	text, ok := jsonString(raw)
	if !ok {
		return "", false
	}
	return validRoutingStrategy(jsTrimSpace(text))
}

// asProxyLBPort mirrors asPort: JavaScript Number() coercion, then a 1..65535
// range check, then Math.floor. Anything unusable keeps the fallback.
func asProxyLBPort(raw json.RawMessage, fallback int) int {
	value, present := jsNumberFromJSON(raw)
	if !present || math.IsNaN(value) || math.IsInf(value, 0) || value < 1 || value > 65535 {
		return fallback
	}
	return int(math.Floor(value))
}

// normalizeNullablePositiveInt mirrors asNullablePositiveInt for an already
// typed request field.
func normalizeNullablePositiveInt(value *int) *int {
	if value == nil || *value <= 0 {
		return nil
	}
	normalized := *value
	return &normalized
}

// resolveProxyLBEffectiveConfig mirrors the NestJS resolveEffectiveConfig for
// this row: only a stored boolean overrides the default, a stored strategy must
// be one of the four accepted strings, redisHost falls back to "redis" and
// redisPort to 6379. The DTO's write-time bounds are deliberately NOT re-applied
// to a legacy stored row.
func (s *Service) resolveProxyLBEffectiveConfig(record proxyLoadBalancingRecord) effectiveProxyLBConfig {
	snapshot := s.buildAnthropicKeySnapshot(record.payload.AnthropicApiKeys)

	enabled := false
	if stored, ok := storedBool(record.payload.Enabled); ok {
		enabled = stored
	}

	strategy := defaultProxyLBRoutingStrategy
	if stored, ok := storedRoutingStrategy(record.payload.RoutingStrategy); ok {
		strategy = stored
	}

	redisHost := defaultProxyLBRedisHost
	if stored, ok := storedNonBlankString(record.payload.RedisHost); ok {
		redisHost = stored
	}

	password, hasPassword := s.resolveProxyLBSecret(record.payload.RedisPassword)
	var redisPassword *string
	if hasPassword {
		value := password
		redisPassword = &value
	}

	return effectiveProxyLBConfig{
		enabled:               enabled,
		anthropicKeys:         snapshot.keys,
		anthropicFingerprints: snapshot.fingerprints,
		routingStrategy:       strategy,
		redisHost:             redisHost,
		redisPort:             asProxyLBPort(record.payload.RedisPort, defaultProxyLBRedisPort),
		redisPassword:         redisPassword,
		hasRedisPassword:      hasPassword,
		deploymentRpm:         nullablePositiveInt(record.payload.DeploymentRpm),
		deploymentTpm:         nullablePositiveInt(record.payload.DeploymentTpm),
	}
}

// nullablePositiveInt projects a stored deploymentRpm/deploymentTpm value.
func nullablePositiveInt(raw json.RawMessage) *int {
	value, ok := asPositiveInt(raw)
	if !ok {
		return nil
	}
	return &value
}

// buildProxyLoadBalancingPublic projects one stored record plus the independent
// OpenAI key metadata onto the public response contract.
func (s *Service) buildProxyLoadBalancingPublic(
	record proxyLoadBalancingRecord,
	openai openAiKeysSettingsPublic,
) proxyLoadBalancingSettingsPublic {
	effective := s.resolveProxyLBEffectiveConfig(record)

	source := settingsSourceNone
	if record.present {
		source = settingsSourceDB
	}
	fingerprints := effective.anthropicFingerprints
	if fingerprints == nil {
		fingerprints = []string{}
	}

	return proxyLoadBalancingSettingsPublic{
		Source:                   source,
		Enabled:                  effective.enabled,
		Openai:                   openai,
		AnthropicKeysCount:       len(effective.anthropicKeys),
		AnthropicKeyFingerprints: fingerprints,
		RoutingStrategy:          effective.routingStrategy,
		RedisHost:                effective.redisHost,
		RedisPort:                effective.redisPort,
		HasRedisPassword:         effective.hasRedisPassword,
		DeploymentRpm:            effective.deploymentRpm,
		DeploymentTpm:            effective.deploymentTpm,
	}
}

// getProxyLoadBalancingSettings serves
// GET /api/system-settings/llm-gateways/proxy-load-balancing through the
// original 30 second best-effort cache contract.
func (s *Service) getProxyLoadBalancingSettings(ctx context.Context) (proxyLoadBalancingSettingsPublic, error) {
	record, err := s.readProxyLoadBalancingRecordCached(ctx)
	if err != nil {
		return proxyLoadBalancingSettingsPublic{}, err
	}
	openai, err := s.getOpenAiKeysSettings(ctx)
	if err != nil {
		return proxyLoadBalancingSettingsPublic{}, err
	}
	return s.buildProxyLoadBalancingPublic(record, openai), nil
}

// getProxyLoadBalancingInternalSnapshot serves
// GET /api/internal/litellm/proxy-load-balancing. It reuses the existing
// plaintext OpenAI key reader, so the LiteLLM snapshot always carries the real
// OpenAI pool even when the model access takeover is still legacy.
func (s *Service) getProxyLoadBalancingInternalSnapshot(ctx context.Context) (proxyLoadBalancingInternalSnapshot, error) {
	record, err := s.readProxyLoadBalancingRecordCached(ctx)
	if err != nil {
		return proxyLoadBalancingInternalSnapshot{}, err
	}
	effective := s.resolveProxyLBEffectiveConfig(record)

	openai, err := s.getPlaintextKeys(ctx)
	if err != nil {
		return proxyLoadBalancingInternalSnapshot{}, err
	}
	openaiKeys := openai.OpenaiApiKeys
	if openaiKeys == nil {
		openaiKeys = []string{}
	}
	anthropicKeys := effective.anthropicKeys
	if anthropicKeys == nil {
		anthropicKeys = []string{}
	}

	return proxyLoadBalancingInternalSnapshot{
		HasStoredConfig:  record.present,
		Enabled:          effective.enabled,
		OpenaiApiKeys:    openaiKeys,
		AnthropicApiKeys: anthropicKeys,
		RoutingStrategy:  effective.routingStrategy,
		RedisHost:        effective.redisHost,
		RedisPort:        effective.redisPort,
		RedisPassword:    effective.redisPassword,
		DeploymentRpm:    effective.deploymentRpm,
		DeploymentTpm:    effective.deploymentTpm,
	}, nil
}

// updateProxyLoadBalancingSettings serves
// PUT /api/system-settings/llm-gateways/proxy-load-balancing.
//
// LB1: the platform admin gate runs first. LB2/LB3: the merge baseline is the
// authoritative row read inside the global lock, and the response is projected
// from the bytes just written (never from the pre-write cache envelope).
func (s *Service) updateProxyLoadBalancingSettings(
	ctx context.Context,
	orgID string,
	actorID string,
	request updateProxyLBSettingsRequest,
) (proxyLoadBalancingSettingsPublic, error) {
	if err := s.assertPlatformAdmin(ctx, actorID); err != nil {
		return proxyLoadBalancingSettingsPublic{}, err
	}

	var result proxyLoadBalancingSettingsPublic
	err := s.withSessionLock(ctx, lockNameProxyLBConfig, func(lockCtx context.Context) error {
		record, err := s.readProxyLoadBalancingRecordAuthoritative(lockCtx)
		if err != nil {
			return err
		}
		public, err := s.persistProxyLoadBalancingLocked(lockCtx, orgID, actorID, record, request)
		if err != nil {
			return err
		}
		result = public
		return nil
	})
	if err != nil {
		return proxyLoadBalancingSettingsPublic{}, err
	}
	return result, nil
}

// resetProxyLoadBalancingSettings serves
// DELETE /api/system-settings/llm-gateways/proxy-load-balancing. It deletes only
// the load balancing row, keeps the independent openai_keys configuration, and
// returns the documented default shape.
func (s *Service) resetProxyLoadBalancingSettings(
	ctx context.Context,
	orgID string,
	actorID string,
) (proxyLoadBalancingSettingsPublic, error) {
	if err := s.assertPlatformAdmin(ctx, actorID); err != nil {
		return proxyLoadBalancingSettingsPublic{}, err
	}

	var result proxyLoadBalancingSettingsPublic
	err := s.withSessionLock(ctx, lockNameProxyLBConfig, func(lockCtx context.Context) error {
		if err := s.removeSetting(lockCtx, settingKeyProxyLoadBalancing); err != nil {
			return err
		}
		metadata, err := json.Marshal(okAudit{OK: true})
		if err != nil {
			return err
		}
		if err := s.writeAuditLogBestEffort(lockCtx, orgID, actorID, actionProxyLBReset, metadata); err != nil {
			return err
		}
		s.invalidateCache(lockCtx, cacheKeyProxyLoadBalancing)
		// The OpenAI key pool is an independent configuration and keeps its own
		// metadata in the response.
		openai, err := s.getOpenAiKeysSettings(lockCtx)
		if err != nil {
			return err
		}
		result = s.buildProxyLoadBalancingPublic(proxyLoadBalancingRecord{}, openai)
		return nil
	})
	if err != nil {
		return proxyLoadBalancingSettingsPublic{}, err
	}
	return result, nil
}

// persistProxyLoadBalancingLocked merges, persists and projects one update.
//
// The caller MUST hold lockNameProxyLBConfig: this helper never acquires the lock
// and never calls a public locking method. Every newly supplied Anthropic key is
// encoded BEFORE the upsert, so a mid-list encryption failure leaves the stored
// configuration untouched.
func (s *Service) persistProxyLoadBalancingLocked(
	ctx context.Context,
	orgID string,
	actorID string,
	record proxyLoadBalancingRecord,
	request updateProxyLBSettingsRequest,
) (proxyLoadBalancingSettingsPublic, error) {
	redisHost := jsTrimSpace(request.RedisHost)
	if redisHost == "" {
		return proxyLoadBalancingSettingsPublic{}, &httpError{status: 400, message: "redisHost is required"}
	}

	strategy, ok := validRoutingStrategy(request.RoutingStrategy)
	if !ok {
		return proxyLoadBalancingSettingsPublic{}, &httpError{status: 400, message: "routingStrategy is invalid"}
	}

	anthropic, err := s.resolveNextProxyLBAnthropicKeys(ctx, record, request)
	if err != nil {
		return proxyLoadBalancingSettingsPublic{}, err
	}

	password, err := s.resolveNextProxyLBRedisPassword(ctx, record, request.RedisPassword)
	if err != nil {
		return proxyLoadBalancingSettingsPublic{}, err
	}

	next := proxyLoadBalancingSettingsWrite{
		Enabled:          request.Enabled,
		AnthropicApiKeys: anthropic.raw,
		RoutingStrategy:  strategy,
		RedisHost:        redisHost,
		RedisPort:        request.RedisPort,
		RedisPassword:    password.raw,
		DeploymentRpm:    normalizeNullablePositiveInt(request.DeploymentRpm),
		DeploymentTpm:    normalizeNullablePositiveInt(request.DeploymentTpm),
	}

	payload, err := json.Marshal(next)
	if err != nil {
		return proxyLoadBalancingSettingsPublic{}, err
	}
	if err := s.persistSetting(ctx, settingKeyProxyLoadBalancing, payload, descriptionProxyLoadBalancing, nullableActorID(actorID)); err != nil {
		return proxyLoadBalancingSettingsPublic{}, err
	}

	metadata, err := json.Marshal(proxyLoadBalancingUpdateAudit{
		Enabled:              next.Enabled,
		AnthropicKeysCount:   anthropic.storedCount,
		RoutingStrategy:      next.RoutingStrategy,
		RedisHost:            next.RedisHost,
		RedisPort:            next.RedisPort,
		HasRedisPassword:     password.hasPassword,
		DeploymentRpm:        next.DeploymentRpm,
		DeploymentTpm:        next.DeploymentTpm,
		AnthropicKeysUpdated: anthropic.updated,
		RedisPasswordUpdated: password.updated,
	})
	if err != nil {
		return proxyLoadBalancingSettingsPublic{}, err
	}
	if err := s.writeAuditLogBestEffort(ctx, orgID, actorID, actionProxyLBUpdate, metadata); err != nil {
		return proxyLoadBalancingSettingsPublic{}, err
	}

	s.invalidateCache(ctx, cacheKeyProxyLoadBalancing)
	openai, err := s.getOpenAiKeysSettings(ctx)
	if err != nil {
		return proxyLoadBalancingSettingsPublic{}, err
	}
	written, err := decodeProxyLoadBalancingRecord(payload)
	if err != nil {
		return proxyLoadBalancingSettingsPublic{}, err
	}
	return s.buildProxyLoadBalancingPublic(written, openai), nil
}

// resolveNextProxyLBAnthropicKeys applies the key semantics: a provided array
// fully replaces the stored list (an explicit empty array clears it), an explicit
// clear flag clears it, and otherwise the stored entries are retained byte for
// byte without being decrypted or re-encrypted.
func (s *Service) resolveNextProxyLBAnthropicKeys(
	ctx context.Context,
	record proxyLoadBalancingRecord,
	request updateProxyLBSettingsRequest,
) (proxyLBAnthropicWrite, error) {
	if request.AnthropicApiKeysProvided {
		normalized := normalizeKeys(request.AnthropicApiKeys)
		if len(normalized) > maxProxyLBAnthropicKeys {
			return proxyLBAnthropicWrite{}, &httpError{
				status:  400,
				message: "Too many Anthropic API keys (max 100)",
			}
		}
		encoded := make([]anthropicKeyEntryWrite, 0, len(normalized))
		for _, key := range normalized {
			storedValue, err := s.encodeSecretForStorage(ctx, key)
			if err != nil {
				return proxyLBAnthropicWrite{}, err
			}
			encoded = append(encoded, anthropicKeyEntryWrite{
				Fingerprint: fingerprintKey(key),
				Value:       storedValue,
			})
		}
		raw, err := json.Marshal(encoded)
		if err != nil {
			return proxyLBAnthropicWrite{}, err
		}
		return proxyLBAnthropicWrite{raw: raw, storedCount: len(encoded), updated: true}, nil
	}

	if request.ClearAnthropicApiKeys {
		return proxyLBAnthropicWrite{raw: json.RawMessage("[]"), storedCount: 0, updated: true}, nil
	}

	retained := record.payload.AnthropicApiKeys
	if !jsonPresent(retained) || jsonIsNull(retained) {
		retained = json.RawMessage("[]")
	}
	return proxyLBAnthropicWrite{
		raw:         retained,
		storedCount: countStoredAnthropicKeys(retained),
		updated:     false,
	}, nil
}

// resolveNextProxyLBRedisPassword applies the password semantics: omission keeps
// the stored representation, while an explicit null, an empty string and a
// whitespace-only string all clear it. Only a string is trimmed before the
// shared encryption policy encodes it.
func (s *Service) resolveNextProxyLBRedisPassword(
	ctx context.Context,
	record proxyLoadBalancingRecord,
	request optionalString,
) (proxyLBRedisPasswordWrite, error) {
	if request.Kind == optionalStringAbsent {
		retained := secretValueNull()
		if jsonPresent(record.payload.RedisPassword) && !jsonIsNull(record.payload.RedisPassword) {
			retained = secretValueFromRaw(record.payload.RedisPassword)
		}
		_, hasPassword := s.resolveProxyLBSecretValue(retained)
		return proxyLBRedisPasswordWrite{raw: retained, hasPassword: hasPassword, updated: false}, nil
	}

	normalized := ""
	if request.Kind == optionalStringValue {
		normalized = jsTrimSpace(request.Value)
	}
	if normalized == "" {
		return proxyLBRedisPasswordWrite{raw: secretValueNull(), hasPassword: false, updated: true}, nil
	}

	stored, err := s.encodeSecretForStorage(ctx, normalized)
	if err != nil {
		return proxyLBRedisPasswordWrite{}, err
	}
	return proxyLBRedisPasswordWrite{raw: stored, hasPassword: true, updated: true}, nil
}
