// Package geocoding is the shared Nominatim client. It owns the cache layout
// (geo:geocode:v1), the sliding-window rate limit key (rate:geocode:nominatim),
// the identity row read and the country-code helpers, so the dashboard war map
// and the two REST geocoding entries cannot drift apart.
package geocoding

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// Cache is the blob cache the geocoder reads and writes. The dashboard war map
// passes its existing Redis blob cache; the REST wiring passes RedisCache below.
type Cache interface {
	Get(ctx context.Context, key string) ([]byte, bool, error)
	Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
	Del(ctx context.Context, key string) error
}

// SettingsReader reads one SystemSetting value. The dashboard war map passes its
// existing MySQL-backed store; the REST wiring passes SQLSettingsReader.
type SettingsReader interface {
	Setting(ctx context.Context, key string) ([]byte, bool, error)
}

// RedisCache is the production Cache implementation.
type RedisCache struct {
	Client *redis.Client
}

// Get implements Cache.
func (r RedisCache) Get(ctx context.Context, key string) ([]byte, bool, error) {
	if r.Client == nil {
		return nil, false, errors.New("geocoding: redis is not configured")
	}
	raw, err := r.Client.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return raw, true, nil
}

// Set implements Cache.
func (r RedisCache) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	if r.Client == nil {
		return errors.New("geocoding: redis is not configured")
	}
	return r.Client.Set(ctx, key, value, ttl).Err()
}

// Del implements Cache.
func (r RedisCache) Del(ctx context.Context, key string) error {
	if r.Client == nil {
		return errors.New("geocoding: redis is not configured")
	}
	return r.Client.Del(ctx, key).Err()
}

// MemoryCache is a process-local Cache used by unit tests.
type MemoryCache struct {
	Values map[string][]byte
}

// NewMemoryCache builds an empty MemoryCache.
func NewMemoryCache() *MemoryCache { return &MemoryCache{Values: map[string][]byte{}} }

// Get implements Cache.
func (m *MemoryCache) Get(_ context.Context, key string) ([]byte, bool, error) {
	value, ok := m.Values[key]
	if !ok {
		return nil, false, nil
	}
	return append([]byte(nil), value...), true, nil
}

// Set implements Cache.
func (m *MemoryCache) Set(_ context.Context, key string, value []byte, _ time.Duration) error {
	m.Values[key] = append([]byte(nil), value...)
	return nil
}

// Del implements Cache.
func (m *MemoryCache) Del(_ context.Context, key string) error {
	delete(m.Values, key)
	return nil
}

// Config is the Nominatim client configuration. The field names match the war
// map's historical nominatimConfig so the call sites stay mechanical.
type Config struct {
	BaseURL        string
	UserAgent      string
	Email          string
	AcceptLanguage string
	Timeout        time.Duration
	CacheTTL       time.Duration
	NegativeTTL    time.Duration
	RatePerSecond  int
	// CacheNegativeOnTransient preserves the war map's historical behaviour of
	// writing a negative cache entry when Nominatim is unreachable or returns a
	// non-2xx status. The two REST geocoding entries leave it false (D2): only a
	// 2xx response without a usable result is cached as "no such place".
	CacheNegativeOnTransient bool
}

// Bounds is the Nominatim bounding box (minLat, maxLat, minLng, maxLng).
type Bounds struct {
	MinLat float64 `json:"minLat"`
	MaxLat float64 `json:"maxLat"`
	MinLng float64 `json:"minLng"`
	MaxLng float64 `json:"maxLng"`
}

// Hit is one resolved place. Provider is always "nominatim" for live results;
// cached entries from other implementations stay unspecified and are treated as
// Nominatim, which is the only provider this service writes.
type Hit struct {
	Lat               float64
	Lng               float64
	DisplayName       string
	Provider          string
	Bounds            *Bounds
	Query             string
	CountryCodeAlpha2 string
}

// Client is the Nominatim client. It is safe for concurrent use except for the
// deliberately unsynchronised 30 second identity cache, which only trades a
// duplicate DB read for a data race-free single value; callers are HTTP handlers
// and the worst case is one extra read.
type Client struct {
	cache   Cache
	redis   *redis.Client
	db      SettingsReader
	config  Config
	script  *redis.Script
	now     func() time.Time
	http    *http.Client
	ident   *Identity
	identAt time.Time
}

