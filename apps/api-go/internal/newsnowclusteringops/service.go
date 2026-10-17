package newsnowclusteringops

import (
	"context"
	"database/sql"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/personalnews"
)

const (
	// maxPersonalizedOrderSources mirrors MAX_PERSONALIZED_ORDER_SOURCES.
	maxPersonalizedOrderSources = 240
	// defaultOpinionIndexHours mirrors DEFAULT_TREND_HOURS.
	defaultOpinionIndexHours = 24
	// maxOpinionIndexHours mirrors MAX_TREND_HOURS.
	maxOpinionIndexHours = 168
)

// Service owns the nine migrated endpoints. Every dependency is injected so the
// handler stays free of configuration and connection handling.
type Service struct {
	cfg        ServiceConfig
	db         *sql.DB
	mongo      *mongo.Database
	redis      *redis.Client
	clustering *clusteringStore
	resolver   *urlResolver
	ordering   *SourceOrderingService
}

// NewService wires the service. db, mongoDB and redisClient must be non-nil in
// go mode; behavior may be nil, in which case personalized ordering degrades to
// manual ordering.
func NewService(cfg ServiceConfig, db *sql.DB, mongoDB *mongo.Database, redisClient *redis.Client, behavior personalnews.BehaviorAPI) *Service {
	service := &Service{
		cfg:        cfg,
		db:         db,
		mongo:      mongoDB,
		redis:      redisClient,
		clustering: newClusteringStore(mongoDB, db),
	}
	service.resolver = newURLResolver(newMongoResolveStore(mongoDB, db), newRedisResolveCache(redisClient))
	service.ordering = NewSourceOrderingService(db, redisClient, behavior)
	return service
}

// metadata returns the deterministic NewsNow metadata payload.
func (s *Service) metadata() metadataResponse {
	return buildMetadata()
}

// resolve performs the URL reverse lookup.
func (s *Service) resolve(ctx context.Context, normalizedURL string) (ResolveResponse, error) {
	return s.resolver.resolveByURL(ctx, normalizedURL)
}

// orderSources computes the personalized source order of one user.
func (s *Service) orderSources(ctx context.Context, orgID, userID string, request PersonalizationRequest) (PersonalizedOrderPayload, error) {
	if s.ordering == nil {
		return PersonalizedOrderPayload{}, newHTTPError(500, "NewsNow personalized ordering is unavailable")
	}
	return s.ordering.OrderSources(ctx, orgID, userID, request)
}

// domesticOpinionIndex returns the blended domestic opinion index.
func (s *Service) domesticOpinionIndex(ctx context.Context, orgID string, hours int) (DomesticOpinionIndexResponse, error) {
	now := time.Now().UTC()
	effectiveHours := hours
	if effectiveHours <= 0 {
		effectiveHours = defaultOpinionIndexHours
	}
	if effectiveHours > maxOpinionIndexHours {
		effectiveHours = maxOpinionIndexHours
	}
	since := now.Add(-time.Duration(effectiveHours) * time.Hour)

	snapshots, err := s.loadOpinionSnapshots(ctx, orgID, since)
	if err != nil {
		return DomesticOpinionIndexResponse{}, err
	}
	articles, err := s.loadOpinionArticles(ctx, orgID, since)
	if err != nil {
		return DomesticOpinionIndexResponse{}, err
	}
	signals, err := s.loadProcessedItemSignalMap(ctx, articles)
	if err != nil {
		return DomesticOpinionIndexResponse{}, err
	}

	var candidates []opinionCandidateRow
	if len(snapshots) > 0 {
		candidates, err = s.loadOpinionCandidates(ctx, orgID, snapshots[len(snapshots)-1].BucketStart)
		if err != nil {
			return DomesticOpinionIndexResponse{}, err
		}
	}
	return BuildDomesticOpinionIndex(effectiveHours, now, snapshots, candidates, articles, signals), nil
}

