package accountsecurity

import (
	"context"
	"crypto/sha256"
	"database/sql/driver"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
	"time"
)

const (
	testOrgID  = "org-1"
	testUserID = "user-1"
)

// rotateSelectRow builds the FOR UPDATE row the rotation transaction reads.
func rotateSelectRow(name string, permissions string, createdBy driver.Value, expires driver.Value) func(string, []driver.NamedValue) (driver.Rows, error) {
	return func(query string, _ []driver.NamedValue) (driver.Rows, error) {
		if !strings.Contains(query, "FOR UPDATE") {
			return nil, errors.New("unexpected query: " + query)
		}
		return rowsWithValues(
			[]string{"id", "name", "permissions", "createdById", "expiresAt"},
			"mtk_old", name, []byte(permissions), createdBy, expires), nil
	}
}

func TestRotateMachineTokenInheritsCreatorAndExpiry(t *testing.T) {
	expires := time.Date(2030, 1, 2, 3, 4, 5, 0, time.UTC)
	state := &fakeState{}
	state.queryHandler = rotateSelectRow("legacy name", `["metrics.read"]`, testUserID, expires)
	var insertArgs []driver.NamedValue
	state.execHandler = func(query string, args []driver.NamedValue) (driver.Result, error) {
		if strings.Contains(query, "INSERT INTO `MachineAccessToken`") {
			insertArgs = args
		}
		return fakeResult{rows: 1}, nil
	}
	service := NewService(newFakeDB(state), nil, Config{})

	result, err := service.rotateMachineToken(context.Background(), &Identity{UserID: testUserID, OrgID: testOrgID}, "mtk_old")
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	commits, rollbacks := state.txCounts()
	if commits != 1 || rollbacks != 0 {
		t.Fatalf("commits=%d rollbacks=%d", commits, rollbacks)
	}
	if !strings.HasPrefix(result.Token, machineTokenPrefix) || len(result.Token) != len(machineTokenPrefix)+43 {
		t.Fatalf("token shape = %q", result.Token)
	}
	if result.Name != "legacy name" || len(result.Permissions) != 1 || result.Permissions[0] != "metrics.read" {
		t.Fatalf("result = %+v", result)
	}
	if result.ExpiresAt == nil || *result.ExpiresAt != "2030-01-02T03:04:05.000Z" {
		t.Fatalf("expiresAt = %v", result.ExpiresAt)
	}
	if got := namedArg(insertArgs, 6); got != testUserID {
		t.Fatalf("inherited createdById = %#v", got)
	}
	if got := namedArg(insertArgs, 3); got != "legacy name" {
		t.Fatalf("inherited name = %#v", got)
	}
	// The successor's token hash is the lowercase SHA-256 hex of the plaintext.
	expectedHash := sha256.Sum256([]byte(result.Token))
	if got := namedArg(insertArgs, 4); got != hex.EncodeToString(expectedHash[:]) {
		t.Fatalf("token hash = %#v", got)
	}
}

func TestRotateMachineTokenMachineCreatorBecomesNull(t *testing.T) {
	state := &fakeState{}
	state.queryHandler = rotateSelectRow("machine made", `["metrics.read"]`, "machine:abc", nil)
	var insertArgs []driver.NamedValue
	state.execHandler = func(_ string, args []driver.NamedValue) (driver.Result, error) {
		insertArgs = args
		return fakeResult{rows: 1}, nil
	}
	service := NewService(newFakeDB(state), nil, Config{})
	if _, err := service.rotateMachineToken(context.Background(), &Identity{UserID: testUserID, OrgID: testOrgID}, "mtk_old"); err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if got := namedArg(insertArgs, 6); got != nil {
		t.Fatalf("machine creator must become SQL NULL, got %#v", got)
	}
}

func TestRotateMachineTokenUnsupportedPermissionsLeavesOldRowUntouched(t *testing.T) {
	state := &fakeState{}
	// A historical token holding settings.manage only: the create-time whitelist
	// empties out, so the rotation must fail before revoking anything.
	state.queryHandler = rotateSelectRow("legacy", `["settings.manage"]`, testUserID, nil)
	service := NewService(newFakeDB(state), nil, Config{})

	_, err := service.rotateMachineToken(context.Background(), &Identity{UserID: testUserID, OrgID: testOrgID}, "mtk_old")
	wantBadRequest(t, err, "At least one supported permission is required")
	if statements := state.executedStatements(); len(statements) != 0 {
		t.Fatalf("the old row was touched: %v", statements)
	}
	if commits, rollbacks := state.txCounts(); commits != 0 || rollbacks != 1 {
		t.Fatalf("commits=%d rollbacks=%d", commits, rollbacks)
	}
}

