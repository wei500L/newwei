package oidclogin

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

// jwk is one named JSON Web Key. Only public asymmetric key material is read;
// an "oct" key never produces a verification key.
type jwk struct {
	Kty    string   `json:"kty"`
	Kid    string   `json:"kid,omitempty"`
	Alg    string   `json:"alg,omitempty"`
	Use    string   `json:"use,omitempty"`
	KeyOps []string `json:"key_ops,omitempty"`
	N      string   `json:"n,omitempty"`
	E      string   `json:"e,omitempty"`
	Crv    string   `json:"crv,omitempty"`
	X      string   `json:"x,omitempty"`
	Y      string   `json:"y,omitempty"`
}

// jwksDocument is the complete named key set stored in Redis.
type jwksDocument struct {
	Keys []jwk `json:"keys"`
}

// idTokenClaims is the verified claim projection. RegisteredClaims feeds the
// standard exp/nbf/iss/aud validation; the remaining members stay raw so an
// absent value, a null and a wrongly typed value stay distinguishable.
type idTokenClaims struct {
	jwt.RegisteredClaims
	Nonce         json.RawMessage `json:"nonce"`
	Email         json.RawMessage `json:"email"`
	EmailVerified json.RawMessage `json:"email_verified"`
	Azp           json.RawMessage `json:"azp"`
	// subjectPresent records the required-claim presence separately from the
	// decoded string, so an empty subject string is still a present claim.
	subjectPresent bool
}

// UnmarshalJSON decodes the standard claims plus the raw claim projection and
// remembers whether "sub" was present. encoding/json cannot map one JSON member
// to two struct fields, so the presence check is done here.
func (c *idTokenClaims) UnmarshalJSON(data []byte) error {
	type claimsAlias idTokenClaims
	var decoded claimsAlias
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	var presence struct {
		Subject json.RawMessage `json:"sub"`
	}
	if err := json.Unmarshal(data, &presence); err != nil {
		return err
	}
	trimmed := bytes.TrimSpace(presence.Subject)
	decoded.subjectPresent = len(trimmed) > 0 && string(trimmed) != "null"
	*c = idTokenClaims(decoded)
	return nil
}

// verifyIDToken performs real signature verification against the cached or
// freshly fetched JWKS, then applies the issuer/audience/nonce/email/azp rules.
//
// Failure handling mirrors jose in the source: a signature failure OR a claim
// assertion failure triggers exactly one JWKS refetch and one retry (covering a
// just-rotated key). Any remaining failure becomes the single 401 identity
// message. There is no loop, no rotation worker and no second key source: the
// token header cannot point at a jku/x5u URL.
func (s *Service) verifyIDToken(ctx context.Context, idToken string, discovery oidcDiscovery, clientID, expectedNonce string, requireEmailVerified bool) (idTokenClaims, error) {
	jwksURL, err := s.assertAllowedOIDCURL(ctx, discovery.JWKSUri, "JWKS")
	if err != nil {
		return idTokenClaims{}, identityInvalid()
	}
	cacheKey := jwksCacheKeyPrefix + jwksURL
	var keySet jwksDocument
	cached, found, err := s.cache.Get(ctx, cacheKey)
	if err != nil {
		return idTokenClaims{}, identityInvalid()
	}
	if found {
		if err := json.Unmarshal(cached, &keySet); err != nil {
			return idTokenClaims{}, identityInvalid()
		}
	} else {
		keySet, err = s.fetchJWKS(ctx, jwksURL)
		if err != nil {
			return idTokenClaims{}, identityInvalid()
		}
		s.storeJWKSBestEffort(ctx, cacheKey, keySet)
	}

	claims, err := s.verifyWithJWKS(idToken, keySet, discovery.Issuer, clientID, expectedNonce, requireEmailVerified)
	if err == nil {
		return claims, nil
	}

	fresh, err := s.fetchJWKS(ctx, jwksURL)
	if err != nil {
		return idTokenClaims{}, identityInvalid()
	}
	s.storeJWKSBestEffort(ctx, cacheKey, fresh)
	claims, err = s.verifyWithJWKS(idToken, fresh, discovery.Issuer, clientID, expectedNonce, requireEmailVerified)
	if err != nil {
		return idTokenClaims{}, identityInvalid()
	}
	return claims, nil
}

