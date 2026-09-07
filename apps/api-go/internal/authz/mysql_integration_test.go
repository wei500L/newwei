//go:build integration

// authz 的远端真实栈集成测试（build tag integration 与普通 go test 分离）。
//
// 一个测试函数覆盖 Go-批3A 授权重推导的关键语义（不追求分支全覆盖）：
//   - MembershipRole 多角色：权限 = 全部关联角色的并集（含 items.read）；
//   - MembershipRole 为空：回退 primary role（无 items.read → 无权限）；
//   - 拒绝语义与顺序：无 membership / 无匹配组织 / org 停用（先于
//     membership 停用）/ membership 停用 / user 停用 / user 不存在——与
//     NestJS getUserProfile 同序同文案；
//   - 租户隔离：另一组织上下文的 claim 不命中；
//   - Redis blacklist（真实 Redis）：key 存在 → revoked；不存在 → 未
//     撤销；值 "false"（JS falsy）→ 未撤销。
//
// 环境变量（CI 注入，缺省即跳过）：
//
//	DATABASE_URL=mysql://root:secret@127.0.0.1:3306/<db>
//	API_GO_TEST_REDIS_ADDR=127.0.0.1:6379（缺省跳过 blacklist 部分）
//
// 注意：本测试在 repository 层验证——「JWT permissions claim 不参与」
// 由结构保证（Authorize 的输入只有 userId/orgId）+ 端到端 smoke 验证。
package authz

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authn"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

