package modelaccesssettings

import (
	"context"
	"encoding/json"
)

// This file declares the narrow infrastructure ports the service depends on.
// Production wiring passes the shared MySQL pool and Redis client (NewService);
// unit tests pass typed in-memory doubles, so the pure unit suite never opens a
// connection.

// settingsRepo persists the global single-row settings this batch owns.
type settingsRepo interface {
	// Load returns the raw SystemSetting.value; found is false when the row does
	// not exist.
	Load(ctx context.Context, key string) (value json.RawMessage, found bool, err error)
	// Upsert inserts or updates one row, keeping the existing description.
	Upsert(ctx context.Context, key string, value json.RawMessage, description string, updatedByID *string) error
	// Delete removes one row; a missing row is not an error.
	Delete(ctx context.Context, key string) error
}

// cacheStore is the Redis envelope surface. Reads/writes are best-effort by
// contract: an error is logged and the caller falls back to MySQL.
type cacheStore interface {
	Get(ctx context.Context, key string) (payload json.RawMessage, found bool, err error)
	Set(ctx context.Context, key string, payload json.RawMessage, ttlSeconds int) error
	Del(ctx context.Context, key string) error
}

// auditLogEntry is one AuditLog row to insert.
type auditLogEntry struct {
	ID        string
	OrgID     string
	ActorID   *string
	Action    string
	Metadata  json.RawMessage
	CreatedAt string
}

// auditOutboxEntry is one AuditLogOutbox row to insert.
type auditOutboxEntry struct {
	ID          string
	OrgID       string
	Payload     json.RawMessage
	Status      string
	Attempts    int
	AvailableAt string
	CreatedAt   string
	UpdatedAt   string
}

// auditor writes the audit trail with the outbox fallback.
type auditor interface {
	InsertAuditLog(ctx context.Context, entry auditLogEntry) error
	InsertAuditOutbox(ctx context.Context, entry auditOutboxEntry) error
}

// lockManager serializes global writes on one MySQL session advisory lock.
type lockManager interface {
	// WithSessionLock runs fn while holding the named lock. It returns
	// errLockUnavailable when the lock could not be confirmed, and never runs fn
	// in that case.
	WithSessionLock(ctx context.Context, name string, fn func(context.Context) error) error
}

// machineTokenRecord is the resolved MachineAccessToken row.
type machineTokenRecord struct {
	ID          string
	OrgID       string
	Permissions []string
	Revoked     bool
	Expired     bool
	OrgActive   bool
}

// identityStore resolves the platform role and the machine-token identities.
type identityStore interface {
	IsPlatformAdmin(ctx context.Context, userID string) (bool, error)
	MachineToken(ctx context.Context, tokenHash string) (machineTokenRecord, error)
	TouchMachineToken(ctx context.Context, id string) error
}

// serviceBackends groups every port so the unexported test constructor stays
// readable.
type serviceBackends struct {
	settings settingsRepo
	cache    cacheStore
	audit    auditor
	locks    lockManager
	identity identityStore
}

// newServiceWithBackends builds a Service over explicit ports. It exists for the
// unit suite; production code goes through NewService.
func newServiceWithBackends(backends serviceBackends, cfg Config) *Service {
	return &Service{
		settings: backends.settings,
		cache:    backends.cache,
		audit:    backends.audit,
		locks:    backends.locks,
		identity: backends.identity,
		cfg:      cfg,
	}
}

// nilSettings reports whether the settings port is missing, which maps onto the
// fail-closed database error.
func (s *Service) nilSettings() bool {
	return s == nil || s.settings == nil
}

// persistSetting writes one SystemSetting row through the settings port.
func (s *Service) persistSetting(ctx context.Context, key string, value json.RawMessage, description string, updatedByID *string) error {
	if s.nilSettings() {
		return errNoDatabase
	}
	return s.settings.Upsert(ctx, key, value, description, updatedByID)
}

// removeSetting deletes one SystemSetting row through the settings port.
func (s *Service) removeSetting(ctx context.Context, key string) error {
	if s.nilSettings() {
		return errNoDatabase
	}
	return s.settings.Delete(ctx, key)
}

// withSessionLock runs fn while holding one global advisory lock through the lock
// port. A missing port fails closed instead of writing without the lock.
func (s *Service) withSessionLock(ctx context.Context, name string, fn func(context.Context) error) error {
	if s == nil || s.locks == nil {
		return errNoDatabase
	}
	return s.locks.WithSessionLock(ctx, name, fn)
}
