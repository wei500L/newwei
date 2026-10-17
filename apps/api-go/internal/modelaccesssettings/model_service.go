package modelaccesssettings

import (
	"context"
	"encoding/json"
	"log"
)

// envModelServiceDefaults is the environment projection of the model service
// configuration. It mirrors EnvService.modelServiceConfig plus the raw env reads
// the stored-token rules need.
type envModelServiceDefaults struct {
	enabled       bool
	baseURL       string
	internalToken string
	timeoutMs     int
	maxRetries    int
}

// modelServiceEnvDefaults projects Config onto the environment defaults.
//
// NestJS drops a blank env value before it ever reaches the service
// (z.preprocess for the URL/token, envBoolean's empty-string rule for the flag),
// so a blank raw value is "unset" here too. The accepted token is NEVER trimmed:
// the env schema only rejects an all-whitespace value, it keeps the original
// bytes for comparison.
func (s *Service) modelServiceEnvDefaults() envModelServiceDefaults {
	defaults := envModelServiceDefaults{
		enabled:    s.cfg.ModelServiceEnabled,
		timeoutMs:  s.cfg.ModelServiceTimeoutMs,
		maxRetries: s.cfg.ModelServiceMaxRetries,
	}
	if trimmed := jsTrimSpace(s.cfg.ModelServiceBaseURL); trimmed != "" {
		defaults.baseURL = trimmed
	}
	if jsTrimSpace(s.cfg.ModelServiceInternalToken) != "" {
		defaults.internalToken = s.cfg.ModelServiceInternalToken
	}
	return defaults
}

// effectiveModelServiceConfig is the resolved configuration both the public
// response and the write validation read.
type effectiveModelServiceConfig struct {
	enabled       bool
	baseURL       string
	internalToken string
	timeoutMs     int
	maxRetries    int
}

// resolveEffectiveConfig mirrors ModelServiceSettingsService.resolveEffectiveConfig:
// only a stored boolean overrides the env flag, a non-blank stored string
// overrides the env URL, the two integers use JavaScript Number coercion with a
// positive/non-negative rule, and the stored token wins only when it is usable.
//
// The DTO's Min/Max bounds are deliberately NOT re-applied to a stored row:
// reading a legacy row and validating a write body are two different rule sets.
func (s *Service) resolveEffectiveConfig(record modelServiceRecord) effectiveModelServiceConfig {
	defaults := s.modelServiceEnvDefaults()

	enabled := defaults.enabled
	if stored, ok := storedBool(record.payload.Enabled); ok {
		enabled = stored
	}

	baseURL := defaults.baseURL
	if stored, ok := storedNonBlankString(record.payload.BaseURL); ok {
		baseURL = stored
	}

	timeoutMs := defaults.timeoutMs
	if stored, ok := asPositiveInt(record.payload.TimeoutMs); ok {
		timeoutMs = stored
	}
	maxRetries := defaults.maxRetries
	if stored, ok := asNonNegativeInt(record.payload.MaxRetries); ok {
		maxRetries = stored
	}

	internalToken := ""
	if usable, ok := s.resolveStoredToken(record.payload.InternalToken); ok {
		internalToken = usable
	}
	if internalToken == "" {
		internalToken = defaults.internalToken
	}

	return effectiveModelServiceConfig{
		enabled:       enabled,
		baseURL:       baseURL,
		internalToken: internalToken,
		timeoutMs:     timeoutMs,
		maxRetries:    maxRetries,
	}
}

// storedBool returns a stored JSON boolean, like
// `typeof value === "boolean" ? value : fallback`.
func storedBool(raw json.RawMessage) (bool, bool) {
	switch string(trimJSON(raw)) {
	case "true":
		return true, true
	case "false":
		return false, true
	default:
		return false, false
	}
}

// storedNonBlankString returns a stored string whose JS-trimmed form is
// non-empty, like `normalizeString(value)`.
func storedNonBlankString(raw json.RawMessage) (string, bool) {
	text, ok := jsonString(raw)
	if !ok {
		return "", false
	}
	trimmed := jsTrimSpace(text)
	if trimmed == "" {
		return "", false
	}
	return trimmed, true
}

