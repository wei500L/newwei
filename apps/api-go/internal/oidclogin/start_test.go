package oidclogin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestStartBuildsAuthorizationURLStateAndTTL(t *testing.T) {
	env := newTestService()
	env.addOrg(testOrg(), "acme")
	env.discoveryResponse()

	target, err := env.service.Start(context.Background(), "ACME")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(target)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Scheme != "https" || parsed.Host != "idp.example" || parsed.Path != "/authorize" {
		t.Fatalf("authorization url = %s", target)
	}
	query := parsed.Query()
	if got := query.Get("client_id"); got != "client-1" {
		t.Fatalf("client_id = %q", got)
	}
	if got := query.Get("response_type"); got != "code" {
		t.Fatalf("response_type = %q", got)
	}
	if got := query.Get("scope"); got != "openid email profile" {
		t.Fatalf("scope = %q", got)
	}
	if got := query.Get("redirect_uri"); got != "https://api.example.com/api/auth/oidc/callback" {
		t.Fatalf("redirect_uri = %q", got)
	}
	if got := query.Get("code_challenge_method"); got != "S256" {
		t.Fatalf("code_challenge_method = %q", got)
	}
	state := query.Get("state")
	nonce := query.Get("nonce")
	if !isUUID(state) || !isUUID(nonce) {
		t.Fatalf("state/nonce are not UUIDs: %q %q", state, nonce)
	}

	raw, found := env.cache.value(stateCacheKey(state))
	if !found {
		t.Fatal("state payload was not cached")
	}
	if got := env.cache.ttl(stateCacheKey(state)); got != 10*time.Minute {
		t.Fatalf("state ttl = %s", got)
	}
	var saved oidcState
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.OrgID != "org-1" || saved.Nonce != nonce {
		t.Fatalf("state payload = %+v", saved)
	}
	if len(saved.CodeVerifier) != 43 {
		t.Fatalf("verifier length = %d", len(saved.CodeVerifier))
	}
	if got, want := query.Get("code_challenge"), sha256Base64URL(saved.CodeVerifier); got != want {
		t.Fatalf("code_challenge = %q, want %q", got, want)
	}
	if got := env.cache.ttl("oidc:discovery:https://idp.example/.well-known/openid-configuration"); got != time.Hour {
		t.Fatalf("discovery ttl = %s", got)
	}
	// The slug lookup uses the lowercased value while the raw value is also
	// offered as the id, exactly like the NestJS OR.
	if len(env.directory.orgCalls) == 0 || env.directory.orgCalls[0] != "ACME/acme" {
		t.Fatalf("identifier call = %+v", env.directory.orgCalls)
	}
}

func TestStartRejectsUnknownOrDisabledOrganization(t *testing.T) {
	env := newTestService()
	if _, err := env.service.Start(context.Background(), "missing"); err == nil || err.Error() != notConfiguredError {
		t.Fatalf("unknown org error = %v", err)
	}
	disabled := testOrg()
	disabled.OIDC.Enabled = false
	env.addOrg(disabled, "acme")
	if _, err := env.service.Start(context.Background(), "acme"); err == nil || err.Error() != notConfiguredError {
		t.Fatalf("disabled org error = %v", err)
	}
}

