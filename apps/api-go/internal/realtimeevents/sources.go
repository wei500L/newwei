package realtimeevents

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlsubscriptions"
)

// Namespaces served by realtimesocket. They are repeated here because the
// event payloads and the local push target have to agree with the transport.
const (
	NamespaceNewsnow          = "/newsnow"
	NamespaceOps              = "/ops"
	NamespaceQuality          = "/quality"
	NamespaceQueue            = "/queue"
	NamespaceSituationMonitor = "/situation-monitor"
)

// DefaultBridgeChannel is the Redis channel the NestJS situation-monitor
// dispatcher publishes on when API_GO_REALTIME_SOCKET_MODE=go.
const DefaultBridgeChannel = "situation-monitor:signals:events:v1"

// DefaultAdapterKey mirrors the NestJS WS_REDIS_ADAPTER_KEY default.
const DefaultAdapterKey = "socket.io"

// Sink is implemented by realtimesocket.Runtime. Every method is a strictly
// local operation: it walks the connections owned by this process and writes
// one Socket.IO EVENT frame per matching session. It never publishes to Redis.
type Sink interface {
	// PublishRooms delivers event to the local namespace sessions in rooms.
	// An empty rooms slice means every local session of the namespace; except
	// rooms are excluded; a session is delivered at most once.
	PublishRooms(namespace string, rooms, except []string, event string, payloadJSON json.RawMessage)
	// PublishOrg is PublishRooms with rooms=["org:<orgID>"].
	PublishOrg(namespace, orgID, event string, payloadJSON json.RawMessage)
	// PublishUser delivers event to the local sessions of that user inside
	// that organization.
	PublishUser(namespace, orgID, userID, event string, payloadJSON json.RawMessage)
	// LocalOrgIDs returns the organizations with at least one local session.
	LocalOrgIDs(namespace string) []string
	// LocalUsers returns the users with at least one local session in orgID.
	LocalUsers(namespace, orgID string) []string
}

// SituationAugmenter augments a situation-monitor payload for a set of users.
// internal/situationsignals.RealtimeAugmenter implements it. A nil augmenter,
// or an error, makes Sources fall back to the unmodified payload exactly like
// the NestJS gateway does when the monitor matcher is unavailable.
type SituationAugmenter interface {
	AugmentRealtime(ctx context.Context, eventType, orgID string, userIDs []string, payloadJSON json.RawMessage) (map[string]json.RawMessage, error)
}

// Options wires the event sources. Zero values are replaced by the NestJS
// defaults; Redis, or a Store plus a way to create the blocking clients, is
// required.
type Options struct {
	// Redis is the shared command client (PUBLISH, SET NX fanout). Required.
	Redis *redis.Client
	// RedisOptions configures the dedicated clients used by XREAD (blocking)
	// and by the subscriptions. When nil, the options of Redis are cloned.
	RedisOptions *redis.Options
	// AdapterKey is WS_REDIS_ADAPTER_KEY. Empty means "socket.io".
	AdapterKey string
	// BridgeChannel overrides the situation-monitor bridge channel.
	BridgeChannel string
	// Store is the BullMQ read surface (XREAD and job hash). When nil, a
	// store is created from RedisOptions and Redis.
	Store graphqlsubscriptions.QueueStore
	// DB resolves the alerts queue orgId (AlertRule / AlertDelivery). When nil
	// the alerts events are dropped with one warning.
	DB *sql.DB
	// Mongo resolves the analysis/assistant queue orgId (analysisresults and
	// assistantruns documents). When nil those events are dropped with one
	// warning.
	Mongo *mongo.Database
	// Situation augments situation-monitor payloads. When nil the original
	// payload is pushed without the monitorMatches fields.
	Situation SituationAugmenter
	// NewsnowSourcesGo mirrors API_GO_NEWSNOW_SOURCES_MODE=="go". When false and
	// the realtime transport is in go mode, no newsnow producer can produce
	// events; Sources logs one warning at Start and keeps running.
	NewsnowSourcesGo bool
	// KnownSource validates a newsnow source id against the registry metadata.
	// When nil only the syntax/length rules are applied (documented subset).
	KnownSource func(sourceID string) bool
	// Now and NewUID are test seams; zero values use time.Now and a random
	// 6 character URL-safe id.
	Now    func() time.Time
	NewUID func() (string, error)
}

// Sources owns every event source. It is safe to Start once and Close more
// than once.
type Sources struct {
	options Options
	now     func() time.Time
	newUID  func() (string, error)
	uid     string

	mu       sync.Mutex
	sink     Sink
	started  bool
	cancel   context.CancelFunc
	wg       sync.WaitGroup
	closers  []func()
	timeouts struct {
		subscribe time.Duration
	}

	// newsnow holds the local active-source registry populated from browser
	// events forwarded by realtimesocket.
	newsnow *newsnowRegistry

	// pubsub connections, owned by this package.
	adapterSub *redis.PubSub
	refreshSub *redis.PubSub
	bridgeSub  *redis.PubSub

	// store is the BullMQ read surface. ownedStore records that Close must
	// release it (the injected one belongs to the caller).
	store      graphqlsubscriptions.QueueStore
	ownedStore bool
	// redisOps is the Redis surface of the newsnow relay path (fanout claim and
	// adapter publish); tests inject a fake.
	redisOps redisOps

	pipelineContext *graphqlsubscriptions.PipelineJobContextResolver
	orgResolvers    map[string]queueContextResolver
}

