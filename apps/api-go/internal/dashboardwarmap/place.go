package dashboardwarmap

import (
	"context"
	"database/sql"
	"time"

	"github.com/redis/go-redis/v9"
)

// Place 是地理缓存或国家中心点命中的坐标。
type Place struct {
	Lat  float64
	Lng  float64
	Name string
}

// PlaceConfig 沿用 NestJS Nominatim 环境变量，不另建地理数据源。
type PlaceConfig struct {
	BaseURL        string
	UserAgent      string
	Email          string
	AcceptLanguage string
	Timeout        time.Duration
	CacheTTL       time.Duration
	NegativeTTL    time.Duration
	RatePerSecond  int
}

// PlaceResolver 读写与 NestJS 相同的 Redis 键 geo:geocode:v1。
type PlaceResolver struct {
	inner *liveGeocoder
}

// NewPlaceResolver 复用 War Map 已经对准的缓存、负缓存和 Nominatim 限流。
func NewPlaceResolver(rdb *redis.Client, db *sql.DB, cfg PlaceConfig) *PlaceResolver {
	return &PlaceResolver{inner: newLiveGeocoder(redisBlobs{client: rdb}, rdb, &mysqlStore{db: db}, nominatimConfig{
		BaseURL: cfg.BaseURL, UserAgent: cfg.UserAgent, Email: cfg.Email,
		AcceptLanguage: cfg.AcceptLanguage, Timeout: cfg.Timeout,
		CacheTTL: cfg.CacheTTL, NegativeTTL: cfg.NegativeTTL, RatePerSecond: cfg.RatePerSecond,
	})}
}

// Resolve 先查缓存。network 为 true 时才允许打到外部地理服务，并且只查第一个候选。
func (p *PlaceResolver) Resolve(ctx context.Context, candidates []string, alpha2 string, network bool) (*Place, error) {
	if p == nil || p.inner == nil {
		return nil, nil
	}
	hit, err := p.inner.Resolve(ctx, candidates, alpha2, network)
	if err != nil || hit == nil {
		return nil, err
	}
	return &Place{Lat: hit.Lat, Lng: hit.Lng, Name: hit.DisplayName}, nil
}

// CountryCodeFromText 从地点文本里抽出 alpha-3。没有国家时返回空字符串。
func CountryCodeFromText(text string) string {
	return extractCountryCodeFromText(text)
}

// CanonicalCountry 把国家名、alpha-2 或 alpha-3 收成 alpha-3。
func CanonicalCountry(input string) string {
	return normalizeCountryCode(input)
}

// CountryAlpha2 返回 alpha-2。未知代码返回空字符串。
func CountryAlpha2(code string) string {
	return countryAlpha2(code)
}

// CountryCenter 返回 world.geo.json 里的国家中心点。
func CountryCenter(code string) (Place, bool) {
	point, ok := worldIndex().get(normalizeCountryCode(code))
	if !ok {
		return Place{}, false
	}
	return Place{Lat: point.Lat, Lng: point.Lng, Name: point.Name}, true
}
