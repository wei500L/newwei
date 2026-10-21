package classificationrssops

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"testing"
	"time"
)

// insertedAlert is one captured notification INSERT.
type insertedAlert struct {
	id      string
	orgID   string
	userID  *string
	body    string
	payload []byte
	now     time.Time
}

// withStubInsert replaces the MySQL INSERT seam and returns the captured rows.
func withStubInsert(t *testing.T, insertErr error) *[]insertedAlert {
	t.Helper()
	original := classificationAlertInsertRow
	inserted := make([]insertedAlert, 0, 1)
	classificationAlertInsertRow = func(
		_ context.Context,
		_ *sql.DB,
		id, orgID string,
		userID *string,
		body string,
		payload []byte,
		now time.Time,
	) error {
		inserted = append(inserted, insertedAlert{
			id:      id,
			orgID:   orgID,
			userID:  userID,
			body:    body,
			payload: payload,
			now:     now,
		})
		return insertErr
	}
	t.Cleanup(func() { classificationAlertInsertRow = original })
	return &inserted
}

// relayCall is one captured relay publish.
type relayCall struct {
	notificationID string
	orgID          string
	userID         string
}

// relayRecorder captures relay publishes.
type relayRecorder struct {
	mu    sync.Mutex
	calls []relayCall
	err   error
}

// publish implements NotificationRelayPublisher.
func (r *relayRecorder) publish(_ context.Context, notificationID, orgID, userID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, relayCall{notificationID: notificationID, orgID: orgID, userID: userID})
	return r.err
}

// recorded returns the captured publishes.
func (r *relayRecorder) recorded() []relayCall {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]relayCall{}, r.calls...)
}

// TestNotificationRelayPayload locks the notification:events:v1 envelope:
// version first, userId omitted for an organization-wide row.
func TestNotificationRelayPayload(t *testing.T) {
	payload, err := notificationRelayPayload("notif-1", "org-1", "")
	if err != nil {
		t.Fatalf("payload: %v", err)
	}
	wantOrgWide := `{"version":1,"notificationId":"notif-1","orgId":"org-1"}`
	if string(payload) != wantOrgWide {
		t.Fatalf("org-wide payload = %s, want %s", payload, wantOrgWide)
	}

	payload, err = notificationRelayPayload("notif-1", "org-1", "user-1")
	if err != nil {
		t.Fatalf("payload: %v", err)
	}
	wantUser := `{"version":1,"notificationId":"notif-1","orgId":"org-1","userId":"user-1"}`
	if string(payload) != wantUser {
		t.Fatalf("user payload = %s, want %s", payload, wantUser)
	}
}

// TestNewRedisNotificationRelayPublisherRequiresRedis proves the production
// publisher fails closed instead of silently dropping the relay.
func TestNewRedisNotificationRelayPublisherRequiresRedis(t *testing.T) {
	publisher := NewRedisNotificationRelayPublisher(nil)
	if err := publisher(context.Background(), "notif-1", "org-1", ""); !errors.Is(err, errNoRedisClient) {
		t.Fatalf("publish error = %v, want errNoRedisClient", err)
	}
}

