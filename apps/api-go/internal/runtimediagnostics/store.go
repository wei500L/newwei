package runtimediagnostics

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Redis keys shared with RealtimeSignalsSnapshotStore.
const (
	insightKeyPrefix   = "realtime-signals:insights:"
	lastRunKeyPrefix   = "realtime-signals:last-run:"
	sourceStatePrefix  = "realtime-signals:source-state:"
	seriesKeyPrefix    = "realtime-signals:series:"
	adsbLatestPrefix   = "realtime-signals:opensky-latest:"
	aisLatestPrefix    = "realtime-signals:ais-latest:"
	openskyCreditsKey  = "realtime-signals:opensky:credits:"
	processedItemsColl = "processeditems"
)

// diagnosticContext is the extension JSON object stored on metric points and
// source-state rows. It stays raw so unknown members survive a round trip, while
// the typed accessors below read only the fields the status resolver needs.
type diagnosticContext map[string]json.RawMessage

func (c diagnosticContext) merge(other diagnosticContext) diagnosticContext {
	if len(c) == 0 && len(other) == 0 {
		return nil
	}
	out := make(diagnosticContext, len(c)+len(other))
	for key, value := range c {
		out[key] = value
	}
	for key, value := range other {
		out[key] = value
	}
	return out
}

func (c diagnosticContext) str(key string) (string, bool) {
	raw, ok := c[key]
	if !ok {
		return "", false
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return "", false
	}
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", false
	}
	return trimmed, true
}

func (c diagnosticContext) boolean(key string) (bool, bool) {
	raw, ok := c[key]
	if !ok {
		return false, false
	}
	var value bool
	if json.Unmarshal(raw, &value) != nil {
		return false, false
	}
	return value, true
}

func (c diagnosticContext) number(key string) (float64, bool) {
	raw, ok := c[key]
	if !ok {
		return 0, false
	}
	var number float64
	if json.Unmarshal(raw, &number) == nil {
		return number, true
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		parsed, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
		if err == nil {
			return parsed, true
		}
	}
	return 0, false
}

func (c diagnosticContext) object(key string) (map[string]json.RawMessage, bool) {
	raw, ok := c[key]
	if !ok {
		return nil, false
	}
	var value map[string]json.RawMessage
	if json.Unmarshal(raw, &value) != nil {
		return nil, false
	}
	return value, true
}

// sourceState is the RealtimeSignalSourceState stored by the collectors.
type sourceState struct {
	Source          string            `json:"source"`
	Status          string            `json:"status"`
	LastAttemptAt   *string           `json:"lastAttemptAt"`
	NextEligibleAt  *string           `json:"nextEligibleAt"`
	LastSuccessAt   *string           `json:"lastSuccessAt"`
	LastErrorAt     *string           `json:"lastErrorAt"`
	LastError       *string           `json:"lastError"`
	LastErrorCode   *string           `json:"lastErrorCode"`
	LastErrorKind   *string           `json:"lastErrorKind"`
	LastErrorStatus *float64          `json:"lastErrorStatus"`
	LastRateLimit   json.RawMessage   `json:"lastRateLimit"`
	MetricSlug      *string           `json:"metricSlug"`
	LatestValue     *float64          `json:"latestValue"`
	Context         diagnosticContext `json:"context"`
}

// metricPoint / metricSeries are the cached series documents.
type metricPoint struct {
	TS      string            `json:"ts"`
	Value   float64           `json:"value"`
	Context diagnosticContext `json:"context"`
}

type metricSeries struct {
	MetricSlug string            `json:"metricSlug"`
	Points     []json.RawMessage `json:"points"`
}

// adsbSnapshot is the cached OpenSky/ADS-B latest snapshot (only the members the
// diagnostics response needs).
type adsbSnapshot struct {
	UpdatedAt          string          `json:"updatedAt"`
	LatestObservedAt   *string         `json:"latestObservedAt"`
	TotalAircraft      int             `json:"totalAircraft"`
	ValidPositionCount int             `json:"validPositionCount"`
	Diagnostics        adsbDiagnostics `json:"diagnostics"`
}

