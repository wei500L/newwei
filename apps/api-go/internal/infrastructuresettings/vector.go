package infrastructuresettings

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// vectorPublicSettings is the public vector-service settings model. Every field
// is always present; baseUrl is rendered as JSON null when unset.
type vectorPublicSettings struct {
	Source          string  `json:"source"`
	Enabled         bool    `json:"enabled"`
	FallbackToMongo bool    `json:"fallbackToMongo"`
	BaseURL         *string `json:"baseUrl"`
	TimeoutMs       int     `json:"timeoutMs"`
	MaxRetries      int     `json:"maxRetries"`
	HasToken        bool    `json:"hasToken"`
	TokenSource     string  `json:"tokenSource"`
}

// vectorEffectiveConfig is the resolved configuration (stored values over
// environment defaults).
type vectorEffectiveConfig struct {
	Enabled         bool
	FallbackToMongo bool
	BaseURL         string
	Token           string
	TimeoutMs       int
	MaxRetries      int
}

// vectorStoredWrite is the exact document written to the SystemSetting column.
// The member order matches the NestJS object literal.
type vectorStoredWrite struct {
	Enabled         bool            `json:"enabled"`
	FallbackToMongo bool            `json:"fallbackToMongo"`
	BaseURL         *string         `json:"baseUrl"`
	Token           json.RawMessage `json:"token"`
	TimeoutMs       int             `json:"timeoutMs"`
	MaxRetries      int             `json:"maxRetries"`
}

// getVectorPublicSettings mirrors getPublicSettings.
func (s *Service) getVectorPublicSettings(ctx context.Context) (vectorPublicSettings, error) {
	stored, err := s.loadVectorSettings(ctx)
	if err != nil {
		return vectorPublicSettings{}, err
	}
	return s.vectorPublic(stored), nil
}

// vectorPublic builds the public model from the stored row and the resolved
// configuration (source and tokenSource are derived independently, exactly like
// the NestJS service).
func (s *Service) vectorPublic(stored *vectorStoredSettings) vectorPublicSettings {
	effective := s.resolveVectorEffective(stored)

	storedToken := ""
	if stored != nil {
		storedToken, _ = s.resolveVectorToken(stored.Token)
	}
	source := SettingSourceEnv
	if stored != nil {
		source = SettingSourceDB
	}
	tokenSource := VectorTokenSourceNone
	switch {
	case storedToken != "":
		tokenSource = VectorTokenSourceStored
	case effective.Token != "":
		tokenSource = VectorTokenSourceEnv
	}

	var baseURL *string
	if effective.BaseURL != "" {
		value := effective.BaseURL
		baseURL = &value
	}
	return vectorPublicSettings{
		Source:          string(source),
		Enabled:         effective.Enabled,
		FallbackToMongo: effective.FallbackToMongo,
		BaseURL:         baseURL,
		TimeoutMs:       effective.TimeoutMs,
		MaxRetries:      effective.MaxRetries,
		HasToken:        effective.Token != "",
		TokenSource:     string(tokenSource),
	}
}

// resolveVectorEffective mirrors resolveEffectiveConfig. Stored booleans only
// win when they really are booleans, and the stored token only wins when it
// resolves to a non-empty string.
func (s *Service) resolveVectorEffective(stored *vectorStoredSettings) vectorEffectiveConfig {
	effective := vectorEffectiveConfig{
		Enabled:         s.cfg.VectorEnabled,
		FallbackToMongo: s.cfg.VectorFallbackToMongo,
		BaseURL:         strings.TrimSpace(s.cfg.VectorBaseURL),
		Token:           s.cfg.VectorToken,
		TimeoutMs:       s.cfg.VectorTimeoutMs,
		MaxRetries:      s.cfg.VectorMaxRetries,
	}
	if stored == nil {
		return effective
	}
	if value, ok := storedBoolean(stored.Enabled); ok {
		effective.Enabled = value
	}
	if value, ok := storedBoolean(stored.FallbackToMongo); ok {
		effective.FallbackToMongo = value
	}
	if value, ok := storedTrimmedString(stored.BaseURL); ok {
		effective.BaseURL = value
	}
	if token, ok := s.resolveVectorToken(stored.Token); ok {
		effective.Token = token
	}
	effective.TimeoutMs = asPositiveInt(stored.TimeoutMs, effective.TimeoutMs)
	effective.MaxRetries = asNonNegativeInt(stored.MaxRetries, effective.MaxRetries)
	return effective
}

