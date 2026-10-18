package userdigest

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authlogin"
)

func TestProcessDueScheduleSendsEmail(t *testing.T) {
	now := time.Date(2026, 10, 18, 6, 30, 0, 0, time.UTC)
	record := testDueRecord(now)
	digest := testDigest(now, 1)
	repo := newFakeDeliveryRepository(&record)
	mail := &fakeMailPort{}
	notifier := &fakeDeliveryNotifier{}
	generator := &fakeDigestGenerator{digest: digest}
	scheduler := newTestScheduler(repo, &fakeDeliveryStore{}, generator, mail, notifier, 4, now)

	status := scheduler.processDueScheduleSafely(context.Background(), record, now)
	if status != statusSent {
		t.Fatalf("status = %q, want %q", status, statusSent)
	}
	if generator.calls != 1 {
		t.Fatalf("digest calls = %d, want 1", generator.calls)
	}
	if len(mail.messages) != 1 {
		t.Fatalf("mail messages = %d, want 1", len(mail.messages))
	}
	if len(notifier.ready) != 1 || len(notifier.empty) != 0 || len(notifier.failure) != 0 {
		t.Fatalf("notifications ready=%d empty=%d failure=%d", len(notifier.ready), len(notifier.empty), len(notifier.failure))
	}
	stored := repo.records[record.ID]
	if stored.LastStatus != statusSent || stored.LastError != nil {
		t.Fatalf("stored status=%q error=%v", stored.LastStatus, stored.LastError)
	}
	if !stored.NextRunAt.After(now) {
		t.Fatalf("nextRunAt %s is not after reference", stored.NextRunAt)
	}
	if len(repo.updateCalls) != 1 || repo.updateCalls[0].LastSentAt == nil {
		t.Fatalf("update calls = %+v", repo.updateCalls)
	}
}

func TestProcessDueScheduleEmptyDigest(t *testing.T) {
	now := time.Date(2026, 10, 18, 6, 30, 0, 0, time.UTC)
	record := testDueRecord(now)
	repo := newFakeDeliveryRepository(&record)
	mail := &fakeMailPort{}
	notifier := &fakeDeliveryNotifier{}
	scheduler := newTestScheduler(repo, &fakeDeliveryStore{}, &fakeDigestGenerator{digest: testDigest(now, 0)}, mail, notifier, 4, now)

	status := scheduler.processDueScheduleSafely(context.Background(), record, now)
	if status != statusEmpty {
		t.Fatalf("status = %q, want %q", status, statusEmpty)
	}
	if len(mail.messages) != 0 {
		t.Fatalf("mail messages = %d, want 0", len(mail.messages))
	}
	if len(notifier.empty) != 1 || len(notifier.ready) != 0 || len(notifier.failure) != 0 {
		t.Fatalf("notifications ready=%d empty=%d failure=%d", len(notifier.ready), len(notifier.empty), len(notifier.failure))
	}
	stored := repo.records[record.ID]
	if stored.LastStatus != statusEmpty || stored.LastError != nil {
		t.Fatalf("stored status=%q error=%v", stored.LastStatus, stored.LastError)
	}
}

func TestProcessDueScheduleUnverifiedEmailDisables(t *testing.T) {
	now := time.Date(2026, 10, 18, 6, 30, 0, 0, time.UTC)
	record := testDueRecord(now)
	record.EmailVerified = false
	repo := newFakeDeliveryRepository(&record)
	mail := &fakeMailPort{}
	notifier := &fakeDeliveryNotifier{}
	generator := &fakeDigestGenerator{digest: testDigest(now, 1)}
	scheduler := newTestScheduler(repo, &fakeDeliveryStore{}, generator, mail, notifier, 4, now)

	status := scheduler.processDueScheduleSafely(context.Background(), record, now)
	if status != statusFailed {
		t.Fatalf("status = %q, want %q", status, statusFailed)
	}
	if generator.calls != 0 || len(mail.messages) != 0 {
		t.Fatalf("unexpected digest/mail call digest=%d mail=%d", generator.calls, len(mail.messages))
	}
	if len(notifier.failure) != 1 {
		t.Fatalf("failure notifications = %d, want 1", len(notifier.failure))
	}
	if notifier.failure[0].TargetEmail != record.Email {
		t.Fatalf("target email = %q, want %q", notifier.failure[0].TargetEmail, record.Email)
	}
	stored := repo.records[record.ID]
	if stored.Enabled {
		t.Fatalf("stored enabled = true, want false")
	}
	if !stored.NextRunAt.IsZero() {
		t.Fatalf("stored nextRunAt = %s, want zero/null", stored.NextRunAt)
	}
	if stored.LastError == nil || *stored.LastError != unverifiedEmailErr {
		t.Fatalf("stored lastError = %v", stored.LastError)
	}
}

