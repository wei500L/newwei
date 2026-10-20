package pipelineenqueue

import (
	"context"
	"log"
	"strconv"
)

// The queue name and Redis prefix are the existing NestJS protocol values
// (queue.constants.ts and BullMQ's default prefix).
const (
	QueueName = "itemPipeline"
	// QueuePrefixKey is BullMQ's queueKeys[''] value: prefix + ":" + queue + ":".
	QueuePrefixKey = "bull:" + QueueName + ":"
)

// Org counter keys. QueueOrgStatsService owns the same names and TTLs.
const (
	orgMetaTTLSeconds   = 60 * 60 * 24 * 7
	orgCountsTTLSeconds = 60 * 60 * 24 * 30
)

// jobStatus is the subset of BullMQ states the org counter tracks.
type jobStatus string

const (
	statusWaiting jobStatus = "waiting"
)

// recordOrgJobCount recreates QueueOrgStatsService.upsertJobMetaAndCount for
// the initial "waiting" state. Later transitions stay with the NestJS
// QueueOrgStatsTracker/QueueEvents consumers; this producer never publishes a
// second event stream.
func (p *Producer) recordOrgJobCount(ctx context.Context, jobID, orgID string) {
	if p == nil || p.redis == nil {
		return
	}
	if _, err := p.redis.Eval(
		ctx,
		upsertJobMetaAndCountScript,
		[]string{orgMetaKey(jobID), orgCountsKey(orgID)},
		string(statusWaiting),
		orgID,
		"0", // keepCompleted: removeOnComplete=true
		"1", // keepFailed: removeOnFail={age:604800,count:10000}
		strconv.Itoa(orgMetaTTLSeconds),
		strconv.Itoa(orgCountsTTLSeconds),
	).Result(); err != nil {
		// The NestJS service treats this as a warning: the job was already
		// accepted by BullMQ and the counter can catch up from later events.
		log.Printf("pipelineenqueue: org counter update failed jobId=%s orgId=%s: %v", jobID, orgID, err)
	}
}

func orgMetaKey(jobID string) string {
	return "queue:" + QueueName + ":job:" + jobID + ":meta"
}

func orgCountsKey(orgID string) string {
	return "queue:" + QueueName + ":org:" + orgID + ":counts"
}

// upsertJobMetaAndCountScript is QueueOrgStatsService's UPSERT_AND_TRANSITION_LUA
// copied verbatim, so a repeated state never double counts and a transition is
// atomic.
const upsertJobMetaAndCountScript = `
  local metaKey = KEYS[1]
  local countsKey = KEYS[2]

  local newStatus = ARGV[1]
  local orgId = ARGV[2]
  local keepCompleted = ARGV[3]
  local keepFailed = ARGV[4]
  local metaTtl = tonumber(ARGV[5])
  local countsTtl = tonumber(ARGV[6])

  local oldStatus = redis.call('HGET', metaKey, 'status')

  if oldStatus ~= false and oldStatus == newStatus then
    redis.call('HSET', metaKey, 'orgId', orgId, 'keepCompleted', keepCompleted, 'keepFailed', keepFailed)
    redis.call('EXPIRE', metaKey, metaTtl)
    redis.call('EXPIRE', countsKey, countsTtl)
    return oldStatus
  end

  if oldStatus ~= false then
    redis.call('HINCRBY', countsKey, oldStatus, -1)
  end

  redis.call('HINCRBY', countsKey, newStatus, 1)
  redis.call('HSET', metaKey, 'orgId', orgId, 'status', newStatus, 'keepCompleted', keepCompleted, 'keepFailed', keepFailed)
  redis.call('EXPIRE', metaKey, metaTtl)
  redis.call('EXPIRE', countsKey, countsTtl)

  return oldStatus
`