func TestAuthZMySQLIntegration(t *testing.T) {
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set — integration test requires a MySQL service")
	}
	db, err := usersettings.OpenMySQLFromURL(databaseURL)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Prisma migration 同构的最小 RBAC 表（列名/类型/唯一键一致；省略
	// FK 约束——测试库直接插入 fixture 行，包括一条 user 不存在的
	// membership 以覆盖 NestJS 的同序分支）。
	for _, ddl := range []string{
		"CREATE TABLE IF NOT EXISTS `User` (" +
			"`id` VARCHAR(191) NOT NULL, `email` VARCHAR(191) NOT NULL, `passwordHash` VARCHAR(191) NOT NULL," +
			"`firstName` VARCHAR(191) NOT NULL, `lastName` VARCHAR(191) NOT NULL, `isActive` BOOLEAN NOT NULL DEFAULT true," +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL," +
			"UNIQUE INDEX `User_email_key`(`email`), PRIMARY KEY (`id`)" +
			") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `Org` (" +
			"`id` VARCHAR(191) NOT NULL, `name` VARCHAR(191) NOT NULL, `slug` VARCHAR(191) NOT NULL," +
			"`isActive` BOOLEAN NOT NULL DEFAULT true," +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL," +
			"UNIQUE INDEX `Org_slug_key`(`slug`), PRIMARY KEY (`id`)" +
			") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `Role` (" +
			"`id` VARCHAR(191) NOT NULL, `name` VARCHAR(191) NOT NULL, `isSystem` BOOLEAN NOT NULL DEFAULT false, `orgId` VARCHAR(191) NOT NULL," +
			"UNIQUE INDEX `Role_id_orgId_key`(`id`, `orgId`), UNIQUE INDEX `Role_orgId_name_key`(`orgId`, `name`), PRIMARY KEY (`id`)" +
			") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `Permission` (" +
			"`id` VARCHAR(191) NOT NULL, `name` VARCHAR(191) NOT NULL," +
			"UNIQUE INDEX `Permission_name_key`(`name`), PRIMARY KEY (`id`)" +
			") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `RolePermission` (" +
			"`id` VARCHAR(191) NOT NULL, `roleId` VARCHAR(191) NOT NULL, `permissionId` VARCHAR(191) NOT NULL," +
			"UNIQUE INDEX `RolePermission_roleId_permissionId_key`(`roleId`, `permissionId`), PRIMARY KEY (`id`)" +
			") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `Membership` (" +
			"`id` VARCHAR(191) NOT NULL, `userId` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL," +
			"`roleId` VARCHAR(191) NOT NULL, `isActive` BOOLEAN NOT NULL DEFAULT true," +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"UNIQUE INDEX `Membership_userId_orgId_key`(`userId`, `orgId`), PRIMARY KEY (`id`)" +
			") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `MembershipRole` (" +
			"`membershipId` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `roleId` VARCHAR(191) NOT NULL," +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"PRIMARY KEY (`membershipId`, `roleId`)" +
			") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
	} {
		if _, err := db.ExecContext(ctx, ddl); err != nil {
			t.Fatalf("create table: %v", err)
		}
	}

	// fixture 常量（固定前缀便于幂等清理）。
	const (
		orgA      = "org-authz-a" // active
		orgB      = "org-authz-b" // active（租户隔离对照）
		orgC      = "org-authz-c" // inactive
		orgD      = "org-authz-d" // active（membership inactive 用）
		userMulti = "user-authz-multi"
		userPrim  = "user-authz-primary"
		userOff   = "user-authz-off"
		userGhost = "user-authz-ghost" // 无 membership
		roleR1    = "role-authz-r1"    // items.read
		roleR2    = "role-authz-r2"    // settings.manage（无 items.read）
		permRead  = "perm-authz-items-read"
		permMgmt  = "perm-authz-settings-manage"
	)
	now := time.Date(2026, 9, 7, 0, 0, 0, 0, time.UTC)

	// 幂等清理旧 fixture。
	cleanup := []struct {
		query string
		args  []any
	}{
		{"DELETE FROM `MembershipRole` WHERE `orgId` LIKE 'org-authz-%' OR `membershipId` LIKE 'm-authz-%'", nil},
		{"DELETE FROM `Membership` WHERE `orgId` LIKE 'org-authz-%' OR `userId` LIKE 'user-authz-%'", nil},
		{"DELETE FROM `Role` WHERE `orgId` LIKE 'org-authz-%'", nil},
		{"DELETE FROM `RolePermission` WHERE `id` LIKE 'rp-authz-%'", nil},
		{"DELETE FROM `Permission` WHERE `id` IN (?, ?)", []any{permRead, permMgmt}},
		{"DELETE FROM `User` WHERE `id` LIKE 'user-authz-%'", nil},
		{"DELETE FROM `Org` WHERE `id` LIKE 'org-authz-%'", nil},
	}
	for _, stmt := range cleanup {
		if _, err := db.ExecContext(ctx, stmt.query, stmt.args...); err != nil {
			t.Fatalf("cleanup %s: %v", stmt.query, err)
		}
	}

	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.ExecContext(ctx, query, args...); err != nil {
			t.Fatalf("exec %s: %v", query, err)
		}
	}

	insertUser := func(id string, active bool) {
		exec("INSERT INTO `User` (`id`, `email`, `passwordHash`, `firstName`, `lastName`, `isActive`, `updatedAt`) VALUES (?, ?, 'x', 'a', 'b', ?, ?)",
			id, id+"@example.com", active, now)
	}
	insertOrg := func(id string, active bool) {
		exec("INSERT INTO `Org` (`id`, `name`, `slug`, `isActive`, `updatedAt`) VALUES (?, 'n', ?, ?, ?)",
			id, "slug-"+id, active, now)
	}

	insertOrg(orgA, true)
	insertOrg(orgB, true)
	insertOrg(orgC, false)
	insertOrg(orgD, true)
	insertUser(userMulti, true)
	insertUser(userPrim, true)
	insertUser(userOff, false)
	insertUser(userGhost, true)
	exec("INSERT INTO `Role` (`id`, `name`, `orgId`) VALUES (?, 'r1', ?), (?, 'r2', ?)", roleR1, orgA, roleR2, orgA)
	exec("INSERT INTO `Permission` (`id`, `name`) VALUES (?, 'items.read'), (?, 'settings.manage')", permRead, permMgmt)
	exec("INSERT INTO `RolePermission` (`id`, `roleId`, `permissionId`) VALUES ('rp-authz-1', ?, ?), ('rp-authz-2', ?, ?)",
		roleR1, permRead, roleR2, permMgmt)

	// multi：MembershipRole 关联 [R1, R2]（primary 亦为 R1——多角色优先，
	// 权限必须是 R1∪R2 而非仅 primary）。
	exec("INSERT INTO `Membership` (`id`, `userId`, `orgId`, `roleId`, `isActive`) VALUES ('m-authz-multi', ?, ?, ?, true)", userMulti, orgA, roleR1)
	exec("INSERT INTO `MembershipRole` (`membershipId`, `orgId`, `roleId`) VALUES ('m-authz-multi', ?, ?), ('m-authz-multi', ?, ?)",
		orgA, roleR1, orgA, roleR2)
	// primary：无 MembershipRole——回退 primary role R2（无 items.read）。
	exec("INSERT INTO `Membership` (`id`, `userId`, `orgId`, `roleId`, `isActive`) VALUES ('m-authz-primary', ?, ?, ?, true)", userPrim, orgA, roleR2)
	// multi 用户在停用组织 orgC 中的第二 membership（claim orgC → org 停用
	// 拒绝；同时验证多 membership 下按 claim 正确选中）。
	exec("INSERT INTO `Membership` (`id`, `userId`, `orgId`, `roleId`, `isActive`) VALUES ('m-authz-multi-c', ?, ?, ?, true)", userMulti, orgC, roleR1)
	// membership 停用（orgD active + membership inactive）。
	exec("INSERT INTO `Membership` (`id`, `userId`, `orgId`, `roleId`, `isActive`) VALUES ('m-authz-off', ?, ?, ?, false)", userOff, orgD, roleR1)
	// userOff 的第二 membership：org/membership 均 active——命中 user 停用。
	exec("INSERT INTO `Membership` (`id`, `userId`, `orgId`, `roleId`, `isActive`) VALUES ('m-authz-user-off', ?, ?, ?, true)", userOff, orgA, roleR1)
	// user 不存在但 membership 存在（FK 省略才可构造；NestJS 同序分支）。
	exec("INSERT INTO `Membership` (`id`, `userId`, `orgId`, `roleId`, `isActive`) VALUES ('m-authz-ghost', 'user-authz-no-such-user', ?, ?, true)", orgA, roleR1)

	repo := NewMySQLRepository(db)

	// 1. 多角色：items.read（R1）与 settings.manage（R2）都在——并集语义。
	auth, err := repo.Authorize(ctx, userMulti, orgA)
	if err != nil {
		t.Fatalf("authorize multi: %v", err)
	}
	if !auth.HasPermission("items.read") || !auth.HasPermission("settings.manage") {
		t.Errorf("multi-role permissions = %v, want items.read+settings.manage（多角色并集）", auth.Permissions)
	}
	if auth.OrgID != orgA || auth.UserID != userMulti {
		t.Errorf("auth identity = %s/%s, want %s/%s", auth.UserID, auth.OrgID, userMulti, orgA)
	}

	// 2. primary fallback：无 MembershipRole → 仅 R2 权限，无 items.read。
	auth, err = repo.Authorize(ctx, userPrim, orgA)
	if err != nil {
		t.Fatalf("authorize primary: %v", err)
	}
	if auth.HasPermission("items.read") {
		t.Errorf("primary-only permissions = %v, want no items.read（R2 无该权限）", auth.Permissions)
	}
	if !auth.HasPermission("settings.manage") {
		t.Errorf("primary-only permissions = %v, want settings.manage（primary role R2）", auth.Permissions)
	}

	// 3. 拒绝语义与顺序（与 getUserProfile 同序同文案）。org 停用先于
	// membership 停用（userOff 同时有两种状态，但分属不同 org 的
	// membership——各自命中对应分支）。
	rejectChecks := []struct {
		name        string
		userID      string
		orgID       string
		wantMessage string
	}{
		{"no-membership", userGhost, orgA, RejectNoMembership},
		{"org-not-matched", userMulti, orgB, RejectMembershipMissing},
		{"org-disabled", userMulti, orgC, RejectOrgDisabled},
		{"membership-inactive", userOff, orgD, RejectMembershipOff},
		{"user-disabled", userOff, orgA, RejectUserDisabled},
		{"user-missing-but-membership-exists", "user-authz-no-such-user", orgA, RejectUserMissing},
	}
	for _, tc := range rejectChecks {
		_, err := repo.Authorize(ctx, tc.userID, tc.orgID)
		if err == nil {
			t.Errorf("%s: Authorize succeeded, want rejection", tc.name)
			continue
		}
		rej, ok := err.(*Rejection)
		if !ok {
			t.Errorf("%s: error = %v, want *Rejection", tc.name, err)
			continue
		}
		if rej.Message != tc.wantMessage {
			t.Errorf("%s: message = %q, want %q", tc.name, rej.Message, tc.wantMessage)
		}
	}

	// 4. Redis blacklist（真实 Redis；缺省跳过——MySQL 语义已覆盖）。
	// key 前缀是 authn 与 NestJS 的共同契约，此处用字面量验证契约本身。
	if addr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR")); addr != "" {
		client := redis.NewClient(&redis.Options{Addr: addr})
		defer client.Close()
		blacklist := authn.NewRedisBlacklist(client)
		if err := client.Set(ctx, "access-token:blacklist:authz-it-revoked-jti", "true", time.Minute).Err(); err != nil {
			t.Fatalf("seed blacklist key: %v", err)
		}
		if err := client.Set(ctx, "access-token:blacklist:authz-it-falsy-jti", "false", time.Minute).Err(); err != nil {
			t.Fatalf("seed falsy blacklist key: %v", err)
		}
		blacklistCases := []struct {
			jti  string
			want bool
		}{
			{"authz-it-revoked-jti", true},
			{"authz-it-never-issued-jti", false},
			{"", false},
			{"authz-it-falsy-jti", false},
		}
		for _, tc := range blacklistCases {
			revoked, err := blacklist.Revoked(ctx, tc.jti)
			if err != nil {
				t.Fatalf("blacklist %q: %v", tc.jti, err)
			}
			if revoked != tc.want {
				t.Errorf("blacklist %q = %v, want %v", tc.jti, revoked, tc.want)
			}
		}
	} else {
		t.Log("API_GO_TEST_REDIS_ADDR not set — skipping blacklist assertions")
	}
}
