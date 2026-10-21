package situationsettings

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// This file is the Go equivalent of
// apps/api/src/modules/system-settings/situation-monitor-telegram-auth.service.ts.
// It owns the pending-request cache document and the three rate-limit buckets
// (shared with NestJS through the same Redis keys), while the MTProto client
// itself stays behind TelegramAuthClient/TelegramAuthClientFactory so the unit
// tests never touch the network.

const (
	// telegramAuthCacheKeyPrefix + ":{requestId}"; CacheService.set writes one
	// plain JSON.stringify document with an EX of AUTH_REQUEST_TTL_SECONDS.
	telegramAuthCacheKeyPrefix = "situation-monitor:telegram-auth"
	// AUTH_REQUEST_TTL_SECONDS / START_RATE_LIMIT_WINDOW_SECONDS (10 minutes).
	telegramAuthRequestTTLSeconds            = 10 * 60
	telegramAuthStartRateLimitWindowSeconds  = 10 * 60
	telegramAuthStartRateLimitPerUser        = 5
	telegramAuthStartRateLimitPerIP          = 15
	telegramAuthStartRateLimitPerPhone       = 3
	telegramAuthRateLimitEvalTimeout         = 100 * time.Millisecond
	telegramAuthRateLimitCleanupLimit        = 100
	telegramAuthRateLimitCleanupThreshold    = 1000
	telegramAuthStartRateLimitKeyUserPrefix  = "situation-monitor:telegram-auth-start:user:"
	telegramAuthStartRateLimitKeyIPPrefix    = "situation-monitor:telegram-auth-start:ip:"
	telegramAuthStartRateLimitKeyPhonePrefix = "situation-monitor:telegram-auth-start:phone:"
)

// errTelegramAuthRedisUnavailable reports a missing Redis client. The NestJS
// process would fail at startup instead; the handler maps it to the generic 500.
var errTelegramAuthRedisUnavailable = errors.New("situationsettings: redis is not configured")

// telegramAuthPending is the PendingTelegramAuthRequest document. The field
// order is the JSON.stringify order of the NestJS object literal, which matters
// because both implementations share the cache entries byte-for-byte.
type telegramAuthPending struct {
	RequestID       string `json:"requestId"`
	OrgID           string `json:"orgId"`
	ActorID         string `json:"actorId"`
	TelegramAPIID   string `json:"telegramApiId"`
	TelegramAPIHash string `json:"telegramApiHash"`
	PhoneNumber     string `json:"phoneNumber"`
	PhoneCodeHash   string `json:"phoneCodeHash"`
	Session         string `json:"session"`
	CreatedAt       string `json:"createdAt"`
}

// telegramAuthStartResult is the startAuth response body
// ({requestId, isCodeViaApp, expiresAt}).
type telegramAuthStartResult struct {
	RequestID    string `json:"requestId"`
	IsCodeViaApp bool   `json:"isCodeViaApp"`
	ExpiresAt    string `json:"expiresAt"`
}

// telegramAuthCompletedSession is the CompletedTelegramAuthSession the
// controller writes into the settings row.
type telegramAuthCompletedSession struct {
	TelegramAPIID   string
	TelegramAPIHash string
	TelegramSession string
}

// telegramAuthSettings is the Service subset the login flow needs. It keeps the
// handler unit tests free of MySQL while production passes the concrete
// *Service.
type telegramAuthSettings interface {
	EffectiveSettings(ctx context.Context) (EffectiveSettings, error)
	Update(ctx context.Context, orgID, actorID string, input UpdateInput) (PublicSettings, error)
}

// telegramAuthStore is the CacheService.get/set/del subset used for pending
// login requests. Payloads stay []byte so the service owns the exact
// JSON.stringify bytes and a fake store can assert them without Redis.
type telegramAuthStore interface {
	Load(ctx context.Context, key string) (payload []byte, found bool, err error)
	Save(ctx context.Context, key string, payload []byte, ttl time.Duration) error
	Delete(ctx context.Context, key string) error
}

// telegramAuthRateLimiter is RateLimiterService.consume(key, limit,
// windowSeconds). Keys are passed WITHOUT the "rate:" prefix; the Redis
// adapter adds it exactly like NestJS.
type telegramAuthRateLimiter interface {
	Consume(ctx context.Context, key string, limit, windowSeconds int) (bool, error)
}