// New validates the options and builds the source set. It opens no connection.
func New(options Options) (*Sources, error) {
	if options.Redis == nil {
		return nil, errors.New("realtimeevents: Redis client is required")
	}
	if options.AdapterKey == "" {
		options.AdapterKey = DefaultAdapterKey
	}
	if options.BridgeChannel == "" {
		options.BridgeChannel = DefaultBridgeChannel
	}
	if options.RedisOptions == nil {
		cloned := *options.Redis.Options()
		options.RedisOptions = &cloned
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	newUID := options.NewUID
	if newUID == nil {
		newUID = randomAdapterUID
	}
	uid, err := newUID()
	if err != nil {
		return nil, err
	}
	sources := &Sources{
		options:  options,
		now:      now,
		newUID:   newUID,
		uid:      uid,
		newsnow:  newNewsnowRegistry(),
		redisOps: redisClientOps{client: options.Redis},
	}
	sources.timeouts.subscribe = 5 * time.Second
	return sources, nil
}

// Start wires the subscriptions and starts the queue stream readers. It is
// idempotent: a second call after a successful start returns nil. The context
// bounds the lifetime: cancelling it stops every reader (Close is still needed
// to release the connections).
func (s *Sources) Start(ctx context.Context, sink Sink) error {
	if s == nil {
		return errors.New("realtimeevents: nil Sources")
	}
	if sink == nil {
		return errors.New("realtimeevents: Sink is required")
	}
	s.mu.Lock()
	if s.started {
		s.mu.Unlock()
		return nil
	}
	s.started = true
	s.sink = sink
	runCtx, cancel := context.WithCancel(ctx)
	s.cancel = cancel
	s.mu.Unlock()

	if err := s.openSubscriptions(runCtx); err != nil {
		s.shutdown()
		s.mu.Lock()
		s.started = false
		s.sink = nil
		s.mu.Unlock()
		return err
	}
	s.startQueueReaders(runCtx)
	if !s.options.NewsnowSourcesGo {
		log.Printf("realtimeevents: newsnow realtime events cannot be produced: API_GO_NEWSNOW_SOURCES_MODE is not go, so the NestJS active-source registry is empty; newsnow namespace keeps serving connections without updates")
	}
	return nil
}

// Close stops every reader and closes the connections owned by this package.
// The shared Redis client from Options is not closed.
func (s *Sources) Close() error {
	if s == nil {
		return nil
	}
	s.shutdown()
	return nil
}

func (s *Sources) shutdown() {
	s.mu.Lock()
	cancel := s.cancel
	s.cancel = nil
	closers := s.closers
	s.closers = nil
	s.adapterSub = nil
	s.refreshSub = nil
	s.bridgeSub = nil
	s.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	for index := len(closers) - 1; index >= 0; index-- {
		closers[index]()
	}
	if s.ownedStore && s.store != nil {
		_ = s.store.Close()
		s.store = nil
	}
	s.wg.Wait()
}

// sink returns the injected sink, or nil before Start.
func (s *Sources) sinkSnapshot() Sink {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sink
}

// registerCloser records a cleanup that shutdown must run.
func (s *Sources) registerCloser(closer func()) {
	if closer == nil {
		return
	}
	s.mu.Lock()
	s.closers = append(s.closers, closer)
	s.mu.Unlock()
}

// redisOps is the Redis surface the newsnow source-refresh relay needs: the
// per (refresh, organization) fanout claim and the adapter broadcast publish.
type redisOps interface {
	Claim(ctx context.Context, key string, ttl time.Duration) (bool, error)
	Publish(ctx context.Context, channel string, payload []byte) error
}

// redisClientOps is redisOps over the shared go-redis client.
type redisClientOps struct {
	client *redis.Client
}

func (o redisClientOps) Claim(ctx context.Context, key string, ttl time.Duration) (bool, error) {
	return o.client.SetNX(ctx, key, "1", ttl).Result()
}

func (o redisClientOps) Publish(ctx context.Context, channel string, payload []byte) error {
	return o.client.Publish(ctx, channel, payload).Err()
}

// newBlockingStore creates the QueueStore backed by a dedicated blocking
// client (owned by the QueueStore itself).
func (s *Sources) newBlockingStore() graphqlsubscriptions.QueueStore {
	s.ownedStore = true
	return graphqlsubscriptions.NewRedisQueueStore(s.options.RedisOptions, s.options.Redis)
}