func TestRotateMachineTokenInsertFailureRollsBack(t *testing.T) {
	state := &fakeState{}
	state.queryHandler = rotateSelectRow("legacy", `["metrics.read"]`, testUserID, nil)
	state.execHandler = func(query string, _ []driver.NamedValue) (driver.Result, error) {
		if strings.Contains(query, "INSERT INTO `MachineAccessToken`") {
			return nil, errors.New("simulated insert failure")
		}
		return fakeResult{rows: 1}, nil
	}
	service := NewService(newFakeDB(state), nil, Config{})

	_, err := service.rotateMachineToken(context.Background(), &Identity{UserID: testUserID, OrgID: testOrgID}, "mtk_old")
	if err == nil {
		t.Fatalf("expected the insert failure to surface")
	}
	commits, rollbacks := state.txCounts()
	if commits != 0 || rollbacks != 1 {
		t.Fatalf("commits=%d rollbacks=%d", commits, rollbacks)
	}
}

func TestRotateMachineTokenConditionalRevokeMustAffectOneRow(t *testing.T) {
	state := &fakeState{}
	state.queryHandler = rotateSelectRow("legacy", `["metrics.read"]`, testUserID, nil)
	state.execHandler = func(query string, _ []driver.NamedValue) (driver.Result, error) {
		if strings.Contains(query, "UPDATE `MachineAccessToken`") {
			return fakeResult{rows: 0}, nil
		}
		return fakeResult{rows: 1}, nil
	}
	service := NewService(newFakeDB(state), nil, Config{})

	_, err := service.rotateMachineToken(context.Background(), &Identity{UserID: testUserID, OrgID: testOrgID}, "mtk_old")
	wantBadRequest(t, err, "Machine token not found or already revoked")
	for _, statement := range state.executedStatements() {
		if strings.Contains(statement, "INSERT INTO `MachineAccessToken`") {
			t.Fatalf("successor inserted after a failed conditional revoke")
		}
	}
}

func TestCreateMachineTokenBlankNameAndUnsupportedPermissions(t *testing.T) {
	service := &Service{}
	_, err := service.createMachineToken(context.Background(), &Identity{UserID: testUserID, OrgID: testOrgID}, createMachineTokenValues{Name: "   ", Permissions: []string{"metrics.read"}})
	wantBadRequest(t, err, "Machine token name cannot be empty")

	_, err = service.createMachineToken(context.Background(), &Identity{UserID: testUserID, OrgID: testOrgID}, createMachineTokenValues{Name: "ci", Permissions: []string{"settings.manage"}})
	wantBadRequest(t, err, "At least one supported permission is required")

	// Permission normalization runs before the name check, exactly like NestJS.
	_, err = service.createMachineToken(context.Background(), &Identity{UserID: testUserID, OrgID: testOrgID}, createMachineTokenValues{Name: "  ", Permissions: nil})
	wantBadRequest(t, err, "At least one supported permission is required")
}

func TestCreateMachineTokenPersistsOnlyTheHash(t *testing.T) {
	state := &fakeState{}
	var insertArgs []driver.NamedValue
	state.execHandler = func(_ string, args []driver.NamedValue) (driver.Result, error) {
		insertArgs = args
		return fakeResult{rows: 1}, nil
	}
	service := NewService(newFakeDB(state), nil, Config{})

	result, err := service.createMachineToken(context.Background(), &Identity{
		UserID:    "machine:creator",
		OrgID:     testOrgID,
		IsMachine: true,
		Machine:   &machineIdentity{TokenID: "creator"},
	}, createMachineTokenValues{Name: "  nightly  ", Permissions: []string{" metrics.read ", "metrics.read", "settings.manage"}})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if result.Name != "nightly" {
		t.Fatalf("name = %q", result.Name)
	}
	if len(result.Permissions) != 1 || result.Permissions[0] != "metrics.read" {
		t.Fatalf("permissions = %v", result.Permissions)
	}
	expectedHash := sha256.Sum256([]byte(result.Token))
	if got := namedArg(insertArgs, 4); got != hex.EncodeToString(expectedHash[:]) {
		t.Fatalf("token hash = %#v", got)
	}
	// A machine actor is not a User row: the FK column must be SQL NULL (AS4).
	if got := namedArg(insertArgs, 6); got != nil {
		t.Fatalf("machine createdById = %#v", got)
	}
	encoded, ok := namedArg(insertArgs, 5).([]byte)
	if !ok {
		t.Fatalf("permissions arg = %#v", namedArg(insertArgs, 5))
	}
	if string(encoded) != `["metrics.read"]` {
		t.Fatalf("stored permissions = %s", encoded)
	}
}