// telegramAuthServiceOptions collects the collaborators; Now/NewRequestID are
// test seams (NestJS uses Date.now()/randomUUID()).
type telegramAuthServiceOptions struct {
	Settings     telegramAuthSettings
	Telegram     TelegramAuthClientFactory
	Store        telegramAuthStore
	Limiter      telegramAuthRateLimiter
	Now          func() time.Time
	NewRequestID func() (string, error)
}

type telegramAuthService struct {
	settings     telegramAuthSettings
	telegram     TelegramAuthClientFactory
	store        telegramAuthStore
	limiter      telegramAuthRateLimiter
	now          func() time.Time
	newRequestID func() (string, error)
}

// newTelegramAuthService wires the login flow.
func newTelegramAuthService(options telegramAuthServiceOptions) *telegramAuthService {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	newRequestID := options.NewRequestID
	if newRequestID == nil {
		newRequestID = newTelegramAuthRequestID
	}
	return &telegramAuthService{
		settings:     options.Settings,
		telegram:     options.Telegram,
		store:        options.Store,
		limiter:      options.Limiter,
		now:          now,
		newRequestID: newRequestID,
	}
}

// ---- startAuth ----

// startAuth mirrors startAuth: resolve credentials, validate the phone number,
// consume the three rate-limit buckets BEFORE talking to Telegram, send the code,
// cache the pending request (600s) and return the request descriptor.
func (s *telegramAuthService) startAuth(ctx context.Context, orgID, actorID string, input StartTelegramAuthInput, clientIP string) (telegramAuthStartResult, error) {
	credentials, err := s.resolveStartCredentials(ctx, input)
	if err != nil {
		return telegramAuthStartResult{}, err
	}
	phoneNumber, err := normalizeTelegramAuthPhoneNumber(input.PhoneNumber)
	if err != nil {
		return telegramAuthStartResult{}, err
	}
	// Rate limiting happens before any MTProto call (NestJS line order).
	if err := s.enforceStartRateLimit(ctx, orgID, actorID, phoneNumber, clientIP); err != nil {
		return telegramAuthStartResult{}, err
	}

	client, err := s.telegram.NewTemporary(ctx, credentials.apiID, credentials.apiHash, "")
	if err != nil {
		return telegramAuthStartResult{}, toTelegramAuthBadRequest(err)
	}
	defer client.Close()

	sentCode, err := client.SendCode(ctx, phoneNumber)
	if err != nil {
		return telegramAuthStartResult{}, toTelegramAuthBadRequest(err)
	}

	session, err := client.ExportStringSession()
	if err != nil {
		return telegramAuthStartResult{}, toTelegramAuthBadRequest(err)
	}

	requestID, err := s.newRequestID()
	if err != nil {
		// randomUUID() sits inside startAuth's try block, so a failure is
		// flattened to TELEGRAM_AUTH_FAILED by toBadRequest.
		return telegramAuthStartResult{}, toTelegramAuthBadRequest(err)
	}

	now := s.now()
	pending := telegramAuthPending{
		RequestID:       requestID,
		OrgID:           orgID,
		ActorID:         actorID,
		TelegramAPIID:   credentials.apiIDString,
		TelegramAPIHash: credentials.apiHash,
		PhoneNumber:     phoneNumber,
		PhoneCodeHash:   sentCode.PhoneCodeHash,
		Session:         session,
		CreatedAt:       telegramAuthISOTime(now),
	}
	payload, err := marshalTelegramAuthPending(pending)
	if err != nil {
		return telegramAuthStartResult{}, toTelegramAuthBadRequest(err)
	}
	if err := s.store.Save(ctx, telegramAuthCacheKey(requestID), payload, telegramAuthRequestTTLSeconds*time.Second); err != nil {
		// cache.set is inside startAuth's try/catch in NestJS, so a Redis
		// failure surfaces as TELEGRAM_AUTH_FAILED (not as a 500).
		return telegramAuthStartResult{}, toTelegramAuthBadRequest(err)
	}

	return telegramAuthStartResult{
		RequestID:    requestID,
		IsCodeViaApp: sentCode.CodeViaApp,
		ExpiresAt:    telegramAuthISOTime(now.Add(telegramAuthRequestTTLSeconds * time.Second)),
	}, nil
}