// loadProcessedItemSignalMap collects the ProcessedItem ids referenced by the
// pipeline articles and loads their sentiment/source hints in one Mongo read.
func (s *Service) loadProcessedItemSignalMap(ctx context.Context, articles []opinionPipelineArticleRow) (map[string]processedItemSignal, error) {
	ids := make([]string, 0, len(articles))
	for _, article := range articles {
		if article.CleanedMarkdownRef == nil {
			continue
		}
		trimmed := strings.TrimSpace(*article.CleanedMarkdownRef)
		if trimmed != "" {
			ids = append(ids, trimmed)
		}
	}
	return s.clustering.loadProcessedItemSignals(ctx, ids)
}

// validateHTTPURL mirrors the controller's validateHttpUrl: it rejects a missing
// value, a value that is not an absolute URL, and a non-http(s) protocol, then
// returns the WHATWG-normalized URL.
func validateHTTPURL(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", newHTTPError(400, "url query is required")
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", newHTTPError(400, "url must be a valid absolute URL")
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme == "" {
		// A relative reference such as "foo/bar" is not an absolute URL, which
		// is what `new URL(value)` without a base reports.
		return "", newHTTPError(400, "url must be a valid absolute URL")
	}
	if scheme != "http" && scheme != "https" {
		return "", newHTTPError(400, "url protocol must be http or https")
	}
	if parsed.Host == "" {
		// A special scheme without a host ("http://", "http:/foo") is rejected
		// by the WHATWG parser as well.
		return "", newHTTPError(400, "url must be a valid absolute URL")
	}
	normalized, ok := parseJSURL(trimmed)
	if !ok {
		return "", newHTTPError(400, "url must be a valid absolute URL")
	}
	return normalized.String(), nil
}

// validateColumnKey mirrors the controller's validateColumnKey.
func validateColumnKey(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", newHTTPError(400, "column is required")
	}
	normalized := strings.ToLower(strings.TrimSpace(raw))
	if !isColumnID(normalized) {
		return "", newHTTPError(400, "invalid column format")
	}
	return normalized, nil
}

// isColumnID implements /^[a-z0-9_-]{1,64}$/i over an already lowered value.
func isColumnID(value string) bool {
	if len(value) == 0 || len(value) > 64 {
		return false
	}
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9':
		case r == '_' || r == '-':
		default:
			return false
		}
	}
	return true
}

// isSourceID implements /^[a-z0-9_-]+$/i.
func isSourceID(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '_' || r == '-':
		default:
			return false
		}
	}
	return true
}

// parseOptionalPositiveInt mirrors the controller's parseOptionalPositiveInt:
// it returns nil for an absent value, and applies the JavaScript parseInt
// prefix semantics (so "24abc" parses as 24) before the range check.
func parseOptionalPositiveInt(raw *string, fieldName string, min, max int) (*int, error) {
	if raw == nil || *raw == "" {
		return nil, nil
	}
	parsed, ok := parseIntPrefix(strings.TrimSpace(*raw))
	if !ok || parsed < min || parsed > max {
		return nil, newHTTPError(400, fieldName+" must be an integer between "+strconv.Itoa(min)+" and "+strconv.Itoa(max))
	}
	return &parsed, nil
}

// parseIntPrefix mirrors Number.parseInt: an optional sign followed by at least
// one decimal digit, ignoring any trailing characters.
func parseIntPrefix(value string) (int, bool) {
	end := 0
	for end < len(value) && (value[end] == '+' || value[end] == '-' || value[end] == ' ' || value[end] == '\t') {
		end++
	}
	digitsStart := end
	for end < len(value) && value[end] >= '0' && value[end] <= '9' {
		end++
	}
	if end == digitsStart {
		return 0, false
	}
	parsed, err := strconv.Atoi(value[:end])
	if err != nil {
		return 0, false
	}
	return parsed, true
}
