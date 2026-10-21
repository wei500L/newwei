package realtimesocket

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authn"
	"github.com/wei500L/newwei/apps/api-go/internal/authz"
	"github.com/wei500L/newwei/apps/api-go/internal/socketio"
)

// authenticator runs the handshake identity chain with the shared api-go
// authn/authz packages. The steps are split on purpose: the gateways interleave
// the per-user connection-rate bucket between token verification and the
// revocation check (newsnow.gateway.ts:141-169), so a single bundle-and-check
// authenticator (socketio.Authenticator) cannot reproduce the ordering and does
// not expose the DB permission set needed for the namespace gate.
//
// Business rejections are returned as *socketio.AuthError; any other error is an
// infrastructure failure (Redis/MySQL unavailable) and is still mapped to the
// generic Unauthorized payload by the caller, matching the NestJS catch-all.
type authenticator struct {
	verifier  *authn.Verifier
	blacklist authn.Blacklist
	authz     authz.Repository
}

func newAuthenticator(verifier *authn.Verifier, blacklist authn.Blacklist, repository authz.Repository) *authenticator {
	return &authenticator{verifier: verifier, blacklist: blacklist, authz: repository}
}

// verifyToken performs the JWT verification step ("verifyToken" in the
// gateways). A missing or malformed token is a business rejection.
func (a *authenticator) verifyToken(rawToken string) (authn.Token, error) {
	if strings.TrimSpace(rawToken) == "" {
		return authn.Token{}, &socketio.AuthError{Message: messageMissingAuthToken}
	}
	token, err := a.verifier.Verify(rawToken)
	if err != nil {
		return authn.Token{}, &socketio.AuthError{Message: messageInvalidToken}
	}
	return token, nil
}

// ensureNotRevoked performs the access-token blacklist check. A token without
// jti skips the lookup, mirroring AccessTokenBlacklistService.has semantics.
func (a *authenticator) ensureNotRevoked(ctx context.Context, jti string) error {
	if strings.TrimSpace(jti) == "" {
		return nil
	}
	revoked, err := a.blacklist.Revoked(ctx, jti)
	if err != nil {
		return fmt.Errorf("realtimesocket: blacklist query failed: %w", err)
	}
	if revoked {
		return &socketio.AuthError{Message: messageTokenRevoked}
	}
	return nil
}

// authorize re-derives the membership, user/org status and permission set from
// MySQL. It is used both at handshake time and by the B2 revalidation loop.
func (a *authenticator) authorize(ctx context.Context, userID, orgID string) (*authz.Authorization, error) {
	authorization, err := a.authz.Authorize(ctx, userID, orgID)
	if err != nil {
		var rejection *authz.Rejection
		if errors.As(err, &rejection) {
			return nil, &socketio.AuthError{Message: rejection.Message}
		}
		return nil, fmt.Errorf("realtimesocket: authorization query failed: %w", err)
	}
	return authorization, nil
}

// authRejection reports whether err is a business rejection (token/membership
// state) as opposed to an infrastructure failure. The B2 loop fails open on
// infrastructure errors and disconnects on rejections.
func authRejection(err error) (string, bool) {
	if err == nil {
		return "", false
	}
	var authErr *socketio.AuthError
	if errors.As(err, &authErr) {
		return authErr.Message, true
	}
	return "", false
}