func (s *Service) storeJWKSBestEffort(ctx context.Context, cacheKey string, keySet jwksDocument) {
	payload, err := json.Marshal(keySet)
	if err != nil {
		return
	}
	_ = s.cache.Set(ctx, cacheKey, payload, jwksCacheTTL)
}

func (s *Service) verifyWithJWKS(idToken string, keySet jwksDocument, issuer, clientID, expectedNonce string, requireEmailVerified bool) (idTokenClaims, error) {
	claims := idTokenClaims{}
	token, err := jwt.ParseWithClaims(idToken, &claims, func(token *jwt.Token) (any, error) {
		algorithm := token.Method.Alg()
		if !containsString(publicIDTokenAlgorithms, algorithm) {
			return nil, fmt.Errorf("oidclogin: token algorithm is not allowed")
		}
		kid, _ := token.Header["kid"].(string)
		return selectSigningKey(keySet, kid, algorithm)
	},
		jwt.WithValidMethods(publicIDTokenAlgorithms),
		jwt.WithIssuer(issuer),
		jwt.WithAudience(clientID),
		jwt.WithExpirationRequired(),
		jwt.WithLeeway(clockTolerance),
		jwt.WithTimeFunc(s.now),
	)
	if err != nil || token == nil || !token.Valid {
		return idTokenClaims{}, fmt.Errorf("oidclogin: token verification failed")
	}
	if err := validateIDTokenClaims(claims, clientID, expectedNonce, requireEmailVerified); err != nil {
		return idTokenClaims{}, err
	}
	return claims, nil
}

// validateIDTokenClaims mirrors assertValidVerifiedClaims. exp/sub are required
// (sub must be non-empty to be a usable subject), nonce must equal the state
// value, email must be a non-empty string, and email_verified must be the JSON
// boolean true when required. An azp, if present, must be a clientId string; a
// multi-audience token must carry azp=clientId.
func validateIDTokenClaims(claims idTokenClaims, clientID, expectedNonce string, requireEmailVerified bool) error {
	if !claims.subjectPresent {
		return identityInvalid()
	}
	nonce, ok := rawJSONString(claims.Nonce)
	if !ok || nonce != expectedNonce {
		return identityInvalid()
	}
	email, ok := rawJSONString(claims.Email)
	if !ok || strings.TrimSpace(email) == "" {
		return identityInvalid()
	}
	if requireEmailVerified {
		verified, ok := rawJSONBool(claims.EmailVerified)
		if !ok || !verified {
			return identityInvalid()
		}
	}
	audienceCount := len(claims.Audience)
	azp := ""
	if len(claims.Azp) > 0 {
		value, ok := rawJSONString(claims.Azp)
		if !ok || value != clientID {
			return identityInvalid()
		}
		azp = value
	}
	if audienceCount > 1 && azp != clientID {
		return identityInvalid()
	}
	return nil
}

// selectSigningKey applies the JWK selection semantics: the header kid selects a
// key when present, use must be "sig" when present, key_ops must contain
// "verify" when present, a JWK alg must match the header algorithm, and the key
// type must match the algorithm family.
func selectSigningKey(keySet jwksDocument, kid, algorithm string) (any, error) {
	for _, key := range keySet.Keys {
		if kid != "" && key.Kid != kid {
			continue
		}
		if key.Use != "" && key.Use != "sig" {
			continue
		}
		if len(key.KeyOps) > 0 && !containsString(key.KeyOps, "verify") {
			continue
		}
		if key.Alg != "" && key.Alg != algorithm {
			continue
		}
		if !algorithmMatchesKeyType(algorithm, key.Kty) {
			continue
		}
		publicKey, err := key.publicKey(algorithm)
		if err != nil {
			continue
		}
		return publicKey, nil
	}
	return nil, fmt.Errorf("oidclogin: no matching JWKS key")
}

func algorithmMatchesKeyType(algorithm, keyType string) bool {
	switch algorithm {
	case "RS256", "RS384", "RS512", "PS256", "PS384", "PS512":
		return keyType == "RSA"
	case "ES256", "ES384", "ES512":
		return keyType == "EC"
	case "EdDSA":
		return keyType == "OKP"
	default:
		return false
	}
}