// resolveStoredToken projects a stored internalToken onto its usable plaintext.
//
// Every failure mode (no key, invalid key, decryption failure, unknown shape) is
// a soft "no stored token" and falls back to the environment token; it never turns
// a read into an error. The warning intentionally carries no secret material.
func (s *Service) resolveStoredToken(raw json.RawMessage) (string, bool) {
	stored := secretValueFromRaw(raw)
	if stored.kind == secretAbsent || stored.kind == secretNull {
		return "", false
	}
	if stored.kind == secretEncrypted {
		key, present := s.settingsDecryptionKey()
		if !present {
			log.Printf("modelaccesssettings: SYSTEM_SETTINGS_ENCRYPTION_KEY is missing or invalid for the model service token")
			return "", false
		}
		return stored.resolvePlaintext(key, true)
	}
	return stored.resolvePlaintext(nil, false)
}

// settingsDecryptionKey mirrors resolveSettingsKey: the key is usable only when
// the raw value is non-empty AND decodes to 32 bytes.
func (s *Service) settingsDecryptionKey() ([]byte, bool) {
	raw := s.cfg.SettingsEncryptionKeyRaw
	if raw == "" {
		return nil, false
	}
	decoded, err := decodeSettingsKey(raw)
	if err != nil {
		return nil, false
	}
	return decoded, true
}

// buildModelServicePublic projects one stored record onto the public response.
func (s *Service) buildModelServicePublic(record modelServiceRecord) modelServiceSettingsPublic {
	effective := s.resolveEffectiveConfig(record)

	storedTokenUsable := false
	if usable, ok := s.resolveStoredToken(record.payload.InternalToken); ok && usable != "" {
		storedTokenUsable = true
	}

	source := settingsSourceEnv
	if record.present {
		source = settingsSourceDB
	}
	state := tokenSourceNone
	switch {
	case storedTokenUsable:
		state = tokenSourceStored
	case effective.internalToken != "":
		state = tokenSourceEnv
	}

	var baseURL *string
	if effective.baseURL != "" {
		value := effective.baseURL
		baseURL = &value
	}

	return modelServiceSettingsPublic{
		Source:      source,
		Enabled:     effective.enabled,
		BaseURL:     baseURL,
		TimeoutMs:   effective.timeoutMs,
		MaxRetries:  effective.maxRetries,
		HasToken:    effective.internalToken != "",
		TokenSource: state,
	}
}

// getModelServiceSettings serves GET /api/system-settings/model-service through
// the original 30 second best-effort cache contract (no strong global
// consistency claim).
func (s *Service) getModelServiceSettings(ctx context.Context) (modelServiceSettingsPublic, error) {
	record, err := s.readModelServiceRecordCached(ctx)
	if err != nil {
		return modelServiceSettingsPublic{}, err
	}
	return s.buildModelServicePublic(record), nil
}

// updateModelServiceSettings serves PUT /api/system-settings/model-service.
//
// MA1: the platform admin gate runs first. MA3: the token-retention baseline is
// the authoritative row read inside the global model service lock.
func (s *Service) updateModelServiceSettings(
	ctx context.Context,
	orgID string,
	actorID string,
	request updateModelServiceSettingsRequest,
) (modelServiceSettingsPublic, error) {
	if err := s.assertPlatformAdmin(ctx, actorID); err != nil {
		return modelServiceSettingsPublic{}, err
	}

	var result modelServiceSettingsPublic
	err := s.withSessionLock(ctx, lockNameModelService, func(lockCtx context.Context) error {
		record, err := s.readModelServiceRecordAuthoritative(lockCtx)
		if err != nil {
			return err
		}

		baseURL, err := normalizeBaseURLInput(request.BaseURL)
		if err != nil {
			return err
		}

		nextToken, err := s.resolveNextToken(lockCtx, record, request.InternalToken)
		if err != nil {
			return err
		}

		next := modelServiceSettingsWrite{
			Enabled:       request.Enabled,
			BaseURL:       baseURL,
			InternalToken: nextToken,
			TimeoutMs:     request.TimeoutMs,
			MaxRetries:    request.MaxRetries,
		}

		nextRecord, err := modelServiceRecordFromWrite(next)
		if err != nil {
			return err
		}
		effective := s.resolveEffectiveConfig(nextRecord)
		if effective.enabled {
			// baseUrl is reported before internalToken when both are missing.
			if effective.baseURL == "" {
				return &httpError{status: 400, message: "baseUrl is required when model service is enabled"}
			}
			if effective.internalToken == "" {
				return &httpError{status: 400, message: "internalToken is required when model service is enabled"}
			}
		}

		payload, err := json.Marshal(next)
		if err != nil {
			return err
		}
		if err := s.persistSetting(lockCtx, settingKeyModelService, payload, descriptionModelService, nullableActorID(actorID)); err != nil {
			return err
		}

		metadata, err := json.Marshal(modelServiceUpdateAudit{
			Enabled:         next.Enabled,
			BaseURL:         next.BaseURL,
			TimeoutMs:       next.TimeoutMs,
			MaxRetries:      next.MaxRetries,
			TokenUpdated:    request.InternalToken.Kind != optionalStringAbsent,
			TokenConfigured: effective.internalToken != "",
		})
		if err != nil {
			return err
		}
		if err := s.writeAuditLogBestEffort(lockCtx, orgID, actorID, actionModelServiceUpdate, metadata); err != nil {
			return err
		}

		s.invalidateCache(lockCtx, cacheKeyModelService)
		// The response is projected from the bytes just written, never from the
		// pre-write cache entry.
		result = s.buildModelServicePublic(nextRecord)
		return nil
	})
	if err != nil {
		return modelServiceSettingsPublic{}, err
	}
	return result, nil
}

