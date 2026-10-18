// Package accountsecurity implements the Go takeover of the eight authenticated
// account, session and machine-token HTTP routes:
//
//	GET    /api/auth/me
//	PATCH  /api/auth/profile
//	POST   /api/auth/change-password
//	POST   /api/auth/logout
//	GET    /api/auth/machine-tokens
//	POST   /api/auth/machine-tokens
//	DELETE /api/auth/machine-tokens/:tokenId
//	POST   /api/auth/machine-tokens/:tokenId/rotate
//
// The package is enabled by API_GO_ACCOUNT_SECURITY_MODE=go and is a no-op for
// the default legacy mode. It reproduces the NestJS contract exactly:
//
//   - human callers go through the same chain as authhttp (HS256/iss/aud/exp
//     verification against the NestJS secret, Redis access-token blacklist,
//     MySQL membership/permission re-derivation). JWT permissions are never
//     trusted;
//   - machine callers present an mtk_ token which is looked up by the SHA-256
//     of the complete token. Revoked, expired and inactive-org tokens are 401
//     "Invalid machine token"; the permissions come from the stored row and are
//     never re-filtered through the create-time whitelist (historical tokens
//     may legitimately hold settings.manage);
//   - login, refresh, e-mail verification, password reset, MFA, OIDC,
//     invitations, registration review, avatar upload signing and personal data
//     export are NOT migrated and keep flowing to NestJS;
//   - no new access/refresh tokens are issued, the JWT format, refresh rotation
//     protocol and MFA policy are unchanged, and no auth schema migration is
//     added.
//
// Data access uses the shared MySQL pool and the shared Redis client. Every SQL
// statement is parameterized, every database/Redis call receives the request
// context, and no password, hash, token or key ever reaches the logs or an
// error response.
package accountsecurity
