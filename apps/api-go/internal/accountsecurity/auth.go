package accountsecurity

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// machineIdentity carries the machine-token row fields the machine profile
// response needs. Permissions keep the stored string entries unchanged (never
// re-filtered through the create-time whitelist).
type machineIdentity struct {
	TokenID            string
	Name               string
	PlanTier           *string
	SubscriptionStatus *string
	Permissions        []string
}

// Identity is the caller context after the full authentication chain.
type Identity struct {
	UserID string
	// OrgID is the membership's organization id (the authoritative tenant).
	OrgID string
	// ClaimOrgID is the raw `orgId` access-token claim. It is the dimension the
	// shared profile cache key uses, so Go and NestJS address the same entry
	// even when the token was issued with an organization slug.
	ClaimOrgID  string
	Permissions map[string]bool
	IsMachine   bool
	// Machine is set only for mtk_ identities.
	Machine *machineIdentity
	// AccessTokenID is the verified jti (empty for machine identities).
	AccessTokenID string
	// AccessTokenExpiresAt is the verified exp instant (zero when absent).
	AccessTokenExpiresAt time.Time
}

// HasPermission reports whether the derived permission set contains name.
func (id *Identity) HasPermission(name string) bool {
	if id == nil || id.Permissions == nil {
		return false
	}
	return id.Permissions[name]
}

// Authenticator resolves the caller identity for every migrated route. It
// reuses the shared authhttp chain for human JWTs (verification, Redis
// revocation, MySQL membership re-derivation) plus the shared machine resolver
// for mtk_ tokens, and keeps the verified jti/exp/claim metadata this unit's
// profile, logout and change-password routes depend on.
type Authenticator struct {
	chain    *authhttp.Authenticator
	machines *authhttp.MachineResolver
}

// NewAuthenticator wires the shared chain and its machine resolver.
func NewAuthenticator(chain *authhttp.Authenticator) *Authenticator {
	return &Authenticator{chain: chain, machines: chain.Machines()}
}

// writeAuthFailure maps a shared auth failure onto the contract error.
func writeAuthFailure(w http.ResponseWriter, r *http.Request, failure *authhttp.AuthFailure) {
	switch {
	case failure.Status == http.StatusUnauthorized:
		authhttp.WriteUnauthorized(w, r, failure.Message)
	case failure.Status == http.StatusInternalServerError:
		authhttp.WriteRedisFailure(w, r)
	default:
		authhttp.WriteDatabaseFailure(w, r)
	}
}

// Authorize runs the full authentication and permission chain.
//
// requiredPermission is the single permission the route demands; an empty string
// means AllowAuthenticated (no permission gate), which is what GET /me,
// PATCH /profile, POST /change-password and POST /logout use. Failure order
// matches NestJS: authentication (401) before permission (403), fail-closed on
// Redis/MySQL errors. The caller must return immediately when nil is returned.
func (a *Authenticator) Authorize(w http.ResponseWriter, r *http.Request, requiredPermission string) *Identity {
	raw := rawBearer(r)
	if raw == "" {
		authhttp.WriteUnauthorized(w, r, "")
		return nil
	}

	var identity *Identity
	if strings.HasPrefix(raw, "mtk_") {
		resolved, err := a.authorizeMachine(r.Context(), raw)
		if err != nil {
			writeServiceError(w, r, err)
			return nil
		}
		identity = resolved
	} else {
		if a == nil || a.chain == nil {
			authhttp.WriteDatabaseFailure(w, r)
			return nil
		}
		resolved, failure := a.authorizeHuman(r)
		if failure != nil {
			writeAuthFailure(w, r, failure)
			return nil
		}
		identity = resolved
	}

	if requiredPermission != "" && !identity.HasPermission(requiredPermission) {
		authhttp.WriteForbidden(w, r, []string{requiredPermission})
		return nil
	}
	return identity
}

// authorizeHuman runs the shared human chain and copies the verified token
// metadata (raw claim orgId, jti, exp) the profile/logout routes need.
func (a *Authenticator) authorizeHuman(r *http.Request) (*Identity, *authhttp.AuthFailure) {
	human, failure := a.chain.Identify(r)
	if failure != nil {
		return nil, failure
	}
	return &Identity{
		UserID:               human.UserID,
		OrgID:                human.OrgID,
		ClaimOrgID:           human.ClaimOrgID(),
		Permissions:          human.PermissionSet(),
		AccessTokenID:        human.TokenID(),
		AccessTokenExpiresAt: human.TokenExpiresAt(),
	}, nil
}

// authorizeMachine resolves an mtk_ token through the shared machine resolver
// and builds the rich machine identity the profile response needs. It keeps the
// stored permissions unchanged and the orgId from the token row.
func (a *Authenticator) authorizeMachine(ctx context.Context, token string) (*Identity, error) {
	if a == nil || a.machines == nil {
		return nil, errNoDatabase
	}
	row, err := a.machines.LookupProfile(ctx, token)
	if errors.Is(err, authhttp.ErrInvalidMachineToken) {
		return nil, unauthorized("Invalid machine token")
	}
	if err != nil {
		return nil, dbWrap(err)
	}
	// best-effort lastUsedAt: a failure must not turn a valid request into a 500.
	a.machines.Touch(ctx, row.ID)

	permissions := machinePermissionStrings(row.PermissionsRaw)
	permissionSet := make(map[string]bool, len(permissions))
	for _, permission := range permissions {
		permissionSet[permission] = true
	}
	return &Identity{
		UserID:      machineActorPrefix + row.ID,
		OrgID:       row.OrgID,
		ClaimOrgID:  row.OrgID,
		Permissions: permissionSet,
		IsMachine:   true,
		Machine: &machineIdentity{
			TokenID:            row.ID,
			Name:               row.Name,
			PlanTier:           row.PlanTier,
			SubscriptionStatus: row.SubscriptionStatus,
			Permissions:        permissions,
		},
	}, nil
}

// machinePermissionStrings keeps only the string entries of the stored
// permissions JSON array, exactly like MachineTokenService.validate. It never
// applies the create-time whitelist: historical tokens keep historical
// permissions.
func machinePermissionStrings(raw []byte) []string {
	if len(raw) == 0 {
		return []string{}
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return []string{}
	}
	permissions := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := jsonString(item); ok {
			permissions = append(permissions, text)
		}
	}
	return permissions
}

// rawBearer extracts the raw Authorization bearer value without filtering mtk_
// tokens (this package handles them itself).
func rawBearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if len(header) < 7 || !strings.EqualFold(header[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
}
