package qualityoverview

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

// 快照与缓存的键/锁/超时与 NestJS 逐项对齐（observability-snapshot.service.ts
// 与 cache.service.ts）：
//   - 快照锁 TTL 15s、重试间隔 100ms、最长等待 20s；
//   - 取不到锁时轮询数据库，仍无则无锁重建（与 Nest 的最终 fallback 一致）；
//   - Redis 锁键 = "lock:" + "observability-snapshot:<orgId>:<scope>:<variantKey>"
//     （CacheService.withLock 会再前缀 "lock:"），与 Nest 共享同一把锁；
//   - 质量总览任务日志缓存 TTL 15s、lockTtl 2000ms、retryDelay 50ms、
//     maxWait 3000ms，键 "quality:task-logs:overview:<orgId>:<since>:<limit>"。
const (
	snapshotDefaultTtlSeconds = 60
	snapshotLockTtl           = 15 * time.Second
	snapshotRenewInterval     = 5 * time.Second
	snapshotMaxWait           = 20 * time.Second
	snapshotRetryDelay        = 100 * time.Millisecond
)

var (
	releaseLockScript = redis.NewScript(`
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      end
      return 0
    `)
	renewLockScript = redis.NewScript(`
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      end
      return 0
    `)
)

// snapshotStore 负责 MySQL ObservabilitySnapshot 的读写与 Redis 分布式锁，
// 以及质量总览任务日志的 Redis 缓存（与 Nest 同一键）。
type snapshotStore struct {
	db    *sql.DB
	redis *redis.Client
}

func snapshotKey(orgID, scope, variantKey string) string {
	return "observability-snapshot:" + orgID + ":" + scope + ":" + variantKey
}

func lockKeyFor(key string) string {
	return "lock:" + key
}

// getOrCreate 对齐 ObservabilitySnapshotService.getOrCreate：未过期直接返回
// 已存的 payload；否则抢锁重建（锁内再查一次），拿不到锁则轮询 20 秒，仍无
// 就无锁重建并 upsert。
func (s *snapshotStore) getOrCreate(ctx context.Context, orgID, scope, variantKey string, ttlSeconds int, loader func() (any, error)) (json.RawMessage, error) {
	if s.db == nil {
		return nil, errors.New("mysql is not configured")
	}
	if payload, ok, err := s.loadFresh(ctx, orgID, scope, variantKey, time.Now()); err != nil {
		return nil, err
	} else if ok {
		return payload, nil
	}

	key := snapshotKey(orgID, scope, variantKey)
	lockKey := lockKeyFor(key)
	token, err := randomToken()
	if err != nil {
		return nil, err
	}
	acquired, err := s.acquireLock(ctx, lockKey, token, snapshotLockTtl)
	if err != nil {
		return nil, err
	}
	if acquired {
		stop := s.startAutoRenew(lockKey, token, snapshotLockTtl, snapshotRenewInterval)
		defer stop()
		defer s.releaseLock(lockKey, token)
		if payload, ok, err := s.loadFresh(ctx, orgID, scope, variantKey, time.Now()); err != nil {
			return nil, err
		} else if ok {
			return payload, nil
		}
		return s.rebuild(ctx, orgID, scope, variantKey, ttlSeconds, loader)
	}

	deadline := time.Now().Add(snapshotMaxWait)
	for time.Now().Before(deadline) {
		if err := sleepContext(ctx, snapshotRetryDelay); err != nil {
			return nil, err
		}
		if payload, ok, err := s.loadFresh(ctx, orgID, scope, variantKey, time.Now()); err != nil {
			return nil, err
		} else if ok {
			return payload, nil
		}
	}
	// Nest 在等待超时后同样会无锁重建（最终 fallback）。
	return s.rebuild(ctx, orgID, scope, variantKey, ttlSeconds, loader)
}

