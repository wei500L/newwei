package platformgovernance

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
)

// SecuritySettingsResponse is the GET /api/system-settings/security body. The
// field order is the one Express res.json produces for the NestJS object
// literal.
type SecuritySettingsResponse struct {
	SecretEncryptionEnabled bool      `json:"secretEncryptionEnabled"`
	SecretEncryptionActive  bool      `json:"secretEncryptionActive"`
	MfaPolicy               MfaPolicy `json:"mfaPolicy"`
	EncryptionKeyPresent    bool      `json:"encryptionKeyPresent"`
	EncryptionKeyValid      bool      `json:"encryptionKeyValid"`
	EncryptionKeyError      *string   `json:"encryptionKeyError"`
}

// securityStoredSettings is the SystemSetting.value shape for key
// "system_security". Either field may be absent or hold a non-matching type.
type securityStoredSettings struct {
	SecretEncryptionEnabled optionalBool   `json:"secretEncryptionEnabled"`
	MfaPolicy               optionalString `json:"mfaPolicy"`
}

// securityStoredValue is the value written to SystemSetting.value; the field
// order matches the NestJS object literal.
type securityStoredValue struct {
	SecretEncryptionEnabled bool      `json:"secretEncryptionEnabled"`
	MfaPolicy               MfaPolicy `json:"mfaPolicy"`
}

// securityUpdateMetadata is the AuditLog metadata document for
// "system_security_update".
type securityUpdateMetadata struct {
	SecretEncryptionEnabled bool      `json:"secretEncryptionEnabled"`
	MfaPolicy               MfaPolicy `json:"mfaPolicy"`
	EncryptionKeyPresent    bool      `json:"encryptionKeyPresent"`
	EncryptionKeyValid      bool      `json:"encryptionKeyValid"`
}

// encryptionKeyStatus is the resolved SYSTEM_SETTINGS_ENCRYPTION_KEY state.
type encryptionKeyStatus struct {
	// present reports that the variable was set to a non-empty string.
	present bool
	// valid reports that the value decoded to exactly 32 key bytes.
	valid bool
	// key is the decoded AES-256 key when valid.
	key []byte
	// errText is the decode error message NestJS would surface, empty when the
	// value is absent or valid.
	errText string
}

// loadStoredSecurity reads the system_security row through the Redis cache,
// mirroring SystemSecuritySettingsService.loadStoredSettings.
func (s *Service) loadStoredSecurity(ctx context.Context) (securityStoredSettings, bool, error) {
	raw, present, err := s.loadStoredWithCache(ctx, settingKeySecurity, cacheKeySecurity, cacheTTLSecondsSecurity)
	if err != nil || !present {
		return securityStoredSettings{}, present, err
	}
	var stored securityStoredSettings
	// An object-like but non-object value (a stored array) yields nil bytes with
	// present=true: every named field stays at its zero value.
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &stored); err != nil {
			return securityStoredSettings{}, false, err
		}
	}
	return stored, true, nil
}

// securitySettings computes the GET /security response from the stored row and
// the environment key status.
func (s *Service) securitySettings(ctx context.Context) (SecuritySettingsResponse, error) {
	stored, present, err := s.loadStoredSecurity(ctx)
	if err != nil {
		return SecuritySettingsResponse{}, err
	}
	keyStatus := s.encryptionKeyStatus()

	// configured is null unless the stored flag is a real boolean.
	configured := present && stored.SecretEncryptionEnabled.present
	configuredValue := stored.SecretEncryptionEnabled.value

	mfaPolicy := MfaPolicyOff
	if present && stored.MfaPolicy.present {
		switch candidate := MfaPolicy(stored.MfaPolicy.value); candidate {
		case MfaPolicyOff, MfaPolicyAdminsOnly, MfaPolicyAllUsers:
			mfaPolicy = candidate
		}
	}

	var keyError *string
	if keyStatus.errText != "" {
		text := keyStatus.errText
		keyError = &text
	}

	return SecuritySettingsResponse{
		// configured === true
		SecretEncryptionEnabled: configured && configuredValue,
		// keyValid && configured !== false
		SecretEncryptionActive: keyStatus.valid && !(configured && !configuredValue),
		MfaPolicy:              mfaPolicy,
		EncryptionKeyPresent:   keyStatus.present,
		EncryptionKeyValid:     keyStatus.valid,
		EncryptionKeyError:     keyError,
	}, nil
}

