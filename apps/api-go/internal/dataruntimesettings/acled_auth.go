package dataruntimesettings

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/rediscache"
)

// This file implements the derived ACLED OAuth access-token state that
// RealtimeSignalsSettingsService maintains on the realtime collection path
// (SystemSetting key realtime_signals_acled_auth_state plus the
// realtime-signals:acled-auth-state cache).
//
// It is mounted behind the hard-coded ACLED API policy (acledAPIEnabled), which
// stays false because Open myACLED has no API access. The resolver, the refresh
// lock, the cooldown, the fallback state and the poll-for-update path therefore
// never execute in production today, but they are a complete port so enabling
// the policy does not require re-deriving NestJS behavior from scratch.
//
// Timestamps are ISO strings with millisecond precision, the token is stored
// through the same secret envelope as every other settings credential, and the
// refresh lock is the same logical key NestJS uses, so a NestJS process and this
// process can never refresh at the same time.

// acledOAuthURL is a variable so an in-package test can point the token request
// at an httptest server; production keeps the constant endpoint.
var acledOAuthURL = "https://acleddata.com/oauth/token"

const (
	acledTokenRefreshWindow = 10 * 60 * 1000
	acledRefreshCooldown    = 5 * 60 * 1000
	acledRefreshLockTTL     = 30 * 1000
	acledRefreshPollDelay   = 250

	acledRefreshLockKey = "realtime-signals:acled-auth-refresh"
)

// acledRefreshMode mirrors AcledAccessTokenRefreshMode.
type acledRefreshMode int

const (
	acledRefreshNone acledRefreshMode = iota
	acledRefreshIfNeeded
	acledRefreshForce
)

// resolvedAcledToken mirrors ResolvedAcledAccessToken. Empty strings stand for
// the NestJS undefined members.
type resolvedAcledToken struct {
	token         string
	source        string
	status        string
	expiresAt     string
	refreshedAt   string
	lastAttemptAt string
	lastError     string
}

// parsedAcledAuthState mirrors ParsedRealtimeSignalsAcledAuthState.
type parsedAcledAuthState struct {
	accessToken   string
	expiresAt     string
	refreshedAt   string
	lastAttemptAt string
	lastError     string
}

func (s *parsedAcledAuthState) empty() bool {
	if s == nil {
		return true
	}
	return s.accessToken == "" && s.expiresAt == "" && s.refreshedAt == "" &&
		s.lastAttemptAt == "" && s.lastError == ""
}

// storedAcledAuthState is the SystemSetting JSON value. Members are raw so a
// wrong stored type degrades to "not set" instead of failing the read, exactly
// like the NestJS unknown-typed interface.
type storedAcledAuthState struct {
	Version       json.RawMessage `json:"version"`
	AccessToken   json.RawMessage `json:"accessToken"`
	ExpiresAt     json.RawMessage `json:"expiresAt"`
	RefreshedAt   json.RawMessage `json:"refreshedAt"`
	LastAttemptAt json.RawMessage `json:"lastAttemptAt"`
	LastError     json.RawMessage `json:"lastError"`
}

// writtenAcledAuthState is the value written to MySQL. The member order matches
// the NestJS object literal; nullable members are written as JSON null because
// NestJS writes them explicitly.
type writtenAcledAuthState struct {
	Version       int             `json:"version"`
	AccessToken   json.RawMessage `json:"accessToken"`
	ExpiresAt     *string         `json:"expiresAt"`
	RefreshedAt   *string         `json:"refreshedAt"`
	LastAttemptAt *string         `json:"lastAttemptAt"`
	LastError     *string         `json:"lastError"`
}

// cachedAcledAuthState is the {exists, value} cache envelope. A cached "no row"
// result is meaningful, so the envelope is required.
type cachedAcledAuthState struct {
	Exists bool                  `json:"exists"`
	Value  *storedAcledAuthState `json:"value,omitempty"`
}

// acledHTTPClient issues the OAuth token request. The caller applies the
// per-attempt timeout through the request context, matching AbortController.
var acledHTTPClient = &http.Client{}

func acledPolicyEnabled() bool { return acledAPIEnabled }

