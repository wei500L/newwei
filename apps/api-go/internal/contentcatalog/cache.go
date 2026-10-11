package contentcatalog

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const releaseLockScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`

const renewLockScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`

func (s *Service) ensureCatalogFresh(ctx context.Context, orgID string) error {
	key := catalogSyncKeyPrefix + orgID
	if s.rdb == nil {
		return s.syncCatalog(ctx, orgID)
	}
	return s.cacheWrap(ctx, key, catalogSyncTTL, func(ctx context.Context) error {
		return s.syncCatalog(ctx, orgID)
	})
}

func (s *Service) cacheWrap(ctx context.Context, key string, ttl time.Duration, loader func(context.Context) error) error {
	fresh, err := s.cacheFresh(ctx, key)
	if err != nil {
		return err
	}
	if fresh {
		return nil
	}
	lockKey := "lock:" + key
	token, locked, err := s.acquireLock(ctx, lockKey, catalogLockTTL)
	if err != nil {
		return err
	}
	if !locked {
		deadline := time.Now().Add(catalogLockTTL)
		for time.Now().Before(deadline) {
			timer := time.NewTimer(catalogLockRetry)
			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
			}
			fresh, err = s.cacheFresh(ctx, key)
			if err != nil {
				return err
			}
			if fresh {
				return nil
			}
			token, locked, err = s.acquireLock(ctx, lockKey, catalogLockTTL)
			if err != nil {
				return err
			}
			if locked {
				break
			}
		}
	}
	if locked {
		return s.runLocked(ctx, key, lockKey, token, ttl, loader)
	}
	fresh, err = s.cacheFresh(ctx, key)
	if err != nil {
		return err
	}
	if fresh {
		return nil
	}
	return s.finishLoader(ctx, key, ttl, loader)
}

func (s *Service) runLocked(ctx context.Context, key, lockKey, token string, ttl time.Duration, loader func(context.Context) error) error {
	stop := make(chan struct{})
	go s.renewWhile(stop, lockKey, token, catalogLockTTL)
	err := s.finishLoader(ctx, key, ttl, loader)
	close(stop)
	s.releaseLock(lockKey, token)
	return err
}

func (s *Service) finishLoader(ctx context.Context, key string, ttl time.Duration, loader func(context.Context) error) error {
	if err := loader(ctx); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return s.writeSyncMarker(ctx, key, ttl)
}

func (s *Service) renewWhile(stop <-chan struct{}, lockKey, token string, ttl time.Duration) {
	interval := ttl / 2
	if interval < time.Second {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			s.renewLock(lockKey, token, ttl)
		}
	}
}

func (s *Service) cacheFresh(ctx context.Context, key string) (bool, error) {
	value, err := s.rdb.Get(ctx, key).Result()
	if errors.Is(err, redis.Nil) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if value == "" {
		return false, nil
	}
	var parsed any
	if err := json.Unmarshal([]byte(value), &parsed); err != nil {
		return false, err
	}
	switch typed := parsed.(type) {
	case nil:
		return false, nil
	case bool:
		return typed, nil
	case float64:
		return typed != 0, nil
	case string:
		return typed != "", nil
	default:
		return true, nil
	}
}

func (s *Service) writeSyncMarker(ctx context.Context, key string, ttl time.Duration) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	payload, err := json.Marshal(struct {
		SyncedAt string `json:"syncedAt"`
	}{SyncedAt: isoTime(time.Now())})
	if err != nil {
		return err
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return s.rdb.Set(ctx, key, payload, ttl).Err()
}

func (s *Service) acquireLock(ctx context.Context, key string, ttl time.Duration) (string, bool, error) {
	token, err := newLockToken()
	if err != nil {
		return "", false, err
	}
	ok, err := s.rdb.SetNX(ctx, key, token, ttl).Result()
	if err != nil {
		return "", false, err
	}
	if !ok {
		return "", false, nil
	}
	return token, true, nil
}

func (s *Service) releaseLock(key, token string) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = s.rdb.Eval(ctx, releaseLockScript, []string{key}, token).Err()
}

func (s *Service) renewLock(key, token string, ttl time.Duration) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = s.rdb.Eval(ctx, renewLockScript, []string{key}, token, ttl.Milliseconds()).Err()
}

func newLockToken() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf("%s-%s-%s-%s-%s",
		hex.EncodeToString(raw[0:4]),
		hex.EncodeToString(raw[4:6]),
		hex.EncodeToString(raw[6:8]),
		hex.EncodeToString(raw[8:10]),
		hex.EncodeToString(raw[10:16]),
	), nil
}

func newCatalogID() (string, error) {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(raw), nil
}
