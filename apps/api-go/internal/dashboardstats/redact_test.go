package dashboardstats

import (
	"encoding/json"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestRecentLogRedactsSecretsLikeNest(t *testing.T) {
	log := recentLogFromDoc(bson.M{
		"message": "upload failed: Authorization=Bearer eyJhbGciOi.payload.sig password=hunter2",
		"stage":   "upload",
		"status":  "failed",
	})
	encoded, err := json.Marshal(log)
	if err != nil {
		t.Fatal(err)
	}
	body := string(encoded)
	if body != `{"message":"upload failed: Authorization=Bearer [REDACTED] password=[REDACTED]","stage":"upload","status":"failed"}` {
		t.Fatalf("redacted log = %s", body)
	}
}

func TestRecentLogKeepsEmptyAndNullMessages(t *testing.T) {
	empty, err := json.Marshal(recentLogFromDoc(bson.M{"message": ""}))
	if err != nil {
		t.Fatal(err)
	}
	if string(empty) != `{"message":""}` {
		t.Fatalf("empty message = %s", empty)
	}
	null, err := json.Marshal(recentLogFromDoc(bson.M{"message": nil}))
	if err != nil {
		t.Fatal(err)
	}
	if string(null) != `{"message":null}` {
		t.Fatalf("null message = %s", null)
	}
	missing, err := json.Marshal(recentLogFromDoc(bson.M{"stage": "ingest"}))
	if err != nil {
		t.Fatal(err)
	}
	if string(missing) != `{"stage":"ingest"}` {
		t.Fatalf("missing message = %s", missing)
	}
}

func TestRedactSensitiveFieldsMatchesSanitizer(t *testing.T) {
	cases := []struct{ input, want string }{
		{"token=abc123 done", "token=[REDACTED] done"},
		{"api_key: s3cret; retry", "api_key:[REDACTED] retry"},
		{"used Basic dXNlcjpwYXNz", "used Basic [REDACTED]"},
		{"no secrets here", "no secrets here"},
	}
	for _, entry := range cases {
		if got := redactSensitiveFields(entry.input); got != entry.want {
			t.Fatalf("redact(%q) = %q, want %q", entry.input, got, entry.want)
		}
	}
}