// telegramAuthCredentials is the resolved (apiId, apiHash) pair.
type telegramAuthCredentials struct {
	apiIDString string
	apiID       int
	apiHash     string
}

// resolveStartCredentials mirrors resolveStartCredentials: the request body
// wins over the effective stored settings, both sides are trimmed, a digital
// api id is normalized through String(Math.trunc(Number(...))), and a missing
// pair is TELEGRAM_AUTH_API_CREDENTIALS_REQUIRED.
func (s *telegramAuthService) resolveStartCredentials(ctx context.Context, input StartTelegramAuthInput) (telegramAuthCredentials, error) {
	effective, err := s.settings.EffectiveSettings(ctx)
	if err != nil {
		return telegramAuthCredentials{}, err
	}

	inputAPIID := ""
	if input.TelegramAPIID.state == presenceValue {
		inputAPIID = input.TelegramAPIID.value
	}
	inputAPIIDString, inputAPIIDValue, err := normalizeTelegramAuthAPIIDIfProvided(inputAPIID)
	if err != nil {
		return telegramAuthCredentials{}, err
	}
	inputAPIHash := ""
	if input.TelegramAPIHash.state == presenceValue {
		inputAPIHash = input.TelegramAPIHash.value
	}
	inputAPIHash = normalizeTelegramAuthOptionalString(inputAPIHash)

	storedAPIIDString, storedAPIIDValue, err := normalizeTelegramAuthAPIIDIfProvided(effective.TelegramAPIID)
	if err != nil {
		return telegramAuthCredentials{}, err
	}
	storedAPIHash := normalizeTelegramAuthOptionalString(effective.TelegramAPIHash)

	telegramAPIIDString := inputAPIIDString
	telegramAPIIDValue := inputAPIIDValue
	if telegramAPIIDString == "" {
		telegramAPIIDString = storedAPIIDString
		telegramAPIIDValue = storedAPIIDValue
	}
	telegramAPIHash := inputAPIHash
	if telegramAPIHash == "" {
		telegramAPIHash = storedAPIHash
	}

	if telegramAPIIDString == "" || telegramAPIHash == "" {
		return telegramAuthCredentials{}, telegramAuthBadRequest(telegramAuthCodeAPICredentialsNeeded)
	}
	return telegramAuthCredentials{
		apiIDString: telegramAPIIDString,
		apiID:       telegramAPIIDValue,
		apiHash:     telegramAPIHash,
	}, nil
}

// normalizeTelegramAuthAPIIDIfProvided mirrors normalizeApiIdIfProvided: an
// absent/blank value yields ("", 0, nil); a non-digital, non-finite or
// non-positive value is TELEGRAM_AUTH_API_ID_INVALID; otherwise the value is
// String(Math.trunc(Number(value))).
//
// Every value that fits in an int64 is below 1e21, where JavaScript prints the
// plain decimal form that strconv.FormatFloat('f', -1) also produces (leading
// zeros dropped). Larger digit strings never reach Telegram in the NestJS
// version either: the RPC answers API_ID_INVALID, which maps to the same code.
func normalizeTelegramAuthAPIIDIfProvided(value string) (string, int, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", 0, nil
	}
	if !telegramAuthIsDigits(trimmed) {
		return "", 0, telegramAuthBadRequest(telegramAuthCodeAPIIDInvalid)
	}
	parsed, parseErr := strconv.ParseFloat(trimmed, 64)
	if parseErr != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed <= 0 {
		return "", 0, telegramAuthBadRequest(telegramAuthCodeAPIIDInvalid)
	}
	truncated := math.Trunc(parsed)
	if truncated >= float64(math.MaxInt64) {
		return "", 0, telegramAuthBadRequest(telegramAuthCodeAPIIDInvalid)
	}
	return strconv.FormatFloat(truncated, 'f', -1, 64), int(truncated), nil
}

