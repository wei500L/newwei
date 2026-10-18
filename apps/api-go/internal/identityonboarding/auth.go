package identityonboarding

import (
	"database/sql"
	"net/http"
	"strings"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/rbacapi"
)

// Authenticator resolves the caller identity for every authenticated route. It
// wraps the shared authhttp chain (JWT verification, Redis access-token
// blacklist, MySQL membership and permission re-derivation) and adds the mtk_
// machine-token branch, which authhttp deliberately rejects.
//
// The machine branch reuses rbacapi.AuthenticateMachine: the identity is
// "machine:<tokenId>", its organization comes from the token row and its
// permissions come from that row. It is never converted into a human actor, so
// services that need a real membership, a global platform role or an email match
// still reject it through their ordinary checks.
type Authenticator struct {
	chain *authhttp.Authenticator
	rbac  *rbacapi.Service
}

// NewAuthenticator wires the human chain and the machine-token lookup. Both use
// the shared MySQL pool and Redis client.
func NewAuthenticator(chain *authhttp.Authenticator, db *sql.DB, redisClient *redis.Client) *Authenticator {
	return &Authenticator{chain: chain, rbac: rbacapi.NewService(db, redisClient)}
}

// authorize runs authentication and, when permission is non-empty, the
// permission check. On failure it writes the contract-equivalent error and
// returns nil.
func (a *Authenticator) authorize(w http.ResponseWriter, r *http.Request, permission string) *authhttp.Identity {
	raw := rawBearer(r)
	if raw == "" {
		authhttp.WriteUnauthorized(w, r, "")
		return nil
	}

	var identity *authhttp.Identity
	if strings.HasPrefix(raw, "mtk_") {
		if a == nil || a.rbac == nil {
			authhttp.WriteDatabaseFailure(w, r)
			return nil
		}
		resolved, err := a.rbac.AuthenticateMachine(r.Context(), raw)
		if err != nil {
			status, message := rbacapi.StatusOf(err)
			if status == http.StatusUnauthorized {
				authhttp.WriteUnauthorized(w, r, message)
				return nil
			}
			writeServiceError(w, r, err)
			return nil
		}
		identity = resolved
	} else {
		if a == nil || a.chain == nil {
			authhttp.WriteDatabaseFailure(w, r)
			return nil
		}
		identity = a.chain.Authenticate(w, r)
		if identity == nil {
			return nil
		}
	}

	if permission != "" && !identity.HasPermission(permission) {
		authhttp.WriteForbidden(w, r, []string{permission})
		return nil
	}
	return identity
}

// rawBearer extracts the raw token from the Authorization header without
// filtering mtk_ tokens, because this package handles them itself.
func rawBearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if len(header) < 7 || !strings.EqualFold(header[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
}