// TestWriteClassificationAlertNotificationRelay covers the go-mode publish
// branch, the legacy no-publisher branch and both failure paths. The unit has no
// MySQL dependency because the INSERT itself is a package test seam.
func TestWriteClassificationAlertNotificationRelay(t *testing.T) {
	data := classificationAlertNotificationData{Domain: "classification_quality"}

	t.Run("go mode publishes once after the insert", func(t *testing.T) {
		inserted := withStubInsert(t, nil)
		recorder := &relayRecorder{}
		service := &Service{db: new(sql.DB)}
		service.SetNotificationRelayPublisher(recorder.publish)

		userID := "user-1"
		if err := service.writeClassificationAlertNotification(context.Background(), "org-1", &userID, "body", data); err != nil {
			t.Fatalf("write: %v", err)
		}
		if len(*inserted) != 1 {
			t.Fatalf("inserted rows = %d, want 1", len(*inserted))
		}
		if (*inserted)[0].userID == nil || *(*inserted)[0].userID != "user-1" {
			t.Fatalf("inserted userID = %v, want user-1", (*inserted)[0].userID)
		}
		calls := recorder.recorded()
		if len(calls) != 1 {
			t.Fatalf("relay publishes = %d, want 1", len(calls))
		}
		if calls[0].notificationID != (*inserted)[0].id {
			t.Fatalf("relay notificationId = %q, want the inserted id %q", calls[0].notificationID, (*inserted)[0].id)
		}
		if calls[0].orgID != "org-1" || calls[0].userID != "user-1" {
			t.Fatalf("relay call = %+v, want org-1/user-1", calls[0])
		}
	})

	t.Run("organization-wide row publishes without a userId", func(t *testing.T) {
		withStubInsert(t, nil)
		recorder := &relayRecorder{}
		service := &Service{db: new(sql.DB)}
		service.SetNotificationRelayPublisher(recorder.publish)

		if err := service.writeClassificationAlertNotification(context.Background(), "org-1", nil, "body", data); err != nil {
			t.Fatalf("write: %v", err)
		}
		calls := recorder.recorded()
		if len(calls) != 1 {
			t.Fatalf("relay publishes = %d, want 1", len(calls))
		}
		if calls[0].userID != "" {
			t.Fatalf("relay userId = %q, want empty", calls[0].userID)
		}
	})

	t.Run("legacy mode persists without a publisher", func(t *testing.T) {
		inserted := withStubInsert(t, nil)
		service := &Service{db: new(sql.DB)}

		if err := service.writeClassificationAlertNotification(context.Background(), "org-1", nil, "body", data); err != nil {
			t.Fatalf("write: %v", err)
		}
		// No publisher is installed: the only observable effect is the row, because
		// the legacy NestJS dispatcher owns the realtime fan-out.
		if len(*inserted) != 1 {
			t.Fatalf("inserted rows = %d, want 1", len(*inserted))
		}
	})

	t.Run("insert failure does not publish", func(t *testing.T) {
		insertErr := errors.New("insert failed")
		withStubInsert(t, insertErr)
		recorder := &relayRecorder{}
		service := &Service{db: new(sql.DB)}
		service.SetNotificationRelayPublisher(recorder.publish)

		err := service.writeClassificationAlertNotification(context.Background(), "org-1", nil, "body", data)
		if !errors.Is(err, insertErr) {
			t.Fatalf("write error = %v, want %v", err, insertErr)
		}
		if calls := recorder.recorded(); len(calls) != 0 {
			t.Fatalf("relay publishes = %d, want 0 after a failed insert", len(calls))
		}
	})

	t.Run("relay failure is best effort", func(t *testing.T) {
		inserted := withStubInsert(t, nil)
		recorder := &relayRecorder{err: errors.New("redis down")}
		service := &Service{db: new(sql.DB)}
		service.SetNotificationRelayPublisher(recorder.publish)

		if err := service.writeClassificationAlertNotification(context.Background(), "org-1", nil, "body", data); err != nil {
			t.Fatalf("write must succeed when only the relay fails: %v", err)
		}
		if len(*inserted) != 1 {
			t.Fatalf("inserted rows = %d, want 1", len(*inserted))
		}
		if calls := recorder.recorded(); len(calls) != 1 {
			t.Fatalf("relay publishes = %d, want 1", len(calls))
		}
	})
}

// TestEvaluateClassificationQualityAlertsRequest locks the scheduler input: the
// organization and the parsed window, with no source or category filter.
func TestEvaluateClassificationQualityAlertsRequest(t *testing.T) {
	request, err := evaluationSummaryRequest("org-1", "1h")
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if request.OrgID != "org-1" || request.Window != QualityWindow1h {
		t.Fatalf("request = %+v, want org-1/1h", request)
	}
	if request.SourceID != nil || request.CategoryPrefix != nil {
		t.Fatalf("request filters = %v/%v, want nil/nil", request.SourceID, request.CategoryPrefix)
	}

	// The GET summary DTO defaults an empty window to 24h.
	request, err = evaluationSummaryRequest("org-1", "")
	if err != nil {
		t.Fatalf("default window request: %v", err)
	}
	if request.Window != QualityWindow24h {
		t.Fatalf("default window = %q, want 24h", request.Window)
	}
}

// TestEvaluateClassificationQualityAlertsRejectsInvalidWindow proves the
// exported scheduler entry validates the window exactly like the controller
// before touching any store.
func TestEvaluateClassificationQualityAlertsRejectsInvalidWindow(t *testing.T) {
	service := &Service{}
	err := service.EvaluateClassificationQualityAlerts(context.Background(), "org-1", "2h")
	status, _, ok := statusOf(err)
	if !ok || status != 400 {
		t.Fatalf("error = %v (status %d, typed %v), want a 400 statusError", err, status, ok)
	}
}