func (s *Service) hasAcledOauthCredentials(effective *effectiveRealtimeSettings) bool {
	return strings.TrimSpace(effective.AcledOauthUsername) != "" &&
		strings.TrimSpace(effective.AcledOauthPassword) != ""
}

// isAcledTokenUsable mirrors isAcledTokenUsable: a missing or unparseable
// expiry is not usable.
func isAcledTokenUsable(expiresAt string) bool {
	if expiresAt == "" {
		return false
	}
	parsed, ok := parseISOTimeMillis(expiresAt)
	return ok && parsed > time.Now().UnixMilli()
}

func isAcledTokenExpiring(expiresAt string) bool {
	if expiresAt == "" {
		return false
	}
	parsed, ok := parseISOTimeMillis(expiresAt)
	return ok && parsed-time.Now().UnixMilli() <= acledTokenRefreshWindow
}

func isAcledRefreshCoolingDown(lastAttemptAt string) bool {
	if lastAttemptAt == "" {
		return false
	}
	parsed, ok := parseISOTimeMillis(lastAttemptAt)
	return ok && time.Now().UnixMilli()-parsed < acledRefreshCooldown
}

// resolveAcledAccessToken mirrors resolveAcledAccessToken, including the
// cooldown that keeps a usable token after a failed background refresh.
func (s *Service) resolveAcledAccessToken(ctx context.Context, effective *effectiveRealtimeSettings, mode acledRefreshMode) (resolvedAcledToken, error) {
	if !acledPolicyEnabled() {
		return resolvedAcledToken{source: "none", status: "missing"}, nil
	}
	state, err := s.loadAcledAuthState(ctx)
	if err != nil {
		return resolvedAcledToken{}, err
	}
	if state == nil {
		state = &parsedAcledAuthState{}
	}
	hasUsableToken := state.accessToken != "" && isAcledTokenUsable(state.expiresAt)
	shouldRefresh := mode == acledRefreshForce ||
		(mode == acledRefreshIfNeeded && (!hasUsableToken || isAcledTokenExpiring(state.expiresAt)))
	coolingDown := mode != acledRefreshForce && state.lastError != "" && hasUsableToken &&
		isAcledRefreshCoolingDown(state.lastAttemptAt)

	if s.hasAcledOauthCredentials(effective) && shouldRefresh && !coolingDown {
		state, err = s.refreshAcledAccessToken(ctx, effective, state, mode == acledRefreshForce)
		if err != nil {
			return resolvedAcledToken{}, err
		}
	}

	if state.accessToken != "" && isAcledTokenUsable(state.expiresAt) {
		status := "ready"
		if isAcledTokenExpiring(state.expiresAt) {
			status = "expiring"
		}
		return resolvedAcledToken{
			token: state.accessToken, source: "stored", status: status,
			expiresAt: state.expiresAt, refreshedAt: state.refreshedAt,
			lastAttemptAt: state.lastAttemptAt, lastError: state.lastError,
		}, nil
	}
	if state.lastError != "" {
		return resolvedAcledToken{
			source: "none", status: "refresh_failed",
			expiresAt: state.expiresAt, refreshedAt: state.refreshedAt,
			lastAttemptAt: state.lastAttemptAt, lastError: state.lastError,
		}, nil
	}
	return resolvedAcledToken{
		source: "none", status: "missing",
		expiresAt: state.expiresAt, refreshedAt: state.refreshedAt, lastAttemptAt: state.lastAttemptAt,
	}, nil
}

