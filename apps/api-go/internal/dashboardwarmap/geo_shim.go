package dashboardwarmap

import (
	"strings"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/geocoding"
)

// This file is the mechanical bridge left in the dashboard war map after the
// geocoder itself moved to internal/geocoding. The unexported names and the
// behaviour stay exactly as they were: the client is constructed with
// CacheNegativeOnTransient=true, which reproduces the historical rule of writing
// a negative cache entry even when Nominatim is unreachable. The two REST
// geocoding entries use the shared client with that flag off (D2).

// geoHit is the war map's historical result type.
type geoHit = geocoding.Hit

// nominatimConfig is the historical configuration struct.
type nominatimConfig = geocoding.Config

// liveGeocoder is the historical client type.
type liveGeocoder = geocoding.Client

// newLiveGeocoder keeps every existing call site unchanged.
func newLiveGeocoder(cache blobCache, rdb *redis.Client, db settingsDB, cfg nominatimConfig) *liveGeocoder {
	cfg.CacheNegativeOnTransient = true
	return geocoding.NewClient(cache, rdb, db, cfg)
}

// Country helpers. They delegate to the shared implementation so the war map and
// the REST geocoding entries use one country table and one normalisation.

func normalizeCountryCode(input string) string { return geocoding.NormalizeCountryCode(input) }

func extractCountryCodeFromText(text string) string {
	return geocoding.ExtractCountryCodeFromText(text)
}

func countryName(code string) string { return geocoding.CountryName(code) }

func countryAlpha2(code string) string { return geocoding.CountryAlpha2(code) }

// stringOrEmpty is still used by the translator settings reader.
func stringOrEmpty(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}
