//go:build integration

// 新组织审批恢复的远端集成测试（build tag integration；普通 go test ./...
// 不依赖数据库）。CI 在已有的 api-go-user-settings-integration job 的真实
// MySQL 8.4 / Redis 7.2 service 上运行，用可失败的 MailSender 覆盖投递边界。
//
// 覆盖：正常审批链（组织/bootstrap/默认角色/邀请/关联/审计）、组织 bootstrap
// 数据库失败回滚、邀请保存/关联失败回滚、邮件保存后发送失败再显式重发、
// 重复/并发审批不重复创建组织或邀请、历史半完成记录的可信恢复与不可信绑定
// 拒绝，以及非平台管理员/伪造角色/跨组织的拒绝。
//
// 表结构按 packages/db/prisma/schema.prisma 的真实列/FK/唯一键创建（不省略
// 本单元用到的外键），因此生产结构差异不会被假 DDL 掩盖。
package identityonboarding

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authlogin"
)

// recoveryMail is a MailSender whose failure can be toggled between calls.
type recoveryMail struct {
	mu       sync.Mutex
	err      error
	messages []authlogin.MailMessage
}

func (m *recoveryMail) Send(_ context.Context, message authlogin.MailMessage) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.messages = append(m.messages, message)
	return m.err
}

func (m *recoveryMail) setError(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.err = err
}

func (m *recoveryMail) count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.messages)
}

func (m *recoveryMail) lastURLContains(fragment string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.messages) == 0 {
		return false
	}
	last := m.messages[len(m.messages)-1]
	return strings.Contains(last.Text, fragment)
}

