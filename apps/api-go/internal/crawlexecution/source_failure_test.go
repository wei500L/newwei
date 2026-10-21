package crawlexecution

// B2: the news source failure counter, its terminal-only notification decision
// and the two notification payloads.

import (
	"context"
	"database/sql/driver"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/newssourcescheduler"
)

// fakeScheduler records the org-wide system notifications the crawl execution
// path requests (B2).
type fakeScheduler struct {
	mu            sync.Mutex
	notifications []fakeSystemNotification
}

type fakeSystemNotification struct {
	OrgID string
	Title string
	Body  string
	Data  json.RawMessage
	Relay bool
}

func (f *fakeScheduler) NotifySystemGeneric(
	ctx context.Context,
	orgID, title, body string,
	data json.RawMessage,
	relay newssourcescheduler.NotificationRelayFunc,
) {
	usedRelay := false
	if relay != nil {
		if err := relay(ctx, "notif-1", orgID, ""); err == nil {
			usedRelay = true
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.notifications = append(f.notifications, fakeSystemNotification{
		OrgID: orgID, Title: title, Body: body, Data: data, Relay: usedRelay,
	})
}

func (f *fakeScheduler) notificationCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.notifications)
}

func fixedBackoff(baseDelayMs, attempt, maxDelayMs int) int {
	value := baseDelayMs
	for index := 1; index < attempt; index++ {
		value *= 2
	}
	if value > maxDelayMs {
		value = maxDelayMs
	}
	return value
}

func sourceFailureTestInput(failureAt time.Time) sourceFailureInput {
	return sourceFailureInput{
		Threshold:                 3,
		AutoDisableThreshold:      0,
		FailureRecoveryDelayMs:    1_000,
		FailureMaxDelayMs:         60_000,
		CircuitBreakerBaseDelayMs: 2_000,
		CircuitBreakerMaxDelayMs:  120_000,
		FailureAt:                 failureAt,
		Backoff:                   fixedBackoff,
	}
}

func TestPlanSourceFailureSkipsInactiveSource(t *testing.T) {
	input := sourceFailureTestInput(fixedNow())
	input.IsActive = false
	plan := planSourceFailure(input)
	if !plan.Skipped {
		t.Fatalf("plan = %#v", plan)
	}
}

func TestPlanSourceFailureBelowThreshold(t *testing.T) {
	input := sourceFailureTestInput(fixedNow())
	input.IsActive = true
	input.PreviousFailures = 0
	plan := planSourceFailure(input)
	if plan.Skipped || plan.ConsecutiveFailures != 1 || plan.NotifyCircuitOpen || plan.NotifyAutoDisable {
		t.Fatalf("plan = %#v", plan)
	}
	if !plan.NextRunAt.Equal(fixedNow().Add(time.Second)) {
		t.Fatalf("nextRunAt = %v", plan.NextRunAt)
	}
	if plan.CircuitOpenUntil != nil {
		t.Fatalf("circuitOpenUntil = %v", plan.CircuitOpenUntil)
	}
}

func TestPlanSourceFailureCrossesThreshold(t *testing.T) {
	input := sourceFailureTestInput(fixedNow())
	input.IsActive = true
	input.PreviousFailures = 2
	plan := planSourceFailure(input)
	if plan.ConsecutiveFailures != 3 || !plan.NotifyCircuitOpen {
		t.Fatalf("plan = %#v", plan)
	}
	if plan.CircuitOpenUntil == nil || !plan.CircuitOpenUntil.Equal(fixedNow().Add(2*time.Second)) {
		t.Fatalf("circuitOpenUntil = %v", plan.CircuitOpenUntil)
	}
	// The retry delay for the third failure (4s) is longer than the circuit
	// window (2s), so nextRunAt keeps the retry delay.
	if !plan.NextRunAt.Equal(fixedNow().Add(4 * time.Second)) {
		t.Fatalf("nextRunAt = %v", plan.NextRunAt)
	}
}

