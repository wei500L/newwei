package oidclogin

import (
	"net/http"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/accountsecurity"
	"github.com/wei500L/newwei/apps/api-go/internal/authlogin"
)

// testClock is the injected request clock. Expiry and the JWT verification
// window use it instead of the wall clock.
type testClock struct {
	mu sync.Mutex
	at time.Time
}

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.at
}

func (c *testClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.at = c.at.Add(d)
}

type testService struct {
	service    *Service
	cache      *fakeCache
	directory  *fakeDirectory
	challenges *fakeChallenges
	secrets    *fakeSecrets
	login      *fakeLogin
	http       *fakeHTTP
	validator  *fakeTargetValidator
	clock      *testClock
}

func newTestService() *testService {
	cache := newFakeCache()
	directory := newFakeDirectory()
	challenges := newFakeChallenges()
	secrets := &fakeSecrets{}
	login := &fakeLogin{}
	client := &fakeHTTP{}
	validator := &fakeTargetValidator{}
	clock := &testClock{at: time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)}
	service := &Service{
		cfg: Config{
			NextAuthURL: "http://localhost:3000",
			APIBaseURL:  "https://api.example.com",
			TrustProxy:  "",
		},
		cache:          cache,
		directory:      directory,
		challenges:     challenges,
		login:          login,
		secrets:        secrets,
		http:           client,
		validateTarget: validator.validate,
		now:            clock.Now,
	}
	return &testService{
		service:    service,
		cache:      cache,
		directory:  directory,
		challenges: challenges,
		secrets:    secrets,
		login:      login,
		http:       client,
		validator:  validator,
		clock:      clock,
	}
}

func testOrg() *orgRecord {
	return &orgRecord{
		ID: "org-1",
		OIDC: &orgOIDCConfig{
			OrgID:                "org-1",
			Enabled:              true,
			IssuerURL:            "https://idp.example",
			ClientID:             "client-1",
			ClientSecret:         []byte(`"client-secret"`),
			Scopes:               []byte(`["openid","email","profile"]`),
			RequireEmailVerified: true,
		},
	}
}

func (t *testService) addOrg(org *orgRecord, slug string) {
	t.directory.orgs[org.ID] = org
	if slug != "" {
		t.directory.slugs[slug] = org.ID
	}
}

func (t *testService) addUser(email, userID string) {
	t.directory.users[email] = userID
}

func (t *testService) discoveryResponse() {
	t.http.handler = func(request *http.Request) (*http.Response, error) {
		switch request.URL.String() {
		case "https://idp.example/.well-known/openid-configuration":
			return jsonResponse(200, `{
				"issuer":"https://idp.example",
				"authorization_endpoint":"https://idp.example/authorize",
				"token_endpoint":"https://idp.example/token",
				"jwks_uri":"https://idp.example/jwks"
			}`), nil
		default:
			return jsonResponse(404, `{}`), nil
		}
	}
}

func sessionFixture() authlogin.TrustedLoginResult {
	organizations := []accountsecurity.LoginOrganization{
		{ID: "org-1", Name: "Org", Slug: "org", IsActive: true},
	}
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
		Organizations: organizations,
		ExpiresIn:     900,
	}}
}
