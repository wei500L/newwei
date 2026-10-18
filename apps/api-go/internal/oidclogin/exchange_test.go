package oidclogin

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/accountsecurity"
)

func handoffRow(t *testing.T, env *testService, payload handoffPayload, expiresAt time.Time) (string, handoffChallenge) {
	t.Helper()
	rawToken := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	row := handoffChallenge{
		ID:        hashOpaqueToken(rawToken),
		Type:      challengeTypeSSOHandoff,
		UserID:    stringRef("user-1"),
		OrgID:     stringRef("org-1"),
		Payload:   encoded,
		ExpiresAt: expiresAt,
	}
	env.challenges.rows[row.ID] = row
	return rawToken, row
}

func baseHandoffPayload(userAgent *string) handoffPayload {
	return handoffPayload{
		AccessToken:   json.RawMessage(`"access-token"`),
		RefreshToken:  json.RawMessage(`"refresh-token"`),
		ExpiresIn:     900,
		User:          sessionFixture().Session.User,
		Organizations: sessionFixture().Session.Organizations,
		UserAgent:     userAgent,
	}
}

func TestExchangeConsumesHandoffOnce(t *testing.T) {
	env := newTestService()
	userAgent := "Browser/1.0"
	rawToken, row := handoffRow(t, env, baseHandoffPayload(&userAgent), env.clock.Now().Add(5*time.Minute))

	result, err := env.service.Exchange(context.Background(), rawToken, &userAgent)
	if err != nil {
		t.Fatal(err)
	}
	if result.AccessToken != "access-token" || result.RefreshToken != "refresh-token" || result.ExpiresIn != 900 {
		t.Fatalf("result = %+v", result)
	}
	if result.User.ID != "user-1" || len(result.Organizations) != 1 {
		t.Fatalf("result identity = %+v", result)
	}
	if stored := env.challenges.rows[row.ID]; stored.ConsumedAt == nil {
		t.Fatal("the successful exchange did not consume the row")
	}
	if _, err := env.service.Exchange(context.Background(), rawToken, &userAgent); err == nil || err.Error() != handoffInvalidError {
		t.Fatalf("second exchange error = %v", err)
	}
}

