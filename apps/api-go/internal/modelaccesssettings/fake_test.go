package modelaccesssettings

import (
	"context"
	"encoding/json"
	"errors"
)

// fakeSettings is a typed in-memory settingsRepo. The unit suite never opens a
// MySQL connection.
type fakeSettings struct {
	rows      map[string]json.RawMessage
	present   map[string]bool
	upserts   []fakeUpsert
	deletes   []string
	loadErr   error
	upsertErr error
	deleteErr error
}

// fakeUpsert records one write including the actor that reached the foreign key.
type fakeUpsert struct {
	Key         string
	Value       json.RawMessage
	Description string
	UpdatedByID *string
}

// newFakeSettings builds an empty store.
func newFakeSettings() *fakeSettings {
	return &fakeSettings{rows: map[string]json.RawMessage{}, present: map[string]bool{}}
}

// seed installs one raw row.
func (f *fakeSettings) seed(key, value string) {
	f.rows[key] = json.RawMessage(value)
	f.present[key] = true
}

// Load implements settingsRepo.
func (f *fakeSettings) Load(_ context.Context, key string) (json.RawMessage, bool, error) {
	if f.loadErr != nil {
		return nil, false, f.loadErr
	}
	if !f.present[key] {
		return nil, false, nil
	}
	return f.rows[key], true, nil
}

// Upsert implements settingsRepo.
func (f *fakeSettings) Upsert(_ context.Context, key string, value json.RawMessage, description string, updatedByID *string) error {
	if f.upsertErr != nil {
		return f.upsertErr
	}
	f.upserts = append(f.upserts, fakeUpsert{Key: key, Value: value, Description: description, UpdatedByID: updatedByID})
	f.rows[key] = value
	f.present[key] = true
	return nil
}

// Delete implements settingsRepo.
func (f *fakeSettings) Delete(_ context.Context, key string) error {
	if f.deleteErr != nil {
		return f.deleteErr
	}
	f.deletes = append(f.deletes, key)
	delete(f.rows, key)
	delete(f.present, key)
	return nil
}

// rowCount reports how many times a key was written.
func (f *fakeSettings) rowCount(key string) int {
	count := 0
	for _, upsert := range f.upserts {
		if upsert.Key == key {
			count++
		}
	}
	return count
}

// fakeCache is a typed in-memory cacheStore.
type fakeCache struct {
	entries map[string]json.RawMessage
	ttls    map[string]int
	getErr  error
	setErr  error
	delErr  error
	dels    []string
}

// newFakeCache builds an empty cache.
func newFakeCache() *fakeCache {
	return &fakeCache{entries: map[string]json.RawMessage{}, ttls: map[string]int{}}
}

// Get implements cacheStore.
func (c *fakeCache) Get(_ context.Context, key string) (json.RawMessage, bool, error) {
	if c.getErr != nil {
		return nil, false, c.getErr
	}
	value, ok := c.entries[key]
	return value, ok, nil
}

// Set implements cacheStore.
func (c *fakeCache) Set(_ context.Context, key string, payload json.RawMessage, ttlSeconds int) error {
	if c.setErr != nil {
		return c.setErr
	}
	c.entries[key] = payload
	c.ttls[key] = ttlSeconds
	return nil
}

// Del implements cacheStore.
func (c *fakeCache) Del(_ context.Context, key string) error {
	if c.delErr != nil {
		return c.delErr
	}
	c.dels = append(c.dels, key)
	delete(c.entries, key)
	return nil
}

// fakeAuditor is a typed in-memory auditor.
type fakeAuditor struct {
	logs      []auditLogEntry
	outbox    []auditOutboxEntry
	logErr    error
	outboxErr error
}

// InsertAuditLog implements auditor.
func (a *fakeAuditor) InsertAuditLog(_ context.Context, entry auditLogEntry) error {
	if a.logErr != nil {
		return a.logErr
	}
	a.logs = append(a.logs, entry)
	return nil
}

// InsertAuditOutbox implements auditor.
func (a *fakeAuditor) InsertAuditOutbox(_ context.Context, entry auditOutboxEntry) error {
	if a.outboxErr != nil {
		return a.outboxErr
	}
	a.outbox = append(a.outbox, entry)
	return nil
}

// fakeLock records the lock names the service asked for.
type fakeLock struct {
	names []string
	err   error
	ran   bool
}

// WithSessionLock implements lockManager.
func (l *fakeLock) WithSessionLock(ctx context.Context, name string, fn func(context.Context) error) error {
	l.names = append(l.names, name)
	if l.err != nil {
		return l.err
	}
	l.ran = true
	return fn(ctx)
}

// fakeIdentity is a typed in-memory identityStore.
type fakeIdentity struct {
	admins   map[string]bool
	asks     []string
	err      error
	tokens   map[string]machineTokenRecord
	touches  []string
	tokenErr error
}

// newFakeIdentity builds an identity store with no platform admin and no tokens.
func newFakeIdentity() *fakeIdentity {
	return &fakeIdentity{admins: map[string]bool{}, tokens: map[string]machineTokenRecord{}}
}

// IsPlatformAdmin implements identityStore.
func (i *fakeIdentity) IsPlatformAdmin(_ context.Context, userID string) (bool, error) {
	if i.err != nil {
		return false, i.err
	}
	i.asks = append(i.asks, userID)
	return i.admins[userID], nil
}

// MachineToken implements identityStore.
func (i *fakeIdentity) MachineToken(_ context.Context, tokenHash string) (machineTokenRecord, error) {
	if i.tokenErr != nil {
		return machineTokenRecord{}, i.tokenErr
	}
	record, ok := i.tokens[tokenHash]
	if !ok {
		return machineTokenRecord{}, errMachineTokenNotFound
	}
	return record, nil
}

// TouchMachineToken implements identityStore.
func (i *fakeIdentity) TouchMachineToken(_ context.Context, id string) error {
	i.touches = append(i.touches, id)
	return nil
}

// testHarness bundles the fakes with the service under test.
type testHarness struct {
	service  *Service
	settings *fakeSettings
	cache    *fakeCache
	audit    *fakeAuditor
	locks    *fakeLock
	identity *fakeIdentity
}

// newTestHarness builds a Service over in-memory ports. Redis and MySQL are never
// contacted.
func newTestHarness(cfg Config) *testHarness {
	settings := newFakeSettings()
	cache := newFakeCache()
	audit := &fakeAuditor{}
	locks := &fakeLock{}
	identity := newFakeIdentity()
	service := newServiceWithBackends(serviceBackends{
		settings: settings,
		cache:    cache,
		audit:    audit,
		locks:    locks,
		identity: identity,
	}, cfg)
	return &testHarness{
		service:  service,
		settings: settings,
		cache:    cache,
		audit:    audit,
		locks:    locks,
		identity: identity,
	}
}

// errFakeBoom is a generic injected infrastructure failure.
var errFakeBoom = errors.New("fake failure")
