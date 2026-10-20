package economicdata

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/economicqueue"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// Env is the Akshare and provider configuration read from the same environment
// variables as NestJS EnvService.akshareConfig plus the shared encryption key.
type Env struct {
	AkshareEnabled        bool
	AkshareBaseURL        string
	AkshareTimeout        time.Duration
	AkshareMaxRetries     int
	AkshareAdminToken     string
	QueueConcurrency      int
	ScheduleSmoothing     bool
	SkipUnchangedLatest   bool
	SettingsEncryptionKey string
	RateLimitFailOpen     bool
}

// Options constructs the service. Mongo is nil for request-only mode; the fetch
// path requires it because every actual fetch archives its response.
type Options struct {
	DB    *sql.DB
	Redis *redis.Client
	Mongo *mongo.Database
	Env   Env
	HTTP  *http.Client
}

// Service owns the economic catalog, schedule, fetch persistence and admin
// operations. The static catalog lives in catalog_defs.go.
type Service struct {
	db    *sql.DB
	redis *redis.Client
	queue *economicqueue.Producer
	mongo *mongo.Database
	env   Env
	http  *http.Client
	keys  *keyResolver
	admin *adminClient

	forceParserSync        map[string]bool
	forceDefaultParamsSync map[string]bool
	forceSourceSync        map[string]bool
	forceFilterSync        map[string]bool
}

// NewService builds the shared service. It does not connect to MySQL, Redis or
// Mongo and does not start a worker.
func NewService(options Options) *Service {
	httpClient := options.HTTP
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	service := &Service{
		db:    options.DB,
		redis: options.Redis,
		mongo: options.Mongo,
		env:   options.Env,
		http:  httpClient,
		forceParserSync: stringSet(
			"global_epu_index", "china_fx_gold_reserves", "macro_fx_sentiment",
			"bitcoin_spot_price", "sp500_index", "platinum_spot_sge",
			"palladium_spot_sge", "us_unemployment_rate", "us_core_pce",
			"us_non_farm_payrolls", "china_international_tourism_fx", "crypto_js_spot",
		),
		forceDefaultParamsSync: stringSet(
			"macro_fx_sentiment", "market_sentiment_usdx", "bitcoin_spot_price",
			"usd_cny_spot", "eur_cny_spot", "sp500_index", "china_treasury_yield_curve",
		),
		forceSourceSync: stringSet("sp500_index"),
		forceFilterSync: stringSet(
			"bitcoin_spot_price", "usd_cny_spot", "eur_cny_spot",
			"china_treasury_yield_curve", "sp500_index",
		),
	}
	if options.Redis != nil {
		service.queue = economicqueue.NewProducer(options.Redis)
		service.keys = newKeyResolver(options.Redis, options.DB, options.Env.SettingsEncryptionKey)
	}
	service.admin = newAdminClient(options.Env)
	return service
}

// SetMongo attaches the Mongo database after it is opened by main. Fetching is
// impossible without it.
func (s *Service) SetMongo(database *mongo.Database) { s.mongo = database }

// Queue exposes the producer to the GraphQL adapter. It is nil when Redis is
// not configured.
func (s *Service) Queue() *economicqueue.Producer { return s.queue }

func stringSet(values ...string) map[string]bool {
	out := make(map[string]bool, len(values))
	for _, value := range values {
		out[value] = true
	}
	return out
}

// FetchConfig is the GraphQL projection of one config row.
type FetchConfig struct {
	ID         string
	Frequency  Frequency
	RepeatCron *string
	IsEnabled  bool
	LastRunAt  *time.Time
	LastStatus *RunStatus
	LastError  *string
	Item       FetchConfigItem
}

// FetchConfigItem is the item subset returned by the config mutation.
type FetchConfigItem struct {
	Slug        string
	DisplayName string
	GroupLabel  *string
	DefaultUnit *string
	Metadata    json.RawMessage
}

// FetchConfigUpdate distinguishes an omitted repeatCron from an explicit null.
type FetchConfigUpdate struct {
	Frequency     *Frequency
	RepeatCron    *string
	RepeatCronSet bool
	IsEnabled     *bool
}

// ItemNotFoundError marks the NestJS InternalServerError for an unknown slug.
type ItemNotFoundError struct{ Slug string }

func (e *ItemNotFoundError) Error() string { return "Data item " + e.Slug + " not found" }

// FetchConfigMissingError means the item exists but has no config row. The
// update must fail rather than inserting one implicitly.
type FetchConfigMissingError struct{ Slug string }

func (e *FetchConfigMissingError) Error() string {
	return "Economic data fetch config not found for " + e.Slug
}

// UpdateFetchConfig mirrors AkshareService.updateFetchConfig with the corrected
// presence semantics for repeatCron: omitted leaves the column untouched, an
// explicit null clears it and a string writes it.
func (s *Service) UpdateFetchConfig(ctx context.Context, slug string, update FetchConfigUpdate) (FetchConfig, error) {
	if s == nil || s.db == nil {
		return FetchConfig{}, fmt.Errorf("economicdata: mysql is not configured")
	}
	item, err := s.loadItemBySlug(ctx, slug)
	if err != nil {
		return FetchConfig{}, err
	}
	if item == nil {
		return FetchConfig{}, &ItemNotFoundError{Slug: slug}
	}
	sets, args := buildFetchConfigUpdate(update, time.Now().UTC())
	args = append(args, item.ID)
	result, err := s.db.ExecContext(ctx, "UPDATE `EconomicDataFetchConfig` SET "+joinComma(sets)+" WHERE `itemId` = ?", args...)
	if err != nil {
		return FetchConfig{}, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return FetchConfig{}, err
	}
	if affected == 0 {
		return FetchConfig{}, &FetchConfigMissingError{Slug: slug}
	}
	if err := s.EnsureRepeatableJobs(ctx); err != nil {
		return FetchConfig{}, err
	}
	return s.loadFetchConfigByItemID(ctx, item.ID)
}

