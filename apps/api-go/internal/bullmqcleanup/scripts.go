package bullmqcleanup

import (
	"embed"
	"fmt"

	"github.com/redis/go-redis/v9"
)

// scriptFiles holds the expanded BullMQ 5.63.2 scripts. See NOTICE for the
// provenance and licence of every file.
//
//go:embed scripts/*.lua
var scriptFiles embed.FS

// mustScript loads one embedded script. A missing file is a programming error,
// so it panics at init instead of failing a cleanup cycle at runtime.
func mustScript(name string) *redis.Script {
	raw, err := scriptFiles.ReadFile("scripts/" + name + ".lua")
	if err != nil {
		panic(fmt.Sprintf("bullmqcleanup: embedded script %s is missing: %v", name, err))
	}
	return redis.NewScript(string(raw))
}

var (
	// scriptCleanJobsInSet is BullMQ's clean command: it deletes jobs from one
	// state set by age (and removes their hashes) and emits a cleaned event.
	scriptCleanJobsInSet = mustScript("cleanJobsInSet")
	// scriptGetRanges is BullMQ's getJobs range reader. The waiting list is read
	// from the oldest end and the deprecated wait marker is popped here.
	scriptGetRanges = mustScript("getRanges")
	// scriptGetCounts reads one state count; for the waiting list it ignores the
	// deprecated marker entry.
	scriptGetCounts = mustScript("getCounts")
	// scriptRemoveJob removes one job from any state and all of its data. It
	// refuses to remove a locked job and reports a job-scheduler job as -8.
	scriptRemoveJob = mustScript("removeJob")
)
