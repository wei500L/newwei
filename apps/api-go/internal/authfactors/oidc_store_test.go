package authfactors

import (
	"encoding/json"
	"strings"
	"testing"
)

// rawScopes decodes a JSON array literal into the raw elements the DTO layer
// hands to the service.
func rawScopes(array string) []json.RawMessage {
	var entries []json.RawMessage
	if err := json.Unmarshal([]byte(array), &entries); err != nil {
		panic(err)
	}
	return entries
}

// oidcWriteStatements returns the OrgOidcConfig write statements the service
// emitted, in order.
func oidcWriteStatements(store *fakeStore) []string {
	out := []string{}
	for _, statement := range store.statements {
		if strings.Contains(statement, "INSERT INTO `OrgOidcConfig`") {
			out = append(out, statement)
		}
	}
	return out
}

// TestGetOidcConfigDefaults locks the eight-field default shape when no row
// exists.
func TestGetOidcConfigDefaults(t *testing.T) {
	store := newFakeStore()
	service := newTestService(store, Config{})

	config, err := service.GetOidcConfig(testContext(), "org-a")
	if err != nil {
		t.Fatal(err)
	}
	if config.Enabled || config.IssuerURL != "" || config.DiscoveryURL != "" || config.ClientID != "" {
		t.Fatalf("defaults = %+v", config)
	}
	if config.HasClientSecret {
		t.Fatal("hasClientSecret must default to false")
	}
	if len(config.Scopes) != 3 || config.Scopes[0] != "openid" || config.Scopes[1] != "email" || config.Scopes[2] != "profile" {
		t.Fatalf("scopes = %v", config.Scopes)
	}
	if config.ButtonLabel != "" || !config.RequireEmailVerified {
		t.Fatalf("defaults = %+v", config)
	}
}

// TestGetOidcConfigIsolatesOrganizations locks the tenant boundary.
func TestGetOidcConfigIsolatesOrganizations(t *testing.T) {
	store := newFakeStore()
	service := newTestService(store, Config{})
	issuer := "https://a.example.com"
	store.oidc["org-a"] = &fakeOidcConfig{
		id: "oidc-a", orgID: "org-a", enabled: true, issuerURL: issuer,
		clientID: "client-a", clientSecret: []byte(`"secret-a"`),
		scopes: []byte(`["openid"]`), requireEmailVerified: true,
	}

	configA, err := service.GetOidcConfig(testContext(), "org-a")
	if err != nil {
		t.Fatal(err)
	}
	configB, err := service.GetOidcConfig(testContext(), "org-b")
	if err != nil {
		t.Fatal(err)
	}
	if !configA.Enabled || configA.ClientID != "client-a" || len(configA.Scopes) != 1 {
		t.Fatalf("org-a = %+v", configA)
	}
	if configB.Enabled || configB.ClientID != "" {
		t.Fatalf("org-b must be isolated: %+v", configB)
	}
}