// buildFetchConfigUpdate builds the SET list. repeatCron is special: the
// presence flag decides whether the column is mentioned at all, while a nil
// value writes SQL NULL.
func buildFetchConfigUpdate(update FetchConfigUpdate, now time.Time) ([]string, []any) {
	sets := []string{"`updatedAt` = ?"}
	args := []any{now}
	if update.Frequency != nil {
		sets = append(sets, "`frequency` = ?")
		args = append(args, *update.Frequency)
	}
	if update.RepeatCronSet {
		if update.RepeatCron == nil {
			sets = append(sets, "`repeatCron` = NULL")
		} else {
			sets = append(sets, "`repeatCron` = ?")
			args = append(args, *update.RepeatCron)
		}
	}
	if update.IsEnabled != nil {
		sets = append(sets, "`isEnabled` = ?")
		args = append(args, *update.IsEnabled)
	}
	return sets, args
}

func joinComma(values []string) string {
	out := ""
	for index, value := range values {
		if index > 0 {
			out += ", "
		}
		out += value
	}
	return out
}

func (s *Service) loadFetchConfigByItemID(ctx context.Context, itemID string) (FetchConfig, error) {
	row := s.db.QueryRowContext(ctx,
		"SELECT f.`id`,f.`frequency`,f.`repeatCron`,f.`isEnabled`,f.`lastRunAt`,f.`lastStatus`,f.`lastError`,"+
			"i.`id`,i.`slug`,i.`displayName`,i.`description`,i.`sourceFunction`,i.`sourceEndpoint`,i.`sourceDocUrl`,i.`valueType`,i.`defaultUnit`,i.`defaultFrequency`,i.`isActive`,i.`metadata`,i.`groupLabel` "+
			"FROM `EconomicDataFetchConfig` f INNER JOIN `EconomicDataItem` i ON i.`id` = f.`itemId` WHERE f.`itemId` = ? LIMIT 1", itemID)
	return scanFetchConfigWithItem(row)
}

type combinedScanner interface {
	Scan(dest ...any) error
}

func scanFetchConfigWithItem(row combinedScanner) (FetchConfig, error) {
	var (
		config      FetchConfig
		repeatCron  sql.NullString
		lastRun     sql.NullTime
		lastStatus  sql.NullString
		lastError   sql.NullString
		item        ItemRow
		description sql.NullString
		docURL      sql.NullString
		unit        sql.NullString
		groupLabel  sql.NullString
	)
	if err := row.Scan(&config.ID, &config.Frequency, &repeatCron, &config.IsEnabled, &lastRun, &lastStatus, &lastError,
		&item.ID, &item.Slug, &item.DisplayName, &description, &item.SourceFunction, &item.SourceEndpoint, &docURL,
		&item.ValueType, &unit, &item.DefaultFrequency, &item.IsActive, &item.Metadata, &groupLabel); err != nil {
		return FetchConfig{}, err
	}
	if repeatCron.Valid {
		config.RepeatCron = &repeatCron.String
	}
	if lastRun.Valid {
		config.LastRunAt = &lastRun.Time
	}
	if lastStatus.Valid {
		status := RunStatus(lastStatus.String)
		config.LastStatus = &status
	}
	if lastError.Valid {
		config.LastError = &lastError.String
	}
	if description.Valid {
		item.Description = &description.String
	}
	if docURL.Valid {
		item.SourceDocURL = &docURL.String
	}
	if unit.Valid {
		item.DefaultUnit = &unit.String
	}
	if groupLabel.Valid {
		item.GroupLabel = &groupLabel.String
	}
	config.Item = FetchConfigItem{
		Slug:        item.Slug,
		DisplayName: item.DisplayName,
		GroupLabel:  item.GroupLabel,
		DefaultUnit: item.DefaultUnit,
		Metadata:    json.RawMessage(item.Metadata),
	}
	return config, nil
}

// FetchConfigs returns every fetch config in the same updatedAt-descending order
// as listFetchConfigs.
func (s *Service) FetchConfigs(ctx context.Context) ([]FetchConfig, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("economicdata: mysql is not configured")
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT f.`id`,f.`frequency`,f.`repeatCron`,f.`isEnabled`,f.`lastRunAt`,f.`lastStatus`,f.`lastError`,"+
			"i.`id`,i.`slug`,i.`displayName`,i.`description`,i.`sourceFunction`,i.`sourceEndpoint`,i.`sourceDocUrl`,i.`valueType`,i.`defaultUnit`,i.`defaultFrequency`,i.`isActive`,i.`metadata`,i.`groupLabel` "+
			"FROM `EconomicDataFetchConfig` f INNER JOIN `EconomicDataItem` i ON i.`id` = f.`itemId` ORDER BY f.`updatedAt` DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]FetchConfig, 0)
	for rows.Next() {
		config, err := scanFetchConfigWithItem(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, config)
	}
	return out, rows.Err()
}

var errNoRedis = errors.New("economicdata: redis is not configured")

type requestIPKey struct{}

// WithRequestIP attaches the client IP to the GraphQL request context. The
// preset mutation uses it only for the best-effort AuditLog row.
func WithRequestIP(ctx context.Context, ip string) context.Context {
	if ctx == nil || ip == "" {
		return ctx
	}
	return context.WithValue(ctx, requestIPKey{}, ip)
}

// RequestIPFromContext returns the client IP attached by WithRequestIP.
func RequestIPFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	value, _ := ctx.Value(requestIPKey{}).(string)
	return value
}
