package crawlreadtelemetry

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// authenticateMachine resolves an `mtk_` machine token exactly like the
// crawltemplate / crawlprofile / adminlogs Go units: SHA-256 hex lookup in
// MachineAccessToken joined to Org.isActive; the row is updated with
// lastUsedAt; permissions and orgId come only from the token row.
func (s *Service) authenticateMachine(ctx context.Context, token string) (*authhttp.Identity, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("%w: mysql is not configured", errDatabase)
	}
	sum := sha256.Sum256([]byte(token))
	var id, orgID string
	var permissions []byte
	var expires, revoked sql.NullTime
	var active int
	err := s.db.QueryRowContext(ctx, `
SELECT t.id, t.orgId, t.permissions, t.expiresAt, t.revokedAt, o.isActive
FROM MachineAccessToken t
JOIN Org o ON o.id = t.orgId
WHERE t.tokenHash = ?`, hex.EncodeToString(sum[:]),
	).Scan(&id, &orgID, &permissions, &expires, &revoked, &active)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, newStatusError(http.StatusUnauthorized, "Invalid machine token")
	}
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errDatabase, err)
	}
	if revoked.Valid || active == 0 || (expires.Valid && !expires.Time.After(time.Now())) {
		return nil, newStatusError(http.StatusUnauthorized, "Invalid machine token")
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE MachineAccessToken SET lastUsedAt = ? WHERE id = ?`, nowUTCMillis(), id); err != nil {
		// A failed bookkeeping update must not reject an otherwise valid token.
		return authhttp.NewIdentity("machine:"+id, orgID, parseMachinePermissions(permissions)), nil
	}
	return authhttp.NewIdentity("machine:"+id, orgID, parseMachinePermissions(permissions)), nil
}

// nowUTCMillis is the millisecond-precision UTC timestamp written into
// Prisma DateTime(3) columns.
func nowUTCMillis() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// parseMachinePermissions decodes the MachineAccessToken.permissions JSON array
// without weak typing: every entry is decoded into a concrete string and
// non-string entries are dropped.
func parseMachinePermissions(raw []byte) []string {
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil
	}
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		var text string
		if err := json.Unmarshal(entry, &text); err == nil {
			out = append(out, text)
		}
	}
	return out
}