func TestCreateMachineTokenHumanCreatorKept(t *testing.T) {
	state := &fakeState{}
	var insertArgs []driver.NamedValue
	state.execHandler = func(_ string, args []driver.NamedValue) (driver.Result, error) {
		insertArgs = args
		return fakeResult{rows: 1}, nil
	}
	service := NewService(newFakeDB(state), nil, Config{})
	if _, err := service.createMachineToken(context.Background(), &Identity{UserID: testUserID, OrgID: testOrgID}, createMachineTokenValues{Name: "ci", Permissions: []string{"metrics.read"}}); err != nil {
		t.Fatalf("create: %v", err)
	}
	if got := namedArg(insertArgs, 6); got != testUserID {
		t.Fatalf("human createdById = %#v", got)
	}
}

func TestRevokeMachineTokenUsesOneErrorForEveryMiss(t *testing.T) {
	state := &fakeState{}
	state.execHandler = func(string, []driver.NamedValue) (driver.Result, error) {
		return fakeResult{rows: 0}, nil
	}
	service := NewService(newFakeDB(state), nil, Config{})
	err := service.revokeMachineToken(context.Background(), testOrgID, "missing")
	wantBadRequest(t, err, "Machine token not found or already revoked")

	state.execHandler = func(string, []driver.NamedValue) (driver.Result, error) {
		return fakeResult{rows: 1}, nil
	}
	if err := service.revokeMachineToken(context.Background(), testOrgID, "mtk_1"); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	statement := state.executedStatements()[0]
	if !strings.Contains(statement, "`orgId` = ?") || !strings.Contains(statement, "`revokedAt` IS NULL") {
		t.Fatalf("revoke statement: %s", statement)
	}
}

// TestListMachineTokensKeepsStoredPermissions proves the list boundary returns
// the stored JSON as-is (no whitelist filtering), unlike create/rotate.
func TestListMachineTokensKeepsStoredPermissions(t *testing.T) {
	state := &fakeState{}
	state.queryHandler = func(query string, _ []driver.NamedValue) (driver.Rows, error) {
		if !strings.Contains(query, "FROM `MachineAccessToken`") {
			return nil, errors.New("unexpected query: " + query)
		}
		return rowsWithValues(
			[]string{"id", "name", "permissions", "expiresAt", "lastUsedAt", "revokedAt", "createdAt"},
			"mtk_1", "legacy", []byte(`["settings.manage","metrics.read"]`), nil, nil, nil,
			time.Date(2026, 5, 6, 7, 8, 9, 0, time.UTC)), nil
	}
	service := NewService(newFakeDB(state), nil, Config{})
	items, err := service.listMachineTokens(context.Background(), testOrgID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("items = %d", len(items))
	}
	if string(items[0].Permissions) != `["settings.manage","metrics.read"]` {
		t.Fatalf("permissions = %s", items[0].Permissions)
	}
	if items[0].ExpiresAt != nil || items[0].RevokedAt != nil || items[0].LastUsedAt != nil {
		t.Fatalf("null dates = %+v", items[0])
	}
	if items[0].CreatedAt != "2026-05-06T07:08:09.000Z" {
		t.Fatalf("createdAt = %q", items[0].CreatedAt)
	}
	payload, err := items.encodeJSON()
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if !strings.Contains(string(payload), `"expiresAt":null`) {
		t.Fatalf("null expiry must serialize as null: %s", payload)
	}
	// The list must never leak the plaintext token, its hash or the creator FK.
	for _, forbidden := range []string{`"token":`, `"tokenHash":`, `"createdById":`} {
		if strings.Contains(string(payload), forbidden) {
			t.Fatalf("list leaked %s: %s", forbidden, payload)
		}
	}
}