func TestExchangeUserAgentBinding(t *testing.T) {
	env := newTestService()
	recorded := "Browser/1.0"
	fixture := baseHandoffPayload(&recorded)

	t.Run("mismatch", func(t *testing.T) {
		rawToken, _ := handoffRow(t, env, fixture, env.clock.Now().Add(time.Minute))
		other := "Browser/2.0"
		if _, err := env.service.Exchange(context.Background(), rawToken, &other); err == nil || err.Error() != handoffInvalidError {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("matching after trim", func(t *testing.T) {
		rawToken, _ := handoffRow(t, env, fixture, env.clock.Now().Add(time.Minute))
		provided := "  Browser/1.0 "
		if _, err := env.service.Exchange(context.Background(), rawToken, &provided); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("missing request value is not a mismatch", func(t *testing.T) {
		rawToken, _ := handoffRow(t, env, fixture, env.clock.Now().Add(time.Minute))
		if _, err := env.service.Exchange(context.Background(), rawToken, nil); err != nil {
			t.Fatal(err)
		}
	})
}

func TestExchangeExpiryBoundary(t *testing.T) {
	t.Run("strictly expired", func(t *testing.T) {
		env := newTestService()
		rawToken, _ := handoffRow(t, env, baseHandoffPayload(nil), env.clock.Now().Add(-time.Nanosecond))
		if _, err := env.service.Exchange(context.Background(), rawToken, nil); err == nil || err.Error() != handoffInvalidError {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("expires exactly now is still claimable", func(t *testing.T) {
		env := newTestService()
		rawToken, _ := handoffRow(t, env, baseHandoffPayload(nil), env.clock.Now())
		if _, err := env.service.Exchange(context.Background(), rawToken, nil); err != nil {
			t.Fatal(err)
		}
	})
}

func TestExchangeRejectsIncompletePayload(t *testing.T) {
	cases := map[string]string{
		"missing expiresIn":     `{"accessToken":"a","refreshToken":"r","user":{"id":"user-1"},"organizations":[]}`,
		"missing user":          `{"accessToken":"a","refreshToken":"r","expiresIn":900,"organizations":[]}`,
		"missing organizations": `{"accessToken":"a","refreshToken":"r","expiresIn":900,"user":{"id":"user-1"}}`,
		"organizations object":  `{"accessToken":"a","refreshToken":"r","expiresIn":900,"user":{"id":"user-1"},"organizations":{}}`,
		"expiresIn string":      `{"accessToken":"a","refreshToken":"r","expiresIn":"900","user":{"id":"user-1"},"organizations":[]}`,
		"missing token":         `{"refreshToken":"r","expiresIn":900,"user":{"id":"user-1"},"organizations":[]}`,
	}
	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			env := newTestService()
			rawToken := strings64hex()
			env.challenges.rows[hashOpaqueToken(rawToken)] = handoffChallenge{
				ID:        hashOpaqueToken(rawToken),
				Type:      challengeTypeSSOHandoff,
				Payload:   []byte(payload),
				ExpiresAt: env.clock.Now().Add(time.Minute),
			}
			if _, err := env.service.Exchange(context.Background(), rawToken, nil); err == nil || err.Error() != handoffInvalidError {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestExchangeAcceptsEmptyOrganizations(t *testing.T) {
	env := newTestService()
	payload := baseHandoffPayload(nil)
	payload.Organizations = []accountsecurity.LoginOrganization{}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	rawToken := strings64hex()
	env.challenges.rows[hashOpaqueToken(rawToken)] = handoffChallenge{
		ID:        hashOpaqueToken(rawToken),
		Type:      challengeTypeSSOHandoff,
		Payload:   raw,
		ExpiresAt: env.clock.Now().Add(time.Minute),
	}
	result, err := env.service.Exchange(context.Background(), rawToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	organizations, err := json.Marshal(result.Organizations)
	if err != nil {
		t.Fatal(err)
	}
	if string(organizations) != "[]" {
		t.Fatalf("organizations = %s, want []", organizations)
	}
}

func TestExchangeDecryptionFailureKeepsItsOwnError(t *testing.T) {
	env := newTestService()
	env.secrets.decodeErr = errors.New("failed to decrypt system setting secret")
	rawToken, _ := handoffRow(t, env, baseHandoffPayload(nil), env.clock.Now().Add(time.Minute))
	_, err := env.service.Exchange(context.Background(), rawToken, nil)
	if err == nil || err.Error() != "failed to decrypt system setting secret" {
		t.Fatalf("error = %v", err)
	}
	if err.Error() == handoffInvalidError {
		t.Fatal("decryption failure must not be disguised as an invalid handoff")
	}
}

func TestExchangeConcurrentClaimOnlyOneSucceeds(t *testing.T) {
	env := newTestService()
	rawToken, _ := handoffRow(t, env, baseHandoffPayload(nil), env.clock.Now().Add(time.Minute))
	var wait sync.WaitGroup
	results := make(chan error, 2)
	for index := 0; index < 2; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, err := env.service.Exchange(context.Background(), rawToken, nil)
			results <- err
		}()
	}
	wait.Wait()
	close(results)
	successes := 0
	failures := 0
	for err := range results {
		switch {
		case err == nil:
			successes++
		case err.Error() == handoffInvalidError:
			failures++
		default:
			t.Fatalf("unexpected error = %v", err)
		}
	}
	if successes != 1 || failures != 1 {
		t.Fatalf("successes=%d failures=%d", successes, failures)
	}
}

// strings64hex returns a distinct 64-character token for payload tests.
func strings64hex() string {
	return "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
}