// TestUpdateOidcConfigKeepsExistingSecretAtomically locks AF4: a request without
// a non-empty secret never writes the column back, so an existing (or
// concurrently rotated) secret survives byte for byte.
func TestUpdateOidcConfigKeepsExistingSecretAtomically(t *testing.T) {
	store := newFakeStore()
	service := newTestService(store, Config{})
	store.oidc["org-a"] = &fakeOidcConfig{
		id: "oidc-a", orgID: "org-a", enabled: false, issuerURL: "https://old.example.com",
		clientID: "old-client", clientSecret: []byte(`"old-ciphertext"`),
		scopes: []byte(`["openid"]`), requireEmailVerified: true,
	}

	// A secret that was rotated by someone else after this request started.
	store.oidc["org-a"].clientSecret = []byte(`"rotated-by-someone-else"`)

	config, err := service.UpdateOidcConfig(testContext(), "org-a", oidcConfigRequest{
		Enabled:   true,
		IssuerURL: "  https://new.example.com  ",
		ClientID:  "  new-client  ",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !config.Enabled || config.IssuerURL != "https://new.example.com" || config.ClientID != "new-client" {
		t.Fatalf("config = %+v", config)
	}
	if !config.HasClientSecret {
		t.Fatal("hasClientSecret must stay true")
	}
	if string(store.oidc["org-a"].clientSecret) != `"rotated-by-someone-else"` {
		t.Fatalf("the secret must be preserved: %s", store.oidc["org-a"].clientSecret)
	}

	writes := oidcWriteStatements(store)
	if len(writes) != 1 {
		t.Fatalf("writes = %d", len(writes))
	}
	if strings.Contains(writes[0], "`clientSecret`") {
		t.Fatalf("the keep-secret write must not mention the column: %s", writes[0])
	}
	if !strings.Contains(writes[0], "`clientId`, `scopes`") {
		t.Fatalf("unexpected statement: %s", writes[0])
	}
}

// TestUpdateOidcConfigReplacesSecretWithANonEmptyValue locks the replace path
// and the empty/blank keep rule.
func TestUpdateOidcConfigReplacesSecretWithANonEmptyValue(t *testing.T) {
	store := newFakeStore()
	service := newTestService(store, Config{})
	store.oidc["org-a"] = &fakeOidcConfig{
		id: "oidc-a", orgID: "org-a", issuerURL: "https://old.example.com",
		clientID: "old-client", clientSecret: []byte(`"old-ciphertext"`),
	}

	newSecret := "  brand-new-secret  "
	config, err := service.UpdateOidcConfig(testContext(), "org-a", oidcConfigRequest{
		Enabled:      true,
		IssuerURL:    "https://new.example.com",
		ClientID:     "new-client",
		ClientSecret: &newSecret,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !config.HasClientSecret {
		t.Fatal("hasClientSecret must be true")
	}
	// No encryption key and a non-production environment: the escape hatch
	// stores the trimmed plaintext.
	if string(store.oidc["org-a"].clientSecret) != `"brand-new-secret"` {
		t.Fatalf("secret = %s", store.oidc["org-a"].clientSecret)
	}
	writes := oidcWriteStatements(store)
	if len(writes) != 1 || !strings.Contains(writes[0], "`clientId`, `clientSecret`") {
		t.Fatalf("the replace write must include the column: %v", writes)
	}

	// A later update without a secret must not revert it.
	blank := "   "
	if _, err := service.UpdateOidcConfig(testContext(), "org-a", oidcConfigRequest{
		Enabled:      true,
		IssuerURL:    "https://new.example.com",
		ClientID:     "new-client",
		ClientSecret: &blank,
	}); err != nil {
		t.Fatal(err)
	}
	if string(store.oidc["org-a"].clientSecret) != `"brand-new-secret"` {
		t.Fatalf("a blank secret must not clear or revert: %s", store.oidc["org-a"].clientSecret)
	}

	// The secret is never returned.
	config, err = service.GetOidcConfig(testContext(), "org-a")
	if err != nil {
		t.Fatal(err)
	}
	if config.ClientID != "new-client" {
		t.Fatalf("config = %+v", config)
	}
}

// TestUpdateOidcConfigCreateWithoutSecretWritesSQLNull locks the first-insert
// branch: no secret means SQL NULL, never a JSON literal null.
func TestUpdateOidcConfigCreateWithoutSecretWritesSQLNull(t *testing.T) {
	store := newFakeStore()
	service := newTestService(store, Config{})

	config, err := service.UpdateOidcConfig(testContext(), "org-a", oidcConfigRequest{
		Enabled:   false,
		IssuerURL: "https://idp.example.com",
		ClientID:  "client-a",
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.HasClientSecret {
		t.Fatal("a first insert without a secret must report hasClientSecret=false")
	}
	row, found := store.oidc["org-a"]
	if !found {
		t.Fatal("the row must be created")
	}
	if row.clientSecret != nil {
		t.Fatalf("clientSecret must be SQL NULL, got %s", row.clientSecret)
	}
	if row.scopes != nil {
		t.Fatalf("scopes must be SQL NULL, got %s", row.scopes)
	}
	if row.discoveryURL != nil || row.buttonLabel != nil {
		t.Fatalf("optional columns must be SQL NULL: %+v", row)
	}
	if !row.requireEmailVerified {
		t.Fatal("requireEmailVerified must default to true")
	}
}

// TestUpdateOidcConfigScopesAndNulls locks the scopes filter (original strings,
// duplicates and order preserved; empty result becomes SQL NULL) and the
// trimmed-or-null optional columns.
func TestUpdateOidcConfigScopesAndNulls(t *testing.T) {
	store := newFakeStore()
	service := newTestService(store, Config{})

	discovery := "  https://idp.example.com/.well-known/openid-configuration  "
	button := "  Sign in with SSO  "
	config, err := service.UpdateOidcConfig(testContext(), "org-a", oidcConfigRequest{
		Enabled:      true,
		IssuerURL:    "https://idp.example.com",
		ClientID:     "client-a",
		DiscoveryURL: &discovery,
		ButtonLabel:  &button,
		Scopes:       rawScopes(`["b", 1, "", "  ", null, "a", "b", " spaced "]`),
	})
	if err != nil {
		t.Fatal(err)
	}
	row := store.oidc["org-a"]
	if string(row.scopes) != `["b","a","b"," spaced "]` {
		t.Fatalf("scopes = %s", row.scopes)
	}
	if len(config.Scopes) != 4 || config.Scopes[3] != " spaced " {
		t.Fatalf("response scopes = %v", config.Scopes)
	}
	if row.discoveryURL == nil || *row.discoveryURL != "https://idp.example.com/.well-known/openid-configuration" {
		t.Fatalf("discoveryUrl = %v", row.discoveryURL)
	}
	if row.buttonLabel == nil || *row.buttonLabel != "Sign in with SSO" {
		t.Fatalf("buttonLabel = %v", row.buttonLabel)
	}

	// An all-blank scope list becomes SQL NULL, and the response falls back to
	// the default three.
	blank := "   "
	config, err = service.UpdateOidcConfig(testContext(), "org-a", oidcConfigRequest{
		Enabled:      true,
		IssuerURL:    "https://idp.example.com",
		ClientID:     "client-a",
		DiscoveryURL: &blank,
		ButtonLabel:  &blank,
		Scopes:       rawScopes(`["", "   ", 7]`),
	})
	if err != nil {
		t.Fatal(err)
	}
	row = store.oidc["org-a"]
	if row.scopes != nil {
		t.Fatalf("blank scopes must be SQL NULL, got %s", row.scopes)
	}
	if row.discoveryURL != nil || row.buttonLabel != nil {
		t.Fatalf("blank optional strings must be SQL NULL: %+v", row)
	}
	if len(config.Scopes) != 3 {
		t.Fatalf("response scopes = %v", config.Scopes)
	}
}

// TestUpdateOidcConfigRequireEmailVerifiedExplicitFalse locks `?? true`.
func TestUpdateOidcConfigRequireEmailVerifiedExplicitFalse(t *testing.T) {
	store := newFakeStore()
	service := newTestService(store, Config{})
	explicit := false

	config, err := service.UpdateOidcConfig(testContext(), "org-a", oidcConfigRequest{
		Enabled:              true,
		IssuerURL:            "https://idp.example.com",
		ClientID:             "client-a",
		RequireEmailVerified: &explicit,
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.RequireEmailVerified {
		t.Fatal("an explicit false must be stored")
	}
}
