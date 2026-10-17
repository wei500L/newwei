package authfactors

import (
	"context"
	"encoding/json"
	"strings"
)

// defaultOidcScopes is the fallback scope list NestJS returns when the stored
// value is absent, not an array, or contains no usable string.
func defaultOidcScopes() []string {
	return []string{"openid", "email", "profile"}
}

// GetOidcConfig returns the organization's OIDC configuration in the eight
// field public shape.
//
// The organization id always comes from the authenticated identity. There is no
// Redis cache for this configuration: every read is database authoritative. The
// client secret is never decrypted and never returned — hasClientSecret is
// Boolean(stored value), not "can it be decrypted".
func (s *Service) GetOidcConfig(ctx context.Context, orgID string) (oidcConfigResponse, error) {
	if s == nil || s.db == nil {
		return oidcConfigResponse{}, errNoDatabase
	}
	row, found, err := s.loadOidcConfig(ctx, s.db, orgID)
	if err != nil {
		return oidcConfigResponse{}, err
	}
	if !found {
		return oidcConfigResponse{
			Enabled:              false,
			IssuerURL:            "",
			DiscoveryURL:         "",
			ClientID:             "",
			HasClientSecret:      false,
			Scopes:               defaultOidcScopes(),
			ButtonLabel:          "",
			RequireEmailVerified: true,
		}, nil
	}
	return oidcResponseFromRow(row), nil
}

// oidcResponseFromRow renders one stored row. SQL NULL discoveryUrl and
// buttonLabel become empty strings; scopes follow the readScopes rule.
func oidcResponseFromRow(row oidcConfigRow) oidcConfigResponse {
	return oidcConfigResponse{
		Enabled:              row.Enabled,
		IssuerURL:            row.IssuerURL,
		DiscoveryURL:         row.DiscoveryURL.String,
		ClientID:             row.ClientID,
		HasClientSecret:      jsonBooleanTruthy(row.ClientSecret),
		Scopes:               readScopes(row.Scopes),
		ButtonLabel:          row.ButtonLabel.String,
		RequireEmailVerified: row.RequireEmailVerified,
	}
}

// readScopes reproduces OidcAuthService.readScopes: a value that is not a JSON
// array, or an array with no non-blank string entry, falls back to the default
// three scopes. Non-empty strings are kept verbatim — no trimming, no dedupe,
// no forced "openid" — while the blank test itself is applied to the trimmed
// text.
func readScopes(raw []byte) []string {
	if len(raw) == 0 {
		return defaultOidcScopes()
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return defaultOidcScopes()
	}
	scopes := make([]string, 0, len(entries))
	for _, entry := range entries {
		text, ok := jsonStringValue(entry)
		if !ok || strings.TrimSpace(text) == "" {
			continue
		}
		scopes = append(scopes, text)
	}
	if len(scopes) == 0 {
		return defaultOidcScopes()
	}
	return scopes
}

// jsonStringValue reports whether a raw JSON value is a string, returning it.
func jsonStringValue(raw json.RawMessage) (string, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if !strings.HasPrefix(trimmed, `"`) {
		return "", false
	}
	var text string
	if err := json.Unmarshal([]byte(trimmed), &text); err != nil {
		return "", false
	}
	return text, true
}

// UpdateOidcConfig persists one organization's OIDC configuration.
//
// The organization id comes from the authenticated identity only. Every column
// except clientSecret follows the original whole-row replacement semantics:
//
//   - issuerUrl and clientId are trimmed and may be empty strings;
//   - discoveryUrl and buttonLabel are trimmed and stored as SQL NULL when the
//     result is empty;
//   - requireEmailVerified defaults to true;
//   - scopes keeps every non-blank string in order, including duplicates, and
//     is stored as SQL NULL when nothing survives the filter (never a JSON
//     literal null and never an empty array).
//
// AF4: clientSecret is replaced only when the request carries a non-empty
// trimmed value. Otherwise the column is omitted from the write entirely, so
// the database preserves its current bytes atomically; a first insert with no
// secret stores SQL NULL. Nothing is read before the write and no previously
// read ciphertext is ever written back.
//
// This route performs local configuration persistence only: it never fetches a
// discovery document, a JWKS or a token endpoint, and it never relaxes the
// HTTPS/SSRF/issuer/nonce/audience checks the NestJS login path applies.
func (s *Service) UpdateOidcConfig(ctx context.Context, orgID string, params oidcConfigRequest) (oidcConfigResponse, error) {
	if s == nil || s.db == nil {
		return oidcConfigResponse{}, errNoDatabase
	}

	var secretJSON []byte
	if params.ClientSecret != nil {
		if trimmed := strings.TrimSpace(*params.ClientSecret); trimmed != "" {
			encoded, err := s.encodeSecret(ctx, trimmed)
			if err != nil {
				return oidcConfigResponse{}, err
			}
			secretJSON = encoded
		}
	}

	nextScopes := make([]string, 0, len(params.Scopes))
	for _, entry := range params.Scopes {
		text, ok := jsonStringValue(entry)
		if !ok || strings.TrimSpace(text) == "" {
			continue
		}
		nextScopes = append(nextScopes, text)
	}
	var scopesJSON []byte
	if len(nextScopes) > 0 {
		encoded, err := json.Marshal(nextScopes)
		if err != nil {
			return oidcConfigResponse{}, err
		}
		scopesJSON = encoded
	}

	requireEmailVerified := true
	if params.RequireEmailVerified != nil {
		requireEmailVerified = *params.RequireEmailVerified
	}

	write := oidcUpsertParams{
		OrgID:                orgID,
		Enabled:              params.Enabled,
		IssuerURL:            strings.TrimSpace(params.IssuerURL),
		DiscoveryURL:         nullableTrimmed(params.DiscoveryURL),
		ClientID:             strings.TrimSpace(params.ClientID),
		ClientSecret:         secretJSON,
		Scopes:               scopesJSON,
		ButtonLabel:          nullableTrimmed(params.ButtonLabel),
		RequireEmailVerified: requireEmailVerified,
	}

	// The write and the read-back share one transaction so the response always
	// describes this request's own committed row (in particular the
	// clientSecret column it deliberately did not overwrite).
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return oidcConfigResponse{}, err
	}
	if err := s.upsertOidcConfig(ctx, tx, write); err != nil {
		_ = tx.Rollback()
		return oidcConfigResponse{}, err
	}
	row, found, err := s.loadOidcConfig(ctx, tx, orgID)
	if err != nil {
		_ = tx.Rollback()
		return oidcConfigResponse{}, err
	}
	if err := tx.Commit(); err != nil {
		return oidcConfigResponse{}, err
	}
	if !found {
		return oidcConfigResponse{}, errNoDatabase
	}
	return oidcResponseFromRow(row), nil
}

// nullableTrimmed renders an optional string column: a trimmed empty result is
// SQL NULL (nil bytes), matching `value?.trim() || null`.
func nullableTrimmed(value *string) []byte {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return []byte(trimmed)
}