func TestProcessDueScheduleGenerationFailureAdvancesSlot(t *testing.T) {
	now := time.Date(2026, 10, 18, 6, 30, 0, 0, time.UTC)
	record := testDueRecord(now)
	repo := newFakeDeliveryRepository(&record)
	mail := &fakeMailPort{}
	notifier := &fakeDeliveryNotifier{}
	scheduler := newTestScheduler(repo, &fakeDeliveryStore{}, &fakeDigestGenerator{err: errors.New("digest exploded")}, mail, notifier, 4, now)

	status := scheduler.processDueScheduleSafely(context.Background(), record, now)
	if status != statusFailed {
		t.Fatalf("status = %q, want %q", status, statusFailed)
	}
	stored := repo.records[record.ID]
	if stored.LastStatus != statusFailed || stored.LastError == nil || *stored.LastError != "digest exploded" {
		t.Fatalf("stored status=%q error=%v", stored.LastStatus, stored.LastError)
	}
	if !stored.NextRunAt.After(now) {
		t.Fatalf("nextRunAt %s was not advanced", stored.NextRunAt)
	}
	if len(notifier.failure) != 1 || len(mail.messages) != 0 {
		t.Fatalf("failure=%d mail=%d", len(notifier.failure), len(mail.messages))
	}
}

func TestProcessDueScheduleSMTPFailureKeepsClaimedSlot(t *testing.T) {
	now := time.Date(2026, 10, 18, 6, 30, 0, 0, time.UTC)
	record := testDueRecord(now)
	repo := newFakeDeliveryRepository(&record)
	mail := &fakeMailPort{err: errors.New("smtp unavailable")}
	notifier := &fakeDeliveryNotifier{}
	scheduler := newTestScheduler(repo, &fakeDeliveryStore{}, &fakeDigestGenerator{digest: testDigest(now, 1)}, mail, notifier, 4, now)

	status := scheduler.processDueScheduleSafely(context.Background(), record, now)
	if status != statusFailed {
		t.Fatalf("status = %q, want %q", status, statusFailed)
	}
	if len(mail.messages) != 1 {
		t.Fatalf("mail messages = %d, want 1 attempt", len(mail.messages))
	}
	if len(repo.claimCalls) != 1 {
		t.Fatalf("claim calls = %d, want 1", len(repo.claimCalls))
	}
	if len(repo.updateCalls) != 1 || repo.updateCalls[0].LastSentAt != nil {
		t.Fatalf("update calls = %+v", repo.updateCalls)
	}
	stored := repo.records[record.ID]
	if stored.LastStatus != statusFailed || stored.LastError == nil || *stored.LastError != "smtp unavailable" {
		t.Fatalf("stored status=%q error=%v", stored.LastStatus, stored.LastError)
	}
	if len(notifier.failure) != 1 {
		t.Fatalf("failure notifications = %d, want 1", len(notifier.failure))
	}
}

func TestProcessDueScheduleLostClaimHasNoSideEffects(t *testing.T) {
	now := time.Date(2026, 10, 18, 6, 30, 0, 0, time.UTC)
	record := testDueRecord(now)
	repo := newFakeDeliveryRepository(&record)
	repo.blockClaim = true
	mail := &fakeMailPort{}
	notifier := &fakeDeliveryNotifier{}
	scheduler := newTestScheduler(repo, &fakeDeliveryStore{}, &fakeDigestGenerator{digest: testDigest(now, 1)}, mail, notifier, 4, now)

	status := scheduler.processDueScheduleSafely(context.Background(), record, now)
	if status != statusIdle {
		t.Fatalf("status = %q, want %q", status, statusIdle)
	}
	if len(mail.messages) != 0 || len(notifier.ready) != 0 || len(notifier.empty) != 0 || len(notifier.failure) != 0 {
		t.Fatalf("unexpected side effects mail=%d ready=%d empty=%d failure=%d",
			len(mail.messages), len(notifier.ready), len(notifier.empty), len(notifier.failure))
	}
}

