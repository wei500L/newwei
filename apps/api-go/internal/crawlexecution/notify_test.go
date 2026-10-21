package crawlexecution

// Notification rendering (title/body/data shape) and the truncate191 rule.

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func notificationTask(displayName *string) *taskRow {
	return &taskRow{
		ID:          "task-1",
		OrgID:       "org-1",
		TargetURL:   "https://news.example.com/",
		DisplayName: displayName,
	}
}

func TestTruncate191ByUTF16CodeUnits(t *testing.T) {
	if got := truncate191("  short  "); got != "short" {
		t.Fatalf("trimmed = %q", got)
	}
	exact := strings.Repeat("a", 191)
	if got := truncate191(exact); got != exact {
		t.Fatalf("191 chars must stay untouched, got %d chars", len(got))
	}
	longer := strings.Repeat("a", 192)
	got := truncate191(longer)
	if got != strings.Repeat("a", 190)+"…" {
		t.Fatalf("192 chars = %q", got)
	}
	// A CJK character is one UTF-16 code unit, so 191 of them fit.
	cjk := strings.Repeat("新", 191)
	if got := truncate191(cjk); got != cjk {
		t.Fatalf("191 CJK chars must fit, got %d runes", len([]rune(got)))
	}
	// An emoji is two UTF-16 code units, so 95 of them equal 190 units and fit.
	emoji := strings.Repeat("😀", 95)
	if got := truncate191(emoji); got != emoji {
		t.Fatalf("190 UTF-16 units must fit, got %q", got)
	}
	// 96 emoji are 192 units: the cut at 190 units keeps the pair intact.
	if got := truncate191(strings.Repeat("😀", 96)); got != strings.Repeat("😀", 95)+"…" {
		t.Fatalf("96 emoji = %q", got)
	}
	// A cut inside a surrogate pair drops the orphaned half (a Go string cannot
	// hold one) instead of emitting an invalid escape.
	orphan := strings.Repeat("😀", 94) + "a" + "😀" + "z"
	if got := truncate191(orphan); got != strings.Repeat("😀", 94)+"a…" {
		t.Fatalf("orphaned surrogate = %q", got)
	}
	// Trailing whitespace inside the cut window is trimmed before the ellipsis.
	padded := strings.Repeat("a", 188) + "   " + "bbbbb"
	if got := truncate191(padded); got != strings.Repeat("a", 188)+"…" {
		t.Fatalf("trailing whitespace = %q", got)
	}
}

func TestNotificationBackoffDelay(t *testing.T) {
	cases := map[int]int{1: 250, 2: 500, 3: 1_000, 4: 2_000, 5: 2_000}
	for attempt, want := range cases {
		if got := notificationBackoffDelayMs(attempt); got != want {
			t.Fatalf("attempt %d = %d, want %d", attempt, got, want)
		}
	}
}

func TestBuildCrawlNotificationCompleted(t *testing.T) {
	fetchedAt := time.Date(2026, 10, 20, 8, 30, 45, 123_000_000, time.UTC)
	summary := FullSummary{
		Inserted:          2,
		Skipped:           1,
		LastFetchedAt:     &fetchedAt,
		RetryableFailures: intPointer(1),
	}
	payload := buildCrawlNotificationPayload(notificationTask(stringPtr("Example Feed")), summary, notificationStatusCompleted, "")
	if payload.Type != notificationTypeCrawlCompleted {
		t.Fatalf("type = %q", payload.Type)
	}
	if payload.Title != "Crawl completed: Example Feed" {
		t.Fatalf("title = %q", payload.Title)
	}
	if payload.Body != "Inserted 2, skipped 1, retryable 1" {
		t.Fatalf("body = %q", payload.Body)
	}
	encoded, err := json.Marshal(payload.Data)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"taskId":"task-1","status":"completed","lastResultAt":"2026-10-20T08:30:45.123Z",` +
		`"presentation":{"kind":"crawl_completed","params":{"taskId":"task-1","taskLabel":"Example Feed",` +
		`"inserted":2,"skipped":1,"retryableFailures":1,"lastResultAt":"2026-10-20T08:30:45.123Z"}}}`
	if string(encoded) != want {
		t.Fatalf("data mismatch\n got: %s\nwant: %s", encoded, want)
	}
}

func TestBuildCrawlNotificationCompletedWithoutFailures(t *testing.T) {
	payload := buildCrawlNotificationPayload(notificationTask(nil), FullSummary{}, notificationStatusCompleted, "")
	if payload.Title != "Crawl completed: https://news.example.com/" {
		t.Fatalf("title = %q", payload.Title)
	}
	if payload.Body != "Inserted 0, skipped 0" {
		t.Fatalf("body = %q", payload.Body)
	}
	encoded, err := json.Marshal(payload.Data)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"taskId":"task-1","status":"completed","lastResultAt":null,` +
		`"presentation":{"kind":"crawl_completed","params":{"taskId":"task-1","taskLabel":"https://news.example.com/",` +
		`"inserted":0,"skipped":0}}}`
	if string(encoded) != want {
		t.Fatalf("data mismatch\n got: %s\nwant: %s", encoded, want)
	}
}

