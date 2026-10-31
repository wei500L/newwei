package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/infrastructuresettings"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/newsnowclusteringops"
	"github.com/wei500L/newwei/apps/api-go/internal/newsnowsources"
)

// newsnowSourceRegistry adapts the generated metadata port to the source
// service's read-only registry interface.
type newsnowSourceRegistry struct{}

// Lookup resolves one id without instantiating the Mongo-backed service.
func (newsnowSourceRegistry) Lookup(sourceID string) (newsnowsources.SourceMeta, bool) {
	meta, ok := newsnowclusteringops.LookupSourceMetadata(sourceID)
	if !ok {
		return newsnowsources.SourceMeta{}, false
	}
	return newsnowsources.SourceMeta{
		ID:       meta.ID,
		Redirect: meta.Redirect,
		Interval: meta.Interval,
	}, true
}

// wireNewsnowSources registers the two public source fetch routes only when
// API_GO_NEWSNOW_SOURCES_MODE=go. The unit is anonymous: it needs MySQL for the
// global runtime-secret row and Redis for the compatible cache, refresh lock and
// source-refresh relay, but no JWT authenticator, Mongo or queue.
func wireNewsnowSources(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
) (*newsnowsources.Service, error) {
	if db == nil || redisClient == nil {
		return nil, fmt.Errorf("api-go: newsnow sources go takeover requires mysql and redis")
	}

	secrets := infrastructuresettings.NewRuntimeSecretReader(
		db, cfg.SettingsEncryptionKeyRaw, cfg.SettingsEncryptionKeyPresent)
	service := newsnowsources.NewService(newsnowsources.ServiceConfig{
		Registry: newsnowSourceRegistry{},
		Secrets:  secrets,
		Store:    newsnowsources.NewRedisStore(redisClient),
		Env:      os.Getenv,
	})
	handler := newsnowsources.NewHandler(service)
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.NewsnowSourcesKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: newsnow source fetch takeover mode=%s", "go")
	return service, nil
}
