package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/infrastructuresettings"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsingest"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/newsbehavior"
	"github.com/wei500L/newwei/apps/api-go/internal/newsnowclusteringops"
	"github.com/wei500L/newwei/apps/api-go/internal/newsnowhottest"
	"github.com/wei500L/newwei/apps/api-go/internal/newsnowsources"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
	"github.com/wei500L/newwei/apps/api-go/internal/runtimesettings"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

// newsnowHottestUnit owns both execution surfaces of this batch:
//
//   - API_GO_NEWSNOW_HOTTEST_MODE=go registers the two authenticated HTTP reads;
//   - API_GO_NEWSNOW_BACKGROUND_MODE=go starts the ten-minute hottest scheduler
//     and the one-minute source warm scheduler.
//
// The two switches are independent. The unit is nil when both are legacy, so the
// default deployment keeps the NestJS owners and the legacy proxy.
type newsnowHottestUnit struct {
	service   *newsnowhottest.Service
	scheduler *newsnowhottest.Scheduler
	warm      *newsnowhottest.WarmScheduler
	registry  *newsnowhottest.InMemoryActiveSourceRegistry
	// ownedSources is set when this unit built its own source fetch service
	// because the public source switch is legacy. Its idle connections are
	// drained on Close; a shared service keeps its existing owner.
	ownedSources *newsnowsources.Service
}

// newNewsnowHottestUnit builds the service, registers the HTTP routes when the
// hot switch is go and prepares (but does not start) the schedulers.
func newNewsnowHottestUnit(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	authenticator *authhttp.Authenticator,
	mongoConn **dashboardstats.Connection,
	sources *newsnowsources.Service,
) (*newsnowHottestUnit, error) {
	hottestGo := cfg.NewsnowHottestMode == config.NewsnowHottestModeGo
	backgroundGo := cfg.NewsnowBackgroundMode == config.NewsnowBackgroundModeGo
	if !hottestGo && !backgroundGo {
		return nil, nil
	}
	if db == nil || redisClient == nil {
		return nil, fmt.Errorf("api-go: newsnow hottest unit requires mysql and redis")
	}
	if hottestGo && authenticator == nil {
		return nil, fmt.Errorf("api-go: API_GO_NEWSNOW_HOTTEST_MODE=go requires jwt")
	}
	if mongoConn == nil || *mongoConn == nil {
		conn, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			return nil, fmt.Errorf("api-go: newsnow hottest unit requires a valid MONGO_URI")
		}
		*mongoConn = conn
	}
	mongoDatabase := (*mongoConn).Database()

	unit := &newsnowHottestUnit{}
	if sources == nil {
		secrets := infrastructuresettings.NewRuntimeSecretReader(
			db, cfg.SettingsEncryptionKeyRaw, cfg.SettingsEncryptionKeyPresent)
		owned := newsnowsources.NewService(newsnowsources.ServiceConfig{
			Registry: newsnowSourceRegistry{},
			Secrets:  secrets,
			Store:    newsnowsources.NewRedisStore(redisClient),
			Env:      os.Getenv,
		})
		sources = owned
		unit.ownedSources = owned
	}

	observer := publicportal.HottestClusterObserver(
		hottestClusterAttemptObserver{writer: llmlogs.NewCompletionWriter(db, mongoDatabase)})
	completer := publicportal.NewHottestClusterCompleter(publicportal.NewMySQLStore(db), publicportal.GatewayEnv{
		EncryptionKey: cfg.SettingsEncryptionKey,
		APIBase:       cfg.LiteLLMAPIBase,
		APIKey:        cfg.LiteLLMAPIKey,
		TimeoutMs:     cfg.LiteLLMTimeoutMs,
		MaxRetries:    cfg.LiteLLMMaxRetries,
		TopP:          cfg.LLMGatewayTopP,
	})
	behavior := newsbehavior.NewService(db, redisClient)
	unit.service = newsnowhottest.NewService(newsnowhottest.Options{
		Store:     newsnowhottest.NewRedisStore(redisClient),
		Catalog:   newsnowHottestCatalog{},
		Sources:   sources,
		Completer: newsnowHottestCompleter{completer: completer, observer: observer},
		Matcher:   newsnowhottest.NewOrgMatcher(newsnowhottest.NewMatchStore(mongoDatabase, db)),
		Bridge:    hottestItemBridge{service: buildItemsIngestService(cfg, db, redisClient, mongoDatabase)},
		Opinion:   newsnowhottest.NewOpinionStore(db, mongoDatabase),
		Behavior:  newsnowHottestBehavior{service: behavior},
		Settings:  newsnowHottestUserSettings{repository: usersettings.NewMySQLRepository(db)},
		Logger:    log.Default(),
	})

	if hottestGo {
		handler := newsnowhottest.NewHandler(authenticator, db, unit.service)
		policy := cors.New(cfg.CorsOrigin)
		gateway.RegisterGoHandler(legacyproxy.NewsnowHottestKey, func(w http.ResponseWriter, r *http.Request) {
			if policy.FinishOptions(w, r) {
				return
			}
			if r.Method == http.MethodOptions {
				gateway.ServeLegacy(w, r)
				return
			}
			handler.ServeHTTP(w, r)
		})
		log.Printf("api-go: newsnow hottest reading takeover mode=%s", cfg.NewsnowHottestMode)
	}

	unit.registry = newsnowhottest.NewActiveSourceRegistry()
	if backgroundGo {
		unit.scheduler = newsnowhottest.NewScheduler(newsnowhottest.SchedulerOptions{
			Store:    newsnowhottest.NewRedisStore(redisClient),
			Orgs:     newsnowHottestOrgReader{db: db},
			Settings: runtimesettingsReader{service: runtimesettings.NewService(db, redisClient, runtimesettings.Config{})},
			Service:  unit.service,
			Logger:   log.Default(),
		})
		unit.warm = newsnowhottest.NewWarmScheduler(newsnowhottest.WarmSchedulerOptions{
			Store:    newsnowhottest.NewRedisStore(redisClient),
			Sources:  sources,
			Registry: unit.registry,
			Logger:   log.Default(),
		})
	}
	return unit, nil
}