// resolveVectorToken mirrors resolveToken: a decryption failure (or a missing
// key) falls back to the environment token without surfacing a public flag.
func (s *Service) resolveVectorToken(raw json.RawMessage) (string, bool) {
	value := parseStoredSecretValue(raw)
	switch value.kind {
	case secretPlaintext:
		trimmed := strings.TrimSpace(value.plaintext)
		return trimmed, trimmed != ""
	case secretEncrypted:
		key := s.settingsKey()
		if key == nil {
			logBackground("missing SYSTEM_SETTINGS_ENCRYPTION_KEY for vector service token", nil)
			return "", false
		}
		plain, err := decryptStringValueV1(value.encrypted, key)
		if err != nil {
			logBackground("failed to decrypt vector service token", err)
			return "", false
		}
		trimmed := strings.TrimSpace(plain)
		return trimmed, trimmed != ""
	default:
		return "", false
	}
}

// updateVectorSettings mirrors updateSettings. The whole read-modify-write runs
// under the global vector lock and reads the row from MySQL: when the request
// omits `token`, the row — not the 30 second Redis cache — is the merge base.
func (s *Service) updateVectorSettings(ctx context.Context, orgID, actorID string, input vectorSettingsRequest) (vectorPublicSettings, error) {
	err := s.withSessionLock(ctx, lockVectorService, func(lockCtx context.Context) error {
		stored, err := s.loadVectorSettingsFromDB(lockCtx)
		if err != nil {
			return err
		}

		normalizedBaseURL, err := normalizeVectorBaseURL(input.BaseURLRaw)
		if err != nil {
			return err
		}
		nextToken, err := s.resolveNextVectorToken(lockCtx, stored, input.TokenRaw)
		if err != nil {
			return err
		}

		next := &vectorStoredSettings{
			Enabled:         boolRaw(input.Enabled),
			FallbackToMongo: boolRaw(input.FallbackToMongo),
			BaseURL:         stringRaw(normalizedBaseURL),
			Token:           nextToken,
			TimeoutMs:       numberRaw(input.TimeoutMs),
			MaxRetries:      numberRaw(input.MaxRetries),
		}
		effective := s.resolveVectorEffective(next)
		if effective.Enabled {
			if effective.BaseURL == "" {
				return &httpError{status: http.StatusBadRequest, message: "baseUrl is required when vector service is enabled"}
			}
			if effective.Token == "" {
				return &httpError{status: http.StatusBadRequest, message: "token is required when vector service is enabled"}
			}
		}

		value, err := json.Marshal(vectorStoredWrite{
			Enabled:         effective.Enabled,
			FallbackToMongo: effective.FallbackToMongo,
			BaseURL:         normalizedBaseURL,
			Token:           nextToken,
			TimeoutMs:       input.TimeoutMs,
			MaxRetries:      input.MaxRetries,
		})
		if err != nil {
			return err
		}
		if err := s.upsertSettingForceDescription(lockCtx, settingKeyVectorService, value,
			descriptionVectorService, false, nullableActorID(actorID)); err != nil {
			return err
		}

		metadata, err := json.Marshal(vectorAuditMetadata{
			Enabled:         input.Enabled,
			FallbackToMongo: input.FallbackToMongo,
			BaseURL:         normalizedBaseURL,
			TimeoutMs:       input.TimeoutMs,
			MaxRetries:      input.MaxRetries,
			TokenUpdated:    present(input.TokenRaw),
			TokenConfigured: effective.Token != "",
		})
		if err != nil {
			return err
		}
		if err := s.writeAuditLogBestEffort(lockCtx, orgID, actorID, "vector_service_update", metadata); err != nil {
			return err
		}
		if err := s.cacheDel(lockCtx, cacheKeyVectorService); err != nil {
			logBackground("failed to invalidate vector settings cache", err)
		}
		return nil
	})
	if err != nil {
		return vectorPublicSettings{}, err
	}
	return s.getVectorPublicSettings(ctx)
}

// resetVectorSettings mirrors resetToEnv. It shares the lock with the update
// path so a reset and an update can never interleave.
func (s *Service) resetVectorSettings(ctx context.Context, orgID, actorID string) (vectorPublicSettings, error) {
	err := s.withSessionLock(ctx, lockVectorService, func(lockCtx context.Context) error {
		if err := s.deleteSetting(lockCtx, settingKeyVectorService); err != nil {
			return err
		}
		metadata, err := json.Marshal(vectorResetAuditMetadata{OK: true})
		if err != nil {
			return err
		}
		if err := s.writeAuditLogBestEffort(lockCtx, orgID, actorID, "vector_service_reset", metadata); err != nil {
			return err
		}
		if err := s.cacheDel(lockCtx, cacheKeyVectorService); err != nil {
			logBackground("failed to invalidate vector settings cache", err)
		}
		return nil
	})
	if err != nil {
		return vectorPublicSettings{}, err
	}
	return s.getVectorPublicSettings(ctx)
}

