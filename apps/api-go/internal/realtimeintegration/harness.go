//go:build integration

// Shared harness for the realtime integration tests: an isolated MySQL schema
// with the RBAC tables the transport re-derives permissions from, a shared
// Redis client on a dedicated database, HS256 test tokens and helpers that
// start the real transport on an httptest server.
//
// Environment (injected by the api-go-user-settings-integration CI job):
//
//	DATABASE_URL=mysql://root:secret@127.0.0.1:3306/app
//	API_GO_TEST_REDIS_ADDR=127.0.0.1:6379
//
// Any missing variable makes the test skip, matching the other integration
// tests of this repository. Every test creates its own database
// (realtime_it_<random>) and drops it on cleanup, so the shared `app` schema
// used by the other steps of the same CI job is never modified.
package realtimeintegration

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"
	"github.com/vmihailenco/msgpack/v5"

	"github.com/wei500L/newwei/apps/api-go/internal/authn"
	"github.com/wei500L/newwei/apps/api-go/internal/authz"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/realtimesocket"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

const (
	// testJWTSecret is the HS256 secret shared by the test signer and the
	// authn.Verifier injected into the transport. The transport never reads
	// JWT_SECRET itself: production wiring passes the verifier in, so the test
	// controls both sides of the signature.
	testJWTSecret   = "realtime-integration-hs256-secret"
	testJWTIssuer   = "newwei-api"
	testJWTAudience = "newwei-web"

	// redisTestDB isolates the realtime fixtures from the other Redis
	// integration steps. Pub/Sub channels are global but streams, rate-limit
	// buckets and locks are database scoped.
	redisTestDB = 12

	// integrationJWTExpiry is long enough that no test observes an exp-driven
	// revalidation disconnect.
	integrationJWTExpiry = time.Hour
)

// harness owns the process-wide test resources of one test function.
type harness struct {
	ctx          context.Context
	db           *sql.DB
	redis        *redis.Client
	redisOptions *redis.Options
	verifier     *authn.Verifier
	repository   authz.Repository
}

// newHarness requires MySQL and Redis, creates the isolated MySQL database and
// the minimal Prisma-compatible tables, flushes the dedicated Redis database and
// registers cleanup.
func newHarness(t *testing.T) *harness {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set — realtime integration tests require MySQL")
	}
	redisAddr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if redisAddr == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR not set — realtime integration tests require Redis")
	}

	baseDB, err := usersettings.OpenMySQLFromURL(databaseURL)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	databaseName := "realtime_it_" + strconv.FormatInt(time.Now().UnixNano(), 36)
	if _, err := baseDB.ExecContext(context.Background(), "CREATE DATABASE `"+databaseName+"`"); err != nil {
		baseDB.Close()
		t.Fatalf("create integration database: %v", err)
	}
	parsedURL, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	parsedURL.Path = "/" + databaseName
	db, err := usersettings.OpenMySQLFromURL(parsedURL.String())
	if err != nil {
		t.Fatalf("open integration database: %v", err)
	}
	if err := db.Ping(); err != nil {
		t.Fatalf("ping integration database: %v", err)
	}
	createRealtimeTables(t, db)

	redisOptions := &redis.Options{Addr: redisAddr, DB: redisTestDB, Protocol: 2}
	redisClient := redis.NewClient(redisOptions)
	ctx := context.Background()
	if err := redisClient.Ping(ctx).Err(); err != nil {
		t.Fatalf("ping redis: %v", err)
	}
	if err := redisClient.FlushDB(ctx).Err(); err != nil {
		t.Fatalf("flush redis db %d: %v", redisTestDB, err)
	}

	h := &harness{
		ctx:          ctx,
		db:           db,
		redis:        redisClient,
		redisOptions: redisOptions,
		verifier:     authn.NewVerifier(testJWTSecret, testJWTIssuer, testJWTAudience),
		repository:   authz.NewMySQLRepository(db),
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = redisClient.Close()
		_ = db.Close()
		_, _ = baseDB.ExecContext(cleanupCtx, "DROP DATABASE `"+databaseName+"`")
		_ = baseDB.Close()
	})
	return h
}