// telegramAuthIsDigits mirrors /^\d+$/.
func telegramAuthIsDigits(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// normalizeTelegramAuthPhoneNumber mirrors normalizePhoneNumber.
func normalizeTelegramAuthPhoneNumber(value string) (string, error) {
	phoneNumber, ok := normalizeTelegramAuthString(value)
	if !ok {
		return "", telegramAuthBadRequestWithDetail(telegramAuthCodeInvalidInput, "phoneNumber is required")
	}
	if !telegramAuthE164PhonePattern.MatchString(phoneNumber) {
		return "", telegramAuthBadRequest(telegramAuthCodePhoneFormatInvalid)
	}
	return phoneNumber, nil
}

// requireTelegramAuthValue mirrors requireValue: trim, reject empty, otherwise
// TELEGRAM_AUTH_INVALID_INPUT with `{field} is required` in detail.
func requireTelegramAuthValue(value, fieldName string) (string, error) {
	normalized, ok := normalizeTelegramAuthString(value)
	if !ok {
		return "", telegramAuthBadRequestWithDetail(telegramAuthCodeInvalidInput, fieldName+" is required")
	}
	return normalized, nil
}

// normalizeTelegramAuthString mirrors normalizeString: trim; empty is undefined.
func normalizeTelegramAuthString(value string) (string, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", false
	}
	return trimmed, true
}

// normalizeTelegramAuthOptionalString is normalizeString for a value that is
// known to be a string; absent/blank becomes "".
func normalizeTelegramAuthOptionalString(value string) string {
	normalized, ok := normalizeTelegramAuthString(value)
	if !ok {
		return ""
	}
	return normalized
}

// enforceStartRateLimit mirrors enforceStartAuthRateLimit: user first, then the
// client IP when present, then sha256(phone). The ip bucket key uses the
// normalized client IP exactly as NestJS passes resolveRequestIp's result.
func (s *telegramAuthService) enforceStartRateLimit(ctx context.Context, orgID, actorID, phoneNumber, clientIP string) error {
	if err := s.consumeStartRateLimit(ctx,
		telegramAuthStartRateLimitKeyUserPrefix+orgID+":"+actorID,
		telegramAuthStartRateLimitPerUser); err != nil {
		return err
	}
	if normalizedIP, ok := normalizeTelegramAuthString(clientIP); ok {
		if err := s.consumeStartRateLimit(ctx,
			telegramAuthStartRateLimitKeyIPPrefix+orgID+":"+normalizedIP,
			telegramAuthStartRateLimitPerIP); err != nil {
			return err
		}
	}
	phoneHash := sha256.Sum256([]byte(phoneNumber))
	if err := s.consumeStartRateLimit(ctx,
		telegramAuthStartRateLimitKeyPhonePrefix+orgID+":"+hex.EncodeToString(phoneHash[:]),
		telegramAuthStartRateLimitPerPhone); err != nil {
		return err
	}
	return nil
}

// consumeStartRateLimit mirrors consumeStartRateLimit: an exhausted bucket (or
// a fail-closed Redis failure) becomes 429 TELEGRAM_AUTH_RATE_LIMIT.
func (s *telegramAuthService) consumeStartRateLimit(ctx context.Context, key string, limit int) error {
	allowed, err := s.limiter.Consume(ctx, key, limit, telegramAuthStartRateLimitWindowSeconds)
	if err != nil || !allowed {
		return telegramAuthTooManyRequests(telegramAuthCodeRateLimit)
	}
	return nil
}

// ---- completeAuth ----

