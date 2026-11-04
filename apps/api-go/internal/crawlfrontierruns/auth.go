package crawlfrontierruns

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// authorize applies the shared identity chain:
//
//   - missing Authorization / non-Bearer -> 401 Unauthorized;
//   - mtk_ tokens -> AuthenticateMachine (SHA-256 lookup in MachineAccessToken);
//   - every other token -> authhttp.Authenticate (JWT verification, Redis
//     revocation list, membership-based permission re-derivation);
//   - a missing method permission -> 403 Insufficient permissions.
//
// Authentication always runs before DTO validation, so the failure order is
// 401 -> 403 -> 400 -> service error, matching NestJS guards-before-pipes.
func (h *Handler) authorize(w http.ResponseWriter, r *http.Request, permission string) *authhttp.Identity {
	if h == nil || h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return nil
	}
	raw := rawBearer(r)
	if raw == "" {
		authhttp.WriteUnauthorized(w, r, "")
		return nil
	}
	var identity *authhttp.Identity
	if strings.HasPrefix(raw, "mtk_") {
		resolved, err := h.svc.AuthenticateMachine(r.Context(), raw)
		if err != nil {
			writeServiceError(w, r, err)
			return nil
		}
		identity = resolved
	} else {
		if h.auth == nil {
			authhttp.WriteDatabaseFailure(w, r)
			return nil
		}
		identity = h.auth.Authenticate(w, r)
		if identity == nil {
			return nil
		}
	}
	if !identity.HasPermission(permission) {
		authhttp.WriteForbidden(w, r, []string{permission})
		return nil
	}
	return identity
}

// rawBearer extracts the Bearer token from the Authorization header.
func rawBearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if len(header) < 7 || !strings.EqualFold(header[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
}

// AuthenticateMachine resolves an mtk_ machine token: SHA-256 hex lookup in
// MachineAccessToken joined with Org.isActive, rejecting revoked, expired and
// disabled-org tokens with 401 Invalid machine token, then updating lastUsedAt.
// Permissions and orgId come from the token row only.
func (s *Service) AuthenticateMachine(ctx context.Context, token string) (*authhttp.Identity, error) {
	identity, err := authhttp.NewMachineResolver(s.db, nil).Resolve(ctx, token)
	if errors.Is(err, authhttp.ErrInvalidMachineToken) {
		return nil, newStatus(401, "Invalid machine token")
	}
	return identity, err
}

// nowMillis returns the current UTC time truncated to milliseconds.
func nowMillis() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// permissionList parses the permissions JSON array of a machine token. Only
// string entries survive.
func permissionList(raw []byte) []string {
	if !rawIsArray(raw) {
		return nil
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil
	}
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		// json.Unmarshal accepts a JSON null into a string without an error, so
		// the quoted-string shape is checked first: only actual strings survive.
		if !rawIsString(entry) {
			continue
		}
		var text string
		if json.Unmarshal(entry, &text) == nil {
			out = append(out, text)
		}
	}
	return out
}
