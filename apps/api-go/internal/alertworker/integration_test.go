//go:build integration

// Alert worker integration tests against a real MySQL and Redis (the two
// services the CI `api-go-user-settings-integration` job provides).
//
// Coverage: the evaluation claim transaction (only one of two concurrent
// evaluations wins), the cooldown precheck, the delivery state machine including
// B1, the delayed/skipAttempt rate-limit semantics, the custom backoff, the
// pace-limiter keys, the O1/O2/B3 scan, and the two Redis bridges.
//
// Environment (CI injects them; missing values skip the test):
//
//	DATABASE_URL=mysql://root:secret@127.0.0.1:3306/<db>
//	API_GO_TEST_REDIS_ADDR=127.0.0.1:6379
//
// Mongo is not required: the fixtures use the MySQL-backed system_event
// provider, so the Mongo providers are never called.
package alertworker

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/alertworker/queue"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

const (
	itOrgID       = "org-it-alert"
	itOtherOrgID  = "org-it-alert-empty"
	itUserAllowed = "user-it-allowed"
	itUserDenied  = "user-it-denied"
	itRoleAllowed = "role-it-allowed"
	itRoleDenied  = "role-it-denied"
	itChannelID   = "channel-it-email"
	itRuleID      = "rule-it-system-event"
	itEmptyRuleID = "rule-it-cooldown"
	itQueuePrefix = "bull"
	itNamespace   = "it-alert"
)

