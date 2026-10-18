package oidclogin

import (
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type testIDClaims struct {
	Nonce         string          `json:"nonce"`
	Email         string          `json:"email"`
	EmailVerified json.RawMessage `json:"email_verified,omitempty"`
	Azp           string          `json:"azp,omitempty"`
	jwt.RegisteredClaims
}

type jwtFixture struct {
	method jwt.SigningMethod
	key    any
	jwk    jwk
}

func newRSAFixture(t *testing.T) *jwtFixture {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return &jwtFixture{
		method: jwt.SigningMethodRS256,
		key:    key,
		jwk: jwk{
			Kty: "RSA", Kid: "key-1", Alg: "RS256", Use: "sig",
			N: base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
			E: base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
		},
	}
}

func newECFixture(t *testing.T) *jwtFixture {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &jwtFixture{
		method: jwt.SigningMethodES256,
		key:    key,
		jwk: jwk{
			Kty: "EC", Kid: "ec-1", Alg: "ES256", Use: "sig", Crv: "P-256",
			X: base64.RawURLEncoding.EncodeToString(key.X.Bytes()),
			Y: base64.RawURLEncoding.EncodeToString(key.Y.Bytes()),
		},
	}
}

func newEdFixture(t *testing.T) *jwtFixture {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &jwtFixture{
		method: jwt.SigningMethodEdDSA,
		key:    private,
		jwk: jwk{
			Kty: "OKP", Kid: "ed-1", Alg: "EdDSA", Use: "sig", Crv: "Ed25519",
			X: base64.RawURLEncoding.EncodeToString(public),
		},
	}
}

func (f *jwtFixture) sign(t *testing.T, claims testIDClaims) string {
	t.Helper()
	signed, err := jwt.NewWithClaims(f.method, claims).SignedString(f.key)
	if err != nil {
		t.Fatal(err)
	}
	return signed
}

func (f *jwtFixture) keySet() jwksDocument {
	return jwksDocument{Keys: []jwk{f.jwk}}
}

func testDiscovery() oidcDiscovery {
	return oidcDiscovery{
		Issuer:                "https://idp.example",
		AuthorizationEndpoint: "https://idp.example/authorize",
		TokenEndpoint:         "https://idp.example/token",
		JWKSUri:               "https://idp.example/jwks",
	}
}

func validClaims(now time.Time) testIDClaims {
	return testIDClaims{
		Nonce:         "nonce-1",
		Email:         "person@example.com",
		EmailVerified: json.RawMessage("true"),
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "https://idp.example",
			Subject:   "subject-1",
			Audience:  jwt.ClaimStrings{"client-1"},
			ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
			IssuedAt:  jwt.NewNumericDate(now),
		},
	}
}

func (env *testService) serveJWKS(document jwksDocument) {
	body, _ := json.Marshal(document)
	env.http.handler = func(request *http.Request) (*http.Response, error) {
		if request.URL.String() == "https://idp.example/jwks" {
			return jsonResponse(200, string(body)), nil
		}
		return jsonResponse(404, `{}`), nil
	}
}

func TestVerifyIDTokenRealSignatures(t *testing.T) {
	cases := map[string]func(*testing.T) *jwtFixture{
		"RS256": newRSAFixture,
		"ES256": newECFixture,
		"EdDSA": newEdFixture,
	}
	for name, build := range cases {
		t.Run(name, func(t *testing.T) {
			env := newTestService()
			fixture := build(t)
			env.serveJWKS(fixture.keySet())
			token := fixture.sign(t, validClaims(env.clock.Now()))
			claims, err := env.service.verifyIDToken(context.Background(), token, testDiscovery(), "client-1", "nonce-1", true)
			if err != nil {
				t.Fatal(err)
			}
			if claims.verifiedEmail() != "person@example.com" {
				t.Fatalf("email = %q", claims.verifiedEmail())
			}
			if got := env.cache.ttl("oidc:jwks:https://idp.example/jwks"); got != 24*time.Hour {
				t.Fatalf("jwks ttl = %s", got)
			}
		})
	}
}

