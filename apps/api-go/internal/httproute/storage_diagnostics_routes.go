package httproute

import "net/http"

// StorageDiagnosticsKey is the Go handler registration key for the storage
// connection test route. It is independent of InfrastructureSettingsKey: the
// seven configuration routes follow API_GO_INFRASTRUCTURE_SETTINGS_MODE while
// the test route follows API_GO_STORAGE_DIAGNOSTICS_MODE, so either switch can
// be go on its own.
const StorageDiagnosticsKey = "/api/admin/settings/storage#test"

// WithStorageDiagnostics registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	POST /api/admin/settings/storage/test
func WithStorageDiagnostics(rules []Rule) []Rule {
	return appendExactKeyed(rules, StorageDiagnosticsKey, "/api/admin/settings/storage/test",
		http.MethodPost)
}
