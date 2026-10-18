package userdigest

import (
	"context"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authlogin"
)

// DeliveryCursor is the read-time pagination cursor for the due schedule scan.
// It carries the original nextRunAt/updatedAt/id of the last scanned row so a
// write-back during processing cannot skip or duplicate a later row.
type DeliveryCursor struct {
	NextRunAt time.Time
	UpdatedAt time.Time
	ID        string
}

// DeliveryScheduleRecord is one due schedule plus the minimum schedule and user
// fields the delivery executor needs. The projection is intentionally narrow:
// the executor reads only what it writes back or puts into the email and
// notification payloads.
type DeliveryScheduleRecord struct {
	ID            string
	OrgID         string
	UserID        string
	Enabled       bool
	Timezone      string
	SendHour      int
	SendMinute    int
	NextRunAt     time.Time
	UpdatedAt     time.Time
	LastStatus    string
	LastError     *string
	Email         string
	EmailVerified bool
	FirstName     string
}

// DeliverySlotClaim is the complete conditional slot claim. Every writable
// column is present: callers that must preserve a column pass the value read
// with the due schedule.
type DeliverySlotClaim struct {
	Enabled      bool
	NextRunAt    *time.Time
	LastStatus   string
	LastStatusAt time.Time
	LastError    *string
}

// DeliveryClaimedUpdate is the post-claim result update. A nil LastSentAt keeps
// the stored value, matching the NestJS update that only writes lastSentAt on
// successful delivery.
type DeliveryClaimedUpdate struct {
	LastSentAt   *time.Time
	LastStatus   string
	LastStatusAt time.Time
	LastError    *string
}

// DeliveryRepository is the MySQL port used by the delivery scheduler. The
// implementation owns the SQL; the scheduler owns pagination, CAS semantics and
// side effects.
type DeliveryRepository interface {
	ListActiveOrgIDs(ctx context.Context) ([]string, error)
	ListDueSchedules(ctx context.Context, orgID string, cutoff time.Time, cursor *DeliveryCursor, limit int) ([]DeliveryScheduleRecord, error)
	ClaimDueSlot(ctx context.Context, record DeliveryScheduleRecord, claim DeliverySlotClaim) (bool, error)
	UpdateClaimedSlot(ctx context.Context, record DeliveryScheduleRecord, update DeliveryClaimedUpdate) error
}

// DeliveryStore is the narrow Redis port for the tick gate, org lease, active
// organization cache and the digest notification relay. It exists so the
// scheduler can be exercised without a live Redis server.
type DeliveryStore interface {
	SetIfAbsent(ctx context.Context, key, value string, ttl time.Duration) (bool, error)
	Get(ctx context.Context, key string) (string, bool, error)
	Set(ctx context.Context, key, value string, ttl time.Duration) error
	ReleaseLock(ctx context.Context, key, token string) error
	RenewLock(ctx context.Context, key, token string, ttl time.Duration) error
	Publish(ctx context.Context, channel, payload string) error
}

// DigestGenerator is the digest read chain the background delivery reuses. The
// HTTP handler and the scheduler share the same *Service implementation.
type DigestGenerator interface {
	GenerateDigest(ctx context.Context, orgID, userID string) (Digest, error)
}

// MailPort is the reused authlogin SMTP port. One connection is opened per
// message; a delivery failure is returned to the caller.
type MailPort interface {
	Send(ctx context.Context, message authlogin.MailMessage) error
}

// OrgConcurrencyReader reads the persisted runtime concurrency for the digest
// delivery scheduler. Implementations must validate the complete stored record,
// not just the digest field.
type OrgConcurrencyReader interface {
	ReadDigestDeliveryOrgConcurrency(ctx context.Context) (int, error)
}

// DigestReadyParams is the params object of the user_digest_ready presentation.
type DigestReadyParams struct {
	Link        string
	EventCount  int
	GeneratedAt string
	NextRunAt   string
}

// DigestEmptyParams is the params object of the user_digest_empty presentation.
type DigestEmptyParams struct {
	Link      string
	NextRunAt string
}

// DigestFailureParams is the params object of the
// user_digest_delivery_failed presentation.
type DigestFailureParams struct {
	Link        string
	TargetEmail string
	Message     string
}

// DeliveryNotifier persists the three digest notifications and publishes the
// digest-only realtime relay message after the row is written.
type DeliveryNotifier interface {
	NotifyReady(ctx context.Context, orgID, userID string, params DigestReadyParams) error
	NotifyEmpty(ctx context.Context, orgID, userID string, params DigestEmptyParams) error
	NotifyFailure(ctx context.Context, orgID, userID string, params DigestFailureParams) error
}

// DigestDeliveryOrgRunSummary counts one organization delivery run. It mirrors
// UserDigestDeliveryOrgRunSummary in the NestJS service.
type DigestDeliveryOrgRunSummary struct {
	DueCount    int
	SentCount   int
	EmptyCount  int
	FailedCount int
}
