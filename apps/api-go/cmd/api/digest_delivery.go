package main

import (
	"database/sql"
	"fmt"
	"log"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authlogin"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/runtimesettings"
	"github.com/wei500L/newwei/apps/api-go/internal/userdigest"
)

// wireDigestDelivery builds the background daily-digest delivery scheduler when
// API_GO_USER_DIGEST_DELIVERY_MODE=go. It registers no HTTP route and requires
// no JWT: the scheduler reads MySQL, Redis, Mongo and the real SMTP transport,
// and reuses the same digest service the HTTP handler uses when both are go.
//
// The returned scheduler is started by main and closed before the shared Redis
// and Mongo connections are closed.
func wireDigestDelivery(
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	digestService *userdigest.Service,
) (*userdigest.DeliveryScheduler, error) {
	if db == nil || redisClient == nil || digestService == nil {
		return nil, fmt.Errorf("api-go: user digest delivery go mode requires mysql, redis, and the digest service")
	}
	mail := authlogin.NewMailSender(authlogin.SMTPConfig{
		Host:                  cfg.SMTP.Host,
		Port:                  cfg.SMTP.Port,
		Secure:                cfg.SMTP.Secure,
		User:                  cfg.SMTP.User,
		Pass:                  cfg.SMTP.Pass,
		From:                  cfg.SMTP.From,
		Pool:                  cfg.SMTP.Pool,
		ConnectionTimeoutMs:   cfg.SMTP.ConnectionTimeoutMs,
		GreetingTimeoutMs:     cfg.SMTP.GreetingTimeoutMs,
		SocketTimeoutMs:       cfg.SMTP.SocketTimeoutMs,
		TLSRejectUnauthorized: cfg.SMTP.TLSRejectUnauthorized,
	})
	store := userdigest.NewRedisDeliveryStore(redisClient)
	scheduler := userdigest.NewDeliveryScheduler(userdigest.DeliverySchedulerDeps{
		Repository:     userdigest.NewMySQLDeliveryRepository(db),
		Store:          store,
		Digest:         digestService,
		Mail:           mail,
		Notifier:       userdigest.NewDeliveryNotifier(db, store),
		Settings:       runtimesettings.NewService(db, redisClient, runtimesettings.Config{}),
		ConsoleBaseURL: cfg.NextAuthURL,
	})
	log.Printf("api-go: user digest delivery scheduler enabled mode=%s", "go")
	return scheduler, nil
}
