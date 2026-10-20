// Package newsindicatorwrite registers the news-indicator association refresh
// mutation in the Go GraphQL executor.
//
// It owns exactly one mutation:
//
//	refreshNewsIndicatorAssociations: Boolean!   (settings.manage)
//
// The computation is not rewritten: it calls newsindicator.RefreshOrg, the same
// implementation the POST /api/news-indicator/refresh route already uses, so
// both entries write the same association and backtest rows inside the same
// per-organization MySQL session lock. While
// API_GO_GRAPHQL_NEWS_INDICATOR_REFRESH_MODE is legacy the mutation is not
// registered and the document stays on NestJS.
package newsindicatorwrite

import (
	"database/sql"
	"net/http"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/newsindicator"
)

// service holds the refresh implementation shared with the HTTP route.
type service struct {
	associations *newsindicator.Service
}

// Register adds the refresh mutation and its root permission.
func Register(reg *contract.Registry, db *sql.DB, redisClient *redis.Client) {
	if reg == nil {
		panic("graphqlread: newsindicatorwrite.Register requires a registry")
	}
	svc := &service{associations: newsindicator.NewService(db, redisClient)}
	reg.RegisterMutation(contract.Root{
		Name:       "refreshNewsIndicatorAssociations",
		Permission: "settings.manage",
		Resolve:    contract.Bind(svc.refresh),
	})
}

// RegisteredMutations lists the mutation names Register adds.
var RegisteredMutations = []string{"refreshNewsIndicatorAssociations"}

// refresh mirrors the NestJS resolver: refreshOrg then return true. A failure
// becomes the same GraphQL error the NestJS exception filter produces for a
// non-HttpException in production: status 500 and "Internal server error". The
// underlying message stays in the server log, never in the response.
func (s *service) refresh(ctx contract.Context) (bool, error) {
	if s == nil || s.associations == nil {
		return false, &contract.Failure{Message: "Internal server error", Status: http.StatusInternalServerError}
	}
	if _, err := s.associations.RefreshOrg(ctx.Ctx, ctx.Identity.OrgID); err != nil {
		return false, &contract.Failure{Message: "Internal server error", Status: http.StatusInternalServerError}
	}
	return true, nil
}