// completeAuth mirrors completeAuth: load and owner-check the pending request,
// sign in (password step when Telegram asks for it), export the final GramJS
// session string and delete the pending document.
func (s *telegramAuthService) completeAuth(ctx context.Context, orgID, actorID string, input CompleteTelegramAuthInput) (telegramAuthCompletedSession, error) {
	requestID, err := requireTelegramAuthValue(input.RequestID, "requestId")
	if err != nil {
		return telegramAuthCompletedSession{}, err
	}
	phoneCode, err := requireTelegramAuthValue(input.PhoneCode, "phoneCode")
	if err != nil {
		return telegramAuthCompletedSession{}, err
	}
	password := ""
	if input.Password.state == presenceValue {
		password = normalizeTelegramAuthOptionalString(input.Password.value)
	}

	cacheKey := telegramAuthCacheKey(requestID)
	payload, found, err := s.store.Load(ctx, cacheKey)
	if err != nil {
		// CacheService.get failures are plain ioredis errors, i.e. 500s.
		return telegramAuthCompletedSession{}, err
	}
	pending, foundInPayload, err := decodeTelegramAuthPending(payload)
	if err != nil {
		// JSON.parse failure is a SyntaxError -> 500.
		return telegramAuthCompletedSession{}, err
	}
	if !found || !foundInPayload {
		return telegramAuthCompletedSession{}, telegramAuthBadRequest(telegramAuthCodeRequestExpired)
	}
	if pending.OrgID != orgID || pending.ActorID != actorID {
		return telegramAuthCompletedSession{}, telegramAuthBadRequest(telegramAuthCodeRequestMismatch)
	}

	apiID, err := strconv.ParseInt(strings.TrimSpace(pending.TelegramAPIID), 10, 64)
	if err != nil {
		// NestJS coerces with Number(); a corrupt cache document is not
		// reachable through the API, so collapse it onto the Telegram code.
		return telegramAuthCompletedSession{}, telegramAuthBadRequest(telegramAuthCodeAPIIDInvalid)
	}

	client, err := s.telegram.NewTemporary(ctx, int(apiID), pending.TelegramAPIHash, pending.Session)
	if err != nil {
		return telegramAuthCompletedSession{}, toTelegramAuthBadRequest(err)
	}
	defer client.Close()

	if err := signInPendingTelegramAuth(ctx, client, pending, phoneCode, password); err != nil {
		return telegramAuthCompletedSession{}, err
	}

	session, err := client.ExportStringSession()
	if err != nil {
		return telegramAuthCompletedSession{}, toTelegramAuthBadRequest(err)
	}
	if err := s.store.Delete(ctx, cacheKey); err != nil {
		// cache.del is inside completeAuth's outer try/catch in NestJS: a
		// Redis failure becomes TELEGRAM_AUTH_FAILED.
		return telegramAuthCompletedSession{}, toTelegramAuthBadRequest(err)
	}
	return telegramAuthCompletedSession{
		TelegramAPIID:   pending.TelegramAPIID,
		TelegramAPIHash: pending.TelegramAPIHash,
		TelegramSession: session,
	}, nil
}

// signInPendingTelegramAuth mirrors completeAuth's nested try/catch:
// ErrSignUpRequired -> TELEGRAM_AUTH_SIGNUP_REQUIRED; SESSION_PASSWORD_NEEDED
// (or the exported sentinel) -> password required / SignInWithPassword; any
// other error goes through toBadRequest.
func signInPendingTelegramAuth(ctx context.Context, client TelegramAuthClient, pending telegramAuthPending, phoneCode, password string) error {
	signInErr := client.SignIn(ctx, pending.PhoneNumber, pending.PhoneCodeHash, phoneCode)
	if signInErr == nil {
		return nil
	}
	if errors.Is(signInErr, ErrTelegramSignUpRequired) {
		// NestJS throws this coded BadRequestException inside the inner try and
		// the inner catch rethrows it unchanged.
		return telegramAuthBadRequest(telegramAuthCodeSignUpRequired)
	}
	if errors.Is(signInErr, ErrTelegramPasswordNeeded) || telegramAuthIsSessionPasswordNeeded(signInErr) {
		if password == "" {
			return telegramAuthBadRequest(telegramAuthCodePasswordRequired)
		}
		if err := client.SignInWithPassword(ctx, password); err != nil {
			// NestJS routes the thrown error through toBadRequest, whose
			// SESSION_PASSWORD_NEEDED text branch answers PASSWORD_REQUIRED.
			if errors.Is(err, ErrTelegramPasswordNeeded) {
				return telegramAuthBadRequest(telegramAuthCodePasswordRequired)
			}
			return toTelegramAuthBadRequest(err)
		}
		return nil
	}
	return toTelegramAuthBadRequest(signInErr)
}

// telegramAuthIsSessionPasswordNeeded mirrors isSessionPasswordNeeded: the
// uppercase error message contains SESSION_PASSWORD_NEEDED.
func telegramAuthIsSessionPasswordNeeded(err error) bool {
	return strings.Contains(strings.ToUpper(err.Error()), "SESSION_PASSWORD_NEEDED")
}

// ---- shared helpers ----

// telegramAuthCacheKey mirrors buildCacheKey.
func telegramAuthCacheKey(requestID string) string {
	return telegramAuthCacheKeyPrefix + ":" + requestID
}

