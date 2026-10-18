package oidclogin

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// fetchDiscovery loads and caches the IdP discovery document.
//
// The configured URL is resolved and validated BEFORE the cache is read, then
// the required members, the issuer match and the three endpoint URLs are
// validated. An HTTP failure is the source 400; a cache read or JSON parse
// failure propagates as an infrastructure failure. A cache write failure is
// ignored because the fetched document is already usable.
func (s *Service) fetchDiscovery(ctx context.Context, config *orgOIDCConfig) (oidcDiscovery, error) {
	raw := strings.TrimSpace(config.DiscoveryURL)
	if raw == "" {
		raw = strings.TrimSuffix(config.IssuerURL, "/") + "/.well-known/openid-configuration"
	}
	validatedURL, err := s.assertAllowedOIDCURL(ctx, raw, "discovery")
	if err != nil {
		return oidcDiscovery{}, err
	}
	cacheKey := discoveryCacheKeyPrefix + validatedURL
	cached, found, err := s.cache.Get(ctx, cacheKey)
	if err != nil {
		return oidcDiscovery{}, err
	}
	if found {
		var discovery oidcDiscovery
		if err := json.Unmarshal(cached, &discovery); err != nil {
			return oidcDiscovery{}, fmt.Errorf("oidclogin: cached discovery document is invalid")
		}
		return discovery, nil
	}

	requestCtx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, validatedURL, nil)
	if err != nil {
		return oidcDiscovery{}, err
	}
	response, err := s.http.Do(request)
	if err != nil {
		return oidcDiscovery{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return oidcDiscovery{}, badRequest(discoveryLoadError)
	}
	var discovery oidcDiscovery
	if err := json.NewDecoder(response.Body).Decode(&discovery); err != nil {
		return oidcDiscovery{}, fmt.Errorf("oidclogin: discovery document could not be parsed")
	}
	if !nonEmptyString(discovery.Issuer) ||
		!nonEmptyString(discovery.AuthorizationEndpoint) ||
		!nonEmptyString(discovery.TokenEndpoint) ||
		!nonEmptyString(discovery.JWKSUri) {
		return oidcDiscovery{}, badRequest(discoveryInvalidError)
	}
	if normalizeIssuerURL(discovery.Issuer) != normalizeIssuerURL(config.IssuerURL) {
		return oidcDiscovery{}, badRequest(discoveryIssuerError)
	}
	if _, err := s.assertAllowedOIDCURL(ctx, discovery.AuthorizationEndpoint, "authorization"); err != nil {
		return oidcDiscovery{}, err
	}
	if _, err := s.assertAllowedOIDCURL(ctx, discovery.TokenEndpoint, "token"); err != nil {
		return oidcDiscovery{}, err
	}
	if _, err := s.assertAllowedOIDCURL(ctx, discovery.JWKSUri, "JWKS"); err != nil {
		return oidcDiscovery{}, err
	}

	payload, err := json.Marshal(discovery)
	if err != nil {
		return oidcDiscovery{}, err
	}
	// Best effort: a failed cache write only means the next request refetches.
	_ = s.cache.Set(ctx, cacheKey, payload, discoveryCacheTTL)
	return discovery, nil
}

// assertAllowedOIDCURL applies the source URL rules in order: parseable absolute
// URL, HTTPS, then the shared SSRF/DNS validator. The label is part of the
// contract message ("discovery", "authorization", "token", "JWKS").
func (s *Service) assertAllowedOIDCURL(ctx context.Context, raw, label string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil || !parsed.IsAbs() || parsed.Host == "" {
		return "", badRequest("OIDC " + label + " URL is invalid")
	}
	if parsed.Scheme != "https" {
		return "", badRequest("OIDC " + label + " URL must use HTTPS")
	}
	if s.validateTarget == nil {
		return "", fmt.Errorf("oidclogin: target validator is not configured")
	}
	if _, allowed := s.validateTarget(ctx, parsed.String()); !allowed {
		return "", badRequest("OIDC " + label + " URL is not allowed")
	}
	return parsed.String(), nil
}

// normalizeIssuerURL trims the value, drops query and fragment and removes all
// trailing slashes, matching the source comparison helper. A value that cannot
// be parsed still gets the trim plus trailing-slash removal.
func normalizeIssuerURL(value string) string {
	trimmed := strings.TrimSpace(value)
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return strings.TrimRight(trimmed, "/")
	}
	parsed.RawQuery = ""
	parsed.ForceQuery = false
	parsed.Fragment = ""
	return strings.TrimRight(parsed.String(), "/")
}

func nonEmptyString(value string) bool {
	return strings.TrimSpace(value) != ""
}