// refreshAcledAccessToken mirrors refreshAcledAccessToken. The shared lease
// guarantees one refresher; a loser polls the shared state for the winner's
// write instead of issuing a second token request.
func (s *Service) refreshAcledAccessToken(ctx context.Context, effective *effectiveRealtimeSettings, current *parsedAcledAuthState, force bool) (*parsedAcledAuthState, error) {
	var result *parsedAcledAuthState
	acquired, err := rediscache.WithLock(ctx, s.redis, acledRefreshLockKey, acledRefreshLockTTL*time.Millisecond, func(ctx context.Context) error {
		latest, loadErr := s.loadAcledAuthState(ctx)
		if loadErr != nil {
			return loadErr
		}
		if latest == nil {
			latest = &parsedAcledAuthState{}
		}
		if !force && latest.accessToken != "" && isAcledTokenUsable(latest.expiresAt) && !isAcledTokenExpiring(latest.expiresAt) {
			result = latest
			return nil
		}
		next, requestErr := s.requestAcledAccessToken(ctx, effective)
		if requestErr == nil {
			if persistErr := s.persistAcledAuthState(ctx, next); persistErr != nil {
				return persistErr
			}
			result = next
			return nil
		}
		fallback := acledFallbackState(latest, current)
		fallback.lastAttemptAt = nestTimestamp(time.Now())
		fallback.lastError = acledAuthErrorMessage(requestErr)
		if persistErr := s.persistAcledAuthState(ctx, fallback); persistErr != nil {
			return persistErr
		}
		log.Printf("dataruntimesettings: failed to refresh ACLED access token: %v", requestErr)
		result = fallback
		return nil
	})
	if err != nil {
		return nil, err
	}
	if acquired {
		return result, nil
	}
	return s.waitForAcledAuthStateUpdate(ctx, current), nil
}

// acledFallbackState keeps the newest still-valid token after a failed refresh,
// preferring the state read under the lock over the caller's snapshot.
func acledFallbackState(latest, current *parsedAcledAuthState) *parsedAcledAuthState {
	state := &parsedAcledAuthState{}
	if latest != nil && latest.accessToken != "" && isAcledTokenUsable(latest.expiresAt) {
		state.accessToken = latest.accessToken
		state.expiresAt = latest.expiresAt
		state.refreshedAt = latest.refreshedAt
	} else if current != nil && current.accessToken != "" && isAcledTokenUsable(current.expiresAt) {
		state.accessToken = current.accessToken
		state.expiresAt = current.expiresAt
		state.refreshedAt = current.refreshedAt
	}
	return state
}

// requestAcledAccessToken mirrors requestAcledAccessToken: the password grant,
// the per-attempt timeout, the retry backoff and the exact error strings.
func (s *Service) requestAcledAccessToken(ctx context.Context, effective *effectiveRealtimeSettings) (*parsedAcledAuthState, error) {
	username := strings.TrimSpace(effective.AcledOauthUsername)
	password := strings.TrimSpace(effective.AcledOauthPassword)
	clientID := strings.TrimSpace(effective.AcledOauthClientID)
	if username == "" || password == "" {
		return nil, errors.New("ACLED OAuth credentials are not configured")
	}
	timeout := effective.RequestTimeoutMs
	if timeout < 1000 {
		timeout = 1000
	}
	maxRetries := effective.MaxRetries
	if maxRetries < 0 {
		maxRetries = 0
	}
	body := encodeFormPairs(
		[2]string{"username", username},
		[2]string{"password", password},
		[2]string{"grant_type", "password"},
		[2]string{"client_id", clientID},
	)

	var lastErr error
	for attempt := 0; attempt <= maxRetries; attempt++ {
		state, err := s.requestAcledTokenOnce(ctx, body, timeout)
		if err == nil {
			return state, nil
		}
		lastErr = err
		if attempt < maxRetries {
			sleepContext(ctx, time.Duration(minInt(5000, 300*(attempt+1)))*time.Millisecond)
		}
	}
	if lastErr == nil {
		lastErr = errors.New("ACLED OAuth request failed")
	}
	return nil, lastErr
}