// marshalTelegramAuthPending produces JSON.stringify-compatible bytes of the
// pending request: declaration order, raw UTF-8 and no HTML escaping. The
// encoder is used with SetEscapeHTML(false) because NestJS JSON.stringify does
// not turn <, > or & into \u003c sequences; Encode's trailing newline is removed
// so the Redis value is exactly one line.
func marshalTelegramAuthPending(pending telegramAuthPending) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(pending); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte("\n")), nil
}

// decodeTelegramAuthPending parses a cache value like CacheService.get +
// JSON.parse + the pending truthiness check:
//   - an absent or falsy document (null/false/0/""/empty) is "no pending
//     request" -> TELEGRAM_AUTH_REQUEST_EXPIRED;
//   - a truthy non-object document (array/string/number/true) has undefined
//     properties in NestJS, so the owner comparison fails ->
//     TELEGRAM_AUTH_REQUEST_MISMATCH (returned as a zero pending document);
//   - malformed JSON throws in JSON.parse -> 500 (plain error).
func decodeTelegramAuthPending(payload []byte) (telegramAuthPending, bool, error) {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) == 0 {
		return telegramAuthPending{}, false, nil
	}
	var decoded any
	if err := json.Unmarshal(trimmed, &decoded); err != nil {
		return telegramAuthPending{}, false, fmt.Errorf("situationsettings: telegram auth cache decode failed: %w", err)
	}
	if !telegramAuthJSONTruthy(decoded) {
		return telegramAuthPending{}, false, nil
	}
	if _, isObject := decoded.(map[string]any); !isObject {
		return telegramAuthPending{}, true, nil
	}
	var pending telegramAuthPending
	if err := json.Unmarshal(trimmed, &pending); err != nil {
		return telegramAuthPending{}, false, fmt.Errorf("situationsettings: telegram auth cache decode failed: %w", err)
	}
	return pending, true, nil
}

// telegramAuthJSONTruthy mirrors JavaScript truthiness for a JSON.parse result:
// null/false/0/"" and NaN are falsy, every object and array is truthy.
func telegramAuthJSONTruthy(value any) bool {
	switch decoded := value.(type) {
	case nil:
		return false
	case bool:
		return decoded
	case float64:
		return decoded != 0 && !math.IsNaN(decoded)
	case string:
		return decoded != ""
	default:
		return true
	}
}

// telegramAuthISOTime is new Date().toISOString(): UTC with millisecond
// precision and a trailing Z (always three fractional digits).
func telegramAuthISOTime(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

// newTelegramAuthRequestID mirrors crypto.randomUUID(): a lowercase RFC 4122
// version 4 UUID. Standard library only.
func newTelegramAuthRequestID() (string, error) {
	var buffer [16]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", err
	}
	buffer[6] = (buffer[6] & 0x0f) | 0x40
	buffer[8] = (buffer[8] & 0x3f) | 0x80
	value := hex.EncodeToString(buffer[:])
	return value[0:8] + "-" + value[8:12] + "-" + value[12:16] + "-" + value[16:20] + "-" + value[20:32], nil
}

// ---- Redis adapters ----

// redisTelegramAuthStore is the CacheService subset backed by the shared
// go-redis client.
type redisTelegramAuthStore struct {
	client *redis.Client
}

// newRedisTelegramAuthStore adapts the shared Redis client to telegramAuthStore.
func newRedisTelegramAuthStore(client *redis.Client) telegramAuthStore {
	return &redisTelegramAuthStore{client: client}
}

// Load mirrors CacheService.get: an absent key (or a value JSON.parse would
// turn into null) means "no pending request".
func (s *redisTelegramAuthStore) Load(ctx context.Context, key string) ([]byte, bool, error) {
	if s == nil || s.client == nil {
		return nil, false, errTelegramAuthRedisUnavailable
	}
	value, err := s.client.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return value, true, nil
}

// Save mirrors CacheService.set(key, value, ttlSeconds): plain JSON payload,
// EX ttl.
func (s *redisTelegramAuthStore) Save(ctx context.Context, key string, payload []byte, ttl time.Duration) error {
	if s == nil || s.client == nil {
		return errTelegramAuthRedisUnavailable
	}
	return s.client.Set(ctx, key, payload, ttl).Err()
}

// Delete mirrors CacheService.del.
func (s *redisTelegramAuthStore) Delete(ctx context.Context, key string) error {
	if s == nil || s.client == nil {
		return errTelegramAuthRedisUnavailable
	}
	return s.client.Del(ctx, key).Err()
}

