package authlogin

import (
	"context"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/accountsecurity"
)

// This file exposes the already migrated trusted-login core to the OIDC login
// unit without duplicating any of it. The entry point below calls the same
// completeTrustedLogin used by password and email-code login, so the user and
// membership reload, the MFA decision, the session issue, the lastLoginAt
// update, the best-effort audit and the organization projection all keep their
// single implementation.
//
// Only named result types are exported. The OIDC handler must be able to tell a
// completed session from an mfa_login challenge and from a forced mfa_enrollment
// challenge, but it must not be able to construct or mutate the internal
// outcome interface.

// TrustedLoginSession is a completed trusted login: the same payload the login
// routes return, plus the two opaque tokens that are later encrypted into the
// one-time handoff row.
type TrustedLoginSession struct {
	User          accountsecurity.LoginProfile
	AccessToken   string
	RefreshToken  string
	Organizations []accountsecurity.LoginOrganization
	ExpiresIn     int
}

// TrustedLoginMFA is a login that must present an existing second factor. No
// access or refresh token exists at this point.
type TrustedLoginMFA struct {
	User               accountsecurity.LoginProfile
	Organizations      []accountsecurity.LoginOrganization
	AuthChallengeID    string
	ChallengeExpiresAt string
}

// TrustedLoginEnrollment is a login that must bind a second factor first. No
// access or refresh token exists at this point.
type TrustedLoginEnrollment struct {
	User                  accountsecurity.LoginProfile
	Organizations         []accountsecurity.LoginOrganization
	EnrollmentChallengeID string
	ChallengeExpiresAt    string
}

// TrustedLoginResult carries exactly one of the three outcomes. The nil members
// keep the branches explicit at the call site.
type TrustedLoginResult struct {
	Session    *TrustedLoginSession
	MFA        *TrustedLoginMFA
	Enrollment *TrustedLoginEnrollment
}

// BeginTrustedLogin is the trusted entry point for an already authenticated
// external identity. The caller has verified the identity token and resolved
// the existing user; everything after that (reloading User.isActive, the
// organization membership and its state, roles and permissions, the local MFA
// policy and the session issue) runs through completeTrustedLogin with
// skipMfa=false.
func (s *Service) BeginTrustedLogin(ctx context.Context, userID, orgID string, ipAddress, userAgent *string, action string) (TrustedLoginResult, error) {
	outcome, err := s.completeTrustedLogin(ctx, userID, orgID, ipAddress, userAgent, action, false)
	if err != nil {
		return TrustedLoginResult{}, err
	}
	switch result := outcome.(type) {
	case sessionResult:
		return TrustedLoginResult{Session: &TrustedLoginSession{
			User:          result.User,
			AccessToken:   result.AccessToken,
			RefreshToken:  result.RefreshToken,
			Organizations: result.Organizations,
			ExpiresIn:     result.ExpiresIn,
		}}, nil
	case mfaChallengeResult:
		return TrustedLoginResult{MFA: &TrustedLoginMFA{
			User:               result.User,
			Organizations:      result.Organizations,
			AuthChallengeID:    result.AuthChallengeID,
			ChallengeExpiresAt: result.ChallengeExpiresAt,
		}}, nil
	case enrollmentChallengeResult:
		return TrustedLoginResult{Enrollment: &TrustedLoginEnrollment{
			User:                  result.User,
			Organizations:         result.Organizations,
			EnrollmentChallengeID: result.EnrollmentChallengeID,
			ChallengeExpiresAt:    result.ChallengeExpiresAt,
		}}, nil
	default:
		return TrustedLoginResult{}, unauthorized(invalidCredentialsMessage)
	}
}

// ClientIP exposes the shared TRUST_PROXY-aware client address resolution to
// the OIDC redirect handler. It keeps one implementation of the forwarded-header
// rules: without TRUST_PROXY the socket address wins and X-Forwarded-For is
// ignored.
func ClientIP(r *http.Request, trustProxy string) *string {
	return clientIP(r, trustProxy)
}
