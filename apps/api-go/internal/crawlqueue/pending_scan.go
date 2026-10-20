package crawlqueue

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/redis/go-redis/v9"
)

// This file ports the pending-job scan the crawl task janitor needs. BullMQ 5
// stores a job with a priority !== 0 in the `prioritized` sorted set instead of
// the `wait` list (queue-getters.js commandByType): whenever the producer
// receives a sourcePriority the add script writes `prioritized`, so the legacy
// "waiting, delayed, active" scan misses queued crawl tasks. The janitor's
// pending scan therefore covers wait, paused, delayed, prioritized and active
// for the three crawl queues.
//
// The scan order mirrors Queue.getJobs(..., asc=false): LRANGE for the list
// states and ZREVRANGE for the sorted-set states, de-duplicated in first-seen
// order. Job hashes are read with one pipelined HGET of the `data` field; the
// whole job object is never loaded.

// pendingPageSize is BullMQ's 500-job page used by listPendingTaskIds.
const pendingPageSize = 500

// pendingScanStates are the BullMQ states that can hold a crawl job which still
// counts as "queued" for janitor purposes. `paused` is included because
// sanitizeJobTypes adds it whenever `waiting` is requested.
var pendingScanStates = []string{"wait", "paused", "delayed", "prioritized", "active"}

// TaskIDSet is the de-duplicated set of task ids found in the pending jobs.
type TaskIDSet map[string]struct{}

// Add records a task id.
func (s TaskIDSet) Add(taskID string) {
	if s == nil {
		return
	}
	s[taskID] = struct{}{}
}

// Has reports whether the set contains taskID.
func (s TaskIDSet) Has(taskID string) bool {
	if s == nil {
		return false
	}
	_, ok := s[taskID]
	return ok
}

// Len returns the number of distinct task ids.
func (s TaskIDSet) Len() int { return len(s) }

// pendingCounts is the getCounts projection for the pending scan states. The
// field order matches pendingScanStates.
type pendingCounts struct {
	Wait        int64
	Paused      int64
	Delayed     int64
	Prioritized int64
	Active      int64
}

// Total is the backlog size the janitor compares against its scan limit.
func (c pendingCounts) Total() int64 {
	return c.Wait + c.Paused + c.Delayed + c.Prioritized + c.Active
}

// PendingJobCount is getPendingJobCount with the pending scan state set:
// waiting + paused + delayed + prioritized + active over hot, normal and
// legacy. It is the B1 backlog figure; QueueCounts.Pending() intentionally
// keeps the NestJS waiting+delayed+active definition for the read routes.
func (p *Producer) PendingJobCount(ctx context.Context) (int64, error) {
	if p == nil || p.redis == nil {
		return 0, errNoRedis
	}
	var total int64
	for _, keys := range queueEntries() {
		counts, err := p.pendingCountsFor(ctx, keys)
		if err != nil {
			return 0, err
		}
		total += counts.Total()
	}
	return total, nil
}

// pendingCountsFor runs getCounts for the five pending states. The Lua script
// maps wait/paused/active to LLEN and the remaining states to ZCARD.
func (p *Producer) pendingCountsFor(ctx context.Context, keys queueKeys) (pendingCounts, error) {
	result, err := p.redis.Eval(ctx, getCountsScript, []string{keys.queuePrefix()}, "wait", "paused", "delayed", "prioritized", "active").Result()
	if err != nil {
		return pendingCounts{}, err
	}
	values, ok := result.([]any)
	if !ok || len(values) != len(pendingScanStates) {
		return pendingCounts{}, fmt.Errorf("crawlqueue: unexpected pending getCounts reply %T", result)
	}
	numbers := make([]int64, len(pendingScanStates))
	for index, value := range values {
		number, ok := value.(int64)
		if !ok {
			return pendingCounts{}, fmt.Errorf("crawlqueue: unexpected pending getCounts element %T", value)
		}
		numbers[index] = number
	}
	return pendingCounts{
		Wait:        numbers[0],
		Paused:      numbers[1],
		Delayed:     numbers[2],
		Prioritized: numbers[3],
		Active:      numbers[4],
	}, nil
}

// ListPendingTaskIDs is listPendingTaskIds over the pending scan states. Every
// queue is paged in 500-id slices until a page returns fewer than 500 ids or
// scanLimit is reached; scanLimit applies per queue exactly like NestJS.
func (p *Producer) ListPendingTaskIDs(ctx context.Context, scanLimit int) (TaskIDSet, error) {
	if p == nil || p.redis == nil {
		return nil, errNoRedis
	}
	taskIDs := make(TaskIDSet)
	for _, keys := range queueEntries() {
		for start := 0; start < scanLimit; start += pendingPageSize {
			end := start + pendingPageSize - 1
			if end >= scanLimit {
				end = scanLimit - 1
			}
			ids, err := p.pendingJobIDs(ctx, keys, start, end)
			if err != nil {
				return nil, err
			}
			if len(ids) > 0 {
				if err := p.collectPendingTaskIDs(ctx, keys, ids, taskIDs); err != nil {
					return nil, err
				}
			}
			if len(ids) < pendingPageSize {
				break
			}
		}
	}
	return taskIDs, nil
}

// pendingJobIDs reads one page of job ids across the pending states, preserving
// first-seen order and removing duplicates like Queue.getRanges does.
func (p *Producer) pendingJobIDs(ctx context.Context, keys queueKeys, start, end int) ([]string, error) {
	ids := make([]string, 0, len(pendingScanStates)*pendingPageSize)
	seen := make(map[string]struct{}, len(pendingScanStates)*pendingPageSize)
	appendIDs := func(values []string) {
		for _, id := range values {
			if id == "" {
				continue
			}
			if _, ok := seen[id]; ok {
				continue
			}
			seen[id] = struct{}{}
			ids = append(ids, id)
		}
	}
	for _, state := range pendingScanStates {
		var values []string
		var err error
		switch state {
		case "wait":
			values, err = p.listRange(ctx, keys.wait, start, end)
		case "paused":
			values, err = p.listRange(ctx, keys.paused, start, end)
		case "active":
			values, err = p.listRange(ctx, keys.active, start, end)
		case "delayed":
			values, err = p.redis.ZRevRange(ctx, keys.delayed, int64(start), int64(end)).Result()
		case "prioritized":
			values, err = p.redis.ZRevRange(ctx, keys.prioritized, int64(start), int64(end)).Result()
		}
		if err != nil && err != redis.Nil {
			return nil, err
		}
		appendIDs(values)
	}
	return ids, nil
}

// collectPendingTaskIDs reads only the `data` field of every job hash and keeps
// the non-empty taskId values. A job removed between the id read and the HGET
// is skipped; that race only narrows the set for one tick.
func (p *Producer) collectPendingTaskIDs(ctx context.Context, keys queueKeys, ids []string, taskIDs TaskIDSet) error {
	pipe := p.redis.Pipeline()
	commands := make([]*redis.StringCmd, len(ids))
	for index, id := range ids {
		commands[index] = pipe.HGet(ctx, keys.jobKey(id), "data")
	}
	if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
		return err
	}
	for _, command := range commands {
		raw, err := command.Result()
		if err != nil {
			continue
		}
		var data struct {
			TaskID string `json:"taskId"`
		}
		if json.Unmarshal([]byte(raw), &data) != nil {
			continue
		}
		if data.TaskID != "" {
			taskIDs.Add(data.TaskID)
		}
	}
	return nil
}
