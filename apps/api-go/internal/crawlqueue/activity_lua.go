package crawlqueue

import (
	"context"

	"github.com/redis/go-redis/v9"
)

// markTasksTerminalAtomicScript is markTasksTerminal in one round trip: an
// HINCRBY by count, the floor-to-zero write when the result went negative, and
// lastTerminalAt in the same EVAL. MarkTasksTerminal keeps its pipeline form
// because its callers batch their own writes around it.
//
// ARGV[1] terminal count, ARGV[2] lastTerminalAt value, ARGV[3] activeTaskCount
// field name, ARGV[4] lastTerminalAt field name.
var markTasksTerminalAtomicScript = redis.NewScript(`
local count = tonumber(ARGV[1])
if count <= 0 then
  redis.call("HSET", KEYS[1], ARGV[4], ARGV[2])
  return 0
end
local current = redis.call("HINCRBY", KEYS[1], ARGV[3], -count)
if current < 0 then
  redis.call("HSET", KEYS[1], ARGV[3], 0)
end
redis.call("HSET", KEYS[1], ARGV[4], ARGV[2])
return current
`)

// MarkTasksTerminalAtomic is the atomic form of MarkTasksTerminal. The Go crawl
// worker applies the terminal decrement exactly once per finished job (B1: the
// QueueEvents consumers that used to do it are gone), so a concurrent
// markTaskQueued increment or a second terminal write can no longer interleave
// between the HINCRBY and the floor-to-zero HSET. A non-positive count only
// records lastTerminalAt, exactly like MarkTasksTerminal.
func (a *Activity) MarkTasksTerminalAtomic(ctx context.Context, count int) error {
	if a == nil || a.redis == nil {
		return errNoRedis
	}
	now := a.clock().UTC().Format("2006-01-02T15:04:05.000Z")
	_, err := markTasksTerminalAtomicScript.Run(ctx, a.redis,
		[]string{ActivityHashKey},
		count, now, ActiveTaskCountField, LastTerminalAtField,
	).Result()
	return err
}
