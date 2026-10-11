// Package alerts serves the migrated alert read queries.
//
// Register wires alertChannels, alertEvents, alertEventReplay, and
// alertRuleTuningSuggestion. alertRules stays on the legacy gateway.
package alerts

import (
	"database/sql"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// Register adds the alert read roots and the object types they return.
func Register(reg *contract.Registry, db *sql.DB) {
	if reg == nil {
		panic("graphqlread: alerts.Register requires a registry")
	}
	reg.RegisterType("AlertChannelModel", AlertChannelModel{})
	reg.RegisterType("AlertDeliveryModel", AlertDeliveryModel{})
	reg.RegisterType("AlertEventModel", AlertEventModel{})
	reg.RegisterType("AlertEventReplayModel", AlertEventReplayModel{})
	reg.RegisterType("AlertEventReplayPointModel", AlertEventReplayPointModel{})
	reg.RegisterType("AlertRuleTuningSuggestionModel", AlertRuleTuningSuggestionModel{})

	reg.RegisterRoot(contract.Root{
		Name:       "alertChannels",
		Permission: "alerts.read",
		Resolve: func(ctx contract.Context) (any, error) {
			return listChannels(ctx.Ctx, db, ctx.Identity.OrgID)
		},
	})
	reg.RegisterRoot(contract.Root{
		Name:       "alertEvents",
		Permission: "alerts.read",
		Resolve: func(ctx contract.Context) (any, error) {
			limit := boundedIntArg(ctx.Args, "limit", 50, 1, 500)
			return listEvents(ctx.Ctx, db, ctx.Identity.OrgID, limit, metricSlugArg(ctx.Args))
		},
	})
	reg.RegisterRoot(contract.Root{
		Name:       "alertEventReplay",
		Permission: "alerts.read",
		Resolve: func(ctx contract.Context) (any, error) {
			eventID, err := requiredStringArg(ctx.Args, "eventId")
			if err != nil {
				return nil, err
			}
			days := boundedIntArg(ctx.Args, "windowDays", 30, 1, 365)
			return replayEvent(ctx.Ctx, db, ctx.Identity.OrgID, eventID, days)
		},
	})
	reg.RegisterRoot(contract.Root{
		Name:       "alertRuleTuningSuggestion",
		Permission: "alerts.manage",
		Resolve: func(ctx contract.Context) (any, error) {
			ruleID, err := requiredStringArg(ctx.Args, "ruleId")
			if err != nil {
				return nil, err
			}
			days := boundedIntArg(ctx.Args, "windowDays", 30, 1, 365)
			return tuningSuggestion(ctx.Ctx, db, ctx.Identity.OrgID, ruleID, days)
		},
	})
}
