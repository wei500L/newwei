package legacyproxy

import "net/http"

// Account-data handler keys. Each route has its own key so the two independent
// handlers only receive the route they own.
const (
	AvatarUploadKey   = "/api/auth#avatar-upload"
	UserDataExportKey = "/api/auth#data-export"
)

// WithAccountData appends the two remaining identity HTTP entries:
//
//	POST /api/auth/avatar/presigned-url  (AvatarUploadKey)
//	GET  /api/auth/data-export           (UserDataExportKey)
//
// Both rules are exact path + single method; the helper also whitelists OPTIONS
// so the CORS preflight is answered by the Go handler. Every other method,
// longer/similar path and every other /api/auth route falls through to the
// unmatched-route 404. The exact prefixes are longer than the existing
// account-security and login rules, so those rules cannot shadow them.
func WithAccountData(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, AvatarUploadKey, "/api/auth/avatar/presigned-url", http.MethodPost)
	return appendExactKeyed(rules, UserDataExportKey, "/api/auth/data-export", http.MethodGet)
}