func TestProcessDueScheduleGenerationFailureLostClaimIsIdle(t *testing.T) {
	now := time.Date(2026, 10, 18, 6, 30, 0, 0, time.UTC)
	record := testDueRecord(now)
	repo := newFakeDeliveryRepository(&record)
	repo.blockClaim = true
	notifier := &fakeDeliveryNotifier{}
	scheduler := newTestScheduler(repo, &fakeDeliveryStore{}, &fakeDigestGenerator{err: errors.New("digest exploded")}, &fakeMailPort{}, notifier, 4, now)

	status := scheduler.processDueScheduleSafely(context.Background(), record, now)
	if status != statusIdle {
		t.Fatalf("status = %q, want %q", status, statusIdle)
	}
	if len(notifier.failure) != 0 {
		t.Fatalf("failure notifications = %d, want 0", len(notifier.failure))
	}
}

func TestRunDueDeliveriesForOrgPaginatesWithStableCursor(t *testing.T) {
	now := time.Date(2026, 10, 18, 6, 30, 0, 0, time.UTC)
	records := make([]*DeliveryScheduleRecord, 0, 150)
	for index := 0; index < 150; index++ {
		record := testDueRecord(now.Add(-time.Duration(index+1) * time.Minute))
		record.ID = fmt.Sprintf("s%03d", index)
		record.UserID = "user-" + record.ID
		record.Email = record.ID + "@example.com"
		records = append(records, &record)
	}
	repo := newFakeDeliveryRepository(records...)
	mail := &fakeMailPort{}
	notifier := &fakeDeliveryNotifier{}
	scheduler := newTestScheduler(repo, &fakeDeliveryStore{}, &fakeDigestGenerator{digest: testDigest(now, 1)}, mail, notifier, 4, now)

	summary, err := scheduler.runDueDeliveriesForOrg(context.Background(), "org1", now)
	if err != nil {
		t.Fatal(err)
	}
	if summary.DueCount != 150 || summary.SentCount != 150 {
		t.Fatalf("summary = %+v, want due=150 sent=150", summary)
	}
	if repo.listCalls < 2 {
		t.Fatalf("list calls = %d, want more than one page", repo.listCalls)
	}
	if len(mail.messages) != 150 {
		t.Fatalf("mail messages = %d, want 150", len(mail.messages))
	}
}

func TestBuildDigestEmailFallbacksAndEscaping(t *testing.T) {
	now := time.Date(2026, 10, 18, 6, 30, 0, 0, time.UTC)
	title := "  "
	entity := "Entity & Co"
	summary := "<script>alert(1)</script>"
	unsafe := "javascript:alert(1)"
	digest := Digest{
		Version:     1,
		GeneratedAt: isoTime(now),
		Preference:  defaultPreference(),
		Events: []Event{
			{
				EventID:           "e1",
				Title:             &title,
				Summary:           &summary,
				PrimaryEntity:     &entity,
				LastAt:            isoTime(now),
				ItemCount:         2,
				RepresentativeURL: &unsafe,
			},
		},
	}
	message := buildDigestEmail(digest, deliveryScheduleConfig{Timezone: "UTC", SendHour: 9, SendMinute: 0}, "Alice", "alice@example.com", "https://console.example.com/")
	if !strings.HasPrefix(message.Subject, "每日摘要｜2026/10/18") {
		t.Fatalf("subject = %q", message.Subject)
	}
	if !strings.Contains(message.HTML, "Entity &amp; Co") {
		t.Fatalf("html title did not fall back to primaryEntity: %s", message.HTML)
	}
	if !strings.Contains(message.HTML, "&lt;script&gt;alert(1)&lt;/script&gt;") {
		t.Fatalf("html summary was not escaped: %s", message.HTML)
	}
	if !strings.Contains(message.HTML, "https://console.example.com/today") {
		t.Fatalf("html link did not fall back to Today: %s", message.HTML)
	}
	if !strings.Contains(message.Text, "Entity &amp; Co") {
		t.Fatalf("text title did not fall back to primaryEntity: %s", message.Text)
	}
}

