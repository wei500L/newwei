package main

import (
	"database/sql"
	"fmt"
	"log"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/auditoutbox"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
)

// wireAuditOutbox builds the audit-log outbox replay scheduler when
// API_GO_AUDIT_OUTBOX_MODE=go. It registers no HTTP route and requires no JWT:
// the scheduler reads and writes MySQL and takes its cron lease in Redis.
//
// SCHEDULE_ENABLED=false keeps the ownership switch as configured but starts
// nothing, so no process replays this chain. The returned scheduler is started
// by main and closed before the shared Redis/MySQL connections are closed.
func wireAuditOutbox(cfg config.Config, db *sql.DB, redisClient *redis.Client) (*auditoutbox.Scheduler, error) {
	if cfg.AuditOutboxMode != config.AuditOutboxModeGo {
		return nil, nil
	}
	if !cfg.ScheduleEnabled {
		log.Printf("api-go: audit log outbox scheduler not started (SCHEDULE_ENABLED=false)")
		return nil, nil
	}
	if db == nil || redisClient == nil {
		return nil, fmt.Errorf("api-go: API_GO_AUDIT_OUTBOX_MODE=go requires mysql and redis")
	}
	scheduler := auditoutbox.NewScheduler(auditoutbox.Deps{
		Repository: auditoutbox.NewMySQLRepository(db),
		Locks:      auditoutbox.NewRedisLockStore(redisClient),
	})
	log.Printf("api-go: audit log outbox scheduler enabled mode=%s", cfg.AuditOutboxMode)
	return scheduler, nil
}
