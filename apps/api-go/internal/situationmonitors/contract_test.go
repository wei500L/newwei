package situationmonitors

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/contentsubscriptions"
)

func TestLockNameMatchesSubscriptions(t *testing.T) {
	if contentsubscriptions.UserLockName("org", "user") != "ucs:org:user" {
		t.Fatalf("short lock = %s", contentsubscriptions.UserLockName("org", "user"))
	}
	if contentsubscriptions.UserLockTimeoutSeconds() != 10 {
		t.Fatalf("timeout = %d", contentsubscriptions.UserLockTimeoutSeconds())
	}
	longOrg := strings.Repeat("o", 40)
	longUser := strings.Repeat("u", 40)
	name := contentsubscriptions.UserLockName(longOrg, longUser)
	if !strings.HasPrefix(name, "ucs:") || len([]rune(name)) > 64 {
		t.Fatalf("long lock = %s (%d)", name, len([]rune(name)))
	}
	if name == "ucs:"+longOrg+":"+longUser {
		t.Fatal("long lock was not hashed")
	}
}

func TestSystemSyncRejectsContentChanges(t *testing.T) {
	if (monitorPatch{Enabled: optionalBool{set: true, value: false}}).rejectsSystemSync() {
		t.Fatal("enabled-only patch was treated as read only")
	}
	if (monitorPatch{Color: optionalString{set: true, value: "#fff"}}).rejectsSystemSync() {
		t.Fatal("color patch was treated as read only")
	}
	for _, patch := range []monitorPatch{
		{Name: optionalString{set: true, value: "x"}},
		{RawKeywords: optionalStrings{set: true, value: []string{"k"}}},
		{ApprovedTopics: optionalStrings{set: true}},
		{Location: optionalLocation{set: true}},
	} {
		if !patch.rejectsSystemSync() {
			t.Fatalf("patch %+v was allowed", patch)
		}
	}
}

func TestCreateRejectsBodyIdentity(t *testing.T) {
	_, err := validateCreate([]byte(`{"name":"A","rawKeywords":["k"],"orgId":"other","userId":"other"}`), false)
	if err == nil || !strings.Contains(err.Error(), "property orgId should not exist") || !strings.Contains(err.Error(), "property userId should not exist") {
		t.Fatalf("identity body error = %v", err)
	}
}

func TestMapRowOmitsEmptyOptionals(t *testing.T) {
	encoded, err := json.Marshal(mapRow(monitorRow{ID: "m1", Kind: "manual", Name: "One", Enabled: true}))
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	for _, absent := range []string{`"color"`, `"location"`, `"lastResolvedAt"`, `"queryEmbeddingModel"`, `"queryEmbeddingVector"`} {
		if strings.Contains(text, absent) {
			t.Fatalf("response included %s: %s", absent, text)
		}
	}
}
