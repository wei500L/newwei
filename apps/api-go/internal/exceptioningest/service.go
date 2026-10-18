package exceptioningest

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// errMongoNotConfigured is logged by the best-effort insert when the takeover
// has no Mongo collection wired.
var errMongoNotConfigured = errors.New("mongo is not configured")

// Config carries the runtime values the takeover needs: the two rate limit
// buckets, the proxy trust setting and the LiteLLM internal token.
type Config struct {
	// UserRateLimit and IPRateLimit are
	// OBSERVABILITY_CLIENT_EXCEPTION_USER_RATE_LIMIT /
	// OBSERVABILITY_CLIENT_EXCEPTION_IP_RATE_LIMIT (defaults 30 / 120).
	UserRateLimit int
	IPRateLimit   int
	// RateLimitWindowSeconds is
	// OBSERVABILITY_CLIENT_EXCEPTION_RATE_LIMIT_WINDOW_SECONDS (default 60).
	RateLimitWindowSeconds int
	// TrustProxy is TRUST_PROXY, used by clientIP.
	TrustProxy string
	// InternalToken is LITELLM_CONFIG_INTERNAL_TOKEN (raw). A missing value
	// stays an endpoint-level 403.
	InternalToken string
}

// Service writes normalized reports into the shared exceptionevents collection
// and owns the two rate limit buckets. The Mongo collection and the Redis
// client are the ones the process already opened.
type Service struct {
	events        *mongo.Collection
	redis         *redis.Client
	config        Config
	trustProxy    string
	internalToken string
}

// NewService builds the takeover service. A nil database leaves events nil;
// the insert then only logs, matching the best-effort contract.
func NewService(database *mongo.Database, redisClient *redis.Client, cfg Config) *Service {
	service := &Service{
		redis:         redisClient,
		config:        cfg,
		trustProxy:    cfg.TrustProxy,
		internalToken: cfg.InternalToken,
	}
	if database != nil {
		service.events = database.Collection(exceptionEventsCollection)
	}
	return service
}

// exceptionEventsCollection is the Mongoose 8 default collection name for the
// ExceptionEvent model (no explicit collection is declared).
const exceptionEventsCollection = "exceptionevents"

// RecordClient stores one client-endpoint report. orgId/userId come from the
// authenticated identity, never from the request body, and the client stack is
// not persisted.
func (s *Service) RecordClient(ctx context.Context, orgID, userID string, event ExceptionEvent) {
	event.OrgID = orgID
	event.UserID = userID
	event.Stack = ""
	s.insert(ctx, event)
}

// RecordInternal stores one internal-endpoint report, including the caller
// supplied orgId/userId and stack.
func (s *Service) RecordInternal(ctx context.Context, event ExceptionEvent) {
	s.insert(ctx, event)
}

// insert performs exactly one InsertOne attempt. Failures are logged and do not
// change the response contract; there is no retry, queue or background writer.
func (s *Service) insert(ctx context.Context, event ExceptionEvent) {
	if s == nil || s.events == nil {
		log.Printf("exceptioningest: %v", errMongoNotConfigured)
		return
	}
	if _, err := s.events.InsertOne(ctx, buildDocument(event)); err != nil {
		log.Printf("exceptioningest: exception event insert failed: %v", err)
	}
}

// buildDocument turns a normalized report into the fixed Mongo document shape.
// timestamp/createdAt/updatedAt are BSON Dates so the existing admin read
// endpoints can query them unchanged.
func buildDocument(event ExceptionEvent) eventDocument {
	now := time.Now().UTC()
	return eventDocument{
		ID:            newUUID(),
		OrgID:         event.OrgID,
		UserID:        event.UserID,
		Kind:          event.Kind,
		TraceID:       event.TraceID,
		Timestamp:     event.Timestamp.UTC(),
		StatusCode:    event.StatusCode,
		Message:       event.Message,
		Path:          event.Path,
		Method:        event.Method,
		Operation:     event.Operation,
		OperationName: event.OperationName,
		ErrorName:     event.ErrorName,
		Stack:         event.Stack,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
}

// newUUID returns a canonical random (v4) UUID string, matching
// crypto.randomUUID() used by ExceptionEventsService.
func newUUID() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 10)
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16])
}
