package oidclogin

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/accountsecurity"
	"github.com/wei500L/newwei/apps/api-go/internal/authlogin"
)

// fakeCache is an in-memory cacheStore. It records TTLs and the exact operation
// used for the OIDC state so the tests can prove the callback uses one GETDEL
// rather than GET followed by DEL.
type fakeCache struct {
	mu      sync.Mutex
	entries map[string]cacheEntry
	ttls    map[string]time.Duration
	gets    int
	sets    int
	getDels int
	getErr  error
	setErr  error
}

type cacheEntry struct {
	value []byte
}

func newFakeCache() *fakeCache {
	return &fakeCache{entries: map[string]cacheEntry{}, ttls: map[string]time.Duration{}}
}

func (c *fakeCache) Get(_ context.Context, key string) ([]byte, bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.gets++
	if c.getErr != nil {
		return nil, false, c.getErr
	}
	entry, found := c.entries[key]
	if !found {
		return nil, false, nil
	}
	return append([]byte(nil), entry.value...), true, nil
}

func (c *fakeCache) Set(_ context.Context, key string, value []byte, ttl time.Duration) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sets++
	if c.setErr != nil {
		return c.setErr
	}
	c.entries[key] = cacheEntry{value: append([]byte(nil), value...)}
	c.ttls[key] = ttl
	return nil
}

func (c *fakeCache) GetDel(_ context.Context, key string) ([]byte, bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.getDels++
	if c.getErr != nil {
		return nil, false, c.getErr
	}
	entry, found := c.entries[key]
	if !found {
		return nil, false, nil
	}
	delete(c.entries, key)
	return append([]byte(nil), entry.value...), true, nil
}

func (c *fakeCache) value(key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, found := c.entries[key]
	if !found {
		return nil, false
	}
	return append([]byte(nil), entry.value...), true
}

func (c *fakeCache) ttl(key string) time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ttls[key]
}

// fakeDirectory serves the existing-user and organization lookups.
type fakeDirectory struct {
	mu       sync.Mutex
	orgs     map[string]*orgRecord
	slugs    map[string]string
	users    map[string]string
	orgCalls []string
}

func newFakeDirectory() *fakeDirectory {
	return &fakeDirectory{orgs: map[string]*orgRecord{}, slugs: map[string]string{}, users: map[string]string{}}
}

func (d *fakeDirectory) FindOrgByIdentifier(_ context.Context, id, slug string) (*orgRecord, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.orgCalls = append(d.orgCalls, id+"/"+slug)
	if record, found := d.orgs[id]; found {
		return record, nil
	}
	if mapped, found := d.slugs[slug]; found {
		return d.orgs[mapped], nil
	}
	return nil, nil
}

func (d *fakeDirectory) FindOrgByID(_ context.Context, id string) (*orgRecord, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.orgCalls = append(d.orgCalls, id)
	return d.orgs[id], nil
}

func (d *fakeDirectory) FindUserIDByEmail(_ context.Context, email string) (string, bool, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	userID, found := d.users[email]
	return userID, found, nil
}

// fakeChallenges is an in-memory AuthChallenge table. ClaimHandoff mirrors the
// production conditional UPDATE: it checks the type, the null consumedAt and
// the unexpired row while holding the lock, so a concurrency test sees exactly
// one winner.
type fakeChallenges struct {
	mu         sync.Mutex
	rows       map[string]handoffChallenge
	createErr  error
	loadCalls  int
	claimCalls int
}

func newFakeChallenges() *fakeChallenges {
	return &fakeChallenges{rows: map[string]handoffChallenge{}}
}

func (c *fakeChallenges) CreateHandoff(_ context.Context, challenge handoffChallenge) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.createErr != nil {
		return c.createErr
	}
	c.rows[challenge.ID] = challenge
	return nil
}

func (c *fakeChallenges) LoadHandoff(_ context.Context, id string) (handoffChallenge, bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.loadCalls++
	row, found := c.rows[id]
	return row, found, nil
}

