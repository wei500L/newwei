package queueorgstats

// The three scripts below are a byte-for-byte copy of the Lua constants at the
// bottom of apps/api/src/modules/queue/queue-org-stats.service.ts. They are the
// protocol between the NestJS QueueOrgStatsService and the readers of the
// counters (QueueOrgStatsService.getCounts called from
// apps/api/src/modules/queue/queue.service.ts:63-73,
// internal/dashboardstats/counts.go and internal/graphqlread/workspace/queue.go),
// so the keys, the hash fields, the argument order and the TTL semantics must
// not change here.
//
//   - upsertAndTransitionScript is UPSERT_AND_TRANSITION_LUA
//     (queue-org-stats.service.ts:152-182). QueueOrgStatsService.upsertJobMetaAndCount
//     (line 71) and the non-terminal branch of transitionJob (line 119) run it.
//   - removeJobScript is REMOVE_JOB_LUA (queue-org-stats.service.ts:184-197).
//     QueueOrgStatsService.removeJob (line 133) runs it.
//   - terminalAndRemoveScript is TERMINAL_AND_REMOVE_LUA
//     (queue-org-stats.service.ts:199-220). transitionJob runs it when a
//     completed/failed job reaches a state whose keep flag is off (line 99-117).
//
// internal/pipelineenqueue/orgstats.go already carries the same
// UPSERT_AND_TRANSITION_LUA bytes for the initial waiting state of a job. The
// SHA-256 pins of TestScriptsMatchNestSource (tracker_test.go) are the digests
// computed from the NestJS template literals, so an accidental edit on either
// side fails a test instead of silently changing the Redis state machine.
const (
	// upsertAndTransitionScript inserts or moves one job, adding +1 to the new
	// status and -1 to the previous one. A repeated state is written without
	// counting twice.
	upsertAndTransitionScript = `
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
	// removeJobScript drops the job metadata and decrements its status.
	removeJobScript = `
  local metaKey = KEYS[1]
  local countsKey = KEYS[2]
  local countsTtl = tonumber(ARGV[1])

  local oldStatus = redis.call('HGET', metaKey, 'status')
  if oldStatus ~= false then
    redis.call('HINCRBY', countsKey, oldStatus, -1)
  end

  redis.call('DEL', metaKey)
  redis.call('EXPIRE', countsKey, countsTtl)
  return oldStatus
`
	// terminalAndRemoveScript counts the terminal status, then drops the job
	// metadata so the per-job hashes do not accumulate.
	terminalAndRemoveScript = `
  local metaKey = KEYS[1]
  local countsKey = KEYS[2]
  local newStatus = ARGV[1]
  local countsTtl = tonumber(ARGV[2])

  local oldStatus = redis.call('HGET', metaKey, 'status')
  if oldStatus ~= false and oldStatus == newStatus then
    redis.call('DEL', metaKey)
    redis.call('EXPIRE', countsKey, countsTtl)
    return oldStatus
  end

  if oldStatus ~= false then
    redis.call('HINCRBY', countsKey, oldStatus, -1)
  end

  redis.call('HINCRBY', countsKey, newStatus, 1)
  redis.call('DEL', metaKey)
  redis.call('EXPIRE', countsKey, countsTtl)
  return oldStatus
`
)
