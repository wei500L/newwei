--[[
  Advance one repeat iteration for the akshare-data queue.

  This queue predates the BullMQ job-scheduler layout: the next iteration is
  scheduled when a worker claims the current one (see producer.ScheduleNextRepeat),
  not by a separate scheduler loop. Two guards keep that safe:

    1. The repeat key must still be in the "repeat" ZSET. A scheduler that was
       deleted or replaced must not be resurrected by an in-flight or recovered
       job (EA-补-A1).
    2. The repeat ZSET score must equal the iteration the caller just claimed
       (prevMillis). If another executor already advanced it, this call is a
       duplicate and must not create a second next iteration.

  Input:
    KEYS[1] 'repeat' ZSET
    KEYS[2] 'delayed' ZSET
    KEYS[3] events stream
    KEYS[4] next job hash
    ARGV[1] repeat key
    ARGV[2] expected current score (prevMillis, ms)
    ARGV[3] next iteration timestamp (ms)
    ARGV[4] next job id
    ARGV[5] job name
    ARGV[6] delay (ms)
    ARGV[7] job opts JSON
    ARGV[8] job data JSON
    ARGV[9] now (ms)
  Output:
    1 advanced, 0 skipped (scheduler gone or iteration already advanced)
]]
local rcall = redis.call
local current = rcall("ZSCORE", KEYS[1], ARGV[1])
if not current then
  return 0
end
if tonumber(current) ~= tonumber(ARGV[2]) then
  return 0
end
rcall("ZADD", KEYS[1], ARGV[3], ARGV[1])
rcall("HSET", KEYS[4], "name", ARGV[5], "data", ARGV[8], "opts", ARGV[7],
  "timestamp", ARGV[9], "delay", ARGV[6], "priority", 0, "rjk", ARGV[1])
rcall("ZADD", KEYS[2], tonumber(ARGV[3]) * 0x1000, ARGV[4])
rcall("XADD", KEYS[3], "MAXLEN", "~", 10000, "*", "event", "delayed",
  "jobId", ARGV[4], "delay", ARGV[6])
return 1