type adsbDiagnostics struct {
	LatestObservedAt         *string `json:"latestObservedAt"`
	StaleThresholdSec        int     `json:"staleThresholdSec"`
	DroppedInvalidPosition   int     `json:"droppedInvalidPositionCount"`
	DroppedMissingIdentity   int     `json:"droppedMissingIdentityCount"`
	DroppedStalePosition     int     `json:"droppedStalePositionCount"`
	DeduplicatedCount        int     `json:"deduplicatedCount"`
	RetainedPreviousSnapshot bool    `json:"retainedPreviousSnapshot"`
}

// aisSnapshot is the cached AIS latest snapshot.
type aisSnapshot struct {
	UpdatedAt         string              `json:"updatedAt"`
	HasVesselSnapshot bool                `json:"hasVesselSnapshot"`
	Status            aisStatus           `json:"status"`
	Diagnostics       aisRelayDiagnostics `json:"diagnostics"`
	Disruptions       []json.RawMessage   `json:"disruptions"`
	Density           []json.RawMessage   `json:"density"`
	CandidateReports  []json.RawMessage   `json:"candidateReports"`
}

type aisStatus struct {
	Connected       bool `json:"connected"`
	Vessels         int  `json:"vessels"`
	Messages        int  `json:"messages"`
	Clients         int  `json:"clients"`
	DroppedMessages int  `json:"droppedMessages"`
}

type aisRelayDiagnostics struct {
	HealthState              string  `json:"healthState"`
	StatusReason             *string `json:"statusReason"`
	StatusReasonCode         *string `json:"statusReasonCode"`
	PositionReportsSeen      int     `json:"positionReportsSeen"`
	PositionReportsProcessed int     `json:"positionReportsProcessed"`
	IgnoredPositionReports   int     `json:"ignoredPositionReports"`
	ParseErrors              int     `json:"parseErrors"`
	LastHealthyAt            *string `json:"lastHealthyAt"`
	LastIssueAt              *string `json:"lastIssueAt"`
	LastConnectedAt          *string `json:"lastConnectedAt"`
	LastMessageAt            *string `json:"lastMessageAt"`
	LastUpstreamErrorAt      *string `json:"lastUpstreamErrorAt"`
	LastUpstreamError        *string `json:"lastUpstreamError"`
	LastParseErrorAt         *string `json:"lastParseErrorAt"`
	LastParseError           *string `json:"lastParseError"`
}

// realtimeStore reads the shared Redis documents. It never writes.
type realtimeStore struct {
	redis *redis.Client
	db    *sql.DB
	mongo *mongo.Database
}

func newRealtimeStore(redisClient *redis.Client, db *sql.DB, mongoDB *mongo.Database) *realtimeStore {
	return &realtimeStore{redis: redisClient, db: db, mongo: mongoDB}
}

func (s *realtimeStore) get(ctx context.Context, key string) ([]byte, bool, error) {
	if s == nil || s.redis == nil {
		return nil, false, errors.New("runtimediagnostics: redis is not configured")
	}
	raw, err := s.redis.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if len(raw) == 0 || string(raw) == "null" {
		return nil, false, nil
	}
	return raw, true, nil
}

func (s *realtimeStore) insight(ctx context.Context, orgID string) (json.RawMessage, error) {
	raw, found, err := s.get(ctx, insightKeyPrefix+orgID)
	if err != nil || !found {
		return nil, err
	}
	return json.RawMessage(raw), nil
}

func (s *realtimeStore) lastRun(ctx context.Context, orgID, source string) (*float64, error) {
	raw, found, err := s.get(ctx, lastRunKeyPrefix+orgID+":"+source)
	if err != nil || !found {
		return nil, err
	}
	value, err := strconv.ParseFloat(strings.TrimSpace(string(raw)), 64)
	if err != nil {
		return nil, nil
	}
	return &value, nil
}

