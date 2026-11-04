package crawlmetadata

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// authenticateMachine resolves an `mtk_` machine token exactly like the
// crawlreadtelemetry / crawltemplate Go units: SHA-256 hex lookup in
// MachineAccessToken joined to Org.isActive, permissions and orgId taken only
// from the token row, and a best-effort lastUsedAt update. The metadata chain
// reads no business table; this is purely the HTTP entry's authentication.
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

// parseMachinePermissions decodes the MachineAccessToken.permissions JSON array
// without weak typing: non-string entries are dropped.
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
