package dashboardstats

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestCountsFromValues(t *testing.T) {
	counts, ok := countsFromValues([]any{nil, "", "-4", "nope", "1.5"}, nil)
	if !ok {
		t.Fatal("successful HMGET must stay available, including a missing key of nils")
	}
	if counts != (queueCounts{Waiting: 0, Active: 0, Completed: 0, Failed: 0, Delayed: 1.5}) {
		t.Fatalf("counts = %+v", counts)
	}

	counts, ok = countsFromValues([]any{"3", "0", "0x10", " 2 ", "+1"}, nil)
	if !ok || counts.Waiting != 3 || counts.Active != 0 || counts.Completed != 16 || counts.Failed != 2 || counts.Delayed != 1 {
		t.Fatalf("parsed = %+v ok=%v", counts, ok)
	}

	counts, ok = countsFromValues(nil, errors.New("dial tcp 127.0.0.1:6379: connection refused"))
	if ok {
		t.Fatal("redis error must set countsAvailable false")
	}
	if counts != (queueCounts{}) {
		t.Fatalf("redis error counts = %+v, want zeros", counts)
	}
}

func TestCountsKeyMatchesNest(t *testing.T) {
	if got := countsKey("org-a"); got != "queue:itemPipeline:org:org-a:counts" {
		t.Fatalf("key = %s", got)
	}
	if !strings.Contains(itemCountSQL, "WHERE orgId = ?") || strings.Contains(itemCountSQL, "%s") {
		t.Fatalf("item count SQL must bind orgId: %s", itemCountSQL)
	}
}

func TestParseMongoDatabaseDoesNotLeakURI(t *testing.T) {
	secret := "s3cret-password"
	cases := []string{
		"http://user:" + secret + "@localhost/app",
		"mongodb://user:" + secret + "@localhost:27017",
		"mongodb://user:" + secret + "@localhost:27017/app/extra",
		"not a uri " + secret,
	}
	for _, uri := range cases {
		if _, err := parseMongoDatabase(uri); err == nil || strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), "localhost") {
			t.Fatalf("uri rejected badly: err=%v", err)
		}
	}
	name, err := parseMongoDatabase("mongodb://user:" + secret + "@mongo:27017/app?authSource=admin")
	if err != nil || name != "app" {
		t.Fatalf("db = %q err=%v", name, err)
	}
}

func TestRecentLogJSONMatchesLeanShape(t *testing.T) {
	when := time.Date(2026, 3, 1, 0, 0, 0, 6_000_000, time.FixedZone("offset", 3*60*60))
	log := recentLog{
		createdAt:    when,
		hasCreatedAt: true,
		jobID:        "job-1",
		hasJobID:     true,
		hasMessage:   false,
		stage:        "dedupe",
		hasStage:     true,
		status:       "completed",
		hasStatus:    true,
	}
	body, err := log.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	got := string(body)
	want := `{"createdAt":"2026-03-01T00:00:00.006Z","jobId":"job-1","stage":"dedupe","status":"completed"}`
	if got != want {
		t.Fatalf("json = %s", got)
	}

	nullMessage := recentLog{hasMessage: true, msgNull: true, hasJobID: true, jobID: "job-2"}
	body, err = nullMessage.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != `{"jobId":"job-2","message":null}` {
		t.Fatalf("null message = %s", body)
	}
}