func (s *realtimeStore) sourceState(ctx context.Context, orgID, source string) (*sourceState, error) {
	raw, found, err := s.get(ctx, sourceStatePrefix+orgID+":"+source)
	if err != nil || !found {
		return nil, err
	}
	var state sourceState
	if err := json.Unmarshal(raw, &state); err != nil {
		return nil, err
	}
	return &state, nil
}

func (s *realtimeStore) series(ctx context.Context, orgID, metricSlug string) ([]metricPoint, error) {
	raw, found, err := s.get(ctx, seriesKeyPrefix+orgID+":"+metricSlug)
	if err != nil || !found {
		return nil, err
	}
	var series metricSeries
	if err := json.Unmarshal(raw, &series); err != nil {
		return nil, err
	}
	points := make([]metricPoint, 0, len(series.Points))
	for _, raw := range series.Points {
		var entry struct {
			TS      *string           `json:"ts"`
			Value   json.RawMessage   `json:"value"`
			Context diagnosticContext `json:"context"`
		}
		if err := json.Unmarshal(raw, &entry); err != nil {
			continue
		}
		if entry.TS == nil || strings.TrimSpace(*entry.TS) == "" {
			continue
		}
		var value float64
		if err := json.Unmarshal(entry.Value, &value); err != nil {
			continue
		}
		points = append(points, metricPoint{TS: *entry.TS, Value: value, Context: entry.Context})
	}
	// Stable sort by ts, matching the store's localeCompare ordering.
	sortPoints(points)
	return points, nil
}

func (s *realtimeStore) latestAdsb(ctx context.Context, orgID string) (*adsbSnapshot, error) {
	raw, found, err := s.get(ctx, adsbLatestPrefix+orgID)
	if err != nil || !found {
		return nil, err
	}
	var snapshot adsbSnapshot
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return nil, err
	}
	return &snapshot, nil
}

func (s *realtimeStore) latestAis(ctx context.Context, orgID string) (*aisSnapshot, error) {
	raw, found, err := s.get(ctx, aisLatestPrefix+orgID)
	if err != nil || !found {
		return nil, err
	}
	var snapshot aisSnapshot
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return nil, err
	}
	return &snapshot, nil
}

// openskyBudgetDay is one day's credit counters (HGETALL of the shared hash).
type openskyBudgetDay struct {
	DateHKT               string
	UsedCredits           float64
	RequestCount          float64
	MilitaryCredits       float64
	AllCredits            float64
	MilitaryCalls         float64
	AllCalls              float64
	ErrorCalls            float64
	AuthErrorCalls        float64
	RateLimitedErrorCalls float64
	ServerErrorCalls      float64
	TimeoutErrorCalls     float64
	NetworkErrorCalls     float64
	UnknownErrorCalls     float64
	BlockedAllModeCount   float64
	SkippedMilitaryCount  float64
}

func (s *realtimeStore) budgetDay(ctx context.Context, date string) (openskyBudgetDay, error) {
	day := openskyBudgetDay{DateHKT: date}
	if s == nil || s.redis == nil {
		return day, errors.New("runtimediagnostics: redis is not configured")
	}
	payload, err := s.redis.HGetAll(ctx, openskyCreditsKey+date).Result()
	if err != nil {
		return day, err
	}
	read := func(field string) float64 {
		value, parseErr := strconv.ParseFloat(strings.TrimSpace(payload[field]), 64)
		if parseErr != nil {
			return 0
		}
		return value
	}
	day.UsedCredits = read("usedCredits")
	day.RequestCount = read("requestCount")
	day.MilitaryCredits = read("militaryCredits")
	day.AllCredits = read("allCredits")
	day.MilitaryCalls = read("militaryCalls")
	day.AllCalls = read("allCalls")
	day.ErrorCalls = read("errorCalls")
	day.AuthErrorCalls = read("authErrorCalls")
	day.RateLimitedErrorCalls = read("rateLimitedErrorCalls")
	day.ServerErrorCalls = read("serverErrorCalls")
	day.TimeoutErrorCalls = read("timeoutErrorCalls")
	day.NetworkErrorCalls = read("networkErrorCalls")
	day.UnknownErrorCalls = read("unknownErrorCalls")
	day.BlockedAllModeCount = read("blockedAllModeCount")
	day.SkippedMilitaryCount = read("skippedMilitaryCount")
	return day, nil
}

