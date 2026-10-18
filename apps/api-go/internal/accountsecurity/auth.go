package accountsecurity

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/authn"
	"github.com/wei500L/newwei/apps/api-go/internal/authz"
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
	// AccessTokenID is the verified jti (empty for machine identities and for
	// legacy tokens without jti).
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
// reproduces the JwtAuthGuard + PermissionsGuard chain and adds the mtk_ machine
// path, which authn.ExtractBearerToken deliberately rejects for the other
// domains.
type Authenticator struct {
	verifier  *authn.Verifier
	blacklist authn.Blacklist
	authorize authz.Repository
	db        *sql.DB
}

// NewAuthenticator wires the human chain and the machine-token lookup pool.
func NewAuthenticator(verifier *authn.Verifier, blacklist authn.Blacklist, repository authz.Repository, db *sql.DB) *Authenticator {
	return &Authenticator{verifier: verifier, blacklist: blacklist, authorize: repository, db: db}
}

// authFailure is an authentication/authorization failure with the HTTP status
// the caller must write.
type authFailure struct {
	status  int
	message string
}

// writeAuthFailure maps the failure onto the contract error.
func writeAuthFailure(w http.ResponseWriter, r *http.Request, failure *authFailure) {
	switch {
	case failure.status == http.StatusUnauthorized:
		authhttp.WriteUnauthorized(w, r, failure.message)
	case failure.status == http.StatusInternalServerError:
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
		if a == nil || a.verifier == nil || a.blacklist == nil || a.authorize == nil {
			authhttp.WriteDatabaseFailure(w, r)
			return nil
		}
		resolved, failure := a.authorizeHuman(r, raw)
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

// authorizeHuman reproduces authhttp.Authenticate while keeping the verified
// jti/exp metadata on the identity.
func (a *Authenticator) authorizeHuman(r *http.Request, raw string) (*Identity, *authFailure) {
	token, err := a.verifier.Verify(raw)
	if err != nil {
		// Only the server-side log sees the reason; the response is the
		// uniform 401 "Unauthorized" passport produces.
		log.Printf("accountsecurity: token rejected: %v", err)
		return nil, &authFailure{status: http.StatusUnauthorized}
	}

	if token.JTI != "" {
		revoked, err := a.blacklist.Revoked(r.Context(), token.JTI)
		if err != nil {
			log.Printf("accountsecurity: blacklist query failed: %v", err)
			return nil, &authFailure{status: http.StatusInternalServerError}
		}
		if revoked {
			return nil, &authFailure{status: http.StatusUnauthorized, message: "Access token revoked"}
		}
	}

	authorization, err := a.authorize.Authorize(r.Context(), token.Subject, token.OrgID)
	if err != nil {
		var rejection *authz.Rejection
		if errors.As(err, &rejection) {
			log.Printf("accountsecurity: authz rejected: %s", rejection.Message)
			return nil, &authFailure{status: http.StatusUnauthorized, message: rejection.Message}
		}
		log.Printf("accountsecurity: authz database error: %v", err)
		return nil, &authFailure{status: http.StatusServiceUnavailable}
	}

	return &Identity{
		UserID:               authorization.UserID,
		OrgID:                authorization.OrgID,
		ClaimOrgID:           token.OrgID,
		Permissions:          authorization.Permissions,
		AccessTokenID:        token.JTI,
		AccessTokenExpiresAt: token.ExpiresAt,
	}, nil
}

// authorizeMachine mirrors MachineTokenService.validate: SHA-256 of the complete
// token (never the mtk_ prefix), revoked/expired/inactive-org rejection with the
// exact 401 message, a best-effort lastUsedAt refresh, and permissions taken
// from the stored row.
func (a *Authenticator) authorizeMachine(ctx context.Context, token string) (*Identity, error) {
	if a == nil || a.db == nil {
		return nil, errNoDatabase
	}
	sum := sha256.Sum256([]byte(token))
	tokenHash := hex.EncodeToString(sum[:])

	var row machineTokenRow
	var rawPermissions []byte
	var expiresAt, revokedAt sql.NullTime
	var planTier, subscriptionStatus sql.NullString
	err := a.db.QueryRowContext(ctx,
		"SELECT `t`.`id`, `t`.`orgId`, `t`.`name`, `t`.`permissions`, `t`.`createdById`, "+
			"`t`.`expiresAt`, `t`.`revokedAt`, `o`.`isActive`, `o`.`planTier`, `o`.`subscriptionStatus` "+
			"FROM `MachineAccessToken` `t` JOIN `Org` `o` ON `o`.`id` = `t`.`orgId` "+
			"WHERE `t`.`tokenHash` = ?", tokenHash).
		Scan(&row.ID, &row.OrgID, &row.Name, &rawPermissions, &row.CreatedByID,
			&expiresAt, &revokedAt, &row.OrgActive, &planTier, &subscriptionStatus)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, unauthorized("Invalid machine token")
	}
	if err != nil {
		return nil, dbWrap(err)
	}
	row.ExpiresAt = nullableTime(expiresAt)
	row.RevokedAt = nullableTime(revokedAt)
	row.PlanTier = nullableString(planTier)
	row.SubscriptionStatus = nullableString(subscriptionStatus)

	now := time.Now()
	if row.RevokedAt != nil || !row.OrgActive || (row.ExpiresAt != nil && !row.ExpiresAt.After(now)) {
		return nil, unauthorized("Invalid machine token")
	}

	// best-effort lastUsedAt: a failure must not turn a valid request into a
	// 500 (NestJS `.catch(() => undefined)`).
	if _, err := a.db.ExecContext(ctx,
		"UPDATE `MachineAccessToken` SET `lastUsedAt` = ? WHERE `id` = ?", nowMillis(), row.ID); err != nil {
		log.Printf("accountsecurity: machine lastUsedAt update failed: %v", err)
	}

	permissions := machinePermissionStrings(rawPermissions)
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