func (s *Service) requestAcledTokenOnce(ctx context.Context, body string, timeoutMs int) (*parsedAcledAuthState, error) {
	requestCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodPost, acledOAuthURL, strings.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("accept", "application/json")
	req.Header.Set("content-type", "application/x-www-form-urlencoded")
	resp, err := acledHTTPClient.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(requestCtx.Err(), context.DeadlineExceeded) {
			// Node's fetch raises a DOMException with this message when the
			// AbortController fires, and that message is persisted as lastError.
			return nil, errors.New("This operation was aborted")
		}
		return nil, err
	}
	defer resp.Body.Close()
	payloadBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var payload struct {
		AccessToken      json.RawMessage `json:"access_token"`
		ExpiresIn        json.RawMessage `json:"expires_in"`
		Message          json.RawMessage `json:"message"`
		Error            json.RawMessage `json:"error"`
		ErrorDescription json.RawMessage `json:"error_description"`
	}
	_ = json.Unmarshal(payloadBytes, &payload)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, errors.New(buildAcledOAuthHTTPErrorMessage(resp.StatusCode, http.StatusText(resp.StatusCode), payload.ErrorDescription, payload.Error, payload.Message))
	}
	accessToken := normalizeStringRaw(payload.AccessToken)
	if accessToken == "" {
		return nil, errors.New("ACLED OAuth response missing access_token")
	}
	expiresInSeconds := 86_400
	if value, ok := toFiniteNumberRaw(payload.ExpiresIn); ok && value > 0 {
		expiresInSeconds = int(value)
	}
	refreshedAt := nestTimestamp(time.Now())
	expiresAt := nestTimestamp(time.Now().Add(time.Duration(expiresInSeconds) * time.Second))
	return &parsedAcledAuthState{
		accessToken: accessToken, expiresAt: expiresAt, refreshedAt: refreshedAt, lastAttemptAt: refreshedAt,
	}, nil
}

// buildAcledOAuthHTTPErrorMessage mirrors buildAcledOAuthHttpErrorMessage.
func buildAcledOAuthHTTPErrorMessage(status int, statusText string, details ...json.RawMessage) string {
	detail := ""
	for _, candidate := range details {
		if text := normalizeStringRaw(candidate); text != "" {
			detail = text
			break
		}
	}
	base := "ACLED OAuth HTTP " + strconv.Itoa(status) + " " + statusText
	if detail != "" {
		return base + ": " + detail
	}
	return base
}

func acledAuthErrorMessage(err error) string {
	if err == nil {
		return "Unknown ACLED OAuth error"
	}
	return err.Error()
}

// loadAcledAuthState reads the cache envelope, then MySQL, and normalizes the
// stored value. An unsupported version is treated as "no state", matching the
// NestJS warning branch.
func (s *Service) loadAcledAuthState(ctx context.Context) (*parsedAcledAuthState, error) {
	record, err := s.loadStoredAcledAuthStateRecord(ctx)
	if err != nil {
		return nil, err
	}
	if record == nil {
		return nil, nil
	}
	version, ok := toFiniteNumberRaw(record.Version)
	if !ok || version != 1 {
		return nil, nil
	}
	state := &parsedAcledAuthState{
		accessToken:   s.resolveStoredSecret(record.AccessToken, "acled oauth access token"),
		expiresAt:     normalizeISO8601(record.ExpiresAt),
		refreshedAt:   normalizeISO8601(record.RefreshedAt),
		lastAttemptAt: normalizeISO8601(record.LastAttemptAt),
		lastError:     normalizeStringRaw(record.LastError),
	}
	if state.empty() {
		return nil, nil
	}
	return state, nil
}

func (s *Service) loadStoredAcledAuthStateRecord(ctx context.Context) (*storedAcledAuthState, error) {
	if cached, found, err := rediscache.GetJSON[cachedAcledAuthState](ctx, s.redis, cacheKeyAcledAuthState); err == nil && found {
		return cached.Value, nil
	}
	raw, found, err := s.loadSettingRaw(ctx, settingKeyAcledAuthState)
	if err != nil {
		return nil, err
	}
	var record *storedAcledAuthState
	if found {
		trimmed := bytes.TrimSpace(raw)
		if len(trimmed) > 0 && trimmed[0] == '{' {
			parsed := &storedAcledAuthState{}
			if json.Unmarshal(trimmed, parsed) == nil {
				record = parsed
			}
		}
	}
	_ = rediscache.SetJSON(ctx, s.redis, cacheKeyAcledAuthState,
		cachedAcledAuthState{Exists: found, Value: record}, acledAuthCacheTTLSeconds*time.Second)
	return record, nil
}

