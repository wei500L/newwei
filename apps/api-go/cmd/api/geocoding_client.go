package main

import (
	"database/sql"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/geocoding"
)

// newGeocodingClient builds the shared Nominatim client. The geocoding REST
// routes and the situation monitor preview/write paths must use this factory so
// they share the same Redis cache layout, global rate-limit key and SQL-backed
// identity row instead of drifting into separate clients.
func newGeocodingClient(cfg config.Config, db *sql.DB, redisClient *redis.Client) *geocoding.Client {
	return geocoding.NewClient(
		geocoding.RedisCache{Client: redisClient},
		redisClient,
		geocoding.SQLSettingsReader{DB: db},
		geocoding.Config{
			BaseURL:        cfg.NominatimBaseURL,
			UserAgent:      cfg.NominatimUserAgent,
			Email:          cfg.NominatimEmail,
			AcceptLanguage: cfg.NominatimAcceptLanguage,
			Timeout:        durationMillis(cfg.GeocodeTimeoutMs),
			CacheTTL:       durationSeconds(cfg.GeocodeCacheTTLSeconds),
			NegativeTTL:    durationSeconds(cfg.GeocodeNegativeTTLSeconds),
			RatePerSecond:  cfg.GeocodeRatePerSecond,
		},
	)
}

func durationMillis(value int) time.Duration {
	return time.Duration(value) * time.Millisecond
}

func durationSeconds(value int) time.Duration {
	return time.Duration(value) * time.Second
}