// ---- fakes ----

type fakeDeliveryRepository struct {
	mu          sync.Mutex
	records     map[string]*DeliveryScheduleRecord
	listCalls   int
	claimCalls  []DeliverySlotClaim
	updateCalls []DeliveryClaimedUpdate
	blockClaim  bool
	listErr     error
}

func newFakeDeliveryRepository(records ...*DeliveryScheduleRecord) *fakeDeliveryRepository {
	repo := &fakeDeliveryRepository{records: make(map[string]*DeliveryScheduleRecord, len(records))}
	for _, record := range records {
		copied := *record
		repo.records[record.ID] = &copied
	}
	return repo
}

func (r *fakeDeliveryRepository) ListActiveOrgIDs(context.Context) ([]string, error) {
	return []string{"org1"}, nil
}

func (r *fakeDeliveryRepository) ListDueSchedules(_ context.Context, orgID string, cutoff time.Time, cursor *DeliveryCursor, limit int) ([]DeliveryScheduleRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.listCalls++
	if r.listErr != nil {
		return nil, r.listErr
	}
	out := make([]DeliveryScheduleRecord, 0, len(r.records))
	for _, record := range r.records {
		if record.OrgID != orgID || !record.Enabled || record.NextRunAt.After(cutoff) {
			continue
		}
		if cursor != nil && !deliveryRecordAfterCursor(*record, *cursor) {
			continue
		}
		out = append(out, *record)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].NextRunAt.Equal(out[j].NextRunAt) {
			return out[i].NextRunAt.Before(out[j].NextRunAt)
		}
		if !out[i].UpdatedAt.Equal(out[j].UpdatedAt) {
			return out[i].UpdatedAt.Before(out[j].UpdatedAt)
		}
		return out[i].ID < out[j].ID
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (r *fakeDeliveryRepository) ClaimDueSlot(_ context.Context, record DeliveryScheduleRecord, claim DeliverySlotClaim) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.claimCalls = append(r.claimCalls, claim)
	if r.blockClaim {
		return false, nil
	}
	stored, ok := r.records[record.ID]
	if !ok || !stored.NextRunAt.Equal(record.NextRunAt) {
		return false, nil
	}
	stored.Enabled = claim.Enabled
	stored.NextRunAt = timeOrZero(claim.NextRunAt)
	stored.LastStatus = claim.LastStatus
	stored.LastError = cloneOptionalString(claim.LastError)
	stored.UpdatedAt = claim.LastStatusAt
	return true, nil
}

func (r *fakeDeliveryRepository) UpdateClaimedSlot(_ context.Context, record DeliveryScheduleRecord, update DeliveryClaimedUpdate) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.updateCalls = append(r.updateCalls, update)
	stored, ok := r.records[record.ID]
	if !ok {
		return nil
	}
	stored.LastStatus = update.LastStatus
	stored.LastError = cloneOptionalString(update.LastError)
	stored.UpdatedAt = update.LastStatusAt
	return nil
}

func deliveryRecordAfterCursor(record DeliveryScheduleRecord, cursor DeliveryCursor) bool {
	if !record.NextRunAt.Equal(cursor.NextRunAt) {
		return record.NextRunAt.After(cursor.NextRunAt)
	}
	if !record.UpdatedAt.Equal(cursor.UpdatedAt) {
		return record.UpdatedAt.After(cursor.UpdatedAt)
	}
	return record.ID > cursor.ID
}

type fakeDeliveryStore struct {
	mu        sync.Mutex
	values    map[string]string
	published []string
}

func (s *fakeDeliveryStore) SetIfAbsent(_ context.Context, key, value string, _ time.Duration) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.values == nil {
		s.values = make(map[string]string)
	}
	if _, ok := s.values[key]; ok {
		return false, nil
	}
	s.values[key] = value
	return true, nil
}