// loadFresh 对齐 loadFreshSnapshot + serializeRecord.payload：record 不存在
// 或 expiresAt <= now 视为过期；否则返回数据库里的 payload 原文。
func (s *snapshotStore) loadFresh(ctx context.Context, orgID, scope, variantKey string, now time.Time) (json.RawMessage, bool, error) {
	var payload []byte
	var expiresAt time.Time
	err := s.db.QueryRowContext(ctx,
		"SELECT payload, expiresAt FROM ObservabilitySnapshot WHERE orgId = ? AND scope = ? AND variantKey = ?",
		orgID, scope, variantKey,
	).Scan(&payload, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if !expiresAt.After(now) {
		return nil, false, nil
	}
	return json.RawMessage(payload), true, nil
}

// rebuild 对齐 rebuildSnapshot：跑 loader、marshal、upsert（唯一键
// orgId+scope+variantKey），TTL = ttlSeconds。
func (s *snapshotStore) rebuild(ctx context.Context, orgID, scope, variantKey string, ttlSeconds int, loader func() (any, error)) (json.RawMessage, error) {
	value, err := loader()
	if err != nil {
		return nil, err
	}
	payload, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	expiresAt := now.Add(time.Duration(ttlSeconds) * time.Second)
	id, err := newRowID()
	if err != nil {
		return nil, err
	}
	if _, err := s.db.ExecContext(ctx, `
INSERT INTO ObservabilitySnapshot (id, orgId, scope, variantKey, payload, generatedAt, expiresAt, lastRequestedAt, createdAt, updatedAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
  payload = VALUES(payload),
  generatedAt = VALUES(generatedAt),
  expiresAt = VALUES(expiresAt),
  lastRequestedAt = VALUES(lastRequestedAt),
  updatedAt = VALUES(updatedAt)`,
		id, orgID, scope, variantKey, payload, now, expiresAt, now, now, now,
	); err != nil {
		return nil, err
	}
	return json.RawMessage(payload), nil
}

// cacheOptions 对齐 CacheService.wrap 的 options。
type cacheOptions struct {
	lockTtl    time.Duration
	renewEvery time.Duration
	retryDelay time.Duration
	maxWait    time.Duration
}

// cacheWrapJSON 对齐 CacheService.wrap：先读缓存；未命中抢锁，抢不到则按
// retryDelay 轮询最多 maxWait，期间只要拿到锁就执行 loader；最终仍拿不到锁
// 就无锁执行 loader。缓存值是 JSON 原文（与 Nest 的 JSON.stringify 一致）。
func (s *snapshotStore) cacheWrapJSON(ctx context.Context, key string, ttlSeconds int, opts cacheOptions, loader func() (json.RawMessage, error)) (json.RawMessage, error) {
	if s.redis == nil {
		return loader()
	}
	if cached, ok, err := s.readCache(ctx, key); err != nil {
		return nil, err
	} else if ok {
		return cached, nil
	}

	lockKey := lockKeyFor(key)
	token, err := randomToken()
	if err != nil {
		return nil, err
	}
	acquired, err := s.acquireLock(ctx, lockKey, token, opts.lockTtl)
	if err != nil {
		return nil, err
	}
	if !acquired {
		deadline := time.Now().Add(opts.maxWait)
		for time.Now().Before(deadline) {
			if err := sleepContext(ctx, opts.retryDelay); err != nil {
				return nil, err
			}
			if cached, ok, err := s.readCache(ctx, key); err != nil {
				return nil, err
			} else if ok {
				return cached, nil
			}
			acquired, err = s.acquireLock(ctx, lockKey, token, opts.lockTtl)
			if err != nil {
				return nil, err
			}
			if acquired {
				break
			}
		}
	}

	if acquired {
		stop := s.startAutoRenew(lockKey, token, opts.lockTtl, opts.renewEvery)
		defer stop()
		defer s.releaseLock(lockKey, token)
		value, err := loader()
		if err != nil {
			return nil, err
		}
		s.writeCache(ctx, key, value, ttlSeconds)
		return value, nil
	}

	if cached, ok, err := s.readCache(ctx, key); err != nil {
		return nil, err
	} else if ok {
		return cached, nil
	}
	value, err := loader()
	if err != nil {
		return nil, err
	}
	s.writeCache(ctx, key, value, ttlSeconds)
	return value, nil
}

func (s *snapshotStore) readCache(ctx context.Context, key string) (json.RawMessage, bool, error) {
	value, err := s.redis.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if len(value) == 0 {
		return nil, false, nil
	}
	return json.RawMessage(value), true, nil
}

func (s *snapshotStore) writeCache(ctx context.Context, key string, value json.RawMessage, ttlSeconds int) {
	if s.redis == nil {
		return
	}
	_ = s.redis.Set(ctx, key, []byte(value), time.Duration(ttlSeconds)*time.Second).Err()
}

func (s *snapshotStore) acquireLock(ctx context.Context, key, token string, ttl time.Duration) (bool, error) {
	if s.redis == nil {
		return false, errors.New("redis is not configured")
	}
	return s.redis.SetNX(ctx, key, token, ttl).Result()
}

func (s *snapshotStore) releaseLock(key, token string) {
	if s.redis == nil {
		return
	}
	_, _ = releaseLockScript.Run(context.Background(), s.redis, []string{key}, token).Result()
}

func (s *snapshotStore) startAutoRenew(key, token string, ttl, interval time.Duration) func() {
	if s.redis == nil {
		return func() {}
	}
	if interval <= 0 {
		interval = ttl / 2
	}
	if interval < time.Second {
		interval = time.Second
	}
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				_, _ = renewLockScript.Run(context.Background(), s.redis,
					[]string{key}, token, int(ttl.Milliseconds())).Result()
			}
		}
	}()
	return func() {
		close(stop)
		<-done
	}
}

func sleepContext(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func randomToken() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}

// newRowID 写入 Prisma cuid 列（MySQL 没有客户端默认值，必须显式插入；
// 形状与既有 Go 批次一致：c + 24 位十六进制）。
func newRowID() (string, error) {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buf[:]), nil
}