// recoveryDDL mirrors the models this unit touches. Only columns referenced by
// the production SQL are present; the foreign keys and unique keys are the real
// ones from the Prisma schema.
var recoveryDDL = []string{
	`CREATE TABLE IF NOT EXISTS User (
		id VARCHAR(191) NOT NULL,
		email VARCHAR(191) NOT NULL,
		emailVerified DATETIME(3) NULL,
		pendingEmail VARCHAR(191) NULL,
		passwordHash VARCHAR(191) NOT NULL,
		firstName VARCHAR(191) NOT NULL,
		lastName VARCHAR(191) NOT NULL,
		avatarUrl VARCHAR(191) NULL,
		isActive TINYINT(1) NOT NULL DEFAULT 1,
		lastLoginAt DATETIME(3) NULL,
		createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		updatedAt DATETIME(3) NOT NULL,
		PRIMARY KEY (id),
		UNIQUE KEY User_email_key (email),
		UNIQUE KEY User_pendingEmail_key (pendingEmail)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS Org (
		id VARCHAR(191) NOT NULL,
		name VARCHAR(191) NOT NULL,
		slug VARCHAR(191) NOT NULL,
		description VARCHAR(191) NULL,
		planTier VARCHAR(191) NULL,
		subscriptionStatus VARCHAR(191) NULL,
		isActive TINYINT(1) NOT NULL DEFAULT 1,
		createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		updatedAt DATETIME(3) NOT NULL,
		PRIMARY KEY (id),
		UNIQUE KEY Org_slug_key (slug)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS Permission (
		id VARCHAR(191) NOT NULL,
		name VARCHAR(191) NOT NULL,
		description VARCHAR(191) NULL,
		PRIMARY KEY (id),
		UNIQUE KEY Permission_name_key (name)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS Role (
		id VARCHAR(191) NOT NULL,
		name VARCHAR(191) NOT NULL,
		description VARCHAR(191) NULL,
		isSystem TINYINT(1) NOT NULL DEFAULT 0,
		orgId VARCHAR(191) NOT NULL,
		PRIMARY KEY (id),
		UNIQUE KEY Role_id_orgId_key (id, orgId),
		UNIQUE KEY Role_orgId_name_key (orgId, name),
		CONSTRAINT Role_orgId_fkey FOREIGN KEY (orgId) REFERENCES Org (id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS RolePermission (
		id VARCHAR(191) NOT NULL,
		roleId VARCHAR(191) NOT NULL,
		permissionId VARCHAR(191) NOT NULL,
		PRIMARY KEY (id),
		UNIQUE KEY RolePermission_roleId_permissionId_key (roleId, permissionId),
		CONSTRAINT RolePermission_roleId_fkey FOREIGN KEY (roleId) REFERENCES Role (id),
		CONSTRAINT RolePermission_permissionId_fkey FOREIGN KEY (permissionId) REFERENCES Permission (id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS OrgInvite (
		id VARCHAR(191) NOT NULL,
		orgId VARCHAR(191) NOT NULL,
		email VARCHAR(191) NOT NULL,
		firstName VARCHAR(191) NULL,
		lastName VARCHAR(191) NULL,
		primaryRoleId VARCHAR(191) NOT NULL,
		roleIds JSON NOT NULL,
		invitedById VARCHAR(191) NULL,
		acceptedById VARCHAR(191) NULL,
		tokenHash VARCHAR(191) NOT NULL,
		status ENUM('pending','accepted','revoked') NOT NULL DEFAULT 'pending',
		expiresAt DATETIME(3) NOT NULL,
		acceptedAt DATETIME(3) NULL,
		revokedAt DATETIME(3) NULL,
		metadata JSON NULL,
		createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		updatedAt DATETIME(3) NOT NULL,
		PRIMARY KEY (id),
		UNIQUE KEY OrgInvite_tokenHash_key (tokenHash),
		KEY OrgInvite_orgId_status_createdAt_idx (orgId, status, createdAt),
		CONSTRAINT OrgInvite_orgId_fkey FOREIGN KEY (orgId) REFERENCES Org (id) ON DELETE CASCADE,
		CONSTRAINT OrgInvite_primaryRoleId_fkey FOREIGN KEY (primaryRoleId, orgId) REFERENCES Role (id, orgId) ON DELETE RESTRICT,
		CONSTRAINT OrgInvite_invitedById_fkey FOREIGN KEY (invitedById) REFERENCES User (id) ON DELETE SET NULL,
		CONSTRAINT OrgInvite_acceptedById_fkey FOREIGN KEY (acceptedById) REFERENCES User (id) ON DELETE SET NULL
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS RegistrationApplication (
		id VARCHAR(191) NOT NULL,
		type ENUM('new_org','join_org') NOT NULL,
		status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
		email VARCHAR(191) NOT NULL,
		firstName VARCHAR(191) NOT NULL,
		lastName VARCHAR(191) NOT NULL,
		orgId VARCHAR(191) NULL,
		requestedOrgName VARCHAR(191) NULL,
		requestedOrgSlug VARCHAR(191) NULL,
		requestedDescription VARCHAR(191) NULL,
		decisionReason VARCHAR(191) NULL,
		generatedInviteId VARCHAR(191) NULL,
		reviewedById VARCHAR(191) NULL,
		reviewedAt DATETIME(3) NULL,
		metadata JSON NULL,
		createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		updatedAt DATETIME(3) NOT NULL,
		PRIMARY KEY (id),
		KEY RegistrationApplication_status_type_createdAt_idx (status, type, createdAt),
		CONSTRAINT RegistrationApplication_orgId_fkey FOREIGN KEY (orgId) REFERENCES Org (id) ON DELETE SET NULL,
		CONSTRAINT RegistrationApplication_generatedInviteId_fkey FOREIGN KEY (generatedInviteId) REFERENCES OrgInvite (id) ON DELETE SET NULL,
		CONSTRAINT RegistrationApplication_reviewedById_fkey FOREIGN KEY (reviewedById) REFERENCES User (id) ON DELETE SET NULL
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS Membership (
		id VARCHAR(191) NOT NULL,
		userId VARCHAR(191) NOT NULL,
		orgId VARCHAR(191) NOT NULL,
		roleId VARCHAR(191) NOT NULL,
		isActive TINYINT(1) NOT NULL DEFAULT 1,
		createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		PRIMARY KEY (id),
		UNIQUE KEY Membership_id_orgId_key (id, orgId),
		UNIQUE KEY Membership_userId_orgId_key (userId, orgId),
		KEY Membership_roleId_orgId_idx (roleId, orgId),
		CONSTRAINT Membership_userId_fkey FOREIGN KEY (userId) REFERENCES User (id),
		CONSTRAINT Membership_orgId_fkey FOREIGN KEY (orgId) REFERENCES Org (id),
		CONSTRAINT Membership_roleId_fkey FOREIGN KEY (roleId, orgId) REFERENCES Role (id, orgId)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS MembershipRole (
		membershipId VARCHAR(191) NOT NULL,
		orgId VARCHAR(191) NOT NULL,
		roleId VARCHAR(191) NOT NULL,
		createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		PRIMARY KEY (membershipId, roleId),
		KEY MembershipRole_orgId_membershipId_idx (orgId, membershipId),
		CONSTRAINT MembershipRole_membershipId_fkey FOREIGN KEY (membershipId, orgId) REFERENCES Membership (id, orgId) ON DELETE CASCADE,
		CONSTRAINT MembershipRole_roleId_fkey FOREIGN KEY (roleId, orgId) REFERENCES Role (id, orgId) ON DELETE CASCADE
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS GlobalRoleAssignment (
		id VARCHAR(191) NOT NULL,
		userId VARCHAR(191) NOT NULL,
		role ENUM('platform_admin') NOT NULL,
		createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		PRIMARY KEY (id),
		UNIQUE KEY GlobalRoleAssignment_userId_role_key (userId, role),
		CONSTRAINT GlobalRoleAssignment_userId_fkey FOREIGN KEY (userId) REFERENCES User (id) ON DELETE CASCADE
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS AuditLog (
		id VARCHAR(191) NOT NULL,
		orgId VARCHAR(191) NOT NULL,
		actorId VARCHAR(191) NULL,
		resource VARCHAR(191) NOT NULL,
		action VARCHAR(191) NOT NULL,
		metadata JSON NULL,
		ipAddress VARCHAR(191) NULL,
		createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		PRIMARY KEY (id),
		KEY AuditLog_orgId_createdAt_idx (orgId, createdAt),
		CONSTRAINT AuditLog_orgId_fkey FOREIGN KEY (orgId) REFERENCES Org (id),
		CONSTRAINT AuditLog_actorId_fkey FOREIGN KEY (actorId) REFERENCES User (id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS AuditLogOutbox (
		id VARCHAR(191) NOT NULL,
		orgId VARCHAR(191) NOT NULL,
		payload JSON NOT NULL,
		status ENUM('pending','processing','failed','dead') NOT NULL DEFAULT 'pending',
		attempts INT NOT NULL DEFAULT 0,
		lastError VARCHAR(191) NULL,
		availableAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		lockedAt DATETIME(3) NULL,
		createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		updatedAt DATETIME(3) NOT NULL,
		PRIMARY KEY (id),
		KEY AuditLogOutbox_status_availableAt_idx (status, availableAt),
		CONSTRAINT AuditLogOutbox_orgId_fkey FOREIGN KEY (orgId) REFERENCES Org (id) ON DELETE CASCADE
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
}

var recoveryCleanup = []string{
	"DELETE FROM RegistrationApplication",
	"DELETE FROM MembershipRole",
	"DELETE FROM Membership",
	"DELETE FROM RolePermission",
	"DELETE FROM OrgInvite",
	"DELETE FROM AuditLog",
	"DELETE FROM AuditLogOutbox",
	"DELETE FROM GlobalRoleAssignment",
	"DELETE FROM Role",
	"DELETE FROM Permission",
	"DELETE FROM Org",
	"DELETE FROM User",
}

type recoveryHarness struct {
	db     *sql.DB
	redis  *redis.Client
	mail   *recoveryMail
	svc    *Service
	prefix string
	seq    int
}

func (h *recoveryHarness) id(kind string) string {
	h.seq++
	return fmt.Sprintf("it-%s-%s-%d", h.prefix, kind, h.seq)
}

func openRecoveryDB(t *testing.T) *sql.DB {
	t.Helper()
	raw := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if raw == "" {
		t.Skip("DATABASE_URL not set — integration test requires MySQL")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	credentials := ""
	if parsed.User != nil {
		credentials = parsed.User.Username()
		if password, ok := parsed.User.Password(); ok {
			credentials += ":" + password
		}
	}
	host := parsed.Host
	database := strings.TrimPrefix(parsed.Path, "/")
	// The job reuses one database for several packages whose User/Org/Role
	// schemas are narrower than this fixture's. Run this suite in its own
	// database so the later packages keep the schema they expect, while the
	// tables here still carry the real Prisma columns, foreign keys and unique
	// keys.
	serverDSN := fmt.Sprintf("%s@tcp(%s)/%s?parseTime=true&loc=UTC&charset=utf8mb4", credentials, host, database)
	server, err := sql.Open("mysql", serverDSN)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	if _, err := server.ExecContext(context.Background(),
		"CREATE DATABASE IF NOT EXISTS `"+recoveryDatabaseName+"` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"); err != nil {
		server.Close()
		t.Fatalf("create dedicated database %q: %v", recoveryDatabaseName, err)
	}
	server.Close()

	dsn := fmt.Sprintf("%s@tcp(%s)/%s?parseTime=true&loc=UTC&charset=utf8mb4", credentials, host, recoveryDatabaseName)
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	if err := db.Ping(); err != nil {
		t.Fatalf("ping mysql: %v", err)
	}
	return db
}

// recoveryDatabaseName isolates this suite from the other packages that share
// the CI MySQL service.
const recoveryDatabaseName = "identity_onboarding_it"

func openRecoveryRedis(t *testing.T) *redis.Client {
	t.Helper()
	addr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if addr == "" {
		return nil
	}
	client := redis.NewClient(&redis.Options{Addr: addr, Protocol: 2})
	if err := client.Ping(context.Background()).Err(); err != nil {
		t.Fatalf("ping redis: %v", err)
	}
	return client
}

func newRecoveryHarness(t *testing.T) *recoveryHarness {
	t.Helper()
	db := openRecoveryDB(t)
	ctx := context.Background()
	for _, statement := range recoveryDDL {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("create table: %v\n%s", err, statement)
		}
	}
	for _, statement := range recoveryCleanup {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("cleanup %q: %v", statement, err)
		}
	}
	redisClient := openRecoveryRedis(t)
	mail := &recoveryMail{}
	svc := NewService(db, redisClient, mail, Config{BaseURL: "http://app.local"})
	h := &recoveryHarness{
		db:     db,
		redis:  redisClient,
		mail:   mail,
		svc:    svc,
		prefix: fmt.Sprintf("%d", time.Now().UnixNano()),
	}
	t.Cleanup(func() {
		if redisClient != nil {
			_ = redisClient.Close()
		}
		_ = db.Close()
	})
	return h
}

func (h *recoveryHarness) exec(t *testing.T, query string, args ...any) {
	t.Helper()
	if _, err := h.db.ExecContext(context.Background(), query, args...); err != nil {
		t.Fatalf("exec %q: %v", query, err)
	}
}

func (h *recoveryHarness) count(t *testing.T, query string, args ...any) int {
	t.Helper()
	var n int
	if err := h.db.QueryRowContext(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatalf("count %q: %v", query, err)
	}
	return n
}

func (h *recoveryHarness) seedUser(t *testing.T, id string) {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Millisecond)
	h.exec(t,
		"INSERT INTO User (id, email, passwordHash, firstName, lastName, isActive, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
		id, id+"@example.com", "hash", "First", "Last", now, now)
}

func (h *recoveryHarness) grantPlatformAdmin(t *testing.T, userID string) {
	t.Helper()
	h.exec(t, "INSERT INTO GlobalRoleAssignment (id, userId, role) VALUES (?, ?, 'platform_admin')", h.id("gra"), userID)
}

func (h *recoveryHarness) seedPermission(t *testing.T, name string) {
	t.Helper()
	h.exec(t, "INSERT INTO Permission (id, name) VALUES (?, ?)", h.id("perm"), name)
}

type recoveryAppRow struct {
	ID                string
	Type              string
	Status            string
	Email             string
	FirstName         string
	LastName          string
	OrgID             *string
	RequestedOrgName  *string
	RequestedOrgSlug  *string
	GeneratedInviteID *string
	ReviewedByID      *string
	Metadata          *string
}

func (h *recoveryHarness) seedApplication(t *testing.T, row recoveryAppRow) {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Millisecond)
	h.exec(t,
		"INSERT INTO RegistrationApplication (id, type, status, email, firstName, lastName, orgId, requestedOrgName, requestedOrgSlug, generatedInviteId, reviewedById, metadata, createdAt, updatedAt) "+
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		row.ID, row.Type, row.Status, row.Email, row.FirstName, row.LastName,
		nullableString(row.OrgID), nullableString(row.RequestedOrgName), nullableString(row.RequestedOrgSlug),
		nullableString(row.GeneratedInviteID), nullableString(row.ReviewedByID), nullableString(row.Metadata), now, now)
}

type recoveryAppState struct {
	Status            string
	OrgID             sql.NullString
	GeneratedInviteID sql.NullString
	Metadata          []byte
}

func (h *recoveryHarness) loadAppState(t *testing.T, id string) recoveryAppState {
	t.Helper()
	var state recoveryAppState
	if err := h.db.QueryRowContext(context.Background(),
		"SELECT status, orgId, generatedInviteId, metadata FROM RegistrationApplication WHERE id = ?", id).
		Scan(&state.Status, &state.OrgID, &state.GeneratedInviteID, &state.Metadata); err != nil {
		t.Fatalf("load application %s: %v", id, err)
	}
	return state
}

func (state recoveryAppState) deliveryStatus(t *testing.T) string {
	t.Helper()
	if len(state.Metadata) == 0 {
		return ""
	}
	var document struct {
		ApprovalProgress *struct {
			DeliveryStatus string `json:"deliveryStatus"`
		} `json:"approvalProgress"`
	}
	if err := json.Unmarshal(state.Metadata, &document); err != nil {
		t.Fatalf("unmarshal metadata: %v", err)
	}
	if document.ApprovalProgress == nil {
		return ""
	}
	return document.ApprovalProgress.DeliveryStatus
}

// seedOrphanOrg creates an organization with an admin role and, when
// approverID is non-empty, the approver's administrator membership — the exact
// fingerprint the organization bootstrap leaves behind.
func (h *recoveryHarness) seedOrphanOrg(t *testing.T, name, slug, approverID string) (orgID, adminRoleID string) {
	t.Helper()
	orgID = h.id("org")
	adminRoleID = h.id("role")
	now := time.Now().UTC().Truncate(time.Millisecond)
	h.exec(t, "INSERT INTO Org (id, name, slug, isActive, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)", orgID, name, slug, now, now)
	h.exec(t, "INSERT INTO Role (id, name, description, isSystem, orgId) VALUES (?, 'admin', 'Admin', 1, ?)", adminRoleID, orgID)
	if approverID != "" {
		membershipID := h.id("mem")
		h.exec(t, "INSERT INTO Membership (id, userId, orgId, roleId, isActive, createdAt) VALUES (?, ?, ?, ?, 1, ?)", membershipID, approverID, orgID, adminRoleID, now)
		h.exec(t, "INSERT INTO MembershipRole (membershipId, orgId, roleId, createdAt) VALUES (?, ?, ?, ?)", membershipID, orgID, adminRoleID, now)
	}
	return orgID, adminRoleID
}

func (h *recoveryHarness) seedInvite(t *testing.T, orgID, primaryRoleID, email, tokenHash, status string) string {
	t.Helper()
	inviteID := h.id("inv")
	now := time.Now().UTC().Truncate(time.Millisecond)
	h.exec(t,
		"INSERT INTO OrgInvite (id, orgId, email, primaryRoleId, roleIds, tokenHash, status, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		inviteID, orgID, email, primaryRoleID, `["`+primaryRoleID+`"]`, tokenHash, status, now.Add(7*24*time.Hour), now, now)
	return inviteID
}

func (h *recoveryHarness) inviteState(t *testing.T, inviteID string) (status, tokenHash string) {
	t.Helper()
	if err := h.db.QueryRowContext(context.Background(),
		"SELECT status, tokenHash FROM OrgInvite WHERE id = ?", inviteID).Scan(&status, &tokenHash); err != nil {
		t.Fatalf("load invite %s: %v", inviteID, err)
	}
	return status, tokenHash
}

func (h *recoveryHarness) resetFault() {
	injectApprovalFault = func(string) error { return nil }
}

// TestOrgApprovalRecoveryIntegration is the single entry point the CI step runs.
func TestOrgApprovalRecoveryIntegration(t *testing.T) {
	t.Run("normal approve creates org invite and association once", func(t *testing.T) {
		h := newRecoveryHarness(t)
		h.seedPermission(t, "org.read")
		h.seedPermission(t, "users.write")
		admin := h.id("admin")
		h.seedUser(t, admin)
		h.grantPlatformAdmin(t, admin)
		slug := "normal-" + h.prefix
		applicationID := h.id("app")
		h.seedApplication(t, recoveryAppRow{
			ID: applicationID, Type: "new_org", Status: "pending", Email: "founder@example.com",
			FirstName: "Founder", LastName: "One", RequestedOrgName: stringPtr("Normal Org"), RequestedOrgSlug: &slug,
		})

		scalar, err := h.svc.ApproveNewOrg(context.Background(), admin, applicationID)
		if err != nil {
			t.Fatalf("approve: %v", err)
		}
		state := h.loadAppState(t, applicationID)
		if state.Status != "approved" || !state.OrgID.Valid || !state.GeneratedInviteID.Valid {
			t.Fatalf("application state = %+v", state)
		}
		if state.deliveryStatus(t) != string(deliveryStatusSent) {
			t.Fatalf("delivery status = %q, want sent", state.deliveryStatus(t))
		}
		if scalar.ApprovalProgress == nil || !scalar.ApprovalProgress.AssociationComplete {
			t.Fatalf("response progress = %+v", scalar.ApprovalProgress)
		}
		orgID := state.OrgID.String
		if got := h.count(t, "SELECT COUNT(*) FROM Role WHERE orgId = ?", orgID); got != 3 {
			t.Fatalf("default roles = %d, want 3", got)
		}
		if got := h.count(t, "SELECT COUNT(*) FROM Membership WHERE orgId = ? AND userId = ?", orgID, admin); got != 1 {
			t.Fatalf("approver membership = %d, want 1", got)
		}
		if got := h.count(t, "SELECT COUNT(*) FROM AuditLog WHERE orgId = ? AND resource = 'org' AND action = 'create'", orgID); got != 1 {
			t.Fatalf("bootstrap audit = %d, want 1", got)
		}
		if h.mail.count() != 1 {
			t.Fatalf("mail count = %d, want 1", h.mail.count())
		}
		if !h.mail.lastURLContains("/invite/") {
			t.Fatal("invitation mail does not contain an /invite/ link")
		}

		// Repeated request is stable: no second organization or invitation.
		if _, err := h.svc.ApproveNewOrg(context.Background(), admin, applicationID); err != nil {
			t.Fatalf("repeat approve: %v", err)
		}
		if got := h.count(t, "SELECT COUNT(*) FROM Org WHERE slug = ?", slug); got != 1 {
			t.Fatalf("organizations after repeat = %d, want 1", got)
		}
		if got := h.count(t, "SELECT COUNT(*) FROM OrgInvite WHERE orgId = ?", orgID); got != 1 {
			t.Fatalf("invitations after repeat = %d, want 1", got)
		}
		if h.mail.count() != 1 {
			t.Fatalf("repeat must not resend automatically, mail count = %d", h.mail.count())
		}
	})

	t.Run("organization bootstrap database failure rolls back the claim", func(t *testing.T) {
		h := newRecoveryHarness(t)
		admin := h.id("admin")
		h.seedUser(t, admin)
		h.grantPlatformAdmin(t, admin)
		slug := "bootstrap-fail-" + h.prefix
		applicationID := h.id("app")
		h.seedApplication(t, recoveryAppRow{
			ID: applicationID, Type: "new_org", Status: "pending", Email: "founder@example.com",
			FirstName: "Founder", LastName: "One", RequestedOrgName: stringPtr("Bootstrap Fail"), RequestedOrgSlug: &slug,
		})
		injectApprovalFault = func(stage string) error {
			if stage == "org_bootstrap" {
				return fmt.Errorf("injected bootstrap failure")
			}
			return nil
		}
		defer h.resetFault()

		if _, err := h.svc.ApproveNewOrg(context.Background(), admin, applicationID); err == nil {
			t.Fatal("approve unexpectedly succeeded")
		}
		state := h.loadAppState(t, applicationID)
		if state.Status != "pending" || state.OrgID.Valid || state.GeneratedInviteID.Valid {
			t.Fatalf("application state after rollback = %+v", state)
		}
		if got := h.count(t, "SELECT COUNT(*) FROM Org WHERE slug = ?", slug); got != 0 {
			t.Fatalf("organization rows after rollback = %d, want 0", got)
		}
		if got := h.count(t, "SELECT COUNT(*) FROM OrgInvite"); got != 0 {
			t.Fatalf("invitation rows after rollback = %d, want 0", got)
		}
	})

	t.Run("invite save failure rolls back organization association", func(t *testing.T) {
		h := newRecoveryHarness(t)
		admin := h.id("admin")
		h.seedUser(t, admin)
		h.grantPlatformAdmin(t, admin)
		slug := "invite-fail-" + h.prefix
		applicationID := h.id("app")
		h.seedApplication(t, recoveryAppRow{
			ID: applicationID, Type: "new_org", Status: "pending", Email: "founder@example.com",
			FirstName: "Founder", LastName: "One", RequestedOrgName: stringPtr("Invite Fail"), RequestedOrgSlug: &slug,
		})
		injectApprovalFault = func(stage string) error {
			if stage == "invite_insert" {
				return fmt.Errorf("injected invite failure")
			}
			return nil
		}
		defer h.resetFault()

		if _, err := h.svc.ApproveNewOrg(context.Background(), admin, applicationID); err == nil {
			t.Fatal("approve unexpectedly succeeded")
		}
		if got := h.count(t, "SELECT COUNT(*) FROM Org WHERE slug = ?", slug); got != 0 {
			t.Fatalf("organization rows after invite failure = %d, want 0", got)
		}
		state := h.loadAppState(t, applicationID)
		if state.Status != "pending" || state.OrgID.Valid || state.GeneratedInviteID.Valid {
			t.Fatalf("application state after invite failure = %+v", state)
		}
	})

	t.Run("association write failure rolls back org and invite", func(t *testing.T) {
		h := newRecoveryHarness(t)
		admin := h.id("admin")
		h.seedUser(t, admin)
		h.grantPlatformAdmin(t, admin)
		slug := "assoc-fail-" + h.prefix
		applicationID := h.id("app")
		h.seedApplication(t, recoveryAppRow{
			ID: applicationID, Type: "new_org", Status: "pending", Email: "founder@example.com",
			FirstName: "Founder", LastName: "One", RequestedOrgName: stringPtr("Assoc Fail"), RequestedOrgSlug: &slug,
		})
		injectApprovalFault = func(stage string) error {
			if stage == "association_write" {
				return fmt.Errorf("injected association failure")
			}
			return nil
		}
		defer h.resetFault()

		if _, err := h.svc.ApproveNewOrg(context.Background(), admin, applicationID); err == nil {
			t.Fatal("approve unexpectedly succeeded")
		}
		if got := h.count(t, "SELECT COUNT(*) FROM Org WHERE slug = ?", slug); got != 0 {
			t.Fatalf("organization rows after association failure = %d, want 0", got)
		}
		if got := h.count(t, "SELECT COUNT(*) FROM OrgInvite"); got != 0 {
			t.Fatalf("invitation rows after association failure = %d, want 0", got)
		}
	})

	t.Run("delivery failure keeps committed approval and explicit resend rotates the token", func(t *testing.T) {
		h := newRecoveryHarness(t)
		admin := h.id("admin")
		h.seedUser(t, admin)
		h.grantPlatformAdmin(t, admin)
		slug := "delivery-fail-" + h.prefix
		applicationID := h.id("app")
		h.seedApplication(t, recoveryAppRow{
			ID: applicationID, Type: "new_org", Status: "pending", Email: "founder@example.com",
			FirstName: "Founder", LastName: "One", RequestedOrgName: stringPtr("Delivery Fail"), RequestedOrgSlug: &slug,
		})
		h.mail.setError(fmt.Errorf("smtp rejected the message"))

		scalar, err := h.svc.ApproveNewOrg(context.Background(), admin, applicationID)
		if err != nil {
			t.Fatalf("approve with failing mail: %v", err)
		}
		state := h.loadAppState(t, applicationID)
		if state.Status != "approved" || !state.OrgID.Valid || !state.GeneratedInviteID.Valid {
			t.Fatalf("committed state lost on delivery failure = %+v", state)
		}
		if state.deliveryStatus(t) != string(deliveryStatusFailed) {
			t.Fatalf("delivery status = %q, want failed", state.deliveryStatus(t))
		}
		if scalar.ApprovalProgress == nil || scalar.ApprovalProgress.LastDeliveryError == nil {
			t.Fatalf("response progress missing the failure = %+v", scalar.ApprovalProgress)
		}
		inviteID := state.GeneratedInviteID.String
		beforeStatus, beforeHash := h.inviteState(t, inviteID)

		h.mail.setError(nil)
		resendScalar, err := h.svc.ResendOrgInvite(context.Background(), admin, applicationID)
		if err != nil {
			t.Fatalf("resend: %v", err)
		}
		afterStatus, afterHash := h.inviteState(t, inviteID)
		if afterStatus != "pending" {
			t.Fatalf("invite status after resend = %q", afterStatus)
		}
		if beforeStatus != "pending" || beforeHash == afterHash {
			t.Fatalf("token was not rotated: before=%q after=%q", beforeHash, afterHash)
		}
		if stateAfter := h.loadAppState(t, applicationID); stateAfter.deliveryStatus(t) != string(deliveryStatusSent) {
			t.Fatalf("delivery status after resend = %q, want sent", stateAfter.deliveryStatus(t))
		}
		if resendScalar.ApprovalProgress == nil || resendScalar.ApprovalProgress.DeliveryAttempts < 2 {
			t.Fatalf("delivery attempts after resend = %+v", resendScalar.ApprovalProgress)
		}
		if h.mail.count() != 2 {
			t.Fatalf("mail count after resend = %d, want 2", h.mail.count())
		}
	})

	t.Run("concurrent approve creates exactly one organization and invitation", func(t *testing.T) {
		h := newRecoveryHarness(t)
		admin := h.id("admin")
		h.seedUser(t, admin)
		h.grantPlatformAdmin(t, admin)
		slug := "concurrent-" + h.prefix
		applicationID := h.id("app")
		h.seedApplication(t, recoveryAppRow{
			ID: applicationID, Type: "new_org", Status: "pending", Email: "founder@example.com",
			FirstName: "Founder", LastName: "One", RequestedOrgName: stringPtr("Concurrent"), RequestedOrgSlug: &slug,
		})

		var wg sync.WaitGroup
		results := make([]error, 2)
		for i := 0; i < 2; i++ {
			wg.Add(1)
			go func(index int) {
				defer wg.Done()
				_, err := h.svc.ApproveNewOrg(context.Background(), admin, applicationID)
				results[index] = err
			}(i)
		}
		wg.Wait()
		successes := 0
		for _, err := range results {
			if err == nil {
				successes++
			}
		}
		if successes != 1 {
			t.Fatalf("successful concurrent approvals = %d, want 1 (errors=%v)", successes, results)
		}
		if got := h.count(t, "SELECT COUNT(*) FROM Org WHERE slug = ?", slug); got != 1 {
			t.Fatalf("organizations = %d, want 1", got)
		}
		if got := h.count(t, "SELECT COUNT(*) FROM OrgInvite"); got != 1 {
			t.Fatalf("invitations = %d, want 1", got)
		}
	})

	t.Run("historical row with a generated invite heals its organization", func(t *testing.T) {
		h := newRecoveryHarness(t)
		admin := h.id("admin")
		h.seedUser(t, admin)
		h.grantPlatformAdmin(t, admin)
		slug := "heal-" + h.prefix
		orgID, adminRoleID := h.seedOrphanOrg(t, "Heal Org", slug, "")
		inviteID := h.seedInvite(t, orgID, adminRoleID, "founder@example.com", "legacy-hash-"+h.prefix, "pending")
		applicationID := h.id("app")
		h.seedApplication(t, recoveryAppRow{
			ID: applicationID, Type: "new_org", Status: "approved", Email: "founder@example.com",
			FirstName: "Founder", LastName: "One", OrgID: nil, RequestedOrgName: stringPtr("Heal Org"),
			RequestedOrgSlug: &slug, GeneratedInviteID: &inviteID, ReviewedByID: &admin,
		})

		scalar, err := h.svc.RecoverNewOrg(context.Background(), admin, applicationID, recoverOrgRequest{})
		if err != nil {
			t.Fatalf("recover heal: %v", err)
		}
		state := h.loadAppState(t, applicationID)
		if !state.OrgID.Valid || state.OrgID.String != orgID {
			t.Fatalf("healed orgId = %+v, want %s", state.OrgID, orgID)
		}
		if got := h.count(t, "SELECT COUNT(*) FROM OrgInvite WHERE orgId = ?", orgID); got != 1 {
			t.Fatalf("heal must not create a second invite, count = %d", got)
		}
		if scalar.ApprovalProgress == nil || !scalar.ApprovalProgress.AssociationComplete {
			t.Fatalf("progress after heal = %+v", scalar.ApprovalProgress)
		}
		if h.mail.count() != 0 {
			t.Fatalf("heal must not auto-send, mail count = %d", h.mail.count())
		}
	})

	t.Run("historical approved row without association refuses a silent slug bind", func(t *testing.T) {
		h := newRecoveryHarness(t)
		admin := h.id("admin")
		h.seedUser(t, admin)
		h.grantPlatformAdmin(t, admin)
		slug := "untrusted-" + h.prefix
		// An organization with the requested slug exists but was not created by
		// this approval: the approver is not a member.
		orphanOrgID, _ := h.seedOrphanOrg(t, "Untrusted Org", slug, "")
		applicationID := h.id("app")
		h.seedApplication(t, recoveryAppRow{
			ID: applicationID, Type: "new_org", Status: "approved", Email: "founder@example.com",
			FirstName: "Founder", LastName: "One", RequestedOrgName: stringPtr("Untrusted Org"),
			RequestedOrgSlug: &slug, ReviewedByID: &admin,
		})

		if _, err := h.svc.RecoverNewOrg(context.Background(), admin, applicationID, recoverOrgRequest{}); err == nil {
			t.Fatal("recover must refuse to guess a slug-matched organization")
		}
		if _, err := h.svc.RecoverNewOrg(context.Background(), admin, applicationID, recoverOrgRequest{TargetOrgID: &orphanOrgID}); err == nil {
			t.Fatal("recover must refuse to bind an organization the approver did not create")
		}
		state := h.loadAppState(t, applicationID)
		if state.OrgID.Valid || state.GeneratedInviteID.Valid {
			t.Fatalf("untrusted recovery changed the row: %+v", state)
		}
		if got := h.count(t, "SELECT COUNT(*) FROM OrgInvite"); got != 0 {
			t.Fatalf("untrusted recovery created an invitation: %d", got)
		}
	})

	t.Run("historical approved row creates the missing organization when the slug is free", func(t *testing.T) {
		h := newRecoveryHarness(t)
		admin := h.id("admin")
		h.seedUser(t, admin)
		h.grantPlatformAdmin(t, admin)
		slug := "missing-org-" + h.prefix
		applicationID := h.id("app")
		reason := "completed after a previous partial approval"
		h.seedApplication(t, recoveryAppRow{
			ID: applicationID, Type: "new_org", Status: "approved", Email: "founder@example.com",
			FirstName: "Founder", LastName: "One", RequestedOrgName: stringPtr("Missing Org"),
			RequestedOrgSlug: &slug, ReviewedByID: &admin,
		})

		if _, err := h.svc.RecoverNewOrg(context.Background(), admin, applicationID, recoverOrgRequest{Reason: &reason}); err != nil {
			t.Fatalf("recover create: %v", err)
		}
		state := h.loadAppState(t, applicationID)
		if !state.OrgID.Valid || !state.GeneratedInviteID.Valid {
			t.Fatalf("recovered state = %+v", state)
		}
		if got := h.count(t, "SELECT COUNT(*) FROM Org WHERE slug = ?", slug); got != 1 {
			t.Fatalf("created organizations = %d, want 1", got)
		}
		if h.mail.count() != 1 {
			t.Fatalf("mail count = %d, want 1", h.mail.count())
		}
	})

	t.Run("historical approved row binds an explicitly confirmed orphan without touching members", func(t *testing.T) {
		h := newRecoveryHarness(t)
		admin := h.id("admin")
		h.seedUser(t, admin)
		h.grantPlatformAdmin(t, admin)
		slug := "bind-orphan-" + h.prefix
		orphanOrgID, _ := h.seedOrphanOrg(t, "Bind Orphan", slug, admin)
		membershipsBefore := h.count(t, "SELECT COUNT(*) FROM Membership WHERE orgId = ?", orphanOrgID)
		applicationID := h.id("app")
		reason := "adopting the organization created by the failed approval"
		h.seedApplication(t, recoveryAppRow{
			ID: applicationID, Type: "new_org", Status: "approved", Email: "founder@example.com",
			FirstName: "Founder", LastName: "One", RequestedOrgName: stringPtr("Bind Orphan"),
			RequestedOrgSlug: &slug, ReviewedByID: &admin,
		})

		if _, err := h.svc.RecoverNewOrg(context.Background(), admin, applicationID, recoverOrgRequest{TargetOrgID: &orphanOrgID, Reason: &reason}); err != nil {
			t.Fatalf("recover bind: %v", err)
		}
		state := h.loadAppState(t, applicationID)
		if !state.OrgID.Valid || state.OrgID.String != orphanOrgID || !state.GeneratedInviteID.Valid {
			t.Fatalf("bound state = %+v", state)
		}
		if got := h.count(t, "SELECT COUNT(*) FROM Membership WHERE orgId = ?", orphanOrgID); got != membershipsBefore {
			t.Fatalf("recovery changed organization members: %d -> %d", membershipsBefore, got)
		}
		if got := h.count(t, "SELECT COUNT(*) FROM OrgInvite WHERE orgId = ?", orphanOrgID); got != 1 {
			t.Fatalf("bound organization invitations = %d, want 1", got)
		}
	})

	t.Run("non platform administrator and org admin cannot approve", func(t *testing.T) {
		h := newRecoveryHarness(t)
		user := h.id("user")
		h.seedUser(t, user)
		// Give the caller an organization administrator role; the platform check
		// must still reject it because reject-vs-allow derives only from the
		// server-side GlobalRoleAssignment, never from an organization role.
		h.seedOrphanOrg(t, "Org Admin Org", "org-admin-"+h.prefix, user)
		slug := "forbidden-" + h.prefix
		applicationID := h.id("app")
		h.seedApplication(t, recoveryAppRow{
			ID: applicationID, Type: "new_org", Status: "pending", Email: "founder@example.com",
			FirstName: "Founder", LastName: "One", RequestedOrgName: stringPtr("Forbidden"), RequestedOrgSlug: &slug,
		})
		_, err := h.svc.ApproveNewOrg(context.Background(), user, applicationID)
		if err == nil {
			t.Fatal("non platform admin must be rejected")
		}
		var coded *httpError
		if !errors.As(err, &coded) || coded.status != 403 {
			t.Fatalf("error = %v, want 403", err)
		}
		if got := h.count(t, "SELECT COUNT(*) FROM Org WHERE slug = ?", slug); got != 0 {
			t.Fatalf("forbidden approval created an organization: %d", got)
		}
	})
}
