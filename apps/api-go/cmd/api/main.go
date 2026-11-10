// api-go is the main backend Go runtime (GO-ONLY-RUNTIME-001 no longer proxies
// to NestJS).
//
// The process owns every implemented HTTP/GraphQL/Socket.IO entrypoint and the
// async execution: the route table is assembled by httproute.AllRoutes() and
// matched requests run the registered Go handler; an unmatched method/path is
// answered by the gateway with a Nest-compatible 404 (CORS/trace/exception
// recording preserved). There is no reverse proxy, shadow comparison or canary
// routing, and no API_GO_*_MODE migration switch.
//
// The retained execution gates (independent of entrypoint ownership):
//   - SCHEDULE_ENABLED: cross-process scheduling/Cron/Outbox replay;
//   - BULLMQ_WORKERS_ENABLED: BullMQ queue workers;
//   - WS_REDIS_ADAPTER_ENABLED / GRAPHQL_SUBSCRIPTION_BUS: realtime multi-instance bus.
//
// Real resources (DATABASE_URL/REDIS/JWT/Mongo/SMTP/encryption keys) and the
// auth/tenant checks stay in force. Node backend source remains for now (removed
// by GO-NODE-RETIRE-001); Go has no mode fallback.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/authn"
	"github.com/wei500L/newwei/apps/api-go/internal/authz"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlmetadata"
	"github.com/wei500L/newwei/apps/api-go/internal/economicdata"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/policy"
	"github.com/wei500L/newwei/apps/api-go/internal/health"
	"github.com/wei500L/newwei/apps/api-go/internal/httproute"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsingest"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
	"github.com/wei500L/newwei/apps/api-go/internal/metrics"
	"github.com/wei500L/newwei/apps/api-go/internal/notificationssocket"
	"github.com/wei500L/newwei/apps/api-go/internal/platform/mongodb"
	"github.com/wei500L/newwei/apps/api-go/internal/platform/mysqldb"
	"github.com/wei500L/newwei/apps/api-go/internal/platform/outbound"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
	"github.com/wei500L/newwei/apps/api-go/internal/realtimesocket"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettingsread"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettingswrite"
	"github.com/wei500L/newwei/apps/api-go/internal/vectorclient"
)

func main() {
	// healthcheck subcommand: in-container liveness probe (distroless has no
	// curl/wget, so the production image probes itself with this same binary; see
	// infra/docker/api-go.Dockerfile). Only argv[1] == "healthcheck" enters it.
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(runHealthcheck())
	}
	if err := run(); err != nil {
		log.Fatalf("api-go: %v", err)
	}
}

// runHealthcheck GETs /__go/healthz on the process listen address with a short
// timeout. The return value is the exit code: 2xx -> 0; any other status,
// connection failure or timeout -> 1. It reads/prints no env, DSN or token.
func runHealthcheck() int {
	port := "4020"
	if raw := strings.TrimSpace(os.Getenv("PORT")); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil && value > 0 {
			port = raw
		}
	}
	client := outbound.NewClient(3 * time.Second)
	resp, err := client.Get("http://127.0.0.1:" + port + "/__go/healthz")
	if err != nil {
		fmt.Fprintln(os.Stderr, "api-go healthcheck: request failed")
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		fmt.Fprintf(os.Stderr, "api-go healthcheck: unexpected status %d\n", resp.StatusCode)
		return 1
	}
	return 0
}

// closerFunc is one entry in the process teardown stack.
type closerFunc func(context.Context) error

// closerStack executes its entries in reverse registration order: a resource
// registered before its dependents is closed after them.
type closerStack struct {
	items []closerFunc
}

func (s *closerStack) push(fn closerFunc) { s.items = append(s.items, fn) }

func (s *closerStack) run(ctx context.Context) {
	for i := len(s.items) - 1; i >= 0; i-- {
		if err := s.items[i](ctx); err != nil {
			log.Printf("api-go: resource close: %v", err)
		}
	}
}

