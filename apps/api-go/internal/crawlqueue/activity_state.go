package crawlqueue

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// LastLoadedAtField is the crawl:activity hash field written by
// ensureActiveTaskCount. It lives here, next to the reader, so the other three
// field constants in model.go stay untouched.
const LastLoadedAtField = "lastLoadedAt"

// ActivityState is CrawlActivityState. A nil pointer means the hash field is
// absent or not a usable value, exactly like the NestJS toOptional* helpers.
type ActivityState struct {
	ActiveTaskCount *int
	LastEnqueuedAt  *string
	LastTerminalAt  *string
	LastLoadedAt    *string
}

// GetState is CrawlActivityService.getState: HGETALL plus the per-field
// normalization. The hash is not namespaced and is shared with NestJS.
func (a *Activity) GetState(ctx context.Context) (ActivityState, error) {
	if a == nil || a.redis == nil {
		return ActivityState{}, errNoRedis
	}
	record, err := a.redis.HGetAll(ctx, ActivityHashKey).Result()
	if err != nil {
		return ActivityState{}, err
	}
	return ActivityState{
		ActiveTaskCount: optionalActivityInt(record[ActiveTaskCountField]),
		LastEnqueuedAt:  optionalActivityString(record[LastEnqueuedAtField]),
		LastTerminalAt:  optionalActivityString(record[LastTerminalAtField]),
		LastLoadedAt:    optionalActivityString(record[LastLoadedAtField]),
	}, nil
}

// EnsureActiveTaskCount is ensureActiveTaskCount: a usable cached count wins;
// otherwise MySQL counts queued + running tasks and both activeTaskCount and
// lastLoadedAt are written back. The database handle is passed in because the
// counter itself owns only Redis.
func (a *Activity) EnsureActiveTaskCount(ctx context.Context, db *sql.DB) (int, error) {
	if a == nil || a.redis == nil {
		return 0, errNoRedis
	}
	state, err := a.GetState(ctx)
	if err != nil {
		return 0, err
	}
	if state.ActiveTaskCount != nil {
		return *state.ActiveTaskCount, nil
	}
	if db == nil {
		return 0, fmt.Errorf("crawlqueue: mysql is not configured")
	}
	var count int64
	if err := db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM `CrawlTask` WHERE `status` IN ('queued', 'running')",
	).Scan(&count); err != nil {
		return 0, err
	}
	if count < 0 {
		count = 0
	}
	lastLoadedAt := a.clock().UTC().Format("2006-01-02T15:04:05.000Z")
	if err := a.redis.HSet(ctx, ActivityHashKey, map[string]any{
		ActiveTaskCountField: strconv.FormatInt(count, 10),
		LastLoadedAtField:    lastLoadedAt,
	}).Err(); err != nil {
		return 0, err
	}
	return int(count), nil
}

// optionalActivityInt mirrors toOptionalInt: a blank or non-finite value is
// absent; a finite value is rounded (JS Math.round) and floored at zero.
func optionalActivityInt(value string) *int {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return nil
	}
	rounded := int(math.Floor(parsed + 0.5))
	if rounded < 0 {
		rounded = 0
	}
	return &rounded
}

// optionalActivityString mirrors toOptionalString: the raw value is kept, but a
// blank one is treated as absent.
func optionalActivityString(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	trimmed := value
	return &trimmed
}
