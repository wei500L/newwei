package newsnowhottest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// Store is the narrow Redis surface this package uses: the compatible cache,
// the compatible cache-batch writes, the physical leases and the batch signal
// state read. Keeping it as a port lets the unit tests exercise cache, lock and
// wait behaviour without a Redis server while production keeps one shared
// *redis.Client.
type Store interface {
	Get(ctx context.Context, key string) (value string, found bool, err error)
	MGet(ctx context.Context, keys []string) (values []string, found []bool, err error)
	Set(ctx context.Context, key, value string, ttl time.Duration) error
	SetMany(ctx context.Context, entries []CacheEntry) error
	SetNX(ctx context.Context, key, value string, ttl time.Duration) (bool, error)
	Eval(ctx context.Context, script string, keys []string, args ...string) (int64, error)
}

// CacheEntry is one SET EX member of a batch write.
type CacheEntry struct {
	Key   string
	Value string
	TTL   time.Duration
}

type redisStore struct {
	client *redis.Client
}

// NewRedisStore adapts the shared Redis client to Store. It opens no second
// connection pool.
func NewRedisStore(client *redis.Client) Store { return &redisStore{client: client} }

func (s *redisStore) Get(ctx context.Context, key string) (string, bool, error) {
	value, err := s.client.Get(ctx, key).Result()
	if errors.Is(err, redis.Nil) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return value, true, nil
}

func (s *redisStore) MGet(ctx context.Context, keys []string) ([]string, []bool, error) {
	if len(keys) == 0 {
		return []string{}, []bool{}, nil
	}
	raw, err := s.client.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, nil, err
	}
	values := make([]string, len(raw))
	found := make([]bool, len(raw))
	for index, entry := range raw {
		if entry == nil {
			continue
		}
		switch typed := entry.(type) {
		case string:
			values[index] = typed
			found[index] = true
		case []byte:
			values[index] = string(typed)
			found[index] = true
		default:
			encoded, encodeErr := json.Marshal(typed)
			if encodeErr != nil {
				continue
			}
			values[index] = string(encoded)
			found[index] = true
		}
	}
	return values, found, nil
}

func (s *redisStore) Set(ctx context.Context, key, value string, ttl time.Duration) error {
	return s.client.Set(ctx, key, value, ttl).Err()
}

// SetMany writes every entry in one pipeline. The keys, values and EX TTLs are
// identical to the per-key SET sequence NestJS performs; only the round trips
// are coalesced.
func (s *redisStore) SetMany(ctx context.Context, entries []CacheEntry) error {
	if len(entries) == 0 {
		return nil
	}
	pipeline := s.client.Pipeline()
	for _, entry := range entries {
		pipeline.Set(ctx, entry.Key, entry.Value, entry.TTL)
	}
	_, err := pipeline.Exec(ctx)
	return err
}

func (s *redisStore) SetNX(ctx context.Context, key, value string, ttl time.Duration) (bool, error) {
	return s.client.SetNX(ctx, key, value, ttl).Result()
}

func (s *redisStore) Eval(ctx context.Context, script string, keys []string, args ...string) (int64, error) {
	arguments := make([]interface{}, len(args))
	for index, arg := range args {
		arguments[index] = arg
	}
	return s.client.Eval(ctx, script, keys, arguments...).Int64()
}

// CacheService.withLock scripts. The physical key is `lock:` + key and the value
// is a random v4 UUID, so NestJS and Go exclude each other on the same lease.
const lockKeyPrefix = "lock:"

var lockReleaseScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      end
      return 0
    `

var lockExtendScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      end
      return 0
    `

// lockLease is one held lease.
type lockLease struct {
	store Store
	key   string
	token string
	ttl   time.Duration
}

// acquireLock takes the physical lock. A nil lease means another process owns
// it; an error is a Redis failure.
func acquireLock(ctx context.Context, store Store, key string, ttlMillis int) (*lockLease, error) {
	if ttlMillis < 1000 {
		ttlMillis = 1000
	}
	ttl := time.Duration(ttlMillis) * time.Millisecond
	token, err := newLockToken()
	if err != nil {
		return nil, err
	}
	acquired, err := store.SetNX(ctx, lockKeyPrefix+key, token, ttl)
	if err != nil {
		return nil, err
	}
	if !acquired {
		return nil, nil
	}
	return &lockLease{store: store, key: lockKeyPrefix + key, token: token, ttl: ttl}, nil
}

// startAutoRenew extends the lease every third of its TTL until the returned
// stop function is called, matching CacheService.startAutoRenew.
func (l *lockLease) startAutoRenew() func() {
	if l == nil {
		return func() {}
	}
	interval := l.ttl / 3
	if interval < 500*time.Millisecond {
		interval = 500 * time.Millisecond
	}
	stop := make(chan struct{})
	var once sync.Once
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				_, _ = l.store.Eval(context.Background(), lockExtendScript, []string{l.key},
					l.token, strconv.FormatInt(l.ttl.Milliseconds(), 10))
			}
		}
	}()
	return func() { once.Do(func() { close(stop) }) }
}

