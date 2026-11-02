package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/accountsecurity"
	"github.com/wei500L/newwei/apps/api-go/internal/analysisexport"
	"github.com/wei500L/newwei/apps/api-go/internal/authn"
	"github.com/wei500L/newwei/apps/api-go/internal/authz"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/newsevents"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/newsbehavior"
)

// wireAnalysisExport registers the two analysis CSV export POST routes only when
// API_GO_ANALYSIS_EXPORT_MODE=go. Every other value (including the default
// legacy and the empty string) registers nothing, so both routes keep flowing
// through the NestJS proxy and rollback is a single variable change.
//
// The unit builds its own item reading service, personalization provider and
// news-event reader: the export must not depend on the item reading REST /
// GraphQL switches being go, and the two CSV routes are the only entry points
// this switch owns. POST /api/analysis/exports/search is never registered.
//
// Authentication reuses the machine-token capable chain (human JWT, shared
// Redis revocation list, MySQL membership re-derivation and the mtk_ path);
// the analysis.write gate is enforced by the handler for both routes. The
// shared Mongo connection is opened only when no other unit already opened one
// and is handed back through mongoConn so the single shutdown path closes it.
func wireAnalysisExport(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	mongoConn **dashboardstats.Connection,
) error {
	if db == nil || redisClient == nil {
		return fmt.Errorf("api-go: analysis export go takeover requires mysql, jwt, and redis")
	}
	if mongoConn == nil || *mongoConn == nil {
		conn, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			return fmt.Errorf("api-go: analysis export go takeover requires a valid MONGO_URI")
		}
		*mongoConn = conn
	}

	verifier := authn.NewVerifier(cfg.JWTSecret, cfg.JWTIssuer, cfg.JWTAudience)
	blacklist := authn.NewRedisBlacklist(redisClient)
	authenticator := accountsecurity.NewAuthenticator(verifier, blacklist, authz.NewMySQLRepository(db), db)

	itemService := itemsreading.NewService(itemsreading.Options{
		DB:    db,
		Mongo: (*mongoConn).Database(),
		Redis: redisClient,
		// The candidate selection keeps the interactive read-model, vector and
		// rerank configuration; only the page size differs (5000 instead of 50).
		ReadModelEnabled:      cfg.ItemsReadModelEnabled,
		VectorHardFailEnabled: cfg.ItemsVectorHardFailEnabled,
		// The PERSONALIZED ordering must read the caller's real profile, so the
		// behavior provider is always wired here.
		Personalization: newsbehavior.NewService(db, redisClient),
	})
	service := analysisexport.NewService(itemService, newsevents.NewExporter(db))

	policy := cors.New(cfg.CorsOrigin)
	register := func(key string, route analysisexport.Route) {
		handler := analysisexport.NewHandler(authenticator, service, route)
		gateway.RegisterGoHandler(key, func(w http.ResponseWriter, r *http.Request) {
			if policy.FinishOptions(w, r) {
				return
			}
			if r.Method == http.MethodOptions {
				gateway.Reject(w, r)
				return
			}
			handler.ServeHTTP(w, r)
		})
	}
	register(legacyproxy.AnalysisExportItemsKey, analysisexport.RouteItems)
	register(legacyproxy.AnalysisExportEventsKey, analysisexport.RouteEvents)
	log.Printf("api-go: analysis CSV export takeover (POST /api/analysis/exports/items, POST /api/analysis/exports/events; readModel=%t)", cfg.ItemsReadModelEnabled)
	return nil
}
