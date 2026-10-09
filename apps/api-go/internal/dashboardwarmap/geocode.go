package dashboardwarmap

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const geocodeCachePrefix = "geo:geocode:v1"

type geoHit struct {
	Lat               float64
	Lng               float64
	DisplayName       string
	CountryCodeAlpha2 string
	Query             string
}

type geocoder interface {
	Resolve(ctx context.Context, candidates []string, alpha2 string, network bool) (*geoHit, error)
}

type nominatimConfig struct {
	BaseURL        string
	UserAgent      string
	Email          string
	AcceptLanguage string
	Timeout        time.Duration
	CacheTTL       time.Duration
	NegativeTTL    time.Duration
	RatePerSecond  int
}

type liveGeocoder struct {
	cache   blobCache
	redis   *redis.Client
	db      settingsDB
	config  nominatimConfig
	script  *redis.Script
	now     func() time.Time
	http    *http.Client
	ident   *nominatimIdentity
	identAt time.Time
}

type nominatimIdentity struct {
	UserAgent string
	Email     string
}

type settingsDB interface {
	Setting(ctx context.Context, key string) ([]byte, bool, error)
}

const nominatimSettingsKey = "geo_nominatim_identity"

func newLiveGeocoder(cache blobCache, rdb *redis.Client, db settingsDB, cfg nominatimConfig) *liveGeocoder {
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
	return &liveGeocoder{
		cache:  cache,
		redis:  rdb,
		db:     db,
		config: cfg,
		script: redis.NewScript(slidingWindowLua),
		now:    time.Now,
		http:   &http.Client{},
	}
}

func (g *liveGeocoder) Resolve(ctx context.Context, candidates []string, alpha2 string, network bool) (*geoHit, error) {
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
	return g.lookupNetwork(ctx, unique[0], alpha2)
}

func (g *liveGeocoder) positive(ctx context.Context, query, alpha2 string) (*geoHit, error) {
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

func (g *liveGeocoder) lookupNetwork(ctx context.Context, query, alpha2 string) (*geoHit, error) {
	normalized := normalizeGeocodeQuery(query)
	if normalized == "" {
		return nil, nil
	}
	country := alpha2
	if country == "" {
		if code := normalizeCountryCode(normalized); code != "" {
			country = countryAlpha2(code)
		}
	}
	effective := normalized
	if code := normalizeCountryCode(normalized); code != "" {
		if name := countryName(code); name != "" {
			effective = name
		}
	}
	effective = normalizeGeocodeQuery(effective)
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
	result, err := g.fetch(ctx, effective, country)
	if err != nil {
		return nil, err
	}
	payload := cachedGeocode{OK: result != nil, CachedAt: g.now().UnixMilli()}
	ttl := g.config.NegativeTTL
	if result != nil {
		payload.Result = result.cached(effective, country)
		ttl = g.config.CacheTTL
	}
	if g.cache != nil {
		body, marshalErr := json.Marshal(payload)
		if marshalErr != nil {
			return nil, marshalErr
		}
		if err := g.cache.Set(ctx, key, body, ttl); err != nil {
			return nil, err
		}
	}
	if result == nil {
		return nil, nil
	}
	return result, nil
}

func (g *liveGeocoder) allow(ctx context.Context) (bool, error) {
	if g.config.RatePerSecond <= 0 || g.redis == nil || g.script == nil {
		return true, nil
	}
	now := g.now().UnixMilli()
	windowMs := int64(1000)
	ttl := 2
	bucket := "rate:geocode:nominatim"
	values, err := g.script.Run(ctx, g.redis, []string{bucket, bucket + ":seq"}, now, windowMs, g.config.RatePerSecond, ttl, 100, 1000).Slice()
	if err != nil {
		log.Printf("dashboard war map: nominatim rate limit unavailable")
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

func (g *liveGeocoder) fetch(ctx context.Context, query, alpha2 string) (*geoHit, error) {
	identity, err := g.identity(ctx)
	if err != nil {
		return nil, err
	}
	base, err := url.Parse(g.config.BaseURL)
	if err != nil {
		return nil, nil
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
	timeout := g.config.Timeout
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(callCtx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, nil
	}
	req.Header.Set("User-Agent", identity.UserAgent)
	req.Header.Set("Accept-Language", g.config.AcceptLanguage)
	resp, err := g.http.Do(req)
	if err != nil {
		log.Printf("dashboard war map: nominatim request failed")
		return nil, nil
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("dashboard war map: nominatim status %d", resp.StatusCode)
		return nil, nil
	}
	var rows []map[string]any
	if err := json.Unmarshal(body, &rows); err != nil || len(rows) == 0 {
		return nil, nil
	}
	lat, okLat := numberField(rows[0]["lat"])
	lng, okLng := numberField(rows[0]["lon"])
	if !okLat || !okLng {
		return nil, nil
	}
	hit := &geoHit{Lat: lat, Lng: lng, Query: query, CountryCodeAlpha2: alpha2}
	if name, ok := rows[0]["display_name"].(string); ok {
		hit.DisplayName = name
	}
	if address, ok := rows[0]["address"].(map[string]any); ok {
		if code, ok := address["country_code"].(string); ok {
			code = strings.ToUpper(strings.TrimSpace(code))
			if len(code) == 2 {
				hit.CountryCodeAlpha2 = code
			}
		}
	}
	return hit, nil
}

func (g *liveGeocoder) identity(ctx context.Context) (nominatimIdentity, error) {
	if g.ident != nil && g.now().Before(g.identAt) {
		return *g.ident, nil
	}
	identity := nominatimIdentity{UserAgent: g.config.UserAgent, Email: g.config.Email}
	if g.db != nil {
		raw, ok, err := g.db.Setting(ctx, nominatimSettingsKey)
		if err != nil {
			return nominatimIdentity{}, err
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
	Query             string  `json:"query"`
	CountryCodeAlpha2 string  `json:"countryCodeAlpha2,omitempty"`
}

func (h *cachedGeoHit) toHit() *geoHit {
	if h == nil {
		return nil
	}
	return &geoHit{Lat: h.Lat, Lng: h.Lng, DisplayName: h.DisplayName, Query: h.Query, CountryCodeAlpha2: h.CountryCodeAlpha2}
}

func (h *geoHit) cached(query, alpha2 string) *cachedGeoHit {
	return &cachedGeoHit{
		Lat: h.Lat, Lng: h.Lng, DisplayName: h.DisplayName,
		Provider: "nominatim", Query: query, CountryCodeAlpha2: alpha2,
	}
}

func geocodeCacheKey(query, alpha2 string) string {
	country := "any"
	if alpha2 != "" {
		country = strings.ToLower(alpha2)
	}
	sum := sha256.Sum256([]byte(query))
	return geocodeCachePrefix + ":" + country + ":" + hex.EncodeToString(sum[:])
}

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
