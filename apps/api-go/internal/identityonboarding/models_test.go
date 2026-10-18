package identityonboarding

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// TestUserViewNeverCarriesCredentials locks the narrowed reviewedBy projection:
// the non-credential scalars stay, and passwordHash never appears.
func TestUserViewNeverCarriesCredentials(t *testing.T) {
	verified := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	payload, err := json.Marshal(userRecord{
		ID:            "u1",
		Email:         "reviewer@example.com",
		EmailVerified: &verified,
		FirstName:     "Grace",
		LastName:      "Hopper",
		IsActive:      true,
		CreatedAt:     verified,
		UpdatedAt:     verified,
	}.view())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(payload), "passwordHash") {
		t.Fatalf("credential leaked: %s", payload)
	}
	for _, want := range []string{`"email":"reviewer@example.com"`, `"emailVerified":"2026-10-18T12:00:00.000Z"`,
		`"pendingEmail":null`, `"avatarUrl":null`} {
		if !strings.Contains(string(payload), want) {
			t.Fatalf("missing %s in %s", want, payload)
		}
	}
}

// TestApplicationRelationsStayNull locks the optional relation shape: an
// application without an organization serializes `org: null` instead of an empty
// object.
func TestApplicationRelationsStayNull(t *testing.T) {
	payload, err := json.Marshal(applicationWithOrg{applicationScalar: applicationRecord{
		ID:     "app1",
		Type:   applicationTypeNewOrg,
		Status: applicationStatusPending,
		Email:  "a@example.com",
	}.scalar()})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(payload), `"org":null`) {
		t.Fatalf("org must stay null: %s", payload)
	}
	if strings.Contains(string(payload), `"org":{}`) {
		t.Fatalf("empty relation object: %s", payload)
	}
}

// TestInvitePreviewOmitsTokenHash locks the public projection.
func TestInvitePreviewOmitsTokenHash(t *testing.T) {
	payload, err := json.Marshal(invitePreview{
		ID:        "inv1",
		Email:     "a@example.com",
		Org:       previewOrg{ID: "o1", Name: "Acme", Slug: "acme"},
		ExpiresAt: stamp(time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)),
		Status:    "pending",
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(payload), "tokenHash") {
		t.Fatalf("token hash leaked: %s", payload)
	}
	if !strings.Contains(string(payload), `"expiresAt":"2026-10-25T12:00:00.000Z"`) {
		t.Fatalf("date format: %s", payload)
	}
}