// Identity is the effective Nominatim User-Agent / e-mail pair.
type Identity struct {
	UserAgent string
	Email     string
}

// NewClient wires the client. Nil configuration values keep the same defaults
// the NestJS service uses.
func NewClient(cache Cache, rdb *redis.Client, db SettingsReader, cfg Config) *Client {
	if cfg.BaseURL == "" {
		cfg.BaseURL = "https://nominatim.openstreetmap.org"
	}
	if cfg.UserAgent == "" {
		cfg.UserAgent = "modular-api"
	}
	if cfg.AcceptLanguage == "" {
		cfg.AcceptLanguage = "zh-CN,zh;q=0.9,en;q=0.7"
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 3 * time.Second
	}
	if cfg.CacheTTL <= 0 {
		cfg.CacheTTL = 2592000 * time.Second
	}
	if cfg.NegativeTTL <= 0 {
		cfg.NegativeTTL = 86400 * time.Second
	}
	if cfg.RatePerSecond <= 0 {
		cfg.RatePerSecond = 1
	}
	return &Client{
		cache:  cache,
		redis:  rdb,
		db:     db,
		config: cfg,
		script: redis.NewScript(slidingWindowLua),
		now:    time.Now,
		http:   &http.Client{},
	}
}

// Resolve keeps the dashboard war map contract: cached candidates first, and a
// network lookup for the first candidate only when network is true.
func (g *Client) Resolve(ctx context.Context, candidates []string, alpha2 string, network bool) (*Hit, error) {
	unique := uniqueStrings(candidates)
	if len(unique) == 0 {
		return nil, nil
	}
	for _, candidate := range unique {
		hit, err := g.positive(ctx, candidate, alpha2)
		if err != nil {
			return nil, err
		}
		if hit != nil {
			return hit, nil
		}
	}
	if !network {
		return nil, nil
	}
	return g.lookupNetwork(ctx, unique[0], alpha2, g.config.CacheNegativeOnTransient)
}

// Geocode is the REST entry semantics (GeocodingService.geocode): resolve the
// country, normalise the provider query, honour both cache directions, apply the
// global rate limit and cache only a definitive answer. Temporary failures
// return (nil, nil) and are deliberately not written to the negative cache (D2).
func (g *Client) Geocode(ctx context.Context, query, alpha2 string) (*Hit, error) {
	normalized := normalizeGeocodeQuery(query)
	if normalized == "" {
		return nil, nil
	}
	effective, country := providerQuery(normalized, alpha2)
	key := geocodeCacheKey(effective, country)
	if g.cache != nil {
		raw, hit, err := g.cache.Get(ctx, key)
		if err != nil {
			return nil, err
		}
		if hit {
			var cached cachedGeocode
			if json.Unmarshal(raw, &cached) == nil {
				if cached.OK && cached.Result != nil {
					return cached.Result.toHit(), nil
				}
				if !cached.OK && g.now().UnixMilli()-cached.CachedAt <= g.config.NegativeTTL.Milliseconds() {
					return nil, nil
				}
			}
		}
	}
	allowed, err := g.allow(ctx)
	if err != nil || !allowed {
		return nil, nil
	}
	result, outcome, err := g.fetch(ctx, effective, country)
	if err != nil {
		return nil, err
	}
	switch outcome {
	case fetchFound:
		if err := g.store(ctx, key, cachedGeocode{OK: true, CachedAt: g.now().UnixMilli(), Result: result.cached(effective, country)}, g.config.CacheTTL); err != nil {
			return nil, err
		}
	case fetchNotFound:
		if err := g.store(ctx, key, cachedGeocode{OK: false, CachedAt: g.now().UnixMilli()}, g.config.NegativeTTL); err != nil {
			return nil, err
		}
	}
	return result, nil
}

