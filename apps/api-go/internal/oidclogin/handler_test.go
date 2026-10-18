package oidclogin

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authlogin"
)

func TestHandlerStartRedirectsOnlyToTheIDP(t *testing.T) {
	env := newTestService()
	env.addOrg(testOrg(), "acme")
	env.discoveryResponse()
	handler := NewHandler(env.service)

	request := httptest.NewRequest(http.MethodGet, PathStart+"?org=acme", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusFound {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	location := recorder.Header().Get("Location")
	parsed, err := url.Parse(location)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Host != "idp.example" || parsed.Path != "/authorize" {
		t.Fatalf("location = %s", location)
	}
	if strings.Contains(location, "client-secret") {
		t.Fatal("client secret leaked into the browser URL")
	}

	missing := httptest.NewRequest(http.MethodGet, PathStart, nil)
	missingRecorder := httptest.NewRecorder()
	handler.ServeHTTP(missingRecorder, missing)
	if missingRecorder.Code != http.StatusInternalServerError {
		t.Fatalf("missing org status = %d", missingRecorder.Code)
	}

	unknown := httptest.NewRequest(http.MethodGet, PathStart+"?org=missing", nil)
	unknownRecorder := httptest.NewRecorder()
	handler.ServeHTTP(unknownRecorder, unknown)
	if unknownRecorder.Code != http.StatusBadRequest {
		t.Fatalf("unknown org status = %d", unknownRecorder.Code)
	}
	var body struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(unknownRecorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Message != notConfiguredError {
		t.Fatalf("message = %q", body.Message)
	}
}

func TestHandlerCallbackAlwaysRedirectsAndEncodesTheError(t *testing.T) {
	env := newTestService()
	env.addOrg(testOrg(), "acme")
	handler := NewHandler(env.service)

	request := httptest.NewRequest(http.MethodGet, PathCallback+"?state=missing&code=code", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusFound {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	location := recorder.Header().Get("Location")
	parsed, err := url.Parse(location)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Scheme != "http" || parsed.Host != "localhost:3000" || parsed.Path != "/auth/sso/callback" {
		t.Fatalf("location = %s", location)
	}
	if got := parsed.Query().Get("error"); got != stateInvalidError {
		t.Fatalf("error = %q", got)
	}
	if parsed.Query().Get("handoffToken") != "" || parsed.Query().Get("challengeId") != "" || parsed.Query().Get("enrollmentChallengeId") != "" {
		t.Fatalf("error redirect carried a success parameter: %s", location)
	}
}

func TestHandlerCallbackSuccessCarriesOneBranch(t *testing.T) {
	cases := []struct {
		name   string
		result authlogin.TrustedLoginResult
		key    string
	}{
		{name: "handoff", result: sessionFixture(), key: "handoffToken"},
		{name: "mfa", result: authlogin.TrustedLoginResult{MFA: &authlogin.TrustedLoginMFA{AuthChallengeID: "challenge-1"}}, key: "challengeId"},
		{name: "enrollment", result: authlogin.TrustedLoginResult{Enrollment: &authlogin.TrustedLoginEnrollment{EnrollmentChallengeID: "enroll-1"}}, key: "enrollmentChallengeId"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := newTestService()
			env.addOrg(testOrg(), "acme")
			env.addUser("person@example.com", "user-1")
			env.login.result = tc.result
			primeState(t, env, "state-1", oidcState{OrgID: "org-1", CodeVerifier: "v", Nonce: "nonce-1"})
			configureCallbackIDP(t, env, newRSAFixture(t), "nonce-1", nil)
			handler := NewHandler(env.service)
			request := httptest.NewRequest(http.MethodGet, PathCallback+"?state=state-1&code=code-1", nil)
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)
			if recorder.Code != http.StatusFound {
				t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
			}
			location, err := url.Parse(recorder.Header().Get("Location"))
			if err != nil {
				t.Fatal(err)
			}
			query := location.Query()
			if query.Get(tc.key) == "" {
				t.Fatalf("missing %s in %s", tc.key, location)
			}
			successKeys := 0
			for _, key := range []string{"handoffToken", "challengeId", "enrollmentChallengeId"} {
				if query.Get(key) != "" {
					successKeys++
				}
			}
			if successKeys != 1 {
				t.Fatalf("success branch count = %d in %s", successKeys, location)
			}
			if query.Get("error") != "" {
				t.Fatalf("success redirect carried error: %s", location)
			}
			// The external id_token and access token never appear in the URL.
			if strings.Contains(recorder.Header().Get("Location"), "access-token") || strings.Contains(recorder.Header().Get("Location"), "eyJ") {
				t.Fatalf("token leaked into redirect: %s", location)
			}
		})
	}
}

func TestHandlerExchangeDTORulesAndOneShotResponse(t *testing.T) {
	env := newTestService()
	handler := NewHandler(env.service)

	for name, body := range map[string]string{
		"missing": `{}`,
		"null":    `{"handoffToken":null}`,
		"number":  `{"handoffToken":123}`,
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, PathExchange, strings.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
			}
		})
	}

	empty := httptest.NewRequest(http.MethodPost, PathExchange, strings.NewReader(`{"handoffToken":""}`))
	empty.Header.Set("Content-Type", "application/json")
	emptyRecorder := httptest.NewRecorder()
	handler.ServeHTTP(emptyRecorder, empty)
	if emptyRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("empty token status = %d", emptyRecorder.Code)
	}

	payload := baseHandoffPayload(nil)
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	rawToken := strings64hex()
	env.challenges.rows[hashOpaqueToken(rawToken)] = handoffChallenge{
		ID:        hashOpaqueToken(rawToken),
		Type:      challengeTypeSSOHandoff,
		Payload:   encoded,
		ExpiresAt: env.clock.Now().Add(time.Minute),
	}
	request := httptest.NewRequest(http.MethodPost, PathExchange, strings.NewReader(`{"handoffToken":"`+rawToken+`"}`))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	var response ExchangeResult
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.AccessToken != "access-token" || response.User.ID != "user-1" {
		t.Fatalf("response = %+v", response)
	}
	if strings.HasSuffix(recorder.Body.String(), "\n") {
		t.Fatal("response body must not carry the encoder newline")
	}
}

func TestHandlerRejectsOtherMethods(t *testing.T) {
	env := newTestService()
	handler := NewHandler(env.service)
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, PathStart},
		{http.MethodPost, PathCallback},
		{http.MethodGet, PathExchange},
	} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(tc.method, tc.path, nil))
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s %s status = %d", tc.method, tc.path, recorder.Code)
		}
	}
}
