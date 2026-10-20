package legacyproxy

import "net/http"

// Account-data handler keys. Each route has its own key so the two independent
// switches only register the route they own.
const (
	AvatarUploadKey   = "/api/auth#avatar-upload"
	UserDataExportKey = "/api/auth#data-export"
)

// WithAccountData takes over the two remaining identity HTTP entries when their
// own switch is go:
//
//	POST /api/auth/avatar/presigned-url  (API_GO_AVATAR_UPLOAD_MODE)
//	GET  /api/auth/data-export           (API_GO_USER_DATA_EXPORT_MODE)
//
// Both rules are exact path + single method; the helper also whitelists OPTIONS
// so the CORS preflight is answered by the Go handler. Every other method,
// longer/similar path and every other /api/auth route keeps flowing to NestJS
// through the /api/ rule. The exact prefixes are longer than the existing
// account-security and login rules, so those rules cannot shadow them.
// An empty or legacy mode adds no rule at all, which keeps the default
// deployment byte-for-byte unchanged and makes rollback a single variable.
func WithAccountData(rules []Rule, avatarMode, exportMode string) []Rule {
	if avatarMode == string(ModeGo) {
		rules = appendExactKeyed(rules, AvatarUploadKey, "/api/auth/avatar/presigned-url", http.MethodPost)
	}
	if exportMode == string(ModeGo) {
		rules = appendExactKeyed(rules, UserDataExportKey, "/api/auth/data-export", http.MethodGet)
	}
	return rules
}