func run() error {
	cfg, err := config.LoadFromOS()
	if err != nil {
		return err
	}

	// GO-ONLY runtime: api-go owns every entrypoint directly. One process-wide
	// MySQL pool, one Redis client and one Mongo client are opened here and handed
	// to every domain assembly; nothing opens a second pool or client.
	sharedDB, err := mysqldb.Open(cfg.DatabaseURL, mysqldb.PoolConfig{
		MaxOpenConns:    cfg.DatabaseMaxOpenConns,
		MaxIdleConns:    cfg.DatabaseMaxIdleConns,
		ConnMaxLifetime: time.Duration(cfg.DatabaseConnMaxLifetimeSeconds) * time.Second,
	})
	if err != nil {
		return fmt.Errorf("api-go: requires a valid DATABASE_URL: %w", err)
	}
	userSettingsRepo := usersettings.NewMySQLRepository(sharedDB)

	redisOptions := newRedisOptions(cfg)
	redisClient := redis.NewClient(redisOptions)

	// Mongo is required by the always-on units (dashboard, items, GraphQL reads,
	// assistant, analysis, workers), so an unusable MONGO_URI fails startup. This
	// is the only place a Mongo client is opened.
	mongoClient, err := mongodb.Open(cfg.MongoURI)
	if err != nil {
		return fmt.Errorf("api-go: requires a valid MONGO_URI: %w", err)
	}

	closers := &closerStack{}
	// Push order is the reverse of close order: MySQL closes last, after Mongo and
	// Redis, so the units that hold those handles drain first.
	closers.push(func(context.Context) error { return sharedDB.Close() })
	closers.push(func(ctx context.Context) error { return mongoClient.Disconnect(ctx) })
	closers.push(func(context.Context) error { return redisClient.Close() })
	// Installed early so every later error path still closes the shared resources.
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		closers.run(closeCtx)
	}()

	rules := httproute.AllRoutes()
	gateway := httproute.New(rules)
	// The process-wide vector-service circuit state shared by the search client,
	// the two upsert clients and the C-5 diagnostics route.
	vectorServiceHealth := &vectorclient.Health{}

	// Shared auth stack: JWT verify + Redis blacklist -> MySQL membership/RBAC
	// re-derivation over the same pool.
	verifier := authn.NewVerifier(cfg.JWTSecret, cfg.JWTIssuer, cfg.JWTAudience)
	blacklist := authn.NewRedisBlacklist(redisClient)
	machines := authhttp.NewMachineResolver(sharedDB, nil)
	authenticator := authhttp.NewAuthenticator(verifier, blacklist, authz.NewMySQLRepository(sharedDB), machines)

	// GDELT snapshot unit shared by the optional scheduler and forced-refresh route.
	gdeltSnapshot := newGdeltSnapshotUnit(cfg, sharedDB, redisClient)
	if gdeltSnapshot != nil {
		log.Printf("api-go: situation-monitor GDELT snapshot unit configured")
	}

	// HTTP GraphQL and the WebSocket executor share one limiter instance so their
	// local circuit-breaker state cannot disagree about the same Redis bucket.
	graphqlLimiter := policy.NewLimiter(redisClient, cfg.RateLimitLogin, cfg.RateLimitLoginWindow, cfg.RateLimitFailOpen).WithSettingsReader(policy.NewMySQLSettingsReader(sharedDB))
	// The HTTP POST and the GraphQL root share one metadata service instance.
	metadataService := crawlmetadata.NewService(sharedDB, redisClient)
	// The crawl task lifecycle producer is built once and reuses the shared Redis.
	crawlTaskService := newCrawlTaskWriteService(cfg, sharedDB, redisClient)

	// user-settings read/write handlers over the shared pool.
	readHandler := usersettingsread.NewHandler(authenticator, userSettingsRepo)
	writeHandler := usersettingswrite.NewHandler(authenticator, userSettingsRepo)
	corsPolicy := cors.New(cfg.CorsOrigin)
	for _, path := range usersettingsread.Paths {
		gateway.Handle(path, func(w http.ResponseWriter, r *http.Request) {
			if corsPolicy.FinishOptions(w, r) {
				return
			}
			if r.Method == http.MethodOptions {
				gateway.Reject(w, r)
				return
			}
			if r.Method == http.MethodPut {
				writeHandler.ServeHTTP(w, r)
				return
			}
			readHandler.ServeHTTP(w, r)
		})
	}
	log.Printf("api-go: user-settings read GET(s) and PUT write under go takeover (JWT + Redis blacklist + MySQL RBAC; issuer=%s)", cfg.JWTIssuer)

	// Public home/channel/story detail: anonymous, no JWT/RBAC.
	portal := publicportal.NewHandler(publicportal.NewMySQLStore(sharedDB), publicportal.WithGatewayEnv(publicportal.GatewayEnv{
		EncryptionKey: cfg.SettingsEncryptionKey,
		APIBase:       cfg.LiteLLMAPIBase,
		APIKey:        cfg.LiteLLMAPIKey,
		TimeoutMs:     cfg.LiteLLMTimeoutMs,
		MaxRetries:    cfg.LiteLLMMaxRetries,
	}))
	gateway.Handle("/api/public-portal/home", portal.ServeHome)
	gateway.Handle("/api/public-portal/channels/", portal.ServeChannel)
	gateway.Handle("/api/public-portal/stories/id/", portal.ServeStoryByID)
	gateway.Handle("/api/public-portal/stories/slug/", portal.ServeStoryBySlug)
	log.Printf("api-go: public portal home, channel and story detail under go takeover")

	// Dashboard: stats, charts, war map, spacetime, stream and authenticated healthz.
	streamHandler, readyHandler, err := wireDashboard(gateway, cfg, sharedDB, redisClient, authenticator, mongoClient)
	if err != nil {
		return err
	}
	closers.push(func(ctx context.Context) error {
		if readyHandler != nil {
			readyHandler.Close(ctx)
		}
		return nil
	})

	digestService, err := wirePersonalNews(gateway, cfg, sharedDB, redisClient, authenticator, mongoClient)
	if err != nil {
		return err
	}
	archiveReadingService, err := wireArchiveReadingHTTP(gateway, cfg, sharedDB, redisClient, mongoClient, authenticator)
	if err != nil {
		return err
	}
	if err := wireAnalysisCollaboration(gateway, cfg, sharedDB, authenticator); err != nil {
		return err
	}
	if err := wireAnalysisExport(gateway, cfg, sharedDB, redisClient, mongoClient, authenticator); err != nil {
		return err
	}
	if err := wireSituationMonitors(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := gdeltSnapshot.RegisterRoute(gateway, cfg, sharedDB, authenticator); err != nil {
		return err
	}
	if err := wireNewsSources(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := wireCrawlWorkflows(gateway, cfg, sharedDB, authenticator); err != nil {
		return err
	}
	if err := wireCrawlProfiles(gateway, cfg, sharedDB, authenticator); err != nil {
		return err
	}
	if err := wireCrawlFrontierRuns(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := wireCrawlFrontierWrites(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := wireRbac(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := wireCrawlTemplates(gateway, cfg, sharedDB, authenticator); err != nil {
		return err
	}
	if err := wireLlmLogs(gateway, cfg, sharedDB, authenticator, mongoClient); err != nil {
		return err
	}
	if err := wireAdminLogs(gateway, cfg, sharedDB, redisClient, authenticator, mongoClient); err != nil {
		return err
	}
	if err := wireExceptionIngest(gateway, cfg, sharedDB, redisClient, authenticator, mongoClient); err != nil {
		return err
	}

	// C-1/C-7/C-9: the recorder is shared by the reject fallback 404 and the Go
	// /docs 404 so both write the same exception event.
	nestNotFoundRecorder := newNestNotFoundRecorder(cfg, mongoClient, redisClient)
	gateway.SetNotFound(cors.New(cfg.CorsOrigin), nestNotFoundRecorder)
	if err := wireAPIDocs(gateway, cfg, cors.New(cfg.CorsOrigin), nestNotFoundRecorder); err != nil {
		return err
	}
	// REST and GraphQL exception side channel. Built on first use; the shared Mongo
	// client is owned by main.
	exceptions := newExceptionRecorder(cfg, mongoClient, redisClient)
	authhttp.SetExceptionRecorder(exceptions.rest)
	closers.push(func(ctx context.Context) error {
		exceptions.wait(ctx, exceptionRecordTimeout)
		return nil
	})

	if err := wireNewsIndicators(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := wireQualityOverview(gateway, cfg, sharedDB, redisClient, authenticator, mongoClient); err != nil {
		return err
	}
	if err := wireClassificationRssOps(gateway, cfg, sharedDB, redisClient, authenticator, mongoClient); err != nil {
		return err
	}
	qualityOps, err := wireQualityOps(gateway, cfg, sharedDB, redisClient, authenticator, mongoClient)
	if err != nil {
		return err
	}
	if qualityOps != nil {
		closers.push(func(ctx context.Context) error { return qualityOps.Close(ctx) })
	}
	if err := wireNewsnowClusteringOps(gateway, cfg, sharedDB, redisClient, authenticator, mongoClient); err != nil {
		return err
	}
	newsnowSourcesService, err := wireNewsnowSources(gateway, cfg, sharedDB, redisClient)
	if err != nil {
		return err
	}
	if newsnowSourcesService != nil {
		closers.push(func(context.Context) error { newsnowSourcesService.CloseIdleConnections(); return nil })
	}
	newsnowHottestUnit, err := newNewsnowHottestUnit(gateway, cfg, sharedDB, redisClient, authenticator, mongoClient, newsnowSourcesService)
	if err != nil {
		return err
	}
	if newsnowHottestUnit != nil {
		closers.push(func(ctx context.Context) error { return newsnowHottestUnit.Close(ctx) })
	}
	if err := wireCrawlMetadata(gateway, cfg, metadataService, authenticator); err != nil {
		return err
	}
	if err := wireCrawlDiscovery(gateway, cfg, sharedDB, redisClient, metadataService, authenticator); err != nil {
		return err
	}
	// The runtime storage configuration reader is shared by the REST media signing
	// path, the GraphQL crawlTask root and the storage diagnostics handler.
	storageConfigReader := newInfrastructureSettingsService(cfg, sharedDB, redisClient)
	if err := wireCrawlReadTelemetry(gateway, cfg, sharedDB, redisClient, authenticator, storageConfigReader, mongoClient); err != nil {
		return err
	}
	wireCrawlTaskLifecycle(gateway, cfg, crawlTaskService, authenticator)
	searchReindexService, err := wireSearchReindex(gateway, cfg, sharedDB, redisClient, authenticator, mongoClient)
	if err != nil {
		return err
	}
	if searchReindexService != nil {
		closers.push(func(context.Context) error { searchReindexService.Close(); return nil })
	}
	if err := wireRuntimeSettings(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := wirePlatformGovernanceSettings(gateway, cfg, sharedDB, redisClient, mongoClient, authenticator); err != nil {
		return err
	}
	if err := wireLLMGatewayProfiles(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := wireLLMGatewayOps(gateway, cfg, sharedDB, redisClient, authenticator, mongoClient); err != nil {
		return err
	}
	if err := wireInfrastructureSettings(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := wireVectorDiagnostics(gateway, cfg, sharedDB, redisClient, authenticator, vectorServiceHealth); err != nil {
		return err
	}
	if err := wireStorageDiagnostics(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := wireDataRuntimeSettings(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		log.Printf("api-go: data runtime settings wiring skipped: %v", err)
	}
	if err := wireEmailSettings(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := wireGeocoding(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := wireRuntimeDiagnostics(gateway, cfg, sharedDB, redisClient, authenticator, mongoClient); err != nil {
		return err
	}
	if err := wireAuthFactors(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := wireAccountSecurity(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := wireAccountData(gateway, cfg, sharedDB, redisClient, mongoClient, authenticator); err != nil {
		return err
	}
	if err := wireAuthLogin(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := wireOIDCLogin(gateway, cfg, sharedDB, redisClient); err != nil {
		return err
	}
	if err := wireIdentityOnboarding(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := wireModelAccessSettings(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := wireSituationSignals(gateway, cfg, sharedDB, redisClient, mongoClient, authenticator); err != nil {
		return err
	}
	if err := wireSituationInsights(gateway, cfg, sharedDB, redisClient, mongoClient, authenticator); err != nil {
		return err
	}
	if err := wireProxyLoadBalancing(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	economicService, economicRuntime, err := wireEconomicData(gateway, cfg, sharedDB, redisClient, authenticator, mongoClient)
	if err != nil {
		return err
	}
	if err := wireSituationSettings(gateway, cfg, sharedDB, redisClient, mongoClient, authenticator, economicService); err != nil {
		return err
	}
	if err := wireSituationTelegramAuth(gateway, cfg, sharedDB, redisClient, mongoClient, authenticator); err != nil {
		return err
	}

	// /__go/healthz: liveness probe + route-table introspection. Renders only
	// stable process facts, never migration mode values.
	gateway.HandleProcessHealth(func(w http.ResponseWriter, _ *http.Request) {
		streamActive, streamCycles := int64(0), int64(0)
		if streamHandler != nil {
			streamActive, streamCycles = streamHandler.Stats()
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{
			"ok":           true,
			"routeCount":   len(gateway.Rules()),
			"streamActive": streamActive,
			"streamCycles": streamCycles,
			"database":     "configured",
		})
	})
	gateway.Handle("/api/healthz/live", health.LiveHandler)

	// The items write service is shared by the HTTP POST, the five mutations,
	// immediate outbox delivery and the scheduled replay owner.
	if err := validateItemsIngestResources(cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	itemsIngestService := buildItemsIngestService(cfg, sharedDB, redisClient, mongoClient.Database())

	newsSourceScheduler, err := wireNewsSourceScheduler(
		gateway, cfg, sharedDB, redisClient, authenticator,
		itemsIngestService, crawlTaskService, mongoClient,
	)
	if err != nil {
		return err
	}
	if newsSourceScheduler != nil {
		closers.push(func(ctx context.Context) error { return newsSourceScheduler.Close(ctx) })
	}

	// Assistant write mutations and worker share one service instance.
	assistantRunService, err := wireAssistantRuns(cfg, sharedDB, redisClient, mongoClient)
	if err != nil {
		return err
	}

	graphqlHandler, err := wireGraphQL(
		gateway, cfg, sharedDB, redisClient, authenticator, mongoClient,
		graphqlLimiter, archiveReadingService, metadataService, storageConfigReader,
		itemsIngestService, assistantRunService, economicService, crawlTaskService, exceptions,
	)
	if err != nil {
		return err
	}
	if graphqlHandler != nil {
		closers.push(func(context.Context) error { graphqlHandler.Close(); return nil })
	}

	itemsReadingService := itemsreading.NewService(itemsreading.Options{
		DB:                    sharedDB,
		Mongo:                 mongoClient.Database(),
		Redis:                 redisClient,
		ReadModelEnabled:      cfg.ItemsReadModelEnabled,
		VectorHardFailEnabled: cfg.ItemsVectorHardFailEnabled,
	})
	itemsReadingHandler := itemsreading.NewHandler(authenticator, sharedDB, itemsReadingService)
	itemsReadingCORS := cors.New(cfg.CorsOrigin)
	gateway.Handle(httproute.ItemsReadingKey, func(w http.ResponseWriter, r *http.Request) {
		if itemsReadingCORS.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		itemsReadingHandler.ServeHTTP(w, r)
	})
	log.Printf("api-go: item reading REST routes under go takeover (GET /api/items, GET /api/items/:id; readModel=%t)", cfg.ItemsReadModelEnabled)

	itemsIngestHandler := itemsingest.NewHandler(authenticator, sharedDB, itemsIngestService)
	registerItemsIngestHandler(gateway, cfg, itemsIngestHandler, itemsReadingHandler)
	log.Printf("api-go: item write REST route registered (POST /api/items)")

	// Realtime subscriptions executor. Needs the credentialed stack but no Mongo,
	// queue worker or HTTP read/write switch.
	if sharedDB == nil || authenticator == nil || redisClient == nil || graphqlLimiter == nil || redisOptions == nil {
		return errGraphQLSubscriptionsResources
	}
	graphqlSubscriptions, err := wireGraphQLSubscriptions(cfg, authenticator, redisClient, graphqlLimiter, redisOptions)
	if err != nil {
		return err
	}
	if graphqlSubscriptions != nil {
		closers.push(func(ctx context.Context) error { return graphqlSubscriptions.Close(ctx) })
	}
	log.Printf("api-go: GraphQL subscriptions under go (alertEvents, analysisEvents, assistantEvents, queueEvents; bus=%s)", cfg.GraphQLSubscriptionBus)

	// Notifications transport owns only /socket.io-notifications.
	if sharedDB == nil || redisClient == nil {
		return fmt.Errorf("api-go: notifications socket takeover requires mysql and redis")
	}
	notificationsSocket, err := notificationssocket.New(notificationssocket.Options{
		DB:                    sharedDB,
		Verifier:              authenticator.Verifier(),
		Blacklist:             authenticator.Blacklist(),
		Authz:                 authenticator.Authz(),
		Redis:                 redisClient,
		CORS:                  cors.New(cfg.CorsOrigin),
		TrustProxy:            strings.TrimSpace(cfg.TrustProxy) != "",
		MaxConnectionsPerUser: cfg.WSMaxConnectionsPerUser,
		MaxConnectionsPerIP:   cfg.WSMaxConnectionsPerIP,
		ConnectLimitPerIP:     cfg.WSConnectRateLimitPerIP,
		ConnectLimitPerUser:   cfg.WSConnectRateLimitPerUser,
		ConnectWindowSeconds:  cfg.WSConnectRateLimitWindowSeconds,
	})
	if err != nil {
		return err
	}
	gateway.Handle(notificationssocket.Path, notificationsSocket.ServeHTTP)
	closers.push(func(ctx context.Context) error { return notificationsSocket.Close(ctx) })
	log.Printf("api-go: notifications Socket.IO transport under go (%s, namespace %s)", notificationssocket.Path, notificationssocket.Namespace)

	// Realtime transport owns /socket.io-realtime and multiplexes five namespaces.
	if sharedDB == nil || redisClient == nil || redisOptions == nil {
		return errRealtimeSocketResources
	}
	realtimeSocket, err := wireRealtimeSocket(cfg, sharedDB, redisClient, redisOptions, mongoClient, authenticator)
	if err != nil {
		return err
	}
	gateway.Handle(realtimesocket.Path, realtimeSocket.runtime.ServeHTTP)
	closers.push(func(ctx context.Context) error { return realtimeSocket.Close(ctx) })
	log.Printf("api-go: realtime Socket.IO transport under go (%s, namespaces /newsnow /ops /quality /queue /situation-monitor)", realtimesocket.Path)

	// Classification quality alert cron.
	if sharedDB == nil || redisClient == nil {
		return errClassificationAlertResources
	}
	classificationAlert, err := wireClassificationAlert(cfg, sharedDB, redisClient, mongoClient)
	if err != nil {
		return err
	}
	closers.push(func(ctx context.Context) error { return classificationAlert.Close(ctx) })
	log.Printf("api-go: classification quality alert scheduler under go")

	if graphqlHandler != nil || graphqlSubscriptions != nil {
		entrypoint := graphqlEntrypoint(graphqlSubscriptions, graphqlHandler)
		gateway.Handle(graphqlread.Path, func(w http.ResponseWriter, r *http.Request) {
			r = r.WithContext(economicdata.WithRequestIP(r.Context(), economicRequestIP(r)))
			entrypoint(w, r)
		})
	}

	// Crawl maintenance crons (janitor, cleanup outbox, adaptive concurrency,
	// quality snapshot, audit retention).
	crawlMaintenance, err := wireCrawlMaintenance(cfg, sharedDB, redisClient, mongoClient)
	if err != nil {
		return err
	}
	if crawlMaintenance != nil {
		closers.push(func(ctx context.Context) error { return crawlMaintenance.Close(ctx) })
	}

	// Background units: constructed now, started after all construction succeeds.
	deliveryScheduler, err := wireDigestDelivery(cfg, sharedDB, redisClient, digestService)
	if err != nil {
		return err
	}
	if deliveryScheduler != nil {
		closers.push(func(ctx context.Context) error { return deliveryScheduler.Close(ctx) })
	}
	auditOutboxScheduler, err := wireAuditOutbox(cfg, sharedDB, redisClient)
	if err != nil {
		return err
	}
	if auditOutboxScheduler != nil {
		closers.push(func(ctx context.Context) error { return auditOutboxScheduler.Close(ctx) })
	}
	rawItemOutboxScheduler := wireRawItemOutboxScheduler(cfg, itemsIngestService, redisClient)
	if rawItemOutboxScheduler != nil {
		closers.push(func(ctx context.Context) error { return rawItemOutboxScheduler.Close(ctx) })
	}
	processedItemOutboxScheduler, err := wireProcessedItemOutbox(cfg, sharedDB, redisClient, mongoClient.Database(), vectorServiceHealth)
	if err != nil {
		return err
	}
	if processedItemOutboxScheduler != nil {
		closers.push(func(ctx context.Context) error { return processedItemOutboxScheduler.Close(ctx) })
	}
	kgIngestion, err := wireKGIngestion(cfg, sharedDB, redisClient, mongoClient)
	if err != nil {
		return err
	}
	closers.push(func(ctx context.Context) error { return kgIngestion.Close(ctx) })
	newsEventsIngestion, err := wireNewsEventsIngestion(cfg, sharedDB, redisClient, mongoClient)
	if err != nil {
		return err
	}
	closers.push(func(ctx context.Context) error { return newsEventsIngestion.Close(ctx) })
	newsBackfill, err := wireNewsBackfillJobs(gateway, cfg, sharedDB, redisClient, authenticator, mongoClient)
	if err != nil {
		return err
	}
	if newsBackfill != nil {
		closers.push(func(ctx context.Context) error { return newsBackfill.Close(ctx) })
	}
	archivePreparationWorker, err := wireArchivePreparationWorker(cfg, sharedDB, redisClient, mongoClient)
	if err != nil {
		return err
	}
	if archivePreparationWorker != nil {
		closers.push(func(ctx context.Context) error { return archivePreparationWorker.Close(ctx) })
	}
	itemPipelineWorker, err := wireItemPipelineWorker(cfg, sharedDB, redisClient, mongoClient, vectorServiceHealth)
	if err != nil {
		return err
	}
	if itemPipelineWorker != nil {
		closers.push(func(ctx context.Context) error { return itemPipelineWorker.Close(ctx) })
	}
	crawlWorker, err := wireCrawlWorker(cfg, sharedDB, redisClient, redisOptions, mongoClient)
	if err != nil {
		return err
	}
	if crawlWorker != nil {
		closers.push(func(ctx context.Context) error { return crawlWorker.Close(ctx) })
	}
	assistantWorker := startAssistantWorker(cfg, assistantRunService, redisClient)
	if assistantWorker != nil {
		closers.push(func(ctx context.Context) error { return assistantWorker.Close(ctx) })
	}
	realtimeSignals := newRealtimeSignalsUnit(cfg, sharedDB, redisClient, mongoClient)
	closers.push(func(ctx context.Context) error { return realtimeSignals.Close(ctx) })
	alertWorker, err := wireAlertWorker(cfg, sharedDB, redisClient, mongoClient)
	if err != nil {
		return err
	}
	if alertWorker != nil {
		closers.push(func(ctx context.Context) error { return alertWorker.Close(ctx) })
	}
	if err := wireQueueOps(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	queueOrgStats, err := wireQueueOrgStats(cfg, redisClient, redisOptions)
	if err != nil {
		return err
	}
	if queueOrgStats != nil {
		closers.push(func(ctx context.Context) error { return queueOrgStats.Close(ctx) })
	}
	situationSignalsWorker, err := wireSituationSignalsWorker(cfg, sharedDB, redisClient)
	if err != nil {
		return err
	}
	if situationSignalsWorker != nil {
		closers.push(func(ctx context.Context) error { return situationSignalsWorker.Close(ctx) })
	}
	if err := wireSituationRefresh(gateway, cfg, sharedDB, redisClient, mongoClient, authenticator,
		newsSourceScheduler, situationSignalsWorkerService(situationSignalsWorker)); err != nil {
		return err
	}
	eventTimelineSentiment, err := wireEventTimelineSentiment(cfg, sharedDB, redisClient, mongoClient)
	if err != nil {
		return err
	}
	closers.push(func(ctx context.Context) error { return eventTimelineSentiment.Close(ctx) })
	analysisWorker, err := startAnalysisWorker(cfg, sharedDB, redisClient, mongoClient)
	if err != nil {
		return err
	}
	if analysisWorker != nil {
		closers.push(func(ctx context.Context) error { return analysisWorker.Close(ctx) })
	}
	frontierLlmWorker, err := wireCrawlFrontierLlmWorker(cfg, sharedDB, redisClient, redisOptions, mongoClient)
	if err != nil {
		return err
	}
	if frontierLlmWorker != nil {
		closers.push(func(ctx context.Context) error { return frontierLlmWorker.Close(ctx) })
	}

	residualDuties, err := startResidualDuties(gateway, cfg, sharedDB, redisClient, redisOptions, authenticator, mongoClient, graphqlSubscriptions)
	if err != nil {
		return err
	}
	closers.push(func(ctx context.Context) error { return residualDuties.Close(ctx) })

	// Every route and handler is registered above; bind each rule to its handler
	// once and close registration before the listener starts. Registering a route
	// after this point is a programming error and panics.
	gateway.Freeze()

	// Start everything. Background units whose switch can be off are nil-guarded.
	if graphqlSubscriptions != nil {
		if err := graphqlSubscriptions.Start(context.Background()); err != nil {
			return err
		}
	}
	if err := notificationsSocket.Start(context.Background()); err != nil {
		return err
	}
	if err := realtimeSocket.Start(context.Background()); err != nil {
		return err
	}
	if classificationAlert != nil {
		classificationAlert.Start(context.Background())
	}
	if economicRuntime != nil {
		if err := economicRuntime.Start(context.Background()); err != nil {
			return err
		}
	}
	if deliveryScheduler != nil {
		deliveryScheduler.Start(context.Background())
	}
	if auditOutboxScheduler != nil {
		auditOutboxScheduler.Start(context.Background())
	}
	if rawItemOutboxScheduler != nil {
		rawItemOutboxScheduler.Start(context.Background())
	}
	if processedItemOutboxScheduler != nil {
		if !cfg.ScheduleEnabled {
			log.Printf("api-go: processed-item outbox scheduler not started (SCHEDULE_ENABLED=false)")
		} else {
			processedItemOutboxScheduler.Start(context.Background())
		}
	}
	if kgIngestion != nil {
		kgIngestion.scheduler.Start(context.Background())
	}
	if newsEventsIngestion != nil {
		newsEventsIngestion.scheduler.Start(context.Background())
	}
	if newsBackfill != nil {
		if err := newsBackfill.Start(context.Background()); err != nil {
			return err
		}
	}
	if archivePreparationWorker != nil {
		if err := archivePreparationWorker.Start(context.Background()); err != nil {
			return err
		}
	}
	if itemPipelineWorker != nil {
		if err := itemPipelineWorker.Start(context.Background()); err != nil {
			return err
		}
	}
	if crawlWorker != nil {
		if err := crawlWorker.Start(context.Background()); err != nil {
			return err
		}
	}
	gdeltSnapshot.Start(cfg)
	if newsnowHottestUnit != nil {
		newsnowHottestUnit.Start(cfg)
	}
	if newsSourceScheduler != nil {
		newsSourceScheduler.Start(context.Background())
	}
	if crawlMaintenance != nil {
		crawlMaintenance.Start(context.Background())
	}
	realtimeSignals.Start(cfg)
	if alertWorker != nil {
		if err := alertWorker.Start(context.Background()); err != nil {
			return err
		}
	}
	if queueOrgStats != nil {
		if err := queueOrgStats.Start(context.Background()); err != nil {
			return err
		}
	}
	if situationSignalsWorker != nil {
		if err := situationSignalsWorker.Start(context.Background()); err != nil {
			return err
		}
	}
	eventTimelineSentiment.Start(cfg)

	// HTTP middleware chain: security headers outside trace/metrics so they cover
	// the trace headers and every Go-written error.
	handler := authhttp.IdentityScope(httpx.SecurityHeadersMiddleware(httpx.MetricsMiddleware(
		httpx.TraceMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			gateway.ServeHTTP(w, r)
		})),
		func(observation httpx.HTTPObservation) {
			metrics.RecordHTTPRequestMetric(metrics.HTTPRequestInput{
				Method:     observation.Method,
				Route:      observation.Route,
				StatusCode: observation.StatusCode,
				DurationMS: float64(observation.Duration.Microseconds()) / 1000,
			})
		},
	)))
	server := &http.Server{
		Addr:              ":" + strconv.Itoa(cfg.Port),
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(stop)

	serverErr := make(chan error, 1)
	go func() {
		log.Printf("api-go: listening on %s", server.Addr)
		serverErr <- server.ListenAndServe()
	}()

	select {
	case err := <-serverErr:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case sig := <-stop:
		log.Printf("api-go: received %s, shutting down", sig)
		// Stop claiming crawl jobs before the HTTP drain so no new job starts while
		// the process is going away; in-flight jobs drain with renewed locks.
		if crawlWorker != nil {
			crawlCtx, cancelCrawl := context.WithTimeout(context.Background(), 30*time.Second)
			if closeErr := crawlWorker.Close(crawlCtx); closeErr != nil {
				log.Printf("api-go: crawl worker close: %v", closeErr)
			}
			cancelCrawl()
			crawlWorker = nil
		}
		// http.Server.Shutdown neither waits for nor closes hijacked WebSocket
		// connections; close the transports before the HTTP drain.
		closeCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if notificationsSocket != nil {
			if closeErr := notificationsSocket.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: notifications socket close: %v", closeErr)
			}
		}
		if classificationAlert != nil {
			if closeErr := classificationAlert.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: classification quality alert scheduler close: %v", closeErr)
			}
		}
		if realtimeSocket != nil {
			if closeErr := realtimeSocket.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: realtime socket close: %v", closeErr)
			}
		}
		if graphqlSubscriptions != nil {
			if closeErr := graphqlSubscriptions.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: graphql subscriptions close: %v", closeErr)
			}
		}
		if err := server.Shutdown(closeCtx); err != nil {
			return err
		}
		return nil
	}
}
