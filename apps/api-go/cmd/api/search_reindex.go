package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/adminlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/httproute"
	"github.com/wei500L/newwei/apps/api-go/internal/platform/mongodb"
	"github.com/wei500L/newwei/apps/api-go/internal/searchreindex"
)

// wireSearchReindex registers the two search index rebuild handlers only when
// API_GO_SEARCH_REINDEX_MODE=go. Legacy (including the empty value) registers
// nothing, so both paths keep proxying to NestJS.
//
// The MongoDB connection reuses the shared one and is opened on demand because
// the item read model lives in Mongo. The Redis client is the gateway's shared
// connection: the reindex job JSON, its organization list, the organization set
// and the "lock:search:reindex:org:<orgId>" lock are all shared with the NestJS
// implementation. The returned service owns the background rebuild context and
// must be closed on shutdown.
func wireSearchReindex(
	gateway *httproute.Router,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	authenticator *authhttp.Authenticator,
	mongoConn *mongodb.Client,
) (*searchreindex.Service, error) {
	if db == nil || redisClient == nil || authenticator == nil || cfg.JWTSecret == "" {
		return nil, fmt.Errorf("api-go: search reindex go takeover requires mysql, jwt, and redis")
	}
	// The global NestJS JwtAuthGuard resolves mtk_ machine tokens through
	// MachineTokenService. The admin logs service exposes the identical
	// lookup, so both endpoints accept the same credentials as NestJS.
	machines := adminlogs.NewService(db, nil)
	service := searchreindex.NewService(redisClient, mongoConn.Database(), machines)
	handler := searchreindex.NewHandler(authenticator, service)
	policy := cors.New(cfg.CorsOrigin)
	gateway.Handle(httproute.SearchReindexKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: search reindex takeover mode=%s", "go")
	return service, nil
}
