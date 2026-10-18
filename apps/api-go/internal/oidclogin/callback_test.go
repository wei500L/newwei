package oidclogin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authlogin"
)

func primeState(t *testing.T, env *testService, state string, payload oidcState) {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := env.cache.Set(context.Background(), stateCacheKey(state), raw, stateTTL); err != nil {
		t.Fatal(err)
	}
}

func configureCallbackIDP(t *testing.T, env *testService, fixture *jwtFixture, nonce string, mutate func(*testIDClaims)) {
	t.Helper()
	claims := validClaims(env.clock.Now())
	claims.Nonce = nonce
	if mutate != nil {
		mutate(&claims)
	}
	idToken := fixture.sign(t, claims)
	discoveryBody := `{
		"issuer":"https://idp.example",
		"authorization_endpoint":"https://idp.example/authorize",
		"token_endpoint":"https://idp.example/token",
		"jwks_uri":"https://idp.example/jwks"
	}`
	jwksBody, err := json.Marshal(fixture.keySet())
	if err != nil {
		t.Fatal(err)
	}
	env.http.handler = func(request *http.Request) (*http.Response, error) {
		switch request.URL.String() {
		case "https://idp.example/.well-known/openid-configuration":
			return jsonResponse(200, discoveryBody), nil
		case "https://idp.example/jwks":
			return jsonResponse(200, string(jwksBody)), nil
		case "https://idp.example/token":
			return jsonResponse(200, `{"id_token":`+quoteJSON(t, idToken)+`}`), nil
		default:
			return jsonResponse(404, `{}`), nil
		}
	}
}