func TestStartEnforcesURLRulesAndStateWrite(t *testing.T) {
	t.Run("non-https discovery", func(t *testing.T) {
		env := newTestService()
		org := testOrg()
		org.OIDC.IssuerURL = "http://idp.example"
		env.addOrg(org, "acme")
		_, err := env.service.Start(context.Background(), "acme")
		if err == nil || err.Error() != "OIDC discovery URL must use HTTPS" {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("ssrf target rejected before cache read", func(t *testing.T) {
		env := newTestService()
		org := testOrg()
		env.addOrg(org, "acme")
		env.validator.reject = map[string]bool{"https://idp.example/.well-known/openid-configuration": true}
		// A pre-populated cache entry must not bypass the URL rule.
		if err := env.cache.Set(context.Background(), "oidc:discovery:https://idp.example/.well-known/openid-configuration", []byte(`{"issuer":"https://idp.example"}`), time.Hour); err != nil {
			t.Fatal(err)
		}
		_, err := env.service.Start(context.Background(), "acme")
		if err == nil || err.Error() != "OIDC discovery URL is not allowed" {
			t.Fatalf("error = %v", err)
		}
		if env.cache.gets != 0 {
			t.Fatalf("discovery cache was read before the URL was validated (%d reads)", env.cache.gets)
		}
	})
	t.Run("missing required member", func(t *testing.T) {
		env := newTestService()
		env.addOrg(testOrg(), "acme")
		env.http.handler = func(request *http.Request) (*http.Response, error) {
			return jsonResponse(200, `{
				"issuer":"https://idp.example",
				"authorization_endpoint":"https://idp.example/authorize",
				"token_endpoint":"https://idp.example/token"
			}`), nil
		}
		_, err := env.service.Start(context.Background(), "acme")
		if err == nil || err.Error() != discoveryInvalidError {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("issuer query hash and slash normalization", func(t *testing.T) {
		env := newTestService()
		env.addOrg(testOrg(), "acme")
		env.http.handler = func(request *http.Request) (*http.Response, error) {
			return jsonResponse(200, `{
				"issuer":"https://idp.example/?ignored=1#fragment",
				"authorization_endpoint":"https://idp.example/authorize",
				"token_endpoint":"https://idp.example/token",
				"jwks_uri":"https://idp.example/jwks"
			}`), nil
		}
		if _, err := env.service.Start(context.Background(), "acme"); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("issuer mismatch", func(t *testing.T) {
		env := newTestService()
		env.addOrg(testOrg(), "acme")
		env.http.handler = func(request *http.Request) (*http.Response, error) {
			return jsonResponse(200, `{
				"issuer":"https://other.example",
				"authorization_endpoint":"https://idp.example/authorize",
				"token_endpoint":"https://idp.example/token",
				"jwks_uri":"https://idp.example/jwks"
			}`), nil
		}
		_, err := env.service.Start(context.Background(), "acme")
		if err == nil || err.Error() != discoveryIssuerError {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("state write failure never returns a login url", func(t *testing.T) {
		env := newTestService()
		env.addOrg(testOrg(), "acme")
		env.discoveryResponse()
		env.cache.setErr = context.Canceled
		target, err := env.service.Start(context.Background(), "acme")
		if err == nil || target != "" {
			t.Fatalf("target=%q error=%v", target, err)
		}
	})
}

func TestStartPreservesExistingAuthorizationParameters(t *testing.T) {
	env := newTestService()
	env.addOrg(testOrg(), "acme")
	env.http.handler = func(request *http.Request) (*http.Response, error) {
		return jsonResponse(200, `{
			"issuer":"https://idp.example",
			"authorization_endpoint":"https://idp.example/authorize?prompt=login",
			"token_endpoint":"https://idp.example/token",
			"jwks_uri":"https://idp.example/jwks"
		}`), nil
	}
	target, err := env.service.Start(context.Background(), "acme")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(target)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Query().Get("prompt") != "login" {
		t.Fatalf("existing authorization parameter was dropped: %s", target)
	}
}

func TestReadScopesRules(t *testing.T) {
	cases := []struct {
		raw  string
		want []string
	}{
		{raw: "", want: []string{"openid", "email", "profile"}},
		{raw: "null", want: []string{"openid", "email", "profile"}},
		{raw: "[]", want: []string{"openid", "email", "profile"}},
		{raw: `"openid"`, want: []string{"openid", "email", "profile"}},
		{raw: `["openid","email","openid"]`, want: []string{"openid", "email", "openid"}},
		{raw: `[" custom ","  ","custom"]`, want: []string{" custom ", "custom"}},
		{raw: `["openid",5,null]`, want: []string{"openid"}},
		{raw: `[""]`, want: []string{"openid", "email", "profile"}},
	}
	for _, tc := range cases {
		got := readScopes([]byte(tc.raw))
		if len(got) != len(tc.want) {
			t.Fatalf("readScopes(%s) = %v, want %v", tc.raw, got, tc.want)
		}
		for index := range tc.want {
			if got[index] != tc.want[index] {
				t.Fatalf("readScopes(%s) = %v, want %v", tc.raw, got, tc.want)
			}
		}
	}
}

func TestStartRequiresAPIBaseURLAtRequestTime(t *testing.T) {
	env := newTestService()
	env.service.cfg.APIBaseURL = ""
	env.addOrg(testOrg(), "acme")
	env.discoveryResponse()
	_, err := env.service.Start(context.Background(), "acme")
	if err == nil || err.Error() != apiBaseURLRequiredError {
		t.Fatalf("error = %v", err)
	}
	// The state save happens before the redirect_uri resolution, exactly like
	// the source; the orphan state expires on its own TTL.
}

func TestIDPCallbackURLNormalization(t *testing.T) {
	cases := map[string]string{
		"https://api.example.com":        "https://api.example.com/api/auth/oidc/callback",
		"https://api.example.com/":       "https://api.example.com/api/auth/oidc/callback",
		"https://api.example.com/api":    "https://api.example.com/api/auth/oidc/callback",
		"https://api.example.com/API/":   "https://api.example.com/api/auth/oidc/callback",
		"  https://api.example.com/api ": "https://api.example.com/api/auth/oidc/callback",
	}
	for input, want := range cases {
		service := &Service{cfg: Config{APIBaseURL: input}}
		got, err := service.idpCallbackURL()
		if err != nil {
			t.Fatalf("%q: %v", input, err)
		}
		if got != want {
			t.Fatalf("%q => %q, want %q", input, got, want)
		}
	}
	service := &Service{cfg: Config{}}
	if _, err := service.idpCallbackURL(); err == nil || err.Error() != apiBaseURLRequiredError {
		t.Fatalf("missing base error = %v", err)
	}
}

func isUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	if strings.Count(value, "-") != 4 {
		return false
	}
	for _, char := range value {
		if char == '-' {
			continue
		}
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f')) {
			return false
		}
	}
	return true
}
