package legacyproxy

import "net/http"

// StorageDiagnosticsKey is the Go handler registration key for the storage
// connection test route. It is independent of InfrastructureSettingsKey: the
// seven configuration routes follow API_GO_INFRASTRUCTURE_SETTINGS_MODE while
// the test route follows API_GO_STORAGE_DIAGNOSTICS_MODE, so either switch can
// be go on its own.
const StorageDiagnosticsKey = "/api/admin/settings/storage#test"

// WithStorageDiagnostics takes over exactly one route when mode is go:
//
//	POST /api/admin/settings/storage/test
//
// The rule is an exact path with an explicit method whitelist (plus the shared
// OPTIONS whitelist for CORS preflight), so GET/HEAD/PATCH/DELETE on the path,
// the trailing-slash form and every longer path keep falling back to the
// legacy /api/ rule. An empty or legacy mode adds nothing, so the default
// deployment is unchanged and rollback only flips this one switch.
//
// The route intentionally stays off WithInfrastructureSettings: enabling the
// seven configuration routes must not silently enable the real S3 calls, and
// enabling the diagnostics must not take over any configuration route.
func WithStorageDiagnostics(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
	return appendExactKeyed(rules, StorageDiagnosticsKey, "/api/admin/settings/storage/test",
		http.MethodPost)
}