func TestPlanSourceFailureAboveThresholdDoesNotNotify(t *testing.T) {
	input := sourceFailureTestInput(fixedNow())
	input.IsActive = true
	input.PreviousFailures = 3
	plan := planSourceFailure(input)
	if plan.ConsecutiveFailures != 4 || plan.NotifyCircuitOpen {
		t.Fatalf("plan = %#v", plan)
	}
	if plan.CircuitOpenUntil == nil {
		t.Fatal("the circuit window must keep extending past the threshold")
	}
}

func TestPlanSourceFailureAutoDisable(t *testing.T) {
	input := sourceFailureTestInput(fixedNow())
	input.IsActive = true
	input.PreviousFailures = 4
	input.AutoDisableThreshold = 5
	plan := planSourceFailure(input)
	if !plan.ShouldDisable || !plan.NotifyAutoDisable || plan.NotifyCircuitOpen {
		t.Fatalf("plan = %#v", plan)
	}
	// autoDisableThreshold=5, threshold=3: the circuit opened earlier, so only
	// the auto-disable notification fires.
	input.PreviousFailures = 5
	plan = planSourceFailure(input)
	if !plan.ShouldDisable || plan.NotifyAutoDisable {
		t.Fatalf("second crossing must not notify again: %#v", plan)
	}
}

func TestPlanSourceFailureBothThresholdsAtOnce(t *testing.T) {
	input := sourceFailureTestInput(fixedNow())
	input.IsActive = true
	input.PreviousFailures = 2
	input.AutoDisableThreshold = 3
	plan := planSourceFailure(input)
	if !plan.NotifyCircuitOpen || !plan.NotifyAutoDisable || !plan.ShouldDisable {
		t.Fatalf("plan = %#v", plan)
	}
}

func TestSourceCircuitOpenedNotificationShape(t *testing.T) {
	until := time.Date(2026, 10, 20, 12, 5, 30, 250_000_000, time.UTC)
	title, body, data, ok := sourceCircuitOpenedNotification("source-1", "Example Feed", 3, until)
	if !ok {
		t.Fatal("notification must be built")
	}
	if title != "News source circuit opened" {
		t.Fatalf("title = %q", title)
	}
	if body != `News source "Example Feed" reached 3 consecutive failures and is paused until 2026-10-20T12:05:30.250Z.` {
		t.Fatalf("body = %q", body)
	}
	want := `{"sourceId":"source-1","sourceName":"Example Feed","consecutiveFailures":3,` +
		`"circuitOpenUntil":"2026-10-20T12:05:30.250Z","presentation":{"kind":"news_source_circuit_opened",` +
		`"params":{"sourceId":"source-1","sourceName":"Example Feed","consecutiveFailures":3,` +
		`"circuitOpenUntil":"2026-10-20T12:05:30.250Z"}}}`
	if string(data) != want {
		t.Fatalf("data mismatch\n got: %s\nwant: %s", data, want)
	}
}

func TestSourceAutoDisabledNotificationShape(t *testing.T) {
	title, body, data, ok := sourceAutoDisabledNotification("source-1", "Example Feed", 5)
	if !ok {
		t.Fatal("notification must be built")
	}
	if title != "News source disabled after failures" {
		t.Fatalf("title = %q", title)
	}
	if body != `News source "Example Feed" was disabled after 5 consecutive failures.` {
		t.Fatalf("body = %q", body)
	}
	want := `{"sourceId":"source-1","consecutiveFailures":5,"sourceName":"Example Feed",` +
		`"presentation":{"kind":"news_source_auto_disabled","params":{"sourceId":"source-1",` +
		`"sourceName":"Example Feed","consecutiveFailures":5}}}`
	if string(data) != want {
		t.Fatalf("data mismatch\n got: %s\nwant: %s", data, want)
	}
}