// Start launches the schedulers when the background switch is go.
func (u *newsnowHottestUnit) Start(cfg config.Config) {
	if u == nil || cfg.NewsnowBackgroundMode != config.NewsnowBackgroundModeGo {
		return
	}
	if u.scheduler != nil {
		u.scheduler.Start(context.Background())
		log.Printf("api-go: NewsNow hottest analysis scheduler started (interval=10m)")
	}
	if u.warm != nil {
		u.warm.Start(context.Background())
		log.Printf("api-go: NewsNow source warm scheduler started (interval=1m)")
	}
}

// Close stops both schedulers and drains a source service this unit created.
func (u *newsnowHottestUnit) Close(ctx context.Context) error {
	if u == nil {
		return nil
	}
	var first error
	if u.scheduler != nil {
		if err := u.scheduler.Close(ctx); err != nil && first == nil {
			first = err
		}
	}
	if u.warm != nil {
		if err := u.warm.Close(ctx); err != nil && first == nil {
			first = err
		}
	}
	if u.ownedSources != nil {
		u.ownedSources.CloseIdleConnections()
	}
	return first
}

// newsnowHottestCatalog adapts the generated registry display port.
type newsnowHottestCatalog struct{}

// HottestSourceIDs returns the hottest column in registry order.
func (newsnowHottestCatalog) HottestSourceIDs() []string {
	return newsnowclusteringops.HottestSourceIDs()
}

// Source resolves one source descriptor.
func (newsnowHottestCatalog) Source(sourceID string) (newsnowhottest.SourceDescriptor, bool) {
	display, ok := newsnowclusteringops.LookupSourceDisplay(sourceID)
	if !ok {
		return newsnowhottest.SourceDescriptor{}, false
	}
	return newsnowhottest.SourceDescriptor{
		ID:     display.ID,
		Name:   display.Name,
		Title:  display.Title,
		Home:   display.Home,
		Column: display.Column,
	}, true
}