// updateSecuritySettings performs the PUT /security flow: platform gate already
// applied by the handler, then the key guard, the upsert, the best-effort audit
// row, both cache invalidations and a fresh read.
func (s *Service) updateSecuritySettings(ctx context.Context, orgID, actorID string, input securityUpdateInput) (SecuritySettingsResponse, error) {
	keyStatus := s.encryptionKeyStatus()
	if input.SecretEncryptionEnabled && !keyStatus.valid {
		details := ""
		if keyStatus.errText != "" {
			details = " (" + keyStatus.errText + ")"
		}
		return SecuritySettingsResponse{}, badRequest(
			"SYSTEM_SETTINGS_ENCRYPTION_KEY is required to enable secret encryption" + details)
	}

	value, err := json.Marshal(securityStoredValue{
		SecretEncryptionEnabled: input.SecretEncryptionEnabled,
		MfaPolicy:               input.MfaPolicy,
	})
	if err != nil {
		return SecuritySettingsResponse{}, err
	}
	if err := s.upsertSetting(ctx, settingKeySecurity, value, 0, descriptionSecurity, nullableActorID(actorID)); err != nil {
		return SecuritySettingsResponse{}, err
	}

	metadata, err := json.Marshal(securityUpdateMetadata{
		SecretEncryptionEnabled: input.SecretEncryptionEnabled,
		MfaPolicy:               input.MfaPolicy,
		EncryptionKeyPresent:    keyStatus.present,
		EncryptionKeyValid:      keyStatus.valid,
	})
	if err != nil {
		return SecuritySettingsResponse{}, err
	}
	s.writeAuditLogBestEffort(ctx, orgID, actorID, "system_security_update", metadata)

	s.invalidateStoredCache(ctx, cacheKeySecurity)
	// The MFA policy is cached separately by AuthSecurityService; leaving it
	// behind would keep the old platform policy for up to 60 seconds.
	if err := s.cacheDel(ctx, authSecurityCacheKey); err != nil {
		logCacheFailure("delete", authSecurityCacheKey, err)
	}
	return s.securitySettings(ctx)
}

// encryptionKeyStatus resolves SYSTEM_SETTINGS_ENCRYPTION_KEY the way
// SystemSecuritySettingsService.resolveEnvKeyStatus does.
func (s *Service) encryptionKeyStatus() encryptionKeyStatus {
	raw := s.env.EncryptionKeyRaw
	if raw == "" {
		// Unset and empty are indistinguishable at the environment level and
		// both mean "no key configured".
		return encryptionKeyStatus{}
	}
	key, errText := resolveEncryptionKey(raw)
	if errText != "" {
		return encryptionKeyStatus{present: true, errText: errText}
	}
	return encryptionKeyStatus{present: true, valid: true, key: key}
}

// resolveEncryptionKey mirrors decodeSystemSettingsKey in
// apps/api/src/modules/storage/storage-settings.crypto.ts, including the
// lenient Node Buffer.from(s, "base64") decoding rules.
func resolveEncryptionKey(raw string) ([]byte, string) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, "SYSTEM_SETTINGS_ENCRYPTION_KEY is empty"
	}

	hexCandidate := trimmed
	if len(hexCandidate) >= 2 && hexCandidate[0] == '0' && (hexCandidate[1] == 'x' || hexCandidate[1] == 'X') {
		hexCandidate = hexCandidate[2:]
	}
	if len(hexCandidate) == 64 && isHexString(hexCandidate) {
		if decoded, err := hex.DecodeString(hexCandidate); err == nil {
			return decoded, ""
		}
	}

	if decoded, ok := decodeLenientBase64(trimmed); ok && len(decoded) == 32 {
		return decoded, ""
	}
	return nil, "SYSTEM_SETTINGS_ENCRYPTION_KEY must be 32 bytes (base64) or 64 hex chars"
}

// isHexString reports whether value consists of one or more hex digits.
func isHexString(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'f', r >= 'A' && r <= 'F':
		default:
			return false
		}
	}
	return true
}

// decodeLenientBase64 mirrors Node's Buffer.from(s, "base64") leniency:
//
//  1. everything from the first '=' on is ignored;
//  2. only [A-Za-z0-9+/-_] characters are kept, with '-' mapped to '+' and '_'
//     mapped to '/';
//  3. a trailing character that would leave a remainder of 1 is dropped;
//  4. the remainder is decoded as unpadded standard base64.
func decodeLenientBase64(value string) ([]byte, bool) {
	if idx := strings.IndexByte(value, '='); idx >= 0 {
		value = value[:idx]
	}
	var builder strings.Builder
	builder.Grow(len(value))
	for _, r := range value {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '+', r == '/':
			builder.WriteRune(r)
		case r == '-':
			builder.WriteByte('+')
		case r == '_':
			builder.WriteByte('/')
		}
	}
	filtered := builder.String()
	if len(filtered)%4 == 1 {
		filtered = filtered[:len(filtered)-1]
	}
	if filtered == "" {
		return nil, false
	}
	decoded, err := base64.RawStdEncoding.DecodeString(filtered)
	if err != nil {
		return nil, false
	}
	return decoded, true
}