func TestAlertWorkerIntegration(t *testing.T) {
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	redisAddr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if databaseURL == "" || redisAddr == "" {
		t.Skip("DATABASE_URL and API_GO_TEST_REDIS_ADDR are required for the alert worker integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	db, err := usersettings.OpenMySQLFromURL(databaseURL)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	defer db.Close()
	if err := createAlertWorkerSchema(ctx, db); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	if err := seedAlertWorkerFixtures(ctx, db); err != nil {
		t.Fatalf("seed fixtures: %v", err)
	}

	redisClient := redis.NewClient(&redis.Options{Addr: redisAddr})
	defer redisClient.Close()
	if err := redisClient.FlushDB(ctx).Err(); err != nil {
		t.Fatalf("flush redis: %v", err)
	}

	service, err := New(Options{
		DB:    db,
		Redis: redisClient,
		Config: Config{
			QueueConcurrency: 2,
			ScanIntervalMs:   300_000,
			// Zero rates disable the pace limiter so the state-machine subtests
			// decide their own scheduling.
			BullMQNamespace: itNamespace,
		},
	})
	if err != nil {
		t.Fatalf("build alert worker: %v", err)
	}

	t.Run("evaluate claims once and writes in-app + external deliveries", func(t *testing.T) {
		results := make(chan *EvaluateResult, 2)
		errs := make(chan error, 2)
		var wg sync.WaitGroup
		for attempt := 0; attempt < 2; attempt++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				result, err := service.EvaluateRule(ctx, itRuleID, itOrgID)
				results <- result
				errs <- err
			}()
		}
		wg.Wait()
		close(results)
		close(errs)
		for err := range errs {
			if err != nil {
				t.Fatalf("evaluate: %v", err)
			}
		}
		created := 0
		for result := range results {
			if result != nil {
				created++
			}
		}
		if created != 1 {
			t.Fatalf("concurrent evaluations created %d events, want exactly 1", created)
		}
		var events int
		if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM `AlertEvent` WHERE `ruleId` = ?", itRuleID).Scan(&events); err != nil {
			t.Fatalf("count events: %v", err)
		}
		if events != 1 {
			t.Fatalf("event rows = %d, want 1", events)
		}
		var external, inApp int
		if err := db.QueryRowContext(ctx,
			"SELECT COUNT(*) FROM `AlertDelivery` `d` JOIN `AlertEvent` `e` ON `e`.`id` = `d`.`eventId`"+
				" WHERE `e`.`ruleId` = ? AND `d`.`channelType` = 'email'", itRuleID).Scan(&external); err != nil {
			t.Fatalf("count external deliveries: %v", err)
		}
		if err := db.QueryRowContext(ctx,
			"SELECT COUNT(*) FROM `AlertDelivery` `d` JOIN `AlertEvent` `e` ON `e`.`id` = `d`.`eventId`"+
				" WHERE `e`.`ruleId` = ? AND `d`.`channelType` = 'in_app'", itRuleID).Scan(&inApp); err != nil {
			t.Fatalf("count in-app deliveries: %v", err)
		}
		if external != 1 || inApp != 1 {
			t.Fatalf("deliveries external=%d inApp=%d, want 1 and 1 (the denied member must be filtered)", external, inApp)
		}
		var status string
		var snapshot []byte
		if err := db.QueryRowContext(ctx,
			"SELECT `d`.`status`, `d`.`targetSnapshot` FROM `AlertDelivery` `d` JOIN `AlertEvent` `e` ON `e`.`id` = `d`.`eventId`"+
				" WHERE `e`.`ruleId` = ? AND `d`.`channelType` = 'in_app'", itRuleID).Scan(&status, &snapshot); err != nil {
			t.Fatalf("read in-app delivery: %v", err)
		}
		if status != DeliveryStatusSent {
			t.Fatalf("in-app delivery status = %q, want sent", status)
		}
		var target inAppTargetSnapshot
		if err := json.Unmarshal(snapshot, &target); err != nil {
			t.Fatalf("decode target snapshot: %v", err)
		}
		if target.UserID != itUserAllowed || target.NotificationID == "" {
			t.Fatalf("in-app snapshot = %+v", target)
		}
		var notifications int
		if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM `Notification` WHERE `id` = ? AND `orgId` = ? AND `userId` = ?",
			target.NotificationID, itOrgID, itUserAllowed).Scan(&notifications); err != nil {
			t.Fatalf("count notifications: %v", err)
		}
		if notifications != 1 {
			t.Fatalf("notification rows = %d, want 1", notifications)
		}
	})

	t.Run("cooldown precheck blocks an immediate second evaluation", func(t *testing.T) {
		result, err := service.EvaluateRule(ctx, itRuleID, itOrgID)
		if err != nil {
			t.Fatalf("evaluate: %v", err)
		}
		if result != nil {
			t.Fatal("the cooldown precheck must skip the evaluation")
		}
	})

	t.Run("cross-org channel is skipped (B2)", func(t *testing.T) {
		// A legacy AlertRuleChannel may point at a channel of another
		// organization. The evaluation must ignore it and record no delivery.
		if _, err := db.ExecContext(ctx,
			"INSERT IGNORE INTO `AlertNotificationChannel` (`id`,`orgId`,`type`,`name`,`target`,`config`,`isActive`) VALUES (?,?,?,?,?,?,?)",
			"channel-it-cross", itOtherOrgID, "email", "cross", "cross@example.com", []byte(`{}`), true); err != nil {
			t.Fatalf("insert cross-org channel: %v", err)
		}
		if _, err := db.ExecContext(ctx,
			"INSERT IGNORE INTO `AlertRuleChannel` (`id`,`ruleId`,`channelId`) VALUES (?,?,?)",
			"link-it-cross", itRuleID, "channel-it-cross"); err != nil {
			t.Fatalf("link cross-org channel: %v", err)
		}
		if _, err := db.ExecContext(ctx, "UPDATE `AlertRule` SET `lastTriggeredAt` = NULL WHERE `id` = ?", itRuleID); err != nil {
			t.Fatalf("reset cooldown: %v", err)
		}
		result, err := service.EvaluateRule(ctx, itRuleID, itOrgID)
		if err != nil {
			t.Fatalf("evaluate: %v", err)
		}
		if result == nil {
			t.Fatal("expected the rule to trigger")
		}
		if len(result.ExternalDeliveryIDs) != 1 {
			t.Fatalf("external deliveries = %d, want 1 (the cross-org channel must be skipped)", len(result.ExternalDeliveryIDs))
		}
		var crossDeliveries int
		if err := db.QueryRowContext(ctx,
			"SELECT COUNT(*) FROM `AlertDelivery` WHERE `eventId` = ? AND `channelId` = ?",
			result.Event.ID, "channel-it-cross").Scan(&crossDeliveries); err != nil {
			t.Fatalf("count cross-org deliveries: %v", err)
		}
		if crossDeliveries != 0 {
			t.Fatalf("cross-org deliveries = %d, want 0", crossDeliveries)
		}
	})

	t.Run("delivery failure marks the last attempt failed (B1)", func(t *testing.T) {
		eventID := "event-it-b1"
		deliveryID := "delivery-it-b1"
		if _, err := db.ExecContext(ctx,
			"INSERT INTO `AlertEvent` (`id`, `ruleId`, `triggeredAt`, `metricValue`, `changePercent`, `severity`, `status`, `message`, `context`, `createdAt`)"+
				" VALUES (?, ?, ?, ?, NULL, 'high', 'pending', 'boom', NULL, NOW(3))",
			eventID, itRuleID, time.Now().UTC(), "1.5"); err != nil {
			t.Fatalf("insert event: %v", err)
		}
		snapshot := []byte(`{"id":"` + itChannelID + `","type":"email","target":"ops@example.com","name":"ops","config":{}}`)
		if _, err := db.ExecContext(ctx,
			"INSERT INTO `AlertDelivery` (`id`, `eventId`, `channelId`, `channelType`, `targetSnapshot`, `status`, `createdAt`)"+
				" VALUES (?, ?, ?, 'email', ?, 'pending', NOW(3))", deliveryID, eventID, itChannelID, snapshot); err != nil {
			t.Fatalf("insert delivery: %v", err)
		}
		attempts := 1
		job := queue.Job{
			ID:           "delivery-it-b1",
			AttemptsMade: 0,
			Opts:         queue.JobOptions{Attempts: &attempts},
		}
		payload := queue.DeliverJobData{Type: queue.JobTypeDeliver, DeliveryID: deliveryID, OrgID: itOrgID}
		if err := service.HandleDeliveryJob(ctx, job, payload, queue.JobHandle{}); err == nil {
			t.Fatal("expected the SMTP failure to be returned")
		}
		var status string
		if err := db.QueryRowContext(ctx, "SELECT `status` FROM `AlertDelivery` WHERE `id` = ?", deliveryID).Scan(&status); err != nil {
			t.Fatalf("read delivery: %v", err)
		}
		if status != DeliveryStatusFailed {
			t.Fatalf("delivery status = %q, want failed on the last attempt", status)
		}
	})

	t.Run("non-final attempt stays pending", func(t *testing.T) {
		eventID := "event-it-pending"
		deliveryID := "delivery-it-pending"
		if _, err := db.ExecContext(ctx,
			"INSERT INTO `AlertEvent` (`id`, `ruleId`, `triggeredAt`, `metricValue`, `changePercent`, `severity`, `status`, `message`, `context`, `createdAt`)"+
				" VALUES (?, ?, ?, ?, NULL, 'high', 'pending', 'boom', NULL, NOW(3))",
			eventID, itRuleID, time.Now().UTC(), "1.5"); err != nil {
			t.Fatalf("insert event: %v", err)
		}
		snapshot := []byte(`{"id":"` + itChannelID + `","type":"email","target":"ops@example.com","name":"ops","config":{}}`)
		if _, err := db.ExecContext(ctx,
			"INSERT INTO `AlertDelivery` (`id`, `eventId`, `channelId`, `channelType`, `targetSnapshot`, `status`, `createdAt`)"+
				" VALUES (?, ?, ?, 'email', ?, 'pending', NOW(3))", deliveryID, eventID, itChannelID, snapshot); err != nil {
			t.Fatalf("insert delivery: %v", err)
		}
		attempts := 4
		job := queue.Job{ID: "delivery-it-pending", AttemptsMade: 0, Opts: queue.JobOptions{Attempts: &attempts}}
		payload := queue.DeliverJobData{Type: queue.JobTypeDeliver, DeliveryID: deliveryID, OrgID: itOrgID}
		if err := service.HandleDeliveryJob(ctx, job, payload, queue.JobHandle{}); err == nil {
			t.Fatal("expected the SMTP failure to be returned")
		}
		var status string
		if err := db.QueryRowContext(ctx, "SELECT `status` FROM `AlertDelivery` WHERE `id` = ?", deliveryID).Scan(&status); err != nil {
			t.Fatalf("read delivery: %v", err)
		}
		if status != DeliveryStatusPending {
			t.Fatalf("delivery status = %q, want pending while attempts remain", status)
		}
	})

	// A delivery whose occupancy claim loses must not be sent again. The row left
	// `pending` between the worker's read and the worker's conditional update
	// (an overlapping retry of the same attempt, or a second consumer after a
	// stalled recovery). AlertsService.occupyDeliveryForSend returns
	// `updated.count === 1` for that case and skips the send; the port has to do
	// the same, otherwise the external channel fires twice.
	//
	// The interleaving is deterministic: a competing transaction owns the row and
	// settles it as sent without committing, so the worker's plain SELECT still
	// reads the committed `pending` row while its UPDATE blocks on the row lock.
	// Committing makes that UPDATE re-evaluate its WHERE clause and match nothing.
	t.Run("a delivery that lost the send CAS is not sent again", func(t *testing.T) {
		eventID := "event-it-occupy"
		deliveryID := "delivery-it-occupy"
		if _, err := db.ExecContext(ctx,
			"INSERT INTO `AlertEvent` (`id`, `ruleId`, `triggeredAt`, `metricValue`, `changePercent`, `severity`, `status`, `message`, `context`, `createdAt`)"+
				" VALUES (?, ?, ?, ?, NULL, 'high', 'pending', 'boom', NULL, NOW(3))",
			eventID, itRuleID, time.Now().UTC(), "1.5"); err != nil {
			t.Fatalf("insert event: %v", err)
		}
		snapshot := []byte(`{"id":"` + itChannelID + `","type":"email","target":"ops@example.com","name":"ops","config":{}}`)
		if _, err := db.ExecContext(ctx,
			"INSERT INTO `AlertDelivery` (`id`, `eventId`, `channelId`, `channelType`, `targetSnapshot`, `status`, `createdAt`)"+
				" VALUES (?, ?, ?, 'email', ?, 'pending', NOW(3))", deliveryID, eventID, itChannelID, snapshot); err != nil {
			t.Fatalf("insert delivery: %v", err)
		}

		competing, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatalf("begin competing transaction: %v", err)
		}
		if _, err := competing.ExecContext(ctx,
			"UPDATE `AlertDelivery` SET `status` = 'sent', `sentAt` = NOW(3) WHERE `id` = ?", deliveryID); err != nil {
			_ = competing.Rollback()
			t.Fatalf("occupy delivery in the competing transaction: %v", err)
		}

		attempts := 4
		job := queue.Job{ID: "delivery-it-occupy", AttemptsMade: 0, Opts: queue.JobOptions{Attempts: &attempts}}
		payload := queue.DeliverJobData{Type: queue.JobTypeDeliver, DeliveryID: deliveryID, OrgID: itOrgID}
		done := make(chan error, 1)
		go func() {
			done <- service.HandleDeliveryJob(ctx, job, payload, queue.JobHandle{})
		}()
		time.Sleep(500 * time.Millisecond)
		if err := competing.Commit(); err != nil {
			t.Fatalf("commit competing transaction: %v", err)
		}
		if err := <-done; err != nil {
			t.Fatalf("handle delivery: %v", err)
		}

		var status string
		var deliveryError sql.NullString
		if err := db.QueryRowContext(ctx,
			"SELECT `status`, `error` FROM `AlertDelivery` WHERE `id` = ?", deliveryID).Scan(&status, &deliveryError); err != nil {
			t.Fatalf("read delivery: %v", err)
		}
		if status != DeliveryStatusSent {
			t.Fatalf("delivery status = %q, want the competing attempt's sent status", status)
		}
		if deliveryError.Valid {
			t.Fatalf("delivery error = %q, want NULL: a lost occupancy claim must not attempt the send", deliveryError.String)
		}
	})

	t.Run("rate limit key reservation", func(t *testing.T) {
		throttle := NewThrottle(redisClient, ThrottleConfig{
			GlobalPerSecond:     1,
			EmailPerSecond:      1,
			WebhookPerSecond:    1,
			PerChannelPerSecond: 1,
			LimiterTTLMs:        60_000,
			Namespace:           itNamespace,
		})
		now := time.Now().UnixMilli()
		first, err := throttle.ReserveNotificationScheduleMs(ctx, ReserveInput{ChannelType: ChannelTypeEmail, ChannelID: "pace-1"})
		if err != nil {
			t.Fatalf("first reservation: %v", err)
		}
		second, err := throttle.ReserveNotificationScheduleMs(ctx, ReserveInput{ChannelType: ChannelTypeEmail, ChannelID: "pace-1"})
		if err != nil {
			t.Fatalf("second reservation: %v", err)
		}
		if first < now-1000 {
			t.Fatalf("first reservation = %d, now = %d", first, now)
		}
		if second <= first {
			t.Fatalf("second reservation = %d, want > %d", second, first)
		}
		for _, key := range []string{
			itNamespace + ":alerts:notify:global",
			itNamespace + ":alerts:notify:type:email",
			itNamespace + ":alerts:notify:channel:pace-1",
		} {
			if err := redisClient.Get(ctx, key).Err(); err != nil {
				t.Fatalf("pace key %s: %v", key, err)
			}
		}
	})

	t.Run("delayed skipAttempt and custom backoff", func(t *testing.T) {
		// Start from an empty queue so the synthetic processor below only sees
		// the job this subtest adds.
		if err := redisClient.FlushDB(ctx).Err(); err != nil {
			t.Fatalf("flush redis: %v", err)
		}
		deliveryID := "delivery-it-queue"
		blocking := redis.NewClient(redisClient.Options())
		defer blocking.Close()
		var attempts int32
		var mu sync.Mutex
		var sawDelayedAtm int64 = -1
		done := make(chan struct{})
		worker, err := queue.NewWorker(redisClient, blocking, queue.WorkerOptions{
			Concurrency: 1,
			Processor: func(ctx context.Context, job queue.Job, handle queue.JobHandle) error {
				if job.ID != "deliver-"+deliveryID {
					return nil
				}
				mu.Lock()
				attempts++
				current := attempts
				mu.Unlock()
				if current == 1 {
					// The rate-limit path: move to delayed without consuming an attempt.
					return &queue.DelayedError{UntilMs: time.Now().Add(150 * time.Millisecond).UnixMilli()}
				}
				// Second attempt: the delayed move must not have consumed an attempt,
				// so atm is still absent (0).
				raw, err := redisClient.HGet(ctx, "bull:alerts:"+job.ID, "atm").Int64()
				if errors.Is(err, redis.Nil) {
					sawDelayedAtm = 0
				} else if err == nil {
					sawDelayedAtm = raw
				}
				close(done)
				return context.DeadlineExceeded
			},
			BackoffDelay: func(attempt int, backoffType string) (int64, bool) {
				return 60_000, backoffType == "alertNotifications"
			},
			Logger: func(string, ...any) {},
		})
		if err != nil {
			t.Fatalf("new worker: %v", err)
		}
		if err := worker.Start(ctx); err != nil {
			t.Fatalf("start worker: %v", err)
		}
		defer func() {
			closeCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = worker.Close(closeCtx)
		}()
		producer, err := queue.NewProducer(redisClient, queue.Prefix)
		if err != nil {
			t.Fatalf("new producer: %v", err)
		}
		if err := producer.AddDeliveryJob(ctx, deliveryID, itOrgID, "trace-it"); err != nil {
			t.Fatalf("add delivery job: %v", err)
		}
		select {
		case <-done:
		case <-time.After(20 * time.Second):
			t.Fatal("the worker did not process the delayed job in time")
		}
		if sawDelayedAtm != 0 {
			t.Fatalf("atm while the job was delayed = %d, want 0 (skipAttempt must not consume an attempt)", sawDelayedAtm)
		}
		jobID := "deliver-" + deliveryID
		deadline := time.Now().Add(10 * time.Second)
		var atm int64 = -1
		for time.Now().Before(deadline) {
			value, err := redisClient.HGet(ctx, "bull:alerts:"+jobID, "atm").Int64()
			if err == nil {
				atm = value
				if atm == 1 {
					break
				}
			}
			time.Sleep(100 * time.Millisecond)
		}
		if atm != 1 {
			t.Fatalf("atm after the failed retry = %d, want 1", atm)
		}
		score, err := redisClient.ZScore(ctx, "bull:alerts:delayed", jobID).Result()
		if err != nil {
			t.Fatalf("delayed score: %v", err)
		}
		delayedAt := int64(score) / 4096
		if delayedAt < time.Now().Add(50*time.Second).UnixMilli() {
			t.Fatalf("delayed timestamp = %d, want the 60s custom backoff", delayedAt)
		}
	})

	t.Run("scan creates default rules once and skips recently evaluated rules", func(t *testing.T) {
		if err := service.ScanActiveRules(ctx); err != nil {
			t.Fatalf("scan: %v", err)
		}
		var defaults int
		if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM `AlertRule` WHERE `orgId` = ? AND `metricProvider` IN ('crawl_task','realtime_signal','pipeline_job')",
			itOtherOrgID).Scan(&defaults); err != nil {
			t.Fatalf("count default rules: %v", err)
		}
		if defaults != 17 {
			t.Fatalf("default rules = %d, want 17", defaults)
		}
		waitBefore, err := redisClient.LLen(ctx, "bull:alerts:wait").Result()
		if err != nil {
			t.Fatalf("wait length: %v", err)
		}
		if waitBefore < 17 {
			t.Fatalf("wait list length = %d, want at least the 17 enqueued evaluations", waitBefore)
		}
		if err := service.ScanActiveRules(ctx); err != nil {
			t.Fatalf("second scan: %v", err)
		}
		if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM `AlertRule` WHERE `orgId` = ? AND `metricProvider` IN ('crawl_task','realtime_signal','pipeline_job')",
			itOtherOrgID).Scan(&defaults); err != nil {
			t.Fatalf("count default rules: %v", err)
		}
		if defaults != 17 {
			t.Fatalf("default rules after the second scan = %d, want 17 (idempotent)", defaults)
		}
		waitAfter, err := redisClient.LLen(ctx, "bull:alerts:wait").Result()
		if err != nil {
			t.Fatalf("wait length: %v", err)
		}
		if waitAfter != waitBefore {
			t.Fatalf("wait list grew from %d to %d; B3 must skip recently evaluated rules", waitBefore, waitAfter)
		}
	})

	t.Run("bridges publish the alertEvents envelope and the notification relay", func(t *testing.T) {
		subscriber := redis.NewClient(redisClient.Options())
		defer subscriber.Close()
		pubsub := subscriber.Subscribe(ctx, gqlSubscriptionChannelPrefix+alertEventsTrigger, alertNotificationChannel)
		defer pubsub.Close()
		if _, err := pubsub.Receive(ctx); err != nil {
			t.Fatalf("subscribe: %v", err)
		}
		channel := pubsub.Channel()
		event := EventRow{
			ID:          "event-it-bridge",
			RuleID:      itRuleID,
			TriggeredAt: time.Date(2026, 10, 20, 1, 2, 3, 400_000_000, time.UTC),
			MetricValue: 5,
			Severity:    "high",
			Status:      EventStatusPending,
		}
		service.publishAlertEvent(ctx, Rule{ID: itRuleID, OrgID: itOrgID, Name: "Rule", MetricProvider: "system_event", MetricSlug: "audit.count", Severity: "high"}, event, "triggered", EventStatusPending, newJSONObject())
		service.publishNotificationRelay(ctx, "notification-it", itOrgID, itUserAllowed)
		seen := map[string]string{}
		timeout := time.After(10 * time.Second)
		for len(seen) < 2 {
			select {
			case message := <-channel:
				seen[message.Channel] = message.Payload
			case <-timeout:
				t.Fatalf("only received %d of 2 bridge messages: %v", len(seen), seen)
			}
		}
		envelope := seen[gqlSubscriptionChannelPrefix+alertEventsTrigger]
		if !strings.Contains(envelope, `"$gqlDate":"2026-10-20T01:02:03.400Z"`) {
			t.Fatalf("alertEvents envelope = %s", envelope)
		}
		if !strings.Contains(envelope, `"metricSlug":"audit.count"`) || !strings.Contains(envelope, `"status":"pending"`) {
			t.Fatalf("alertEvents envelope = %s", envelope)
		}
		relay := seen[alertNotificationChannel]
		if relay != `{"version":1,"notificationId":"notification-it","orgId":"`+itOrgID+`","userId":"`+itUserAllowed+`"}` {
			t.Fatalf("notification relay = %s", relay)
		}
	})
}