func quoteJSON(t *testing.T, value string) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func TestCallbackVerifiesTokenAndCreatesEncryptedHandoff(t *testing.T) {
	env := newTestService()
	env.addOrg(testOrg(), "acme")
	env.addUser("person@example.com", "user-1")
	env.login.result = sessionFixture()
	primeState(t, env, "state-1", oidcState{OrgID: "org-1", CodeVerifier: "verifier-1", Nonce: "nonce-1"})
	configureCallbackIDP(t, env, newRSAFixture(t), "nonce-1", nil)

	userAgent := "Browser/1.0"
	result, err := env.service.Callback(context.Background(), CallbackParams{
		State:     stringRef("state-1"),
		Code:      stringRef("code-1"),
		UserAgent: &userAgent,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.HandoffToken) != 64 || !isHex(result.HandoffToken) {
		t.Fatalf("handoff token = %q", result.HandoffToken)
	}
	if result.AuthChallengeID != "" || result.EnrollmentChallengeID != "" {
		t.Fatalf("unexpected challenge branch: %+v", result)
	}

	challengeID := hashOpaqueToken(result.HandoffToken)
	row, found := env.challenges.rows[challengeID]
	if !found {
		t.Fatal("handoff challenge was not created")
	}
	if row.Type != challengeTypeSSOHandoff || row.UserID == nil || *row.UserID != "user-1" || row.OrgID == nil || *row.OrgID != "org-1" {
		t.Fatalf("challenge row = %+v", row)
	}
	if got := row.ExpiresAt.Sub(env.clock.Now()); got != 5*time.Minute {
		t.Fatalf("handoff ttl = %s", got)
	}

	var payload handoffPayload
	if err := json.Unmarshal(row.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	var accessToken string
	if err := json.Unmarshal(payload.AccessToken, &accessToken); err != nil {
		t.Fatal(err)
	}
	if accessToken != "access-token" {
		t.Fatalf("stored access token = %q", accessToken)
	}
	if payload.ExpiresIn != 900 || payload.User.ID != "user-1" || len(payload.Organizations) != 1 {
		t.Fatalf("payload = %+v", payload)
	}
	if payload.UserAgent == nil || *payload.UserAgent != userAgent {
		t.Fatalf("payload user agent = %v", payload.UserAgent)
	}

	if len(env.login.calls) != 1 {
		t.Fatalf("trusted login calls = %d", len(env.login.calls))
	}
	call := env.login.calls[0]
	if call.UserID != "user-1" || call.OrgID != "org-1" || call.Action != oidcLoginAuditAction {
		t.Fatalf("trusted login call = %+v", call)
	}
	if call.UserAgent == nil || *call.UserAgent != userAgent {
		t.Fatalf("trusted login user agent = %v", call.UserAgent)
	}

	tokenCall := findHTTPCall(t, env.http.calls, http.MethodPost, "https://idp.example/token")
	if tokenCall.ContentType != "application/x-www-form-urlencoded" {
		t.Fatalf("content type = %q", tokenCall.ContentType)
	}
	form, err := url.ParseQuery(tokenCall.Body)
	if err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]string{
		"grant_type":    "authorization_code",
		"code":          "code-1",
		"redirect_uri":  "https://api.example.com/api/auth/oidc/callback",
		"client_id":     "client-1",
		"code_verifier": "verifier-1",
		"client_secret": "client-secret",
	} {
		if got := form.Get(key); got != want {
			t.Fatalf("%s = %q, want %q", key, got, want)
		}
	}

	// The state is a one-time credential: a replayed callback cannot reuse it.
	if _, err := env.service.Callback(context.Background(), CallbackParams{
		State: stringRef("state-1"),
		Code:  stringRef("code-1"),
	}); err == nil || err.Error() != stateInvalidError {
		t.Fatalf("replayed state error = %v", err)
	}
}

func TestCallbackRejectsIDPErrorBeforeConsumingState(t *testing.T) {
	env := newTestService()
	env.addOrg(testOrg(), "acme")
	primeState(t, env, "state-1", oidcState{OrgID: "org-1", CodeVerifier: "v", Nonce: "n"})
	before := env.cache.getDels
	_, err := env.service.Callback(context.Background(), CallbackParams{
		State: stringRef("state-1"),
		Error: stringRef("access_denied"),
	})
	if err == nil || err.Error() != "OIDC login failed: access_denied" {
		t.Fatalf("error = %v", err)
	}
	if env.cache.getDels != before {
		t.Fatal("state was consumed even though the IdP returned an error")
	}
	if _, err := env.service.Callback(context.Background(), CallbackParams{}); err == nil || err.Error() != callbackInvalidError {
		t.Fatalf("missing params error = %v", err)
	}
}

func TestCallbackMFAAndForcedEnrollmentBranches(t *testing.T) {
	t.Run("existing factor", func(t *testing.T) {
		env := newTestService()
		env.addOrg(testOrg(), "acme")
		env.addUser("person@example.com", "user-1")
		env.login.result = authlogin.TrustedLoginResult{MFA: &authlogin.TrustedLoginMFA{AuthChallengeID: "mfa-challenge"}}
		primeState(t, env, "state-1", oidcState{OrgID: "org-1", CodeVerifier: "v", Nonce: "nonce-1"})
		configureCallbackIDP(t, env, newRSAFixture(t), "nonce-1", nil)
		result, err := env.service.Callback(context.Background(), CallbackParams{
			State: stringRef("state-1"), Code: stringRef("code-1"),
		})
		if err != nil {
			t.Fatal(err)
		}
		if result.AuthChallengeID != "mfa-challenge" || result.HandoffToken != "" || result.EnrollmentChallengeID != "" {
			t.Fatalf("result = %+v", result)
		}
		if len(env.challenges.rows) != 0 {
			t.Fatal("no handoff row may exist before the second factor")
		}
	})
	t.Run("forced enrollment", func(t *testing.T) {
		env := newTestService()
		env.addOrg(testOrg(), "acme")
		env.addUser("person@example.com", "user-1")
		env.login.result = authlogin.TrustedLoginResult{Enrollment: &authlogin.TrustedLoginEnrollment{EnrollmentChallengeID: "enroll-challenge"}}
		primeState(t, env, "state-1", oidcState{OrgID: "org-1", CodeVerifier: "v", Nonce: "nonce-1"})
		configureCallbackIDP(t, env, newRSAFixture(t), "nonce-1", nil)
		result, err := env.service.Callback(context.Background(), CallbackParams{
			State: stringRef("state-1"), Code: stringRef("code-1"),
		})
		if err != nil {
			t.Fatal(err)
		}
		if result.EnrollmentChallengeID != "enroll-challenge" || result.HandoffToken != "" || result.AuthChallengeID != "" {
			t.Fatalf("result = %+v", result)
		}
		if len(env.challenges.rows) != 0 {
			t.Fatal("no handoff row may exist before the forced enrollment")
		}
	})
}

func TestCallbackRejectsUnknownAccountAndInvalidToken(t *testing.T) {
	t.Run("account must already exist", func(t *testing.T) {
		env := newTestService()
		env.addOrg(testOrg(), "acme")
		primeState(t, env, "state-1", oidcState{OrgID: "org-1", CodeVerifier: "v", Nonce: "nonce-1"})
		configureCallbackIDP(t, env, newRSAFixture(t), "nonce-1", nil)
		_, err := env.service.Callback(context.Background(), CallbackParams{
			State: stringRef("state-1"), Code: stringRef("code-1"),
		})
		if err == nil || err.Error() != invitedAccountError {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("invalid token is a 401 contract message", func(t *testing.T) {
		env := newTestService()
		env.addOrg(testOrg(), "acme")
		env.addUser("person@example.com", "user-1")
		primeState(t, env, "state-1", oidcState{OrgID: "org-1", CodeVerifier: "v", Nonce: "nonce-1"})
		configureCallbackIDP(t, env, newRSAFixture(t), "nonce-1", func(claims *testIDClaims) {
			claims.Nonce = "wrong"
		})
		_, err := env.service.Callback(context.Background(), CallbackParams{
			State: stringRef("state-1"), Code: stringRef("code-1"),
		})
		if err == nil || err.Error() != identityTokenInvalidError {
			t.Fatalf("error = %v", err)
		}
	})
}

func TestCallbackOmitsSecretWhenNoneDecoded(t *testing.T) {
	env := newTestService()
	org := testOrg()
	org.OIDC.ClientSecret = nil
	env.addOrg(org, "acme")
	env.addUser("person@example.com", "user-1")
	env.login.result = sessionFixture()
	primeState(t, env, "state-1", oidcState{OrgID: "org-1", CodeVerifier: "verifier-1", Nonce: "nonce-1"})
	configureCallbackIDP(t, env, newRSAFixture(t), "nonce-1", nil)
	if _, err := env.service.Callback(context.Background(), CallbackParams{
		State: stringRef("state-1"), Code: stringRef("code-1"),
	}); err != nil {
		t.Fatal(err)
	}
	tokenCall := findHTTPCall(t, env.http.calls, http.MethodPost, "https://idp.example/token")
	form, err := url.ParseQuery(tokenCall.Body)
	if err != nil {
		t.Fatal(err)
	}
	if _, present := form["client_secret"]; present {
		t.Fatalf("client_secret must be omitted, form = %v", form)
	}
}

func findHTTPCall(t *testing.T, calls []httpCall, method, target string) httpCall {
	t.Helper()
	for _, call := range calls {
		if call.Method == method && call.URL == target {
			return call
		}
	}
	t.Fatalf("missing %s %s in %+v", method, target, calls)
	return httpCall{}
}

func stringRef(value string) *string { return &value }

func isHex(value string) bool {
	for _, char := range value {
		if !strings.ContainsRune("0123456789abcdef", char) {
			return false
		}
	}
	return true
}