func (c *fakeChallenges) ClaimHandoff(_ context.Context, id string, now time.Time) (bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.claimCalls++
	row, found := c.rows[id]
	if !found || row.Type != challengeTypeSSOHandoff || row.ConsumedAt != nil || row.ExpiresAt.Before(now) {
		return false, nil
	}
	consumed := now
	row.ConsumedAt = &consumed
	c.rows[id] = row
	return true, nil
}

// fakeSecrets implements the shared AuthSecurity JSON-string shape and can
// inject an encoding/decryption failure.
type fakeSecrets struct {
	encodeErr error
	decodeErr error
}

func (s fakeSecrets) EncodeLoginSecret(_ context.Context, plain string) (json.RawMessage, error) {
	if s.encodeErr != nil {
		return nil, s.encodeErr
	}
	return json.Marshal(plain)
}

func (s fakeSecrets) DecodeLoginSecret(_ context.Context, raw []byte) (string, bool, error) {
	if s.decodeErr != nil {
		return "", false, s.decodeErr
	}
	if len(bytes.TrimSpace(raw)) == 0 || string(bytes.TrimSpace(raw)) == "null" {
		return "", false, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false, nil
	}
	return value, true, nil
}

type loginCall struct {
	UserID    string
	OrgID     string
	IPAddress *string
	UserAgent *string
	Action    string
}

type fakeLogin struct {
	mu     sync.Mutex
	result authlogin.TrustedLoginResult
	err    error
	calls  []loginCall
}

func (l *fakeLogin) BeginTrustedLogin(_ context.Context, userID, orgID string, ipAddress, userAgent *string, action string) (authlogin.TrustedLoginResult, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.calls = append(l.calls, loginCall{UserID: userID, OrgID: orgID, IPAddress: ipAddress, UserAgent: userAgent, Action: action})
	return l.result, l.err
}

func sessionLoginResult() authlogin.TrustedLoginResult {
	return authlogin.TrustedLoginResult{Session: &authlogin.TrustedLoginSession{
		User: accountsecurity.LoginProfile{
			ID:          "user-1",
			Email:       "person@example.com",
			FirstName:   "Person",
			LastName:    "Example",
			IsActive:    true,
			OrgID:       "org-1",
			RoleIDs:     []string{},
			Permissions: []string{"items.read"},
		},
		AccessToken:   "access-token",
		RefreshToken:  "refresh-token",
		Organizations: []accountsecurity.LoginOrganization{{ID: "org-1", Name: "Org", Slug: "org", IsActive: true}},
		ExpiresIn:     900,
	}}
}

// fakeHTTP records each outbound request and delegates the response.
type fakeHTTP struct {
	mu      sync.Mutex
	calls   []httpCall
	handler func(*http.Request) (*http.Response, error)
}

type httpCall struct {
	Method      string
	URL         string
	Body        string
	ContentType string
	UserAgent   string
}

func (h *fakeHTTP) Do(request *http.Request) (*http.Response, error) {
	var body []byte
	if request.Body != nil {
		body, _ = io.ReadAll(request.Body)
	}
	h.mu.Lock()
	h.calls = append(h.calls, httpCall{
		Method:      request.Method,
		URL:         request.URL.String(),
		Body:        string(body),
		ContentType: request.Header.Get("Content-Type"),
		UserAgent:   request.Header.Get("User-Agent"),
	})
	handler := h.handler
	h.mu.Unlock()
	if handler != nil {
		return handler(request)
	}
	return jsonResponse(http.StatusNotFound, `{}`), nil
}

func (h *fakeHTTP) requestCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.calls)
}

func jsonResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(bytes.NewBufferString(body)),
	}
}

type fakeTargetValidator struct {
	mu     sync.Mutex
	calls  []string
	reject map[string]bool
}

func (v *fakeTargetValidator) validate(_ context.Context, raw string) (string, bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.calls = append(v.calls, raw)
	if v.reject[raw] {
		return "blocked", false
	}
	return "", true
}
