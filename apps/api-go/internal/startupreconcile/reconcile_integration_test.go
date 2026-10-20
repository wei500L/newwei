//go:build integration

package startupreconcile

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/cronlock"
	"github.com/wei500L/newwei/apps/api-go/internal/platformgovernance"
)

type reconcileFixture struct {
	db      *sql.DB
	service *platformgovernance.Service
	lock    *cronlock.Lock
	mongo   *mongo.Database
	redis   *redis.Client
	ctx     context.Context
}

func openReconcileFixture(t *testing.T, redisDB int) *reconcileFixture {
	t.Helper()
	ctx := context.Background()

	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL is not set")
	}
	mongoURI := strings.TrimSpace(os.Getenv("MONGO_URI"))
	if mongoURI == "" {
		t.Skip("MONGO_URI is not set")
	}
	address := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if address == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR is not set")
	}

	parsed, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	password, _ := parsed.User.Password()
	dsn := fmt.Sprintf("%s:%s@tcp(%s)/%s?parseTime=true&loc=UTC&charset=utf8mb4",
		parsed.User.Username(), password, parsed.Host, strings.TrimPrefix(parsed.Path, "/"))
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		t.Fatalf("ping mysql: %v", err)
	}
	// Matches the SystemSetting table the email-settings integration step
	// creates earlier in this job, including the NOT NULL updatedAt column.
	if _, err := db.ExecContext(ctx, "CREATE TABLE IF NOT EXISTS SystemSetting ("+
		"`key` varchar(191) NOT NULL, value json NOT NULL, isPublic tinyint(1) NOT NULL DEFAULT 0, "+
		"description varchar(191) NULL, createdAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), "+
		"updatedAt datetime(3) NOT NULL, updatedById varchar(191) NULL, PRIMARY KEY (`key`)) "+
		"DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"); err != nil {
		t.Fatalf("create SystemSetting: %v", err)
	}
	if _, err := db.ExecContext(ctx, "DELETE FROM SystemSetting"); err != nil {
		t.Fatalf("clear SystemSetting: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	mongoClient, err := mongo.Connect(options.Client().ApplyURI(mongoURI))
	if err != nil {
		t.Fatalf("connect mongo: %v", err)
	}
	if err := mongoClient.Ping(pingCtx, nil); err != nil {
		t.Fatalf("ping mongo: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_ = mongoClient.Disconnect(cleanupCtx)
	})
	databaseName := "app"
	if parsedMongo, err := url.Parse(mongoURI); err == nil {
		if name := strings.TrimPrefix(parsedMongo.Path, "/"); name != "" {
			databaseName = name
		}
	}
	database := mongoClient.Database(databaseName)
	for _, collection := range []string{"tasklogs", "llmrequestlogs"} {
		if err := database.Collection(collection).Drop(ctx); err != nil {
			var commandError mongo.CommandError
			if !errors.As(err, &commandError) || commandError.Code != 26 {
				t.Fatalf("drop %s: %v", collection, err)
			}
		}
	}

	redisClient := redis.NewClient(&redis.Options{Addr: address, DB: redisDB, Protocol: 2})
	if err := redisClient.Ping(pingCtx).Err(); err != nil {
		t.Fatalf("ping redis: %v", err)
	}
	if err := redisClient.FlushDB(ctx).Err(); err != nil {
		t.Fatalf("flush redis: %v", err)
	}
	t.Cleanup(func() { _ = redisClient.Close() })

	service := platformgovernance.NewService(db, redisClient, database, platformgovernance.Env{
		TaskLogRetentionDays: 14,
	})
	return &reconcileFixture{
		db:      db,
		service: service,
		lock:    cronlock.New(redisClient),
		mongo:   database,
		redis:   redisClient,
		ctx:     ctx,
	}
}

// seedSetting writes the same SystemSetting row the NestJS settings service
// stores, so the reconciliation reads a realistic value.
func (f *reconcileFixture) seedSetting(t *testing.T, key, value string) {
	t.Helper()
	if _, err := f.db.ExecContext(f.ctx,
		"INSERT INTO SystemSetting (`key`, value, updatedAt) VALUES (?, ?, NOW(3))", key, value); err != nil {
		t.Fatalf("seed setting %s: %v", key, err)
	}
}

func indexExpireSeconds(t *testing.T, database *mongo.Database, collection, name string) int32 {
	t.Helper()
	cursor, err := database.Collection(collection).Indexes().List(context.Background())
	if err != nil {
		t.Fatalf("list indexes %s: %v", collection, err)
	}
	defer func() { _ = cursor.Close(context.Background()) }()
	var documents []bson.M
	if err := cursor.All(context.Background(), &documents); err != nil {
		t.Fatalf("decode indexes %s: %v", collection, err)
	}
	for _, document := range documents {
		if document["name"] != name {
			continue
		}
		switch value := document["expireAfterSeconds"].(type) {
		case int32:
			return value
		case int64:
			return int32(value)
		default:
			t.Fatalf("index %s expireAfterSeconds type = %T", name, document["expireAfterSeconds"])
		}
	}
	t.Fatalf("index %s not found in %s", name, collection)
	return 0
}

// TestStartupReconcileIntegration applies both retention TTL indexes from the
// stored settings against real MySQL and Mongo.
func TestStartupReconcileIntegration(t *testing.T) {
	fixture := openReconcileFixture(t, 0)
	fixture.seedSetting(t, "task_log_settings", `{"retentionDays":30}`)
	fixture.seedSetting(t, "llm_request_log_settings", `{"retentionDays":45}`)

	reconciler := New(Deps{Settings: fixture.service, Lock: fixture.lock})
	acquired, err := reconciler.RunOnce(fixture.ctx)
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if !acquired {
		t.Fatal("lease was not acquired")
	}

	if got := indexExpireSeconds(t, fixture.mongo, "tasklogs", "task_log_created_at_ttl"); got != 30*24*60*60 {
		t.Fatalf("tasklogs ttl = %d", got)
	}
	if got := indexExpireSeconds(t, fixture.mongo, "llmrequestlogs", "llm_request_log_created_at_ttl"); got != 45*24*60*60 {
		t.Fatalf("llmrequestlogs ttl = %d", got)
	}
}

// TestStartupReconcileLeaseIntegration proves the multi-replica guard with the
// real Redis lease: while one instance holds it, a second reconciliation does no
// work at all; after release the next one runs both settings parts.
func TestStartupReconcileLeaseIntegration(t *testing.T) {
	fixture := openReconcileFixture(t, 1)
	settings := &fakeSettings{taskDays: 14, llmDays: 30}

	held := make(chan struct{})
	release := make(chan struct{})
	holderResult := make(chan bool, 1)
	go func() {
		acquired, err := fixture.lock.WithLock(fixture.ctx, lockName, lockTTL, func(context.Context) error {
			close(held)
			<-release
			return nil
		})
		if err != nil {
			t.Errorf("holder: %v", err)
		}
		holderResult <- acquired
	}()
	select {
	case <-held:
	case <-time.After(3 * time.Second):
		t.Fatal("holder did not acquire the lease")
	}

	reconciler := New(Deps{Settings: settings, Lock: fixture.lock})
	acquired, err := reconciler.RunOnce(fixture.ctx)
	if err != nil {
		t.Fatalf("contended RunOnce: %v", err)
	}
	if acquired {
		t.Fatal("a second replica must not acquire the lease while it is held")
	}
	if settings.calls != 0 {
		t.Fatalf("contended reconciliation ran %d operations, want 0", settings.calls)
	}

	close(release)
	if !<-holderResult {
		t.Fatal("holder did not report acquisition")
	}

	acquired, err = reconciler.RunOnce(fixture.ctx)
	if err != nil {
		t.Fatalf("RunOnce after release: %v", err)
	}
	if !acquired || settings.calls != 2 {
		t.Fatalf("acquired=%t calls=%d, want true/2", acquired, settings.calls)
	}
}