// release drops the lease only while the token still matches.
func (l *lockLease) release() {
	if l == nil {
		return
	}
	_, _ = l.store.Eval(context.Background(), lockReleaseScript, []string{l.key}, l.token)
}

// newLockToken produces a random version 4 UUID, the shape Node's randomUUID
// gives the CacheService lease token.
func newLockToken() (string, error) {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	buffer[6] = (buffer[6] & 0x0f) | 0x40
	buffer[8] = (buffer[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(buffer)
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32], nil
}

// safeGetAnalysis reads and decodes one analysis document. Cache and decode
// failures count as a miss with a warning, exactly like safeGet.
func (s *Service) safeGetAnalysis(ctx context.Context, key string) *AnalysisResponse {
	value, found, err := s.store.Get(ctx, key)
	if err != nil {
		s.logf("newsnowhottest: analysis cache read failed key=%s err=%v", key, err)
		return nil
	}
	if !found {
		return nil
	}
	var response AnalysisResponse
	if err := json.Unmarshal([]byte(value), &response); err != nil {
		s.logf("newsnowhottest: analysis cache decode failed key=%s err=%v", key, err)
		return nil
	}
	return &response
}

// safeGetSnapshot reads and decodes one global snapshot.
func (s *Service) safeGetSnapshot(ctx context.Context, key string) *GlobalSnapshot {
	value, found, err := s.store.Get(ctx, key)
	if err != nil {
		s.logf("newsnowhottest: snapshot cache read failed key=%s err=%v", key, err)
		return nil
	}
	if !found {
		return nil
	}
	var snapshot GlobalSnapshot
	if err := json.Unmarshal([]byte(value), &snapshot); err != nil {
		s.logf("newsnowhottest: snapshot cache decode failed key=%s err=%v", key, err)
		return nil
	}
	return &snapshot
}

// safeGetSignature reads the cached signature. The value is a JSON string, the
// shape CacheService.set<string> writes.
func (s *Service) safeGetSignature(ctx context.Context, key string) string {
	value, found, err := s.store.Get(ctx, key)
	if err != nil || !found {
		if err != nil {
			s.logf("newsnowhottest: signature cache read failed key=%s err=%v", key, err)
		}
		return ""
	}
	var signature string
	if err := json.Unmarshal([]byte(value), &signature); err != nil {
		s.logf("newsnowhottest: signature cache decode failed key=%s err=%v", key, err)
		return ""
	}
	return signature
}

// safeGetStates is the batch state read behind buildSignalsFromSeeds. A failed
// MGET returns one nil per key, like safeGetMany.
func (s *Service) safeGetStates(ctx context.Context, keys []string) []*SignalState {
	if len(keys) == 0 {
		return []*SignalState{}
	}
	values, found, err := s.store.MGet(ctx, keys)
	if err != nil {
		s.logf("newsnowhottest: signal state batch read failed count=%d err=%v", len(keys), err)
		return make([]*SignalState, len(keys))
	}
	states := make([]*SignalState, len(keys))
	for index := range keys {
		if index >= len(values) || !found[index] {
			continue
		}
		var state SignalState
		if err := json.Unmarshal([]byte(values[index]), &state); err != nil {
			s.logf("newsnowhottest: signal state decode failed key=%s err=%v", keys[index], err)
			continue
		}
		states[index] = &state
	}
	return states
}

// setAnalysisCaches writes the fresh and stale organization documents. Failures
// are logged and ignored: the projection was already computed.
func (s *Service) setAnalysisCaches(ctx context.Context, freshKey, staleKey string, response AnalysisResponse) {
	encoded, err := marshalJSON(response)
	if err != nil {
		s.logf("newsnowhottest: analysis encode failed orgKey=%s err=%v", freshKey, err)
		return
	}
	entries := []CacheEntry{
		{Key: freshKey, Value: string(encoded), TTL: analysisFreshTTLSeconds * time.Second},
		{Key: staleKey, Value: string(encoded), TTL: analysisStaleTTLSeconds * time.Second},
	}
	if err := s.store.SetMany(ctx, entries); err != nil {
		s.logf("newsnowhottest: analysis cache write failed orgKey=%s err=%v", freshKey, err)
	}
}

// setGlobalSnapshotCaches writes the snapshot pair and the signature. The
// signature TTL equals the stale snapshot TTL, like the NestJS Promise.allSettled
// block.
func (s *Service) setGlobalSnapshotCaches(ctx context.Context, freshKey, staleKey, signatureKey string, snapshot GlobalSnapshot) {
	encoded, err := marshalJSON(snapshot)
	if err != nil {
		s.logf("newsnowhottest: snapshot encode failed err=%v", err)
		return
	}
	signature, err := marshalJSON(snapshot.Signature)
	if err != nil {
		s.logf("newsnowhottest: signature encode failed err=%v", err)
		return
	}
	entries := []CacheEntry{
		{Key: freshKey, Value: string(encoded), TTL: globalSnapshotFreshTTLSeconds * time.Second},
		{Key: staleKey, Value: string(encoded), TTL: globalSnapshotStaleTTLSeconds * time.Second},
		{Key: signatureKey, Value: string(signature), TTL: globalSnapshotStaleTTLSeconds * time.Second},
	}
	if err := s.store.SetMany(ctx, entries); err != nil {
		s.logf("newsnowhottest: snapshot cache write failed err=%v", err)
	}
}

// persistSignalStates writes every organization signal state in one pipeline.
// The values and the 36-hour TTL are identical to the per-key SET loop NestJS
// performs, only the round trips are coalesced.
func (s *Service) persistSignalStates(ctx context.Context, orgID string, signals []Signal) {
	entries := make([]CacheEntry, 0, len(signals))
	for _, signal := range signals {
		firstSeenAt := signal.CapturedAt
		if signal.State != nil {
			firstSeenAt = signal.State.FirstSeenAt
		}
		state := SignalState{
			FirstSeenAt: firstSeenAt,
			LastSeenAt:  signal.CapturedAt,
			LastRank:    intOrNull(int64(signal.Rank)),
		}
		encoded, err := marshalJSON(state)
		if err != nil {
			s.logf("newsnowhottest: signal state encode failed signalKey=%s err=%v", signal.SignalKey, err)
			continue
		}
		entries = append(entries, CacheEntry{
			Key:   buildStateKey(orgID, signal.SignalKey),
			Value: string(encoded),
			TTL:   signalStateTTLSeconds * time.Second,
		})
	}
	if err := s.store.SetMany(ctx, entries); err != nil {
		s.logf("newsnowhottest: signal state pipeline failed orgId=%s count=%d err=%v", orgID, len(entries), err)
	}
}

// waitForReadyAnalysis polls the fresh and stale documents with exponential
// backoff (50ms doubling to 500ms) inside the same 120s budget NestJS uses. Both
// keys are read with one MGET, so the number of Redis round trips drops without
// changing the accepted states or their order.
func (s *Service) waitForReadyAnalysis(ctx context.Context, freshKey, staleKey string, allowStale bool) *AnalysisResponse {
	deadline := s.now().Add(time.Duration(analysisWaitTimeoutMillis) * time.Millisecond)
	poll := analysisWaitInitialPoll
	for s.now().Before(deadline) {
		values, found, err := s.store.MGet(ctx, []string{freshKey, staleKey})
		if err != nil {
			s.logf("newsnowhottest: wait analysis cache read failed err=%v", err)
		}
		if err == nil && len(values) == 2 {
			if found[0] {
				var fresh AnalysisResponse
				if decodeErr := json.Unmarshal([]byte(values[0]), &fresh); decodeErr == nil {
					return &fresh
				}
			}
			if allowStale && found[1] {
				var stale AnalysisResponse
				if decodeErr := json.Unmarshal([]byte(values[1]), &stale); decodeErr == nil {
					return &stale
				}
			}
		}
		if !s.sleep(ctx, poll) {
			return nil
		}
		if poll < analysisWaitMaxPoll {
			poll *= 2
			if poll > analysisWaitMaxPoll {
				poll = analysisWaitMaxPoll
			}
		}
	}
	return nil
}

// waitForReadyGlobalSnapshot polls both snapshot documents with the same backoff
// and one MGET per iteration, returning only a snapshot whose signature matches
// the requested one.
func (s *Service) waitForReadyGlobalSnapshot(ctx context.Context, freshKey, staleKey, signature string) *GlobalSnapshot {
	deadline := s.now().Add(time.Duration(globalSnapshotWaitTimeoutMillis) * time.Millisecond)
	poll := globalSnapshotWaitInitialPoll
	for s.now().Before(deadline) {
		values, found, err := s.store.MGet(ctx, []string{freshKey, staleKey})
		if err != nil {
			s.logf("newsnowhottest: wait snapshot cache read failed err=%v", err)
		}
		if err == nil && len(values) == 2 {
			if found[0] {
				var fresh GlobalSnapshot
				if decodeErr := json.Unmarshal([]byte(values[0]), &fresh); decodeErr == nil && fresh.Signature == signature {
					return &fresh
				}
			}
			if found[1] {
				var stale GlobalSnapshot
				if decodeErr := json.Unmarshal([]byte(values[1]), &stale); decodeErr == nil && stale.Signature == signature {
					return &stale
				}
			}
		}
		if !s.sleep(ctx, poll) {
			return nil
		}
		if poll < globalSnapshotWaitMaxPoll {
			poll *= 2
			if poll > globalSnapshotWaitMaxPoll {
				poll = globalSnapshotWaitMaxPoll
			}
		}
	}
	return nil
}

// sleep waits for the poll interval. It returns false when the context ended
// first, which aborts the wait instead of sleeping through the deadline.
func (s *Service) sleep(ctx context.Context, millis int) bool {
	timer := time.NewTimer(time.Duration(millis) * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// logf writes through the configured logger.
func (s *Service) logf(format string, args ...any) {
	if s == nil {
		return
	}
	if s.logger != nil {
		s.logger.Printf(format, args...)
		return
	}
	log.Printf(format, args...)
}
