package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/economicdata"
	"github.com/wei500L/newwei/apps/api-go/internal/gdeltsnapshot"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/platformgovernance"
	"github.com/wei500L/newwei/apps/api-go/internal/situationsettings"
	"github.com/wei500L/newwei/apps/api-go/internal/situationsettings/telegramsched"
	"github.com/wei500L/newwei/apps/api-go/internal/situationsignals"
)

// wireSituationSettings registers the four situation-monitor settings entries
// only when API_GO_SITUATION_SETTINGS_MODE=go. Every other value (including the
// default legacy) registers nothing, so rollback is a single variable change
// plus a restart.
//
// The takeover shares the process-wide MySQL, Redis and Mongo clients. It
// starts no worker and never connects to Telegram or OREF: the Telegram
// authorization start/complete routes stay on NestJS.
func wireSituationSettings(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	mongoConn **dashboardstats.Connection,
	authenticator *authhttp.Authenticator,
	economic *economicdata.Service,
) error {
	if cfg.SituationSettingsMode != config.SituationSettingsModeGo {
		return nil
	}
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: situation settings go takeover requires mysql, redis, and jwt")
	}
	if mongoConn == nil {
		return fmt.Errorf("api-go: situation settings go takeover requires a mongo connection slot")
	}
	if *mongoConn == nil {
		conn, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			return fmt.Errorf("api-go: situation settings go takeover requires a valid MONGO_URI")
		}
		*mongoConn = conn
	}
	mongoDatabase := (*mongoConn).Database()

	env := situationsettings.NewEnvFromLookup(os.LookupEnv)
	service := situationsettings.NewService(situationsettings.Options{
		DB:    db,
		Redis: redisClient,
		Env:   env,
	})
	snapshotService := gdeltsnapshot.NewService(gdeltsnapshot.Options{
		DB:           db,
		Redis:        redisClient,
		GDeltEnabled: cfg.SituationMonitorGdeltEnabled,
	})
	settingsReader := situationsignals.NewSettingsReader(db, redisClient, os.LookupEnv)
	qualityService := situationsignals.NewQualitySummaryService(db, redisClient, mongoDatabase, settingsReader)

	if economic == nil {
		economic = economicdata.NewService(economicdata.Options{
			DB:    db,
			Redis: redisClient,
			Env: economicdata.Env{
				AkshareEnabled:        cfg.AkshareEnabled,
				AkshareBaseURL:        cfg.AkshareBaseURL,
				AkshareTimeout:        time.Duration(cfg.AkshareTimeoutMs) * time.Millisecond,
				AkshareMaxRetries:     cfg.AkshareMaxRetries,
				AkshareAdminToken:     cfg.AkshareAdminToken,
				QueueConcurrency:      cfg.AkshareQueueConcurrency,
				ScheduleSmoothing:     cfg.AkshareScheduleSmoothing,
				SkipUnchangedLatest:   cfg.AkshareSkipUnchangedLatest,
				SettingsEncryptionKey: cfg.SettingsEncryptionKey,
				RateLimitFailOpen:     cfg.RateLimitFailOpen,
			},
		})
	}

	handler := situationsettings.NewHandler(situationsettings.HandlerOptions{
		Auth:     platformgovernance.NewAuthenticator(authenticator, db),
		Service:  service,
		External: snapshotService,
		Quality:  qualityService,
		Telegram: telegramsched.New(redisClient),
		Economic: economic,
	})
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.SituationSettingsKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.ServeLegacy(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: situation-monitor settings takeover mode=%s", cfg.SituationSettingsMode)
	return nil
}