// ---- marker readiness ----

// markerReadiness is the GET response section. Optional timestamps are omitted
// when the underlying query failed or returned nothing.
type markerReadiness struct {
	WindowHours                           int     `json:"windowHours"`
	RecentProcessedArticles               int     `json:"recentProcessedArticles"`
	RecentProcessedArticlesWithLocation   int     `json:"recentProcessedArticlesWithLocation"`
	RecentMongoProcessedItems             int     `json:"recentMongoProcessedItems"`
	RecentMongoProcessedItemsWithLocation int     `json:"recentMongoProcessedItemsWithLocation"`
	LatestProcessedArticleAt              *string `json:"latestProcessedArticleAt,omitempty"`
	LatestProcessedItemAt                 *string `json:"latestProcessedItemAt,omitempty"`
	NewsMarkersReady                      bool    `json:"newsMarkersReady"`
}

// readMarkerReadiness mirrors getMarkerReadiness: both halves degrade to zeros
// independently and never fail the diagnostics.
func (s *realtimeStore) readMarkerReadiness(ctx context.Context, orgID string, now time.Time) markerReadiness {
	since := now.Add(-markerWindowHours * time.Hour)
	result := markerReadiness{WindowHours: markerWindowHours}

	if s.db != nil {
		type mysqlCounts struct {
			total        int
			withLocation int
			latest       *time.Time
			ok           bool
		}
		ch := make(chan mysqlCounts, 1)
		go func() {
			var counts mysqlCounts
			var total int
			if err := s.db.QueryRowContext(ctx,
				"SELECT COUNT(*) FROM ProcessedArticle WHERE orgId = ? AND status = 'completed' AND processedAt >= ?",
				orgID, since).Scan(&total); err != nil {
				log.Printf("runtimediagnostics: marker readiness mysql read failed")
				ch <- counts
				return
			}
			var withLocation int
			if err := s.db.QueryRowContext(ctx,
				"SELECT COUNT(*) FROM ProcessedArticle WHERE orgId = ? AND status = 'completed' AND processedAt >= ? AND hasLocation = 1",
				orgID, since).Scan(&withLocation); err != nil {
				ch <- counts
				return
			}
			var latest sql.NullTime
			if err := s.db.QueryRowContext(ctx,
				"SELECT processedAt FROM ProcessedArticle WHERE orgId = ? AND status = 'completed' ORDER BY processedAt DESC LIMIT 1",
				orgID).Scan(&latest); err != nil {
				ch <- counts
				return
			}
			counts.total = total
			counts.withLocation = withLocation
			counts.ok = true
			if latest.Valid {
				value := latest.Time.UTC()
				counts.latest = &value
			}
			ch <- counts
		}()
		counts := <-ch
		if counts.ok {
			result.RecentProcessedArticles = counts.total
			result.RecentProcessedArticlesWithLocation = counts.withLocation
			if counts.latest != nil {
				iso := counts.latest.Format("2006-01-02T15:04:05.000Z")
				result.LatestProcessedArticleAt = &iso
			}
		}
	}

	if s.mongo != nil {
		recent, withLocation, latest := s.mongoMarkerReadiness(ctx, orgID, since)
		result.RecentMongoProcessedItems = recent
		result.RecentMongoProcessedItemsWithLocation = withLocation
		result.LatestProcessedItemAt = latest
	}

	result.NewsMarkersReady = result.RecentProcessedArticlesWithLocation > 0 ||
		result.RecentMongoProcessedItemsWithLocation > 0
	return result
}