// hottestItemBridge adapts ItemsIngestService.create to the NewsNow bridge port.
type hottestItemBridge struct {
	service *itemsingest.Service
}

// CreateItem creates the ItemMeta/raw_item pair of one bridged signal.
func (b hottestItemBridge) CreateItem(ctx context.Context, orgID, userID string, input itemsingest.CreateItemInput) (itemsingest.CreateItemResult, error) {
	return b.service.Create(ctx, orgID, userID, input)
}

// newsnowHottestCompleter maps the service port onto the public portal gateway.
type newsnowHottestCompleter struct {
	completer publicportal.HottestClusterCompleter
	observer  publicportal.HottestClusterObserver
}

// CompleteClusterInsights performs the real model call.
func (c newsnowHottestCompleter) CompleteClusterInsights(ctx context.Context, orgID, system, user string, clusterCount int) (string, error) {
	if c.completer == nil {
		return "", fmt.Errorf("newsnowhottest: model completer is not configured")
	}
	result, err := c.completer.CompleteHottestClusterInsights(ctx, publicportal.HottestClusterRequest{
		OrgID:        orgID,
		System:       system,
		User:         user,
		ClusterCount: clusterCount,
		Observer:     c.observer,
	})
	if err != nil {
		return "", err
	}
	return result.Content, nil
}

// hottestClusterAttemptObserver writes one llmrequestlogs row per real attempt.
type hottestClusterAttemptObserver struct {
	writer *llmlogs.CompletionWriter
}

// ObserveHottestClusterAttempt implements publicportal.HottestClusterObserver.
func (o hottestClusterAttemptObserver) ObserveHottestClusterAttempt(ctx context.Context, attempt publicportal.HottestClusterAttempt) {
	if o.writer == nil {
		return
	}
	status := "error"
	if attempt.Success {
		status = "success"
	}
	errorText := ""
	if attempt.Err != nil {
		errorText = attempt.Err.Error()
	}
	governanceApplied := attempt.GovernanceApplied
	clusters := attempt.Metadata.Clusters
	entry := llmlogs.CompletionLogEntry{
		OrgID:   attempt.OrgID,
		Model:   attempt.Model,
		Status:  status,
		Error:   errorText,
		Latency: attempt.Latency,
		Usage: llmlogs.CompletionUsage{
			PromptTokens:     attempt.Usage.PromptTokens,
			CompletionTokens: attempt.Usage.CompletionTokens,
			TotalTokens:      attempt.Usage.TotalTokens,
			CostUSD:          attempt.Usage.CostUSD,
		},
		Feature:                   attempt.Metadata.Feature,
		APISurface:                attempt.APISurface,
		GatewayProfileID:          attempt.GatewayProfileID,
		GovernanceApplied:         &governanceApplied,
		AuthMode:                  attempt.AuthMode,
		GovernanceTargetProfileID: attempt.GovernanceTargetProfileID,
		Metadata: &llmlogs.CompletionMetadata{
			Feature:  attempt.Metadata.Feature,
			Clusters: &clusters,
		},
		OccurredAt: time.Now(),
	}
	if err := o.writer.WriteAttempt(ctx, entry); err != nil {
		log.Printf("api-go: NewsNow hottest LLM request log write failed")
	}
}

// newsnowHottestBehavior adapts the news-behavior read port.
type newsnowHottestBehavior struct {
	service *newsbehavior.Service
}