func (s *fakeDeliveryStore) Get(_ context.Context, key string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, ok := s.values[key]
	return value, ok, nil
}

func (s *fakeDeliveryStore) Set(_ context.Context, key, value string, _ time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.values == nil {
		s.values = make(map[string]string)
	}
	s.values[key] = value
	return nil
}

func (s *fakeDeliveryStore) ReleaseLock(_ context.Context, key, token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.values[key] == token {
		delete(s.values, key)
	}
	return nil
}

func (s *fakeDeliveryStore) RenewLock(context.Context, string, string, time.Duration) error {
	return nil
}

func (s *fakeDeliveryStore) Publish(_ context.Context, _ string, payload string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.published = append(s.published, payload)
	return nil
}

type fakeDigestGenerator struct {
	digest Digest
	err    error
	calls  int
}

func (g *fakeDigestGenerator) GenerateDigest(context.Context, string, string) (Digest, error) {
	g.calls++
	return g.digest, g.err
}

type fakeMailPort struct {
	messages []authlogin.MailMessage
	err      error
}

func (m *fakeMailPort) Send(_ context.Context, message authlogin.MailMessage) error {
	m.messages = append(m.messages, message)
	return m.err
}

type fakeDeliveryNotifier struct {
	ready   []DigestReadyParams
	empty   []DigestEmptyParams
	failure []DigestFailureParams
}

func (n *fakeDeliveryNotifier) NotifyReady(_ context.Context, _ string, _ string, params DigestReadyParams) error {
	n.ready = append(n.ready, params)
	return nil
}

func (n *fakeDeliveryNotifier) NotifyEmpty(_ context.Context, _ string, _ string, params DigestEmptyParams) error {
	n.empty = append(n.empty, params)
	return nil
}

func (n *fakeDeliveryNotifier) NotifyFailure(_ context.Context, _ string, _ string, params DigestFailureParams) error {
	n.failure = append(n.failure, params)
	return nil
}

type fakeOrgConcurrencyReader struct {
	value int
	err   error
}

func (r *fakeOrgConcurrencyReader) ReadDigestDeliveryOrgConcurrency(context.Context) (int, error) {
	return r.value, r.err
}

func newTestScheduler(
	repo DeliveryRepository,
	store DeliveryStore,
	generator DigestGenerator,
	mail MailPort,
	notifier DeliveryNotifier,
	concurrency int,
	now time.Time,
) *DeliveryScheduler {
	return NewDeliveryScheduler(DeliverySchedulerDeps{
		Repository:     repo,
		Store:          store,
		Digest:         generator,
		Mail:           mail,
		Notifier:       notifier,
		Settings:       &fakeOrgConcurrencyReader{value: concurrency},
		ConsoleBaseURL: "https://console.example.com",
		Now:            func() time.Time { return now },
	})
}

func testDueRecord(now time.Time) DeliveryScheduleRecord {
	return DeliveryScheduleRecord{
		ID:            "schedule-1",
		OrgID:         "org1",
		UserID:        "user1",
		Enabled:       true,
		Timezone:      "UTC",
		SendHour:      9,
		SendMinute:    0,
		NextRunAt:     now,
		UpdatedAt:     now,
		LastStatus:    statusIdle,
		Email:         "user@example.com",
		EmailVerified: true,
		FirstName:     "Alice",
	}
}

func testDigest(now time.Time, eventCount int) Digest {
	events := make([]Event, 0, eventCount)
	for index := 0; index < eventCount; index++ {
		events = append(events, Event{
			EventID:   "event-" + string(rune('a'+index)),
			LastAt:    isoTime(now),
			ItemCount: 1,
		})
	}
	return Digest{
		Version:     1,
		GeneratedAt: isoTime(now),
		WindowStart: isoTime(now.Add(-72 * time.Hour)),
		WindowEnd:   isoTime(now),
		Preference:  defaultPreference(),
		Events:      events,
	}
}

func timeOrZero(value *time.Time) time.Time {
	if value == nil {
		return time.Time{}
	}
	return *value
}

func cloneOptionalString(value *string) *string {
	if value == nil {
		return nil
	}
	copied := *value
	return &copied
}