// persistAcledAuthState writes the derived state row and invalidates the cache.
// An empty state deletes the row, matching clearAcledAuthState.
func (s *Service) persistAcledAuthState(ctx context.Context, state *parsedAcledAuthState) error {
	if state.empty() {
		return s.clearAcledAuthState(ctx)
	}
	accessTokenRaw := jsonNullValue
	if state.accessToken != "" {
		encoded, err := s.encodeSecretForStorage(ctx, state.accessToken)
		if err != nil {
			return err
		}
		raw, err := encoded.toRawValue()
		if err != nil {
			return err
		}
		accessTokenRaw = raw
	}
	value := writtenAcledAuthState{
		Version:       1,
		AccessToken:   accessTokenRaw,
		ExpiresAt:     nullableString(state.expiresAt),
		RefreshedAt:   nullableString(state.refreshedAt),
		LastAttemptAt: nullableString(state.lastAttemptAt),
		LastError:     nullableString(state.lastError),
	}
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if s.db == nil {
		return errNoDatabase
	}
	now := nowMillis()
	if _, err := s.db.ExecContext(ctx, upsertRealtimeSQL, settingKeyAcledAuthState, payload,
		descriptionAcledAuthState, now, now); err != nil {
		return err
	}
	return s.invalidateAcledAuthStateCache(ctx)
}

// descriptionAcledAuthState is written on both upsert branches, exactly like the
// NestJS persistAcledAuthState.
const descriptionAcledAuthState = "Derived ACLED OAuth access token state for realtime signals."

func (s *Service) clearAcledAuthState(ctx context.Context) error {
	if s.db != nil {
		if _, err := s.db.ExecContext(ctx, "DELETE FROM SystemSetting WHERE `key` = ?", settingKeyAcledAuthState); err != nil {
			return err
		}
	}
	return s.invalidateAcledAuthStateCache(ctx)
}

func (s *Service) invalidateAcledAuthStateCache(ctx context.Context) error {
	if s.redis == nil {
		return nil
	}
	if err := s.redis.Del(ctx, cacheKeyAcledAuthState).Err(); err != nil && !errors.Is(err, sql.ErrNoRows) {
		log.Printf("dataruntimesettings: failed to invalidate ACLED auth state cache: %v", err)
	}
	return nil
}

// acledAuthStateSignature mirrors acledAuthStateSignature: the poller only needs
// to know whether the shared state changed, never its plaintext.
func acledAuthStateSignature(state *parsedAcledAuthState) string {
	payload := struct {
		HasAccessToken bool    `json:"hasAccessToken"`
		ExpiresAt      *string `json:"expiresAt"`
		RefreshedAt    *string `json:"refreshedAt"`
		LastAttemptAt  *string `json:"lastAttemptAt"`
		LastError      *string `json:"lastError"`
	}{
		HasAccessToken: state != nil && state.accessToken != "",
		ExpiresAt:      nullableString(stateValue(state, func(s *parsedAcledAuthState) string { return s.expiresAt })),
		RefreshedAt:    nullableString(stateValue(state, func(s *parsedAcledAuthState) string { return s.refreshedAt })),
		LastAttemptAt:  nullableString(stateValue(state, func(s *parsedAcledAuthState) string { return s.lastAttemptAt })),
		LastError:      nullableString(stateValue(state, func(s *parsedAcledAuthState) string { return s.lastError })),
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "null"
	}
	return string(encoded)
}

func stateValue(state *parsedAcledAuthState, pick func(*parsedAcledAuthState) string) string {
	if state == nil {
		return ""
	}
	return pick(state)
}

// waitForAcledAuthStateUpdate mirrors waitForAcledAuthStateUpdate: poll until the
// signature changes or the lease TTL plus one second elapses.
func (s *Service) waitForAcledAuthStateUpdate(ctx context.Context, previous *parsedAcledAuthState) *parsedAcledAuthState {
	previousSignature := acledAuthStateSignature(previous)
	deadline := time.Now().Add((acledRefreshLockTTL + 1000) * time.Millisecond)
	for time.Now().Before(deadline) {
		sleepContext(ctx, acledRefreshPollDelay*time.Millisecond)
		next, err := s.loadAcledAuthState(ctx)
		if err != nil {
			continue
		}
		if acledAuthStateSignature(next) != previousSignature {
			return next
		}
	}
	next, err := s.loadAcledAuthState(ctx)
	if err != nil || next == nil {
		return previous
	}
	return next
}