// GetScoringProfile returns the net and negative dimensions.
func (b newsnowHottestBehavior) GetScoringProfile(ctx context.Context, orgID, userID string) (newsnowhottest.ScoringProfile, error) {
	view, err := b.service.GetScoringProfile(ctx, orgID, userID)
	if err != nil {
		return newsnowhottest.ScoringProfile{}, err
	}
	return newsnowhottest.ScoringProfile{
		Sources:  newsnowhottest.ScoreMap(view.Sources),
		Topics:   newsnowhottest.ScoreMap(view.Topics),
		Entities: newsnowhottest.ScoreMap(view.Entities),
		Items:    newsnowhottest.ScoreMap(view.Items),
		Events:   newsnowhottest.ScoreMap(view.Events),
		Domains:  newsnowhottest.ScoreMap(view.Domains),
		Negative: newsnowhottest.NegativeScores{
			Sources:  newsnowhottest.ScoreMap(view.Negative.Sources),
			Topics:   newsnowhottest.ScoreMap(view.Negative.Topics),
			Entities: newsnowhottest.ScoreMap(view.Negative.Entities),
			Items:    newsnowhottest.ScoreMap(view.Negative.Items),
			Events:   newsnowhottest.ScoreMap(view.Negative.Events),
			Domains:  newsnowhottest.ScoreMap(view.Negative.Domains),
		},
	}, nil
}

// GetCollaborativeProfile returns the collaborative dimensions.
func (b newsnowHottestBehavior) GetCollaborativeProfile(ctx context.Context, orgID, userID string) (newsnowhottest.CollaborativeProfile, error) {
	view, err := b.service.GetCollaborativeProfile(ctx, orgID, userID)
	if err != nil {
		return newsnowhottest.CollaborativeProfile{}, err
	}
	return newsnowhottest.CollaborativeProfile{
		Sources:  newsnowhottest.ScoreMap(view.Sources),
		Topics:   newsnowhottest.ScoreMap(view.Topics),
		Entities: newsnowhottest.ScoreMap(view.Entities),
		Items:    newsnowhottest.ScoreMap(view.Items),
		Events:   newsnowhottest.ScoreMap(view.Events),
		Domains:  newsnowhottest.ScoreMap(view.Domains),
		Degraded: view.Degraded,
	}, nil
}

// newsnowHottestUserSettings adapts the usersettings repository.
type newsnowHottestUserSettings struct {
	repository *usersettings.MySQLRepository
}

// NewsnowSettings resolves ui:newsnow:settings:v1.
func (s newsnowHottestUserSettings) NewsnowSettings(ctx context.Context, orgID, userID string) (newsnowhottest.NewsnowUISettings, bool, error) {
	record, err := s.repository.FindNewsnow(ctx, orgID, userID)
	if err != nil {
		return newsnowhottest.NewsnowUISettings{}, false, err
	}
	if !record.Found {
		return newsnowhottest.NewsnowUISettings{}, false, nil
	}
	normalized := usersettings.NormalizeNewsnow(record.Value)
	affinity := make(map[string]float64, len(normalized.SourceAffinity))
	for _, pair := range normalized.SourceAffinity {
		affinity[pair.Key] = pair.Affinity.Score
	}
	focus := normalized.FocusSources
	if focus == nil {
		focus = []string{}
	}
	return newsnowhottest.NewsnowUISettings{FocusSources: focus, SourceAffinity: affinity}, true, nil
}

// newsnowHottestOrgReader lists the active organizations.
type newsnowHottestOrgReader struct {
	db *sql.DB
}

// ListActiveOrgIDs mirrors ActiveOrgRegistryService.loadActiveOrgs.
func (r newsnowHottestOrgReader) ListActiveOrgIDs(ctx context.Context) ([]string, error) {
	if r.db == nil {
		return nil, fmt.Errorf("newsnowhottest: mysql is not configured")
	}
	rows, err := r.db.QueryContext(ctx, "SELECT `id` FROM `Org` WHERE `isActive` = true ORDER BY `id` ASC")
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	ids := make([]string, 0, 16)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return ids, nil
}

// runtimesettingsReader adapts the runtime settings service.
type runtimesettingsReader struct {
	service *runtimesettings.Service
}

// ReadNewsnowHottestAnalysisOrgConcurrency reads the persisted concurrency.
func (r runtimesettingsReader) ReadNewsnowHottestAnalysisOrgConcurrency(ctx context.Context) (int, error) {
	return r.service.ReadNewsnowHottestAnalysisOrgConcurrency(ctx)
}
