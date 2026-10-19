package newsnowsources

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strconv"
	"sync"
	"time"
)

// Physical refresh lock. The key is `lock:news-aggregator:source:<id>:refresh`
// and the protocol (SET NX PX, token-compared extension and release) matches
// CacheService.withLock so Go and NestJS exclude each other.

const refreshLockPrefix = "lock:"

var releaseLockScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      end
      return 0
    `

var extendLockScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      end
      return 0
    `

// refreshLock is one held lease.
type refreshLock struct {
	store Store
	key   string
	token string
}

// acquireRefreshLock tries to take the physical lock. A nil lock means another
// process owns it; an error is a Redis failure.
func (s *Service) acquireRefreshLock(ctx context.Context, freshKey string) (*refreshLock, error) {
	token, err := newLockToken()
	if err != nil {
		return nil, err
	}
	key := refreshLockPrefix + freshKey + ":refresh"
	acquired, err := s.store.SetNX(ctx, key, token, refreshLockTTL)
	if err != nil {
		return nil, err
	}
	if !acquired {
		return nil, nil
	}
	return &refreshLock{store: s.store, key: key, token: token}, nil
}

// startAutoRenew extends the lease every third of its TTL until the returned
// stop function is called.
func (l *refreshLock) startAutoRenew() func() {
	interval := refreshLockTTL / 3
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
				_, _ = l.store.Eval(context.Background(), extendLockScript, []string{l.key},
					l.token, strconv.FormatInt(int64(refreshLockTTL/time.Millisecond), 10))
			}
		}
	}()
	return func() {
		once.Do(func() { close(stop) })
	}
}

// release drops the lease only when the token still matches.
func (l *refreshLock) release() {
	_, _ = l.store.Eval(context.Background(), releaseLockScript, []string{l.key}, l.token)
}

// newLockToken mirrors randomUUID.
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
