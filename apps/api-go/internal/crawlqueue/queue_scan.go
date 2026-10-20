package crawlqueue

import (
	"context"
	"encoding/json"
	"log"

	"github.com/redis/go-redis/v9"
)

// This file ports the two bulk queue scans CrawlQueueService exposes:
// listQueuedTaskIds and removeQueuedJobsForTasks. Both walk the same four job
// states as removeQueuedJobs (waiting, delayed, failed, paused) across the
// three crawl queues, page by page, and stop early once a page comes back
// short. The news-source admin operations use them to find the queued jobs that
// belong to one source without scanning the whole task table.

// listQueuedPageSize and listQueuedScanLimit mirror listQueuedTaskIds'
// pageSize (500) and scanLimit (5000).
const (
	listQueuedPageSize  = 500
	listQueuedScanLimit = 5_000
)

// taskIDBatch decodes the data JSON of the given job ids and returns a set of
// job id -> taskId. Jobs whose hash disappeared between the range read and the
// pipeline read are skipped.
func (p *Producer) taskIDsForJobs(ctx context.Context, keys queueKeys, ids []string) map[string]string {
	if len(ids) == 0 {
		return map[string]string{}
	}
	pipe := p.redis.Pipeline()
	commands := make([]*redis.StringCmd, len(ids))
	for index, id := range ids {
		commands[index] = pipe.HGet(ctx, keys.jobKey(id), "data")
	}
	if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
		log.Printf("crawlqueue: read job data for %s: %v", keys.queue, err)
		return map[string]string{}
	}
	out := make(map[string]string, len(ids))
	for index, command := range commands {
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
			out[ids[index]] = data.TaskID
		}
	}
	return out
}

// ListQueuedTaskIDs is CrawlQueueService.listQueuedTaskIds: every crawl-task id
// that currently has a waiting, delayed, failed or paused job, capped at 5000
// per state and read in pages of 500.
func (p *Producer) ListQueuedTaskIDs(ctx context.Context) (map[string]struct{}, error) {
	taskIDs := map[string]struct{}{}
	if p == nil || p.redis == nil {
		return taskIDs, errNoRedis
	}
	for _, keys := range queueEntries() {
		for start := 0; start < listQueuedScanLimit; start += listQueuedPageSize {
			end := start + listQueuedPageSize - 1
			if end >= listQueuedScanLimit {
				end = listQueuedScanLimit - 1
			}
			ids, err := p.rangeJobIDs(ctx, keys, start, end)
			if err != nil {
				return taskIDs, err
			}
			for _, taskID := range p.taskIDsForJobs(ctx, keys, ids) {
				taskIDs[taskID] = struct{}{}
			}
			if len(ids) < listQueuedPageSize {
				break
			}
		}
	}
	return taskIDs, nil
}

// RemoveQueuedJobsResult is the removeQueuedJobsForTasks return value.
type RemoveQueuedJobsResult struct {
	Scanned        int
	Removed        int
	RemovedTaskIDs []string
}

// RemoveQueuedJobsForTasks is CrawlQueueService.removeQueuedJobsForTasks:
// remove every waiting/delayed/failed/paused job whose data.taskId is in the
// set, paging in blocks of 200 and compensating the shared activity counter by
// the number of removed jobs.
func (p *Producer) RemoveQueuedJobsForTasks(ctx context.Context, taskIDs map[string]struct{}) (RemoveQueuedJobsResult, error) {
	result := RemoveQueuedJobsResult{RemovedTaskIDs: []string{}}
	if len(taskIDs) == 0 {
		return result, nil
	}
	if p == nil || p.redis == nil {
		return result, errNoRedis
	}
	removedTaskIDs := map[string]struct{}{}
	for _, keys := range queueEntries() {
		for start := 0; start < removeScanLimit; start += removePageSize {
			end := start + removePageSize - 1
			if end >= removeScanLimit {
				end = removeScanLimit - 1
			}
			ids, err := p.rangeJobIDs(ctx, keys, start, end)
			if err != nil {
				return result, err
			}
			result.Scanned += len(ids)
			jobTaskIDs := p.taskIDsForJobs(ctx, keys, ids)
			for _, id := range ids {
				taskID, ok := jobTaskIDs[id]
				if !ok {
					continue
				}
				if _, wanted := taskIDs[taskID]; !wanted {
					continue
				}
				removed, err := p.removeJob(ctx, keys, id)
				if err != nil {
					// A locked job is a silent skip, exactly like removeQueuedJobs.
					log.Printf("crawlqueue: failed to remove queued job %s from %s: %v", id, keys.queue, err)
					continue
				}
				if removed {
					result.Removed++
					if _, seen := removedTaskIDs[taskID]; !seen {
						removedTaskIDs[taskID] = struct{}{}
						result.RemovedTaskIDs = append(result.RemovedTaskIDs, taskID)
					}
				}
			}
			if len(ids) < removePageSize {
				break
			}
		}
	}
	if result.Removed > 0 {
		if err := p.activity.MarkTasksTerminal(ctx, result.Removed); err != nil {
			log.Printf("crawlqueue: failed to decrement crawl activity: %v", err)
		}
	}
	return result, nil
}
