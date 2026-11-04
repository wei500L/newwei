package crawlreadtelemetry

import (
	"context"
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
	identity, err := authhttp.NewMachineResolver(s.db, nil).Resolve(ctx, token)
	if errors.Is(err, authhttp.ErrInvalidMachineToken) {
		return nil, newStatusError(http.StatusUnauthorized, "Invalid machine token")
	}
	return identity, err
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