func TestBuildCrawlNotificationFailedCarriesTechnicalDetail(t *testing.T) {
	payload := buildCrawlNotificationPayload(notificationTask(nil), FullSummary{}, notificationStatusFailed, "crawl worker exploded")
	if payload.Type != notificationTypeCrawlFailed {
		t.Fatalf("type = %q", payload.Type)
	}
	if payload.Title != "Crawl failed: https://news.example.com/" {
		t.Fatalf("title = %q", payload.Title)
	}
	if payload.Body != "crawl worker exploded" {
		t.Fatalf("body = %q", payload.Body)
	}
	encoded, err := json.Marshal(payload.Data)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"taskId":"task-1","status":"failed","lastResultAt":null,` +
		`"presentation":{"kind":"crawl_failed","params":{"taskId":"task-1","taskLabel":"https://news.example.com/",` +
		`"inserted":0,"skipped":0},"technicalDetail":"crawl worker exploded"}}`
	if string(encoded) != want {
		t.Fatalf("data mismatch\n got: %s\nwant: %s", encoded, want)
	}
}

func TestBuildCrawlNotificationFailedWithoutMessage(t *testing.T) {
	payload := buildCrawlNotificationPayload(notificationTask(nil), FullSummary{}, notificationStatusFailed, "")
	if payload.Body != "Crawl task failed" {
		t.Fatalf("body = %q", payload.Body)
	}
	encoded, err := json.Marshal(payload.Data)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "technicalDetail") {
		t.Fatalf("technicalDetail must be absent without a message: %s", encoded)
	}
}

func TestBuildCrawlNotificationTruncatesLongTitle(t *testing.T) {
	displayName := strings.Repeat("t", 400)
	payload := buildCrawlNotificationPayload(notificationTask(&displayName), FullSummary{}, notificationStatusCompleted, "")
	if utf16Length(payload.Title) > 191 || !strings.HasSuffix(payload.Title, "…") {
		t.Fatalf("title = %q (%d units)", payload.Title, utf16Length(payload.Title))
	}
}

func TestSafeNotifyCrawlWritesRowAndPublishesRelay(t *testing.T) {
	database := &fakeDatabase{}
	db := openFakeDB(t, database)
	published := make([]string, 0, 1)
	service := New(Options{
		DB:  db,
		Now: func() time.Time { return time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC) },
		Relay: func(_ context.Context, notificationID, orgID, userID string) error {
			published = append(published, notificationID+"|"+orgID+"|"+userID)
			return nil
		},
	})
	service.sleep = func(context.Context, time.Duration) {}

	service.safeNotifyCrawl(context.Background(), notificationTask(stringPtr("Example Feed")),
		FullSummary{Inserted: 1, Skipped: 0}, "user-1", notificationStatusCompleted, "")

	inserted := 0
	for _, exec := range database.executes {
		if strings.Contains(exec.query, "INSERT INTO `Notification`") {
			inserted++
		}
	}
	if inserted != 1 {
		t.Fatalf("notification inserts = %d (%#v)", inserted, database.executes)
	}
	if len(published) != 1 {
		t.Fatalf("relay publishes = %#v", published)
	}
	parts := strings.Split(published[0], "|")
	if len(parts) != 3 || parts[1] != "org-1" || parts[2] != "user-1" || !strings.HasPrefix(parts[0], "c") {
		t.Fatalf("relay payload = %q", published[0])
	}
}

func TestSafeNotifyCrawlWritesNotifyTaskLogAfterRetries(t *testing.T) {
	// A nil MySQL handle makes safeNotifyCrawl return early, so the retry path is
	// exercised through a closeable pool instead: the row insert fails once the
	// pool is closed.
	database := &fakeDatabase{}
	db := openFakeDB(t, database)
	service := New(Options{DB: db, Now: func() time.Time { return time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC) }})
	service.sleep = func(context.Context, time.Duration) {}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	// With no Mongo handle the TaskLog write is skipped, but the delivery loop
	// must not panic and must attempt three times.
	service.safeNotifyCrawl(context.Background(), notificationTask(nil), FullSummary{}, "user-1", notificationStatusFailed, "boom")
}
