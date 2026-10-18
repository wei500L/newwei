// Package oidclogin owns the three public organization-SSO HTTP entries:
//
//	GET  /api/auth/sso/oidc/start
//	GET  /api/auth/oidc/callback
//	POST /api/auth/sso/handoff/exchange
//
// It is a faithful port of the NestJS OidcAuthService/controller chain. The
// authorization redirect generates the PKCE verifier, the state and the nonce
// and stores them in Redis; the callback consumes the state with an atomic
// GETDEL, validates the discovery document, exchanges the code at the IdP,
// verifies the id_token signature against JWKS and continues through the
// already migrated trusted-login core; the exchange entry consumes the encrypted
// one-time handoff row and returns the session.
//
// The package deliberately does not implement the OIDC configuration CRUD (that
// belongs to the authenticated auth-factors unit) and does not add automatic
// registration, a second session signer, a queue/worker, a lock or a retry
// platform. Redis keys, database rows, JWT validation rules, MFA challenge
// formats and the secret envelope are shared with the current NestJS
// implementation so a deployment can fall back without invalidating state.
package oidclogin