func createAlertWorkerSchema(ctx context.Context, db *sql.DB) error {
	statements := []string{
		"CREATE TABLE IF NOT EXISTS `Org` (" +
			"`id` VARCHAR(191) NOT NULL, `name` VARCHAR(191) NOT NULL, `slug` VARCHAR(191) NOT NULL," +
			"`isActive` BOOLEAN NOT NULL DEFAULT true," +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `User` (" +
			"`id` VARCHAR(191) NOT NULL, `email` VARCHAR(191) NOT NULL, `passwordHash` VARCHAR(191) NOT NULL DEFAULT ''," +
			"`firstName` VARCHAR(191) NOT NULL DEFAULT '', `lastName` VARCHAR(191) NOT NULL DEFAULT ''," +
			"`isActive` BOOLEAN NOT NULL DEFAULT true," +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `Role` (" +
			"`id` VARCHAR(191) NOT NULL, `name` VARCHAR(191) NOT NULL, `description` VARCHAR(191) NULL," +
			"`isSystem` BOOLEAN NOT NULL DEFAULT false, `orgId` VARCHAR(191) NOT NULL," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `Permission` (" +
			"`id` VARCHAR(191) NOT NULL, `name` VARCHAR(191) NOT NULL, `description` VARCHAR(191) NULL," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `RolePermission` (" +
			"`id` VARCHAR(191) NOT NULL, `roleId` VARCHAR(191) NOT NULL, `permissionId` VARCHAR(191) NOT NULL," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `Membership` (" +
			"`id` VARCHAR(191) NOT NULL, `userId` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL," +
			"`roleId` VARCHAR(191) NOT NULL, `isActive` BOOLEAN NOT NULL DEFAULT true," +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `MembershipRole` (" +
			"`membershipId` VARCHAR(191) NOT NULL, `roleId` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL," +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"PRIMARY KEY (`membershipId`, `roleId`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `AlertRule` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `name` VARCHAR(191) NOT NULL," +
			"`description` VARCHAR(191) NULL, `severity` VARCHAR(191) NOT NULL DEFAULT 'medium'," +
			"`status` VARCHAR(191) NOT NULL DEFAULT 'active', `metricProvider` VARCHAR(191) NOT NULL," +
			"`dataItemId` VARCHAR(191) NULL, `metricSlug` VARCHAR(191) NOT NULL, `operator` VARCHAR(191) NOT NULL," +
			"`thresholdValue` DECIMAL(38,12) NULL, `thresholdLower` DECIMAL(38,12) NULL, `thresholdUpper` DECIMAL(38,12) NULL," +
			"`changeWindowMin` INT NULL, `cooldownSeconds` INT NOT NULL DEFAULT 3600, `checkIntervalSec` INT NOT NULL DEFAULT 300," +
			"`lastTriggeredAt` DATETIME(3) NULL, `metadata` JSON NULL, `createdById` VARCHAR(191) NULL," +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `AlertNotificationChannel` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `type` VARCHAR(191) NOT NULL," +
			"`name` VARCHAR(191) NOT NULL, `target` VARCHAR(191) NOT NULL, `config` JSON NULL," +
			"`isActive` BOOLEAN NOT NULL DEFAULT true, `createdById` VARCHAR(191) NULL," +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `AlertRuleChannel` (" +
			"`id` VARCHAR(191) NOT NULL, `ruleId` VARCHAR(191) NOT NULL, `channelId` VARCHAR(191) NOT NULL," +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `AlertEvent` (" +
			"`id` VARCHAR(191) NOT NULL, `ruleId` VARCHAR(191) NOT NULL, `triggeredAt` DATETIME(3) NOT NULL," +
			"`metricValue` DECIMAL(38,12) NOT NULL, `changePercent` DOUBLE NULL, `severity` VARCHAR(191) NOT NULL," +
			"`status` VARCHAR(191) NOT NULL DEFAULT 'pending', `message` VARCHAR(191) NULL, `context` JSON NULL," +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `AlertDelivery` (" +
			"`id` VARCHAR(191) NOT NULL, `eventId` VARCHAR(191) NOT NULL, `channelId` VARCHAR(191) NULL," +
			"`channelType` VARCHAR(191) NOT NULL, `targetSnapshot` JSON NULL, `status` VARCHAR(191) NOT NULL DEFAULT 'pending'," +
			"`error` VARCHAR(191) NULL, `sentAt` DATETIME(3) NULL," +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `Notification` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `userId` VARCHAR(191) NULL," +
			"`type` VARCHAR(191) NOT NULL, `title` VARCHAR(191) NOT NULL, `body` VARCHAR(191) NULL, `data` JSON NULL," +
			"`readAt` DATETIME(3) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"`updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `AuditLog` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `actorId` VARCHAR(191) NULL," +
			"`resource` VARCHAR(191) NOT NULL, `action` VARCHAR(191) NOT NULL, `metadata` JSON NULL," +
			"`ipAddress` VARCHAR(191) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
	}
	for _, table := range []string{
		"AlertRuleChannel", "AlertDelivery", "AlertEvent", "AlertNotificationChannel",
		"Notification", "AuditLog", "MembershipRole", "Membership", "RolePermission",
		"Permission", "Role", "User", "Org", "AlertRule",
	} {
		if _, err := db.ExecContext(ctx, "DROP TABLE IF EXISTS `"+table+"`"); err != nil {
			return err
		}
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

func seedAlertWorkerFixtures(ctx context.Context, db *sql.DB) error {
	now := time.Now().UTC().Truncate(time.Millisecond)
	statements := []struct {
		query string
		args  []any
	}{
		{"INSERT IGNORE INTO `Org` (`id`,`name`,`slug`,`isActive`,`updatedAt`) VALUES (?,?,?,?,?)", []any{itOrgID, "IT", "it-alert", true, now}},
		{"INSERT IGNORE INTO `Org` (`id`,`name`,`slug`,`isActive`,`updatedAt`) VALUES (?,?,?,?,?)", []any{itOtherOrgID, "IT empty", "it-alert-empty", true, now}},
		{"INSERT IGNORE INTO `User` (`id`,`email`,`isActive`,`updatedAt`) VALUES (?,?,?,?)", []any{itUserAllowed, "allowed@example.com", true, now}},
		{"INSERT IGNORE INTO `User` (`id`,`email`,`isActive`,`updatedAt`) VALUES (?,?,?,?)", []any{itUserDenied, "denied@example.com", true, now}},
		{"INSERT IGNORE INTO `Role` (`id`,`name`,`orgId`) VALUES (?,?,?)", []any{itRoleAllowed, "allowed", itOrgID}},
		{"INSERT IGNORE INTO `Role` (`id`,`name`,`orgId`) VALUES (?,?,?)", []any{itRoleDenied, "denied", itOrgID}},
		{"INSERT IGNORE INTO `Permission` (`id`,`name`) VALUES (?,?)", []any{"perm-it-alerts-read", alertsReadPermission}},
		{"INSERT IGNORE INTO `RolePermission` (`id`,`roleId`,`permissionId`) VALUES (?,?,?)", []any{"rp-it-read", itRoleAllowed, "perm-it-alerts-read"}},
		{"INSERT IGNORE INTO `Membership` (`id`,`userId`,`orgId`,`roleId`,`isActive`) VALUES (?,?,?,?,?)", []any{"membership-it-allowed", itUserAllowed, itOrgID, itRoleAllowed, true}},
		{"INSERT IGNORE INTO `Membership` (`id`,`userId`,`orgId`,`roleId`,`isActive`) VALUES (?,?,?,?,?)", []any{"membership-it-denied", itUserDenied, itOrgID, itRoleDenied, true}},
		{"INSERT IGNORE INTO `AlertNotificationChannel` (`id`,`orgId`,`type`,`name`,`target`,`config`,`isActive`) VALUES (?,?,?,?,?,?,?)",
			[]any{itChannelID, itOrgID, "email", "ops", "ops@example.com", []byte(`{"notifyIntervalSeconds":0}`), true}},
		{"INSERT IGNORE INTO `AlertRule` (`id`,`orgId`,`name`,`description`,`severity`,`status`,`metricProvider`,`metricSlug`,`operator`," +
			"`thresholdValue`,`changeWindowMin`,`cooldownSeconds`,`checkIntervalSec`,`metadata`,`createdById`," +
			"`createdAt`,`updatedAt`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
			[]any{itRuleID, itOrgID, "Audit spike", "IT rule", "high", StatusActive, "system_event", "audit.it",
				"gte", "1", 60, 3600, 300,
				[]byte(`{"notifyUserIds":["` + itUserAllowed + `","` + itUserDenied + `"]}`), itUserAllowed, now, now}},
		{"INSERT IGNORE INTO `AlertRuleChannel` (`id`,`ruleId`,`channelId`) VALUES (?,?,?)", []any{"link-it-1", itRuleID, itChannelID}},
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement.query, statement.args...); err != nil {
			return err
		}
	}
	// audit rows so the system_event provider has a current-window count >= 1
	for index := 0; index < 3; index++ {
		if _, err := db.ExecContext(ctx,
			"INSERT INTO `AuditLog` (`id`,`orgId`,`resource`,`action`,`createdAt`) VALUES (?,?,?,?,?)",
			"audit-it-"+string(rune('a'+index)), itOrgID, "audit.it", "update", now); err != nil {
			return err
		}
	}
	return nil
}
