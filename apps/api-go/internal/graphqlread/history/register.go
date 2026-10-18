// Package history serves the migrated analysis, assistant, and notification Query fields.
package history

import (
	"context"
	"database/sql"
	"errors"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

var (
	errDatabaseUnavailable = errors.New("mysql is not configured")
	errMongoUnavailable    = errors.New("mongo is not configured")
)

type service struct {
	db    *sql.DB
	mongo *mongo.Database
	redis *redis.Client
}

// Register adds the history Query roots and their object types.
func Register(reg *contract.Registry, db *sql.DB, mongoDB *mongo.Database, redisClient *redis.Client) {
	if reg == nil {
		panic("graphqlread: history.Register requires a registry")
	}
	RegisterModels(reg)
	svc := &service{db: db, mongo: mongoDB, redis: redisClient}

	reg.RegisterRoot(contract.Root{
		Name:       "analysisResults",
		Permission: "analysis.read",
		Resolve:    svc.analysisResults,
	})
	reg.RegisterRoot(contract.Root{
		Name:       "assistantRuns",
		Permission: "assistant.read",
		Resolve:    svc.assistantRuns,
	})
	reg.RegisterRoot(contract.Root{
		Name:       "assistantEconomicSeriesSuggestions",
		Permission: "assistant.run",
		Resolve:    svc.assistantEconomicSeriesSuggestions,
	})
	reg.RegisterRoot(contract.Root{
		Name:       "assistantRuntimeCapabilities",
		Permission: "assistant.read",
		Resolve:    svc.assistantRuntimeCapabilities,
	})
	reg.RegisterRoot(contract.Root{
		Name:               "notifications",
		AllowAuthenticated: true,
		Resolve:            svc.notifications,
	})
	reg.RegisterRoot(contract.Root{
		Name:               "unreadNotificationCount",
		AllowAuthenticated: true,
		Resolve:            svc.unreadNotificationCount,
	})
}

// RegisterModels registers the analysis, assistant and notification object
// types the read roots project, without registering any read root.
//
// It exists so the workspace write batch can return the notification model
// while the history read roots are not registered at all. Every type may be
// registered exactly once per registry, so a caller must choose between
// Register (reads plus models) and RegisterModels (models only), never both.
func RegisterModels(reg *contract.Registry) {
	if reg == nil {
		panic("graphqlread: history.RegisterModels requires a registry")
	}
	reg.RegisterType("AnalysisResultModel", AnalysisResultModel{})
	reg.RegisterType("AssistantRunModel", AssistantRunModel{})
	reg.RegisterType("EconomicSeriesSuggestion", EconomicSeriesSuggestion{})
	reg.RegisterType("AssistantRuntimeCapabilitiesModel", AssistantRuntimeCapabilitiesModel{})
	reg.RegisterType("NotificationModel", NotificationModel{})
}

func callContext(ctx contract.Context) context.Context {
	if ctx.Ctx != nil {
		return ctx.Ctx
	}
	return context.Background()
}

func (s *service) analysisResults(ctx contract.Context) (any, error) {
	limit, err := runLimit(ctx.Args)
	if err != nil {
		return nil, err
	}
	rows, err := s.listAnalysis(callContext(ctx), ctx.Identity.OrgID, limit)
	if err != nil {
		return nil, err
	}
	return rows, nil
}

func (s *service) assistantRuns(ctx contract.Context) (any, error) {
	limit, err := runLimit(ctx.Args)
	if err != nil {
		return nil, err
	}
	rows, err := s.listAssistantRuns(callContext(ctx), ctx.Identity.OrgID, limit)
	if err != nil {
		return nil, err
	}
	return rows, nil
}

func (s *service) assistantEconomicSeriesSuggestions(ctx contract.Context) (any, error) {
	term, _ := contract.StringArg(ctx.Args, "term")
	normalized := jsTrim(term)
	switch length := utf16Len(normalized); {
	case length < 2:
		return nil, &contract.Failure{Message: "term must be at least 2 characters", Status: 400}
	case length > 100:
		return nil, &contract.Failure{Message: "term must be at most 100 characters", Status: 400}
	}
	limit, err := suggestionLimit(ctx.Args)
	if err != nil {
		return nil, err
	}
	rows, err := s.searchSeries(callContext(ctx), normalized, limit)
	if err != nil {
		return nil, err
	}
	return rows, nil
}

func (s *service) assistantRuntimeCapabilities(ctx contract.Context) (any, error) {
	capabilities, err := s.runtimeCapabilities(callContext(ctx))
	if err != nil {
		return nil, err
	}
	return capabilities, nil
}

func (s *service) notifications(ctx contract.Context) (any, error) {
	take, err := notificationTake(ctx.Args)
	if err != nil {
		return nil, err
	}
	rows, err := s.listNotifications(callContext(ctx), ctx.Identity.OrgID, ctx.Identity.UserID, take)
	if err != nil {
		return nil, err
	}
	return rows, nil
}

func (s *service) unreadNotificationCount(ctx contract.Context) (any, error) {
	count, err := s.countUnread(callContext(ctx), ctx.Identity.OrgID, ctx.Identity.UserID)
	if err != nil {
		return nil, err
	}
	return count, nil
}
