package newsbehavior

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

type hashIncr struct {
	field string
	by    int64
}

type hashField struct {
	field string
	value string
}

func (s *Service) needRedis() error {
	if s == nil || s.rdb == nil {
		return fmt.Errorf("%w: redis is not configured", errRedis)
	}
	return nil
}

func redisErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, errRedis) {
		return err
	}
	return fmt.Errorf("%w: %v", errRedis, err)
}

func ttlSeconds(d time.Duration) time.Duration {
	sec := int64(d / time.Second)
	if sec < 1 {
		sec = 1
	}
	return time.Duration(sec) * time.Second
}

// setIfAbsentAt 写入 CacheService.setIfAbsent 的 JSON：{"at":<unix ms>}。
// 成功拿到 NX 返回 true。键已存在返回 false, nil。
func (s *Service) setIfAbsentAt(ctx context.Context, key string, ttl time.Duration) (bool, error) {
	if err := s.needRedis(); err != nil {
		return false, err
	}
	payload, err := marshalJS(struct {
		At int64 `json:"at"`
	}{At: time.Now().UnixMilli()})
	if err != nil {
		return false, err
	}
	ok, err := s.rdb.SetNX(ctx, key, payload, ttlSeconds(ttl)).Result()
	if err != nil {
		return false, redisErr(err)
	}
	return ok, nil
}

func (s *Service) hincrBy(ctx context.Context, key string, incs []hashIncr) error {
	if len(incs) == 0 {
		return nil
	}
	if err := s.needRedis(); err != nil {
		return err
	}
	pipe := s.rdb.Pipeline()
	for _, inc := range incs {
		pipe.HIncrBy(ctx, key, inc.field, inc.by)
	}
	_, err := pipe.Exec(ctx)
	if err != nil && !errors.Is(err, redis.Nil) {
		return redisErr(err)
	}
	return nil
}

func (s *Service) expireAndDel(ctx context.Context, expireKey string, ttl time.Duration, delKeys ...string) error {
	if err := s.needRedis(); err != nil {
		return err
	}
	pipe := s.rdb.Pipeline()
	pipe.Expire(ctx, expireKey, ttlSeconds(ttl))
	if len(delKeys) > 0 {
		pipe.Del(ctx, delKeys...)
	}
	_, err := pipe.Exec(ctx)
	if err != nil && !errors.Is(err, redis.Nil) {
		return redisErr(err)
	}
	return nil
}

func (s *Service) cacheDel(ctx context.Context, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	if err := s.needRedis(); err != nil {
		return err
	}
	if err := s.rdb.Del(ctx, keys...).Err(); err != nil && !errors.Is(err, redis.Nil) {
		return redisErr(err)
	}
	return nil
}

func (s *Service) cacheGet(ctx context.Context, key string) ([]byte, bool, error) {
	if err := s.needRedis(); err != nil {
		return nil, false, err
	}
	raw, err := s.rdb.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, redisErr(err)
	}
	// 空字符串在 CacheService.get 里是假值，不会 JSON.parse。
	if len(raw) == 0 {
		return nil, false, nil
	}
	return raw, true, nil
}

func (s *Service) cacheSet(ctx context.Context, key string, payload []byte, ttl time.Duration) error {
	if err := s.needRedis(); err != nil {
		return err
	}
	if err := s.rdb.Set(ctx, key, payload, ttlSeconds(ttl)).Err(); err != nil {
		return redisErr(err)
	}
	return nil
}

// hgetallMany 用原始 HGETALL 回复保留字段顺序。go-redis 的 HGetAll
// 收成 map 之后，同分稳定排序就和 ioredis 对不上。
func (s *Service) hgetallMany(ctx context.Context, keys []string) ([][]hashField, error) {
	out := make([][]hashField, len(keys))
	if len(keys) == 0 {
		return out, nil
	}
	if err := s.needRedis(); err != nil {
		return nil, err
	}
	pipe := s.rdb.Pipeline()
	cmds := make([]*redis.Cmd, len(keys))
	for i, key := range keys {
		cmds[i] = pipe.Do(ctx, "HGETALL", key)
	}
	if _, err := pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return nil, redisErr(err)
	}
	for i, cmd := range cmds {
		fields, err := hashFieldsFromCmd(cmd)
		if err != nil {
			return nil, redisErr(err)
		}
		out[i] = fields
	}
	return out, nil
}

func hashFieldsFromCmd(cmd *redis.Cmd) ([]hashField, error) {
	values, err := cmd.StringSlice()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return nil, nil
		}
		return nil, err
	}
	if len(values)%2 != 0 {
		return nil, fmt.Errorf("hgetall: odd field count")
	}
	out := make([]hashField, 0, len(values)/2)
	for i := 0; i < len(values); i += 2 {
		out = append(out, hashField{field: values[i], value: values[i+1]})
	}
	return out, nil
}