// telegramAuthSlidingWindowLua is RateLimiterService's SLIDING_WINDOW_LUA_SCRIPT,
// byte-identical, so Go and NestJS count against the same ZSET (the "rate:"
// bucket plus its ":seq" counter) and share one quota.
const telegramAuthSlidingWindowLua = `
local bucket_key = KEYS[1]
local sequence_key = KEYS[2]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local ttl_seconds = tonumber(ARGV[4])
local cleanup_limit = tonumber(ARGV[5])
local cleanup_threshold = tonumber(ARGV[6])

local window_start = now - window_ms
local window_min = '(' .. tostring(window_start)
local active = redis.call('ZCOUNT', bucket_key, window_min, now)

if cleanup_limit > 0 and cleanup_threshold > 0 then
  local total = redis.call('ZCARD', bucket_key)
  if (total - active) >= cleanup_threshold then
    local expired = redis.call('ZRANGEBYSCORE', bucket_key, 0, window_start, 'LIMIT', 0, cleanup_limit)
    if #expired > 0 then
      redis.call('ZREM', bucket_key, unpack(expired))
    end
  end
end

if active >= limit then
  redis.call('EXPIRE', bucket_key, ttl_seconds)
  redis.call('EXPIRE', sequence_key, ttl_seconds)
  return {0, active}
end

local sequence = redis.call('INCR', sequence_key)
redis.call('ZADD', bucket_key, now, tostring(now) .. '-' .. sequence)
redis.call('EXPIRE', bucket_key, ttl_seconds)
redis.call('EXPIRE', sequence_key, ttl_seconds)

return {1, active + 1}
`

// redisTelegramAuthRateLimiter is RateLimiterService.consume on the shared
// Redis. Failure semantics follow RATE_LIMIT_REDIS_FAIL_OPEN (default false,
// i.e. fail-closed: a Redis error answers the same 429 as an exhausted quota).
// The in-process circuit breaker is intentionally not replicated; the shared
// sliding-window script and the fail-closed answer are, which is what the
// quota contract (and the accountdata precedent) requires.
type redisTelegramAuthRateLimiter struct {
	client   *redis.Client
	failOpen bool
}

// newRedisTelegramAuthRateLimiter adapts the shared Redis client and the
// RATE_LIMIT_REDIS_FAIL_OPEN flag.
func newRedisTelegramAuthRateLimiter(client *redis.Client, failOpen bool) telegramAuthRateLimiter {
	return &redisTelegramAuthRateLimiter{client: client, failOpen: failOpen}
}

// Consume mirrors RateLimiterService.consume. The bucket key is "rate:" + key
// and its sequence counter is "<bucket>:seq"; the window TTL is
// max(ceil(windowSeconds*2), 1) seconds, all exactly as NestJS writes them.
func (l *redisTelegramAuthRateLimiter) Consume(ctx context.Context, key string, limit, windowSeconds int) (bool, error) {
	if l == nil {
		return false, errTelegramAuthRedisUnavailable
	}
	if l.client == nil {
		return l.failOpen, nil
	}
	if limit <= 0 || windowSeconds <= 0 {
		return true, nil
	}

	now := time.Now().UnixMilli()
	windowMS := int64(windowSeconds) * 1000
	ttlSeconds := windowSeconds * 2
	if ttlSeconds < 1 {
		ttlSeconds = 1
	}
	bucketKey := "rate:" + key
	evalCtx, cancel := context.WithTimeout(ctx, telegramAuthRateLimitEvalTimeout)
	defer cancel()
	value, err := l.client.Eval(evalCtx, telegramAuthSlidingWindowLua,
		[]string{bucketKey, bucketKey + ":seq"},
		now, windowMS, limit, ttlSeconds,
		telegramAuthRateLimitCleanupLimit, telegramAuthRateLimitCleanupThreshold).Result()
	if err != nil {
		// NestJS swallows the error and returns failOpen; fail-closed is the
		// default and answers the same 429 as an exhausted bucket.
		return l.failOpen, nil
	}
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return l.failOpen, nil
	}
	switch allowed := items[0].(type) {
	case int64:
		return allowed == 1, nil
	case int:
		return allowed == 1, nil
	default:
		return l.failOpen, nil
	}
}
