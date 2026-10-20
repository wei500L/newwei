package auditoutbox

import (
	"encoding/json"
	"testing"
	"time"
)

// TestParsePayloadKeepsPresenceAndValues locks the producer contract: required
// members must be non-blank strings, actor/ip normalize to null, metadata
// preserves the difference between an absent member and an explicit null, and
// the value is never trimmed.
func TestParsePayloadKeepsPresenceAndValues(t *testing.T) {
	cases := []struct {
		name        string
		raw         string
		wantOK      bool
		wantActor   *string
		wantIP      *string
		wantMeta    string
		wantHasMeta bool
	}{
		{
			name:     "iso-millis-without-optional-members",
			raw:      `{"orgId":"org-1","resource":"audit","action":"create","createdAt":"2026-10-19T10:00:00.123Z"}`,
			wantOK:   true,
			wantMeta: "",
		},
		{
			name:        "explicit-null-and-values",
			raw:         `{"orgId":" org-1 ","actorId":null,"resource":" user ","action":" update ","metadata":null,"ipAddress":" 10.0.0.1 ","createdAt":"2026-10-19T10:00:00.123Z"}`,
			wantOK:      true,
			wantIP:      strPtr(" 10.0.0.1 "),
			wantMeta:    "null",
			wantHasMeta: true,
		},
		{
			name:        "metadata-object",
			raw:         `{"orgId":"org-1","actorId":"user-1","resource":"audit","action":"create","metadata":{"email":"a@b.c"},"ipAddress":null,"createdAt":"2026-10-19T10:00:00.123Z"}`,
			wantOK:      true,
			wantActor:   strPtr("user-1"),
			wantMeta:    `{"email":"a@b.c"}`,
			wantHasMeta: true,
		},
		{
			name:     "non-string-actor-and-ip-normalize-to-null",
			raw:      `{"orgId":"org-1","actorId":42,"resource":"audit","action":"create","ipAddress":true,"createdAt":"2026-10-19T10:00:00Z"}`,
			wantOK:   true,
			wantMeta: "",
		},
		{
			name:   "array-root",
			raw:    `[{"orgId":"org-1"}]`,
			wantOK: false,
		},
		{
			name:   "null-root",
			raw:    `null`,
			wantOK: false,
		},
		{
			name:   "blank-org",
			raw:    `{"orgId":"   ","resource":"audit","action":"create","createdAt":"2026-10-19T10:00:00Z"}`,
			wantOK: false,
		},
		{
			name:   "non-string-resource",
			raw:    `{"orgId":"org-1","resource":7,"action":"create","createdAt":"2026-10-19T10:00:00Z"}`,
			wantOK: false,
		},
		{
			name:   "unparsable-created-at",
			raw:    `{"orgId":"org-1","resource":"audit","action":"create","createdAt":"yesterday"}`,
			wantOK: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			payload, ok := parsePayload(json.RawMessage(tc.raw))
			if ok != tc.wantOK {
				t.Fatalf("ok = %t, want %t", ok, tc.wantOK)
			}
			if !ok {
				return
			}
			if payload.OrgID != jsonString(tc.raw, "orgId") {
				t.Fatalf("orgId = %q, want the stored value", payload.OrgID)
			}
			if !equalPtr(payload.ActorID, tc.wantActor) {
				t.Fatalf("actorId = %v, want %v", payload.ActorID, tc.wantActor)
			}
			if !equalPtr(payload.IPAddress, tc.wantIP) {
				t.Fatalf("ipAddress = %v, want %v", payload.IPAddress, tc.wantIP)
			}
			if string(payload.Metadata) != tc.wantMeta {
				t.Fatalf("metadata = %q, want %q", payload.Metadata, tc.wantMeta)
			}
			if (payload.Metadata != nil) != tc.wantHasMeta {
				t.Fatalf("metadata presence = %t, want %t", payload.Metadata != nil, tc.wantHasMeta)
			}
			if payload.CreatedAt.Location() != time.UTC || payload.CreatedAt.Nanosecond()%int(time.Millisecond) != 0 {
				t.Fatalf("createdAt = %s, want UTC millisecond precision", payload.CreatedAt)
			}
		})
	}
}

func strPtr(value string) *string { return &value }

func equalPtr(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func jsonString(raw, key string) string {
	var decoded map[string]any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return ""
	}
	value, _ := decoded[key].(string)
	return value
}