func TestMarkSourceFailureStateNotifiesOnThresholdCrossing(t *testing.T) {
	failureAt := fixedNow()
	database := &fakeDatabase{nextRows: []fakeRowSet{{
		columns: []string{"consecutiveFailures", "isActive", "orgId", "name"},
		values:  [][]driver.Value{{2, true, "org-1", "Example Feed"}},
	}}}
	db := openFakeDB(t, database)
	scheduler := &fakeScheduler{}
	relayCalls := 0
	service := New(Options{
		DB:        db,
		Config:    Config{CircuitBreakerThreshold: 3, CircuitBreakerBaseDelayMs: 60_000, CircuitBreakerMaxDelayMs: 900_000},
		Scheduler: scheduler,
		Relay: func(_ context.Context, notificationID, orgID, userID string) error {
			relayCalls++
			if userID != "" {
				t.Fatalf("system notifications are org-wide, userId = %q", userID)
			}
			return nil
		},
		Now: fixedNow,
	})
	service.markSourceFailureState(context.Background(), "source-1", failureAt)

	updated := false
	for _, exec := range database.executes {
		if strings.Contains(exec.query, "UPDATE `NewsSource`") && strings.Contains(exec.query, "FOR UPDATE") {
			t.Fatalf("FOR UPDATE belongs to the SELECT: %q", exec.query)
		}
		if strings.Contains(exec.query, "UPDATE `NewsSource`") {
			updated = true
			if len(exec.args) < 2 {
				t.Fatalf("update args = %#v", exec.args)
			}
			if value, ok := exec.args[1].(int64); !ok || value != 3 {
				t.Fatalf("consecutiveFailures arg = %#v", exec.args[1])
			}
		}
	}
	if !updated {
		t.Fatalf("news source update missing: %#v", database.executes)
	}
	queried := false
	for _, query := range database.queried {
		if strings.Contains(query, "FOR UPDATE") {
			queried = true
		}
	}
	if !queried {
		t.Fatalf("row-locked select missing: %#v", database.queried)
	}
	if scheduler.notificationCount() != 1 {
		t.Fatalf("notifications = %#v", scheduler.notifications)
	}
	if relayCalls != 1 {
		t.Fatalf("relay calls = %d", relayCalls)
	}
	notification := scheduler.notifications[0]
	if notification.Title != "News source circuit opened" || notification.OrgID != "org-1" {
		t.Fatalf("notification = %#v", notification)
	}
	var payload map[string]any
	if err := json.Unmarshal(notification.Data, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["sourceId"] != "source-1" || payload["sourceName"] != "Example Feed" {
		t.Fatalf("payload = %#v", payload)
	}
	presentation, ok := payload["presentation"].(map[string]any)
	if !ok || presentation["kind"] != "news_source_circuit_opened" {
		t.Fatalf("presentation = %#v", payload["presentation"])
	}
}

func TestMarkSourceFailureStateBelowThresholdDoesNotNotify(t *testing.T) {
	database := &fakeDatabase{nextRows: []fakeRowSet{{
		columns: []string{"consecutiveFailures", "isActive", "orgId", "name"},
		values:  [][]driver.Value{{0, true, "org-1", "Example Feed"}},
	}}}
	db := openFakeDB(t, database)
	scheduler := &fakeScheduler{}
	service := New(Options{
		DB:        db,
		Config:    Config{CircuitBreakerThreshold: 3},
		Scheduler: scheduler,
		Now:       fixedNow,
	})
	service.markSourceFailureState(context.Background(), "source-1", fixedNow())
	if scheduler.notificationCount() != 0 {
		t.Fatalf("notifications = %#v", scheduler.notifications)
	}
}

func TestMarkSourceFailureStateIgnoresInactiveSource(t *testing.T) {
	database := &fakeDatabase{nextRows: []fakeRowSet{{
		columns: []string{"consecutiveFailures", "isActive", "orgId", "name"},
		values:  [][]driver.Value{{9, false, "org-1", "Example Feed"}},
	}}}
	db := openFakeDB(t, database)
	scheduler := &fakeScheduler{}
	service := New(Options{DB: db, Config: Config{CircuitBreakerThreshold: 3}, Scheduler: scheduler, Now: fixedNow})
	service.markSourceFailureState(context.Background(), "source-1", fixedNow())
	for _, exec := range database.executes {
		if strings.Contains(exec.query, "UPDATE `NewsSource`") {
			t.Fatalf("inactive source must not be updated: %#v", exec)
		}
	}
	if scheduler.notificationCount() != 0 {
		t.Fatalf("notifications = %#v", scheduler.notifications)
	}
}
