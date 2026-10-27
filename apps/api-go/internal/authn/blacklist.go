// access-token blacklist（与 NestJS AccessTokenBlacklistService 同一
// Redis、同一 key——Go 不建立第二套撤销名单）。
//
// 契约对齐（apps/api/src/modules/auth/access-token-blacklist.service.ts +
// cache/cache.service.ts，逐行核实）：
//   - key：`access-token:blacklist:<jti>`；
//   - 写入：仅 logout——value 是 JSON.stringify(true) 即字面量 "true"，
//     TTL 为该 token 剩余寿命秒数（auth.service.ts logout → add）；
//   - 读取：GET → `value ? JSON.parse(value) : null` → Boolean()——false /
//     null / 0 / "" 为未撤销，其余真值（包括 [] 与 {}：JS 中数组与对象恒为
//     真）为已撤销；存成空字符串的 value 在 NestJS 里被三元的短路跳过解析
//     并当作 null，故此处同样按未撤销处理；
//   - value 非法 JSON：NestJS JSON.parse 抛错 → 请求 500（fail-closed），
//     Go 同样返回错误由调用方 fail-closed；
//   - jti 为空：NestJS has() 直接返回 false 不触 Redis——Go 在调用方
//     （authhttp）于查询前跳过，语义一致；
//   - Redis 不可达：NestJS ioredis get 抛错 → 非 HttpException →
//     生产 500 "Internal server error"（fail-closed，绝不放行）。Go 的
//     查询错误同样上抛，由 authhttp 映射为 500 fail-closed。
package authn

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// blacklistKeyPrefix 与 NestJS AccessTokenBlacklistService 的 prefix 一致。
const blacklistKeyPrefix = "access-token:blacklist"

// Blacklist 是撤销名单查询接口（authz/http 层依赖抽象而非具体客户端）。
type Blacklist interface {
	// Revoked 报告该 jti 是否已被撤销。错误表示查询本身失败（Redis 不可达
	// 等）——调用方必须 fail-closed，不得把错误当作「未撤销」。
	Revoked(ctx context.Context, jti string) (bool, error)
}

// RedisBlacklist 是 Blacklist 的 Redis 实现。
type RedisBlacklist struct {
	client *redis.Client
	// timeout 是单次查询的硬超时（请求路径上不能无限等待 Redis——
	// ioredis 侧由 maxRetriesPerRequest 兜底，这里给 Go 侧同等的
	// 有界性）。
	timeout time.Duration
}

// NewRedisBlacklist 用已创建的客户端构造（客户端由 main 统一创建与
// 关闭——blacklist 不另行建立连接）。
func NewRedisBlacklist(client *redis.Client) *RedisBlacklist {
	return &RedisBlacklist{client: client, timeout: 2 * time.Second}
}

// Revoked 查询 `access-token:blacklist:<jti>` 并按 NestJS 的
// Boolean(JSON.parse(value)) 语义判定。
func (b *RedisBlacklist) Revoked(ctx context.Context, jti string) (bool, error) {
	if jti == "" {
		return false, nil
	}
	queryCtx, cancel := context.WithTimeout(ctx, b.timeout)
	defer cancel()

	value, err := b.client.Get(queryCtx, blacklistKeyPrefix+":"+jti).Result()
	if errors.Is(err, redis.Nil) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("blacklist query failed: %w", err)
	}
	revoked, err := jsTruthyJSON(value)
	if err != nil {
		return false, err
	}
	return revoked, nil
}

// jsTruthyJSON reproduces NestJS's Boolean(JSON.parse(value)) for the value
// CacheService.get returns. The falsy set is exactly false, null, 0 and "" —
// arrays and objects are truthy in JavaScript no matter how many members they
// have, so "[]" and "{}" mean *revoked* here. An empty stored value never
// reaches JSON.parse in NestJS (`value ? JSON.parse(value) : null` short
// circuits) and is therefore "not revoked", not a parse failure. Any other
// non-JSON value is an error, which the caller turns into the same fail-closed
// 500 that a JSON.parse throw produces in NestJS.
func jsTruthyJSON(value string) (bool, error) {
	if value == "" {
		return false, nil
	}
	var parsed any
	if err := json.Unmarshal([]byte(value), &parsed); err != nil {
		return false, fmt.Errorf("blacklist value is not valid JSON: %w", err)
	}
	switch v := parsed.(type) {
	case bool:
		return v, nil
	case nil:
		return false, nil
	case string:
		return v != "", nil
	case float64:
		return v != 0, nil
	case []any:
		// Boolean([]) is true in JavaScript, even for an empty array.
		return true, nil
	case map[string]any:
		// Boolean({}) is true in JavaScript, even for an empty object.
		return true, nil
	default:
		return true, nil
	}
}
