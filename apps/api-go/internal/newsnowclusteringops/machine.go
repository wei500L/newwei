package newsnowclusteringops

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// authenticateMachineSQL resolves a machine token and its organization state.
const authenticateMachineSQL = `
SELECT t.id, t.orgId, t.permissions, t.expiresAt, t.revokedAt, o.isActive
FROM MachineAccessToken t
JOIN Org o ON o.id = t.orgId
WHERE t.tokenHash = ?`

// AuthenticateMachine validates an mtk_ machine token the way every other Go
// takeover does: SHA-256 hex of the token against MachineAccessToken.tokenHash,
// joined with Org.isActive, rejecting revoked, expired and inactive tokens, and
// deriving the permission set from the token row only. The JWT verifier rejects
// mtk_ tokens by design, so machine callers must come through here.
func (s *Service) AuthenticateMachine(ctx context.Context, token string) (*authhttp.Identity, error) {
	if s == nil || s.db == nil {
		return nil, newHTTPError(http.StatusServiceUnavailable, "Internal server error")
	}
	sum := sha256.Sum256([]byte(token))

	var id, orgID string
	var permissions json.RawMessage
	var expires, revoked sql.NullTime
	var active int
	err := s.db.QueryRowContext(ctx, authenticateMachineSQL, hex.EncodeToString(sum[:])).
		Scan(&id, &orgID, &permissions, &expires, &revoked, &active)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, newHTTPError(http.StatusUnauthorized, "Invalid machine token")
	}
	if err != nil {
		return nil, err
	}
	if revoked.Valid || active == 0 || (expires.Valid && !expires.Time.After(time.Now())) {
		return nil, newHTTPError(http.StatusUnauthorized, "Invalid machine token")
	}
	_, _ = s.db.ExecContext(ctx,
		"UPDATE MachineAccessToken SET lastUsedAt = ? WHERE id = ?",
		time.Now().UTC().Truncate(time.Millisecond), id)

	return authhttp.NewIdentity("machine:"+id, orgID, machinePermissionList(permissions)), nil
}

// machinePermissionList decodes the JSON string array stored in
// MachineAccessToken.permissions. Non-string entries are dropped and blank
// entries are trimmed away.
func machinePermissionList(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var entries []string
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil
	}
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" {
			continue
		}
		out = append(out, trimmed)
	}
	return out
}
