package accountsecurity

import (
	"encoding/json"
	"time"
)

// encodedResponse is a response body that renders itself as JSON. Using a named
// interface keeps the responder free of any untyped parameter.
type encodedResponse interface {
	encodeJSON() ([]byte, error)
}

// profileResponse is the human AuthenticatedUser JSON shape. Field declaration
// order is the serialization order NestJS produces for buildAuthenticatedUser
// and the field set is complete: emailVerified/lastLoginAt/pendingEmail/
// avatarUrl/primaryRoleId/planTier/subscriptionStatus are always present (as
// null when absent), while the two JWT metadata fields follow JwtStrategy's
// `...profile, accessTokenId, accessTokenExpiresAt` spread.
//
// The base profile layer deliberately carries no JWT metadata. GET /me layers
// the verified accessTokenId/accessTokenExpiresAt on top; PATCH /profile
// returns the base profile without them, exactly like NestJS.
type profileResponse struct {
	ID                    string   `json:"id"`
	Email                 string   `json:"email"`
	EmailVerified         *string  `json:"emailVerified"`
	LastLoginAt           *string  `json:"lastLoginAt"`
	PendingEmail          *string  `json:"pendingEmail"`
	FirstName             string   `json:"firstName"`
	LastName              string   `json:"lastName"`
	AvatarURL             *string  `json:"avatarUrl"`
	IsActive              bool     `json:"isActive"`
	OrgID                 string   `json:"orgId"`
	PrimaryRoleID         *string  `json:"primaryRoleId"`
	RoleIDs               []string `json:"roleIds"`
	Permissions           []string `json:"permissions"`
	PlanTier              *string  `json:"planTier"`
	SubscriptionStatus    *string  `json:"subscriptionStatus"`
	GlobalRoles           []string `json:"globalRoles"`
	MFAEnabled            bool     `json:"mfaEnabled"`
	MFARequired           bool     `json:"mfaRequired"`
	MFAEnrollmentRequired bool     `json:"mfaEnrollmentRequired"`
	AccessTokenID         string   `json:"accessTokenId,omitempty"`
	AccessTokenExpiresAt  *int64   `json:"accessTokenExpiresAt,omitempty"`
}

// encodeJSON renders the human profile.
func (p profileResponse) encodeJSON() ([]byte, error) { return json.Marshal(p) }

// machineProfileResponse is the machine identity shape produced by
// MachineTokenService.validate. Its member order differs from the human profile
// (orgId/primaryRoleId/roleIds/permissions come before the name fields), so it
// is modelled separately instead of reusing profileResponse.
type machineProfileResponse struct {
	ID                    string   `json:"id"`
	Email                 string   `json:"email"`
	EmailVerified         *string  `json:"emailVerified"`
	LastLoginAt           *string  `json:"lastLoginAt"`
	PendingEmail          *string  `json:"pendingEmail"`
	OrgID                 string   `json:"orgId"`
	PrimaryRoleID         *string  `json:"primaryRoleId"`
	RoleIDs               []string `json:"roleIds"`
	Permissions           []string `json:"permissions"`
	FirstName             string   `json:"firstName"`
	LastName              string   `json:"lastName"`
	AvatarURL             *string  `json:"avatarUrl"`
	IsActive              bool     `json:"isActive"`
	PlanTier              *string  `json:"planTier"`
	SubscriptionStatus    *string  `json:"subscriptionStatus"`
	GlobalRoles           []string `json:"globalRoles"`
	MFAEnabled            bool     `json:"mfaEnabled"`
	MFARequired           bool     `json:"mfaRequired"`
	MFAEnrollmentRequired bool     `json:"mfaEnrollmentRequired"`
}

// encodeJSON renders the machine profile.
func (p machineProfileResponse) encodeJSON() ([]byte, error) { return json.Marshal(p) }

// machineTokenCreateResult is the create/rotate response shape:
// {id,name,token,permissions,expiresAt}. The plaintext token appears exactly
// once, here, and is never stored.
type machineTokenCreateResult struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Token       string   `json:"token"`
	Permissions []string `json:"permissions"`
	ExpiresAt   *string  `json:"expiresAt"`
}

// encodeJSON renders the create/rotate response.
func (r machineTokenCreateResult) encodeJSON() ([]byte, error) { return json.Marshal(r) }

// machineTokenListItem is one list row. `permissions` is the stored JSON value
// emitted as-is (history may contain non-array or non-string entries); only the
// authentication path narrows it to strings, and only create/rotate apply the
// create-time whitelist.
type machineTokenListItem struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Permissions json.RawMessage `json:"permissions"`
	ExpiresAt   *string         `json:"expiresAt"`
	LastUsedAt  *string         `json:"lastUsedAt"`
	RevokedAt   *string         `json:"revokedAt"`
	CreatedAt   string          `json:"createdAt"`
}

// machineTokenListResponse is the array NestJS returns (empty array when the
// organization has no tokens).
type machineTokenListResponse []machineTokenListItem

// encodeJSON renders the list, never emitting a JSON null for an empty result.
func (l machineTokenListResponse) encodeJSON() ([]byte, error) {
	if l == nil {
		return []byte("[]"), nil
	}
	return json.Marshal(l)
}

// okResponse is the {ok:true} body of logout and change-password.
type okResponse struct {
	OK bool `json:"ok"`
}

// encodeJSON renders {ok:true}.
func (o okResponse) encodeJSON() ([]byte, error) { return json.Marshal(o) }

// revokeResponse is the {revoked:true} body of DELETE machine-tokens/:id.
type revokeResponse struct {
	Revoked bool `json:"revoked"`
}

// encodeJSON renders {revoked:true}.
func (r revokeResponse) encodeJSON() ([]byte, error) { return json.Marshal(r) }

// membershipRow is one candidate membership for pickMembership.
type membershipRow struct {
	MembershipID       string
	OrgID              string
	Active             bool
	RoleID             string
	OrgSlug            string
	OrgActive          bool
	PlanTier           *string
	SubscriptionStatus *string
	CreatedAt          time.Time
}

// userRow is the subset of User the profile builder needs.
type userRow struct {
	ID            string
	Email         string
	EmailVerified *time.Time
	LastLoginAt   *time.Time
	PendingEmail  *string
	FirstName     string
	LastName      string
	AvatarURL     *string
	IsActive      bool
}

// machineTokenRow is the full machine-token row used by the authentication path
// and by create/rotate checks.
type machineTokenRow struct {
	ID                 string
	OrgID              string
	Name               string
	Permissions        json.RawMessage
	CreatedByID        *string
	ExpiresAt          *time.Time
	RevokedAt          *time.Time
	CreatedAt          time.Time
	LastUsedAt         *time.Time
	OrgActive          bool
	PlanTier           *string
	SubscriptionStatus *string
}
