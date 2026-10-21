package queueops

import (
	"context"
	"embed"
	"fmt"

	"github.com/redis/go-redis/v9"
)

// scriptFiles holds the expanded BullMQ 5.63.2 scripts this package executes.
// See NOTICE for the provenance, the KEYS/ARGV tuples and the licence of every
// file.
//
//go:embed scripts/*.lua
var scriptFiles embed.FS

// mustScript loads one embedded script. A missing file is a programming error,
// so it panics at init instead of failing an operation at runtime.
func mustScript(name string) *redis.Script {
	raw, err := scriptFiles.ReadFile("scripts/" + name + ".lua")
	if err != nil {
		panic(fmt.Sprintf("queueops: embedded script %s is missing: %v", name, err))
	}
	return redis.NewScript(string(raw))
}

var (
	// scriptGetCounts is BullMQ's getCounts command. One call reads every state
	// count of one queue, and the waiting/paused lists are read through the
	// deprecated marker handling the script owns.
	scriptGetCounts = mustScript("getCounts")
	// scriptGetRanges is BullMQ's getJobs range reader.
	scriptGetRanges = mustScript("getRanges")
	// scriptRemoveJob removes one job from any state and all of its data. It
	// refuses a locked job (returns 0) and reports a job-scheduler job as -8.
	scriptRemoveJob = mustScript("removeJob")
	// scriptCleanJobsInSet deletes jobs of one state set by age and emits the
	// cleaned event BullMQ's Queue.clean emits.
	scriptCleanJobsInSet = mustScript("cleanJobsInSet")
	// scriptReprocessJob is Job.retry(): it moves a failed/completed job back to
	// the wait or paused list and emits the waiting event.
	scriptReprocessJob = mustScript("reprocessJob")
	// scriptPromote is Job.promote(): it moves a delayed job to the wait list (or
	// the prioritized set) and emits the waiting event.
	scriptPromote = mustScript("promote")
	// scriptPause is Queue.pause/Queue.resume: it moves the wait list to the
	// paused list (or back), flips meta.paused and republishes the marker.
	scriptPause = mustScript("pause")
)

// allScripts is the set primed before a pipelined script call.
var allScripts = []*redis.Script{
	scriptGetCounts,
	scriptGetRanges,
	scriptRemoveJob,
	scriptCleanJobsInSet,
	scriptReprocessJob,
	scriptPromote,
	scriptPause,
}

// loadScripts primes the Redis script cache for the given scripts.
//
// redis.Script.Run performs its own NOSCRIPT fallback on a single connection,
// but a pipeline cannot: the error only surfaces after Exec and the retry has
// already been lost. Every script this package sends through a pipeline is
// therefore loaded first, exactly like bullmqcleanup does for its removeJob
// pipeline.
func (s *Service) loadScripts(ctx context.Context, scripts ...*redis.Script) error {
	for _, script := range scripts {
		if err := script.Load(ctx, s.redis).Err(); err != nil {
			return err
		}
	}
	return nil
}