// mongoMarkerReadiness mirrors the $match/$group aggregate: completed,
// non-duplicate items inside the 7 day window, counting one extra bucket for
// "has a location".
func (s *realtimeStore) mongoMarkerReadiness(ctx context.Context, orgID string, since time.Time) (int, int, *string) {
	collection := s.mongo.Collection(processedItemsColl)
	timeFilter := bson.D{{Key: "$or", Value: bson.A{
		bson.D{{Key: "sortAt", Value: bson.D{{Key: "$gte", Value: since}}}},
		bson.D{{Key: "ingestedAt", Value: bson.D{{Key: "$gte", Value: since}}}},
		bson.D{{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: since}}}},
	}}}
	baseFilter := bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: "completed"},
		{Key: "duplicateOf", Value: nil},
	}
	recentFilter := append(append(bson.D{}, baseFilter...), timeFilter...)
	locationFilter := bson.D{{Key: "$or", Value: bson.A{
		bson.D{{Key: "hasLocation", Value: true}},
		bson.D{{Key: "$and", Value: bson.A{
			bson.D{{Key: "hasLocation", Value: bson.D{{Key: "$not", Value: bson.D{{Key: "$type", Value: "bool"}}}}}},
			bson.D{{Key: "result.location", Value: bson.D{
				{Key: "$type", Value: "string"},
				{Key: "$regex", Value: "\\S"},
			}}},
		}}},
	}}}
	recentWithLocationFilter := append(append(bson.D{}, recentFilter...), locationFilter...)

	recentCh := make(chan int, 1)
	withLocationCh := make(chan int, 1)
	go func() {
		count, err := collection.CountDocuments(ctx, recentFilter)
		if err != nil {
			log.Printf("runtimediagnostics: marker readiness mongo count failed")
			recentCh <- 0
			return
		}
		recentCh <- int(count)
	}()
	go func() {
		count, err := collection.CountDocuments(ctx, recentWithLocationFilter)
		if err != nil {
			log.Printf("runtimediagnostics: marker readiness mongo location count failed")
			withLocationCh <- 0
			return
		}
		withLocationCh <- int(count)
	}()

	recent := <-recentCh
	withLocation := <-withLocationCh

	var latest *string
	var doc struct {
		SortAt     bson.RawValue `bson:"sortAt"`
		IngestedAt bson.RawValue `bson:"ingestedAt"`
		CreatedAt  bson.RawValue `bson:"createdAt"`
	}
	err := collection.FindOne(ctx, baseFilter,
		options.FindOne().
			SetSort(bson.D{{Key: "sortAt", Value: -1}, {Key: "ingestedAt", Value: -1}, {Key: "createdAt", Value: -1}}).
			SetProjection(bson.D{{Key: "sortAt", Value: 1}, {Key: "ingestedAt", Value: 1}, {Key: "createdAt", Value: 1}}),
	).Decode(&doc)
	if err == nil || errors.Is(err, mongo.ErrNoDocuments) {
		for _, value := range []bson.RawValue{doc.SortAt, doc.IngestedAt, doc.CreatedAt} {
			if iso, ok := bsonTimeISO(value); ok {
				latest = &iso
				break
			}
		}
	}
	return recent, withLocation, latest
}

func bsonTimeISO(value bson.RawValue) (string, bool) {
	switch value.Type {
	case bson.TypeDateTime:
		millis := value.DateTime()
		return time.UnixMilli(millis).UTC().Format("2006-01-02T15:04:05.000Z"), true
	case bson.TypeString:
		parsed, err := time.Parse(time.RFC3339Nano, value.StringValue())
		if err != nil {
			return "", false
		}
		return parsed.UTC().Format("2006-01-02T15:04:05.000Z"), true
	default:
		return "", false
	}
}

func sortPoints(points []metricPoint) {
	sort.SliceStable(points, func(i, j int) bool { return points[i].TS < points[j].TS })
}