// ---- generic helpers ----

// encodeFormPairs serializes application/x-www-form-urlencoded members in
// insertion order. URLSearchParams preserves insertion order, unlike
// url.Values.Encode which sorts keys, and the ACLED body order is part of the
// request shape the NestJS service sends.
func encodeFormPairs(pairs ...[2]string) string {
	var builder strings.Builder
	for index, pair := range pairs {
		if index > 0 {
			builder.WriteByte('&')
		}
		builder.WriteString(encodeURIComponentStrict(pair[0]))
		builder.WriteByte('=')
		builder.WriteString(encodeURIComponentStrict(pair[1]))
	}
	return builder.String()
}

// encodeURIComponentStrict matches the URLSearchParams serializer: ASCII
// alphanumerics plus *-._ stay literal, a space becomes '+', everything else is
// percent-encoded with uppercase hex.
func encodeURIComponentStrict(value string) string {
	var builder strings.Builder
	for index := 0; index < len(value); index++ {
		ch := value[index]
		switch {
		case ch >= 'A' && ch <= 'Z', ch >= 'a' && ch <= 'z', ch >= '0' && ch <= '9':
			builder.WriteByte(ch)
		case ch == '*', ch == '-', ch == '.', ch == '_':
			builder.WriteByte(ch)
		case ch == ' ':
			builder.WriteByte('+')
		default:
			const hexDigits = "0123456789ABCDEF"
			builder.WriteByte('%')
			builder.WriteByte(hexDigits[ch>>4])
			builder.WriteByte(hexDigits[ch&0x0f])
		}
	}
	return builder.String()
}

// nullableString converts "" into a JSON null pointer.
func nullableString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// normalizeISO8601 mirrors normalizeIsoTimestamp: Date.parse then toISOString,
// or undefined when unparseable.
func normalizeISO8601(raw json.RawMessage) string {
	text := normalizeStringRaw(raw)
	if text == "" {
		return ""
	}
	parsed, ok := parseISOTimeMillis(text)
	if !ok {
		return ""
	}
	return nestTimestamp(time.UnixMilli(parsed))
}

// toFiniteNumberRaw decodes a JSON number (or numeric string) with JavaScript
// Number() semantics.
func toFiniteNumberRaw(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return 0, false
	}
	if trimmed[0] == '"' {
		var text string
		if json.Unmarshal(trimmed, &text) != nil {
			return 0, false
		}
		return parseNumericString(text)
	}
	var number float64
	if json.Unmarshal(trimmed, &number) != nil {
		return 0, false
	}
	return number, true
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func sleepContext(ctx context.Context, duration time.Duration) {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}

// parseISOTimeMillis parses the ISO-8601 timestamps this unit reads back from
// its own writes. Date.parse also accepts many other shapes, but the ACLED state
// row is only ever written by persistAcledAuthState (or by NestJS, which writes
// toISOString), so the ISO layouts are the complete input domain.
func parseISOTimeMillis(value string) (int64, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, false
	}
	for _, layout := range []string{
		time.RFC3339Nano,
		"2006-01-02T15:04:05.999Z0700",
		"2006-01-02T15:04:05",
		"2006-01-02",
	} {
		if parsed, err := time.Parse(layout, trimmed); err == nil {
			return parsed.UnixMilli(), true
		}
	}
	return 0, false
}

// parseNumericString applies JavaScript's Number() coercion to a string: an
// empty or whitespace-only string is 0, "0x" prefixes are hexadecimal, and a
// non-finite result is rejected.
func parseNumericString(value string) (float64, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, true
	}
	if len(trimmed) > 2 && trimmed[0] == '0' && (trimmed[1] == 'x' || trimmed[1] == 'X') {
		parsed, err := strconv.ParseUint(trimmed[2:], 16, 64)
		if err != nil {
			return 0, false
		}
		return float64(parsed), true
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return 0, false
	}
	if parsed != parsed || parsed > 1.7976931348623157e308 || parsed < -1.7976931348623157e308 {
		return 0, false
	}
	return parsed, true
}