// createRealtimeTables builds the minimal Prisma-compatible schema required by
// the transport (RBAC re-derivation), the classification scheduler (active orgs
// and SystemSetting-backed runtime settings) and the notification side effects.
// Column names/types/uniques follow packages/db/prisma/schema.prisma and the
// existing authz/usersettings integration fixtures; foreign keys are omitted
// because the fixtures insert rows directly.
func createRealtimeTables(t *testing.T, db *sql.DB) {
	t.Helper()
	statements := []string{
		"CREATE TABLE `User` (" +
			"`id` VARCHAR(191) NOT NULL, `email` VARCHAR(191) NOT NULL, `passwordHash` VARCHAR(191) NOT NULL," +
			"`firstName` VARCHAR(191) NOT NULL, `lastName` VARCHAR(191) NOT NULL, `isActive` BOOLEAN NOT NULL DEFAULT true," +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL," +
			"UNIQUE INDEX `User_email_key`(`email`), PRIMARY KEY (`id`)" +
			") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE `Org` (" +
			"`id` VARCHAR(191) NOT NULL, `name` VARCHAR(191) NOT NULL, `slug` VARCHAR(191) NOT NULL," +
			"`isActive` BOOLEAN NOT NULL DEFAULT true," +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL," +
			"UNIQUE INDEX `Org_slug_key`(`slug`), PRIMARY KEY (`id`)" +
			") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE `Role` (" +
			"`id` VARCHAR(191) NOT NULL, `name` VARCHAR(191) NOT NULL, `isSystem` BOOLEAN NOT NULL DEFAULT false, `orgId` VARCHAR(191) NOT NULL," +
			"UNIQUE INDEX `Role_id_orgId_key`(`id`, `orgId`), UNIQUE INDEX `Role_orgId_name_key`(`orgId`, `name`), PRIMARY KEY (`id`)" +
			") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE `Permission` (" +
			"`id` VARCHAR(191) NOT NULL, `name` VARCHAR(191) NOT NULL," +
			"UNIQUE INDEX `Permission_name_key`(`name`), PRIMARY KEY (`id`)" +
			") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE `RolePermission` (" +
			"`id` VARCHAR(191) NOT NULL, `roleId` VARCHAR(191) NOT NULL, `permissionId` VARCHAR(191) NOT NULL," +
			"UNIQUE INDEX `RolePermission_roleId_permissionId_key`(`roleId`, `permissionId`), PRIMARY KEY (`id`)" +
			") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE `Membership` (" +
			"`id` VARCHAR(191) NOT NULL, `userId` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL," +
			"`roleId` VARCHAR(191) NOT NULL, `isActive` BOOLEAN NOT NULL DEFAULT true," +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"UNIQUE INDEX `Membership_userId_orgId_key`(`userId`, `orgId`), PRIMARY KEY (`id`)" +
			") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE `MembershipRole` (" +
			"`membershipId` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `roleId` VARCHAR(191) NOT NULL," +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"PRIMARY KEY (`membershipId`, `roleId`)" +
			") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE `Notification` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `userId` VARCHAR(191) NULL," +
			"`type` VARCHAR(191) NOT NULL, `title` VARCHAR(191) NOT NULL, `body` TEXT NULL, `data` JSON NULL," +
			"`readAt` DATETIME(3) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"`updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"INDEX `Notification_orgId_createdAt_idx`(`orgId`, `createdAt`)," +
			"INDEX `Notification_userId_createdAt_idx`(`userId`, `createdAt`), PRIMARY KEY (`id`)" +
			") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE `SystemSetting` (" +
			"`key` VARCHAR(191) NOT NULL, `value` JSON NOT NULL, `isPublic` BOOLEAN NOT NULL DEFAULT false," +
			"`description` VARCHAR(191) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"`updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedById` VARCHAR(191) NULL," +
			"PRIMARY KEY (`key`)" +
			") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(context.Background(), statement); err != nil {
			t.Fatalf("create table: %v\n%s", err, statement)
		}
	}
}

// exec runs one fixture statement and fails the test on error.
func (h *harness) exec(t *testing.T, query string, args ...any) {
	t.Helper()
	if _, err := h.db.ExecContext(h.ctx, query, args...); err != nil {
		t.Fatalf("exec %q: %v", query, err)
	}
}

// seedOrg inserts one Org row (idempotent inside the per-test database).
func (h *harness) seedOrg(t *testing.T, orgID string, active bool) {
	t.Helper()
	h.exec(t, "INSERT INTO `Org` (`id`, `name`, `slug`, `isActive`, `updatedAt`) VALUES (?, ?, ?, ?, NOW(3))",
		orgID, "org-"+orgID, "slug-"+orgID, active)
}

// seedUser inserts one User row.
func (h *harness) seedUser(t *testing.T, userID string, active bool) {
	t.Helper()
	h.exec(t, "INSERT INTO `User` (`id`, `email`, `passwordHash`, `firstName`, `lastName`, `isActive`, `updatedAt`)"+
		" VALUES (?, ?, 'x', 'first', 'last', ?, NOW(3))",
		userID, userID+"@example.com", active)
}

// seedMember creates an active Org, an active User, one role carrying the given
// permissions and an active Membership linking them. It is the standard fixture
// of every transport test. Duplicate permission names are inserted once.
func (h *harness) seedMember(t *testing.T, orgID, userID string, permissions ...string) {
	t.Helper()
	h.seedOrg(t, orgID, true)
	h.seedUser(t, userID, true)
	roleID := "role-" + orgID + "-" + userID
	h.exec(t, "INSERT INTO `Role` (`id`, `name`, `orgId`) VALUES (?, ?, ?)", roleID, "role-"+userID, orgID)
	for _, permission := range permissions {
		permissionID := "perm-" + strings.NewReplacer(".", "-", " ", "-").Replace(permission)
		h.exec(t, "INSERT IGNORE INTO `Permission` (`id`, `name`) VALUES (?, ?)", permissionID, permission)
		h.exec(t, "INSERT IGNORE INTO `RolePermission` (`id`, `roleId`, `permissionId`) VALUES (?, ?, ?)",
			"rp-"+roleID+"-"+permissionID, roleID, permissionID)
	}
	h.exec(t, "INSERT INTO `Membership` (`id`, `userId`, `orgId`, `roleId`, `isActive`) VALUES (?, ?, ?, ?, true)",
		"membership-"+orgID+"-"+userID, userID, orgID, roleID)
}

// setMembershipActive flips the Membership.isActive flag (B2 identity
// revalidation fixture).
func (h *harness) setMembershipActive(t *testing.T, orgID, userID string, active bool) {
	t.Helper()
	h.exec(t, "UPDATE `Membership` SET `isActive` = ? WHERE `orgId` = ? AND `userId` = ?", active, orgID, userID)
}

// seedSystemSetting writes one SystemSetting row (JSON semantics).
func (h *harness) seedSystemSetting(t *testing.T, key, valueJSON string) {
	t.Helper()
	h.exec(t, "INSERT INTO `SystemSetting` (`key`, `value`, `updatedAt`) VALUES (?, ?, NOW(3))",
		key, valueJSON)
}

// accessToken signs an HS256 access token with the same issuer/audience/secret
// the authn.Verifier was built with. sub/orgId are the identity claims; jti is
// unique per token so the blacklist lookup never hits a stale key.
func (h *harness) accessToken(t *testing.T, userID, orgID string) string {
	t.Helper()
	now := time.Now().UTC()
	claims := jwt.MapClaims{
		"sub":   userID,
		"orgId": orgID,
		"jti":   "jti-" + userID + "-" + strconv.FormatInt(now.UnixNano(), 36),
		"iss":   testJWTIssuer,
		"aud":   testJWTAudience,
		"iat":   now.Unix(),
		"exp":   now.Add(integrationJWTExpiry).Unix(),
	}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(testJWTSecret))
	if err != nil {
		t.Fatalf("sign test access token: %v", err)
	}
	return token
}

// realtimeOptions returns the transport options shared by all tests: the real
// MySQL RBAC repository, a real Redis client, an empty CORS allow-list (the
// coder/websocket test client sends no Origin), generous rate limits so tests
// do not trip the production defaults and a short revalidation interval that
// keeps every assertion under the 5s budget.
func (h *harness) realtimeOptions() realtimesocket.Options {
	return realtimesocket.Options{
		DB:                    h.db,
		Verifier:              h.verifier,
		Blacklist:             authn.NewRedisBlacklist(h.redis),
		Authz:                 h.repository,
		Redis:                 h.redis,
		CORS:                  cors.New(""),
		TrustProxy:            false,
		MaxConnectionsPerUser: 20,
		MaxConnectionsPerIP:   200,
		ConnectLimitPerIP:     10_000,
		ConnectLimitPerUser:   10_000,
		ConnectWindowSeconds:  60,
		RevalidateInterval:    300 * time.Millisecond,
	}
}

// newRealtimeRuntime starts a real transport on ctx and closes it in cleanup.
func (h *harness) newRealtimeRuntime(t *testing.T, options realtimesocket.Options) *realtimesocket.Runtime {
	t.Helper()
	runtime, err := realtimesocket.New(options)
	if err != nil {
		t.Fatalf("realtimesocket.New: %v", err)
	}
	if err := runtime.Start(h.ctx); err != nil {
		t.Fatalf("realtimesocket.Start: %v", err)
	}
	t.Cleanup(func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := runtime.Close(closeCtx); err != nil {
			t.Logf("realtimesocket.Close: %v", err)
		}
	})
	return runtime
}

// serveRealtime mounts the real Handles/ServeHTTP routing on an httptest server,
// so tests exercise the same request gating as production (path, EIO=4,
// transport=websocket, GET + upgrade headers).
func serveRealtime(t *testing.T, runtime *realtimesocket.Runtime) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !runtime.Handles(r) {
			http.NotFound(w, r)
			return
		}
		runtime.ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)
	return server
}

// waitFor polls cond until it reports true or the timeout elapses; it is used
// for cross-process effects (Redis pub/sub, XREAD loops, MySQL updates) where no
// synchronous completion signal exists.
func waitFor(t *testing.T, timeout, interval time.Duration, description string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		if cond() {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %s waiting for %s", timeout, description)
		}
		time.Sleep(interval)
	}
}

// adapterWirePacket is the msgpack packet shape written by
// @socket.io/redis-adapter 8.3.0 when a broadcast is published on Redis:
//
//	{type:2 (EVENT), data:[event, ...args], nsp:"/namespace"}
//
// A struct (not a map) keeps the encoded field order deterministic so the tests
// can also assert that the Go decoder preserves the original msgpack ordering.
type adapterWirePacket struct {
	Type int    `msgpack:"type"`
	Data []any  `msgpack:"data"`
	NSP  string `msgpack:"nsp"`
}

// adapterWireOptions mirrors the adapter broadcast opts map:
//
//	{rooms:[...], except:[...], flags:{}}
type adapterWireOptions struct {
	Rooms  []string       `msgpack:"rooms"`
	Except []string       `msgpack:"except"`
	Flags  map[string]any `msgpack:"flags"`
}

// encodeAdapterBroadcast builds the exact notepack-compatible msgpack payload
// the NestJS Redis adapter publishes (see /tmp/spec-go-infra.md §1.4/§1.5).
// payload is encoded by the caller-chosen type; a struct keeps the field order.
func encodeAdapterBroadcast(t *testing.T, uid, namespace, event string, payload any, rooms []string) []byte {
	t.Helper()
	wire := []any{
		uid,
		adapterWirePacket{Type: 2, Data: []any{event, payload}, NSP: namespace},
		adapterWireOptions{Rooms: rooms, Except: []string{}, Flags: map[string]any{}},
	}
	encoded, err := msgpack.Marshal(wire)
	if err != nil {
		t.Fatalf("encode redis adapter broadcast: %v", err)
	}
	return encoded
}

// adapterChannel returns the broadcast channel used by @socket.io/redis-adapter
// for a namespace (base channel) and, when exactly one room is targeted, the
// single-room channel suffix used by the NestJS adapter.
func adapterChannel(adapterKey, namespace string, rooms ...string) string {
	channel := adapterKey + "#" + namespace + "#"
	if len(rooms) == 1 {
		channel += rooms[0] + "#"
	}
	return channel
}

// assertKeyOrder asserts that the top-level JSON object keys appear in the
// expected order inside raw. It is used for wire payloads whose field order is
// part of the NestJS contract (the Go decoder must preserve the msgpack order).
func assertKeyOrder(t *testing.T, raw, description string, keys ...string) {
	t.Helper()
	last := -1
	for _, key := range keys {
		index := strings.Index(raw, `"`+key+`":`)
		if index < 0 {
			t.Fatalf("%s: key %q missing from payload %s", description, key, raw)
		}
		if index <= last {
			t.Fatalf("%s: key %q is out of order in payload %s (want order %v)", description, key, raw, keys)
		}
		last = index
	}
}

// marshalJSON marshals a fixture value into JSON bytes for sinks/fakes.
func marshalJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal fixture JSON: %v", err)
	}
	return encoded
}