// resolveNextVectorToken implements the four-state token contract:
//
//   - absent: keep the stored token (read from the database inside the lock);
//   - null or blank: store JSON null, which lets the environment token apply;
//   - non-empty string: trim and encode with the existing encryption policy.
func (s *Service) resolveNextVectorToken(ctx context.Context, stored *vectorStoredSettings, raw json.RawMessage) (json.RawMessage, error) {
	if !present(raw) {
		if stored != nil && present(stored.Token) {
			return stored.Token, nil
		}
		return json.RawMessage("null"), nil
	}
	if isNull(raw) {
		return json.RawMessage("null"), nil
	}
	text, ok := stringConstraint(&validationErrors{}, raw, "token", false)
	if !ok {
		// The DTO already rejected non-strings; treat anything unexpected as a
		// blank token.
		return json.RawMessage("null"), nil
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return json.RawMessage("null"), nil
	}
	encoded, err := s.encodeSecretForStorage(ctx, trimmed)
	if err != nil {
		if secretErr, ok := err.(*secretError); ok {
			return nil, secretErr.asHTTPError()
		}
		return nil, err
	}
	return encoded.toRawValue()
}

// normalizeVectorBaseURL mirrors the baseUrl branch of updateSettings: absent
// and null both clear the stored value, a non-empty string is trimmed and
// validated as an http(s) URL (Node WHATWG semantics), and one trailing slash
// is removed.
func normalizeVectorBaseURL(raw json.RawMessage) (*string, error) {
	if !present(raw) || isNull(raw) {
		return nil, nil
	}
	text, ok := stringConstraint(&validationErrors{}, raw, "baseUrl", false)
	if !ok {
		return nil, nil
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil, nil
	}
	normalized, err := normalizeVectorURL(trimmed)
	if err != nil {
		return nil, err
	}
	return &normalized, nil
}

// normalizeVectorURL reproduces `new URL(value).toString().replace(/\/$/, "")`
// for the http/https subset: lowercase scheme and host, default port dropped,
// path defaulting to "/", then a single trailing slash removed.
func normalizeVectorURL(value string) (string, error) {
	invalid := &httpError{status: http.StatusBadRequest, message: "baseUrl must be a valid http(s) URL"}
	parsed, err := url.Parse(value)
	if err != nil {
		return "", invalid
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", invalid
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "" {
		return "", invalid
	}
	port := parsed.Port()
	if port != "" {
		// The WHATWG URL parser rejects a port outside [0, 65535] before the
		// value ever reaches toString.
		parsedPort, portErr := strconv.Atoi(port)
		if portErr != nil || parsedPort < 0 || parsedPort > 65535 {
			return "", invalid
		}
		if (scheme == "http" && parsedPort == 80) || (scheme == "https" && parsedPort == 443) {
			port = ""
		}
	}
	authority := host
	if port != "" {
		authority += ":" + port
	}
	if parsed.User != nil {
		authority = parsed.User.String() + "@" + authority
	}
	path := parsed.EscapedPath()
	if path == "" {
		path = "/"
	}
	normalized := scheme + "://" + authority + path
	if parsed.RawQuery != "" {
		normalized += "?" + parsed.RawQuery
	}
	if parsed.Fragment != "" {
		normalized += "#" + parsed.Fragment
	}
	return strings.TrimSuffix(normalized, "/"), nil
}

// storedBoolean returns a stored boolean, or ok=false for any other type.
func storedBoolean(raw json.RawMessage) (bool, bool) {
	trimmed := trimSpace(raw)
	switch string(trimmed) {
	case "true":
		return true, true
	case "false":
		return false, true
	default:
		return false, false
	}
}

// storedTrimmedString returns a trimmed non-empty stored string.
func storedTrimmedString(raw json.RawMessage) (string, bool) {
	text, ok := storedString(raw)
	if !ok {
		return "", false
	}
	trimmed := strings.TrimSpace(text)
	return trimmed, trimmed != ""
}

// storedString returns a stored string as-is.
func storedString(raw json.RawMessage) (string, bool) {
	if len(trimSpace(raw)) == 0 {
		return "", false
	}
	var text string
	if err := json.Unmarshal(trimSpace(raw), &text); err != nil {
		return "", false
	}
	return text, true
}

// asPositiveInt mirrors the reader's `Number(value)` plus finite/>0 plus
// Math.floor; anything else keeps the fallback. Out-of-range magnitudes are
// saturated so a hostile stored value cannot overflow the Go int.
func asPositiveInt(raw json.RawMessage, fallback int) int {
	value, present := jsNumberFromJSON(raw)
	if !present || math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 {
		return fallback
	}
	return saturateInt(jsFloor(value))
}

// asNonNegativeInt mirrors the reader's `Number(value)` plus finite/>=0 plus
// Math.floor.
func asNonNegativeInt(raw json.RawMessage, fallback int) int {
	value, present := jsNumberFromJSON(raw)
	if !present || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
		return fallback
	}
	return saturateInt(jsFloor(value))
}

// saturateInt converts a finite float to int, clamping to the int32 range so a
// stored value cannot overflow.
func saturateInt(value float64) int {
	if value >= math.MaxInt32 {
		return math.MaxInt32
	}
	if value <= math.MinInt32 {
		return math.MinInt32
	}
	return int(value)
}
