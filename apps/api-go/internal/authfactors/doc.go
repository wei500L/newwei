// Package authfactors serves the seven authenticated MFA management and
// organization OIDC configuration HTTP routes migrated from NestJS by this
// batch (API_GO_AUTH_FACTORS_MODE):
//
//	GET  /api/auth/mfa
//	POST /api/auth/mfa/enroll
//	POST /api/auth/mfa/verify-enroll
//	POST /api/auth/mfa/disable
//	POST /api/auth/mfa/recovery/rotate
//	GET  /api/auth/admin/oidc-config
//	PUT  /api/auth/admin/oidc-config
//
// Everything else under /api/auth stays on NestJS: login, refresh, logout,
// profile, change-password, machine-token management, the public MFA login and
// forced-enrollment challenges, and the whole OIDC start/callback/handoff
// login chain. This package never contacts an identity provider, never fetches
// a discovery document, JWKS or token endpoint, and never signs an access or
// refresh token.
//
// # Trust model
//
// Humans authenticate through the shared authhttp chain (JWT signature,
// issuer/audience/expiry, Redis access-token blacklist, and MySQL
// membership/permission re-derivation). Machine callers authenticate through
// the established mtk_ database lookup: SHA-256 of the full token against
// MachineAccessToken.tokenHash, joined to Org.isActive, rejecting revoked or
// expired rows. Permission sets and org ids always come from the database and
// never from JWT claims.
//
// GET /api/auth/mfa deliberately keeps returning the empty factor state for a
// machine identity (a machine id is not a User row, so it simply has no
// factor). The four MFA write routes require a real human User and answer 403
// for machine identities. OIDC configuration is a tenant setting, so it is
// gated by the settings.manage permission of the caller's own organization and
// is never given a global platform-admin gate.
//
// # Data model
//
// The package reads and writes exactly these Prisma models: User, Org,
// Membership, MachineAccessToken, UserTotpFactor, UserRecoveryCode,
// OrgOidcConfig and SystemSetting. It never changes the schema, never adds a
// table, and never touches AuthChallenge (the public login challenges stay on
// NestJS).
package authfactors