func TestVerifyIDTokenRejectsInvalidClaimsAndAlgorithms(t *testing.T) {
	now := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	cases := map[string]func(*testIDClaims){
		"wrong issuer":   func(claims *testIDClaims) { claims.Issuer = "https://other.example" },
		"wrong audience": func(claims *testIDClaims) { claims.Audience = jwt.ClaimStrings{"other-client"} },
		"nonce mismatch": func(claims *testIDClaims) { claims.Nonce = "other-nonce" },
		"expired":        func(claims *testIDClaims) { claims.ExpiresAt = jwt.NewNumericDate(now.Add(-2 * time.Minute)) },
		"email_verified string": func(claims *testIDClaims) {
			claims.EmailVerified = json.RawMessage(`"true"`)
		},
		"email_verified false": func(claims *testIDClaims) { claims.EmailVerified = json.RawMessage("false") },
		"email empty":          func(claims *testIDClaims) { claims.Email = "  " },
		"azp mismatch": func(claims *testIDClaims) {
			claims.Azp = "other-client"
		},
		"multi audience without azp": func(claims *testIDClaims) {
			claims.Audience = jwt.ClaimStrings{"client-1", "client-2"}
		},
		"missing subject": func(claims *testIDClaims) { claims.Subject = "" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			env := newTestService()
			fixture := newRSAFixture(t)
			env.serveJWKS(fixture.keySet())
			claims := validClaims(now)
			mutate(&claims)
			token := fixture.sign(t, claims)
			_, err := env.service.verifyIDToken(context.Background(), token, testDiscovery(), "client-1", "nonce-1", true)
			if err == nil || err.Error() != identityTokenInvalidError {
				t.Fatalf("error = %v", err)
			}
		})
	}

	t.Run("HS256 is never accepted", func(t *testing.T) {
		env := newTestService()
		env.serveJWKS(jwksDocument{Keys: []jwk{{
			Kty: "oct", Kid: "symmetric", Alg: "HS256", Use: "sig",
			N: base64.RawURLEncoding.EncodeToString([]byte("shared-secret")),
			E: "AQAB",
		}}})
		claims := validClaims(now)
		token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte("shared-secret"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := env.service.verifyIDToken(context.Background(), token, testDiscovery(), "client-1", "nonce-1", true); err == nil || err.Error() != identityTokenInvalidError {
			t.Fatalf("error = %v", err)
		}
	})
}

func TestVerifyIDTokenRefreshesJWKSExactlyOnce(t *testing.T) {
	env := newTestService()
	stale := newRSAFixture(t)
	rotated := newRSAFixture(t)
	rotated.jwk.Kid = "key-1"
	env.serveJWKS(rotated.keySet())

	// Prime the cache with the stale key set. The token is signed by the new
	// key, so the first verification fails and must trigger exactly one refetch.
	cached, _ := json.Marshal(stale.keySet())
	if err := env.cache.Set(context.Background(), "oidc:jwks:https://idp.example/jwks", cached, jwksCacheTTL); err != nil {
		t.Fatal(err)
	}
	token := rotated.sign(t, validClaims(env.clock.Now()))
	if _, err := env.service.verifyIDToken(context.Background(), token, testDiscovery(), "client-1", "nonce-1", true); err != nil {
		t.Fatal(err)
	}
	if got := env.http.requestCount(); got != 1 {
		t.Fatalf("JWKS fetches = %d, want 1", got)
	}
	raw, found := env.cache.value("oidc:jwks:https://idp.example/jwks")
	if !found {
		t.Fatal("refreshed JWKS was not cached")
	}
	var refreshed jwksDocument
	if err := json.Unmarshal(raw, &refreshed); err != nil {
		t.Fatal(err)
	}
	if len(refreshed.Keys) != 1 || refreshed.Keys[0].N != rotated.jwk.N {
		t.Fatalf("cache did not receive the refreshed key")
	}
}

func TestPublicAlgorithmAllowlistIsExact(t *testing.T) {
	want := []string{"RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"}
	if len(publicIDTokenAlgorithms) != len(want) {
		t.Fatalf("allowlist = %v", publicIDTokenAlgorithms)
	}
	for index := range want {
		if publicIDTokenAlgorithms[index] != want[index] {
			t.Fatalf("allowlist = %v", publicIDTokenAlgorithms)
		}
	}
}