// Probe is the administrator test semantics (D3): it never reads the cache, but
// it still consumes the shared global rate limit. A definitive result is written
// to the positive cache; a miss or a temporary failure is not cached at all, so
// a fixed User-Agent/e-mail is exercised on the next test.
func (g *Client) Probe(ctx context.Context, query, alpha2 string) (*Hit, error) {
	normalized := normalizeGeocodeQuery(query)
	if normalized == "" {
		return nil, nil
	}
	effective, country := providerQuery(normalized, alpha2)
	allowed, err := g.allow(ctx)
	if err != nil || !allowed {
		return nil, nil
	}
	result, outcome, err := g.fetch(ctx, effective, country)
	if err != nil {
		return nil, err
	}
	if outcome == fetchFound {
		key := geocodeCacheKey(effective, country)
		// The diagnostic must not fail because the cache write failed: the
		// probe's answer is the real upstream response.
		_ = g.store(ctx, key, cachedGeocode{OK: true, CachedAt: g.now().UnixMilli(), Result: result.cached(effective, country)}, g.config.CacheTTL)
	}
	return result, nil
}

func (g *Client) store(ctx context.Context, key string, payload cachedGeocode, ttl time.Duration) error {
	if g.cache == nil {
		return nil
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return g.cache.Set(ctx, key, body, ttl)
}

func (g *Client) positive(ctx context.Context, query, alpha2 string) (*Hit, error) {
	normalized := normalizeGeocodeQuery(query)
	if normalized == "" || g.cache == nil {
		return nil, nil
	}
	key := geocodeCacheKey(normalized, alpha2)
	raw, hit, err := g.cache.Get(ctx, key)
	if err != nil || !hit {
		return nil, err
	}
	var cached cachedGeocode
	if err := json.Unmarshal(raw, &cached); err != nil {
		return nil, nil
	}
	if !cached.OK {
		if g.now().UnixMilli()-cached.CachedAt > g.config.NegativeTTL.Milliseconds() {
			_ = g.cache.Del(ctx, key)
		}
		return nil, nil
	}
	if cached.Result == nil {
		return nil, nil
	}
	return cached.Result.toHit(), nil
}

func (g *Client) lookupNetwork(ctx context.Context, query, alpha2 string, cacheTransient bool) (*Hit, error) {
	normalized := normalizeGeocodeQuery(query)
	if normalized == "" {
		return nil, nil
	}
	effective, country := providerQuery(normalized, alpha2)
	key := geocodeCacheKey(effective, country)
	if g.cache != nil {
		raw, hit, err := g.cache.Get(ctx, key)
		if err != nil {
			return nil, err
		}
		if hit {
			var cached cachedGeocode
			if err := json.Unmarshal(raw, &cached); err == nil {
				if cached.OK && cached.Result != nil {
					return cached.Result.toHit(), nil
				}
				if !cached.OK && g.now().UnixMilli()-cached.CachedAt <= g.config.NegativeTTL.Milliseconds() {
					return nil, nil
				}
			}
		}
	}
	allowed, err := g.allow(ctx)
	if err != nil || !allowed {
		return nil, nil
	}
	result, outcome, err := g.fetch(ctx, effective, country)
	if err != nil {
		return nil, err
	}
	if result != nil {
		if err := g.store(ctx, key, cachedGeocode{OK: true, CachedAt: g.now().UnixMilli(), Result: result.cached(effective, country)}, g.config.CacheTTL); err != nil {
			return nil, err
		}
	} else if outcome == fetchNotFound || (outcome == fetchTransient && cacheTransient) {
		if err := g.store(ctx, key, cachedGeocode{OK: false, CachedAt: g.now().UnixMilli()}, g.config.NegativeTTL); err != nil {
			return nil, err
		}
	}
	return result, nil
}

// providerQuery mirrors GeocodingService.geocode's normalisation: infer the
// country from the query when no override is given, and replace a country-name
// query with the canonical country name the provider understands.
func providerQuery(normalized, alpha2 string) (string, string) {
	country := alpha2
	if country == "" {
		if code := NormalizeCountryCode(normalized); code != "" {
			country = CountryAlpha2(code)
		}
	}
	effective := normalized
	if code := NormalizeCountryCode(normalized); code != "" {
		if name := CountryName(code); name != "" {
			effective = name
		}
	}
	return normalizeGeocodeQuery(effective), country
}

func (g *Client) allow(ctx context.Context) (bool, error) {
	if g.config.RatePerSecond <= 0 || g.redis == nil || g.script == nil {
		return true, nil
	}
	now := g.now().UnixMilli()
	windowMs := int64(1000)
	ttl := 2
	bucket := "rate:geocode:nominatim"
	values, err := g.script.Run(ctx, g.redis, []string{bucket, bucket + ":seq"}, now, windowMs, g.config.RatePerSecond, ttl, 100, 1000).Slice()
	if err != nil {
		log.Printf("geocoding: nominatim rate limit unavailable")
		return false, nil
	}
	if len(values) == 0 {
		return false, nil
	}
	switch n := values[0].(type) {
	case int64:
		return n == 1, nil
	case int:
		return n == 1, nil
	default:
		return false, nil
	}
}

// fetchOutcome classifies one Nominatim call. The distinction is what makes D2
// possible: a 2xx response without a usable result is a definitive "unknown
// place", while a network error, timeout or non-2xx status is transient.
type fetchOutcome int

const (
	fetchTransient fetchOutcome = iota
	fetchFound
	fetchNotFound
)

func (g *Client) fetch(ctx context.Context, query, alpha2 string) (*Hit, fetchOutcome, error) {
	identity, err := g.identity(ctx)
	if err != nil {
		return nil, fetchTransient, err
	}
	base, err := url.Parse(g.config.BaseURL)
	if err != nil {
		return nil, fetchTransient, nil
	}
	endpoint := base.JoinPath("search")
	params := endpoint.Query()
	params.Set("format", "jsonv2")
	params.Set("q", query)
	params.Set("limit", "1")
	params.Set("addressdetails", "1")
	params.Set("namedetails", "0")
	if alpha2 != "" {
		params.Set("countrycodes", strings.ToLower(alpha2))
	}
	if identity.Email != "" {
		params.Set("email", identity.Email)
	}
	endpoint.RawQuery = params.Encode()
	callCtx, cancel := context.WithTimeout(ctx, g.config.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(callCtx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, fetchTransient, nil
	}
	req.Header.Set("User-Agent", identity.UserAgent)
	req.Header.Set("Accept-Language", g.config.AcceptLanguage)
	resp, err := g.http.Do(req)
	if err != nil {
		log.Printf("geocoding: nominatim request failed")
		return nil, fetchTransient, nil
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("geocoding: nominatim status %d", resp.StatusCode)
		return nil, fetchTransient, nil
	}
	var rows []map[string]any
	if err := json.Unmarshal(body, &rows); err != nil || len(rows) == 0 {
		return nil, fetchNotFound, nil
	}
	lat, okLat := numberField(rows[0]["lat"])
	lng, okLng := numberField(rows[0]["lon"])
	if !okLat || !okLng {
		return nil, fetchNotFound, nil
	}
	hit := &Hit{Lat: lat, Lng: lng, Provider: "nominatim", Query: query, CountryCodeAlpha2: alpha2}
	if name, ok := rows[0]["display_name"].(string); ok {
		hit.DisplayName = name
	}
	if bounds := parseBoundingBox(rows[0]["boundingbox"]); bounds != nil {
		hit.Bounds = bounds
	}
	if address, ok := rows[0]["address"].(map[string]any); ok {
		if code, ok := address["country_code"].(string); ok {
			code = strings.ToUpper(strings.TrimSpace(code))
			if len(code) == 2 {
				hit.CountryCodeAlpha2 = code
			}
		}
	}
	return hit, fetchFound, nil
}

// parseBoundingBox mirrors GeocodingService.parseBoundingBox: four finite
// numbers, otherwise no bounds at all.
func parseBoundingBox(input any) *Bounds {
	raw, ok := input.([]any)
	if !ok || len(raw) < 4 {
		return nil
	}
	minLat, ok1 := numberField(raw[0])
	maxLat, ok2 := numberField(raw[1])
	minLng, ok3 := numberField(raw[2])
	maxLng, ok4 := numberField(raw[3])
	if !ok1 || !ok2 || !ok3 || !ok4 {
		return nil
	}
	return &Bounds{MinLat: minLat, MaxLat: maxLat, MinLng: minLng, MaxLng: maxLng}
}

const nominatimSettingsKey = "geo_nominatim_identity"

// identity mirrors GeoNominatimSettingsService.getEffectiveIdentity's 30 second
// process cache. The row members are trimmed; an e-mail is accepted only when it
// contains "@", exactly like the war map implementation this was extracted from.
func (g *Client) identity(ctx context.Context) (Identity, error) {
	if g.ident != nil && g.now().Before(g.identAt) {
		return *g.ident, nil
	}
	identity := Identity{UserAgent: g.config.UserAgent, Email: g.config.Email}
	if g.db != nil {
		raw, ok, err := g.db.Setting(ctx, nominatimSettingsKey)
		if err != nil {
			return Identity{}, err
		}
		if ok {
			var payload map[string]any
			if json.Unmarshal(raw, &payload) == nil {
				if agent := stringOrEmpty(payload["userAgent"]); agent != "" {
					identity.UserAgent = agent
				}
				if email := stringOrEmpty(payload["email"]); email != "" && strings.Contains(email, "@") {
					identity.Email = email
				}
			}
		}
	}
	if identity.UserAgent == "" {
		identity.UserAgent = "modular-api"
	}
	g.ident = &identity
	g.identAt = g.now().Add(30 * time.Second)
	return identity, nil
}

type cachedGeocode struct {
	OK       bool          `json:"ok"`
	CachedAt int64         `json:"cachedAt"`
	Result   *cachedGeoHit `json:"result,omitempty"`
}

type cachedGeoHit struct {
	Lat               float64 `json:"lat"`
	Lng               float64 `json:"lng"`
	DisplayName       string  `json:"displayName,omitempty"`
	Provider          string  `json:"provider"`
	Bounds            *Bounds `json:"bounds,omitempty"`
	Query             string  `json:"query"`
	CountryCodeAlpha2 string  `json:"countryCodeAlpha2,omitempty"`
}

func (h *cachedGeoHit) toHit() *Hit {
	if h == nil {
		return nil
	}
	provider := h.Provider
	if provider == "" {
		provider = "nominatim"
	}
	return &Hit{Lat: h.Lat, Lng: h.Lng, DisplayName: h.DisplayName, Provider: provider, Bounds: h.Bounds, Query: h.Query, CountryCodeAlpha2: h.CountryCodeAlpha2}
}

func (h *Hit) cached(query, alpha2 string) *cachedGeoHit {
	if h == nil {
		return nil
	}
	return &cachedGeoHit{
		Lat: h.Lat, Lng: h.Lng, DisplayName: h.DisplayName, Provider: "nominatim",
		Bounds: h.Bounds, Query: query, CountryCodeAlpha2: alpha2,
	}
}

// CacheKey is exported for cache-compatibility tests; the format must match
// NestJS exactly.
func CacheKey(query, alpha2 string) string { return geocodeCacheKey(query, alpha2) }

func geocodeCacheKey(query, alpha2 string) string {
	country := "any"
	if alpha2 != "" {
		country = strings.ToLower(alpha2)
	}
	sum := sha256.Sum256([]byte(query))
	return "geo:geocode:v1:" + country + ":" + hex.EncodeToString(sum[:])
}

// NormalizeQuery mirrors GeocodingService.normalizeQuery (trim, collapse
// whitespace, truncate to 200 characters).
func NormalizeQuery(value string) string { return normalizeGeocodeQuery(value) }

func normalizeGeocodeQuery(value string) string {
	value = strings.Join(strings.Fields(value), " ")
	runes := []rune(value)
	if len(runes) > 200 {
		value = string(runes[:200])
	}
	return value
}

func uniqueStrings(values []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func numberField(value any) (float64, bool) {
	switch n := value.(type) {
	case float64:
		return n, n == n
	case string:
		parsed, err := json.Number(strings.TrimSpace(n)).Float64()
		return parsed, err == nil
	default:
		return 0, false
	}
}

func stringOrEmpty(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

const slidingWindowLua = `
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

// SQLSettingsReader reads geo_nominatim_identity from the shared MySQL pool. It
// is the REST wiring's SettingsReader; the war map keeps passing its existing
// store.
type SQLSettingsReader struct {
	DB *sql.DB
}

// Setting implements SettingsReader.
func (r SQLSettingsReader) Setting(ctx context.Context, key string) ([]byte, bool, error) {
	if r.DB == nil {
		return nil, false, errors.New("geocoding: mysql is not configured")
	}
	var raw []byte
	err := r.DB.QueryRowContext(ctx,
		"SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return raw, true, nil
}