func (k jwk) publicKey(algorithm string) (any, error) {
	switch k.Kty {
	case "RSA":
		modulus, err := base64.RawURLEncoding.DecodeString(k.N)
		if err != nil || len(modulus) == 0 {
			return nil, fmt.Errorf("oidclogin: invalid RSA modulus")
		}
		exponentBytes, err := base64.RawURLEncoding.DecodeString(k.E)
		if err != nil || len(exponentBytes) == 0 {
			return nil, fmt.Errorf("oidclogin: invalid RSA exponent")
		}
		exponent := new(big.Int).SetBytes(exponentBytes)
		if !exponent.IsInt64() || exponent.Int64() <= 0 || exponent.Int64() > int64(^uint(0)>>1) {
			return nil, fmt.Errorf("oidclogin: invalid RSA exponent")
		}
		return &rsa.PublicKey{N: new(big.Int).SetBytes(modulus), E: int(exponent.Int64())}, nil
	case "EC":
		curve, err := curveForAlgorithm(algorithm)
		if err != nil {
			return nil, err
		}
		xBytes, err := base64.RawURLEncoding.DecodeString(k.X)
		if err != nil {
			return nil, fmt.Errorf("oidclogin: invalid EC x")
		}
		yBytes, err := base64.RawURLEncoding.DecodeString(k.Y)
		if err != nil {
			return nil, fmt.Errorf("oidclogin: invalid EC y")
		}
		x := new(big.Int).SetBytes(xBytes)
		y := new(big.Int).SetBytes(yBytes)
		if !curve.IsOnCurve(x, y) {
			return nil, fmt.Errorf("oidclogin: invalid EC point")
		}
		return &ecdsa.PublicKey{Curve: curve, X: x, Y: y}, nil
	case "OKP":
		if algorithm != "EdDSA" || k.Crv != "Ed25519" {
			return nil, fmt.Errorf("oidclogin: invalid OKP key")
		}
		raw, err := base64.RawURLEncoding.DecodeString(k.X)
		if err != nil || len(raw) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("oidclogin: invalid Ed25519 key")
		}
		return ed25519.PublicKey(raw), nil
	default:
		return nil, fmt.Errorf("oidclogin: unsupported key type")
	}
}

func curveForAlgorithm(algorithm string) (elliptic.Curve, error) {
	switch algorithm {
	case "ES256":
		return elliptic.P256(), nil
	case "ES384":
		return elliptic.P384(), nil
	case "ES512":
		return elliptic.P521(), nil
	default:
		return nil, fmt.Errorf("oidclogin: invalid EC algorithm")
	}
}

// fetchJWKS performs one GET with the source 8 second timeout. A non-2xx
// response is an error, and the response must carry a keys array (an empty array
// is structurally valid; verification then fails on the missing key).
func (s *Service) fetchJWKS(ctx context.Context, jwksURL string) (jwksDocument, error) {
	requestCtx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, jwksURL, nil)
	if err != nil {
		return jwksDocument{}, err
	}
	response, err := s.http.Do(request)
	if err != nil {
		return jwksDocument{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return jwksDocument{}, fmt.Errorf("Failed to load OIDC JWKS")
	}
	var envelope struct {
		Keys json.RawMessage `json:"keys"`
	}
	if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil {
		return jwksDocument{}, fmt.Errorf("OIDC JWKS is invalid")
	}
	if !isJSONArray(envelope.Keys) {
		return jwksDocument{}, fmt.Errorf("OIDC JWKS is invalid")
	}
	var document jwksDocument
	if err := json.Unmarshal(envelope.Keys, &document.Keys); err != nil {
		return jwksDocument{}, fmt.Errorf("OIDC JWKS is invalid")
	}
	if document.Keys == nil {
		document.Keys = []jwk{}
	}
	return document, nil
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func rawJSONString(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return "", false
	}
	var value string
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return "", false
	}
	return value, true
}

func rawJSONBool(raw json.RawMessage) (bool, bool) {
	trimmed := bytes.TrimSpace(raw)
	if string(trimmed) == "true" {
		return true, true
	}
	if string(trimmed) == "false" {
		return false, true
	}
	return false, false
}

// verifiedEmail returns the already validated email string.
func (claims idTokenClaims) verifiedEmail() string {
	email, _ := rawJSONString(claims.Email)
	return email
}
