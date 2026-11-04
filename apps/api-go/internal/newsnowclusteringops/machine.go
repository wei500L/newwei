package newsnowclusteringops

import (
	"context"
	"errors"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// AuthenticateMachine validates an mtk_ machine token through the shared
// authhttp.MachineResolver: SHA-256 of the token against
// MachineAccessToken.tokenHash joined with Org.isActive, rejecting revoked,
// expired and inactive tokens, and deriving the permission set from the token
// row only. The JWT verifier rejects mtk_ tokens by design, so machine callers
// must come through here.
func (s *Service) AuthenticateMachine(ctx context.Context, token string) (*authhttp.Identity, error) {
	if s == nil || s.db == nil {
		return nil, newHTTPError(http.StatusServiceUnavailable, "Internal server error")
	}
	identity, err := authhttp.NewMachineResolver(s.db, nil).Resolve(ctx, token)
	if errors.Is(err, authhttp.ErrInvalidMachineToken) {
		return nil, newHTTPError(http.StatusUnauthorized, "Invalid machine token")
	}
	return identity, err
}