// resetModelServiceSettings serves DELETE /api/system-settings/model-service.
//
// MA1: the platform admin gate runs first. MA3: reset takes the same global lock
// as PUT so a reset cannot interleave with a token-preserving update.
func (s *Service) resetModelServiceSettings(
	ctx context.Context,
	orgID string,
	actorID string,
) (modelServiceSettingsPublic, error) {
	if err := s.assertPlatformAdmin(ctx, actorID); err != nil {
		return modelServiceSettingsPublic{}, err
	}

	var result modelServiceSettingsPublic
	err := s.withSessionLock(ctx, lockNameModelService, func(lockCtx context.Context) error {
		if err := s.removeSetting(lockCtx, settingKeyModelService); err != nil {
			return err
		}
		metadata, err := json.Marshal(okAudit{OK: true})
		if err != nil {
			return err
		}
		if err := s.writeAuditLogBestEffort(lockCtx, orgID, actorID, actionModelServiceReset, metadata); err != nil {
			return err
		}
		s.invalidateCache(lockCtx, cacheKeyModelService)
		// No row remains, so the effective configuration is the env default.
		result = s.buildModelServicePublic(modelServiceRecord{})
		return nil
	})
	if err != nil {
		return modelServiceSettingsPublic{}, err
	}
	return result, nil
}

// resolveNextToken mirrors ModelServiceSettingsService.resolveNextToken.
//
// An ABSENT internalToken keeps the stored raw value (whatever shape it has),
// an explicit null or a blank string clears it, and a non-blank string is encoded
// through the shared fail-closed encryption policy.
func (s *Service) resolveNextToken(
	ctx context.Context,
	record modelServiceRecord,
	next optionalString,
) (secretValue, error) {
	if next.Kind == optionalStringAbsent {
		if !jsonPresent(record.payload.InternalToken) {
			return secretValueNull(), nil
		}
		return secretValueFromRaw(record.payload.InternalToken), nil
	}
	normalized := ""
	if next.Kind == optionalStringValue {
		normalized = jsTrimSpace(next.Value)
	}
	if normalized == "" {
		return secretValueNull(), nil
	}
	return s.encodeSecretForStorage(ctx, normalized)
}

// normalizeBaseURLInput mirrors the baseUrl normalisation of the PUT handler:
// a string is trimmed, an omitted or null value becomes null, and a non-blank
// string must normalise as an http(s) URL.
func normalizeBaseURLInput(input optionalString) (*string, error) {
	if input.Kind != optionalStringValue {
		return nil, nil
	}
	trimmed := jsTrimSpace(input.Value)
	if trimmed == "" {
		return nil, nil
	}
	normalized, err := normalizeHTTPURL(trimmed)
	if err != nil {
		return nil, err
	}
	return &normalized, nil
}

// modelServiceRecordFromWrite round-trips a write snapshot through the stored
// decoder so the response projection and the persisted bytes cannot drift.
func modelServiceRecordFromWrite(next modelServiceSettingsWrite) (modelServiceRecord, error) {
	raw, err := json.Marshal(next)
	if err != nil {
		return modelServiceRecord{}, err
	}
	return decodeModelServiceRecord(raw)
}
