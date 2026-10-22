package rbacapi

import (
	"encoding/json"
	"strings"
	"testing"
)

// GET /api/rbac/members must never serialize a member's password hash. The
// NestJS controller returned the raw Prisma User row, so users.read (held by the
// built-in analyst role) was enough to read every member's bcrypt hash; the Go
// port keeps the column scanned but drops it from the response body.
func TestUserViewNeverSerializesPasswordHash(t *testing.T) {
	payload, err := json.Marshal(membershipJSON{
		ID:       "membership-1",
		UserID:   "user-1",
		OrgID:    "org-1",
		RoleID:   "role-1",
		IsActive: true,
		User: userJSON{
			ID:           "user-1",
			Email:        "analyst@example.com",
			PasswordHash: "$2b$12$abcdefghijklmnopqrstuv",
			FirstName:    "Ana",
			LastName:     "Lyst",
			IsActive:     true,
		},
	})
	if err != nil {
		t.Fatalf("marshal membership: %v", err)
	}

	body := string(payload)
	if strings.Contains(body, "passwordHash") {
		t.Fatalf("members response must not carry a passwordHash field: %s", body)
	}
	if strings.Contains(body, "$2b$") {
		t.Fatalf("members response leaked a hash value: %s", body)
	}
	// The rest of the row must still be present, otherwise the fix would have
	// removed a field the Web client actually reads.
	for _, want := range []string{`"email":"analyst@example.com"`, `"firstName":"Ana"`, `"isActive":true`} {
		if !strings.Contains(body, want) {
			t.Errorf("members response is missing %s: %s", want, body)
		}
	}
}
