package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/gdeltsnapshot"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/platformgovernance"
	"github.com/wei500L/newwei/apps/api-go/internal/situationsettings"
	"github.com/wei500L/newwei/apps/api-go/internal/situationsettings/telegramsched"
	"github.com/wei500L/newwei/apps/api-go/internal/situationsignals"
	"github.com/wei500L/newwei/apps/api-go/internal/telegramclient"
)

// wireSituationTelegramAuth registers the two situation-monitor Telegram login
// POSTs only when API_GO_SITUATION_TELEGRAM_AUTH_MODE=go. Every other value
// (including the default legacy) registers nothing, so rollback is a single
// variable change plus a restart.
//
// The takeover serves exactly POST .../telegram-auth/start and .../complete; the
// settings CRUD, DELETE telegram-auth and every other sub-path keep their
// existing owner. It shares the process-wide MySQL, Redis and Mongo clients with
// the settings unit and starts no worker.
func wireSituationTelegramAuth(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	mongoConn **dashboardstats.Connection,
	authenticator *authhttp.Authenticator,
) error {
	if cfg.SituationTelegramAuthMode != config.SituationTelegramAuthModeGo {
		return nil
	}
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: situation Telegram auth takeover requires mysql, redis, and jwt")
	}
	if mongoConn == nil {
		return fmt.Errorf("api-go: situation Telegram auth takeover requires a mongo connection slot")
	}
	if *mongoConn == nil {
		conn, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			return fmt.Errorf("api-go: situation Telegram auth takeover requires a valid MONGO_URI: %w", err)
		}
		*mongoConn = conn
	}
	mongoDatabase := (*mongoConn).Database()

	// The login handler writes the same settings row as the settings unit, so it
	// uses the identical environment-derived configuration (including the
	// system-settings:v1 encryption key) and the same service instance type.
	settings := situationsettings.NewService(situationsettings.Options{
		DB:    db,
		Redis: redisClient,
		Env:   situationsettings.NewEnvFromLookup(os.LookupEnv),
	})
	external := gdeltsnapshot.NewService(gdeltsnapshot.Options{
		DB:           db,
		Redis:        redisClient,
		GDeltEnabled: cfg.SituationMonitorGdeltEnabled,
	})
	settingsReader := situationsignals.NewSettingsReader(db, redisClient, os.LookupEnv)
	quality := situationsignals.NewQualitySummaryService(db, redisClient, mongoDatabase, settingsReader)

	handler := situationsettings.NewTelegramAuthHandler(situationsettings.TelegramAuthHandlerOptions{
		Auth:              platformgovernance.NewAuthenticator(authenticator, db),
		Settings:          settings,
		Telegram:          telegramAuthClientFactory{},
		Redis:             redisClient,
		TrustProxy:        cfg.TrustProxy,
		RateLimitFailOpen: cfg.RateLimitFailOpen,
		External:          external,
		Quality:           quality,
		Scheduler:         telegramsched.New(redisClient),
	})

	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.SituationTelegramAuthKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.ServeLegacy(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: situation-monitor Telegram auth takeover mode=%s", cfg.SituationTelegramAuthMode)
	return nil
}

// telegramAuthClientFactory adapts internal/telegramclient to the
// situationsettings.TelegramAuthClientFactory interface. The settings package
// deliberately defines its own narrow client interface so it does not import
// the MTProto implementation.
type telegramAuthClientFactory struct{}

// NewTemporary starts one temporary MTProto client. An empty session string is
// a fresh unauthenticated session (startAuth); a pending GramJS session string
// resumes the login (completeAuth). The returned client is already connected,
// so a dial failure maps onto the NestJS connect() error path.
func (telegramAuthClientFactory) NewTemporary(ctx context.Context, apiID int, apiHash, sessionString string) (situationsettings.TelegramAuthClient, error) {
	var session telegramclient.Session
	if sessionString != "" {
		decoded, err := telegramclient.DecodeStringSession(sessionString)
		if err != nil {
			return nil, fmt.Errorf("api-go: decode pending telegram session: %w", err)
		}
		session = decoded
	}
	client, err := telegramclient.New(telegramclient.Options{
		APIID:   apiID,
		APIHash: apiHash,
		Session: session,
	})
	if err != nil {
		return nil, err
	}
	if err := client.Start(ctx); err != nil {
		client.Close()
		return nil, err
	}
	return &telegramAuthAdapter{client: client}, nil
}

// telegramAuthAdapter maps the MTProto client onto the settings package's
// narrow login interface and normalizes the two control-flow outcomes the HTTP
// layer distinguishes: 2FA required and sign-up required.
type telegramAuthAdapter struct {
	client *telegramclient.Client
}

func (a *telegramAuthAdapter) SendCode(ctx context.Context, phone string) (situationsettings.TelegramSentCode, error) {
	sent, err := a.client.SendCode(ctx, phone)
	if err != nil {
		return situationsettings.TelegramSentCode{}, mapTelegramAuthError(err)
	}
	return situationsettings.TelegramSentCode{
		PhoneCodeHash: sent.PhoneCodeHash,
		CodeViaApp:    sent.CodeViaApp,
	}, nil
}

func (a *telegramAuthAdapter) SignIn(ctx context.Context, phone, phoneCodeHash, code string) error {
	return mapTelegramAuthError(a.client.SignIn(ctx, phone, phoneCodeHash, code))
}

func (a *telegramAuthAdapter) SignInWithPassword(ctx context.Context, password string) error {
	return mapTelegramAuthError(a.client.SignInWithPassword(ctx, password))
}

func (a *telegramAuthAdapter) ExportStringSession() (string, error) {
	return a.client.ExportStringSession()
}

func (a *telegramAuthAdapter) Close() {
	a.client.Close()
}

// mapTelegramAuthError preserves the original error chain (so tgerr
// classification still works) while translating the two control-flow sentinels
// into the settings package's equivalents.
func mapTelegramAuthError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, telegramclient.ErrPasswordNeeded) {
		return fmt.Errorf("%w: %w", situationsettings.ErrTelegramPasswordNeeded, err)
	}
	if errors.Is(err, telegramclient.ErrSignUpRequired) {
		return fmt.Errorf("%w: %w", situationsettings.ErrTelegramSignUpRequired, err)
	}
	return err
}
