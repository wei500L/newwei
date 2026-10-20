//go:build integration

package metrics

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

func openMetricsTestDB(t *testing.T) *sql.DB {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL is not set")
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
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("ping mysql: %v", err)
	}
	for _, statement := range []string{
		// Matches the Org table the authz integration step creates earlier in
		// this job, so CREATE IF NOT EXISTS is a no-op and the insert satisfies
		// every NOT NULL column.
		`CREATE TABLE IF NOT EXISTS Org (
			id varchar(191) NOT NULL,
			name varchar(191) NOT NULL,
			slug varchar(191) NOT NULL,
			isActive boolean NOT NULL DEFAULT true,
			createdAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			updatedAt datetime(3) NOT NULL,
			UNIQUE KEY Org_slug_key (slug),
			PRIMARY KEY (id)
		) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
		`CREATE TABLE IF NOT EXISTS MachineAccessToken (
			id varchar(40) NOT NULL PRIMARY KEY,
			orgId varchar(40) NOT NULL,
			tokenHash varchar(64) NOT NULL,
			permissions json NULL,
			name varchar(255) NOT NULL DEFAULT 'machine',
			expiresAt datetime(3) NULL,
			revokedAt datetime(3) NULL,
			lastUsedAt datetime(3) NULL,
			createdById varchar(40) NULL,
			UNIQUE KEY MachineAccessToken_tokenHash (tokenHash)
		) ENGINE=InnoDB`,
		`CREATE TABLE IF NOT EXISTS GlobalRoleAssignment (
			id varchar(40) NOT NULL PRIMARY KEY,
			userId varchar(40) NOT NULL,
			role varchar(40) NOT NULL,
			createdAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
		) ENGINE=InnoDB`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("create table: %v", err)
		}
	}
	for _, table := range []string{"MachineAccessToken", "GlobalRoleAssignment"} {
		if _, err := db.ExecContext(ctx, "DELETE FROM "+table); err != nil {
			t.Fatalf("clear %s: %v", table, err)
		}
	}
	// Only the row this test owns: earlier steps in the same job also use Org.
	if _, err := db.ExecContext(ctx, "DELETE FROM Org WHERE id = 'org-1'"); err != nil {
		t.Fatalf("clear org-1: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func insertMachine(t *testing.T, db *sql.DB, id, token string, permissions string,
	createdBy *string, revoked bool, expires *time.Time) {
	t.Helper()
	var revokedAt any
	if revoked {
		revokedAt = time.Now().UTC()
	}
	if _, err := db.Exec(
		"INSERT INTO MachineAccessToken (id, orgId, tokenHash, permissions, createdById, revokedAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
		id, "org-1", hashToken(token), permissions, createdBy, revokedAt, expires); err != nil {
		t.Fatalf("insert machine token: %v", err)
	}
}

func scrape(t *testing.T, handler *Handler, authorization string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest("GET", metricsPath, nil)
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

// TestMetricsEndpointAuthorizationIntegration covers the SEC-03 checks against
// real MySQL rows: metrics.read, the machine token state and the creator's
// current platform_admin role, plus the Prometheus response.
func TestMetricsEndpointAuthorizationIntegration(t *testing.T) {
	db := openMetricsTestDB(t)
	ctx := context.Background()
	if _, err := db.ExecContext(ctx,
		"INSERT INTO Org (id, name, slug, isActive, updatedAt) VALUES ('org-1', 'org-1', 'org-1', 1, NOW(3))"); err != nil {
		t.Fatalf("insert org: %v", err)
	}
	adminID := "user-admin"
	plainID := "user-plain"
	if _, err := db.ExecContext(ctx,
		"INSERT INTO GlobalRoleAssignment (id, userId, role) VALUES ('gra-1', ?, 'platform_admin')", adminID); err != nil {
		t.Fatalf("insert platform admin: %v", err)
	}

	insertMachine(t, db, "token-admin", "mtk_admin", `["metrics.read"]`, &adminID, false, nil)
	insertMachine(t, db, "token-plain", "mtk_plain", `["metrics.read"]`, &plainID, false, nil)
	insertMachine(t, db, "token-noperm", "mtk_noperm", `["items.read"]`, &adminID, false, nil)
	insertMachine(t, db, "token-revoked", "mtk_revoked", `["metrics.read"]`, &adminID, true, nil)
	expired := time.Now().Add(-time.Hour).UTC()
	insertMachine(t, db, "token-expired", "mtk_expired", `["metrics.read"]`, &adminID, false, &expired)

	handler := NewHandler(nil, db, NewRegistry())

	// Missing bearer.
	if response := scrape(t, handler, ""); response.Code != 401 {
		t.Fatalf("no token status = %d, want 401", response.Code)
	}

	// Platform-admin machine token: 200 + Prometheus text.
	response := scrape(t, handler, "Bearer mtk_admin")
	if response.Code != 200 {
		t.Fatalf("admin token status = %d, body=%s", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Content-Type"); got != ContentType {
		t.Fatalf("content type = %q, want %q", got, ContentType)
	}
	body := response.Body.String()
	for _, expected := range []string{
		"# TYPE scheduler_runs_total counter",
		"# TYPE integration_events_total counter",
		"# TYPE pipeline_metric_value gauge",
		"# TYPE http_request_duration_seconds histogram",
		"# TYPE go_goroutines gauge",
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("body is missing %q", expected)
		}
	}
	var lastUsed sql.NullTime
	if err := db.QueryRowContext(ctx,
		"SELECT lastUsedAt FROM MachineAccessToken WHERE id = 'token-admin'").Scan(&lastUsed); err != nil {
		t.Fatalf("read lastUsedAt: %v", err)
	}
	if !lastUsed.Valid {
		t.Fatal("lastUsedAt must be updated on authentication")
	}

	// Missing metrics.read: 403 INSUFFICIENT_PERMISSIONS.
	response = scrape(t, handler, "Bearer mtk_noperm")
	if response.Code != 403 || !strings.Contains(response.Body.String(), "INSUFFICIENT_PERMISSIONS") {
		t.Fatalf("no-permission status = %d, body=%s", response.Code, response.Body.String())
	}

	// The creator is not a platform administrator: 403 with the platform text.
	response = scrape(t, handler, "Bearer mtk_plain")
	if response.Code != 403 || !strings.Contains(response.Body.String(), "Platform admin access required") {
		t.Fatalf("non-admin status = %d, body=%s", response.Code, response.Body.String())
	}

	// Revoked and expired tokens: 401 Invalid machine token.
	for _, token := range []string{"mtk_revoked", "mtk_expired"} {
		response = scrape(t, handler, "Bearer "+token)
		if response.Code != 401 || !strings.Contains(response.Body.String(), "Invalid machine token") {
			t.Fatalf("%s status = %d, body=%s", token, response.Code, response.Body.String())
		}
	}
}
