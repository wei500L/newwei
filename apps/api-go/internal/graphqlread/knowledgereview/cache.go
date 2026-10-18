package knowledgereview

import (
	"context"

	"github.com/redis/go-redis/v9"
)

// cacheScanCount is the SCAN hint, matching CacheService.delByPrefix's default
// scanCount of 500.
const cacheScanCount = 500

// invalidateGraphCaches deletes both knowledge-graph cache prefixes for the
// organization, mirroring CacheService.delByPrefix: SCAN with a MATCH pattern
// and follow every cursor to zero, then DEL each page. It never uses KEYS and
// never touches another organization's keys.
//
// A failure is logged and swallowed: the review already committed and its
// result must still be returned.
func (s *service) invalidateGraphCaches(ctx context.Context, orgID string) {
	if s == nil || s.redis == nil {
		return
	}
	prefixes := []string{
		"knowledgeGraph:subgraph:" + orgID + ":",
		"knowledgeGraph:impact:" + orgID + ":",
	}
	for _, prefix := range prefixes {
		if err := deleteByPrefix(ctx, s.redis, prefix); err != nil {
			logCacheFailure(prefix, err)
		}
	}
}

// deleteByPrefix walks every SCAN cursor and deletes the matching pages.
func deleteByPrefix(ctx context.Context, client *redis.Client, prefix string) error {
	var cursor uint64
	for {
		keys, next, err := client.Scan(ctx, cursor, prefix+"*", cacheScanCount).Result()
		if err != nil {
			return err
		}
		if len(keys) > 0 {
			if err := client.Del(ctx, keys...).Err(); err != nil {
				return err
			}
		}
		cursor = next
		if cursor == 0 {
			return nil
		}
	}
}
